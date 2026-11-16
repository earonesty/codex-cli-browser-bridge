import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyAuthorizationResponse } from "../src/host-authorization.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const request = { executorId: "fixture", sessionId: "test-session", turnId: "test-turn", nonce: "unique-fixture" };
function response(allowed, override = {}) {
  const payload = JSON.stringify({ domain: "codex.browserAccess.v1", request, allowed, ...override });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64") };
}

test("requires a valid host signature and preserves a signed denial", () => {
  assert.equal(verifyAuthorizationResponse(response(true), request, key), true);
  assert.equal(verifyAuthorizationResponse(response(false), request, key), false);
});

test("rejects modified grants, replayed turns, and wrong domains", () => {
  const denied = response(false);
  assert.throws(() => verifyAuthorizationResponse({ ...denied, payload: denied.payload.replace('"allowed":false', '"allowed":true') }, request, key), /signature/);
  assert.throws(() => verifyAuthorizationResponse(response(true), { ...request, turnId: "different-turn" }, key), /does not match/);
  assert.throws(() => verifyAuthorizationResponse(response(true, { domain: "different-domain" }), request, key), /does not match/);
});

test("rejects a different signing key and malformed responses", () => {
  const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.throws(() => verifyAuthorizationResponse(response(true), request, otherKey), /signature/);
  assert.throws(() => verifyAuthorizationResponse({}, request, key), /malformed/);
});
