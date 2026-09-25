import { Readable } from "node:stream";
import { DataLakeServiceClient } from "@azure/storage-file-datalake";
import type { DataLakeFileSystemClient } from "@azure/storage-file-datalake";
import type { FileEntry, FilesResponse } from "../shared/contracts.js";
import type { DelegatedCredential } from "./auth.js";
import type { AppConfig } from "./config.js";
import { AppError, statusOf } from "./errors.js";
import { mediaInfo } from "./media.js";
import { fileNameOf, isVisiblePath, joinPath, relativePath } from "./paths.js";
import type { ByteRange } from "./ranges.js";

export interface FileProperties {
  size: number;
  etag: string;
  lastModified: string | null;
  metadata: Record<string, string>;
}

export interface MediaStorage {
  list(path: string, cursor?: string): Promise<FilesResponse>;
  properties(path: string): Promise<FileProperties>;
  read(path: string, properties: FileProperties, range?: ByteRange, signal?: AbortSignal): Promise<Readable>;
  create(path: string, mime: string, metadata: Record<string, string>): Promise<void>;
  append(path: string, data: Buffer, offset: number): Promise<void>;
  flush(path: string, size: number): Promise<void>;
  publish(source: string, destination: string, uploadId: string): Promise<FileEntry>;
  remove(path: string): Promise<void>;
}

export class OneLakeStorage implements MediaStorage {
  private readonly fileSystem: DataLakeFileSystemClient;
  private readonly root: string;

  constructor(config: AppConfig, credential: DelegatedCredential) {
    if (!config.connection) throw new Error("Configurazione OneLake incompleta.");
    const client = new DataLakeServiceClient(config.endpoint, credential, {
      retryOptions: { maxTries: 3, tryTimeoutInMs: 45_000, retryDelayInMs: 500, maxRetryDelayInMs: 3000 },
    });
    this.fileSystem = client.getFileSystemClient(config.connection.workspaceId);
    this.root = `${config.connection.lakehouseId}/${config.rootPath}`;
  }

  private path(path: string): string {
    return joinPath(this.root, path);
  }

  async list(path: string, cursor?: string): Promise<FilesResponse> {
    const directory = this.path(path);
    const iterator = this.fileSystem.listPaths({ path: directory, recursive: false }).byPage({
      maxPageSize: 100,
      continuationToken: cursor,
    });
    const page = await iterator.next();
    if (page.done || !page.value) {
      throw new AppError(502, "INVALID_STORAGE_RESPONSE", "OneLake non ha restituito una pagina valida.");
    }
    const entries: FileEntry[] = [];
    for (const item of page.value.pathItems ?? []) {
      if (!item.name || !item.name.startsWith(directory + "/")) {
        throw new AppError(502, "INVALID_STORAGE_RESPONSE", "OneLake ha restituito un percorso inatteso.");
      }
      const name = item.name.slice(directory.length + 1);
      if (name.includes("/")) throw new AppError(502, "INVALID_STORAGE_RESPONSE", "OneLake ha restituito un percorso inatteso.");
      const relative = item.name.slice(this.root.length + 1);
      if (!isVisiblePath(relative)) continue;
      relativePath(relative, false);
      entries.push({
        name, path: relative, isDirectory: item.isDirectory === true,
        size: item.contentLength ?? 0,
        lastModified: item.lastModified?.toISOString() ?? null,
        mediaType: item.isDirectory ? "other" : mediaInfo(name).kind,
      });
    }
    entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, "it"));
    return { path, entries, nextCursor: page.value.continuation || null };
  }

  async properties(path: string): Promise<FileProperties> {
    const result = await this.fileSystem.getFileClient(this.path(path)).getProperties();
    if (result.contentLength === undefined || !result.etag) {
      throw new AppError(502, "INVALID_STORAGE_RESPONSE", "Le proprieta' del file non sono disponibili.");
    }
    return {
      size: result.contentLength,
      etag: result.etag,
      lastModified: result.lastModified?.toISOString() ?? null,
      metadata: result.metadata ?? {},
    };
  }

  async read(path: string, properties: FileProperties, range?: ByteRange, signal?: AbortSignal): Promise<Readable> {
    const result = await this.fileSystem.getFileClient(this.path(path)).read(range?.offset, range?.count, {
      conditions: { ifMatch: properties.etag },
      abortSignal: signal,
    });
    if (!(result.readableStreamBody instanceof Readable)) {
      throw new AppError(502, "INVALID_STORAGE_RESPONSE", "OneLake non ha restituito il contenuto del file.");
    }
    return result.readableStreamBody;
  }

  async create(path: string, mime: string, metadata: Record<string, string>): Promise<void> {
    await this.fileSystem.getFileClient(this.path(path)).create({
      conditions: { ifNoneMatch: "*" },
      pathHttpHeaders: { contentType: mime },
      metadata,
    });
  }

  async append(path: string, data: Buffer, offset: number): Promise<void> {
    await this.fileSystem.getFileClient(this.path(path)).append(data, offset, data.length);
  }

  async flush(path: string, size: number): Promise<void> {
    await this.fileSystem.getFileClient(this.path(path)).flush(size, { close: true });
  }

  async publish(source: string, destination: string, uploadId: string): Promise<FileEntry> {
    let existing: FileProperties | undefined;
    try {
      existing = await this.properties(destination);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    if (existing && existing.metadata.uploadid !== uploadId) {
      throw new AppError(409, "FILE_EXISTS", "Esiste gia' un file con questo nome.");
    }
    if (!existing) {
      await this.fileSystem.getFileClient(this.path(source)).move(this.path(destination), {
        destinationConditions: { ifNoneMatch: "*" },
      });
      existing = await this.properties(destination);
    }
    return {
      name: fileNameOf(destination), path: destination, isDirectory: false,
      size: existing.size, lastModified: existing.lastModified,
      mediaType: mediaInfo(destination).kind,
    };
  }

  async remove(path: string): Promise<void> {
    await this.fileSystem.getFileClient(this.path(path)).deleteIfExists();
  }
}
