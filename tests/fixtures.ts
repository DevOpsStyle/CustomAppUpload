import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FileEntry, FilesResponse } from "../shared/contracts.js";
import type { AuthAttempt, AuthProvider, AuthSession } from "../server/auth.js";
import { loadConfig } from "../server/config.js";
import type { AppConfig } from "../server/config.js";
import { AppError } from "../server/errors.js";
import { mediaInfo } from "../server/media.js";
import { fileNameOf, isVisiblePath } from "../server/paths.js";
import type { ByteRange } from "../server/ranges.js";
import type { FileProperties, MediaStorage } from "../server/storage.js";

export const testEnvironment = {
  NODE_ENV: "test",
  ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111",
  ENTRA_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  ENTRA_CLIENT_SECRET: "test-placeholder-not-a-real-credential",
  SESSION_SECRET: "test-session-placeholder-at-least-32-characters",
  FABRIC_WORKSPACE_ID: "33333333-3333-3333-3333-333333333333",
  FABRIC_LAKEHOUSE_ID: "44444444-4444-4444-4444-444444444444",
  APP_BASE_URL: "http://localhost:3000",
};

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...testEnvironment, ...overrides });
}

export function jpeg(size = 64): Buffer {
  const data = Buffer.alloc(size);
  data.set([0xff, 0xd8, 0xff, 0xe0]);
  return data;
}

export class StorageFailure extends Error {
  constructor(public readonly statusCode: number) {
    super("Internal upstream detail that must not reach the browser.");
  }
}

export class FakeStorage implements MediaStorage {
  files = new Map<string, { data: Buffer; metadata: Record<string, string> }>();
  forbidden = false;
  deleteForbidden = false;
  deleteCalls = 0;
  appendCalls = 0;
  flushCalls = 0;
  moveCalls = 0;
  failAfterAppend = false;
  failAfterPublish = false;

  private authorize(): void {
    if (this.forbidden) throw new StorageFailure(403);
  }

  seed(path: string, data: Buffer): void {
    this.files.set(path, { data, metadata: {} });
  }

  async list(path: string): Promise<FilesResponse> {
    this.authorize();
    const entries = new Map<string, FileEntry>();
    const prefix = path ? `${path}/` : "";
    for (const [name, file] of this.files) {
      if (!name.startsWith(prefix) || !isVisiblePath(name)) continue;
      const remaining = name.slice(prefix.length);
      const first = remaining.split("/")[0];
      if (!first) continue;
      const isDirectory = remaining.includes("/");
      entries.set(first, {
        name: first, path: prefix + first, isDirectory,
        size: isDirectory ? 0 : file.data.length,
        lastModified: "2026-01-01T00:00:00.000Z",
        mediaType: isDirectory ? "other" : mediaInfo(first).kind,
      });
    }
    return { path, entries: [...entries.values()], nextCursor: null };
  }

  async properties(path: string): Promise<FileProperties> {
    this.authorize();
    const file = this.files.get(path);
    if (!file) throw new StorageFailure(404);
    return { size: file.data.length, etag: '"v1"', lastModified: "2026-01-01T00:00:00.000Z", metadata: file.metadata };
  }

  async read(path: string, _properties: FileProperties, range?: ByteRange): Promise<Readable> {
    this.authorize();
    const file = this.files.get(path);
    if (!file) throw new StorageFailure(404);
    const start = range?.offset ?? 0;
    return Readable.from(file.data.subarray(start, range ? start + range.count : undefined));
  }

  async create(path: string, _mime: string, metadata: Record<string, string>): Promise<void> {
    this.authorize();
    if (this.files.has(path)) throw new StorageFailure(409);
    this.files.set(path, { data: Buffer.alloc(0), metadata });
  }

  async append(path: string, data: Buffer, offset: number): Promise<void> {
    this.authorize();
    const file = this.files.get(path);
    if (!file) throw new StorageFailure(404);
    const next = Buffer.alloc(Math.max(file.data.length, offset + data.length));
    file.data.copy(next);
    data.copy(next, offset);
    file.data = next;
    this.appendCalls++;
    if (this.failAfterAppend) {
      this.failAfterAppend = false;
      throw new StorageFailure(503);
    }
  }

  async flush(path: string, size: number): Promise<void> {
    this.authorize();
    if (this.files.get(path)?.data.length !== size) throw new StorageFailure(400);
    this.flushCalls++;
  }

  async publish(source: string, destination: string, uploadId: string): Promise<FileEntry> {
    this.authorize();
    const existing = this.files.get(destination);
    if (existing && existing.metadata.uploadid !== uploadId) throw new StorageFailure(409);
    if (!existing) {
      const file = this.files.get(source);
      if (!file) throw new StorageFailure(404);
      this.files.set(destination, file);
      this.files.delete(source);
      this.moveCalls++;
    }
    if (this.failAfterPublish) {
      this.failAfterPublish = false;
      throw new StorageFailure(503);
    }
    const properties = await this.properties(destination);
    return {
      name: fileNameOf(destination), path: destination, isDirectory: false,
      size: properties.size, lastModified: properties.lastModified, mediaType: mediaInfo(destination).kind,
    };
  }

  async remove(path: string): Promise<void> {
    this.authorize();
    this.files.delete(path);
  }

  async deleteFile(path: string): Promise<void> {
    this.authorize();
    if (this.deleteForbidden) throw new StorageFailure(403);
    if ([...this.files.keys()].some((name) => name.startsWith(path + "/"))) {
      throw new AppError(400, "DIRECTORY_DELETE_NOT_ALLOWED", "Puoi eliminare soltanto singoli file, non cartelle.");
    }
    if (!this.files.has(path)) throw new StorageFailure(404);
    this.files.delete(path);
    this.deleteCalls++;
  }
}

export class FakeAuth implements AuthProvider {
  logoutUrl = "https://login.microsoftonline.com/test/logout";
  finishCalls = 0;
  expiresAt = Date.now() + 60_000;
  latestAttempt: AuthAttempt | undefined;

  async start() {
    const state = randomBytes(32).toString("base64url");
    this.latestAttempt = { state, nonce: "test-nonce", verifier: "test-verifier", createdAt: Date.now() };
    return { url: `https://login.microsoftonline.com/test?state=${state}`, attempt: this.latestAttempt };
  }

  async finish(): Promise<AuthSession> {
    this.finishCalls++;
    return {
      user: { name: "Utente di test", username: "test@example.invalid" },
      oid: "55555555-5555-5555-5555-555555555555",
      homeAccountId: "test-account",
      cache: "PRIVATE_TEST_TOKEN_CACHE",
      csrfToken: randomBytes(32).toString("base64url"),
      expiresAt: this.expiresAt,
    };
  }

  credential() {
    return { getToken: async () => ({ token: "TEST_ONLY", expiresOnTimestamp: this.expiresAt }) };
  }
}
