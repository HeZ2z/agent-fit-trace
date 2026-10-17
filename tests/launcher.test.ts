import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";

import { analyzeProgress, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { parseAnalysisResult, parseWorkoutList } from "@pi-fit-trace/api-contracts";
import type { CoachingEventPayload } from "@pi-fit-trace/api-contracts";
import {
  checkNodeRuntime,
  isSafeOpenUrl,
  normalizeUpstreamBaseUrl,
  resolveLauncherConfig,
} from "../packages/fit-trace-cli/src/config.ts";
import { RUNTIME_SCRIPT_BODY, startLauncherServer } from "../packages/fit-trace-cli/src/launcherServer.ts";
import type { LauncherServer } from "../packages/fit-trace-cli/src/launcherServer.ts";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import { CAPABILITY_HEADER } from "../server/coaching/coachingServer.ts";
import type { RuntimeFactory, RuntimeLaunchOptions } from "../server/coaching/coachingService.ts";

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | null;
  body: string;
}

interface FakeUpstream {
  baseUrl: string;
  recorded: RecordedRequest[];
  close(): Promise<void>;
  setResponder(
    responder: (recorded: RecordedRequest) => { status: number; body: string } | null,
  ): void;
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const recorded: RecordedRequest[] = [];
  let responder: (recorded: RecordedRequest) => { status: number; body: string } | null = () => null;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const entry: RecordedRequest = {
        method: (request.method ?? "GET").toUpperCase(),
        path: request.url ?? "/",
        auth: typeof request.headers.authorization === "string" ? request.headers.authorization : null,
        body,
      };
      recorded.push(entry);
      const answer = responder(entry);
      if (answer === null) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "API_ERROR", message: "No fake route." } }));
        return;
      }
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    recorded,
    setResponder(next) {
      responder = next;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      }),
  };
}

async function makeFixtureDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-dist-"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(
    join(dir, "index.html"),
    [
      "<!doctype html>",
      "<html><head><meta charset=\"utf-8\"></head>",
      "<body><div id=\"root\"></div>",
      "<script src=\"/assets/app.js\"></script>",
      "</body></html>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(dir, "assets", "app.js"), "console.log(\"fixture\");\n", "utf8");
  return dir;
}

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

let distDir = "";
let upstream: FakeUpstream | null = null;
let launcher: LauncherServer | null = null;

before(async () => {
  distDir = await makeFixtureDist();
  upstream = await startFakeUpstream();
});

after(async () => {
  await launcher?.close().catch(() => undefined);
  launcher = null;
  await upstream?.close().catch(() => undefined);
  upstream = null;
  if (distDir !== "") await rm(distDir, { recursive: true, force: true });
});

async function bootLauncher(): Promise<LauncherServer> {
  assert.ok(upstream !== null);
  if (launcher !== null) await launcher.close().catch(() => undefined);
  launcher = null;
  upstream.setResponder(() => null);
  upstream.recorded.length = 0;
  try {
    launcher = await startLauncherServer({
      distDir,
      upstreamBaseUrl: upstream.baseUrl,
      host: "127.0.0.1",
      port: 0,
    });
    // Boot resolves the default coaching public config with one upstream
    // read; that is boot traffic, not test traffic — clear it so assertions
    // on the shared fake see only the requests the test itself makes.
    upstream.recorded.length = 0;
  } catch (error) {
    // Failed boots must not leave a stale handle behind.
    launcher = null;
    throw error;
  }
  // `port: 0` means "any available port" for these tests; the launcher still
  // binds loopback only and reports the real address.
  return launcher;
}

// --- config validation (no servers involved) ---

test("upstream config rejects credentials, queries, and non-http URLs", () => {
  assert.throws(() => normalizeUpstreamBaseUrl("https://user:pw@example.com/api/v1"), /credentials/);
  assert.throws(() => normalizeUpstreamBaseUrl("https://example.com/api/v1?x=1"), /query or fragment/);
  assert.throws(() => normalizeUpstreamBaseUrl("ftp://example.com/api"), /http\(s\)/);
  assert.equal(normalizeUpstreamBaseUrl("https://example.com/api/v1///"), "https://example.com/api/v1");
});

test("launcher config rejects invalid ports; node check requires >= 24", () => {
  const upstreamBase = "https://example.com/api/v1";
  assert.throws(() => resolveLauncherConfig({}, { port: 0, upstream: upstreamBase }, "/repo"), /invalid launcher port/);
  assert.throws(
    () => resolveLauncherConfig({ FIT_TRACE_API_BASE_URL: upstreamBase }, { port: 70000 }, "/repo"),
    /invalid launcher port/,
  );
  assert.throws(() => checkNodeRuntime("22.1.0"), /Node >= 24/);
  checkNodeRuntime("24.0.0");
});

test("missing dist fails with a clear build diagnostic", async () => {
  assert.ok(upstream !== null);
  await assert.rejects(
    startLauncherServer({ distDir: join(distDir, "does-not-exist"), upstreamBaseUrl: upstream.baseUrl }),
    /Static app build is missing.*pnpm --filter @pi-fit-trace\/app build/,
  );
});

// --- one-command boot: static, SPA fallback, runtime bootstrap ---

test("one-command boot serves the fixture app with runtime bootstrap injected", async () => {
  const booted = await bootLauncher();
  const root = await fetch(`${booted.url}/`);
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.match(html, /id="root"/);
  assert.match(html, new RegExp(`src="${"/fit-trace-runtime\\.js"}"`));

  const runtime = await fetch(`${booted.url}/fit-trace-runtime.js`);
  assert.equal(runtime.status, 200);
  assert.equal(await runtime.text(), RUNTIME_SCRIPT_BODY);

  const asset = await fetch(`${booted.url}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /fixture/);
});

test("SPA fallback serves the shell for app routes but never for API/assets", async () => {
  const booted = await bootLauncher();
  const shell = await (await fetch(`${booted.url}/`)).text();

  const analysis = await fetch(`${booted.url}/analysis`);
  assert.equal(analysis.status, 200);
  assert.equal(await analysis.text(), shell);

  const missingAsset = await fetch(`${booted.url}/assets/missing.js`);
  assert.equal(missingAsset.status, 404);

  assert.ok(upstream !== null);
  const before = upstream.recorded.length;
  const unknownApi = await fetch(`${booted.url}/api/v1/secret`);
  assert.equal(unknownApi.status, 404);
  assert.equal(upstream.recorded.length, before);
});

// --- bootstrap + data proxy against the fixed fake upstream ---

test("public-config proxy uses the upstream response and drops credentials", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  upstream.setResponder((entry) => {
    if (entry.path === "/api/v1/public-config") {
      return {
        status: 200,
        body: JSON.stringify({
          data: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk_test" },
        }),
      };
    }
    return null;
  });
  const response = await fetch(`${booted.url}/api/v1/public-config`, {
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk_test" },
  });
  assert.equal(upstream.recorded.length, 1);
  assert.equal(upstream.recorded[0]?.auth, null);
});

test("malformed upstream bootstrap surfaces a gateway failure, never the raw bytes as success", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  upstream.setResponder(() => ({ status: 200, body: "not-json{{{[" }));
  const response = await fetch(`${booted.url}/api/v1/public-config`);
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "API_ERROR");
});

test("workout reads forward the user bearer; parsers accept the proxied payload", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  const records = [seedRecord({ id: "w-01", date: "2026-09-01" })];
  upstream.setResponder((entry) => {
    if (entry.path === "/api/v1/workouts") return { status: 200, body: JSON.stringify({ data: records }) };
    return null;
  });
  const response = await fetch(`${booted.url}/api/v1/workouts`, {
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(response.status, 200);
  const parsed = parseWorkoutList(((await response.json()) as { data: unknown }).data);
  assert.deepEqual(parsed, records);
  assert.equal(upstream.recorded[0]?.auth, "Bearer user-token");
});

test("analysis proxy preserves the query and validates through the existing parser", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  const records = [seedRecord({ id: "w-01", date: "2026-09-01" })];
  const analysis = analyzeProgress(records, {});
  upstream.setResponder((entry) => {
    if (entry.path.startsWith("/api/v1/analysis")) {
      assert.match(entry.path, /from=2026-09-01/);
      return { status: 200, body: JSON.stringify({ data: analysis }) };
    }
    return null;
  });
  const response = await fetch(`${booted.url}/api/v1/analysis?from=2026-09-01`, {
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(parseAnalysisResult(((await response.json()) as { data: unknown }).data), analysis);
});

test("the browser cannot smuggle an upstream target through the query string", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  upstream.setResponder((entry) => {
    if (entry.path === "/api/v1/workouts") return { status: 200, body: JSON.stringify({ data: [] }) };
    return null;
  });
  const response = await fetch(`${booted.url}/api/v1/workouts?upstream=https://evil.example`, {
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.recorded[0]?.path, "/api/v1/workouts");
});

test("upstream auth rejections pass through; redirects refuse; outages are 503", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);

  upstream.setResponder(() => ({
    status: 401,
    body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "bad token" } }),
  }));
  const denied = await fetch(`${booted.url}/api/v1/workouts`, {
    headers: { authorization: "Bearer stale" },
  });
  assert.equal(denied.status, 401);

  // Redirects are refused without following, even to the same host.
  const redirector = createServer((_request, response) => {
    response.writeHead(302, { location: `${booted.url}/api/v1/workouts` });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    redirector.once("error", reject);
    redirector.listen(0, "127.0.0.1", () => {
      redirector.off("error", reject);
      resolve();
    });
  });
  const redirectPort = (redirector.address() as { port: number }).port;
  const viaRedirect = await startLauncherServer({
    distDir,
    upstreamBaseUrl: `http://127.0.0.1:${redirectPort}/api/v1`,
    host: "127.0.0.1",
    port: 0,
    // Data-proxy-only boot: skip the coaching public-config fetch.
    verifier: null,
    publicConfig: null,
  });
  try {
    const refused = await fetch(`${viaRedirect.url}/api/v1/workouts`);
    assert.equal(refused.status, 502);
  } finally {
    await viaRedirect.close();
    await new Promise<void>((resolveClose) => redirector.close(() => resolveClose()));
  }

  await upstream.close();
  const down = await fetch(`${booted.url}/api/v1/workouts`);
  assert.equal(down.status, 503);
  upstream = await startFakeUpstream();
});

test("proxy never logs headers or keys", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  upstream.setResponder((entry) => {
    if (entry.path === "/api/v1/workouts") return { status: 200, body: JSON.stringify({ data: [] }) };
    return null;
  });
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    await fetch(`${booted.url}/api/v1/workouts`, {
      headers: { authorization: "Bearer super-secret-token" },
    });
  } finally {
    console.log = originalLog;
  }
  assert.ok(!captured.join("\n").includes("super-secret-token"));
});

// --- one listener: static + data proxy + coaching ---

test("one listener serves tracking, data proxy, and coaching bootstrap/run/events", async () => {
  assert.ok(upstream !== null);
  const seen: RuntimeLaunchOptions[] = [];
  const runtimeFactory: RuntimeFactory = (options: RuntimeLaunchOptions) => ({
    start(): void {
      seen.push(options);
      setImmediate(() => {
        const emit = (payload: CoachingEventPayload): void => options.onEvent(payload);
        emit({ type: "text_delta", delta: "hello " });
        emit({ type: "tool_start", tool: "get_training_history", callId: "c1" });
        emit({ type: "tool_end", tool: "get_training_history", callId: "c1", ok: true });
        emit({ type: "analysis_result", result: analyzeProgress([]) });
        emit({ type: "text_delta", delta: "world" });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      });
    },
    cancel(): void {
      setImmediate(() => options.onDone("cancelled", "cancel requested", { processExitConfirmed: true }));
    },
    async close(): Promise<void> {},
  });
  const records = [seedRecord({ id: "w-coach-01", date: "2026-09-01" })];
  upstream.setResponder((entry) => {
    if (entry.path === "/api/v1/workouts") {
      return { status: 200, body: JSON.stringify({ data: records }) };
    }
    if (entry.path === "/api/v1/public-config") {
      return {
        status: 200,
        body: JSON.stringify({
          data: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk_test" },
        }),
      };
    }
    return null;
  });
  const sameOrigin = await startLauncherServer({
    distDir,
    upstreamBaseUrl: upstream.baseUrl,
    host: "127.0.0.1",
    port: 0,
    verifier: createTestVerifier({ "token-coach": { id: "user-coach" } }),
    publicConfig: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk_test" },
    runtimeFactory,
  });
  try {
    // Tracking shell + runtime bootstrap advertise same-origin coaching.
    const shell = await fetch(`${sameOrigin.url}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /fit-trace-runtime\.js/);
    const runtime = await fetch(`${sameOrigin.url}/fit-trace-runtime.js`);
    assert.equal(runtime.status, 200);
    assert.match(await runtime.text(), /coaching: "same-origin"/);

    // Data proxy on the same origin forwards the user bearer.
    const proxied = await fetch(`${sameOrigin.url}/api/v1/workouts`, {
      headers: { authorization: "Bearer token-coach" },
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(parseWorkoutList(((await proxied.json()) as { data: unknown }).data), records);

    // Coaching handshake on the same origin.
    const bootstrap = await fetch(`${sameOrigin.url}/coaching/bootstrap`, {
      method: "POST",
      headers: { authorization: "Bearer token-coach" },
    });
    assert.equal(bootstrap.status, 200);
    const capability = ((await bootstrap.json()) as { data: { capability: string } }).data.capability;
    const creds = { authorization: "Bearer token-coach", [CAPABILITY_HEADER]: capability };
    const jsonHeaders = { ...creds, "content-type": "application/json" };

    const session = await fetch(`${sameOrigin.url}/coaching/sessions`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    assert.equal(session.status, 201);
    const sessionId = ((await session.json()) as { data: { id: string } }).data.id;

    const snapshot = await fetch(`${sameOrigin.url}/coaching/snapshots`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    assert.equal(snapshot.status, 201);
    const snap = (
      await snapshot.json()
    ) as { data: { snapshotId: string; source: string; accountId: string; recordCount: number } };
    assert.equal(snap.data.recordCount, 1);

    const run = await fetch(`${sameOrigin.url}/coaching/runs`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        sessionId,
        prompt: "analyze my training",
        idempotencyKey: "same-origin-1",
        snapshot: {
          snapshotId: snap.data.snapshotId,
          source: snap.data.source,
          accountId: snap.data.accountId,
        },
      }),
    });
    assert.equal(run.status, 201);
    const runId = ((await run.json()) as { data: { run: { id: string } } }).data.run.id;

    const start = Date.now();
    for (;;) {
      const read = await fetch(`${sameOrigin.url}/coaching/runs/${runId}`, { headers: creds });
      assert.equal(read.status, 200);
      const status = ((await read.json()) as { data: { run: { status: string } } }).data.run.status;
      if (status === "completed") break;
      assert.ok(Date.now() - start < 8000, `timed out waiting for completed, still ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(seen.length, 1);

    const events = await fetch(`${sameOrigin.url}/coaching/runs/${runId}/events`, { headers: creds });
    assert.equal(events.status, 200);
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    assert.match(await events.text(), /terminal/);

    // A foreign origin is rejected on the shared listener.
    const evil = await fetch(`${sameOrigin.url}/coaching/sessions`, {
      method: "POST",
      headers: { ...jsonHeaders, origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(evil.status, 403);
  } finally {
    await sameOrigin.close();
  }
  await assert.rejects(fetch(`${sameOrigin.url}/`), /fetch failed|ECONNREFUSED/);
});

// --- origin/host protection ---

test("API proxy enforces exact host and origin", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  upstream.setResponder((entry) => {
    if (entry.path === "/api/v1/public-config") {
      return {
        status: 200,
        body: JSON.stringify({
          data: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk_test" },
        }),
      };
    }
    return null;
  });
  const ok = await fetch(`${booted.url}/api/v1/public-config`);
  assert.equal(ok.status, 200);

  const badHost = await rawRequest(booted.port, "/api/v1/public-config", { host: "localhost.evil.com" });
  assert.equal(badHost, 403);

  const badOrigin = await fetch(`${booted.url}/api/v1/public-config`, {
    headers: { origin: "http://localhost.evil.com" },
  });
  assert.equal(badOrigin.status, 403);
});

// --- port fallback + shutdown ---

test("a busy preferred port falls forward instead of failing", async () => {
  assert.ok(upstream !== null);
  const squatter = createServer((_request, response) => {
    response.end("squat");
  });
  await new Promise<void>((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(0, "127.0.0.1", () => {
      squatter.off("error", reject);
      resolve();
    });
  });
  const busyPort = (squatter.address() as { port: number }).port;
  const moved = await startLauncherServer({
    distDir,
    upstreamBaseUrl: upstream.baseUrl,
    host: "127.0.0.1",
    port: busyPort,
  });
  try {
    assert.notEqual(moved.port, busyPort);
    assert.equal((await fetch(`${moved.url}/`)).status, 200);
  } finally {
    await moved.close();
    await new Promise<void>((resolveClose) => squatter.close(() => resolveClose()));
  }
});

test("shutdown settles an active proxied run and releases the port", async () => {
  const gate = createServer(() => {
    // Never respond: the launcher must still shut down cleanly.
  });
  await new Promise<void>((resolve, reject) => {
    gate.once("error", reject);
    gate.listen(0, "127.0.0.1", () => {
      gate.off("error", reject);
      resolve();
    });
  });
  const gatePort = (gate.address() as { port: number }).port;
  const running = await startLauncherServer({
    distDir,
    upstreamBaseUrl: `http://127.0.0.1:${gatePort}/api/v1`,
    host: "127.0.0.1",
    port: 0,
    // Data-proxy-only boot: the gate never responds, so skip the coaching
    // public-config fetch instead of paying its timeout.
    verifier: null,
    publicConfig: null,
  });
  const pending = fetch(`${running.url}/api/v1/workouts`).catch(() => null);
  await running.close();
  await pending;
  await assert.rejects(fetch(`${running.url}/`), /fetch failed|ECONNREFUSED/);
  await new Promise<void>((resolveClose) => gate.close(() => resolveClose()));
});

test("launcher refuses a non-loopback bind host", async () => {
  assert.ok(upstream !== null);
  await assert.rejects(
    startLauncherServer({ distDir, upstreamBaseUrl: upstream.baseUrl, host: "0.0.0.0", port: 0 }),
    /127\.0\.0\.1 only/,
  );
});

// --- batch4 regressions: static escape, config guards, proxy caps ---

test("a symlink inside dist pointing outside is never served", async () => {
  const booted = await bootLauncher();
  const outside = await mkdtemp(join(tmpdir(), "fit-trace-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "outside-secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(distDir, "linked-secret.txt")).catch(() => undefined);
    const response = await fetch(`${booted.url}/linked-secret.txt`);
    const body = await response.text();
    assert.ok(!body.includes("outside-secret"), "symlink escape must not serve outside bytes");
  } finally {
    await rm(join(distDir, "linked-secret.txt"), { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("an injected service-role key is rejected, never used for the verifier", async () => {
  assert.ok(upstream !== null);
  const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  const serviceRoleJwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
  // No explicit verifier: the default must NOT be built from the rejected
  // key — coaching stays unauthenticated instead.
  const rejected = await startLauncherServer({
    distDir,
    upstreamBaseUrl: upstream.baseUrl,
    host: "127.0.0.1",
    port: 0,
    publicConfig: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: serviceRoleJwt },
  });
  try {
    const bootstrap = await fetch(`${rejected.url}/coaching/bootstrap`, { method: "POST" });
    assert.equal(bootstrap.status, 400);
    const body = (await bootstrap.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "API_ERROR");
    assert.match(body.error.message, /not configured/);
  } finally {
    await rejected.close();
  }
});

test("unknown API routes with a bearer never touch the upstream", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  upstream.setResponder(() => ({ status: 200, body: JSON.stringify({ data: [] }) }));
  upstream.recorded.length = 0;
  const response = await fetch(`${booted.url}/api/v1/secret`, {
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(response.status, 404);
  assert.equal(upstream.recorded.length, 0);
});

test("oversize upstream bodies are capped by streamed bytes, not chars", async () => {
  const booted = await bootLauncher();
  assert.ok(upstream !== null);
  // 600k chars but 1.2M UTF-8 bytes: a char-length check would pass, the
  // byte cap must refuse.
  upstream.setResponder(() => ({ status: 200, body: "é".repeat(600_000) }));
  const response = await fetch(`${booted.url}/api/v1/workouts`, {
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /size limit/);
  upstream.setResponder(() => null);
});

test("an empty FIT_TRACE_APP_DIST is treated as unset (repo default)", () => {
  const resolved = resolveLauncherConfig(
    { FIT_TRACE_API_BASE_URL: "https://example.com/api/v1", FIT_TRACE_APP_DIST: "" },
    {},
    "/repo",
  );
  assert.equal(resolved.distDir, "/repo/app/dist");
  const flagged = resolveLauncherConfig({ FIT_TRACE_API_BASE_URL: "https://example.com/api/v1" }, { dist: "" }, "/repo");
  assert.equal(flagged.distDir, "/repo/app/dist");
});

test("browser open is loopback-only", () => {
  assert.equal(isSafeOpenUrl("http://127.0.0.1:5198/"), true);
  assert.equal(isSafeOpenUrl("http://localhost:5198/"), true);
  assert.equal(isSafeOpenUrl("https://127.0.0.1:5198/"), false);
  assert.equal(isSafeOpenUrl("http://localhost.evil.com/"), false);
  assert.equal(isSafeOpenUrl("http://127.0.0.1:5198.evil.com/"), false);
  assert.equal(isSafeOpenUrl("http://user:pw@127.0.0.1:5198/"), false);
  assert.equal(isSafeOpenUrl("not-a-url"), false);
});

test("CLI flags with missing values fail fast", async () => {
  const run = (args: string[]): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["packages/fit-trace-cli/src/cli.ts", ...args], {
        timeout: 30_000,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
  for (const flag of ["--port", "--upstream", "--dist"]) {
    const result = await run(["start", flag]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`missing value for ${flag.replace("-", "\\-")}`));
  }
});

test("a busy preferred port falls forward with a live coaching factory", async () => {
  assert.ok(upstream !== null);
  const squatter = createServer((_request, response) => {
    response.end("squat");
  });
  await new Promise<void>((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(0, "127.0.0.1", () => {
      squatter.off("error", reject);
      resolve();
    });
  });
  const busyPort = (squatter.address() as { port: number }).port;
  const moved = await startLauncherServer({
    distDir,
    upstreamBaseUrl: upstream.baseUrl,
    host: "127.0.0.1",
    port: busyPort,
    verifier: createTestVerifier({
      "token-busy": { id: "user-busy" },
    }),
    publicConfig: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk_test" },
    runtimeFactory: () => ({
      start(): void {
        // Never invoked for the bootstrap-only assertions below; the
        // factory existing proves wiring survived the port scan.
      },
      cancel(): void {},
      async close(): Promise<void> {},
    }),
  });
  try {
    assert.notEqual(moved.port, busyPort);
    assert.equal((await fetch(`${moved.url}/`)).status, 200);
    const bootstrap = await fetch(`${moved.url}/coaching/bootstrap`, {
      method: "POST",
      headers: { authorization: "Bearer token-busy" },
    });
    assert.equal(bootstrap.status, 200);
  } finally {
    await moved.close();
    await new Promise<void>((resolveClose) => squatter.close(() => resolveClose()));
  }
});

test("pi-unavailable launches fail coaching runs clearly, not as spawn errors", async () => {
  assert.ok(upstream !== null);
  const server = await startLauncherServer({
    distDir,
    upstreamBaseUrl: upstream.baseUrl,
    host: "127.0.0.1",
    port: 0,
    verifier: createTestVerifier({
      "token-nopi": { id: "user-nopi" },
    }),
    publicConfig: { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pk_test" },
    // No injected runtime factory: piAvailable false selects the fail-clear
    // factory instead of spawning.
    piAvailable: false,
  });
  try {
    const bootstrap = await fetch(`${server.url}/coaching/bootstrap`, {
      method: "POST",
      headers: { authorization: "Bearer token-nopi" },
    });
    assert.equal(bootstrap.status, 200);
    const capability = ((await bootstrap.json()) as { data: { capability: string } }).data.capability;
    const creds = { authorization: "Bearer token-nopi", [CAPABILITY_HEADER]: capability };
    const session = await fetch(`${server.url}/coaching/sessions`, {
      method: "POST",
      headers: { ...creds, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 201);
    const sessionId = ((await session.json()) as { data: { id: string } }).data.id;
    upstream.setResponder((entry) => {
      if (entry.path === "/api/v1/workouts") {
        return {
          status: 200,
          body: JSON.stringify({
            data: [seedRecord({ id: "w-nopi-01", date: "2026-09-01" })],
          }),
        };
      }
      return null;
    });
    const snapshot2 = await fetch(`${server.url}/coaching/snapshots`, {
      method: "POST",
      headers: { ...creds, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(snapshot2.status, 201);
    const snap = (
      await snapshot2.json()
    ) as { data: { snapshotId: string; source: string; accountId: string } };
    const run = await fetch(`${server.url}/coaching/runs`, {
      method: "POST",
      headers: { ...creds, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        prompt: "analyze my training",
        idempotencyKey: "nopi-1",
        snapshot: {
          snapshotId: snap.data.snapshotId,
          source: snap.data.source,
          accountId: snap.data.accountId,
        },
      }),
    });
    assert.equal(run.status, 201);
    const runId = ((await run.json()) as { data: { run: { id: string } } }).data.run.id;
    const start = Date.now();
    let status = "";
    for (;;) {
      const read = await fetch(`${server.url}/coaching/runs/${runId}`, { headers: creds });
      assert.equal(read.status, 200);
      status = ((await read.json()) as { data: { run: { status: string } } }).data.run.status;
      if (status === "failed" || status === "completed") break;
      assert.ok(Date.now() - start < 8000, `timed out waiting for terminal, still ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status, "failed");
    const events = await fetch(`${server.url}/coaching/runs/${runId}/events`, { headers: creds });
    assert.match(await events.text(), /pi CLI is not available/);
    const runtime = await (await fetch(`${server.url}/fit-trace-runtime.js`)).text();
    assert.match(runtime, /piAvailable: false/);
  } finally {
    await server.close();
    upstream.setResponder(() => null);
  }
});
