import { createHash, randomUUID } from "node:crypto";
import type { FileEntry, UploadResponse } from "../shared/contracts.js";
import { CHUNK_BYTES, UPLOAD_TTL_MS } from "./config.js";
import { AppError, logError, statusOf } from "./errors.js";
import { mediaInfo, safeUploadName, verifyMediaHeader } from "./media.js";
import { joinPath, relativePath, STAGING_PREFIX } from "./paths.js";
import type { MediaStorage } from "./storage.js";

interface UploadRecord {
  id: string;
  owner: string;
  name: string;
  temporaryPath: string;
  destination: string;
  size: number;
  offset: number;
  updatedAt: number;
  busy: boolean;
  flushed: boolean;
  storage: MediaStorage;
  lastChunk?: { offset: number; length: number; hash: string };
  result?: FileEntry;
}

export class UploadManager {
  private readonly records = new Map<string, UploadRecord>();

  constructor(
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  async start(owner: string, oid: string, body: unknown, storage: MediaStorage): Promise<UploadResponse> {
    if (typeof body !== "object" || body === null ||
        !("path" in body) || !("fileName" in body) || !("size" in body)) {
      throw new AppError(400, "INVALID_UPLOAD", "Specificare cartella, nome e dimensione del file.");
    }
    const path = relativePath(body.path);
    const name = safeUploadName(body.fileName);
    if (typeof body.size !== "number" || !Number.isSafeInteger(body.size) || body.size <= 0) {
      throw new AppError(400, "INVALID_SIZE", "Il file deve contenere almeno un byte.");
    }
    if (body.size > this.maxBytes) {
      throw new AppError(413, "FILE_TOO_LARGE", `Il file supera il limite di ${this.maxBytes / 1_000_000} MB.`);
    }
    const active = [...this.records.values()].filter((record) => !record.result);
    if (this.records.size >= 200 || active.length >= 20 || active.filter((r) => r.owner === owner).length >= 2) {
      throw new AppError(429, "UPLOAD_LIMIT", "Ci sono troppi caricamenti in corso. Attendi e riprova.");
    }
    const id = randomUUID();
    const date = new Date(this.now()).toISOString();
    const record: UploadRecord = {
      id, owner, name,
      temporaryPath: joinPath(path, `${STAGING_PREFIX}${id}.part`),
      destination: relativePath(joinPath(path, `${date.replace(/[:.]/g, "-")}_${id.slice(0, 8)}_${name}`), false),
      size: body.size, offset: 0, updatedAt: this.now(), busy: true, flushed: false, storage,
    };
    this.records.set(id, record);
    try {
      await storage.create(record.temporaryPath, mediaInfo(name).mime, {
        uploadid: id,
        uploaderoid: oid,
        originalnamebase64: Buffer.from(String(body.fileName), "utf8").toString("base64"),
        createdatutc: date,
        declaredbytes: String(body.size),
        contenttype: mediaInfo(name).mime,
      });
    } catch (error) {
      this.records.delete(id);
      if (![403, 409, 412].includes(statusOf(error) ?? 0)) {
        try {
          await storage.remove(record.temporaryPath);
        } catch (cleanupError) {
          logError("upload-start-cleanup-failed", cleanupError, id);
        }
      }
      throw error;
    } finally {
      record.busy = false;
    }
    return this.response(record);
  }

  private response(record: UploadRecord): UploadResponse {
    return { id: record.id, offset: record.offset, chunkSize: CHUNK_BYTES };
  }

  private async locked<T>(owner: string, id: string, action: (record: UploadRecord) => Promise<T>): Promise<T> {
    const record = this.records.get(id);
    if (!record || record.owner !== owner) {
      throw new AppError(404, "UPLOAD_NOT_FOUND", "Caricamento non trovato. Potrebbe essere scaduto: seleziona nuovamente il file.");
    }
    if (this.now() - record.updatedAt >= UPLOAD_TTL_MS) {
      throw new AppError(410, "UPLOAD_EXPIRED", "Il caricamento e' scaduto. Seleziona nuovamente il file.");
    }
    if (record.busy) throw new AppError(409, "UPLOAD_BUSY", "Un blocco e' ancora in elaborazione. Attendi e riprova.");
    record.busy = true;
    record.updatedAt = this.now();
    try {
      return await action(record);
    } finally {
      record.busy = false;
      record.updatedAt = this.now();
    }
  }

  append(owner: string, id: string, offset: number, data: Buffer): Promise<UploadResponse> {
    return this.locked(owner, id, async (record) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || data.length === 0 || data.length > CHUNK_BYTES) {
        throw new AppError(400, "INVALID_CHUNK", "Il blocco di caricamento non e' valido.");
      }
      const hash = createHash("sha256").update(data).digest("hex");
      if (record.lastChunk?.offset === offset && record.lastChunk.length === data.length && record.lastChunk.hash === hash) {
        return this.response(record);
      }
      if (record.result || record.flushed || offset !== record.offset ||
          data.length !== Math.min(CHUNK_BYTES, record.size - offset)) {
        throw new AppError(409, "INVALID_OFFSET", "I blocchi non sono nell'ordine atteso o non corrispondono alla dimensione del file.");
      }
      if (offset === 0) await verifyMediaHeader(record.name, data);
      await record.storage.append(record.temporaryPath, data, offset);
      record.lastChunk = { offset, length: data.length, hash };
      record.offset += data.length;
      return this.response(record);
    });
  }

  complete(owner: string, id: string): Promise<FileEntry> {
    return this.locked(owner, id, async (record) => {
      if (record.result) return record.result;
      if (record.offset !== record.size) {
        throw new AppError(409, "UPLOAD_INCOMPLETE", "Il caricamento non e' completo. Mancano alcuni blocchi.");
      }
      if (!record.flushed) {
        await record.storage.flush(record.temporaryPath, record.size);
        record.flushed = true;
      }
      record.result = await record.storage.publish(record.temporaryPath, record.destination, record.id);
      return record.result;
    });
  }

  cancel(owner: string, id: string): Promise<void> {
    return this.locked(owner, id, async (record) => {
      await record.storage.remove(record.temporaryPath);
      this.records.delete(id);
    });
  }

  async sweep(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.busy || this.now() - record.updatedAt < UPLOAD_TTL_MS) continue;
      record.busy = true;
      try {
        await record.storage.remove(record.temporaryPath);
      } catch (error) {
        logError("expired-upload-cleanup-failed", error, record.id);
      } finally {
        this.records.delete(record.id);
      }
    }
  }
}
