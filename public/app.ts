import type {
  ApiErrorResponse,
  FileEntry,
  FilesResponse,
  SessionResponse,
  StartUploadRequest,
  UploadCompleteResponse,
  UploadResponse,
} from "../shared/contracts.js";

type AuthenticatedSession = Extract<SessionResponse, { authenticated: true }>;
type Page = "dashboard" | "files" | "upload";
type UploadState = "queued" | "uploading" | "completing" | "completed" | "failed" | "cancelled" | "invalid";
type Icon = "folder" | "image" | "video" | "file" | "chevron";
type Validator<T> = (value: unknown) => value is T;

interface QueuedFile {
  key: number;
  file: File;
  state: UploadState;
  offset: number;
  uploadId: string | null;
  message: string;
  cleanupMessage: string;
  startUnconfirmed: boolean;
}

interface LogoutResponse {
  logoutUrl: string;
}

class RequestFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 120_000;
const COMPLETE_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 20_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif", "mp4", "mov", "m4v", "webm", "3gp"]);
const numberFormat = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" });
const iconPaths: Record<Icon, string> = {
  folder: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z",
  image: "M3 3h18v18H3ZM3 16l5-5 5 5 3-3 5 5M16 7h.01",
  video: "M3 5h13v14H3ZM16 10l5-3v10l-5-3",
  file: "M5 3h9l5 5v13H5ZM14 3v5h5M9 12h6M9 16h6",
  chevron: "m9 5 7 7-7 7",
};

function element<T extends HTMLElement>(id: string, constructor: { new(): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof constructor)) {
    throw new Error(`Elemento dell'interfaccia mancante: ${id}`);
  }
  return found;
}

function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: Icon): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", iconPaths[name]);
  svg.append(path);
  return svg;
}

const gates = {
  loading: element("loading-view", HTMLElement),
  login: element("login-view", HTMLElement),
  setup: element("setup-view", HTMLElement),
  connection: element("connection-view", HTMLElement),
  app: element("app-view", HTMLDivElement),
};
const pages: Record<Page, HTMLElement> = {
  dashboard: element("dashboard-view", HTMLElement),
  files: element("files-view", HTMLElement),
  upload: element("upload-view", HTMLElement),
};
const headings: Record<Page, HTMLHeadingElement> = {
  dashboard: element("dashboard-title", HTMLHeadingElement),
  files: element("files-title", HTMLHeadingElement),
  upload: element("upload-title", HTMLHeadingElement),
};
const expiredNotice = element("session-expired", HTMLElement);
const sessionErrorDetail = element("session-error-detail", HTMLParagraphElement);
const globalNotice = element("global-notice", HTMLParagraphElement);
const backButton = element("back-button", HTMLButtonElement);
const backLabel = element("back-label", HTMLSpanElement);
const logoutButton = element("logout-button", HTMLButtonElement);
const browseButton = element("browse-button", HTMLButtonElement);
const uploadButton = element("upload-button", HTMLButtonElement);
const refreshButton = element("refresh-button", HTMLButtonElement);
const uploadHereButton = element("upload-here-button", HTMLButtonElement);
const moreButton = element("load-more-button", HTMLButtonElement);
const filesRetryButton = element("files-retry", HTMLButtonElement);
const breadcrumbs = element("breadcrumbs", HTMLOListElement);
const fileList = element("file-list", HTMLUListElement);
const filesStatus = element("files-status", HTMLParagraphElement);
const filesErrorBox = element("files-error-box", HTMLDivElement);
const filesError = element("files-error", HTMLParagraphElement);
const emptyFiles = element("empty-files", HTMLDivElement);
const picker = element("file-picker", HTMLInputElement);
const cameraPicker = element("camera-picker", HTMLInputElement);
const pickButton = element("pick-button", HTMLButtonElement);
const cameraButton = element("camera-button", HTMLButtonElement);
const startButton = element("start-upload-button", HTMLButtonElement);
const cancelButton = element("cancel-upload-button", HTMLButtonElement);
const destinationButton = element("view-destination-button", HTMLButtonElement);
const uploadList = element("upload-list", HTMLOListElement);
const queueCount = element("queue-count", HTMLParagraphElement);
const uploadStatus = element("upload-status", HTMLParagraphElement);
const previewDialog = element("preview-dialog", HTMLDialogElement);
const previewTitle = element("preview-title", HTMLHeadingElement);
const previewDetails = element("preview-details", HTMLParagraphElement);
const previewBody = element("preview-body", HTMLDivElement);
const previewStatus = element("preview-status", HTMLParagraphElement);
const previewError = element("preview-error", HTMLParagraphElement);
const downloadLink = element("download-link", HTMLAnchorElement);
const previewLogin = element("preview-login", HTMLAnchorElement);
const deleteDialog = element("delete-dialog", HTMLDialogElement);
const deleteFileName = element("delete-file-name", HTMLParagraphElement);
const deleteError = element("delete-error", HTMLParagraphElement);
const deleteCancel = element("delete-cancel", HTMLButtonElement);
const deleteConfirm = element("delete-confirm", HTMLButtonElement);

let session: AuthenticatedSession | null = null;
let expired = false;
let logoutPending = false;
let page: Page = "dashboard";
let sessionController: AbortController | null = null;
let directoryController: AbortController | null = null;
let directoryVersion = 0;
let directoryLoading = false;
let directoryLoaded = false;
let currentPath = "";
let entries: FileEntry[] = [];
let nextCursor: string | null = null;
let failedDirectoryRequest: { path: string; cursor: string | null } | null = null;
let uploadPath = "";
let uploadOrigin: "dashboard" | "files" = "dashboard";
let queue: QueuedFile[] = [];
let nextFileKey = 0;
let uploadActive = false;
let cancelling = false;
let uploadController: AbortController | null = null;
let previewController: AbortController | null = null;
let previewVersion = 0;
let previewOpener: HTMLElement | null = null;
let previewFile: FileEntry | null = null;
let downloadPending = false;
let fileToDelete: FileEntry | null = null;
let deleteOpener: HTMLElement | null = null;
let deletePending = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}

function isSession(value: unknown): value is SessionResponse {
  if (!isRecord(value)) return false;
  if (value.configured === false) {
    return value.authenticated === false && Array.isArray(value.missing)
      && value.missing.every((name: unknown) => typeof name === "string");
  }
  if (value.configured !== true) return false;
  if (value.authenticated === false) return true;
  return value.authenticated === true && isRecord(value.user)
    && typeof value.user.name === "string" && typeof value.user.username === "string"
    && typeof value.folderLabel === "string"
    && isPositiveInteger(value.maxUploadBytes) && isPositiveInteger(value.chunkSize)
    && typeof value.csrfToken === "string" && value.csrfToken.length > 0;
}

function isFileEntry(value: unknown): value is FileEntry {
  return isRecord(value) && typeof value.name === "string" && typeof value.path === "string"
    && typeof value.isDirectory === "boolean" && isNonnegativeInteger(value.size)
    && (value.lastModified === null
      || (typeof value.lastModified === "string" && Number.isFinite(Date.parse(value.lastModified))))
    && (value.mediaType === "image" || value.mediaType === "video" || value.mediaType === "other");
}

function isFilesResponse(value: unknown): value is FilesResponse {
  return isRecord(value) && typeof value.path === "string"
    && Array.isArray(value.entries) && value.entries.every(isFileEntry)
    && (value.nextCursor === null || (typeof value.nextCursor === "string" && value.nextCursor.length > 0));
}

function isUploadResponse(value: unknown): value is UploadResponse {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && isNonnegativeInteger(value.offset) && isPositiveInteger(value.chunkSize);
}

function isUploadComplete(value: unknown): value is UploadCompleteResponse {
  return isRecord(value) && isFileEntry(value.file) && !value.file.isDirectory;
}

function isApiError(value: unknown): value is ApiErrorResponse {
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string"
    && typeof value.error.message === "string" && value.error.message.trim().length > 0
    && (value.error.requestId === undefined || typeof value.error.requestId === "string");
}

function isLogout(value: unknown): value is LogoutResponse {
  return isRecord(value) && typeof value.logoutUrl === "string" && value.logoutUrl.length > 0;
}

function invalidResponse(): RequestFailure {
  return new RequestFailure("Il servizio ha restituito una risposta non valida. Riprova o contatta il responsabile della demo.", 0, "invalid_response");
}

function errorMessage(error: unknown): string {
  if (error instanceof RequestFailure) {
    return error.message + (error.requestId ? `\nRiferimento: ${error.requestId}` : "");
  }
  return "Si \u00e8 verificato un problema inatteso. Riprova o contatta il responsabile della demo.";
}

function message(target: HTMLElement, text: string): void {
  target.textContent = text;
  target.hidden = text.length === 0;
}

function expireSession(): void {
  expired = true;
  expiredNotice.hidden = false;
  updateControls();
}

function requireSession(): AuthenticatedSession {
  if (!session || expired) {
    expireSession();
    throw new RequestFailure("La sessione \u00e8 scaduta. Accedi di nuovo con Microsoft.", 401, "session_expired");
  }
  return session;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(5000, Math.max(0, milliseconds)) : undefined;
}

async function responseFailure(response: Response): Promise<RequestFailure> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return new RequestFailure(
      `Il servizio non ha potuto completare la richiesta (HTTP ${response.status}). Riprova.`,
      response.status,
      "http_error",
      undefined,
      retryAfter(response),
    );
  }
  if (!isApiError(value)) {
    return new RequestFailure(
      `Il servizio non ha potuto completare la richiesta (HTTP ${response.status}). Riprova.`,
      response.status,
      "http_error",
      undefined,
      retryAfter(response),
    );
  }
  return new RequestFailure(value.error.message, response.status, value.error.code, value.error.requestId, retryAfter(response));
}

async function request<T>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
      if (!session) throw new RequestFailure("Accedi di nuovo prima di modificare i file.", 401, "session_expired");
      headers.set("X-CSRF-Token", session.csrfToken);
    }
    const response = await fetch(url, {
      ...init,
      headers,
      credentials: "same-origin",
      mode: "same-origin",
      // Firefox/WebKit otherwise inherit no-referrer and send Origin: null on mutations.
      referrerPolicy: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    signal?.throwIfAborted();
    if (response.status === 401) expireSession();
    if (!response.ok) {
      const failure = await responseFailure(response);
      if (response.status === 401) message(sessionErrorDetail, errorMessage(failure));
      throw failure;
    }
    const result = await read(response);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Richiesta annullata.", "AbortError");
    if (timedOut) throw new RequestFailure("Il servizio sta impiegando troppo tempo. Controlla la connessione e riprova.", 0, "timeout");
    if (error instanceof TypeError) throw new RequestFailure("Connessione interrotta. Controlla la rete e riprova.", 0, "network_error");
    if (error instanceof SyntaxError) throw invalidResponse();
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function requestJson<T>(
  url: string,
  init: RequestInit,
  validate: Validator<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  return request(url, init, async (response) => {
    const value: unknown = await response.json();
    if (!validate(value)) throw invalidResponse();
    return value;
  }, signal, timeoutMs);
}

function probeContent(url: string, size: number, signal: AbortSignal): Promise<void> {
  const headers = new Headers({ Accept: "*/*" });
  if (size > 0) headers.set("Range", "bytes=0-0");
  return request(url, { headers }, async (response) => {
    // Inspect errors without buffering the original, even if a server ignores Range.
    await response.body?.cancel();
  }, signal);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      window.clearTimeout(timeout);
      reject(new DOMException("Richiesta annullata.", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function withRetries<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onRetry: (attempt: number) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      const retryable = error instanceof RequestFailure
        && (RETRY_STATUSES.has(error.status)
          || (error.status === 409 && error.code === "UPLOAD_BUSY")
          || (error.status === 0 && (error.code === "network_error" || error.code === "timeout")));
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      onRetry(attempt + 1);
      await wait(Math.max(750 * 2 ** (attempt - 1), error.retryAfterMs ?? 0), signal);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${numberFormat.format(bytes / 1_000_000_000)} GB`;
  if (bytes >= 1_000_000) return `${numberFormat.format(bytes / 1_000_000)} MB`;
  if (bytes >= 1000) return `${numberFormat.format(bytes / 1000)} kB`;
  return `${bytes} byte`;
}

function fileDetails(file: FileEntry): string {
  const kind = file.isDirectory ? "Cartella" : file.mediaType === "image" ? "Foto" : file.mediaType === "video" ? "Video" : "File";
  const details = [kind];
  if (!file.isDirectory) details.push(formatBytes(file.size));
  if (file.lastModified !== null) details.push(dateFormat.format(new Date(file.lastModified)));
  return details.join(" \u00b7 ");
}

function fullPath(path: string): string {
  return path ? `Files/demo/${path}` : "Files/demo";
}

function contentUrl(path: string, download = false): string {
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "1");
  return `/api/files/content?${params}`;
}

function showGate(name: keyof typeof gates): void {
  for (const gate of Object.values(gates)) gate.hidden = true;
  gates[name].hidden = false;
}

function handleLoginRedirect(): void {
  const url = new URL(window.location.href);
  const authError = url.searchParams.get("authError");
  if (authError === null) return;
  url.searchParams.delete("authError");
  window.history.replaceState(window.history.state, "", url.href);
  if (authError === "failed") {
    message(element("login-error", HTMLParagraphElement), "Accesso con Microsoft non riuscito. Riprova con il tuo account aziendale dello stesso tenant. Se il problema persiste, contatta il responsabile della demo.");
  }
}

function navigationAllowed(): boolean {
  if (deletePending) {
    message(deleteError, "Eliminazione in corso. Attendi la conferma prima di lasciare la pagina.");
    return false;
  }
  if (uploadActive) {
    message(uploadStatus, "Attendi la conferma oppure annulla il caricamento prima di cambiare pagina.");
    return false;
  }
  if (logoutPending) {
    message(globalNotice, "Uscita in corso. Attendi il completamento.");
    return false;
  }
  return true;
}

function stopDirectoryRequest(): void {
  directoryController?.abort();
  directoryController = null;
  directoryVersion += 1;
  directoryLoading = false;
  fileList.setAttribute("aria-busy", "false");
}

function showPage(target: Page): void {
  if (target !== "files") stopDirectoryRequest();
  for (const view of Object.values(pages)) view.hidden = true;
  pages[target].hidden = false;
  page = target;
  backButton.hidden = target === "dashboard";
  backLabel.textContent = target === "upload" && uploadOrigin === "files" ? "Torna alla cartella" : "Torna alla home";
  message(globalNotice, "");
  updateControls();
  headings[target].focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function updateControls(): void {
  const locked = uploadActive || deletePending || expired || logoutPending || !session;
  logoutButton.disabled = locked;
  backButton.disabled = uploadActive || deletePending || logoutPending;
  browseButton.disabled = locked;
  uploadButton.disabled = locked;
  refreshButton.disabled = locked || directoryLoading;
  uploadHereButton.disabled = locked || directoryLoading || !directoryLoaded;
  moreButton.disabled = locked || directoryLoading;
  moreButton.hidden = nextCursor === null;
  filesRetryButton.disabled = locked || directoryLoading;
  pickButton.disabled = locked;
  cameraButton.disabled = locked;
  picker.disabled = locked;
  cameraPicker.disabled = locked;
  startButton.disabled = locked || !queue.some((file) => file.state === "queued");
  startButton.textContent = uploadActive ? "Caricamento in corso..." : "Avvia caricamento";
  cancelButton.hidden = !uploadActive;
  cancelButton.disabled = !uploadActive || cancelling;
  cancelButton.textContent = cancelling ? "Annullamento in corso..." : "Annulla caricamento";
  destinationButton.hidden = uploadActive || !queue.some((file) => file.state === "completed");
  destinationButton.disabled = locked;
  downloadLink.setAttribute("aria-disabled", String(locked || downloadPending));
  previewLogin.hidden = !expired;
  deleteConfirm.disabled = locked || !fileToDelete;
  deleteConfirm.textContent = deletePending ? "Eliminazione in corso..." : "Elimina file";
  deleteCancel.disabled = deletePending;
  for (const button of document.querySelectorAll<HTMLButtonElement>("#breadcrumbs button, #file-list button, #upload-list button")) {
    button.disabled = locked || (directoryLoading && button.classList.contains("file-delete"));
  }
}

async function loadSession(): Promise<void> {
  sessionController?.abort();
  const controller = new AbortController();
  sessionController = controller;
  showGate("loading");
  expiredNotice.hidden = true;
  message(sessionErrorDetail, "");
  try {
    const result = await requestJson("/api/me", {}, isSession, controller.signal);
    if (controller.signal.aborted) return;
    if (!result.configured) {
      const missing = element("missing-variables", HTMLUListElement);
      missing.replaceChildren();
      for (const name of result.missing) {
        const item = create("li");
        item.append(create("code", undefined, name));
        missing.append(item);
      }
      showGate("setup");
      element("setup-title", HTMLHeadingElement).focus();
      return;
    }
    if (!result.authenticated) {
      showGate("login");
      element("login-title", HTMLHeadingElement).focus();
      return;
    }
    session = result;
    expired = false;
    const nameParts = result.user.name.trim().split(/\s+/u);
    const initials = [nameParts[0], nameParts.length > 1 ? nameParts.at(-1) : undefined]
      .map((part) => part ? Array.from(part)[0] ?? "" : "").join("").toLocaleUpperCase("it-IT");
    element("user-avatar", HTMLSpanElement).textContent = initials;
    element("user-name", HTMLElement).textContent = result.user.name;
    element("user-username", HTMLParagraphElement).textContent = result.user.username;
    element("folder-label", HTMLElement).textContent = result.folderLabel;
    element("upload-limit", HTMLParagraphElement).replaceChildren(create("strong", undefined, `Massimo ${formatBytes(result.maxUploadBytes)} per file.`));
    showGate("app");
    showPage("dashboard");
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof RequestFailure && error.status === 401) {
      showGate("login");
      element("login-title", HTMLHeadingElement).focus();
    } else {
      message(element("connection-error", HTMLParagraphElement), errorMessage(error));
      showGate("connection");
      element("connection-title", HTMLHeadingElement).focus();
    }
  }
}

function renderBreadcrumbs(path: string): void {
  breadcrumbs.replaceChildren();
  const parts = path ? path.split("/") : [];
  const crumbs = [{ label: session?.folderLabel ?? "demo", path: "" }];
  parts.forEach((part, index) => crumbs.push({ label: part, path: parts.slice(0, index + 1).join("/") }));
  for (const crumb of crumbs) {
    const item = create("li");
    const button = create("button", "crumb", crumb.label);
    button.type = "button";
    if (crumb.path === path) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => { void loadDirectory(crumb.path); });
    item.append(button);
    breadcrumbs.append(item);
  }
}

function renderFiles(): void {
  fileList.replaceChildren();
  for (const entry of entries) {
    const item = create("li", "file-row");
    const button = create("button", "file-card");
    button.type = "button";
    button.setAttribute("aria-label", `${entry.isDirectory ? "Apri cartella" : "Apri file"} ${entry.name}`);
    const copy = create("span", "file-copy");
    copy.append(create("span", "file-name", entry.name), create("span", "file-meta", fileDetails(entry)));
    const kind: Icon = entry.isDirectory ? "folder" : entry.mediaType === "other" ? "file" : entry.mediaType;
    button.append(icon(kind), copy, icon("chevron"));
    button.addEventListener("click", () => {
      if (entry.isDirectory) {
        void loadDirectory(entry.path);
      } else {
        openPreview(entry, button);
      }
    });
    item.append(button);
    if (!entry.isDirectory) {
      const remove = create("button", "button danger file-delete", "Elimina");
      remove.type = "button";
      remove.setAttribute("aria-label", `Elimina file ${entry.name}`);
      remove.addEventListener("click", () => openDelete(entry, remove));
      item.append(remove);
    }
    fileList.append(item);
  }
  emptyFiles.hidden = !directoryLoaded || entries.length > 0 || directoryLoading;
  updateControls();
}

function openDelete(file: FileEntry, opener: HTMLElement): void {
  if (!navigationAllowed() || directoryLoading) return;
  try {
    requireSession();
    if (file.isDirectory) throw new RequestFailure("Non puoi eliminare cartelle da questa app.", 400, "DIRECTORY_DELETE_NOT_ALLOWED");
    fileToDelete = file;
    deleteOpener = opener;
    deleteFileName.textContent = file.name;
    message(deleteError, "");
    updateControls();
    deleteDialog.showModal();
    document.body.classList.add("dialog-open");
    deleteCancel.focus();
  } catch (error) {
    message(globalNotice, errorMessage(error));
  }
}

async function deleteSelectedFile(): Promise<void> {
  if (deletePending) return;
  const file = fileToDelete;
  if (!file) {
    message(deleteError, "Seleziona nuovamente il file da eliminare.");
    return;
  }
  let deleted = false;
  deletePending = true;
  message(deleteError, "");
  updateControls();
  window.addEventListener("beforeunload", beforeUnload);
  try {
    requireSession();
    await request(`/api/files?${new URLSearchParams({ path: file.path })}`, { method: "DELETE" }, async (response) => {
      if (response.status !== 204) throw invalidResponse();
    });
    deleted = true;
  } catch (error) {
    message(deleteError, `Eliminazione non confermata. ${errorMessage(error)}\nSe la connessione si \u00e8 interrotta, aggiorna l'elenco prima di riprovare.`);
  } finally {
    deletePending = false;
    window.removeEventListener("beforeunload", beforeUnload);
    updateControls();
  }
  if (deleted) {
    deleteDialog.close();
    await loadDirectory(currentPath);
    message(globalNotice, `File "${file.name}" eliminato da OneLake.`);
  }
}

async function loadDirectory(path: string, cursor: string | null = null): Promise<void> {
  if (!navigationAllowed()) return;
  const focusInListing = fileList.contains(document.activeElement) || breadcrumbs.contains(document.activeElement);
  const moreHadFocus = document.activeElement === moreButton;
  const previousEntryCount = entries.length;
  directoryController?.abort();
  const controller = new AbortController();
  directoryController = controller;
  const version = ++directoryVersion;
  directoryLoading = true;
  failedDirectoryRequest = null;
  filesErrorBox.hidden = true;
  emptyFiles.hidden = true;
  if (cursor === null) {
    currentPath = path;
    entries = [];
    nextCursor = null;
    directoryLoaded = false;
    renderBreadcrumbs(path);
    renderFiles();
    if (focusInListing) headings.files.focus();
  }
  fileList.setAttribute("aria-busy", "true");
  filesStatus.textContent = cursor ? "Caricamento di altri elementi..." : "Caricamento della cartella...";
  updateControls();
  try {
    requireSession();
    const params = new URLSearchParams({ path });
    if (cursor !== null) params.set("cursor", cursor);
    const result = await requestJson(`/api/files?${params}`, {}, isFilesResponse, controller.signal);
    if (controller.signal.aborted || version !== directoryVersion) return;
    if ((cursor !== null && result.path !== path) || (cursor !== null && result.nextCursor === cursor)) {
      throw invalidResponse();
    }
    currentPath = result.path;
    entries = Array.from(new Map([...entries, ...result.entries].map((entry) => [entry.path, entry])).values());
    nextCursor = result.nextCursor;
    directoryLoaded = true;
    renderBreadcrumbs(currentPath);
    filesStatus.textContent = `${entries.length} ${entries.length === 1 ? "elemento" : "elementi"}${nextCursor ? " mostrati. Altri elementi disponibili." : " nella cartella."}`;
  } catch (error) {
    if (controller.signal.aborted || version !== directoryVersion) return;
    failedDirectoryRequest = { path, cursor };
    message(filesError, errorMessage(error));
    filesErrorBox.hidden = false;
    filesStatus.textContent = cursor ? `${entries.length} elementi mostrati. Caricamento interrotto.` : "Cartella non caricata.";
  } finally {
    if (version === directoryVersion) {
      directoryLoading = false;
      fileList.setAttribute("aria-busy", "false");
      renderFiles();
      if (moreHadFocus && moreButton.hidden && !previewDialog.open
        && (document.activeElement === document.body || document.activeElement === moreButton)) {
        const nextEntry = fileList.children.item(previousEntryCount)?.querySelector("button");
        (nextEntry ?? headings.files).focus({ preventScroll: true });
      }
    }
  }
}

function openFiles(path: string): void {
  if (!navigationAllowed()) return;
  showPage("files");
  void loadDirectory(path);
}

function clearPreview(): void {
  previewVersion += 1;
  previewController?.abort();
  previewController = null;
  const video = previewBody.querySelector("video");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  const image = previewBody.querySelector("img");
  image?.removeAttribute("src");
  previewBody.replaceChildren();
  previewFile = null;
  downloadPending = false;
  downloadLink.textContent = "Scarica originale";
  downloadLink.removeAttribute("href");
  document.body.classList.remove("dialog-open");
  if (previewOpener?.isConnected) previewOpener.focus({ preventScroll: true });
  else if (page === "files") headings.files.focus({ preventScroll: true });
  previewOpener = null;
}

async function explainPreviewFailure(file: FileEntry, version: number, signal: AbortSignal): Promise<void> {
  const fallback = "Il browser non riesce a mostrare questo formato. Pu\u00f2 succedere con HEIC/HEIF o alcuni video: scarica l'originale e aprilo con un'app compatibile.";
  message(previewError, fallback);
  previewStatus.textContent = "Anteprima non disponibile. Il file non \u00e8 stato modificato.";
  try {
    await probeContent(contentUrl(file.path), file.size, signal);
  } catch (error) {
    if (signal.aborted || version !== previewVersion) return;
    message(previewError, errorMessage(error));
  }
}

function openPreview(file: FileEntry, opener: HTMLElement): void {
  if (!navigationAllowed()) return;
  try {
    requireSession();
    previewController?.abort();
    const controller = new AbortController();
    previewController = controller;
    const version = ++previewVersion;
    previewOpener = opener;
    previewFile = file;
    previewTitle.textContent = file.name;
    previewDetails.textContent = fileDetails(file);
    previewBody.replaceChildren();
    message(previewError, "");
    downloadPending = false;
    downloadLink.textContent = "Scarica originale";
    downloadLink.href = contentUrl(file.path, true);
    previewStatus.textContent = file.mediaType === "other" ? "Anteprima non disponibile per questo tipo di file. Puoi scaricare l'originale." : "Caricamento dell'anteprima...";
    let failureStarted = false;
    const onError = (): void => {
      if (controller.signal.aborted || version !== previewVersion || failureStarted) return;
      failureStarted = true;
      void explainPreviewFailure(file, version, controller.signal);
    };
    const onLoaded = (): void => {
      if (controller.signal.aborted || version !== previewVersion) return;
      previewStatus.textContent = file.mediaType === "video" ? "Premi Riproduci per avviare il video." : "Anteprima dell'originale.";
    };
    if (file.mediaType === "image") {
      const image = create("img");
      image.alt = `Anteprima di ${file.name}`;
      image.decoding = "async";
      image.addEventListener("load", onLoaded);
      image.addEventListener("error", onError);
      image.src = contentUrl(file.path);
      previewBody.append(image);
    } else if (file.mediaType === "video") {
      const video = create("video");
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", `Anteprima video: ${file.name}`);
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
      video.src = contentUrl(file.path);
      previewBody.append(video);
    } else {
      previewBody.append(icon("file"));
    }
    updateControls();
    previewDialog.showModal();
    document.body.classList.add("dialog-open");
  } catch (error) {
    clearPreview();
    message(globalNotice, errorMessage(error));
  }
}

async function downloadOriginal(): Promise<void> {
  if (!navigationAllowed() || downloadPending) return;
  const file = previewFile;
  const controller = previewController;
  if (!file || !controller) {
    message(previewError, "Apri di nuovo il file prima di scaricarlo.");
    return;
  }
  const version = previewVersion;
  downloadPending = true;
  downloadLink.textContent = "Verifica del download...";
  updateControls();
  try {
    requireSession();
    const url = contentUrl(file.path, true);
    await probeContent(url, file.size, controller.signal);
    if (controller.signal.aborted || version !== previewVersion) return;
    window.location.assign(url);
    previewStatus.textContent = "Download richiesto al browser. Controlla i download del dispositivo.";
  } catch (error) {
    if (controller.signal.aborted || version !== previewVersion) return;
    message(previewError, errorMessage(error));
  } finally {
    if (version === previewVersion) {
      downloadPending = false;
      downloadLink.textContent = "Scarica originale";
      updateControls();
    }
  }
}

function openUpload(path: string, origin: "dashboard" | "files"): void {
  if (!navigationAllowed()) return;
  if (path !== uploadPath && queue.length > 0) {
    if (!window.confirm("Vuoi cambiare cartella? L'elenco dei file selezionati verr\u00e0 svuotato. I file gi\u00e0 salvati non saranno eliminati.")) return;
    queue = [];
    message(uploadStatus, "");
  }
  uploadPath = path;
  uploadOrigin = origin;
  element("upload-folder-label", HTMLElement).textContent = path.split("/").at(-1) || session?.folderLabel || "demo";
  element("upload-destination", HTMLElement).textContent = fullPath(path);
  renderQueue();
  showPage("upload");
}

function validateFile(file: File, maxBytes: number): string | null {
  const extension = file.name.includes(".") ? file.name.split(".").at(-1)?.toLowerCase() : undefined;
  if (!extension || !EXTENSIONS.has(extension)) return "Formato non supportato. Scegli una foto o un video in uno dei formati indicati.";
  if (file.size === 0) return "Il file \u00e8 vuoto e non pu\u00f2 essere caricato.";
  if (file.size > maxBytes) return `Il file supera il limite di ${formatBytes(maxBytes)}. Scegli una versione pi\u00f9 piccola.`;
  return null;
}

function selectFiles(input: HTMLInputElement): void {
  const selected = Array.from(input.files ?? []);
  input.value = "";
  if (selected.length === 0) return;
  if (!navigationAllowed()) return;
  try {
    const authenticated = requireSession();
    let invalid = 0;
    for (const file of selected) {
      const validation = validateFile(file, authenticated.maxUploadBytes);
      if (validation) invalid += 1;
      queue.push({
        key: ++nextFileKey,
        file,
        state: validation ? "invalid" : "queued",
        offset: 0,
        uploadId: null,
        message: validation ?? "Pronto per l'invio.",
        cleanupMessage: "",
        startUnconfirmed: false,
      });
    }
    message(uploadStatus, `${selected.length} ${selected.length === 1 ? "file aggiunto" : "file aggiunti"}.${invalid ? ` ${invalid} non ${invalid === 1 ? "\u00e8 caricabile" : "sono caricabili"}: consulta i dettagli nell'elenco.` : " Premi Avvia caricamento quando sei pronto."}`);
    renderQueue();
  } catch (error) {
    message(uploadStatus, errorMessage(error));
  }
}

function uploadStateLabel(file: QueuedFile): string {
  switch (file.state) {
    case "queued": return "In attesa";
    case "uploading": return `Invio ${Math.floor(file.offset / file.file.size * 100)}%`;
    case "completing": return "Conferma in corso";
    case "completed": return "Completato";
    case "failed": return "Non riuscito";
    case "cancelled": return "Annullato";
    case "invalid": return "Non caricabile";
  }
}

function renderQueue(): void {
  uploadList.replaceChildren();
  queueCount.textContent = queue.length === 0 ? "Nessun file selezionato." : `${queue.length} file nell'elenco \u00b7 ${queue.filter((file) => file.state === "queued").length} in attesa`;
  for (const file of queue) {
    const row = create("li", "upload-item");
    row.dataset.state = file.state;
    const header = create("div", "upload-item-header");
    const copy = create("div");
    const title = create("strong", undefined, file.file.name);
    title.id = `upload-name-${file.key}`;
    copy.append(title, create("span", "upload-state", `${formatBytes(file.file.size)} \u00b7 ${uploadStateLabel(file)}`));
    const remove = create("button", "text-button", "Rimuovi");
    remove.type = "button";
    remove.setAttribute("aria-label", `Rimuovi dall'elenco ${file.file.name}`);
    remove.addEventListener("click", () => {
      if (!navigationAllowed()) return;
      queue = queue.filter((candidate) => candidate.key !== file.key);
      renderQueue();
      message(uploadStatus, "File rimosso dall'elenco. Eventuali file gi\u00e0 salvati in OneLake non vengono eliminati.");
      pickButton.focus({ preventScroll: true });
    });
    header.append(copy, remove);
    row.append(header);
    if (file.state !== "invalid") {
      const progress = create("progress");
      progress.max = file.file.size;
      progress.value = file.offset;
      progress.setAttribute("aria-labelledby", title.id);
      progress.setAttribute("aria-valuetext", `${uploadStateLabel(file)}: ${formatBytes(file.offset)} di ${formatBytes(file.file.size)}`);
      row.append(progress);
    }
    row.append(create("p", "upload-detail", file.message + (file.cleanupMessage ? `\n${file.cleanupMessage}` : "")));
    uploadList.append(row);
  }
  updateControls();
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!uploadActive) return;
  event.preventDefault();
  event.returnValue = "";
}

async function cleanupUpload(file: QueuedFile): Promise<void> {
  if (!file.uploadId) {
    if (file.startUnconfirmed) {
      file.cleanupMessage = "Il server non ha confermato l'identificativo del caricamento: non \u00e8 stato possibile richiedere la rimozione di eventuali dati temporanei. Verifica la destinazione prima di riprovare.";
    }
    return;
  }
  try {
    await request(`/api/uploads/${encodeURIComponent(file.uploadId)}`, { method: "DELETE" }, async (response) => {
      if (response.status !== 204) throw invalidResponse();
    }, undefined, CLEANUP_TIMEOUT_MS);
    file.uploadId = null;
    file.cleanupMessage = "Rimozione del caricamento incompleto confermata.";
  } catch (error) {
    file.cleanupMessage = `La rimozione del caricamento incompleto non \u00e8 confermata. ${errorMessage(error)}\nVerifica la destinazione prima di riprovare: il salvataggio potrebbe essere gi\u00e0 avvenuto.`;
  }
}

async function uploadFile(file: QueuedFile, destination: string, signal: AbortSignal): Promise<void> {
  const authenticated = requireSession();
  const validation = validateFile(file.file, authenticated.maxUploadBytes);
  if (validation) throw new RequestFailure(validation, 400, "invalid_file");
  file.state = "uploading";
  file.message = "Preparazione del caricamento...";
  file.startUnconfirmed = true;
  renderQueue();
  const body: StartUploadRequest = { path: destination, fileName: file.file.name, size: file.file.size };
  let upload: UploadResponse;
  try {
    upload = await requestJson("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, isUploadResponse, signal);
  } catch (error) {
    if (error instanceof RequestFailure && error.status >= 400 && error.status < 500) file.startUnconfirmed = false;
    throw error;
  }
  file.uploadId = upload.id;
  file.startUnconfirmed = false;
  if (upload.offset > file.file.size) throw invalidResponse();
  file.offset = upload.offset;

  while (upload.offset < file.file.size) {
    signal.throwIfAborted();
    const offset = upload.offset;
    const end = Math.min(file.file.size, offset + upload.chunkSize);
    // Keep the same Blob and offset across retries; the server makes this operation idempotent.
    const chunk = file.file.slice(offset, end);
    const url = `/api/uploads/${encodeURIComponent(upload.id)}?offset=${offset}`;
    file.message = `Invio di ${formatBytes(file.file.size)} in corso.`;
    renderQueue();
    const result = await withRetries(
      () => requestJson(url, { method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: chunk }, isUploadResponse, signal, CHUNK_TIMEOUT_MS),
      signal,
      (attempt) => {
        file.message = `Invio non ancora confermato. Tentativo ${attempt} di ${MAX_ATTEMPTS} con la stessa parte, senza duplicarla.`;
        renderQueue();
      },
    );
    if (result.id !== upload.id || result.offset !== end) throw invalidResponse();
    file.offset = result.offset;
    upload = result;
    renderQueue();
  }

  signal.throwIfAborted();
  file.state = "completing";
  file.message = "Tutti i dati sono stati inviati. Attendiamo la conferma del salvataggio in OneLake.";
  renderQueue();
  const completed = await withRetries(
    () => requestJson(`/api/uploads/${encodeURIComponent(upload.id)}/complete`, { method: "POST" }, isUploadComplete, signal, COMPLETE_TIMEOUT_MS),
    signal,
    (attempt) => {
      file.message = `Conferma non ancora ricevuta. Tentativo ${attempt} di ${MAX_ATTEMPTS}; il file non \u00e8 ancora indicato come completato.`;
      renderQueue();
    },
  );
  if (completed.file.size !== file.file.size) {
    throw new RequestFailure("La dimensione confermata dal server non corrisponde al file selezionato. Verifica il materiale prima di riprovare.", 0, "invalid_response");
  }
  file.state = "completed";
  file.offset = file.file.size;
  file.uploadId = null;
  file.message = completed.file.name === file.file.name ? "Salvato in OneLake." : `Salvato in OneLake come ${completed.file.name}.`;
}

async function startUploads(): Promise<void> {
  if (uploadActive || !navigationAllowed()) return;
  const pending = queue.filter((file) => file.state === "queued");
  if (pending.length === 0) {
    message(uploadStatus, "Seleziona almeno un file valido prima di avviare il caricamento.");
    return;
  }
  try {
    requireSession();
  } catch (error) {
    message(uploadStatus, errorMessage(error));
    return;
  }
  const controller = new AbortController();
  uploadController = controller;
  uploadActive = true;
  cancelling = false;
  const destination = uploadPath;
  window.addEventListener("beforeunload", beforeUnload);
  renderQueue();
  try {
    for (const [index, file] of pending.entries()) {
      if (controller.signal.aborted || expired) {
        file.state = "cancelled";
        file.message = expired ? "Non inviato: accedi di nuovo con Microsoft." : "Non inviato: caricamento annullato.";
        renderQueue();
        continue;
      }
      message(uploadStatus, `File ${index + 1} di ${pending.length}: ${file.file.name}. Tieni la pagina aperta fino alla conferma.`);
      try {
        await uploadFile(file, destination, controller.signal);
      } catch (error) {
        file.state = controller.signal.aborted ? "cancelled" : "failed";
        file.message = controller.signal.aborted ? "Invio interrotto. Il salvataggio non \u00e8 confermato." : errorMessage(error);
        renderQueue();
        await cleanupUpload(file);
      }
      renderQueue();
    }
  } finally {
    uploadActive = false;
    cancelling = false;
    uploadController = null;
    window.removeEventListener("beforeunload", beforeUnload);
    renderQueue();
    const completed = pending.filter((file) => file.state === "completed").length;
    const failed = pending.filter((file) => file.state === "failed").length;
    const cancelled = pending.filter((file) => file.state === "cancelled").length;
    message(uploadStatus, `${completed} ${completed === 1 ? "file completato" : "file completati"}.${failed ? ` ${failed} non riusciti.` : ""}${cancelled ? ` ${cancelled} annullati.` : ""}${failed || cancelled ? " Consulta i dettagli di ciascun file. Per riprovare, rimuovilo dall'elenco e selezionalo di nuovo." : " Puoi visualizzare la destinazione per ritrovare il materiale."}`);
    if (cancelButton === document.activeElement || startButton === document.activeElement) {
      if (!destinationButton.hidden && !destinationButton.disabled) destinationButton.focus({ preventScroll: true });
      else if (!pickButton.disabled) pickButton.focus({ preventScroll: true });
    }
  }
}

function cancelUploads(): void {
  if (!uploadController || !uploadActive) return;
  cancelling = true;
  message(uploadStatus, "Interruzione dell'invio e richiesta di rimozione del caricamento incompleto. Attendi l'esito prima di lasciare la pagina.");
  uploadController.abort();
  updateControls();
}

async function logout(): Promise<void> {
  if (!navigationAllowed()) return;
  logoutPending = true;
  updateControls();
  try {
    requireSession();
    const result = await requestJson("/auth/logout", { method: "POST" }, isLogout);
    let destination: URL;
    try {
      destination = new URL(result.logoutUrl, window.location.origin);
    } catch (error) {
      if (error instanceof TypeError) throw invalidResponse();
      throw error;
    }
    if (!["http:", "https:"].includes(destination.protocol)
      || (destination.origin !== window.location.origin && destination.protocol !== "https:")
      || destination.username || destination.password) {
      throw invalidResponse();
    }
    window.location.assign(destination.href);
  } catch (error) {
    message(globalNotice, errorMessage(error));
  } finally {
    logoutPending = false;
    updateControls();
  }
}

element("setup-retry", HTMLButtonElement).addEventListener("click", () => { void loadSession(); });
element("session-retry", HTMLButtonElement).addEventListener("click", () => { void loadSession(); });
browseButton.addEventListener("click", () => openFiles(""));
uploadButton.addEventListener("click", () => openUpload("", "dashboard"));
uploadHereButton.addEventListener("click", () => openUpload(currentPath, "files"));
refreshButton.addEventListener("click", () => { void loadDirectory(currentPath); });
moreButton.addEventListener("click", () => {
  if (nextCursor !== null) void loadDirectory(currentPath, nextCursor);
});
filesRetryButton.addEventListener("click", () => {
  if (failedDirectoryRequest) void loadDirectory(failedDirectoryRequest.path, failedDirectoryRequest.cursor);
});
backButton.addEventListener("click", () => {
  if (!navigationAllowed()) return;
  if (page === "upload" && uploadOrigin === "files") openFiles(uploadPath);
  else showPage("dashboard");
});
pickButton.addEventListener("click", () => picker.click());
cameraButton.addEventListener("click", () => cameraPicker.click());
picker.addEventListener("change", () => selectFiles(picker));
cameraPicker.addEventListener("change", () => selectFiles(cameraPicker));
startButton.addEventListener("click", () => {
  void startUploads().catch((error: unknown) => message(uploadStatus, errorMessage(error)));
});
cancelButton.addEventListener("click", cancelUploads);
destinationButton.addEventListener("click", () => openFiles(uploadPath));
logoutButton.addEventListener("click", () => { void logout(); });
deleteConfirm.addEventListener("click", () => {
  void deleteSelectedFile().catch((error: unknown) => message(deleteError, errorMessage(error)));
});
deleteCancel.addEventListener("click", () => { if (!deletePending) deleteDialog.close(); });
deleteDialog.addEventListener("cancel", (event) => { if (deletePending) event.preventDefault(); });
deleteDialog.addEventListener("close", () => {
  fileToDelete = null;
  document.body.classList.remove("dialog-open");
  if (deleteOpener?.isConnected) deleteOpener.focus({ preventScroll: true });
  else if (page === "files") headings.files.focus({ preventScroll: true });
  deleteOpener = null;
  updateControls();
});
element("preview-close", HTMLButtonElement).addEventListener("click", () => previewDialog.close());
element("preview-done", HTMLButtonElement).addEventListener("click", () => previewDialog.close());
previewDialog.addEventListener("close", clearPreview);
previewDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    previewDialog.close();
  }
});
previewDialog.addEventListener("click", (event) => {
  if (event.target !== previewDialog) return;
  const bounds = previewDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) previewDialog.close();
});
downloadLink.addEventListener("click", (event) => {
  event.preventDefault();
  void downloadOriginal();
});
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href="/auth/login"]')) {
  link.addEventListener("click", (event) => {
    if (!navigationAllowed()) event.preventDefault();
  });
}

handleLoginRedirect();
void loadSession();
