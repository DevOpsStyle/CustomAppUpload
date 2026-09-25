import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthenticationResult } from "@azure/msal-node";
import { checkAttempt, equalSecret, validateIdentity } from "../server/auth.js";
import { testConfig } from "./fixtures.js";

const connection = testConfig().connection;
assert.ok(connection);
const claims = {
  tid: connection.tenantId,
  aud: connection.clientId,
  iss: `https://login.microsoftonline.com/${connection.tenantId}/v2.0`,
  oid: "55555555-5555-5555-5555-555555555555",
  nonce: "test-nonce",
  exp: Math.floor(Date.now() / 1000) + 3600,
};
function authenticationResult(idTokenClaims: object = claims): AuthenticationResult {
  return {
    authority: "https://login.microsoftonline.com/" + claims.tid,
    uniqueId: claims.oid,
    tenantId: claims.tid,
    scopes: ["https://storage.azure.com/user_impersonation"],
    account: {
      homeAccountId: "test-home",
      localAccountId: claims.oid,
      environment: "login.microsoftonline.com",
      tenantId: claims.tid,
      username: "user@example.invalid",
    },
    idToken: "test-placeholder",
    idTokenClaims,
    accessToken: "test-placeholder",
    fromCache: false,
    expiresOn: new Date(Date.now() + 3_600_000),
    tokenType: "Bearer",
    correlationId: "66666666-6666-6666-6666-666666666666",
  };
}

test("state is bound to the browser login attempt and expires after ten minutes", () => {
  const attempt = { state: "correct-state", nonce: "nonce", verifier: "pkce", createdAt: 1000 };
  assert.equal(checkAttempt(attempt, "correct-state", 1001), attempt);
  assert.throws(() => checkAttempt(attempt, "wrong-state", 1001), { code: "INVALID_LOGIN_STATE" });
  assert.throws(() => checkAttempt(undefined, "correct-state", 1001), { code: "INVALID_LOGIN_STATE" });
  assert.throws(() => checkAttempt(attempt, "correct-state", 602_000), { code: "INVALID_LOGIN_STATE" });
  assert.throws(() => checkAttempt(attempt, "correct-state", 999), { code: "INVALID_LOGIN_STATE" });
  assert.equal(equalSecret(["correct-state"], "correct-state"), false);
  assert.equal(equalSecret("correct-state", "correct-state"), true);
});

test("accepts only the registered tenant, application, issuer and original nonce", () => {
  assert.ok(connection);
  assert.equal(validateIdentity(authenticationResult(), connection, "test-nonce"), claims.oid);
  for (const change of [
    { tid: "other-tenant" }, { aud: "other-app" }, { iss: "https://evil.example.invalid" },
    { nonce: "other-nonce" }, { exp: 0 }, { oid: "not-a-guid" },
  ]) {
    assert.throws(() => validateIdentity(authenticationResult({ ...claims, ...change }), connection, "test-nonce"), { code: "INVALID_IDENTITY" });
  }
  const noAccount = authenticationResult();
  noAccount.account = null;
  assert.throws(() => validateIdentity(noAccount, connection, "test-nonce"), { code: "INVALID_IDENTITY" });
});
