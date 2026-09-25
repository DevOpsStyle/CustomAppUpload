import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { DataLakeFileClient, DataLakeFileSystemClient } from "@azure/storage-file-datalake";
import type { ListPathsOptions, Path, PathDeleteOptions } from "@azure/storage-file-datalake";
import { OneLakeStorage } from "../server/storage.js";
import { StorageFailure, testConfig } from "./fixtures.js";

const config = testConfig();
assert.ok(config.connection);
const root = `${config.connection.lakehouseId}/${config.rootPath}`;
type PageSettings = Parameters<ReturnType<DataLakeFileSystemClient["listPaths"]>["byPage"]>[0];

function storageClient(): OneLakeStorage {
  return new OneLakeStorage(config, {
    getToken: async () => { throw new Error("Unit tests must not call OneLake."); },
  });
}

function listing(t: TestContext, pathItems: Path[], continuation?: string) {
  const requests: { path?: string; recursive?: boolean; pageSettings: PageSettings }[] = [];
  t.mock.method(DataLakeFileSystemClient.prototype, "listPaths", (options: ListPathsOptions = {}) => ({
    byPage: async function* (pageSettings: PageSettings = {}) {
      requests.push({ path: options.path, recursive: options.recursive, pageSettings });
      yield { pathItems, continuation };
    },
  }));
  return { storage: storageClient(), requests };
}

test("OneLake root listing accepts canonical SDK paths and hides unfinished uploads", async (t) => {
  const modified = new Date("2026-01-01T00:00:00Z");
  const { storage, requests } = listing(t, [
    { name: `${root}/photo.jpg`, isDirectory: false, contentLength: 64, lastModified: modified },
    { name: `${root}/Piano 1`, isDirectory: true },
    { name: `${root}/.upload-test.part`, isDirectory: false, contentLength: 0 },
  ], "next-page");
  const result = await storage.list("");
  assert.deepEqual(result, {
    path: "",
    entries: [
      { name: "Piano 1", path: "Piano 1", isDirectory: true, size: 0, lastModified: null, mediaType: "other" },
      { name: "photo.jpg", path: "photo.jpg", isDirectory: false, size: 64, lastModified: modified.toISOString(), mediaType: "image" },
    ],
    nextCursor: "next-page",
  });
  assert.deepEqual(requests, [{ path: root, recursive: false, pageSettings: { maxPageSize: 100, continuationToken: undefined } }]);
});

test("OneLake empty root remains a valid empty page", async (t) => {
  const { storage, requests } = listing(t, []);
  assert.deepEqual(await storage.list(""), { path: "", entries: [], nextCursor: null });
  assert.equal(requests[0]?.path, root);
});

test("OneLake subfolder listing preserves relative paths and the continuation cursor", async (t) => {
  const { storage, requests } = listing(t, [
    { name: `${root}/Piano 1/video.mp4`, isDirectory: false, contentLength: 100 },
  ]);
  const result = await storage.list("Piano 1", "previous-page");
  assert.equal(result.entries[0]?.path, "Piano 1/video.mp4");
  assert.equal(result.entries[0]?.mediaType, "video");
  assert.equal(result.nextCursor, null);
  assert.deepEqual(requests, [{
    path: `${root}/Piano 1`, recursive: false,
    pageSettings: { maxPageSize: 100, continuationToken: "previous-page" },
  }]);
});

test("OneLake root listing still rejects out-of-scope paths and recursive children", async (t) => {
  const items: Path[] = [];
  const { storage } = listing(t, items);
  for (const name of [
    undefined,
    "other-lakehouse/Files/demo/photo.jpg",
    `${config.connection?.lakehouseId}/Files/demolition/photo.jpg`,
    `${root}/nested/photo.jpg`,
    `${root}//photo.jpg`,
  ]) {
    items.splice(0, items.length, { name });
    await assert.rejects(storage.list(""), { status: 502, code: "INVALID_STORAGE_RESPONSE" });
  }
});

test("OneLake subfolder listing cannot return a file from a sibling folder", async (t) => {
  const { storage } = listing(t, [{ name: `${root}/Piano 2/photo.jpg` }]);
  await assert.rejects(storage.list("Piano 1"), { status: 502, code: "INVALID_STORAGE_RESPONSE" });
});

test("OneLake deletes only the selected file non-recursively with the checked ETag", async (t) => {
  const selected = `/33333333-3333-3333-3333-333333333333/${root}/Piano 1/photo.jpg`;
  const calls: string[] = [];
  t.mock.method(DataLakeFileClient.prototype, "getSystemProperties", async function (this: DataLakeFileClient) {
    assert.equal(decodeURIComponent(new URL(this.url).pathname), selected);
    calls.push("properties");
    return { isDirectory: false, etag: '"current-version"' };
  });
  t.mock.method(DataLakeFileClient.prototype, "delete", async function (
    this: DataLakeFileClient, recursive?: boolean, options?: PathDeleteOptions,
  ) {
    assert.equal(decodeURIComponent(new URL(this.url).pathname), selected);
    assert.equal(recursive, false);
    assert.deepEqual(options?.conditions, { ifMatch: '"current-version"' });
    calls.push("delete");
  });
  await storageClient().deleteFile("Piano 1/photo.jpg");
  assert.deepEqual(calls, ["properties", "delete"]);
});

test("OneLake deletion refuses directories and incomplete type or ETag information", async (t) => {
  let properties: { isDirectory?: boolean; etag?: string } = { isDirectory: true, etag: '"directory"' };
  t.mock.method(DataLakeFileClient.prototype, "getSystemProperties", async () => properties);
  const deleted = t.mock.method(DataLakeFileClient.prototype, "delete", async () => undefined);
  const storage = storageClient();
  await assert.rejects(storage.deleteFile("empty-directory"), { code: "DIRECTORY_DELETE_NOT_ALLOWED" });
  properties = { isDirectory: false };
  await assert.rejects(storage.deleteFile("photo.jpg"), { code: "INVALID_STORAGE_RESPONSE" });
  properties = { etag: '"unknown-type"' };
  await assert.rejects(storage.deleteFile("photo.jpg"), { code: "INVALID_STORAGE_RESPONSE" });
  assert.equal(deleted.mock.callCount(), 0);
});

test("OneLake deletion rejects root, traversal and staging paths before calling the SDK", async (t) => {
  const inspected = t.mock.method(DataLakeFileClient.prototype, "getSystemProperties", async () => {
    throw new Error("Invalid paths must not reach OneLake.");
  });
  for (const path of ["", "..", "../private.jpg", "/file.jpg", "folder/../file.jpg", ".upload-test.part", "folder/.upload-test.part"]) {
    await assert.rejects(storageClient().deleteFile(path), { code: "INVALID_PATH" });
  }
  assert.equal(inspected.mock.callCount(), 0);
});

test("OneLake deletion propagates permission, missing-file and version-conflict failures", async (t) => {
  t.mock.method(DataLakeFileClient.prototype, "getSystemProperties", async () => ({ isDirectory: false, etag: '"v1"' }));
  let status = 403;
  const deleted = t.mock.method(DataLakeFileClient.prototype, "delete", async () => { throw new StorageFailure(status); });
  for (const code of [403, 404, 412]) {
    status = code;
    await assert.rejects(storageClient().deleteFile("photo.jpg"), { statusCode: code });
  }
  assert.equal(deleted.mock.callCount(), 3);
});
