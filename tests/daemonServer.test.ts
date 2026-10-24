import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
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

let shared: BootedDaemon | null = null;
let shellDist: string | null = null;
const tempDirs: string[] = [];

before(async () => {
  shared = await bootDaemon();
  tempDirs.push(shared.dataDir);
  shellDist = await makeShellDist();
  tempDirs.push(shellDist);
});

after(async () => {
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
