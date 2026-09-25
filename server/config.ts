import { relativePath } from "./paths.js";

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const UPLOAD_TTL_MS = 30 * 60 * 1000;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectionConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  workspaceId: string;
  lakehouseId: string;
}

export interface AppConfig {
  port: number;
  baseUrl: string;
  secureCookies: boolean;
  production: boolean;
  connection: ConnectionConfig | null;
  missing: string[];
  endpoint: string;
  rootPath: string;
  folderLabel: string;
  maxUploadBytes: number;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} deve essere un intero tra ${min} e ${max}.`);
  }
  return number;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const production = env.NODE_ENV === "production";
  const port = integer(env.PORT, production ? 8080 : 3000, 1, 65535, "PORT");
  const required = [
    "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET",
    "SESSION_SECRET", "FABRIC_WORKSPACE_ID", "FABRIC_LAKEHOUSE_ID",
  ];
  const missing = required.filter((key) => !env[key]?.trim());
  if (production && !env.APP_BASE_URL) missing.push("APP_BASE_URL");
  for (const key of ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "FABRIC_WORKSPACE_ID", "FABRIC_LAKEHOUSE_ID"]) {
    if (env[key] && !GUID.test(env[key])) throw new Error(`${key} deve essere un GUID.`);
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET deve contenere almeno 32 caratteri casuali.");
  }
  const base = new URL(env.APP_BASE_URL || `http://localhost:${port}`);
  const local = !production && base.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((!local && base.protocol !== "https:" && !missing.includes("APP_BASE_URL")) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("APP_BASE_URL deve essere un'origine HTTPS, senza percorso. HTTP e' ammesso solo su localhost in sviluppo.");
  }
  const endpoint = new URL(env.ONELAKE_ENDPOINT || "https://onelake.dfs.fabric.microsoft.com");
  if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password ||
      endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
      !/^(?:[a-z0-9-]+-)?onelake\.dfs\.fabric\.microsoft\.com$/.test(endpoint.hostname)) {
    throw new Error("ONELAKE_ENDPOINT deve essere l'endpoint OneLake HTTPS globale o regionale.");
  }
  const rootPath = relativePath(env.ONELAKE_ROOT_PATH || "Files/demo", false);
  if (rootPath !== "Files" && !rootPath.startsWith("Files/")) {
    throw new Error("ONELAKE_ROOT_PATH deve essere Files oppure una sua sottocartella.");
  }
  const getRequired = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Configurazione mancante: ${name}`);
    return value;
  };
  const connection = missing.length ? null : {
    tenantId: getRequired("ENTRA_TENANT_ID").toLowerCase(),
    clientId: getRequired("ENTRA_CLIENT_ID").toLowerCase(),
    clientSecret: getRequired("ENTRA_CLIENT_SECRET"),
    sessionSecret: getRequired("SESSION_SECRET"),
    workspaceId: getRequired("FABRIC_WORKSPACE_ID").toLowerCase(),
    lakehouseId: getRequired("FABRIC_LAKEHOUSE_ID").toLowerCase(),
  };
  return {
    port, production, baseUrl: base.origin, secureCookies: base.protocol === "https:",
    missing, connection, endpoint: endpoint.origin, rootPath,
    folderLabel: env.FOLDER_LABEL || "MaterialiCantiere / demo",
    maxUploadBytes: integer(env.MAX_UPLOAD_MB, 250, 1, 2048, "MAX_UPLOAD_MB") * 1_000_000,
  };
}
