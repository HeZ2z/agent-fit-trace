import { signedSyncToken, syncAuthFixture } from "./syncAuthFixture.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { parseCoachingCapabilityDiscovery } from "@agent-fit-trace/api-contracts";
import type { CoachingCapabilityDiscovery } from "@agent-fit-trace/api-contracts";
import {
  defaultBackendIdFor,
  piExtensionCandidates,
  resolvePiAvailability,
  startDaemonServer,
} from "../packages/fit-trace-cli/src/daemonServer.ts";
import type { DaemonServer, DaemonServerOptions } from "../packages/fit-trace-cli/src/daemonServer.ts";
import type { DetectedLocalCli } from "../server/coaching/localRuntimeRegistrations.ts";
import { LOCAL_DAEMON_BEARER } from "../server/auth/localVerifier.ts";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import { CAPABILITY_HEADER } from "../server/coaching/coachingServer.ts";

/**
 * In-process daemon tests over real HTTP sockets (no real pi, no Supabase).
 * Each boot gets its own tmp data dir, so the default coaching journal and
 * the SQLite stores never touch the repository; the CLI-level assertions
 * spawn `cli.ts` directly (parseArgs is not importable — cli.ts executes
 * main() at import).
 */

const GUEST_AUTH = `Bearer ${LOCAL_DAEMON_BEARER}`;

/** Environment with Supabase deliberately unconfigured: the pure guest plane. */
const NO_SUPABASE_ENV: Record<string, string | undefined> = {};

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

async function makeDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fit-trace-daemon-data-"));
}

async function makeShellDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-daemon-dist-"));
  await writeFile(
    join(dir, "index.html"),
    [
      "<!doctype html>",
      "<html><head><meta charset=\"utf-8\"></head>",
      "<body><div id=\"daemon-shell-root\"></div></body></html>",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

interface BootedDaemon {
  daemon: DaemonServer;
  dataDir: string;
}

async function bootDaemon(overrides: Partial<DaemonServerOptions> = {}): Promise<BootedDaemon> {
  const dataDir = await makeDataDir();
  const daemon = await startDaemonServer({
    port: 0,
    dataDir,
    distDir: null,
    env: NO_SUPABASE_ENV,
    ...overrides,
  });
  return { daemon, dataDir };
}

// --- local fake Supabase Auth (for the configured-login suite below) ---

/** Stable users the fake resolves, keyed by magic bearer token. */
const FAKE_AUTH_USERS: Record<string, { id: string; email: string; is_anonymous: boolean }> = {
  "good-alice-token": {
    id: "11111111-1111-4111-8111-111111111111",
    email: "alice@example.test",
    is_anonymous: false,
  },
  "good-bob-token": {
    id: "22222222-2222-4222-8222-222222222222",
    email: "bob@example.test",
    is_anonymous: false,
  },
};

interface FakeSupabaseAuth {
  url: string;
  close(): Promise<void>;
}

/**
 * Minimal fake Supabase Auth server: `GET /auth/v1/user` with `apikey` and
 * `Authorization: Bearer <token>` headers — the exact request shape
 * `supabaseVerifier.ts` issues. Magic tokens resolve to the user payload the
 * verifier parses (`id`, `email`, `is_anonymous`); anything else gets a 401,
 * which the verifier maps to `UNAUTHENTICATED`.
 */
function startFakeSupabaseAuth(): Promise<FakeSupabaseAuth> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
      const user = FAKE_AUTH_USERS[bearer];
      if (pathname !== "/auth/v1/user" || user === undefined) {
        response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "Invalid token" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(user));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake auth server did not bind a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.closeAllConnections();
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
          }),
      });
    });
  });
}

let shared: BootedDaemon | null = null;
let shellDist: string | null = null;
let fakeAuth: FakeSupabaseAuth | null = null;
let configured: BootedDaemon | null = null;
const tempDirs: string[] = [];

before(async () => {
  shared = await bootDaemon();
  tempDirs.push(shared.dataDir);
  shellDist = await makeShellDist();
  tempDirs.push(shellDist);
  fakeAuth = await startFakeSupabaseAuth();
  configured = await bootDaemon({
    env: {
      SUPABASE_URL: fakeAuth.url,
      // Publishable-key shaped: passes getPublicConfig's URL/key checks and
      // is rejected by neither the `sb_secret_` nor the service-role JWT rule.
      SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    },
  });
  tempDirs.push(configured.dataDir);
});

after(async () => {
  await configured?.daemon.close().catch(() => undefined);
  configured = null;
  await fakeAuth?.close().catch(() => undefined);
  fakeAuth = null;
  await shared?.daemon.close().catch(() => undefined);
  shared = null;
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- guest data plane (no Supabase, no shell) ---

test("public-config advertises the daemon plane and stays unconfigured without Supabase", async () => {
  const booted = shared;
  assert.ok(booted !== null);
  const response = await fetch(`${booted.daemon.url}/api/v1/public-config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: { daemon: true, auth_configured: false },
  });
});

test("without a dist the shell routes 404 while the data plane answers", async () => {
  const booted = shared;
  assert.ok(booted !== null);
  const shell = await fetch(`${booted.daemon.url}/`);
  assert.equal(shell.status, 404);
  const configured = await fetch(`${booted.daemon.url}/api/v1/public-config`);
  assert.equal(configured.status, 200);
});

test("the guest bearer creates and lists workouts backed by the guest db file", async () => {
  const booted = shared;
  assert.ok(booted !== null);
  const record = seedRecord({ id: "daemon-w-01", date: "2026-09-01" });
  const created = await fetch(`${booted.daemon.url}/api/v1/workouts`, {
    method: "POST",
    headers: { authorization: GUEST_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ record }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { data: { record: WorkoutRecord; duplicate: boolean } };
  assert.equal(createdBody.data.duplicate, false);
  assert.equal(createdBody.data.record.id, "daemon-w-01");

  const list = await fetch(`${booted.daemon.url}/api/v1/workouts`, {
    headers: { authorization: GUEST_AUTH },
  });
  assert.equal(list.status, 200);
  const listed = (await list.json()) as { data: WorkoutRecord[] };
  assert.ok(listed.data.some((entry) => entry.id === "daemon-w-01"));

  // The record is durable in the guest principal's own SQLite file.
  const dbStat = await stat(join(booted.dataDir, "guest.db"));
  assert.equal(dbStat.isFile(), true);
});

test("unknown bearers and missing credentials fail closed with UNAUTHENTICATED", async () => {
  const booted = shared;
  assert.ok(booted !== null);
  const wrong = await fetch(`${booted.daemon.url}/api/v1/workouts`, {
    headers: { authorization: "Bearer not-the-daemon-token" },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("www-authenticate"), "Bearer");
  const wrongBody = (await wrong.json()) as { error: { code: string } };
  assert.equal(wrongBody.error.code, "UNAUTHENTICATED");

  const anonymous = await fetch(`${booted.daemon.url}/api/v1/workouts`);
  assert.equal(anonymous.status, 401);
  const anonymousBody = (await anonymous.json()) as { error: { code: string } };
  assert.equal(anonymousBody.error.code, "UNAUTHENTICATED");
});

test("startup records the guest identity for followers", async () => {
  const booted = shared;
  assert.ok(booted !== null);
  const identity = JSON.parse(
    await readFile(join(booted.dataDir, "identity.json"), "utf8"),
  ) as { schema_version: number; active_principal: string };
  assert.equal(identity.schema_version, 1);
  assert.equal(identity.active_principal, "guest");
});

// --- configured Supabase login (local fake auth server) ---

test("public-config advertises the configured Supabase project", async () => {
  assert.ok(configured !== null);
  assert.ok(fakeAuth !== null);
  const response = await fetch(`${configured.daemon.url}/api/v1/public-config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      supabaseUrl: fakeAuth.url,
      supabasePublishableKey: "test-publishable-key",
      guestSignInEnabled: false,
      guestUpgradeEnabled: false,
      guestSignInCaptchaRequired: false,
      daemon: true,
      auth_configured: true,
    },
  });
});

test("the guest bearer still short-circuits to the guest db while Supabase is configured", async () => {
  assert.ok(configured !== null);
  const record = seedRecord({ id: "daemon-w-guest-configured", date: "2026-09-03" });
  const created = await fetch(`${configured.daemon.url}/api/v1/workouts`, {
    method: "POST",
    headers: { authorization: GUEST_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ record }),
  });
  assert.equal(created.status, 201);

  // The local bearer never reaches the Supabase delegation: the record is
  // durable in the guest principal's own SQLite file.
  const dbStat = await stat(join(configured.dataDir, "guest.db"));
  assert.equal(dbStat.isFile(), true);
});

test("magic tokens resolve distinct Supabase principals with isolated stores", async () => {
  assert.ok(configured !== null);
  const alice = FAKE_AUTH_USERS["good-alice-token"] as { id: string; email: string };
  const bob = FAKE_AUTH_USERS["good-bob-token"] as { id: string; email: string };

  // The SAME business id with different content lands in each principal's
  // own store: no cross-principal CONFLICT, no cross-principal visibility.
  const aliceCreated = await fetch(`${configured.daemon.url}/api/v1/workouts`, {
    method: "POST",
    headers: { authorization: "Bearer good-alice-token", "content-type": "application/json" },
    body: JSON.stringify({ record: seedRecord({ id: "daemon-w-shared", date: "2026-09-01" }) }),
  });
  assert.equal(aliceCreated.status, 201);
  const bobCreated = await fetch(`${configured.daemon.url}/api/v1/workouts`, {
    method: "POST",
    headers: { authorization: "Bearer good-bob-token", "content-type": "application/json" },
    body: JSON.stringify({ record: seedRecord({ id: "daemon-w-shared", date: "2026-09-02" }) }),
  });
  assert.equal(bobCreated.status, 201);

  const aliceList = await fetch(`${configured.daemon.url}/api/v1/workouts`, {
    headers: { authorization: "Bearer good-alice-token" },
  });
  assert.equal(aliceList.status, 200);
  const aliceData = (await aliceList.json()) as { data: WorkoutRecord[] };
  assert.deepEqual(
    aliceData.data.map((entry) => [entry.id, entry.date]),
    [["daemon-w-shared", "2026-09-01"]],
  );

  const bobList = await fetch(`${configured.daemon.url}/api/v1/workouts`, {
    headers: { authorization: "Bearer good-bob-token" },
  });
  assert.equal(bobList.status, 200);
  const bobData = (await bobList.json()) as { data: WorkoutRecord[] };
  assert.deepEqual(
    bobData.data.map((entry) => [entry.id, entry.date]),
    [["daemon-w-shared", "2026-09-02"]],
  );

  // Each verified principal maps to `<dataDir>/<sub>.db` (principalDbPath).
  const aliceDb = await stat(join(configured.dataDir, `${alice.id}.db`));
  const bobDb = await stat(join(configured.dataDir, `${bob.id}.db`));
  assert.equal(aliceDb.isFile(), true);
  assert.equal(bobDb.isFile(), true);
});

test("a bearer the configured Supabase project rejects fails closed with UNAUTHENTICATED", async () => {
  assert.ok(configured !== null);
  const response = await fetch(`${configured.daemon.url}/api/v1/workouts`, {
    headers: { authorization: "Bearer not-a-magic-token" },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

// --- optional app shell ---

test("a provided dist serves the shell with runtime bootstrap, SPA fallback, and no API/assets fallback", async () => {
  assert.ok(shellDist !== null);
  const { daemon } = await bootDaemon({ distDir: shellDist });
  try {
    const shell = await (await fetch(`${daemon.url}/`)).text();
    assert.match(shell, /daemon-shell-root/);
    assert.match(shell, /src="\/fit-trace-runtime\.js"/);

    // SPA fallback serves the shell for app routes…
    const fallback = await (await fetch(`${daemon.url}/coach/app-route`)).text();
    assert.equal(fallback, shell);

    // …but never for bundled assets or the API (the unknown API route hits
    // the data plane's auth boundary, not the shell).
    assert.equal((await fetch(`${daemon.url}/assets/missing.js`)).status, 404);
    const api = await fetch(`${daemon.url}/api/v1/secret`);
    assert.equal(api.status, 401);
    const apiBody = (await api.json()) as { error: { code: string } };
    assert.equal(apiBody.error.code, "UNAUTHENTICATED");
  } finally {
    await daemon.close();
  }
});

// --- lifecycle ---

test("close() releases the port and a second close is a no-op", async () => {
  const { daemon } = await bootDaemon();
  const url = daemon.url;
  assert.equal((await fetch(`${url}/api/v1/public-config`)).status, 200);
  await daemon.close();
  await assert.rejects(fetch(`${url}/api/v1/public-config`));
  await daemon.close();
});

// --- coaching capability surface (no real run, no pi) ---

test("coaching discovery reports pi unavailable and cloud closed for the guest", async () => {
  const { daemon } = await bootDaemon({ piAvailable: false });
  try {
    const bootstrap = await fetch(`${daemon.url}/coaching/bootstrap`, {
      method: "POST",
      headers: { authorization: GUEST_AUTH },
    });
    assert.equal(bootstrap.status, 200);
    const capability = ((await bootstrap.json()) as { data: { capability: string } }).data.capability;
    const creds = { authorization: GUEST_AUTH, [CAPABILITY_HEADER]: capability };

    const capabilitiesResponse = await fetch(`${daemon.url}/coaching/capabilities`, { headers: creds });
    assert.equal(capabilitiesResponse.status, 200);
    const discovery = parseCoachingCapabilityDiscovery(
      ((await capabilitiesResponse.json()) as { data: unknown }).data,
    );
    assert.equal(discovery.discoveryVersion, 1);
    const localPi = discovery.backends.find((entry) => entry.backendId === "local-pi");
    assert.equal(localPi?.available, false);
    assert.equal(localPi?.unavailableReason?.code, "cli-not-installed");
    const cloud = discovery.backends.find((entry) => entry.backendId === "cloud-default");
    assert.equal(cloud?.available, false);
  } finally {
    await daemon.close();
  }
});

// --- cloud coaching proxy surface ---

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/** A local hosted-cloud stand-in: public-config proves the issuer, everything else echoes. */
async function startFakeCloudApi(issuer: string): Promise<{
  apiBase: string;
  requests: { method: string; path: string; authorization?: string }[];
  close: () => Promise<void>;
}> {
  const requests: { method: string; path: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
    });
    if (url.pathname === "/api/v1/public-config") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { supabaseUrl: issuer, supabasePublishableKey: "pub" } }));
      return;
    }
    if (url.pathname === "/api/v1/coaching/cloud/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { enabled: true, from: "fake-cloud" } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });
  const port = await listen(server);
  return {
    apiBase: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () => closeServer(server),
  };
}

test("cloud is advertised whenever an account service is configured, and its destination state is explicit", async () => {
  const verifier = createTestVerifier({
    "token-formal": { id: "user-1", email: "formal@example.test", isAnonymous: false },
  });
  const official = await bootDaemon({
    env: {
      SUPABASE_URL: "https://project.example.test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      FIT_TRACE_CLOUD_API_BASE_URL: "https://cloud.example.test/api/v1",
    },
    verifier,
  });
  try {
    const script = await (await fetch(`${official.daemon.url}/fit-trace-runtime.js`)).text();
    assert.match(script, /cloud: true/);
    const status = await fetch(`${official.daemon.url}/api/v1/coaching/cloud/destination`, {
      headers: { authorization: "Bearer token-formal" },
    });
    assert.equal(status.status, 200);
    const body = (await status.json()) as { data: { source: string; destination: string; host: string; consent: string } };
    assert.equal(body.data.source, "official");
    assert.equal(body.data.destination, "https://cloud.example.test/api/v1");
    assert.equal(body.data.host, "cloud.example.test");
    assert.equal(body.data.consent, "not-applicable");
    const guest = await fetch(`${official.daemon.url}/api/v1/coaching/cloud/destination`, {
      headers: { authorization: GUEST_AUTH },
    });
    assert.equal(guest.status, 403);
    const missing = await fetch(`${official.daemon.url}/api/v1/coaching/cloud/capabilities`);
    assert.equal(missing.status, 401);
  } finally {
    await official.daemon.close();
  }

  // An account service without a destination still advertises the proxy
  // surface: the settings page can add a user destination at runtime.
  const unset = await bootDaemon({
    env: {
      SUPABASE_URL: "https://project.example.test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    },
    verifier,
  });
  try {
    const script = await (await fetch(`${unset.daemon.url}/fit-trace-runtime.js`)).text();
    assert.match(script, /cloud: true/);
    const status = await fetch(`${unset.daemon.url}/api/v1/coaching/cloud/destination`, {
      headers: { authorization: "Bearer token-formal" },
    });
    assert.equal(((await status.json()) as { data: { source: string } }).data.source, "unset");
    const capabilities = await fetch(`${unset.daemon.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer token-formal" },
    });
    assert.equal(capabilities.status, 503);
    assert.equal(
      ((await capabilities.json()) as { error: { code: string } }).error.code,
      "CLOUD_DESTINATION_UNCONFIGURED",
    );
  } finally {
    await unset.daemon.close();
  }

  const disabled = await bootDaemon();
  try {
    const script = await (await fetch(`${disabled.daemon.url}/fit-trace-runtime.js`)).text();
    assert.ok(!script.includes("cloud: true"));
    const response = await fetch(`${disabled.daemon.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: GUEST_AUTH },
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "CLOUD_DISABLED");
  } finally {
    await disabled.daemon.close();
  }
});

test("a user-entered destination is validated, consented per account, and proxied only after confirmation", async (t) => {
  const issuer = "https://project.example.test";
  const cloud = await startFakeCloudApi(issuer);
  t.after(() => cloud.close());
  const verifier = createTestVerifier({
    "token-a": { id: "user-a", email: "a@example.test", isAnonymous: false },
    "token-b": { id: "user-b", email: "b@example.test", isAnonymous: false },
  });
  const { daemon } = await bootDaemon({
    env: {
      SUPABASE_URL: issuer,
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    },
    verifier,
    allowInsecureCloudProxyLoopback: true,
  });
  try {
    const headers = { authorization: "Bearer token-a", "content-type": "application/json" };
    const preview = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ address: cloud.apiBase }),
    });
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as {
      data: { ok: boolean; destination: string; host: string; issuerCompatible: boolean };
    };
    assert.equal(previewBody.data.ok, true);
    assert.equal(previewBody.data.destination, cloud.apiBase);
    assert.equal(previewBody.data.issuerCompatible, true);
    const host = previewBody.data.host;

    const wrongHost = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ address: cloud.apiBase, confirmHost: "wrong.example.test" }),
    });
    assert.equal(wrongHost.status, 400);
    assert.equal(existsSync(join(daemon.dataDir, "cloud-destination.json")), false);

    const confirmed = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ address: cloud.apiBase, confirmHost: host }),
    });
    assert.equal(confirmed.status, 200);
    const confirmedBody = (await confirmed.json()) as {
      data: { source: string; consent: string; destination: string; binding: string };
    };
    assert.equal(confirmedBody.data.source, "user");
    assert.equal(confirmedBody.data.consent, "confirmed");
    assert.equal(confirmedBody.data.destination, cloud.apiBase);
    assert.match(confirmedBody.data.binding, /^[0-9a-f]{32}$/);
    assert.equal(existsSync(join(daemon.dataDir, "cloud-destination.json")), true);

    // Run-scoped requests are bound to the destination they started against.
    // A request without the binding is refused before upstream; the same
    // destination with the binding is forwarded.
    const beforeBinding = cloud.requests.length;
    const unbound = await fetch(`${daemon.url}/api/v1/coaching/cloud/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(unbound.status, 409);
    assert.equal(
      ((await unbound.json()) as { error: { code: string } }).error.code,
      "CLOUD_DESTINATION_CHANGED",
    );
    assert.equal(cloud.requests.length, beforeBinding);
    const bound = await fetch(`${daemon.url}/api/v1/coaching/cloud/sessions`, {
      method: "POST",
      headers: { ...headers, "x-fit-trace-cloud-destination": confirmedBody.data.binding },
      body: JSON.stringify({}),
    });
    assert.equal(bound.status, 404, "the bound request reaches the upstream fake");
    assert.equal(cloud.requests.length, beforeBinding + 1);

    // A different account sees the same device-local destination but must
    // confirm it for itself; its bearer is not forwarded before that.
    const otherStatus = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination`, {
      headers: { authorization: "Bearer token-b" },
    });
    assert.equal(((await otherStatus.json()) as { data: { consent: string } }).data.consent, "required");
    const before = cloud.requests.length;
    const refused = await fetch(`${daemon.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer token-b" },
    });
    assert.equal(refused.status, 403);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "CLOUD_DESTINATION_CONSENT_REQUIRED",
    );
    assert.equal(cloud.requests.length, before, "an unconfirmed account must not reach the upstream");

    const proxied = await fetch(`${daemon.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer token-a" },
    });
    assert.equal(proxied.status, 200);
    assert.equal(
      ((await proxied.json()) as { data: { from: string } }).data.from,
      "fake-cloud",
    );
    const forwarded = cloud.requests.find((request) => request.path === "/api/v1/coaching/cloud/capabilities");
    assert.equal(forwarded?.authorization, "Bearer token-a");

    const reset = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination`, {
      method: "DELETE",
      headers: { authorization: "Bearer token-a" },
    });
    assert.equal(reset.status, 200);
    assert.equal(((await reset.json()) as { data: { source: string } }).data.source, "unset");
    assert.equal(existsSync(join(daemon.dataDir, "cloud-destination.json")), false);
    const afterReset = await fetch(`${daemon.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer token-a" },
    });
    assert.equal(afterReset.status, 503);
    assert.equal(
      ((await afterReset.json()) as { error: { code: string } }).error.code,
      "CLOUD_DESTINATION_UNCONFIGURED",
    );
  } finally {
    await daemon.close();
  }
});

test("an incompatible destination issuer is refused before any consent is stored", async (t) => {
  const cloud = await startFakeCloudApi("https://other-project.example.test");
  t.after(() => cloud.close());
  const verifier = createTestVerifier({
    "token-a": { id: "user-a", email: "a@example.test", isAnonymous: false },
  });
  const { daemon } = await bootDaemon({
    env: {
      SUPABASE_URL: "https://project.example.test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    },
    verifier,
    allowInsecureCloudProxyLoopback: true,
  });
  try {
    const headers = { authorization: "Bearer token-a", "content-type": "application/json" };
    const preview = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ address: cloud.apiBase }),
    });
    assert.equal(preview.status, 200);
    const body = (await preview.json()) as {
      data: { ok: boolean; error: { code: string; message: string } };
    };
    assert.equal(body.data.ok, false);
    assert.equal(body.data.error.code, "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE");
    assert.match(body.data.error.message, /different account service/);
    const put = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ address: cloud.apiBase, confirmHost: new URL(cloud.apiBase).host }),
    });
    assert.equal(put.status, 400);
    assert.equal(
      ((await put.json()) as { error: { code: string } }).error.code,
      "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE",
    );
    assert.equal(existsSync(join(daemon.dataDir, "cloud-destination.json")), false);
  } finally {
    await daemon.close();
  }
});

test("a malformed stored destination fails closed instead of using the official default", async () => {
  const dataDir = await makeDataDir();
  await writeFile(join(dataDir, "cloud-destination.json"), "{not json", "utf8");
  const daemon = await startDaemonServer({
    port: 0,
    dataDir,
    distDir: null,
    env: {
      SUPABASE_URL: "https://project.example.test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      FIT_TRACE_CLOUD_API_BASE_URL: "https://cloud.example.test/api/v1",
    },
    verifier: createTestVerifier({ "token-a": { id: "user-a", email: "a@example.test", isAnonymous: false } }),
  });
  try {
    const status = await fetch(`${daemon.url}/api/v1/coaching/cloud/destination`, {
      headers: { authorization: "Bearer token-a" },
    });
    const body = (await status.json()) as { data: { source: string; error: { code: string } } };
    assert.equal(body.data.source, "invalid");
    assert.equal(body.data.error.code, "CLOUD_DESTINATION_INVALID");
    const capabilities = await fetch(`${daemon.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer token-a" },
    });
    assert.equal(capabilities.status, 503);
    assert.equal(
      ((await capabilities.json()) as { error: { code: string } }).error.code,
      "CLOUD_DESTINATION_INVALID",
    );
  } finally {
    await daemon.close();
  }
});

// --- pi availability: CLI presence alone is not enough ---

test("resolvePiAvailability separates a missing CLI from a missing extension", () => {
  const exists = () => true;
  const missing = () => false;

  // No CLI at all: install pi.
  const noCli = resolvePiAvailability({ cliAvailable: false, extensionPath: "/x/index.ts", pathExists: exists });
  assert.equal(noCli.available, false);
  assert.equal(noCli.reason?.code, "cli-not-installed");

  // CLI present and the extension is there: packaging is sound, and the
  // resolved path is reported back so the run uses exactly what was verified.
  const ok = resolvePiAvailability({ cliAvailable: true, extensionPath: "/app/pi-extension.mjs", pathExists: exists });
  assert.equal(ok.available, true);
  assert.equal(ok.reason, undefined);
  assert.equal(ok.path, "/app/pi-extension.mjs");

  // CLI present but no candidate exists anywhere. This must NOT be reported as
  // "cli-not-installed": that would send the user to reinstall a CLI they
  // already have, which is the exact inversion #67 exists to remove.
  const noExtension = resolvePiAvailability({
    cliAvailable: true,
    extensionPath: "/app/pi-extension.mjs",
    daemonDir: "/app/Contents/Resources",
    pathExists: missing,
  });
  assert.equal(noExtension.available, false);
  assert.equal(noExtension.reason?.code, "cli-version-unsupported");
  assert.match(noExtension.reason?.message ?? "", /pi-extension\.mjs/, "the message must name the paths tried");
  assert.doesNotMatch(noExtension.reason?.message ?? "", /on PATH/, "must not blame the CLI");
});

test("a wrong --extension falls back to the resource next to the daemon", () => {
  // The self-healing case: the shell passes a path that does not exist (a
  // repackaged layout, an operator override, a moved resource), but the
  // extension shipped beside the daemon. Hard-failing on the first candidate
  // would report "local coaching broken" for a recoverable mismatch.
  const daemonDir = "/app/Contents/Resources";
  const shipped = `${daemonDir}/pi-extension.mjs`;
  const resolution = resolvePiAvailability({
    cliAvailable: true,
    extensionPath: "/stale/path/pi-extension.mjs",
    daemonDir,
    pathExists: (candidate) => candidate === shipped,
  });
  assert.equal(resolution.available, true);
  assert.equal(resolution.path, shipped, "the RUN must get the path that was actually found");
});

test("piExtensionCandidates orders the explicit path before the shipped resources", () => {
  const candidates = piExtensionCandidates({
    extensionPath: "/explicit/pi-extension.mjs",
    daemonDir: "/app/Contents/Resources",
  });
  assert.equal(candidates[0], "/explicit/pi-extension.mjs");
  assert.ok(candidates.includes("/app/Contents/Resources/pi-extension.mjs"));
  // Deduplicated: the same path requested twice must not appear twice.
  assert.equal(new Set(candidates).size, candidates.length);
});

test("a packaged daemon with pi but a missing extension advertises coaching unavailable", async () => {
  // The packaged-app failure this guards: `pi` is installed, so the CLI probe
  // says yes, but the bundled extension was not shipped (or the override is
  // wrong). Before this fix the daemon advertised local-pi as available and the
  // run died later with EXTENSION_ERROR.
  const { daemon } = await bootDaemon({
    piAvailable: true,
    extensionPath: "/nonexistent/pi-extension.mjs",
    pathExists: () => false,
  });
  try {
    const bootstrap = await fetch(`${daemon.url}/coaching/bootstrap`, {
      method: "POST",
      headers: { authorization: GUEST_AUTH },
    });
    assert.equal(bootstrap.status, 200);
    const capability = ((await bootstrap.json()) as { data: { capability: string } }).data.capability;
    const creds = { authorization: GUEST_AUTH, [CAPABILITY_HEADER]: capability };

    const capabilitiesResponse = await fetch(`${daemon.url}/coaching/capabilities`, { headers: creds });
    assert.equal(capabilitiesResponse.status, 200);
    const discovery = parseCoachingCapabilityDiscovery(
      ((await capabilitiesResponse.json()) as { data: unknown }).data,
    );
    const localPi = discovery.backends.find((entry) => entry.backendId === "local-pi");
    assert.equal(localPi?.available, false, "an unloadable extension must not be advertised");
    assert.equal(localPi?.unavailableReason?.code, "cli-version-unsupported");

    // The injected runtime script must agree with discovery, or the Coach UI
    // offers a backend the server has already rejected.
    const runtimeScript = await (await fetch(`${daemon.url}/fit-trace-runtime.js`)).text();
    assert.match(runtimeScript, /piAvailable: false/);
  } finally {
    await daemon.close();
  }
});

// --- CLI surface: daemon flags parse, unknown arguments refuse ---

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["packages/fit-trace-cli/src/cli.ts", ...args], {
      env: {
        ...process.env,
        SUPABASE_URL: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_ANON_KEY: "",
        ...extraEnv,
      },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) reject(new Error(`cli ${args.join(" ")} was killed by ${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

test("daemon CLI parses --port/--data/--dist, serves headless, and exits cleanly on SIGINT", async () => {
  const dataDir = await makeDataDir();
  tempDirs.push(dataDir);
  const child = spawn(
    process.execPath,
    [
      "packages/fit-trace-cli/src/cli.ts",
      "daemon",
      "--port",
      "0",
      "--data",
      dataDir,
      "--dist",
      join(dataDir, "no-dist-here"),
    ],
    {
      env: {
        ...process.env,
        SUPABASE_URL: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_ANON_KEY: "",
      },
      timeout: 30_000,
    },
  );
  let stdout = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`daemon CLI never listened: ${stdout}`)),
      20_000,
    );
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        resolve(match[1] ?? "");
      }
    };
    child.stdout.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon CLI exited before listening (code ${String(code)}): ${stdout}`));
    });
  });
  // The boot waiter's close listener must not swallow the shutdown exit.
  child.removeAllListeners("close");

  try {
    // --data took effect: the identity file landed in the requested dir.
    const identity = JSON.parse(
      await readFile(join(dataDir, "identity.json"), "utf8"),
    ) as { active_principal: string };
    assert.equal(identity.active_principal, "guest");
    // The missing --dist is not an error: shell 404, data plane live.
    assert.equal((await fetch(`${url}/`)).status, 404);
    const configured = await fetch(`${url}/api/v1/public-config`);
    assert.equal(configured.status, 200);
    assert.deepEqual(await configured.json(), {
      data: { daemon: true, auth_configured: false },
    });
  } finally {
    child.kill("SIGINT");
  }
  const exit = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  assert.equal(exit, 0);
});

test("daemon CLI refuses valueless and unknown flags", async () => {
  for (const flag of ["--port", "--data", "--dist"]) {
    const result = await runCli(["daemon", flag]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`missing value for ${flag.replace("-", "\\-")}`));
  }
  const unknown = await runCli(["daemon", "--bogus"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown argument: --bogus/);
});

// --- #68: three local backends, probed after startup ---

/** Bootstrap a guest capability and return everything needed to call /coaching. */
async function coachingCreds(daemon: DaemonServer): Promise<Record<string, string>> {
  const bootstrap = await fetch(`${daemon.url}/coaching/bootstrap`, {
    method: "POST",
    headers: { authorization: GUEST_AUTH },
  });
  const raw = (await bootstrap.json()) as { data?: { capability?: string } };
  if (raw.data?.capability === undefined) {
    throw new Error(`bootstrap failed (${bootstrap.status}): ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const capability = raw.data.capability;
  return { authorization: GUEST_AUTH, [CAPABILITY_HEADER]: capability };
}

async function discoverBackends(daemon: DaemonServer): Promise<CoachingCapabilityDiscovery> {
  const creds = await coachingCreds(daemon);
  const response = await fetch(`${daemon.url}/coaching/capabilities`, { headers: creds });
  return parseCoachingCapabilityDiscovery(((await response.json()) as { data: unknown }).data);
}

/**
 * A probe double: `support` is the capability answer, `executablePath` the
 * binary that was "detected". Both travel together because production detection
 * resolves the path BEFORE probing, and the registration must report the same
 * file the run will spawn.
 */
function detected<T>(support: T, executablePath?: string) {
  return async (): Promise<DetectedLocalCli<T>> =>
    executablePath === undefined ? { support } : { support, executablePath };
}

/** A promise that never settles: models a hung child process. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

test("all three local backends are registered and unprobed CLIs are not claimed absent", async () => {
  // Neither probe ever settles, so this observes the STARTUP state: what a
  // user sees before any child process has answered.
  const { daemon } = await bootDaemon({
    piAvailable: false,
    localCliProbeTimeoutMs: 30_000,
    localCliProbes: { codex: () => never(), openCode: () => never() },
  });
  try {
    const discovery = await discoverBackends(daemon);
    const ids = discovery.backends.map((entry) => entry.backendId);
    assert.deepEqual(ids.sort(), ["cloud-default", "local-codex", "local-opencode", "local-pi"]);

    for (const backendId of ["local-codex", "local-opencode"] as const) {
      const entry = discovery.backends.find((candidate) => candidate.backendId === backendId);
      assert.equal(entry?.available, false, `${backendId} must not be advertised before it is probed`);
      assert.equal(entry?.unavailableReason?.code, "probe-pending");
      // The reason must say "not probed", NOT "not installed": we have not
      // asked, and claiming absence sends the user to install what they have.
      assert.match(
        entry?.unavailableReason?.message ?? "",
        /pending/i,
        `${backendId} must report that it is unprobed rather than absent`,
      );
    }
  } finally {
    await daemon.close();
  }
});

test("the port accepts connections while the pi probe and CLI probes are all unresolved", async () => {
  // The startup blocker this replaces: `runDaemon` awaited `checkPiCli()` BEFORE
  // binding. Here the pi probe is an explicit promise the test controls plus two
  // probes that never settle, so nothing can have answered before the listener.
  let piResolved = false;
  let resolvePi: ((value: boolean) => void) | undefined;
  const piProbe = new Promise<boolean>((resolve) => {
    resolvePi = (value: boolean) => {
      piResolved = true;
      resolve(value);
    };
  });
  const { daemon } = await bootDaemon({
    piAvailable: piProbe,
    localCliProbeTimeoutMs: 30_000,
    localCliProbes: { codex: () => never(), openCode: () => never() },
  });
  try {
    // startDaemonServer RESOLVED, i.e. the listener is bound, while the probe
    // that used to gate it is provably still pending.
    assert.equal(piResolved, false, "the listener must not wait for the pi probe");
    const response = await fetch(`${daemon.url}/api/v1/public-config`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(piResolved, false, "serving requests must not resolve the probe either");
  } finally {
    void resolvePi;
    await daemon.close();
  }
});

test("a shell is served while probes are unresolved", async () => {
  assert.ok(shellDist !== null);
  const { daemon } = await bootDaemon({
    distDir: shellDist,
    piAvailable: false,
    localCliProbeTimeoutMs: 30_000,
    localCliProbes: { codex: () => never(), openCode: () => never() },
  });
  try {
    const shell = await fetch(`${daemon.url}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /daemon-shell-root/);
  } finally {
    await daemon.close();
  }
});

test("a late probe updates BOTH discovery and submission with no restart", async () => {
  // Codex becomes available after the listener is up. Submission must follow,
  // not just the discovery payload: a settings page could otherwise enable a
  // backend the server still refuses to run.
  let finishCodex: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finishCodex = resolve;
  });
  const { daemon } = await bootDaemon({
    piAvailable: false,
    // No local runtime factory: the test drives the pi backend through the
    // injected registry path below instead of spawning a real CLI.
    localCliProbeTimeoutMs: 30_000,
    localCliProbes: {
      // Latches on `gate`: resolving it produces a VERIFIED Codex.
      codex: async () => {
        await gate;
        return {
          support: { supported: true, builtinIsolationVerified: true, version: "9.9.9-late" },
          executablePath: "/opt/late/codex",
        };
      },
      openCode: async () => ({
        support: { supported: false, isolationVerified: false, gap: "not installed (test)" },
      }),
    },
  });
  try {
    // Before the probe settles: unavailable, with the "not probed" reason.
    const before = await discoverBackends(daemon);
    const codexBefore = before.backends.find((entry) => entry.backendId === "local-codex");
    assert.equal(codexBefore?.available, false);
    assert.match(codexBefore?.unavailableReason?.message ?? "", /pending/i);

    finishCodex?.();
    await daemon.localCliRefreshSettled();

    const after = await discoverBackends(daemon);
    const codexAfter = after.backends.find((entry) => entry.backendId === "local-codex");
    assert.equal(codexAfter?.available, true, "discovery must reflect the late probe");
    assert.equal(codexAfter?.version, "9.9.9-late");
    assert.equal(codexAfter?.executablePath, "/opt/late/codex");
    assert.equal(codexAfter?.unavailableReason, undefined);

    // Submission now dispatches to the CODEX factory instead of being refused.
    // A real run would spawn the CLI, so assert the routing decision only: the
    // refusal disappears, which is exactly what "submission reflects it" means.
    const creds = await coachingCreds(daemon);
    const created = await fetch(`${daemon.url}/coaching/sessions`, { method: "POST", headers: creds });
    assert.equal(created.status, 201);
    const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
    const snapshot = await fetch(`${daemon.url}/coaching/snapshots`, {
      method: "POST",
      headers: { ...creds, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(snapshot.status, 201);
    const handle = ((await snapshot.json()) as {
      data: { snapshotId: string; source: string; accountId: string };
    }).data;
    const run = await fetch(`${daemon.url}/coaching/runs`, {
      method: "POST",
      headers: { ...creds, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        snapshot: { snapshotId: handle.snapshotId, source: handle.source, accountId: handle.accountId },
        prompt: "analyze",
        idempotencyKey: "late-probe",
        backendId: "local-codex",
      }),
    });
    // No longer refused as unavailable. It may still fail later at spawn time
    // (there is no /opt/late/codex), which is the truthful outcome here.
    assert.notEqual(run.status, 400, await run.text());
  } finally {
    await daemon.close();
  }
});

test("a hanging probe never delays startup, and another backend still works", async () => {
  const { daemon } = await bootDaemon({
    piAvailable: false,
    // Short bound so the test does not sit through the production timeout.
    localCliProbeTimeoutMs: 150,
    localCliProbes: {
      codex: () => never(),
      // OpenCode answers immediately; a hung Codex must not affect it.
      openCode: detected({ supported: false, isolationVerified: false, gap: "not installed (test)" }),
    },
  });
  try {
    const response = await fetch(`${daemon.url}/api/v1/public-config`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();

    await daemon.localCliRefreshSettled();
    const discovery = await discoverBackends(daemon);
    const openCode = discovery.backends.find((entry) => entry.backendId === "local-opencode");
    const codex = discovery.backends.find((entry) => entry.backendId === "local-codex");
    // OpenCode published its real answer…
    assert.equal(openCode?.available, false);
    assert.match(openCode?.unavailableReason?.message ?? "", /not installed \(test\)/);
    // …while the hung Codex kept the truthful "not probed yet" state instead of
    // inheriting OpenCode's outcome or being claimed absent.
    assert.equal(codex?.available, false);
    assert.match(codex?.unavailableReason?.message ?? "", /pending/i);
  } finally {
    await daemon.close();
  }
});

test("an installed CLI whose isolation gate fails stays unavailable (gate not bypassed)", async () => {
  const { daemon } = await bootDaemon({
    piAvailable: false,
    localCliProbes: {
      // ADR 0007: a supported Codex is admitted under a read-only sandbox even
      // though built-in isolation is NOT proven. `builtinIsolationVerified`
      // stays false and the gap says what remains possible.
      codex: detected({
        supported: true,
        builtinIsolationVerified: false,
        version: "0.9.0-test",
        gap: "read-only sandbox: built-in reads remain possible",
      }),
      // Same for OpenCode: supported, version known, isolation NOT verified.
      openCode: detected({
        supported: true,
        isolationVerified: false,
        version: "2.0.30",
        model: "fixture/model",
        gap: "plugin-isolation-unproven: built-in inventory was not excluded",
      }),
    },
  });
  try {
    await daemon.localCliRefreshSettled();
    const discovery = await discoverBackends(daemon);
    const codex = discovery.backends.find((entry) => entry.backendId === "local-codex");
    const openCode = discovery.backends.find((entry) => entry.backendId === "local-opencode");

    // Codex: admitted under the weaker posture (ADR 0007).
    assert.equal(codex?.available, true, "a supported Codex is admitted read-only");
    assert.equal(codex?.unavailableReason, undefined);

    // OpenCode: unchanged. It needs positive inventory evidence that nothing
    // supplies, so it stays unavailable — the two gates are NOT the same and
    // relaxing one must not silently relax the other.
    assert.equal(openCode?.available, false, "an unproven OpenCode must never be selectable");
    assert.equal(openCode?.unavailableReason?.code, "cli-version-unsupported");
    assert.match(openCode?.unavailableReason?.message ?? "", /plugin-isolation-unproven/);
    // The version is reported even though unavailable: installing the CLI is
    // not the fix, and a settings page must be able to say which one it saw.
    assert.equal(codex?.version, "0.9.0-test");
  } finally {
    await daemon.close();
  }
});

test("an unavailable backend rejects submit with its own reason rather than dispatching", async () => {
  const { daemon } = await bootDaemon({
    piAvailable: false,
    localCliProbes: {
      // Codex is admitted under ADR 0007, so OpenCode is the unavailable
      // backend this test needs: its gate is unchanged and still refuses.
      codex: detected({ supported: true, builtinIsolationVerified: false, gap: "read-only sandbox (test)" }),
      openCode: detected({
        supported: true,
        isolationVerified: false,
        model: "fixture/model",
        gap: "plugin-isolation-unproven: test double",
      }),
    },
  });
  try {
    await daemon.localCliRefreshSettled();
    const creds = await coachingCreds(daemon);
    const created = await fetch(`${daemon.url}/coaching/sessions`, { method: "POST", headers: creds });
    assert.equal(created.status, 201);
    const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
    const snapshot = await fetch(`${daemon.url}/coaching/snapshots`, {
      method: "POST",
      headers: { ...creds, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(snapshot.status, 201);
    // A submit accepts a snapshot HANDLE only (id/source/account); the server
    // resolves records itself.
    const snapshotBody = ((await snapshot.json()) as {
      data: { snapshotId: string; source: string; accountId: string };
    }).data;
    const snapshotHandle = {
      snapshotId: snapshotBody.snapshotId,
      source: snapshotBody.source,
      accountId: snapshotBody.accountId,
    };

    // Discovery says unavailable, so a submit naming it must be REFUSED with
    // that reason — never silently routed to another backend.
    const run = await fetch(`${daemon.url}/coaching/runs`, {
      method: "POST",
      headers: { ...creds, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        snapshot: snapshotHandle,
        prompt: "analyze",
        idempotencyKey: "test-unavailable-backend",
        backendId: "local-opencode",
      }),
    });
    assert.equal(run.status, 400);
    const error = ((await run.json()) as { error?: { message?: string } }).error;
    assert.match(error?.message ?? "", /plugin-isolation-unproven/);
  } finally {
    await daemon.close();
  }
});

test("discovery reports path, version, availability and reason as distinct fields", async () => {
  const { daemon } = await bootDaemon({
    piAvailable: false,
    localCliProbes: {
      // OpenCode is the backend that stays gated after ADR 0007, so it is the
      // "installed at a known path but not usable" case a settings page must
      // render: path, version, availability and a reason, all distinct.
      codex: detected({ supported: false, builtinIsolationVerified: false, gap: "x" }),
      openCode: detected(
        {
          supported: true,
          isolationVerified: false,
          version: "2.0.30",
          model: "fixture/model",
          gap: "plugin-isolation-unproven: test double",
        },
        "/usr/local/bin/opencode-shadowed",
      ),
    },
  });
  try {
    await daemon.localCliRefreshSettled();
    const discovery = await discoverBackends(daemon);
    const openCode = discovery.backends.find((entry) => entry.backendId === "local-opencode");
    assert.ok(openCode !== undefined);
    // Field by field, not "present": a settings page renders all four.
    assert.equal(openCode.executablePath, "/usr/local/bin/opencode-shadowed");
    assert.equal(openCode.version, "2.0.30");
    assert.equal(openCode.available, false);
    assert.equal(openCode.unavailableReason?.code, "cli-version-unsupported");
    assert.equal(typeof openCode.unavailableReason?.message, "string");
    assert.notEqual(openCode.unavailableReason?.message, "");
    // Codex was not installed here, so no path is invented for it.
    const codex = discovery.backends.find((entry) => entry.backendId === "local-codex");
    assert.equal(codex?.executablePath, undefined);
  } finally {
    await daemon.close();
  }
});

test("an explicit piAvailable:false is honoured immediately, not overwritten by the refresh", async () => {
  // A known "no" is an answer. The optimistic startup registration only exists
  // for a still-pending probe; a boolean must not be treated as "probably fine".
  const { daemon } = await bootDaemon({
    piAvailable: false,
    localCliProbes: {
      codex: detected({ supported: false, builtinIsolationVerified: false, gap: "x" }),
      openCode: detected({ supported: false, isolationVerified: false, gap: "y" }),
    },
  });
  try {
    const before = await discoverBackends(daemon);
    const piBefore = before.backends.find((entry) => entry.backendId === "local-pi");
    assert.equal(piBefore?.available, false);
    await daemon.localCliRefreshSettled();
    const after = await discoverBackends(daemon);
    const piAfter = after.backends.find((entry) => entry.backendId === "local-pi");
    assert.equal(piAfter?.available, false, "an explicit false must survive the refresh");
  } finally {
    await daemon.close();
  }
});

// --- `--runtime`: a default selection, never a discovery filter ---

test("--runtime selects the default backend without filtering discovery", async () => {
  // The semantics chosen for the daemon: `--runtime` preselects what a NEW run
  // uses. It must NOT hide other backends — a settings page (#69) has to offer
  // every installed CLI, and filtering here would make an installed CLI
  // unreachable.
  const { daemon } = await bootDaemon({
    defaultRuntime: "codex",
    piAvailable: false,
    localCliProbes: {
      codex: detected({ supported: false, builtinIsolationVerified: false, gap: "unproven (test)" }),
      openCode: detected({ supported: false, isolationVerified: false, gap: "absent (test)" }),
    },
  });
  try {
    assert.equal(daemon.defaultBackendId, "local-codex", "the named runtime is the default");
    await daemon.localCliRefreshSettled();
    const discovery = await discoverBackends(daemon);
    // All four backends are still reported: selection ≠ filtering.
    assert.deepEqual(
      discovery.backends.map((entry) => entry.backendId).sort(),
      ["cloud-default", "local-codex", "local-opencode", "local-pi"],
    );
  } finally {
    await daemon.close();
  }
});

test("without --runtime no unavailable backend is selected", async () => {
  assert.equal(defaultBackendIdFor(undefined), null);

  const { daemon } = await bootDaemon({
    piAvailable: false,
    localCliProbes: {
      codex: detected({ supported: false, builtinIsolationVerified: false, gap: "x" }),
      openCode: detected({ supported: false, isolationVerified: false, gap: "y" }),
    },
  });
  try {
    await daemon.localCliRefreshSettled();
    assert.equal(daemon.defaultBackendId, null);
  } finally {
    await daemon.close();
  }
});

test("--runtime maps each local runtime to its backend, and refuses cloud", () => {
  assert.equal(defaultBackendIdFor("pi"), "local-pi");
  assert.equal(defaultBackendIdFor("codex"), "local-codex");
  assert.equal(defaultBackendIdFor("opencode"), "local-opencode");
  // The daemon has no cloud execution path; naming it as the local default
  // would promise a backend this server cannot run.
  assert.throws(() => defaultBackendIdFor("hosted-sdk"), /cannot default to the hosted-sdk cloud runtime/);
});

// --- shutdown signal safety: no orphaned journal lock ---

test("SIGTERM during startup still releases the journal lock", async () => {
  // The regression this pins: the SIGTERM/SIGINT handlers used to be installed
  // only AFTER `startDaemonServer` returned. Between the journal lock being
  // acquired and the handlers existing, a signal hit Node's default action, the
  // process died without `close()`, and `<dataDir>/coaching-journal.json.lock`
  // survived. The NEXT daemon then refused to start with the fail-closed stale
  // lock error (exit code 3) — so a supervisor restarting the daemon could be
  // wedged by a signal it sent microseconds too early.
  //
  // The window is real but narrow, so this asserts the INVARIANT rather than a
  // specific timing: kill as soon as startup is visibly in progress (the
  // identity file exists), then require that (a) the process exits cleanly and
  // (b) a fresh daemon on the same data dir can start.
  const dataDir = await makeDataDir();
  tempDirs.push(dataDir);
  const child = spawn(
    process.execPath,
    [
      "packages/fit-trace-cli/src/cli.ts",
      "daemon",
      "--port",
      "0",
      "--data",
      dataDir,
      "--dist",
      join(dataDir, "no-dist-here"),
    ],
    {
      env: {
        ...process.env,
        SUPABASE_URL: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_ANON_KEY: "",
      },
      timeout: 30_000,
    },
  );
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));

  // `identity.json` is written before the listener binds, so this lands inside
  // the window the old code left uncovered.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = (): void => {
      if (existsSync(join(dataDir, "identity.json"))) {
        child.kill("SIGTERM");
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("daemon never began startup"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });

  assert.equal(await exit, 0, "a signal during startup must still shut down cleanly");
  // The lock is released, so a second daemon on the same data dir starts.
  assert.equal(
    existsSync(join(dataDir, "coaching-journal.json.lock")),
    false,
    "shutdown must release the coaching journal lock",
  );
  const restarted = await startDaemonServer({
    port: 0,
    dataDir,
    distDir: null,
    env: NO_SUPABASE_ENV,
    piAvailable: false,
    localCliProbeTimeoutMs: 50,
    localCliProbes: {
      codex: detected({ supported: false, builtinIsolationVerified: false, gap: "x" }),
      openCode: detected({ supported: false, isolationVerified: false, gap: "y" }),
    },
  });
  try {
    assert.equal((await fetch(`${restarted.url}/api/v1/public-config`)).status, 200);
  } finally {
    await restarted.close();
  }
});

// --- #68 review follow-ups: independent publishing and an honoured default ---

test("a settled pi probe publishes even while an unrelated CLI probe hangs", async () => {
  // Regression: the earlier `Promise.all` held a KNOWN pi result hostage behind
  // an unrelated slow probe, so discovery kept advertising an optimistic pi
  // that was not there, for up to the full probe bound.
  //
  // `piAvailable` must be a PROBE (not the immediate boolean) for this test to
  // mean anything: a boolean is known before the refresh starts, so both the
  // old and new implementations agree instantly and the ordering is invisible.
  const { daemon } = await bootDaemon({
    piAvailable: Promise.resolve(false),
    localCliProbes: {
      codex: () => new Promise(() => {}),
      openCode: () => new Promise(() => {}),
    },
  });
  try {
    // Wait only for pi to settle; the other two never will.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const discovery = await discoverBackends(daemon);
      const pi = discovery.backends.find((entry) => entry.backendId === "local-pi");
      if (pi?.available === false) {
        assert.equal(pi.unavailableReason?.code, "cli-not-installed");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("a known pi result never published while unrelated probes were pending");
  } finally {
    await daemon.close();
  }
});

test("discovery publishes the operator's default backend", async () => {
  // `--runtime` used to be logged and then forgotten, so a run silently used pi
  // despite the operator choosing another backend.
  const { daemon } = await bootDaemon({ piAvailable: false, defaultRuntime: "codex" });
  try {
    const discovery = await discoverBackends(daemon);
    assert.equal(discovery.defaultBackendId, "local-codex");
    assert.equal(discovery.defaultBackendSource, "runtime");
  } finally {
    await daemon.close();
  }
});

test("no default is published when the operator named none", async () => {
  // Absent means "no server preference": the client applies its own default.
  const { daemon } = await bootDaemon({ piAvailable: false });
  try {
    const discovery = await discoverBackends(daemon);
    // "pi" is the legacy default, so the effective choice is local-pi whether
    // or not the field is present; assert the field matches it or is absent.
    assert.ok(
      discovery.defaultBackendId === undefined || discovery.defaultBackendId === "local-pi",
      `unexpected default: ${String(discovery.defaultBackendId)}`,
    );
  } finally {
    await daemon.close();
  }
});

test("a settled alternative does not mark an unprobed pi as absent", async () => {
  // Regression: publishing from OpenCode's settle also evaluated the pi slot,
  // which was still `null`. That flipped an INSTALLED pi to `cli-not-installed`
  // for the length of its own probe — and the app caches a successful discovery
  // per identity, so a Coach screen opened in that window kept pi disabled.
  let resolvePi: ((value: boolean) => void) | undefined;
  const piProbe = new Promise<boolean>((resolve) => {
    resolvePi = resolve;
  });
  const { daemon } = await bootDaemon({
    piAvailable: piProbe,
    localCliProbes: {
      // Settles immediately, which is what used to trigger the bad publish.
      codex: async () => ({
        support: { supported: false, builtinIsolationVerified: false, gap: "no codex (test)" },
      }),
      openCode: async () => ({
        support: { supported: false, isolationVerified: false, gap: "no opencode (test)" },
      }),
    },
  });
  try {
    // Bootstrap ONCE: every call mints a capability and they are capacity
    // limited, so polling through `discoverBackends` exhausts them (503).
    const creds = await coachingCreds(daemon);
    const discoverOnce = async (): Promise<CoachingCapabilityDiscovery> => {
      const response = await fetch(`${daemon.url}/coaching/capabilities`, { headers: creds });
      return parseCoachingCapabilityDiscovery(((await response.json()) as { data: unknown }).data);
    };
    // Let both alternatives settle while pi is still pending.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const discovery = await discoverOnce();
      const pi = discovery.backends.find((entry) => entry.backendId === "local-pi");
      assert.notEqual(
        pi?.unavailableReason?.code,
        "cli-not-installed",
        "an unprobed pi must not be reported as absent",
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Now let pi settle and confirm the real answer does take effect.
    resolvePi?.(false);
    await daemon.localCliRefreshSettled();
    const settled = await discoverOnce();
    const pi = settled.backends.find((entry) => entry.backendId === "local-pi");
    assert.equal(pi?.available, false);
    assert.equal(pi?.unavailableReason?.code, "cli-not-installed");
  } finally {
    resolvePi?.(false);
    await daemon.close();
  }
});

test("manual rescan reruns pi detection and publishes the new executable version", async () => {
  if (process.platform === "win32") return;
  const { chmod } = await import("node:fs/promises");
  const bin = await mkdtemp(join(tmpdir(), "fit-trace-pi-bin-"));
  const binary = join(bin, "pi");
  const oldPath = process.env.PATH;
  const install = async (version: string): Promise<void> => {
    await writeFile(binary, `#!/bin/sh\nprintf '${version}\\n'\n`);
    await chmod(binary, 0o755);
  };
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  await install("1.0.0");
  const { daemon, dataDir } = await bootDaemon({ localCliProbes: {
    codex: async () => ({ support: { supported: false, builtinIsolationVerified: false } }),
    openCode: async () => ({ support: { supported: false, isolationVerified: false } }),
  } });
  try {
    await daemon.localCliRefreshSettled();
    const headers = await coachingCreds(daemon);
    const first = await fetch(`${daemon.url}/coaching/capabilities`, { headers });
    const firstDiscovery = parseCoachingCapabilityDiscovery(((await first.json()) as { data: unknown }).data);
    assert.equal(firstDiscovery.backends.find((backend) => backend.backendId === "local-pi")?.version, "1.0.0");
    assert.equal(firstDiscovery.defaultBackendSource, "automatic");
    await install("2.0.0");
    const second = await fetch(`${daemon.url}/coaching/capabilities`, { method: "POST", headers });
    assert.equal(second.status, 200);
    const secondDiscovery = parseCoachingCapabilityDiscovery(((await second.json()) as { data: unknown }).data);
    const pi = secondDiscovery.backends.find((backend) => backend.backendId === "local-pi");
    assert.equal(pi?.version, "2.0.0");
    assert.equal(pi?.executablePath, binary);
    await rm(binary);
    const removed = await fetch(`${daemon.url}/coaching/capabilities`, { method: "POST", headers });
    const removedDiscovery = parseCoachingCapabilityDiscovery(((await removed.json()) as { data: unknown }).data);
    assert.notEqual(removedDiscovery.backends.find((backend) => backend.backendId === "local-pi")?.executablePath, binary);
    await install("3.0.0");
    const reinstalled = await fetch(`${daemon.url}/coaching/capabilities`, { method: "POST", headers });
    const reinstalledDiscovery = parseCoachingCapabilityDiscovery(((await reinstalled.json()) as { data: unknown }).data);
    assert.equal(reinstalledDiscovery.backends.find((backend) => backend.backendId === "local-pi")?.version, "3.0.0");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

test("sync routes default closed and fence a revoked verified session", async () => {
  const disabled = await bootDaemon();
  try {
    assert.equal((await fetch(`${disabled.daemon.url}/api/v1/sync/bootstrap`, { method: "POST" })).status, 503);
    const unavailable = await fetch(`${disabled.daemon.url}/api/v1/sync/revoke-session`, { method: "POST", headers: { authorization: "Bearer unknown" } });
    assert.equal(unavailable.status, 200);
    assert.deepEqual(await unavailable.json(), { data: { revoked: false, configured: false } });
    // A previous sync state means this daemon cannot confirm revocation while
    // sync is disabled; it must not report the same never-configured result.
    await writeFile(join(disabled.dataDir, "workout-sync-session.db"), "");
    assert.equal((await fetch(`${disabled.daemon.url}/api/v1/sync/revoke-session`, { method: "POST", headers: { authorization: "Bearer unknown" } })).status, 503);
  } finally { await disabled.daemon.close(); await rm(disabled.dataDir, { recursive: true, force: true }); }
  const claims = { iss: "https://auth.example.test/auth/v1", sub: "alice", role: "authenticated", aud: "authenticated", session_id: "00000000-0000-0000-0000-000000000001" };
  const token = signedSyncToken(JSON.stringify(claims));
  const bobClaims = { ...claims, sub: "bob", session_id: "00000000-0000-0000-0000-000000000002" };
  const bobToken = signedSyncToken(JSON.stringify(bobClaims));
  const enabled = await bootDaemon({
    env: { SUPABASE_URL: "https://auth.example.test", SUPABASE_PUBLISHABLE_KEY: "public", FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH: "1", FIT_TRACE_SYNC_PUBLIC_KEYS: JSON.stringify(syncAuthFixture.publicKeys), FIT_TRACE_API_BASE_URL: "https://api.example.test/api/v1" },
    syncAuthFetch: syncAuthFixture.fetchImpl,
    verifier: { async verify(value) { if (value === token) return { id: "alice", isAnonymous: false }; if (value === bobToken) return { id: "bob", isAnonymous: false }; throw new Error("bad token"); } },
  });
  try {
    const headers = { authorization: `Bearer ${token}` };
    const bootstrap = await fetch(`${enabled.daemon.url}/api/v1/sync/bootstrap`, { method: "POST", headers });
    assert.equal(bootstrap.status, 200);
    const { data: { capability } } = await bootstrap.json() as { data: { capability: string } };
    const withCapability = { ...headers, "x-fit-trace-sync-capability": capability };
    assert.equal((await fetch(`${enabled.daemon.url}/api/v1/sync/consent`, { method: "POST", headers: { ...withCapability, "content-type": "application/json" }, body: JSON.stringify({ endpoint: "https://api.example.test/api/v1" }) })).status, 200);
    const transition = await fetch(`${enabled.daemon.url}/api/v1/sync/transition`, { method: "POST", headers: { authorization: `Bearer ${bobToken}`, "x-fit-trace-sync-capability": capability } });
    assert.equal(transition.status, 200);
    const { data: { capability: bobCapability } } = await transition.json() as { data: { capability: string } };
    assert.equal((await fetch(`${enabled.daemon.url}/api/v1/sync/bootstrap`, { method: "POST", headers })).status, 403);
    assert.equal((await fetch(`${enabled.daemon.url}/api/v1/sync/status`, { headers: withCapability })).status, 403);
    assert.equal((await fetch(`${enabled.daemon.url}/api/v1/sync/logout`, { method: "POST", headers: { "x-fit-trace-sync-capability": capability } })).status, 403);
    const revoke = `${enabled.daemon.url}/api/v1/sync/revoke-session`;
    const aliceRevoke = await fetch(revoke, { method: "POST", headers });
    assert.equal(aliceRevoke.status, 200);
    assert.deepEqual(await aliceRevoke.json(), { data: { revoked: true, configured: true } });
    assert.equal((await fetch(`${enabled.daemon.url}/api/v1/sync/status`, { headers: { authorization: `Bearer ${bobToken}`, "x-fit-trace-sync-capability": bobCapability } })).status, 200);
    assert.equal((await fetch(revoke, { method: "POST", headers: { authorization: "Bearer forged" } })).status, 403);
    assert.equal((await fetch(revoke, { method: "POST", headers: { authorization: `Bearer ${bobToken}` } })).status, 200);
    assert.equal((await fetch(revoke, { method: "POST", headers: { authorization: `Bearer ${bobToken}` } })).status, 200);
    assert.equal((await fetch(`${enabled.daemon.url}/api/v1/sync/status`, { headers: { authorization: `Bearer ${bobToken}`, "x-fit-trace-sync-capability": bobCapability } })).status, 403);
  } finally { await enabled.daemon.close(); await rm(enabled.dataDir, { recursive: true, force: true }); }
});

test("disabled sync confirms no active session even when its database already exists", async () => {
  const { WorkoutSyncSessionState } = await import("../server/workoutSyncSessionState.ts");
  const { daemon, dataDir } = await bootDaemon();
  try {
    const endpoint = `${daemon.url}/api/v1/sync/revoke-session`;
    const request = () => fetch(endpoint, { method: "POST", headers: { authorization: "Bearer test" } });
    // Model a daemon that used sync before and cleanly revoked its session.
    const state = new WorkoutSyncSessionState(dataDir);
    const identity = { issuer: "https://auth.example.test/auth/v1", accountId: "account", sessionId: "00000000-0000-0000-0000-000000000001", endpoint: "https://api.example.test/api/v1" };
    const cap = state.bootstrap(identity, state.version());
    state.logout(cap, () => {});
    state.close();
    const inactive = await request();
    assert.equal(inactive.status, 200);
    assert.deepEqual(await inactive.json(), { data: { revoked: false, configured: false } });
    // A separate sync daemon holding the ownership lock is not safe to inspect.
    const owner = new WorkoutSyncSessionState(dataDir);
    assert.equal((await request()).status, 503);
    const active = { ...identity, sessionId: "00000000-0000-0000-0000-000000000002" };
    owner.bootstrap(active, owner.version());
    owner.close();
    assert.equal((await request()).status, 503);
  } finally {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
