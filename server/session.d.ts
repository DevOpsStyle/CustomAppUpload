import type { AuthAttempt, AuthSession } from "./auth.js";

declare module "express-session" {
  interface SessionData {
    authentication?: AuthSession;
    authAttempt?: AuthAttempt;
  }
}
