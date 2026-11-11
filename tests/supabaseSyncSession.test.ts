import { signedSyncToken, syncAuthFixture } from "./syncAuthFixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifySupabaseSyncSession } from "../server/auth/supabaseSyncSession.ts";
import { generateKeyPairSync } from "node:crypto";
import { createSupabaseVerifier } from "../server/auth/supabaseVerifier.ts";

const principal = { id: "user-1", isAnonymous: false };
const claims = { iss: "https://project.example/auth/v1", sub: "user-1", role: "authenticated", aud: "authenticated", session_id: "00000000-0000-0000-0000-000000000001" };
const jwt = signedSyncToken;
const verifier = { async verify() { return principal; } };

test("sync credentials require verified issuer, principal, account and session", async () => {
  const token = jwt(JSON.stringify(claims));
  assert.equal((await verifySupabaseSyncSession(token, verifier, "https://project.example", syncAuthFixture)).sessionId, claims.session_id);
  for (const patch of [{ sub: "other" }, { iss: "https://other/auth/v1" }, { role: "service_role" }, { aud: "anon" }, { session_id: "invalid" }]) {
    await assert.rejects(() => verifySupabaseSyncSession(jwt(JSON.stringify({ ...claims, ...patch })), verifier, "https://project.example", syncAuthFixture));
  }
  await assert.rejects(() => verifySupabaseSyncSession(token, { async verify() { throw new Error("bad signature"); } }, "https://project.example", syncAuthFixture));
  await assert.rejects(() => verifySupabaseSyncSession(token, { async verify() { return { id: "user-1", isAnonymous: true }; } }, "https://project.example", syncAuthFixture));
});

test("sync credentials reject duplicate decoded claim names", async () => {
  const valid = JSON.stringify(claims);
  const duplicate = valid.slice(0, -1) + ',"session_\\u0069d":"00000000-0000-0000-0000-000000000002"}';
  await assert.rejects(() => verifySupabaseSyncSession(jwt(duplicate), verifier, "https://project.example", syncAuthFixture));
  const nested = valid.slice(0, -1) + ',"nested":{"x":1,"x":2}}';
  await assert.rejects(() => verifySupabaseSyncSession(jwt(nested), verifier, "https://project.example", syncAuthFixture));
});

test("sync requires an approved ES256 signature and matching live session ownership", async () => {
  const token = jwt(JSON.stringify(claims));
  const check = (value: string, options = syncAuthFixture) => verifySupabaseSyncSession(value, verifier, "https://project.example", options);
  await assert.rejects(() => check(jwt(JSON.stringify({ ...claims, session_id: "00000000-0000-0000-0000-000000000000" }))));
  await assert.rejects(() => check(jwt(JSON.stringify(claims), '{"alg":"HS256","kid":"test"}')));
  await assert.rejects(() => check(jwt(JSON.stringify(claims), '{"alg":"ES256","kid":"test","k\\u0069d":"test"}')));
  await assert.rejects(() => check(token.slice(0, -2) + "AA"));
  await assert.rejects(() => check(token, { ...syncAuthFixture, fetchImpl: async () => new Response("false") }));
  await assert.rejects(() => check(token, { ...syncAuthFixture, fetchImpl: async () => new Response("unavailable", { status: 503 }) }));
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const next = { ...other, kid: "next" };
  assert.equal((await check(token, { ...syncAuthFixture, publicKeys: [...syncAuthFixture.publicKeys, next] })).sessionId, claims.session_id);
  await assert.rejects(() => check(token, { ...syncAuthFixture, publicKeys: [next] }));
});

test("sync authentication times out during response headers and body", async () => {
  const token = jwt(JSON.stringify(claims));
  const never = () => new Promise<never>(() => {});
  const stalledBody = () => ({ ok: true, json: never }) as unknown as Response;
  for (const fetchImpl of [never, async () => stalledBody()]) {
    const auth = createSupabaseVerifier({ supabaseUrl: "https://project.example", publishableKey: "public", fetchImpl });
    await assert.rejects(() => verifySupabaseSyncSession(token, auth, "https://project.example", { ...syncAuthFixture, timeoutMs: 10 }), /timed out/);
    await assert.rejects(() => verifySupabaseSyncSession(token, verifier, "https://project.example", { ...syncAuthFixture, fetchImpl, timeoutMs: 10 }), /timed out/);
  }
});

test("a late authentication result after timeout cannot start ownership verification", async () => {
  let release!: (value: typeof principal) => void;
  const pending = new Promise<typeof principal>(resolve => { release = resolve; });
  let rpcCalls = 0;
  const result = verifySupabaseSyncSession(jwt(JSON.stringify(claims)), { verify: () => pending }, "https://project.example", {
    ...syncAuthFixture, timeoutMs: 10, fetchImpl: async () => { rpcCalls++; return new Response("true"); },
  });
  await assert.rejects(result, /timed out/);
  release(principal);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rpcCalls, 0);
});
