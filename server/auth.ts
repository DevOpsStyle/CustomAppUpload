import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ConfidentialClientApplication,
  CryptoProvider,
  InteractionRequiredAuthError,
  LogLevel,
} from "@azure/msal-node";
import type { AuthenticationResult } from "@azure/msal-node";
import type { UserProfile } from "../shared/contracts.js";
import { GUID, SESSION_TTL_MS } from "./config.js";
import type { AppConfig, ConnectionConfig } from "./config.js";
import { AppError } from "./errors.js";

export const STORAGE_SCOPES = ["https://storage.azure.com/user_impersonation"];

export interface AuthAttempt {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
}

export interface AuthSession {
  user: UserProfile;
  oid: string;
  homeAccountId: string;
  cache: string;
  csrfToken: string;
  expiresAt: number;
}

export interface DelegatedCredential {
  getToken(): Promise<{ token: string; expiresOnTimestamp: number }>;
}

export interface AuthProvider {
  start(): Promise<{ url: string; attempt: AuthAttempt }>;
  finish(code: string, attempt: AuthAttempt): Promise<AuthSession>;
  credential(authentication: AuthSession): DelegatedCredential;
  logoutUrl: string;
}

export function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkAttempt(attempt: AuthAttempt | undefined, state: unknown, now = Date.now()): AuthAttempt {
  if (!attempt || now - attempt.createdAt > 10 * 60_000 || now < attempt.createdAt ||
      !equalSecret(state, attempt.state)) {
    throw new AppError(400, "INVALID_LOGIN_STATE", "Il tentativo di accesso e' scaduto o non e' valido. Accedi nuovamente.");
  }
  return attempt;
}

export function validateIdentity(result: AuthenticationResult, connection: ConnectionConfig, nonce: string): string {
  const claims = result.idTokenClaims;
  if (!("tid" in claims) || claims.tid !== connection.tenantId ||
      !("aud" in claims) || claims.aud !== connection.clientId ||
      !("iss" in claims) || claims.iss !== `https://login.microsoftonline.com/${connection.tenantId}/v2.0` ||
      !("nonce" in claims) || !equalSecret(claims.nonce, nonce) ||
      !("oid" in claims) || typeof claims.oid !== "string" || !GUID.test(claims.oid) ||
      !("exp" in claims) || typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 ||
      !result.account || result.account.tenantId !== connection.tenantId) {
    throw new AppError(401, "INVALID_IDENTITY", "L'identita' Microsoft non e' valida per questo tenant.");
  }
  return claims.oid;
}

export class EntraAuth implements AuthProvider {
  readonly logoutUrl: string;
  private readonly connection: ConnectionConfig;
  private readonly authority: string;
  private readonly redirectUri: string;

  constructor(config: AppConfig) {
    if (!config.connection) throw new Error("Configurazione Entra incompleta.");
    this.connection = config.connection;
    this.authority = `https://login.microsoftonline.com/${config.connection.tenantId}`;
    this.redirectUri = `${config.baseUrl}/auth/callback`;
    this.logoutUrl = `${this.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.baseUrl + "/")}`;
  }

  private client(cache?: string): ConfidentialClientApplication {
    const client = new ConfidentialClientApplication({
      auth: {
        clientId: this.connection.clientId,
        clientSecret: this.connection.clientSecret,
        authority: this.authority,
      },
      system: { loggerOptions: { piiLoggingEnabled: false, logLevel: LogLevel.Error } },
    });
    if (cache) client.getTokenCache().deserialize(cache);
    return client;
  }

  async start(): Promise<{ url: string; attempt: AuthAttempt }> {
    const pkce = await new CryptoProvider().generatePkceCodes();
    const attempt: AuthAttempt = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      verifier: pkce.verifier,
      createdAt: Date.now(),
    };
    const url = await this.client().getAuthCodeUrl({
      scopes: STORAGE_SCOPES,
      redirectUri: this.redirectUri,
      responseMode: "query",
      prompt: "select_account",
      state: attempt.state,
      nonce: attempt.nonce,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
    });
    return { url, attempt };
  }

  async finish(code: string, attempt: AuthAttempt): Promise<AuthSession> {
    const client = this.client();
    const result = await client.acquireTokenByCode({
      code,
      scopes: STORAGE_SCOPES,
      redirectUri: this.redirectUri,
      codeVerifier: attempt.verifier,
      nonce: attempt.nonce,
    });
    const oid = validateIdentity(result, this.connection, attempt.nonce);
    if (!result.account) throw new AppError(401, "INVALID_IDENTITY", "Account Microsoft non disponibile.");
    return {
      user: { name: result.account.name || result.account.username, username: result.account.username },
      oid,
      homeAccountId: result.account.homeAccountId,
      cache: client.getTokenCache().serialize(),
      csrfToken: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
  }

  credential(authentication: AuthSession): DelegatedCredential {
    const client = this.client(authentication.cache);
    let pending: Promise<{ token: string; expiresOnTimestamp: number }> | undefined;
    const acquire = async () => {
      if (authentication.expiresAt <= Date.now()) {
        throw new AppError(401, "REAUTH_REQUIRED", "La sessione e' scaduta. Accedi nuovamente.");
      }
      const account = await client.getTokenCache().getAccountByHomeId(authentication.homeAccountId);
      if (!account) throw new AppError(401, "REAUTH_REQUIRED", "Accedi nuovamente con il tuo account Microsoft.");
      try {
        const token = await client.acquireTokenSilent({ account, scopes: STORAGE_SCOPES });
        if (!token.accessToken || !token.expiresOn) {
          throw new AppError(401, "REAUTH_REQUIRED", "Il token Microsoft non e' disponibile. Accedi nuovamente.");
        }
        authentication.cache = client.getTokenCache().serialize();
        return { token: token.accessToken, expiresOnTimestamp: token.expiresOn.getTime() };
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
          throw new AppError(401, "REAUTH_REQUIRED", "Microsoft richiede un nuovo accesso. Accedi nuovamente.");
        }
        throw error;
      }
    };
    return {
      getToken: () => {
        pending ??= acquire().finally(() => { pending = undefined; });
        return pending;
      },
    };
  }
}
