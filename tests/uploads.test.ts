import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_BYTES, UPLOAD_TTL_MS } from "../server/config.js";
import { UploadManager } from "../server/uploads.js";
import { FakeStorage, jpeg } from "./fixtures.js";

const owner = "session-one";
const oid = "55555555-5555-5555-5555-555555555555";
const start = (manager: UploadManager, storage: FakeStorage, size: number, path = "") =>
  manager.start(owner, oid, { path, fileName: "photo.jpg", size }, storage);

test("enforces the exact 250 MB boundary before accepting data", async () => {
  const manager = new UploadManager(250_000_000);
  const storage = new FakeStorage();
  await assert.rejects(start(manager, storage, 250_000_001), { status: 413 });
  assert.equal(storage.files.size, 0);
  const accepted = await start(manager, storage, 250_000_000);
  assert.equal(storage.files.size, 1);
  await manager.cancel(owner, accepted.id);
  for (const size of [0, -1, 1.1, Number.NaN]) {
    await assert.rejects(start(manager, storage, size), { status: 400 });
  }
});

test("upload remains hidden until complete, retains metadata and never overwrites", async () => {
  const manager = new UploadManager(250_000_000);
  const storage = new FakeStorage();
  storage.seed("photo.jpg", jpeg());
  const upload = await start(manager, storage, 64);
  assert.equal((await storage.list("")).entries.length, 1);
  await manager.append(owner, upload.id, 0, jpeg());
  const file = await manager.complete(owner, upload.id);
  assert.notEqual(file.path, "photo.jpg");
  assert.equal(file.size, 64);
  assert.equal((await storage.list("")).entries.length, 2);
  const saved = storage.files.get(file.path);
  assert.equal(saved?.metadata.uploaderoid, oid);
  assert.equal(saved?.metadata.originalnamebase64, Buffer.from("photo.jpg").toString("base64"));
  assert.equal([...storage.files.keys()].some((path) => path.startsWith(".upload-")), false);
  assert.deepEqual(await manager.complete(owner, upload.id), file);
  assert.equal(storage.moveCalls, 1);
});

test("uploads are bound to the initiating session, not client-controlled identifiers", async () => {
  const manager = new UploadManager(250_000_000);
  const storage = new FakeStorage();
  const upload = await start(manager, storage, 64);
  await assert.rejects(manager.append("different-session", upload.id, 0, jpeg()), { status: 404 });
  await assert.rejects(manager.complete("different-session", upload.id), { status: 404 });
  await assert.rejects(manager.cancel("different-session", upload.id), { status: 404 });
  await assert.rejects(manager.complete(owner, upload.id), { code: "UPLOAD_INCOMPLETE" });
  assert.equal(storage.appendCalls, 0);
});

test("chunks are bounded, ordered and safely retried without duplicate bytes", async () => {
  const manager = new UploadManager(250_000_000);
  const storage = new FakeStorage();
  const upload = await start(manager, storage, CHUNK_BYTES + 8);
  await assert.rejects(manager.append(owner, upload.id, CHUNK_BYTES, Buffer.alloc(8)), { code: "INVALID_OFFSET" });
  await assert.rejects(manager.append(owner, upload.id, 0, jpeg(CHUNK_BYTES + 1)), { code: "INVALID_CHUNK" });
  const first = jpeg(CHUNK_BYTES);
  assert.equal((await manager.append(owner, upload.id, 0, first)).offset, CHUNK_BYTES);
  assert.equal((await manager.append(owner, upload.id, 0, first)).offset, CHUNK_BYTES);
  assert.equal(storage.appendCalls, 1);
  const changed = Buffer.from(first);
  changed[100] = 1;
  await assert.rejects(manager.append(owner, upload.id, 0, changed), { code: "INVALID_OFFSET" });
  await manager.append(owner, upload.id, CHUNK_BYTES, Buffer.alloc(8));
  assert.equal((await manager.complete(owner, upload.id)).size, CHUNK_BYTES + 8);
  assert.equal(storage.appendCalls, 2);
});

test("a lost append response and a lost publish response can be retried", async () => {
  const manager = new UploadManager(250_000_000);
  const storage = new FakeStorage();
  const upload = await start(manager, storage, 64);
  storage.failAfterAppend = true;
  await assert.rejects(manager.append(owner, upload.id, 0, jpeg()), { statusCode: 503 });
  await manager.append(owner, upload.id, 0, jpeg());
  storage.failAfterPublish = true;
  await assert.rejects(manager.complete(owner, upload.id), { statusCode: 503 });
  const result = await manager.complete(owner, upload.id);
  assert.equal(result.size, 64);
  assert.equal(storage.moveCalls, 1);
  assert.equal(storage.flushCalls, 1);
  assert.equal(storage.files.size, 1);
});

test("rejects renamed executables and deletes partial data on cancellation", async () => {
  const manager = new UploadManager(250_000_000);
  const storage = new FakeStorage();
  const upload = await start(manager, storage, 64);
  await assert.rejects(manager.append(owner, upload.id, 0, Buffer.alloc(64)), { status: 415 });
  await manager.cancel(owner, upload.id);
  assert.equal(storage.files.size, 0);
});

test("expires abandoned uploads and cleans up their OneLake staging files", async () => {
  let now = 0;
  const manager = new UploadManager(250_000_000, () => now);
  const storage = new FakeStorage();
  const upload = await start(manager, storage, 64, "Piano 1");
  now = UPLOAD_TTL_MS + 1;
  await assert.rejects(manager.append(owner, upload.id, 0, jpeg()), { status: 410 });
  await manager.sweep();
  assert.equal(storage.files.size, 0);
  await assert.rejects(manager.complete(owner, upload.id), { status: 404 });
});

test("OneLake permission failures are surfaced, not reported as successful uploads", async () => {
  const manager = new UploadManager(250_000_000);
  const storage = new FakeStorage();
  storage.forbidden = true;
  await assert.rejects(start(manager, storage, 64), { statusCode: 403 });
  assert.equal(storage.files.size, 0);
});
