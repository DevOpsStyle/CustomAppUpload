import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, firefox, webkit } from "playwright";
import { createApplication } from "../server/app.js";
import { CHUNK_BYTES } from "../server/config.js";
import { FakeAuth, FakeStorage, jpeg, testConfig } from "./fixtures.js";

for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: real browser uploads, cleanup and logout preserve the trusted origin`, { timeout: 60_000 }, async (t) => {
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

    const loggedOut = page.waitForResponse((result) => new URL(result.url()).pathname === "/auth/logout");
    await page.locator("#logout-button").click();
    assert.equal((await loggedOut).status(), 200);
    await page.getByRole("link", { name: "Accedi con Microsoft", exact: true }).waitFor({ state: "visible" });
    assert.ok(requests.every((req) => req.origin === origin), JSON.stringify(requests));
    assert.deepEqual(browserErrors, []);
  });
}
