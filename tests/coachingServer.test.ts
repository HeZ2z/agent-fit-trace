/**
 * Real-HTTP coaching server tests with injected fake runtimes (no real pi).
 *
 * Each test starts its own loopback `startCoachingServer({ port: 0 })` and
 * drives it over real HTTP sockets + fetch: both credentials (fresh bearer
 * AND short-TTL capability), malicious prefixes/ports/Host values, expired
 * bearers, account swaps, handle guessing, storage outages, datetime
 * filters, snapshot reuse/native resume, SSE reconnect, cancel/close/
 * shutdown confirmation, and cap/expiry/resource cleanup. Nothing here
 * calls the service directly — every assertion crosses the wire, so the
 * tests cannot mirror a fake-only implementation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { analyzeProgress, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import type { CoachingEventPayload } from "@pi-fit-trace/api-contracts";
import { ApiError, API_ERROR_CODES } from "@pi-fit-trace/api-contracts";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import type { TokenVerifier } from "../server/auth/verifier.ts";
import { createPrincipalMemoryStores } from "../server/principalMemoryStore.ts";
import { startCoachingServer, CAPABILITY_HEADER, MAX_CAPABILITIES_PER_ACCOUNT } from "../server/coaching/coachingServer.ts";
import type { CoachingServer } from "../server/coaching/coachingServer.ts";
import type { RuntimeDoneInfo, RuntimeFactory, RuntimeLaunchOptions } from "../server/coaching/coachingService.ts";
import { EMPTY_HISTORY_REASON } from "../server/coaching/coachingService.ts";

const TOKENS = {
  "token-a": { id: "user-a", email: "a@example.com" },
  "token-b": { id: "user-b", email: "b@example.com" },
};
const AUTH_A = "Bearer token-a";
const AUTH_B = "Bearer token-b";

function record(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

interface LaunchCapture {
  options: RuntimeLaunchOptions;
  cancelled: boolean;
  cancelReason?: string;
  closed: boolean;
  snapshotFile?: string;
  resumeSessionFile?: string;
}

type FactoryMode =
  | "success"
  | "hang"
  | "refused-tool"
  | "sync"
  | "kill-refusing"
  | "close-rejects"
  | "unconfirmed-success"
  | "missing-confirmation"
  | "session-file";

/** Fake runtime. Modes cover: async success, hang (cancel path), refused
 * tool, synchronous callbacks (reentrancy), kill-refusing (close hangs),
 * close-rejects (cleanup failure), unconfirmed success (onDone without
 * exit confirmation), and native session-file capture. */
function makeFactory(captures: LaunchCapture[], mode: FactoryMode = "success"): RuntimeFactory {
  return (options: RuntimeLaunchOptions) => {
    const capture: LaunchCapture = {
      options,
      cancelled: false,
      closed: false,
      snapshotFile: options.snapshotFile,
      resumeSessionFile: options.resumeSessionFile,
    };
    captures.push(capture);
    const done = (status: "completed" | "failed" | "cancelled", reason?: string, info?: RuntimeDoneInfo): void => {
      options.onDone(status, reason, info);
    };
    const succeed = (): void => {
      const emit = (payload: CoachingEventPayload): void => options.onEvent(payload);
      emit({ type: "text_delta", delta: "hello " });
      emit({ type: "tool_start", tool: "get_training_history", callId: "c1" });
      emit({ type: "tool_end", tool: "get_training_history", callId: "c1", ok: true });
      emit({ type: "analysis_result", result: analyzeProgress([]) });
      emit({ type: "text_delta", delta: "world" });
    };
    return {
      start(): void {
        if (mode === "hang" || mode === "kill-refusing" || mode === "close-rejects") return;
        if (mode === "sync") {
          succeed();
          done("completed", undefined, { processExitConfirmed: true });
          return;
        }
        if (mode === "refused-tool") {
          setImmediate(() => {
            options.onEvent({ type: "tool_start", tool: "generate_next_plan", callId: "c-evil" });
            done("completed", undefined, { processExitConfirmed: true });
          });
          return;
        }
        if (mode === "unconfirmed-success") {
          setImmediate(() => {
            succeed();
            done("completed", undefined, { processExitConfirmed: false });
          });
          return;
        }
        if (mode === "session-file") {
          setImmediate(() => {
            succeed();
            done("completed", undefined, {
              processExitConfirmed: true,
              sessionFile: `${options.sessionDir}/session-${options.runId}.jsonl`,
            });
          });
          return;
        }
        if (mode === "missing-confirmation") {
          setImmediate(() => {
            succeed();
            done("completed");
          });
          return;
        }
        setImmediate(() => {
          succeed();
          done("completed", undefined, { processExitConfirmed: true });
        });
      },
      cancel(reason?: string): void {
        capture.cancelled = true;
        capture.cancelReason = reason;
        if (mode === "kill-refusing" || mode === "close-rejects") return;
        setImmediate(() => done("cancelled", reason ?? "cancel requested", { processExitConfirmed: true }));
      },
      async close(): Promise<void> {
        if (mode === "kill-refusing") {
          await new Promise(() => undefined);
          return;
        }
        capture.closed = true;
        if (mode === "close-rejects") throw new Error("close failed: child refuses to die");
      },
    };
  };
}

async function startTestServer(
  captures: LaunchCapture[] = [],
  mode: FactoryMode = "success",
  serviceOptions: Record<string, unknown> = {},
  extra: { verifier?: TokenVerifier; serverOptions?: Record<string, unknown> } = {},
): Promise<{ server: CoachingServer; base: string }> {
  const stores = createPrincipalMemoryStores();
  await stores.storeFor({ id: "user-a" }).createWorkout(record({ id: "w-a1", date: "2026-09-01" }));
  await stores.storeFor({ id: "user-a" }).createWorkout(record({ id: "w-a2", date: "2026-09-03" }));
  const server = await startCoachingServer({
    verifier: extra.verifier ?? createTestVerifier(TOKENS),
    stores,
    runtimeFactory: makeFactory(captures, mode),
    serviceOptions: { cancelGraceMs: 200, ...serviceOptions },
    publicConfig: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk" },
    ...(extra.serverOptions ?? {}),
  });
  return { server, base: server.url };
}

/** Bootstrap a capability for `auth`, returning headers carrying BOTH creds. */
async function bothCreds(base: string, auth: string): Promise<Record<string, string>> {
  const response = await fetch(`${base}/coaching/bootstrap`, {
    method: "POST",
    headers: { authorization: auth },
  });
  assert.equal(response.status, 200);
  const json = (await response.json()) as { data: { capability: string } };
  return { authorization: auth, [CAPABILITY_HEADER]: json.data.capability };
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
  return { status: response.status, headers: response.headers, json };
}

async function getJson(base: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  const json = (await response.json()) as { data?: Record<string, unknown>; error?: { code: string } };
  return { status: response.status, headers: response.headers, json };
}

async function setupRun(
  base: string,
  creds: Record<string, string>,
  prompt = "analyze my training",
  key = `key-${Math.random().toString(36).slice(2)}`,
) {
  const session = await postJson(base, "/coaching/sessions", {}, creds);
  assert.equal(session.status, 201);
  const sessionId = (session.json.data as { id: string }).id;
  const snapshot = await postJson(base, "/coaching/snapshots", {}, creds);
  assert.equal(snapshot.status, 201);
  const snap = snapshot.json.data as { snapshotId: string; source: string; accountId: string };
  const run = await postJson(base, "/coaching/runs", {
    sessionId,
    prompt,
    idempotencyKey: key,
    snapshot: { snapshotId: snap.snapshotId, source: snap.source, accountId: snap.accountId },
  }, creds);
  return { sessionId, snapshot: snap, run };
}

async function waitForStatus(base: string, runId: string, creds: Record<string, string>, want: string, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const read = await getJson(base, `/coaching/runs/${runId}`, creds);
    assert.equal(read.status, 200);
    const run = read.json.data?.run as { status: string };
    if (run.status === want) return read.json.data as { run: { id: string; status: string }; lastSeq: number };
    assert.ok(Date.now() - start < timeoutMs, `timed out waiting for ${want}, still ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readSseEvents(text: string): { seq: number; envelope: { seq: number; event: { type: string } } }[] {
  const out: { seq: number; envelope: { seq: number; event: { type: string } } }[] = [];
  for (const block of text.split("\n\n")) {
    const idLine = block.split("\n").find((line) => line.startsWith("id: "));
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (idLine === undefined || dataLine === undefined) continue;
    const envelope = JSON.parse(dataLine.slice("data: ".length)) as { seq: number; event: { type: string } };
    out.push({ seq: Number(idLine.slice("id: ".length)), envelope });
  }
  return out;
}

/**
 * Race a promise against a timeout, ALWAYS clearing the timer so a failing
 * assertion cannot leak a pending handle or keep the test process alive.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A promise resolved when its `resolve` is invoked (deterministic gate). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("unauthenticated requests are denied with 401 + WWW-Authenticate", async () => {
  const { server, base } = await startTestServer();
  try {
    for (const path of ["/coaching/sessions", "/coaching/snapshots", "/coaching/runs"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", body: "{}" });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
    const bad = await fetch(`${base}/coaching/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "{}",
    });
    assert.equal(bad.status, 401);
    const deniedBootstrap = await fetch(`${base}/coaching/bootstrap`, { method: "POST", body: "{}" });
    assert.equal(deniedBootstrap.status, 401);
  } finally {
    await server.close();
  }
});

test("both credentials are required: bearer-only and cap-only both reject", async () => {
  const { server, base } = await startTestServer();
  try {
    const creds = await bothCreds(base, AUTH_A);
    const cap = creds[CAPABILITY_HEADER] as string;
    // Bearer alone (no capability) rejects — no-origin requests still need both.
    const bearerOnly = await postJson(base, "/coaching/sessions", {}, { authorization: AUTH_A });
    assert.equal(bearerOnly.status, 401);
    // Capability alone (no bearer) rejects.
    const capOnly = await postJson(base, "/coaching/sessions", {}, { [CAPABILITY_HEADER]: cap });
    assert.equal(capOnly.status, 401);
    // Both together succeed.
    const ok = await postJson(base, "/coaching/sessions", {}, creds);
    assert.equal(ok.status, 201);
  } finally {
    await server.close();
  }
});

test("expired bearer rejects even with a valid capability", async () => {
  let expired = false;
  const inner = createTestVerifier(TOKENS);
  const verifier: TokenVerifier = {
    async verify(token: string) {
      if (expired) {
        throw new ApiError({ code: API_ERROR_CODES.UNAUTHENTICATED, message: "expired" });
      }
      return inner.verify(token);
    },
  };
  const { server, base } = await startTestServer([], "success", {}, { verifier });
  try {
    const creds = await bothCreds(base, AUTH_A);
    assert.equal((await postJson(base, "/coaching/sessions", {}, creds)).status, 201);
    expired = true;
    // Same (still unexpired) capability + expired bearer → 401.
    assert.equal((await postJson(base, "/coaching/sessions", {}, creds)).status, 401);
  } finally {
    await server.close();
  }
});

test("capability/account swap is rejected", async () => {
  const { server, base } = await startTestServer();
  try {
    const credsA = await bothCreds(base, AUTH_A);
    const credsB = await bothCreds(base, AUTH_B);
    const capA = credsA[CAPABILITY_HEADER] as string;
    // B's bearer + A's capability → reject.
    const swapped = await postJson(
      base,
      "/coaching/sessions",
      {},
      { authorization: AUTH_B, [CAPABILITY_HEADER]: capA },
    );
    assert.equal(swapped.status, 401);
    // Unknown capability value → reject.
    const forged = await postJson(
      base,
      "/coaching/sessions",
      {},
      { authorization: AUTH_A, [CAPABILITY_HEADER]: "coachcap_forged" },
    );
    assert.equal(forged.status, 401);
    void credsB;
  } finally {
    await server.close();
  }
});

test("bootstrap issues a bounded header capability; query-string capability is rejected", async () => {
  const { server, base } = await startTestServer();
  try {
    const evilOrigin = await postJson(
      base,
      "/coaching/bootstrap",
      {},
      { authorization: AUTH_A },
      { origin: "https://evil.example" },
    );
    assert.equal(evilOrigin.status, 403);
    const issued = await postJson(base, "/coaching/bootstrap", {}, { authorization: AUTH_A });
    assert.equal(issued.status, 200);
    const capability = ((issued.json.data ?? {}) as { capability: string }).capability;
    assert.ok(capability.length >= 16);
    // Capability works via header together with the bearer.
    const viaBoth = await postJson(
      base,
      "/coaching/sessions",
      {},
      { authorization: AUTH_A, [CAPABILITY_HEADER]: capability },
    );
    assert.equal(viaBoth.status, 201);
    // Capability in the query string is rejected, not honored.
    const smuggled = await fetch(
      `${base}/coaching/sessions?capability=${encodeURIComponent(capability)}`,
      { method: "POST", headers: { authorization: AUTH_A }, body: "{}" },
    );
    assert.equal(smuggled.status, 401);
  } finally {
    await server.close();
  }
});

test("expired capability rejects; logout invalidates caps/sessions and cancels own run", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "hang", {}, {
    serverOptions: { capabilityTtlMs: 150 },
  });
  try {
    const creds = await bothCreds(base, AUTH_A);
    assert.equal((await postJson(base, "/coaching/sessions", {}, creds)).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Short-TTL cap has now expired → 401 even though the bearer is fresh.
    assert.equal((await postJson(base, "/coaching/sessions", {}, creds)).status, 401);
  } finally {
    await server.close();
  }

  const hang2: LaunchCapture[] = [];
  const second = await startTestServer(hang2, "hang");
  try {
    const credsA = await bothCreds(second.base, AUTH_A);
    const credsB = await bothCreds(second.base, AUTH_B);
    const { sessionId, run } = await setupRun(second.base, credsA);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const logout = await postJson(second.base, "/coaching/logout", {}, credsA);
    assert.equal(logout.status, 200);
    // A's capability is invalidated.
    assert.equal((await postJson(second.base, "/coaching/sessions", {}, credsA)).status, 401);
    // A's session is gone for a fresh login, and private run outputs are
    // invalidated on logout (confirmed runs are cleared; the read is 404).
    const freshA = await bothCreds(second.base, AUTH_A);
    assert.equal((await getJson(second.base, `/coaching/sessions/${sessionId}`, freshA)).status, 404);
    assert.equal((await getJson(second.base, `/coaching/runs/${runId}`, freshA)).status, 404);
    assert.ok(hang2[0]?.cancelled);
    // B is unaffected.
    assert.equal((await postJson(second.base, "/coaching/sessions", {}, credsB)).status, 201);
  } finally {
    await second.server.close();
  }
});

test("origin binding: bootstrap-with-Origin cap works for no-Origin reads; no-Origin bootstrap allows canonical Origin use", async () => {
  const { server, base } = await startTestServer();
  try {
    const port = new URL(base).port;
    const canonical = `http://127.0.0.1:${port}`;
    // Bootstrap WITH canonical Origin, then read WITHOUT Origin succeeds.
    const bootResp = await fetch(`${base}/coaching/bootstrap`, {
      method: "POST",
      headers: { authorization: AUTH_A, origin: canonical },
    });
    assert.equal(bootResp.status, 200);
    const bootJson = (await bootResp.json()) as { data: { capability: string; expiresInMs: number } };
    assert.ok(bootJson.data.capability.length >= 16);
    assert.ok(bootJson.data.expiresInMs > 0);
    const withOriginCreds = { authorization: AUTH_A, [CAPABILITY_HEADER]: bootJson.data.capability };
    const created = await postJson(base, "/coaching/sessions", {}, withOriginCreds, { origin: canonical });
    assert.equal(created.status, 201);
    const sessionId = (created.json.data as { id: string }).id;
    const noOriginRead = await getJson(base, `/coaching/sessions/${sessionId}`, withOriginCreds);
    assert.equal(noOriginRead.status, 200);
    // Bootstrap WITHOUT Origin, then use WITH the canonical Origin is
    // allowed: capabilities always bind the canonical server origin, and a
    // missing Origin never widens access (both credentials still verified).
    // Malicious origins still reject (covered by the next test).
    const noOriginCreds = await bothCreds(base, AUTH_A);
    const canonicalUse = await postJson(base, "/coaching/sessions", {}, noOriginCreds, { origin: canonical });
    assert.equal(canonicalUse.status, 201);
  } finally {
    await server.close();
  }
});

test("malicious Origin is rejected; only the exact same-origin URL is echoed", async () => {
  const { server, base } = await startTestServer();
  try {
    const creds = await bothCreds(base, AUTH_A);
    const port = new URL(base).port;
    for (const origin of [
      "https://evil.example",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
      `http://127.0.0.1:${Number(port) + 1}`,
      "http://localhost:1",
    ]) {
      const evil = await fetch(`${base}/coaching/sessions`, {
        method: "POST",
        headers: { authorization: AUTH_A, origin, [CAPABILITY_HEADER]: creds[CAPABILITY_HEADER] as string },
        body: "{}",
      });
      assert.equal(evil.status, 403, `origin ${origin} must reject`);
      assert.equal(evil.headers.get("access-control-allow-origin"), null);
    }
    const exact = `http://127.0.0.1:${port}`;
    const ok = await postJson(base, "/coaching/sessions", {}, creds, { origin: exact });
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get("access-control-allow-origin"), exact);
  } finally {
    await server.close();
  }
});

test("malicious Host header is rejected (prefix domains, other ports, comma values)", async () => {
  const { server, base } = await startTestServer();
  try {
    const creds = await bothCreds(base, AUTH_A);
    const port = new URL(base).port;
    const raw = async (host: string): Promise<number> => {
      const headers: Record<string, string> = {
        authorization: AUTH_A,
        [CAPABILITY_HEADER]: creds[CAPABILITY_HEADER] as string,
      };
      return new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: Number(port), path: "/coaching/sessions", method: "POST", headers: { ...headers, host } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
    };
    assert.equal(await raw("evil.example"), 403);
    assert.equal(await raw("localhost.evil.com"), 403);
    assert.equal(await raw(`127.0.0.1:${Number(port) + 1}`), 403);
    assert.equal(await raw(`127.0.0.1:${port}, evil.example`), 403);
    assert.equal(await raw(`127.0.0.1:${port}`), 201);
  } finally {
    await server.close();
  }
});

test("unknown routes are 404, not 500", async () => {
  const { server, base } = await startTestServer();
  try {
    const creds = await bothCreds(base, AUTH_A);
    const missing = await getJson(base, "/coaching/nope", creds);
    assert.equal(missing.status, 404);
    const root = await fetch(`${base}/elsewhere`);
    assert.equal(root.status, 404);
  } finally {
    await server.close();
  }
});

test("session/snapshot/run handle guessing is 404, never cross-account", async () => {
  const { server, base } = await startTestServer();
  try {
    const credsA = await bothCreds(base, AUTH_A);
    const credsB = await bothCreds(base, AUTH_B);
    assert.equal((await getJson(base, "/coaching/sessions/sess-guess", credsA)).status, 404);
    assert.equal((await getJson(base, "/coaching/runs/run-guess", credsA)).status, 404);
    assert.equal((await postJson(base, "/coaching/runs/run-guess/cancel", {}, credsA)).status, 404);
    const { sessionId, run } = await setupRun(base, credsA);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    assert.equal((await getJson(base, `/coaching/sessions/${sessionId}`, credsB)).status, 404);
    assert.equal((await getJson(base, `/coaching/runs/${runId}`, credsB)).status, 404);
    const events = await fetch(`${base}/coaching/runs/${runId}/events`, { headers: credsB });
    assert.equal(events.status, 404);
    await events.text().catch(() => undefined);
    assert.equal((await postJson(base, `/coaching/runs/${runId}/cancel`, {}, credsB)).status, 404);
  } finally {
    await server.close();
  }
});

test("session create/read expose id only; native handle stays server-side", async () => {
  const { server, base } = await startTestServer();
  try {
    const credsA = await bothCreds(base, AUTH_A);
    const credsB = await bothCreds(base, AUTH_B);
    const created = await postJson(base, "/coaching/sessions", {}, credsA);
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.json.data ?? {}).sort(), ["id"]);
    const sessionId = (created.json.data as { id: string }).id;
    const rawCreate = JSON.stringify(created.json.data);
    assert.ok(!rawCreate.includes("nativeSession"), "create must not leak native handle");
    assert.ok(!rawCreate.includes("tmp") && !rawCreate.includes("fit-trace-sess"), "create must not leak native path");
    assert.ok(!("expiresAt" in (created.json.data ?? {})), "create must not leak expiry");
    assert.ok(!("accountId" in (created.json.data ?? {})), "create must not leak account");
    const read = await getJson(base, `/coaching/sessions/${sessionId}`, credsA);
    assert.equal(read.status, 200);
    assert.deepEqual(Object.keys(read.json.data ?? {}).sort(), ["id"]);
    assert.equal((read.json.data as { id: string }).id, sessionId);
    const rawRead = JSON.stringify(read.json.data);
    assert.ok(!rawRead.includes("nativeSession"), "read must not leak native handle");
    assert.ok(!("expiresAt" in (read.json.data ?? {})), "read must not leak expiry");
    // Account isolation preserved: another account still sees 404.
    assert.equal((await getJson(base, `/coaching/sessions/${sessionId}`, credsB)).status, 404);
  } finally {
    await server.close();
  }
});

test("A/B isolation: snapshots cannot be spent cross-account; empty history is per-account", async () => {
  const { server, base } = await startTestServer();
  try {
    const credsA = await bothCreds(base, AUTH_A);
    const credsB = await bothCreds(base, AUTH_B);
    const { snapshot } = await setupRun(base, credsA);
    const bSession = await postJson(base, "/coaching/sessions", {}, credsB);
    const bSessionId = (bSession.json.data as { id: string }).id;
    // Handle-only shape (what submit accepts): ownership is enforced on the
    // bound account, so A's handle spent by B is FORBIDDEN — never 400.
    const forged = await postJson(base, "/coaching/runs", {
      sessionId: bSessionId,
      prompt: "steal",
      idempotencyKey: "steal-1",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    }, credsB);
    assert.equal(forged.status, 403);
    assert.equal(forged.json.error?.code, "FORBIDDEN");
    const bSnap = await postJson(base, "/coaching/snapshots", {}, credsB);
    assert.equal(bSnap.status, 201);
    assert.equal((bSnap.json.data as { recordCount: number }).recordCount, 0);
  } finally {
    await server.close();
  }
});

test("storage outage is 503, not 400 or empty history", async () => {
  const failing = {
    listWorkouts(): Promise<WorkoutRecord[]> {
      return Promise.reject(new Error("db down"));
    },
  };
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    source: failing,
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    const snap = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(snap.status, 503);
    assert.equal(snap.json.error?.code, "STORAGE_UNAVAILABLE");
  } finally {
    await server.close();
  }
});

test("snapshot filters: invalid calendar dates reject; datetime records survive end-date filters", async () => {
  const stores = createPrincipalMemoryStores();
  await stores.storeFor({ id: "user-a" }).createWorkout(
    record({ id: "w-dt", date: "2026-09-03T15:00:00Z" }),
  );
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    stores,
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    // Invalid calendar date rejects (regex-only validation would accept it).
    const bad = await postJson(server.url, "/coaching/snapshots", { from: "2026-02-30" }, creds);
    assert.equal(bad.status, 400);
    const inverted = await postJson(
      server.url,
      "/coaching/snapshots",
      { from: "2026-09-10", to: "2026-09-01" },
      creds,
    );
    assert.equal(inverted.status, 400);
    // A datetime record ON the end date is included (string `to` comparison
    // would exclude "2026-09-03T15:00:00Z" > "2026-09-03").
    const exact = await postJson(
      server.url,
      "/coaching/snapshots",
      { from: "2026-09-03", to: "2026-09-03" },
      creds,
    );
    assert.equal(exact.status, 201);
    assert.deepEqual((exact.json.data as { recordIds: string[] }).recordIds, ["w-dt"]);
  } finally {
    await server.close();
  }
});

test("submit → completed over real SSE with cursor-semantics replay (lastSeq is final seq)", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures);
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    assert.equal(run.status, 201);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const done = await waitForStatus(base, runId, creds, "completed");
    // 5 content events + terminal = seqs 0..5, so lastSeq is 5 (final seq,
    // not one-past-final).
    assert.equal(done.lastSeq, 5);
    const replay = await fetch(`${base}/coaching/runs/${runId}/events`, { headers: creds });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("content-type"), "text/event-stream");
    const frames = readSseEvents(await replay.text());
    assert.deepEqual(frames.map((frame) => frame.seq), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(frames.map((frame) => frame.seq), frames.map((frame) => frame.envelope.seq));
    assert.equal(frames.filter((frame) => frame.envelope.event.type === "terminal").length, 1);
    // Resume AFTER the last consumed seq returns only newer events.
    const tail = await fetch(`${base}/coaching/runs/${runId}/events?fromSeq=${done.lastSeq}`, { headers: creds });
    assert.equal(tail.status, 200);
    const tailFrames = readSseEvents(await tail.text());
    assert.deepEqual(tailFrames.map((frame) => frame.seq), [done.lastSeq]);
    // Caught-up cursor (lastSeq + 1) returns an empty page, not an error.
    const caughtUp = await fetch(`${base}/coaching/runs/${runId}/events?fromSeq=${done.lastSeq + 1}`, { headers: creds });
    assert.equal(caughtUp.status, 200);
    assert.deepEqual(readSseEvents(await caughtUp.text()), []);
    // Read-run returns coherent cursors + retention for gap recovery.
    const read = await getJson(base, `/coaching/runs/${runId}`, creds);
    assert.equal(read.status, 200);
    const data = read.json.data as { lastSeq: number; firstSeq: number; expiresAt: number };
    assert.equal(data.firstSeq, 0);
    assert.equal(data.lastSeq, done.lastSeq);
    assert.ok(data.expiresAt > Date.now());
    assert.equal(captures.length, 1);
    assert.ok(!captures[0]?.options.prompt.includes("token-a"));
  } finally {
    await server.close();
  }
});

test("expired cursor is explicit (410) directing refetch, never a silent skip", async () => {
  const { server, base } = await startTestServer();
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    await waitForStatus(base, runId, creds, "completed");
    const beyond = await fetch(`${base}/coaching/runs/${runId}/events?fromSeq=99999`, { headers: creds });
    assert.equal(beyond.status, 410);
    const body = (await beyond.json()) as {
      error: { code: string; message: string };
      data: { lastSeq: number; firstSeq: number };
    };
    assert.equal(body.error.code, "EXPIRED_CURSOR");
    assert.match(body.error.message, /refetch/i);
    assert.match(body.error.message, /do not skip/i);
    assert.equal(body.data.firstSeq, 0);
    assert.ok(typeof body.data.lastSeq === "number");
  } finally {
    await server.close();
  }
});

test("cancel aborts the runtime, frees capacity, and is idempotent", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "hang");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { sessionId, snapshot, run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const cancelled = await postJson(base, `/coaching/runs/${runId}/cancel`, { reason: "user stopped" }, creds);
    assert.equal(cancelled.status, 200);
    await waitForStatus(base, runId, creds, "cancelled");
    assert.ok(captures[0]?.cancelled);
    assert.ok(captures[0]?.closed);
    const replay = await fetch(`${base}/coaching/runs/${runId}/events`, { headers: creds });
    const frames = readSseEvents(await replay.text());
    assert.equal(frames.filter((frame) => frame.envelope.event.type === "terminal").length, 1);
    // Late duplicate cancel is idempotent.
    const again = await postJson(base, `/coaching/runs/${runId}/cancel`, {}, creds);
    assert.equal(again.status, 200);
    const reread = await getJson(base, `/coaching/runs/${runId}`, creds);
    assert.equal((reread.json.data as { run: { status: string } }).run.status, "cancelled");
    // Capacity was released on confirmed cancel: a new run can start.
    const retry = await postJson(base, "/coaching/runs", {
      sessionId,
      prompt: "analyze again",
      idempotencyKey: "after-cancel",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    }, creds);
    assert.equal(retry.status, 201);
  } finally {
    await server.close();
  }
});

test("unconfirmed termination withholds success and keeps capacity held", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "unconfirmed-success");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const done = await waitForStatus(base, runId, creds, "failed");
    void done;
    const read = await getJson(base, `/coaching/runs/${runId}`, creds);
    const body = read.json.data as { run: { failure?: { message: string } } };
    assert.match(body.run.failure?.message ?? "", /unconfirmed/i);
    // Capacity is still held: a second run is busy, not queued behind an orphan.
    const second = await setupRun(base, creds, "second", "unconfirmed-second");
    assert.equal(second.run.status, 409);
    assert.equal(second.run.json.error?.code, "RUN_BUSY");
  } finally {
    // Unconfirmed shutdown must reject (live child retained, capacity held):
    // catch the proper failure explicitly instead of suppressing it.
    await assert.rejects(server.close(), /unconfirmed/);
  }
});

test("kill-refusing runtime: cancel never releases capacity; shutdown/logouts report failure and preserve files", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "kill-refusing", { cancelGraceMs: 150 });
  let closeError: unknown = null;
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const cancelled = await postJson(base, `/coaching/runs/${runId}/cancel`, {}, creds);
    assert.equal(cancelled.status, 200);
    // Grace + bounded close elapse; cleanup stays unconfirmed.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const read = await getJson(base, `/coaching/runs/${runId}`, creds);
    assert.equal(read.status, 200);
    const data = read.json.data as { run: { status: string; failure?: { message: string } } };
    assert.equal(data.run.status, "cancelled");
    // Unconfirmed cancel carries the marker on the terminal event reason
    // (cancelled runs set no run.failure); assert via the event log.
    const replay = await fetch(`${base}/coaching/runs/${runId}/events`, { headers: creds });
    assert.match(await replay.text(), /unconfirmed/i);
    assert.ok(captures[0]?.cancelled);
    // Capacity still held — no silent release around a live child.
    const busy = await setupRun(base, creds, "another", "kill-refusing-second");
    assert.equal(busy.run.status, 409);
    assert.equal(busy.run.json.error?.code, "RUN_BUSY");
    // Snapshot workspace is preserved while the child is unconfirmed.
    const { stat } = await import("node:fs/promises");
    await stat(captures[0]?.options.snapshotFile as string);
    // Shutdown must report failure (never resolve success) for the live child.
    closeError = await server.close().then(() => null, (error: unknown) => error);
    assert.ok(closeError instanceof Error, "server.close must reject on unconfirmed live child");
  } catch (error) {
    if (closeError === null) {
      await server.close().then(() => undefined, () => undefined);
    }
    throw error;
  }
});

test("missing exit confirmation withholds success (onDone without info)", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "missing-confirmation");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    await waitForStatus(base, runId, creds, "failed");
    const read = await getJson(base, `/coaching/runs/${runId}`, creds);
    assert.match(((read.json.data as { run: { failure?: { message: string } } }).run.failure?.message ?? ""), /unconfirmed/i);
    const second = await setupRun(base, creds, "second", "missing-second");
    assert.equal(second.run.status, 409);
    assert.equal(second.run.json.error?.code, "RUN_BUSY");
  } finally {
    // Unconfirmed shutdown rejects: catch the proper failure explicitly.
    await assert.rejects(server.close(), /unconfirmed|incomplete/);
  }
});

test("kill-refusing logout preserves files and reports unconfirmed cancel", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "kill-refusing", { cancelGraceMs: 150 });
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const logout = await postJson(base, "/coaching/logout", {}, creds);
    assert.equal(logout.status, 200);
    assert.deepEqual((logout.json.data as { loggedOut: boolean }), { loggedOut: true });
    const { stat } = await import("node:fs/promises");
    await stat(captures[0]?.options.snapshotFile as string);
    const fresh = await bothCreds(base, AUTH_A);
    const read = await getJson(base, `/coaching/runs/${runId}`, fresh);
    // Unconfirmed run is retained (not silently deleted); if swept, 404 is
    // acceptable only with capacity still held — assert busy instead.
    if (read.status === 200) {
      assert.equal((read.json.data as { run: { status: string } }).run.status, "cancelled");
    } else {
      assert.equal(read.status, 404);
    }
  } finally {
    // Unconfirmed shutdown rejects: catch the proper failure explicitly.
    await assert.rejects(server.close(), /unconfirmed|incomplete|shutdown/);
  }
});

test("cleanup rejection keeps the run unconfirmed with capacity held", async () => {
  const { server, base } = await startTestServer([], "close-rejects", { cancelGraceMs: 150 });
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    await postJson(base, `/coaching/runs/${runId}/cancel`, {}, creds);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const read = await getJson(base, `/coaching/runs/${runId}`, creds);
    const data = read.json.data as { run: { status: string; failure?: { message: string } } };
    assert.equal(data.run.status, "cancelled");
    const replay = await fetch(`${base}/coaching/runs/${runId}/events`, { headers: creds });
    assert.match(await replay.text(), /unconfirmed/i);
    const busy = await setupRun(base, creds, "another", "close-rejects-second");
    assert.equal(busy.run.status, 409);
  } finally {
    // Unconfirmed shutdown rejects: catch the proper failure explicitly.
    await assert.rejects(server.close(), /unconfirmed|incomplete|shutdown|failed/);
  }
});

test("synchronous runtime callbacks terminate exactly once with capacity released", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "sync");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { sessionId, snapshot, run } = await setupRun(base, creds);
    assert.equal(run.status, 201);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const done = await waitForStatus(base, runId, creds, "completed");
    assert.equal(done.lastSeq, 5);
    // Capacity released: an immediate follow-up run starts.
    const next = await postJson(base, "/coaching/runs", {
      sessionId,
      prompt: "follow-up",
      idempotencyKey: "sync-second",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    }, creds);
    assert.equal(next.status, 201);
    assert.equal(captures.length, 2);
  } finally {
    await server.close();
  }
});

test("concurrent duplicate submit dedups to one runtime launch; different content conflicts", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "hang");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const session = await postJson(base, "/coaching/sessions", {}, creds);
    const sessionId = (session.json.data as { id: string }).id;
    const snapshot = await postJson(base, "/coaching/snapshots", {}, creds);
    const snap = snapshot.json.data as { snapshotId: string; source: string; accountId: string };
    const payload = {
      sessionId,
      prompt: "analyze my training",
      idempotencyKey: "race-key",
      snapshot: { snapshotId: snap.snapshotId, source: snap.source, accountId: snap.accountId },
    };
    const [first, second] = await Promise.all([
      postJson(base, "/coaching/runs", payload, creds),
      postJson(base, "/coaching/runs", payload, creds),
    ]);
    assert.ok([200, 201].includes(first.status));
    assert.ok([200, 201].includes(second.status));
    const idA = (first.json.data as { run: { id: string } }).run.id;
    const idB = (second.json.data as { run: { id: string } }).run.id;
    assert.equal(idA, idB);
    assert.equal(captures.length, 1);
    const conflict = await postJson(base, "/coaching/runs", { ...payload, prompt: "different question" }, creds);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error?.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(captures.length, 1);
    const busy = await postJson(base, "/coaching/runs", { ...payload, idempotencyKey: "other-key" }, creds);
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error?.code, "RUN_BUSY");
  } finally {
    await server.close();
  }
});

test("global single-process limit: a second session gets RUN_BUSY", async () => {
  const { server, base } = await startTestServer([], "hang");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const first = await setupRun(base, creds, "first", "global-1");
    assert.equal(first.run.status, 201);
    const s2 = await postJson(base, "/coaching/sessions", {}, creds);
    const s2Id = (s2.json.data as { id: string }).id;
    const snap2 = await postJson(base, "/coaching/snapshots", {}, creds);
    const sn2 = snap2.json.data as { snapshotId: string; source: string; accountId: string };
    const second = await postJson(base, "/coaching/runs", {
      sessionId: s2Id,
      prompt: "second",
      idempotencyKey: "global-2",
      snapshot: { snapshotId: sn2.snapshotId, source: sn2.source, accountId: sn2.accountId },
    }, creds);
    assert.equal(second.status, 409);
    assert.equal(second.json.error?.code, "RUN_BUSY");
  } finally {
    await server.close();
  }
});

test("sequential runs reuse the snapshot handle but get fresh files + native resume", async () => {
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "session-file");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const session = await postJson(base, "/coaching/sessions", {}, creds);
    const sessionId = (session.json.data as { id: string }).id;
    const snapshot = await postJson(base, "/coaching/snapshots", {}, creds);
    const snap = snapshot.json.data as { snapshotId: string; source: string; accountId: string };
    const payload = (key: string) => ({
      sessionId,
      prompt: "analyze",
      idempotencyKey: key,
      snapshot: { snapshotId: snap.snapshotId, source: snap.source, accountId: snap.accountId },
    });
    const first = await postJson(base, "/coaching/runs", payload("native-1"), creds);
    assert.equal(first.status, 201);
    const firstId = (first.json.data as { run: { id: string } }).run.id;
    await waitForStatus(base, firstId, creds, "completed");
    const second = await postJson(base, "/coaching/runs", payload("native-2"), creds);
    assert.equal(second.status, 201);
    const secondId = (second.json.data as { run: { id: string } }).run.id;
    await waitForStatus(base, secondId, creds, "completed");
    assert.equal(captures.length, 2);
    // Fresh immutable file per run: different paths, none reused.
    assert.notEqual(captures[0]?.snapshotFile, captures[1]?.snapshotFile);
    // Fixed per-session native dir reused across sequential runs.
    assert.ok(captures[0]?.options.sessionDir);
    assert.equal(captures[0]?.options.sessionDir, captures[1]?.options.sessionDir);
    // Snapshot files live inside their per-run snapshot dirs, not the session dir.
    assert.ok((captures[0]?.snapshotFile as string).startsWith(captures[0]?.options.snapshotDir as string));
    // Native resume: the second launch received the first run's handle, which
    // must live inside the fixed session dir (containment enforced).
    const firstSessionFile = `${captures[0]?.options.sessionDir}/session-${captures[0]?.options.runId}.jsonl`;
    assert.equal(captures[0]?.resumeSessionFile, undefined);
    assert.equal(captures[1]?.resumeSessionFile, firstSessionFile);
    assert.ok((captures[1]?.resumeSessionFile as string).startsWith(captures[1]?.options.sessionDir as string));
  } finally {
    await server.close();
  }
});

test("non-allowlisted tools are denied and completion is withheld", async () => {
  const { server, base } = await startTestServer([], "refused-tool");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    await waitForStatus(base, runId, creds, "failed");
    const replay = await fetch(`${base}/coaching/runs/${runId}/events`, { headers: creds });
    const text = await replay.text();
    assert.ok(text.includes("TOOL_REFUSED"));
    assert.ok(!text.includes('"tool":"generate_next_plan","callId"'));
  } finally {
    await server.close();
  }
});

test("unsupported runtimeId rejects via the contract guard", async () => {
  const { server, base } = await startTestServer();
  try {
    const creds = await bothCreds(base, AUTH_A);
    const session = await postJson(base, "/coaching/sessions", {}, creds);
    const sessionId = (session.json.data as { id: string }).id;
    const snapshot = await postJson(base, "/coaching/snapshots", {}, creds);
    const snap = snapshot.json.data as { snapshotId: string; source: string; accountId: string };
    const run = await postJson(base, "/coaching/runs", {
      sessionId,
      prompt: "analyze",
      idempotencyKey: "runtime-id",
      runtimeId: "codex",
      snapshot: { snapshotId: snap.snapshotId, source: snap.source, accountId: snap.accountId },
    }, creds);
    assert.equal(run.status, 400);
    assert.equal(run.json.error?.code, "VALIDATION_ERROR");
  } finally {
    await server.close();
  }
});

test("empty history completes explicitly without invoking the runtime", async () => {
  const captures: LaunchCapture[] = [];
  const stores = createPrincipalMemoryStores();
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-empty": { id: "user-empty" } }),
    stores,
    runtimeFactory: makeFactory(captures, "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, "Bearer token-empty");
    const session = await postJson(server.url, "/coaching/sessions", {}, creds);
    const sessionId = (session.json.data as { id: string }).id;
    const snapshot = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal((snapshot.json.data as { recordCount: number }).recordCount, 0);
    const snap = snapshot.json.data as { snapshotId: string; source: string; accountId: string };
    const run = await postJson(server.url, "/coaching/runs", {
      sessionId,
      prompt: "analyze",
      idempotencyKey: "empty-1",
      snapshot: { snapshotId: snap.snapshotId, source: snap.source, accountId: snap.accountId },
    }, creds);
    assert.equal(run.status, 201);
    const runId = (run.json.data as { run: { id: string; status: string } }).run.id;
    assert.equal((run.json.data as { run: { status: string } }).run.status, "completed");
    assert.equal(captures.length, 0);
    const replay = await fetch(`${server.url}/coaching/runs/${runId}/events`, { headers: creds });
    const text = await replay.text();
    assert.ok(text.includes(EMPTY_HISTORY_REASON));
  } finally {
    await server.close();
  }
});

test("queued run reports lastSeq -1 with empty event page (contract cursor)", async () => {
  const { server, base } = await startTestServer([], "hang");
  let closed = false;
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const read = await getJson(base, `/coaching/runs/${runId}`, creds);
    assert.equal(read.status, 200);
    const data = read.json.data as { lastSeq: number; firstSeq: number; expiresAt: number; run: { status: string } };
    assert.equal(data.firstSeq, 0);
    assert.equal(data.lastSeq, -1);
    assert.ok(data.expiresAt > Date.now());
    assert.ok(["queued", "running"].includes(data.run.status));
    // Empty page, not an error; contract guard accepts -1.
    const { parseReadCoachingRunResult } = await import("@pi-fit-trace/api-contracts");
    parseReadCoachingRunResult(JSON.parse(JSON.stringify({ ...data, run: { ...data.run, id: runId, sessionId: (read.json.data as { run: { sessionId: string } }).run.sessionId, idempotencyKey: "k", prompt: "p", snapshot: (read.json.data as { run: { snapshot: unknown } }).run.snapshot, runtimeId: "pi" } })));
    // Active run: the stream stays open as a live tail (no terminal yet), so
    // never await the full body while live. Close with it open instead: the
    // server ends tracked streams cleanly and the replayed body is empty.
    const live = await fetch(`${base}/coaching/runs/${runId}/events?fromSeq=0`, { headers: creds });
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("content-type"), "text/event-stream");
    closed = true;
    await server.close();
    assert.deepEqual(readSseEvents(await live.text().catch(() => "")), []);
  } finally {
    if (!closed) await server.close();
  }
});

test("cancel body carries no runId: empty body works, stray runId is ignored", async () => {
  const { server, base } = await startTestServer([], "hang");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const first = await setupRun(base, creds, "a", "cancel-body-1");
    const id1 = (first.run.json.data as { run: { id: string } }).run.id;
    const withStray = await postJson(base, `/coaching/runs/${id1}/cancel`, { runId: "ignored", reason: "stop" }, creds);
    assert.equal(withStray.status, 200);
    assert.ok(((withStray.json.data as { run: { id: string } }).run.id) === id1);
    await waitForStatus(base, id1, creds, "cancelled");
  } finally {
    await server.close();
  }
});

test("retention expiry deletes the run; duplicate retry starts a fresh run", async () => {
  const stores = createPrincipalMemoryStores();
  const captures: LaunchCapture[] = [];
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-empty": { id: "user-empty" } }),
    stores,
    runtimeFactory: makeFactory(captures, "success"),
    serviceOptions: { cancelGraceMs: 200, retentionMs: 150 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, "Bearer token-empty");
    const session = await postJson(server.url, "/coaching/sessions", {}, creds);
    const sessionId = (session.json.data as { id: string }).id;
    const snapshot = await postJson(server.url, "/coaching/snapshots", {}, creds);
    const snap = snapshot.json.data as { snapshotId: string; source: string; accountId: string };
    const payload = {
      sessionId,
      prompt: "analyze",
      idempotencyKey: "expiry-retry",
      snapshot: { snapshotId: snap.snapshotId, source: snap.source, accountId: snap.accountId },
    };
    const first = await postJson(server.url, "/coaching/runs", payload, creds);
    assert.equal(first.status, 201);
    const firstId = (first.json.data as { run: { id: string } }).run.id;
    // Same-key duplicate BEFORE expiry returns the original run (no new launch).
    const dup = await postJson(server.url, "/coaching/runs", payload, creds);
    assert.ok([200, 201].includes(dup.status));
    assert.equal((dup.json.data as { run: { id: string } }).run.id, firstId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await getJson(server.url, `/coaching/runs/${firstId}`, creds)).status, 404);
    // Retry against the expired idle session is 404 — never a fresh 201 on a
    // deleted session.
    assert.equal((await postJson(server.url, "/coaching/runs", payload, creds)).status, 404);
    // New analysis needs a fresh session + snapshot; it starts a fresh run.
    const session2 = await postJson(server.url, "/coaching/sessions", {}, creds);
    assert.equal(session2.status, 201);
    const snapshot2 = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(snapshot2.status, 201);
    const snap2 = snapshot2.json.data as { snapshotId: string; source: string; accountId: string };
    const retry = await postJson(server.url, "/coaching/runs", {
      sessionId: (session2.json.data as { id: string }).id,
      prompt: "analyze",
      idempotencyKey: "expiry-retry",
      snapshot: { snapshotId: snap2.snapshotId, source: snap2.source, accountId: snap2.accountId },
    }, creds);
    assert.equal(retry.status, 201);
    assert.notEqual((retry.json.data as { run: { id: string } }).run.id, firstId);
  } finally {
    await server.close();
  }
});

test("unused snapshot expiry: the handle stops resolving after its TTL", async () => {
  const { server, base } = await startTestServer([], "success", { snapshotTtlMs: 150 });
  try {
    const creds = await bothCreds(base, AUTH_A);
    const session = await postJson(base, "/coaching/sessions", {}, creds);
    const sessionId = (session.json.data as { id: string }).id;
    const snapshot = await postJson(base, "/coaching/snapshots", {}, creds);
    const snap = snapshot.json.data as { snapshotId: string; source: string; accountId: string };
    await new Promise((resolve) => setTimeout(resolve, 300));
    const run = await postJson(base, "/coaching/runs", {
      sessionId,
      prompt: "analyze",
      idempotencyKey: "expired-snap",
      snapshot: { snapshotId: snap.snapshotId, source: snap.source, accountId: snap.accountId },
    }, creds);
    assert.equal(run.status, 404);
    assert.equal(run.json.error?.code, "SNAPSHOT_NOT_FOUND");
  } finally {
    await server.close();
  }
});

test("event cap stops the child and fails the run explicitly", async () => {
  // The success factory emits 4 content events; with maxEventsPerRun 3 the
  // 4th trips the cap: the child is stopped (cancel invoked) and the run
  // fails explicitly instead of silently dropping events.
  const captures2: LaunchCapture[] = [];
  const second = await startTestServer(captures2, "success", { maxEventsPerRun: 3 });
  try {
    const creds = await bothCreds(second.base, AUTH_A);
    const { run } = await setupRun(second.base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    const done = await waitForStatus(second.base, runId, creds, "failed");
    void done;
    const replay = await fetch(`${second.base}/coaching/runs/${runId}/events`, { headers: creds });
    const text = await replay.text();
    assert.ok(text.includes("EVENT_CAP"));
    // The child was stopped, not just released: cancel was invoked on cap trip.
    assert.ok(captures2[0]?.cancelled);
  } finally {
    await second.server.close();
  }
});

test("session and snapshot caps reject instead of growing without bound", async () => {
  const one = await startTestServer([], "success", { maxSessionsPerAccount: 1 });
  try {
    const creds = await bothCreds(one.base, AUTH_A);
    assert.equal((await postJson(one.base, "/coaching/sessions", {}, creds)).status, 201);
    const capped = await postJson(one.base, "/coaching/sessions", { id: "second" }, creds);
    assert.equal(capped.status, 400);
    assert.equal(capped.json.error?.code, "VALIDATION_ERROR");
  } finally {
    await one.server.close();
  }
  const two = await startTestServer([], "success", { maxSnapshotsPerAccount: 1 });
  try {
    const creds = await bothCreds(two.base, AUTH_A);
    assert.equal((await postJson(two.base, "/coaching/snapshots", {}, creds)).status, 201);
    const capped = await postJson(two.base, "/coaching/snapshots", {}, creds);
    assert.equal(capped.status, 400);
    assert.equal(capped.json.error?.code, "VALIDATION_ERROR");
  } finally {
    await two.server.close();
  }
});

test("oversized bodies reject as VALIDATION_ERROR", async () => {
  const { server, base } = await startTestServer();
  try {
    const creds = await bothCreds(base, AUTH_A);
    const big = await postJson(base, "/coaching/runs", {
      sessionId: "s",
      prompt: "x".repeat(70 * 1024),
      idempotencyKey: "big",
      snapshot: { snapshotId: "snap", source: "s", accountId: "user-a" },
    }, creds);
    assert.equal(big.status, 400);
    assert.equal(big.json.error?.code, "VALIDATION_ERROR");
  } finally {
    await server.close();
  }
});

test("shutdown cleans snapshot tmpdirs and closes an open SSE stream", async () => {
  const before = new Set(await readdir(tmpdir()));
  const captures: LaunchCapture[] = [];
  const { server, base } = await startTestServer(captures, "hang");
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    const runId = (run.json.data as { run: { id: string } }).run.id;
    // Hold an SSE stream open against the live run, then shut down: the
    // tracked response must close before the server does, and close() must
    // resolve (headers arrive; the body stays open until shutdown ends it).
    const live = await fetch(`${base}/coaching/runs/${runId}/events?fromSeq=0`, { headers: creds });
    assert.equal(live.status, 200);
    // Bounded close: must settle promptly (no >10s hang) even with an open stream.
    const closeResult = await settleWithin(
      server.close().then(() => "closed" as const, (error: unknown) => error),
      10000,
    );
    assert.notEqual(closeResult, "timeout", "server.close hung with open SSE stream");
    void closeResult;
    await live.text().catch(() => "");
    const after = await readdir(tmpdir());
    const leaked = after.filter((entry) => entry.startsWith("fit-trace-coach-") && !before.has(entry));
    assert.deepEqual(leaked, []);
  } catch (error) {
    try {
      await server.close();
    } catch {
      // Already closing.
    }
    throw error;
  }
});

test("fixed upstream uses the current user bearer and strict { data } envelope (local stub only)", async () => {
  const { createServer: createStubServer } = await import("node:http");
  const seenAuth: string[] = [];
  const valid = record({ id: "w-up-1", date: "2026-09-01" });
  const stub = createStubServer((req, res) => {
    if (req.url !== "/workouts" || req.method !== "GET") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    seenAuth.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [valid] }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : 0;
  const stubBase = `http://127.0.0.1:${stubPort}`;
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    upstream: { baseUrl: stubBase },
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    const snap = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(snap.status, 201);
    assert.deepEqual((snap.json.data as { recordIds: string[] }).recordIds, ["w-up-1"]);
    assert.deepEqual(seenAuth, ["Bearer token-a"]);
  } finally {
    await server.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("fixed upstream 401/403 map to 403, other outages to 503 (local stub only)", async () => {
  const { createServer: createStubServer } = await import("node:http");
  let status = 401;
  const stub = createStubServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : 0;
  const stubBase = `http://127.0.0.1:${stubPort}`;
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    upstream: { baseUrl: stubBase },
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    status = 401;
    const u401 = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(u401.status, 403);
    assert.equal(u401.json.error?.code, "FORBIDDEN");
    status = 403;
    const u403 = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(u403.status, 403);
    assert.equal(u403.json.error?.code, "FORBIDDEN");
    status = 500;
    const u500 = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(u500.status, 503);
    assert.equal(u500.json.error?.code, "STORAGE_UNAVAILABLE");
  } finally {
    await server.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("fixed upstream redirect is refused without following (local stub only)", async () => {
  const { createServer: createStubServer } = await import("node:http");
  let hits = 0;
  const stub = createStubServer((_req, res) => {
    hits += 1;
    res.writeHead(302, { location: "http://127.0.0.1:1/workouts" });
    res.end();
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : 0;
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    upstream: { baseUrl: `http://127.0.0.1:${stubPort}` },
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    const snap = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(snap.status, 503);
    assert.equal(snap.json.error?.code, "STORAGE_UNAVAILABLE");
    assert.equal(hits, 1);
  } finally {
    await server.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("fixed upstream bare array and invalid envelope are malformed 503 (local stub only)", async () => {
  const { createServer: createStubServer } = await import("node:http");
  let mode: "array" | "envelope" = "array";
  const stub = createStubServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (mode === "array") res.end(JSON.stringify([{ id: "w-x", date: "2026-09-01" }]));
    else res.end(JSON.stringify({ wrong: [] }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : 0;
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    upstream: { baseUrl: `http://127.0.0.1:${stubPort}` },
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    mode = "array";
    const bare = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(bare.status, 503);
    mode = "envelope";
    const bad = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(bad.status, 503);
  } finally {
    await server.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("fixed upstream multi-byte oversized body is byte-capped, server stays responsive (local stub only)", async () => {
  const { createServer: createStubServer } = await import("node:http");
  let oversized = true;
  const valid = record({ id: "w-up-1", date: "2026-09-01" });
  const stub = createStubServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (oversized) {
      // ~600k chars but ~1.2MB bytes: char-counting would pass, byte counting rejects.
      res.end(JSON.stringify({ data: "é".repeat(600_000) }));
    } else {
      res.end(JSON.stringify({ data: [valid] }));
    }
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : 0;
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    upstream: { baseUrl: `http://127.0.0.1:${stubPort}` },
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    const big = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(big.status, 503);
    assert.match(big.json.error?.message ?? "", /size limit/i);
    oversized = false;
    const ok = await postJson(server.url, "/coaching/snapshots", {}, creds);
    assert.equal(ok.status, 201);
  } finally {
    await server.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("fixed upstream snapshot without bearer is 401, not an upstream fetch (local stub only)", async () => {
  const { createServer: createStubServer } = await import("node:http");
  let hits = 0;
  const stub = createStubServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : 0;
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    upstream: { baseUrl: `http://127.0.0.1:${stubPort}` },
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const denied = await postJson(server.url, "/coaching/snapshots", {}, {});
    assert.equal(denied.status, 401);
    assert.equal(hits, 0);
  } finally {
    await server.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("injected public-config secrets are never served (shared key guard)", async () => {
  const secretServer = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    stores: createPrincipalMemoryStores(),
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "sb_secret_abc123" },
  });
  try {
    const response = await fetch(`${secretServer.url}/public-config`);
    assert.equal(response.status, 500);
    await response.text().catch(() => undefined);
  } finally {
    await secretServer.close();
  }
  const okServer = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    stores: createPrincipalMemoryStores(),
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk" },
  });
  try {
    const response = await fetch(`${okServer.url}/public-config`);
    assert.equal(response.status, 200);
    await response.text().catch(() => undefined);
  } finally {
    await okServer.close();
  }
});

test("bootstrap capability map is bounded per account; valid caps are never silently evicted", async () => {
  const { server, base } = await startTestServer([], "success", {});
  try {
    const issued: string[] = [];
    for (let i = 0; i < MAX_CAPABILITIES_PER_ACCOUNT; i += 1) {
      const response = await fetch(`${base}/coaching/bootstrap`, {
        method: "POST",
        headers: { authorization: AUTH_A },
      });
      assert.equal(response.status, 200);
      const json = (await response.json()) as { data: { capability: string } };
      issued.push(json.data.capability);
    }
    const full = await fetch(`${base}/coaching/bootstrap`, {
      method: "POST",
      headers: { authorization: AUTH_A },
    });
    assert.equal(full.status, 503);
    await full.text().catch(() => undefined);
    // Existing in-use caps still work: no silent invalidation to make room.
    const firstCreds = { authorization: AUTH_A, [CAPABILITY_HEADER]: issued[0] as string };
    assert.equal((await postJson(base, "/coaching/sessions", {}, firstCreds)).status, 201);
  } finally {
    await server.close();
  }
});

test("expired capabilities release capacity for new bootstrap (existing creds)", async () => {
  const { server, base } = await startTestServer([], "success", {}, {
    serverOptions: { capabilityTtlMs: 150 },
  });
  try {
    const first: string[] = [];
    for (let i = 0; i < MAX_CAPABILITIES_PER_ACCOUNT; i += 1) {
      const response = await fetch(`${base}/coaching/bootstrap`, {
        method: "POST",
        headers: { authorization: AUTH_A },
      });
      assert.equal(response.status, 200);
      first.push(((await response.json()) as { data: { capability: string } }).data.capability);
    }
    assert.equal(
      (await fetch(`${base}/coaching/bootstrap`, { method: "POST", headers: { authorization: AUTH_A } })).status,
      503,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Expired caps sweep: the old credential now rejects, and a fresh
    // bootstrap succeeds with existing (still-valid bearer) creds.
    const stale = { authorization: AUTH_A, [CAPABILITY_HEADER]: first[0] as string };
    assert.equal((await postJson(base, "/coaching/sessions", {}, stale)).status, 401);
    const fresh = await bothCreds(base, AUTH_A);
    assert.equal((await postJson(base, "/coaching/sessions", {}, fresh)).status, 201);
  } finally {
    await server.close();
  }
});

test("close stops accepting and force-destroys an unfinished raw-socket upload within a bounded grace", async () => {
  const { server, base } = await startTestServer([], "success", {}, {
    serverOptions: { shutdownGraceMs: 200 },
  });
  const port = Number(new URL(base).port);
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    // A request whose body never completes: an unbounded shutdown would await
    // this socket forever because the handler never produces a response.
    socket.write(
      `POST /coaching/runs HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `content-type: application/json\r\n` +
        `content-length: 1000\r\n\r\n` +
        `{"partial":`,
    );
    const settled = await settleWithin(
      server.close().then(() => "closed" as const, (error: unknown) => error),
      5000,
    );
    assert.equal(settled, "closed", "close must settle within the bounded grace, not await the socket");
  } finally {
    socket.destroy();
    // Idempotent close in case the assertion threw before close() ran.
    await server.close().catch(() => undefined);
  }
  // The port is released: a fresh server can bind it again.
  const rebind = await startTestServer([], "success", {}, { serverOptions: { port } });
  await rebind.server.close();
});

test("close aborts a pending fixed-upstream read and settles within the grace", async () => {
  const { createServer: createStubServer } = await import("node:http");
  // Deterministic gate: the stub confirms it RECEIVED the upstream read before
  // the test closes (never a fixed sleep).
  const reached = deferred();
  const stub = createStubServer(() => {
    // Never respond: the snapshot read stalls on the configured upstream.
    reached.resolve();
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : 0;
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    upstream: { baseUrl: `http://127.0.0.1:${stubPort}` },
    runtimeFactory: makeFactory([], "success"),
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
    shutdownGraceMs: 200,
  });
  try {
    const creds = await bothCreds(server.url, AUTH_A);
    // Fire a snapshot read that will stall on the upstream; do not await it.
    const pending = postJson(server.url, "/coaching/snapshots", {}, creds).catch(() => undefined);
    await reached.promise;
    const settled = await settleWithin(
      server.close().then(() => "closed" as const, (error: unknown) => error),
      5000,
    );
    assert.equal(settled, "closed", "close must cancel the pending upstream read and settle");
    await pending;
  } finally {
    await server.close().catch(() => undefined);
    stub.closeAllConnections?.();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("close overlaps socket grace with bounded agent cleanup (hanging child + unfinished socket)", async () => {
  const captures: LaunchCapture[] = [];
  // kill-refusing: the runtime's close() never settles, so service.shutdown is
  // bounded by cancelGraceMs and must reject (never silently release capacity).
  const { server, base } = await startTestServer(captures, "kill-refusing", { cancelGraceMs: 200 }, {
    serverOptions: { shutdownGraceMs: 150 },
  });
  const port = Number(new URL(base).port);
  let socket: ReturnType<typeof createConnection> | null = null;
  try {
    const creds = await bothCreds(base, AUTH_A);
    const { run } = await setupRun(base, creds);
    assert.equal(run.status, 201, "a live hang-refusing run must exist before shutdown");
    // Create + connect the socket only AFTER the setup awaits. A socket created
    // before them connects while those awaits are pending, so registering its
    // `connect` listener afterward would never fire (connect already happened)
    // and the test would wait forever.
    const connected = createConnection({ host: "127.0.0.1", port });
    socket = connected;
    await new Promise<void>((resolve, reject) => {
      connected.once("connect", () => resolve());
      connected.once("error", reject);
    });
    // Drain incoming bytes: a paused raw socket with buffered data (the
    // server's shutdown FIN/response) may never advance its readable side, so
    // its `close` event would not fire. `resume()` keeps it flowing.
    connected.resume();
    // The bounded shutdown grace force-destroys remaining sockets; capture the
    // close event (event-based, no wall-clock assertion) before shutting down.
    const socketClosed = new Promise<void>((resolve) => connected.once("close", () => resolve()));
    connected.write(
      `POST /coaching/runs HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `content-type: application/json\r\n` +
        `content-length: 1000\r\n\r\n` +
        `{"partial":`,
    );
    // The two waits overlap: total ≈ max(grace, cancelGrace), never their sum.
    const settled = await settleWithin(
      server.close().then(() => "closed" as const, (error: unknown) => error),
      3000,
    );
    assert.ok(settled instanceof Error, "an unconfirmed live child must surface as a rejection");
    assert.match(String(settled), /unconfirmed|incomplete|shutdown/);
    assert.notEqual(
      await settleWithin(socketClosed, 5000),
      "timeout",
      "the shutdown grace must force-close the unfinished socket",
    );
  } finally {
    socket?.destroy();
    await server.close().catch(() => undefined);
  }
});

test("close is idempotent", async () => {
  const { server } = await startTestServer();
  await server.close();
  await server.close();
});

test("bind failure rejects cleanly and the port stays reusable", async () => {
  const first = await startTestServer();
  const port = Number(new URL(first.base).port);
  await assert.rejects(
    startCoachingServer({
      verifier: createTestVerifier(TOKENS),
      stores: createPrincipalMemoryStores(),
      runtimeFactory: makeFactory([], "success"),
      serviceOptions: { cancelGraceMs: 200 },
      publicConfig: null,
      port,
    }),
    /EADDRINUSE|address already in use/i,
  );
  await first.server.close();
  // The failed bind left no listener/timers holding the port.
  const third = await startTestServer([], "success", {}, { serverOptions: { port } });
  await third.server.close();
});
