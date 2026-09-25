import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, firefox, webkit } from "playwright";
import { createApplication } from "../server/app.js";
import { CHUNK_BYTES } from "../server/config.js";
import { FakeAuth, FakeStorage, jpeg, testConfig } from "./fixtures.js";

for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: file actions require confirmation, respect permissions and preserve the trusted origin`, { timeout: 60_000 }, async (t) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const auth = new FakeAuth();
    const startLogin = auth.start.bind(auth);
    auth.start = async () => {
      const login = await startLogin();
      return {
        ...login,
        url: `${origin}/auth/callback?code=test-code&state=${encodeURIComponent(login.attempt.state)}`,
      };
    };
    auth.logoutUrl = origin;
    const storage = new FakeStorage();
    const runtime = await createApplication(testConfig({ APP_BASE_URL: origin }), {
      auth, storage: () => storage, rateLimits: false,
    });
    t.after(runtime.close);
    const requests: { method: string; path: string; origin: string | undefined }[] = [];
    server.on("request", (req, res) => {
      if (req.method && !["GET", "HEAD"].includes(req.method)) {
        requests.push({ method: req.method, path: req.url ?? "", origin: req.headers.origin });
      }
      runtime.app(req, res);
    });

    const browser = await browserType.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    const home = await page.goto(origin);
    assert.equal(home?.headers()["referrer-policy"], "no-referrer");
    await page.getByRole("link", { name: "Accedi con Microsoft", exact: true }).click();
    await page.locator("#dashboard-title").waitFor({ state: "visible" });
    await page.locator("#upload-button").click();

    const content = jpeg(CHUNK_BYTES + 64);
    await page.locator("#file-picker").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: content });
    const created = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/uploads" && response.request().method() === "POST");
    await page.locator("#start-upload-button").click();
    const response = await created;
    assert.equal(response.status(), 201, `Upload rejected: ${await response.text()}`);
    await page.locator("#upload-status").filter({ hasText: "1 file completato." }).waitFor({ state: "visible" });
    assert.deepEqual(requests.map((req) => req.method), ["POST", "PATCH", "PATCH", "POST"]);
    assert.equal(storage.files.size, 1);
    assert.deepEqual([...storage.files.values()][0]?.data, content);

    await page.locator("#file-picker").setInputFiles({
      name: "invalid.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(64),
    });
    const deleted = page.waitForResponse((result) => result.request().method() === "DELETE");
    await page.locator("#start-upload-button").click();
    assert.equal((await deleted).status(), 204);
    await page.locator("#upload-list").getByText("Rimozione del caricamento incompleto confermata.").waitFor();
    assert.equal(storage.files.size, 1);

    const savedPath = [...storage.files.keys()][0];
    assert.ok(savedPath);
    const savedName = savedPath.split("/").at(-1);
    assert.ok(savedName);
    storage.seed("Piano 1/keep.jpg", jpeg());
    await page.locator("#view-destination-button").click();
    const removeButton = page.getByRole("button", { name: `Elimina file ${savedName}`, exact: true });
    await removeButton.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Elimina file Piano 1", exact: true }).count(), 0);
    await removeButton.click();
    assert.equal(await page.locator("#delete-file-name").textContent(), savedName);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "delete-cancel");
    await page.locator("#delete-cancel").click();
    assert.equal(storage.deleteCalls, 0);
    assert.equal(await removeButton.evaluate((button) => button === document.activeElement), true);

    storage.deleteForbidden = true;
    await removeButton.click();
    const forbidden = page.waitForResponse((result) =>
      new URL(result.url()).pathname === "/api/files" && result.request().method() === "DELETE");
    await page.locator("#delete-confirm").click();
    assert.equal((await forbidden).status(), 403);
    await page.locator("#delete-error").filter({ hasText: "Non hai il permesso" }).waitFor();
    assert.equal(storage.files.has(savedPath), true);
    assert.equal(storage.deleteCalls, 0);
    await page.locator("#delete-cancel").click();

    storage.deleteForbidden = false;
    await page.setViewportSize({ width: 320, height: 780 });
    await removeButton.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const removed = page.waitForResponse((result) =>
      new URL(result.url()).pathname === "/api/files" && result.request().method() === "DELETE");
    await page.locator("#delete-confirm").click();
    assert.equal((await removed).status(), 204);
    await page.locator("#global-notice").filter({ hasText: "eliminato da OneLake." }).waitFor();
    assert.equal(storage.files.has(savedPath), false);
    assert.equal(storage.files.has("Piano 1/keep.jpg"), true);
    assert.equal(storage.deleteCalls, 1);
    assert.equal(await removeButton.count(), 0);

    const loggedOut = page.waitForResponse((result) => new URL(result.url()).pathname === "/auth/logout");
    await page.locator("#logout-button").click();
    assert.equal((await loggedOut).status(), 200);
    await page.getByRole("link", { name: "Accedi con Microsoft", exact: true }).waitFor({ state: "visible" });
    assert.ok(requests.every((req) => req.origin === origin), JSON.stringify(requests));
    assert.deepEqual(browserErrors, []);
  });
}
