export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  if ("status" in error && typeof error.status === "number") return error.status;
  return undefined;
}

export function publicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  switch (statusOf(error)) {
    case 400:
      return new AppError(400, "BAD_REQUEST", "La richiesta non e' valida.");
    case 401:
      return new AppError(401, "REAUTH_REQUIRED", "La sessione Microsoft e' scaduta. Accedi nuovamente.");
    case 403:
      return new AppError(403, "ONELAKE_FORBIDDEN", "Non hai il permesso di eseguire questa operazione nella cartella. Verifica i permessi OneLake.");
    case 404:
      return new AppError(404, "NOT_FOUND", "File o cartella non trovato. Verifica anche il percorso configurato in OneLake.");
    case 409:
    case 412:
      return new AppError(409, "CONFLICT", "Il file e' stato modificato o l'operazione e' gia' in corso. Riprova.");
    case 413:
      return new AppError(413, "TOO_LARGE", "La richiesta supera la dimensione consentita.");
    case 429:
      return new AppError(429, "RATE_LIMITED", "Troppe richieste. Attendi qualche secondo e riprova.");
    case 500:
    case 502:
    case 503:
    case 504:
      return new AppError(503, "STORAGE_UNAVAILABLE", "OneLake non e' temporaneamente disponibile. Riprova tra poco.");
    default:
      return new AppError(500, "INTERNAL_ERROR", "Operazione non riuscita. Riprova o comunica il riferimento all'amministratore.");
  }
}

export function logError(event: string, error: unknown, requestId?: string): void {
  const code = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(error.code)
    ? error.code
    : error instanceof Error ? error.name : "UnknownError";
  console.error(JSON.stringify({ event, code, status: statusOf(error), requestId }));
}
