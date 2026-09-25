import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import request from "supertest";
import { createApplication } from "../server/app.js";
import type { AppConfig } from "../server/config.js";
import { FakeAuth, FakeStorage, jpeg, testConfig } from "./fixtures.js";

const template = '<!doctype html><style nonce="__CSP_NONCE__">body{display:block}</style><script nonce="__CSP_NONCE__">void 0</script>';
type Agent = ReturnType<typeof request.agent>;

async function fixture(t: TestContext, config: AppConfig = testConfig()) {
  const auth = new FakeAuth();
  const storage = new FakeStorage();
  const runtime = await createApplication(config, { auth, storage: () => storage, html: template, rateLimits: false });
  t.after(runtime.close);
  return { app: runtime.app, agent: request.agent(runtime.app), auth, storage };
}

async function signIn(agent: Agent): Promise<string> {
  const login = await agent.get("/auth/login").expect(302);
  const location = login.headers.location;
  assert.ok(location);
  const state = new URL(location).searchParams.get("state");
  assert.ok(state);
  const callback = await agent.get("/auth/callback").query({ code: "test-code", state }).expect(302);
  assert.equal(callback.headers.location, "/");
  assert.notEqual(String(login.headers["set-cookie"]).split(";")[0], String(callback.headers["set-cookie"]).split(";")[0]);
  const me = await agent.get("/api/me").expect(200);
  assert.equal(me.body.authenticated, true);
  assert.equal(typeof me.body.csrfToken, "string");
  return me.body.csrfToken;
}

test("health probes distinguish live process from incomplete configuration", async (t) => {
  const { agent } = await fixture(t, testConfig({ ENTRA_CLIENT_SECRET: "" }));
  await agent.get("/healthz").expect(200, { status: "ok" });
  await agent.get("/readyz").expect(503);
  const me = await agent.get("/api/me").expect(200);
  assert.equal(me.body.configured, false);
  assert.deepEqual(me.body.missing, ["ENTRA_CLIENT_SECRET"]);
  await agent.get("/auth/login").expect(503);
  await agent.post("/api/uploads").send({ fileName: "photo.jpg", path: "", size: 64 }).expect(503);
});

test("anonymous users cannot list, read, upload, finalize or forge platform identity headers", async (t) => {
  const { agent, storage } = await fixture(t);
  await agent.get("/api/files").expect(401);
  await agent.get("/api/files/content").query({ path: "secret.jpg" }).expect(401);
  await agent.delete("/api/files").query({ path: "secret.jpg" }).expect(401);
  await agent.get("/api/files").set("X-MS-CLIENT-PRINCIPAL", "forged").expect(401);
  await agent.post("/api/uploads").send({ fileName: "photo.jpg", path: "", size: 64 }).expect(401);
  await agent.post("/api/uploads/guessed/complete").expect(401);
  await agent.delete("/api/uploads/guessed").expect(401);
  assert.equal(storage.files.size, 0);
});

test("login state is checked before redeeming the authorization code", async (t) => {
  const { agent, auth } = await fixture(t);
  await agent.get("/auth/login").expect(302);
  const result = await agent.get("/auth/callback?code=test&state=forged").expect(302);
  assert.equal(result.headers.location, "/?authError=failed");
  assert.equal(auth.finishCalls, 0);
  assert.equal((await agent.get("/api/me")).body.authenticated, false);
});

test("login rotates the session; credentials never reach the client", async (t) => {
  const { agent } = await fixture(t);
  const csrf = await signIn(agent);
  assert.ok(csrf);
  const result = await agent.get("/api/me").expect(200);
  assert.equal(result.body.user.name, "Utente di test");
  assert.equal(result.body.maxUploadBytes, 250_000_000);
  assert.equal(result.text.includes("PRIVATE_TEST_TOKEN_CACHE"), false);
  assert.equal(result.text.includes("clientSecret"), false);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("HTML uses a fresh CSP nonce and sessions are HttpOnly, SameSite=Lax", async (t) => {
  const { agent } = await fixture(t);
  const first = await agent.get("/").expect(200);
  const second = await agent.get("/").expect(200);
  assert.equal(first.text.includes("__CSP_NONCE__"), false);
  assert.notEqual(first.text, second.text);
  const csp = first.headers["content-security-policy"];
  assert.ok(csp);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  const login = await agent.get("/auth/login");
  assert.match(String(login.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(login.headers["set-cookie"]), /SameSite=Lax/);
});

test("HTTPS production sessions have the __Host- prefix and Secure flag behind ACA", async (t) => {
  const { agent } = await fixture(t, testConfig({ NODE_ENV: "production", APP_BASE_URL: "https://demo.example.invalid" }));
  const login = await agent.get("/auth/login").set("X-Forwarded-Proto", "https").expect(302);
  assert.match(String(login.headers["set-cookie"]), /__Host-cantieri\.sid=/);
  assert.match(String(login.headers["set-cookie"]), /; Secure/);
});

test("mutation requires both the correct CSRF token and configured origin", async (t) => {
  const { agent, storage } = await fixture(t);
  const csrf = await signIn(agent);
  const body = { path: "", fileName: "photo.jpg", size: 64 };
  await agent.post("/api/uploads").send(body).expect(403);
  await agent.post("/api/uploads").set("X-CSRF-Token", csrf).send(body).expect(403);
  const opaqueOrigin = await agent.post("/api/uploads").set("Origin", "null").set("X-CSRF-Token", csrf).send(body).expect(403);
  assert.equal(opaqueOrigin.body.error.code, "CSRF_REJECTED");
  await agent.post("/api/uploads").set("Origin", "http://localhost:3000").set("X-CSRF-Token", "wrong").send(body).expect(403);
  await agent.post("/api/uploads").set("Origin", "https://evil.example.invalid").set("X-CSRF-Token", csrf).send(body).expect(403);
  assert.equal(storage.files.size, 0);
});

test("OneLake permissions are enforced on each listing and media request", async (t) => {
  const { agent, storage } = await fixture(t);
  await signIn(agent);
  storage.seed("photo.jpg", jpeg());
  assert.equal((await agent.get("/api/files").expect(200)).body.entries.length, 1);
  storage.forbidden = true;
  const denied = await agent.get("/api/files").expect(403);
  assert.equal(denied.body.error.code, "ONELAKE_FORBIDDEN");
  assert.equal(denied.text.includes("Internal upstream detail"), false);
  await agent.get("/api/files/content?path=photo.jpg").expect(403);
});

test("HTTP flow uploads a file in the selected subfolder and protects the upload owner", async (t) => {
  const { app, agent, storage } = await fixture(t);
  const csrf = await signIn(agent);
  const headers = { Origin: "http://localhost:3000", "X-CSRF-Token": csrf };
  const created = await agent.post("/api/uploads").set(headers).send({ path: "Piano 1", fileName: "photo.jpg", size: 64 }).expect(201);
  const id: string = created.body.id;
  assert.equal((await agent.get("/api/files?path=Piano%201")).body.entries.length, 0);
  const other = request.agent(app);
  const otherCsrf = await signIn(other);
  await other.delete(`/api/uploads/${id}`).set("Origin", "http://localhost:3000").set("X-CSRF-Token", otherCsrf).expect(404);
  await agent.patch(`/api/uploads/${id}?offset=0`).set(headers).set("Content-Type", "application/octet-stream").send(jpeg()).expect(200);
  const completed = await agent.post(`/api/uploads/${id}/complete`).set(headers).expect(200);
  assert.equal(completed.body.file.size, 64);
  assert.match(completed.body.file.path, /^Piano 1\//);
  assert.equal(storage.files.size, 1);
  const listing = await agent.get("/api/files?path=Piano%201").expect(200);
  assert.equal(listing.body.entries.length, 1);
  const download = await agent.get("/api/files/content").query({ path: completed.body.file.path, download: "1" }).expect(200);
  const contentDisposition = download.headers["content-disposition"];
  assert.ok(contentDisposition);
  assert.match(contentDisposition, /^attachment;/);
  assert.deepEqual(download.body, jpeg());
});

test("mobile video ranges and HEAD requests have correct headers and byte counts", async (t) => {
  const { agent, storage } = await fixture(t);
  await signIn(agent);
  storage.seed("video.mp4", Buffer.from("0123456789"));
  const partial = await agent.get("/api/files/content?path=video.mp4").set("Range", "bytes=2-5").expect(206);
  assert.equal(partial.headers["content-range"], "bytes 2-5/10");
  assert.equal(partial.headers["content-length"], "4");
  assert.deepEqual(partial.body, Buffer.from("2345"));
  const suffix = await agent.get("/api/files/content?path=video.mp4").set("Range", "bytes=-2").expect(206);
  assert.equal(suffix.headers["content-range"], "bytes 8-9/10");
  await agent.head("/api/files/content?path=video.mp4").expect(200).expect("Content-Length", "10");
  await agent.get("/api/files/content?path=video.mp4").set("Range", "bytes=10-").expect(416).expect("Content-Range", "bytes */10");
});

test("traversal, wrong body types and unsupported content are rejected explicitly", async (t) => {
  const { agent, storage } = await fixture(t);
  const csrf = await signIn(agent);
  await agent.get("/api/files").query({ path: "../other" }).expect(400);
  await agent.get("/api/files/content").query({ path: ".upload-private.part" }).expect(400);
  const headers = { Origin: "http://localhost:3000", "X-CSRF-Token": csrf };
  await agent.post("/api/uploads").set(headers).send({ path: "", fileName: "attack.svg", size: 64 }).expect(415);
  await agent.post("/api/uploads").set(headers).send({ path: "", fileName: "photo.jpg", size: 250_000_001 }).expect(413);
  await agent.post("/api/uploads").set(headers).set("Content-Type", "application/json").send("{broken").expect(400);
  assert.equal(storage.files.size, 0);
});

test("logout destroys the session and expired sessions cannot access files", async (t) => {
  const { agent, auth } = await fixture(t);
  const csrf = await signIn(agent);
  await agent.post("/auth/logout").set("Origin", "http://localhost:3000").set("X-CSRF-Token", csrf).expect(200, { logoutUrl: auth.logoutUrl });
  await agent.get("/api/files").expect(401);
  auth.expiresAt = Date.now() - 1;
  const login = await agent.get("/auth/login");
  const location = login.headers.location;
  assert.ok(location);
  const state = new URL(location).searchParams.get("state");
  await agent.get("/auth/callback").query({ state, code: "test" });
  assert.equal((await agent.get("/api/me")).body.authenticated, false);
  await agent.get("/api/files").expect(401);
});

test("file deletion removes only the selected file and returns 204 after confirmation by storage", async (t) => {
  const { agent, storage } = await fixture(t);
  const csrf = await signIn(agent);
  storage.seed("Piano 1/photo.jpg", jpeg());
  storage.seed("Piano 1/keep.jpg", jpeg());
  await agent.delete("/api/files").query({ path: "Piano 1/photo.jpg" })
    .set("Origin", "http://localhost:3000").set("X-CSRF-Token", csrf).expect(204);
  assert.equal(storage.files.has("Piano 1/photo.jpg"), false);
  assert.equal(storage.files.has("Piano 1/keep.jpg"), true);
  assert.equal(storage.deleteCalls, 1);
  const result = await agent.get("/api/files").query({ path: "Piano 1" }).expect(200);
  assert.equal(result.body.entries.length, 1);
  assert.equal(result.body.entries[0].path, "Piano 1/keep.jpg");
});

test("file deletion requires CSRF, configured origin, valid path and OneLake write permission", async (t) => {
  const { agent, storage } = await fixture(t);
  const csrf = await signIn(agent);
  const headers = { Origin: "http://localhost:3000", "X-CSRF-Token": csrf };
  storage.seed("photo.jpg", jpeg());
  storage.seed("folder/keep.jpg", jpeg());
  await agent.delete("/api/files?path=photo.jpg").expect(403);
  await agent.delete("/api/files?path=photo.jpg").set("Origin", "null").set("X-CSRF-Token", csrf).expect(403);
  await agent.delete("/api/files?path=photo.jpg").set("Origin", "https://evil.example.invalid").set("X-CSRF-Token", csrf).expect(403);
  await agent.delete("/api/files?path=photo.jpg").set(headers).set("X-CSRF-Token", "wrong").expect(403);
  for (const path of ["", "../photo.jpg", "folder/../photo.jpg", ".upload-private.part"]) {
    await agent.delete("/api/files").query({ path }).set(headers).expect(400);
  }
  const directory = await agent.delete("/api/files?path=folder").set(headers).expect(400);
  assert.equal(directory.body.error.code, "DIRECTORY_DELETE_NOT_ALLOWED");
  storage.deleteForbidden = true;
  await agent.get("/api/files").expect(200);
  const denied = await agent.delete("/api/files?path=photo.jpg").set(headers).expect(403);
  assert.equal(denied.body.error.code, "ONELAKE_FORBIDDEN");
  assert.equal(storage.files.size, 2);
  assert.equal(storage.deleteCalls, 0);
});

test("file deletion does not report a missing file as a successful deletion", async (t) => {
  const { agent, storage } = await fixture(t);
  const csrf = await signIn(agent);
  const missing = await agent.delete("/api/files?path=missing.jpg")
    .set("Origin", "http://localhost:3000").set("X-CSRF-Token", csrf).expect(404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
  assert.equal(storage.deleteCalls, 0);
});
