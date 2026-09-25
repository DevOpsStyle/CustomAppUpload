import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../server/config.js";
import { testConfig } from "./fixtures.js";

test("configuration uses the agreed decimal 250 MB limit and Files/demo", () => {
  const config = testConfig();
  assert.equal(config.maxUploadBytes, 250_000_000);
  assert.equal(config.rootPath, "Files/demo");
  assert.equal(config.secureCookies, false);
  assert.ok(config.connection);
});

test("missing credentials disable real login without a development bypass", () => {
  const config = loadConfig({});
  assert.equal(config.connection, null);
  assert.ok(config.missing.includes("ENTRA_CLIENT_SECRET"));
  assert.ok(config.missing.includes("SESSION_SECRET"));
});

test("normalizes GUID casing before comparing Entra claims and OneLake paths", () => {
  const config = testConfig({ ENTRA_TENANT_ID: "ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF" });
  assert.equal(config.connection?.tenantId, "abcdefab-abcd-abcd-abcd-abcdefabcdef");
});

test("production requires an explicit public origin", () => {
  const config = testConfig({ NODE_ENV: "production", APP_BASE_URL: "" });
  assert.equal(config.connection, null);
  assert.ok(config.missing.includes("APP_BASE_URL"));
  assert.throws(() => testConfig({ NODE_ENV: "production", APP_BASE_URL: "http://localhost:3000" }));
  assert.equal(testConfig({ NODE_ENV: "production", APP_BASE_URL: "https://demo.example.invalid" }).secureCookies, true);
});

test("rejects invalid origins, untrusted storage endpoints, paths and limits", () => {
  for (const APP_BASE_URL of ["http://public.example.invalid", "https://demo.example.invalid/path", "https://user:password@demo.example.invalid"]) {
    assert.throws(() => testConfig({ APP_BASE_URL }));
  }
  for (const ONELAKE_ENDPOINT of ["https://evil.example.invalid", "http://onelake.dfs.fabric.microsoft.com", "https://onelake.dfs.fabric.microsoft.com.evil.test", "https://onelake.dfs.fabric.microsoft.com/path"]) {
    assert.throws(() => testConfig({ ONELAKE_ENDPOINT }));
  }
  assert.equal(testConfig({ ONELAKE_ENDPOINT: "https://westeurope-onelake.dfs.fabric.microsoft.com" }).endpoint, "https://westeurope-onelake.dfs.fabric.microsoft.com");
  for (const ONELAKE_ROOT_PATH of ["Tables/private", "Files/../Tables", "/Files/demo"]) {
    assert.throws(() => testConfig({ ONELAKE_ROOT_PATH }));
  }
  for (const MAX_UPLOAD_MB of ["0", "-1", "NaN", "2.5", "999999"]) {
    assert.throws(() => testConfig({ MAX_UPLOAD_MB }));
  }
  assert.throws(() => testConfig({ SESSION_SECRET: "weak" }));
  assert.throws(() => testConfig({ ENTRA_TENANT_ID: "common" }));
});
