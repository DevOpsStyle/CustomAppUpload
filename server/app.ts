import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { checkAttempt, EntraAuth, equalSecret } from "./auth.js";
import type { AuthProvider, AuthSession } from "./auth.js";
import { CHUNK_BYTES, SESSION_TTL_MS } from "./config.js";
import type { AppConfig } from "./config.js";
import { AppError, logError, publicError } from "./errors.js";
import { fileNameOf, relativePath } from "./paths.js";
import { mediaInfo } from "./media.js";
import { parseRange } from "./ranges.js";
import { OneLakeStorage } from "./storage.js";
import type { MediaStorage } from "./storage.js";
import { UploadManager } from "./uploads.js";
import type { SessionResponse } from "../shared/contracts.js";

interface ApplicationDependencies {
  auth?: AuthProvider;
  storage?: (authentication: AuthSession) => MediaStorage;
  html?: string;
  rateLimits?: boolean;
}

function queryString(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new AppError(400, "BAD_REQUEST", "Parametro non valido.");
  return value;
}

function currentUser(req: Request): AuthSession {
  const authentication = req.session?.authentication;
  if (!authentication || authentication.expiresAt <= Date.now()) {
    throw new AppError(401, "REAUTH_REQUIRED", "Accedi con il tuo account Microsoft per continuare.");
  }
  return authentication;
}

function saveSession(req: Request): Promise<void> {
  return new Promise((done, reject) => req.session.save((error) => error ? reject(error) : done()));
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((done, reject) => req.session.regenerate((error) => error ? reject(error) : done()));
}

function disposition(path: string, download: boolean): string {
  const name = fileNameOf(path);
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function createApplication(config: AppConfig, dependencies: ApplicationDependencies = {}) {
  const publicDirectory = resolve("dist", "public");
  const html = dependencies.html ?? await readFile(resolve(publicDirectory, "index.html"), "utf8");
  const app = express();
  const uploads = new UploadManager(config.maxUploadBytes);
  const auth = config.connection ? dependencies.auth ?? new EntraAuth(config) : undefined;
  const storage = (authentication: AuthSession): MediaStorage => {
    if (!auth) throw new AppError(503, "NOT_CONFIGURED", "L'applicazione non e' ancora configurata.");
    return dependencies.storage?.(authentication) ?? new OneLakeStorage(config, auth.credential(authentication));
  };
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", config.production ? 1 : false);
  app.use((req, res, next) => {
    const nonce = randomBytes(18).toString("base64");
    res.locals.cspNonce = nonce;
    res.setHeader("X-Request-Id", randomUUID());
    res.setHeader("Cache-Control", "no-store");
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", `'nonce-${nonce}'`],
          styleSrc: ["'self'", `'nonce-${nonce}'`],
          imgSrc: ["'self'", "blob:", "data:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.secureCookies ? [] : null,
        },
      },
      referrerPolicy: { policy: "no-referrer" },
      strictTransportSecurity: config.secureCookies ? { maxAge: 31_536_000 } : false,
    })(req, res, next);
  });

  app.get("/healthz", (_req, res) => { res.json({ status: "ok" }); });
  app.get("/readyz", (_req, res) => {
    res.status(config.connection ? 200 : 503).json({ status: config.connection ? "ready" : "not-configured" });
  });
  app.get(["/", "/index.html"], (_req, res) => {
    res.type("html").send(html.replaceAll("__CSP_NONCE__", String(res.locals.cspNonce)));
  });
  app.get("/app.js", (_req, res) => { res.sendFile(resolve(publicDirectory, "app.js")); });
  app.get("/favicon.ico", (_req, res) => { res.status(204).end(); });

  const cookieName = config.secureCookies ? "__Host-cantieri.sid" : "cantieri.sid";
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const, path: "/" };
  const MemoryStore = createMemoryStore(session);
  const store = new MemoryStore({ checkPeriod: 60_000, max: 200, ttl: SESSION_TTL_MS });
  if (config.connection) {
    app.use(session({
      name: cookieName, secret: config.connection.sessionSecret,
      resave: false, saveUninitialized: false, store,
      cookie: { ...cookieOptions, maxAge: SESSION_TTL_MS },
    }));
  }
  if (dependencies.rateLimits !== false) {
    app.use("/auth", rateLimit({
      windowMs: 15 * 60_000, limit: 40, standardHeaders: "draft-8", legacyHeaders: false,
      handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Troppi tentativi di accesso. Riprova tra qualche minuto.")),
    }));
    app.use("/api", rateLimit({
      windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false,
      handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Troppe richieste. Attendi qualche secondo.")),
    }));
  }
  app.get("/api/me", (req, res) => {
    let response: SessionResponse;
    if (!config.connection) {
      response = { configured: false, authenticated: false, missing: config.missing };
    } else if (!req.session.authentication || req.session.authentication.expiresAt <= Date.now()) {
      delete req.session.authentication;
      response = { configured: true, authenticated: false };
    } else {
      response = {
        configured: true, authenticated: true,
        user: req.session.authentication.user,
        csrfToken: req.session.authentication.csrfToken,
        folderLabel: config.folderLabel, maxUploadBytes: config.maxUploadBytes, chunkSize: CHUNK_BYTES,
      };
    }
    res.json(response);
  });
  app.use(["/api", "/auth"], (_req, _res, next) => {
    if (!config.connection || !auth) throw new AppError(503, "NOT_CONFIGURED", "Completa le variabili d'ambiente per abilitare l'accesso.");
    next();
  });

  app.get("/auth/login", async (req, res) => {
    if (!auth) throw new Error("Provider Entra non disponibile.");
    if (req.session.authentication && req.session.authentication.expiresAt > Date.now()) {
      res.redirect("/");
      return;
    }
    await regenerateSession(req);
    const login = await auth.start();
    req.session.authAttempt = login.attempt;
    await saveSession(req);
    res.redirect(login.url);
  });
  app.get("/auth/callback", async (req, res) => {
    try {
      if (!auth) throw new Error("Provider Entra non disponibile.");
      const attempt = checkAttempt(req.session.authAttempt, req.query.state);
      delete req.session.authAttempt;
      await saveSession(req);
      if (req.query.error !== undefined) {
        throw new AppError(401, "LOGIN_DENIED", "Accesso Microsoft annullato o non autorizzato.");
      }
      const code = queryString(req.query.code);
      if (!code || code.length > 8192) throw new AppError(400, "INVALID_CODE", "Codice di accesso non valido.");
      const authentication = await auth.finish(code, attempt);
      await regenerateSession(req);
      req.session.authentication = authentication;
      await saveSession(req);
      res.redirect("/");
    } catch (error) {
      logError("login-failed", error, String(res.getHeader("X-Request-Id")));
      res.redirect("/?authError=failed");
    }
  });

  const csrf = (req: Request, _res: Response, next: () => void) => {
    const authentication = currentUser(req);
    if (req.get("origin") !== config.baseUrl || !equalSecret(req.get("X-CSRF-Token"), authentication.csrfToken)) {
      throw new AppError(403, "CSRF_REJECTED", "Richiesta non valida. Ricarica la pagina e riprova.");
    }
    next();
  };
  app.post("/auth/logout", csrf, async (req, res) => {
    await new Promise<void>((done, reject) => req.session.destroy((error) => error ? reject(error) : done()));
    res.clearCookie(cookieName, cookieOptions);
    res.json({ logoutUrl: auth?.logoutUrl });
  });
  app.use("/api", (req, res, next) => {
    currentUser(req);
    if (!["GET", "HEAD"].includes(req.method)) {
      csrf(req, res, next);
    } else {
      next();
    }
  });
  app.use("/api", express.json({ limit: "8kb" }));

  app.get("/api/files", async (req, res) => {
    const path = relativePath(queryString(req.query.path, ""));
    const cursor = req.query.cursor === undefined ? undefined : queryString(req.query.cursor);
    if (cursor && cursor.length > 8192) throw new AppError(400, "INVALID_CURSOR", "Pagina non valida.");
    res.json(await storage(currentUser(req)).list(path, cursor));
  });
  app.delete("/api/files", async (req, res) => {
    const path = relativePath(queryString(req.query.path), false);
    await storage(currentUser(req)).deleteFile(path);
    res.status(204).end();
  });
  app.get("/api/files/content", async (req, res) => {
    const path = relativePath(queryString(req.query.path), false);
    const files = storage(currentUser(req));
    const properties = await files.properties(path);
    let range;
    try {
      range = parseRange(req.get("range"), properties.size);
    } catch (error) {
      res.setHeader("Content-Range", `bytes */${properties.size}`);
      throw error;
    }
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    const stream = req.method === "HEAD" || properties.size === 0
      ? undefined : await files.read(path, properties, range, controller.signal);
    const media = mediaInfo(path);
    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", media.mime);
    res.setHeader("Content-Disposition", disposition(path, req.query.download === "1" || media.kind === "other"));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("ETag", properties.etag);
    res.setHeader("Content-Length", range?.count ?? properties.size);
    if (range) res.setHeader("Content-Range", `bytes ${range.offset}-${range.offset + range.count - 1}/${properties.size}`);
    if (!stream) {
      res.end();
      return;
    }
    try {
      await pipeline(stream, res, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
        console.info(JSON.stringify({ event: "media-transfer-cancelled", requestId: res.getHeader("X-Request-Id") }));
        return;
      }
      throw error;
    }
  });
  app.post("/api/uploads", async (req, res) => {
    const authentication = currentUser(req);
    const body: unknown = req.body;
    res.status(201).json(await uploads.start(req.sessionID, authentication.oid, body, storage(authentication)));
  });
  app.patch("/api/uploads/:id", express.raw({ type: "application/octet-stream", limit: CHUNK_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, "INVALID_CONTENT_TYPE", "Invia il blocco come application/octet-stream.");
    const offsetText = queryString(req.query.offset);
    if (!/^\d+$/.test(offsetText)) throw new AppError(400, "INVALID_OFFSET", "Posizione del blocco non valida.");
    res.json(await uploads.append(req.sessionID, queryString(req.params.id), Number(offsetText), req.body));
  });
  app.post("/api/uploads/:id/complete", async (req, res) => {
    res.json({ file: await uploads.complete(req.sessionID, queryString(req.params.id)) });
  });
  app.delete("/api/uploads/:id", async (req, res) => {
    await uploads.cancel(req.sessionID, queryString(req.params.id));
    res.status(204).end();
  });
  app.use((_req, _res) => { throw new AppError(404, "NOT_FOUND", "Risorsa non trovata."); });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const requestId = String(res.getHeader("X-Request-Id"));
    logError("request-failed", error, requestId);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const failure = publicError(error);
    res.removeHeader("Content-Length");
    if (failure.status === 429) res.setHeader("Retry-After", "5");
    res.status(failure.status).json({ error: { code: failure.code, message: failure.message, requestId } });
  };
  app.use(errorHandler);
  const sweepTimer = setInterval(() => {
    void uploads.sweep().catch((error: unknown) => logError("upload-sweep-failed", error));
  }, 60_000);
  sweepTimer.unref();
  return {
    app,
    close: () => { clearInterval(sweepTimer); store.stopInterval(); },
  };
}
