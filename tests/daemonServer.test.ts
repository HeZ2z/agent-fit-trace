import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { parseCoachingCapabilityDiscovery } from "@agent-fit-trace/api-contracts";
import { startDaemonServer } from "../packages/fit-trace-cli/src/daemonServer.ts";
import type { DaemonServer, DaemonServerOptions } from "../packages/fit-trace-cli/src/daemonServer.ts";
import { LOCAL_DAEMON_BEARER } from "../server/auth/localVerifier.ts";
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
