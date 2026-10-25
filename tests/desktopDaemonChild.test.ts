import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, test } from "node:test";

/**
 * Tests for the desktop shell's daemon child manager
 * (packages/fit-trace-desktop/main/daemonChild.cjs — plain Node, no electron,
 * no window). The CLI-level cases spawn the real `cli.ts daemon` exactly the
 * way main.cjs does (port 0, tmp data dir); the planner/parser cases cover
 * the pure helpers.
 */

const require = createRequire(import.meta.url);
const daemonChild = require("../packages/fit-trace-desktop/main/daemonChild.cjs") as {
  URL_TIMEOUT_MS: number;
  parseDaemonUrl: (text: string) => string | null;
  nextRestartDelay: (attempt: number) => number;
  healthCheck: (url: string) => Promise<boolean>;
  spawnDaemon: (options: {
    nodePath: string;
    cliPath: string;
    dataDir?: string;
    port?: number;
    env?: NodeJS.ProcessEnv;
    urlTimeoutMs?: number;
  }) => { child: import("node:child_process").ChildProcess; url: Promise<string> };
  stopDaemonChild: (child: import("node:child_process").ChildProcess | null) => Promise<void>;
};

const CLI_PATH = join(import.meta.dirname, "..", "packages", "fit-trace-cli", "src", "cli.ts");

/** Guest plane only: Supabase deliberately unconfigured (mirrors daemonServer.test.ts). */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SUPABASE_URL: "",
    SUPABASE_PUBLISHABLE_KEY: "",
    SUPABASE_ANON_KEY: "",
  };
}

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function trackDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-desktop-data-"));
  tempDirs.push(dir);
  return dir;
}

/** Prove a loopback port is free again by binding it briefly. */
function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve());
    });
  });
}

test("nextRestartDelay backs off 1s/2s/4s exponentially and caps at 4s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(daemonChild.nextRestartDelay), [
    1000, 2000, 4000, 4000, 4000, 4000,
  ]);
});

test("parseDaemonUrl prefers the listening line and falls back to any loopback URL", () => {
  assert.equal(
    daemonChild.parseDaemonUrl(
      "pi CLI detected: 0.0.x\nfit-trace daemon listening at http://127.0.0.1:5213\ndata directory: /x",
    ),
    "http://127.0.0.1:5213",
  );
  // Fallback: no listening line, but a loopback URL in the noise.
  assert.equal(
    daemonChild.parseDaemonUrl("data directory: /x\nhttp://127.0.0.1:5199"),
    "http://127.0.0.1:5199",
  );
  // Nothing parseable.
  assert.equal(daemonChild.parseDaemonUrl("pi CLI not found on PATH"), null);
  assert.equal(daemonChild.parseDaemonUrl(""), null);
});

test("spawnDaemon launches the real daemon and healthCheck passes against it", async () => {
  const dataDir = await trackDir();
  const { child, url } = daemonChild.spawnDaemon({
    nodePath: process.execPath,
    cliPath: CLI_PATH,
    dataDir,
    port: 0,
    env: childEnv(),
  });
  const daemonUrl = await url;
  try {
    assert.match(daemonUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await daemonChild.healthCheck(daemonUrl), true, "public-config answers 2xx");
  } finally {
    await daemonChild.stopDaemonChild(child);
  }
});

test("stopDaemonChild exits the daemon and releases its port", async () => {
  const dataDir = await trackDir();
  const { child, url } = daemonChild.spawnDaemon({
    nodePath: process.execPath,
    cliPath: CLI_PATH,
    dataDir,
    port: 0,
    env: childEnv(),
  });
  const daemonUrl = await url;
  const port = Number(new URL(daemonUrl).port);
  assert.ok(port > 0);

  await daemonChild.stopDaemonChild(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "child process is gone");
  assert.equal(await daemonChild.healthCheck(daemonUrl), false, "daemon no longer answers");
  await assertPortFree(port);
});

test("spawnDaemon again after stop yields a fresh healthy daemon (restart path)", async () => {
  const dataDir = await trackDir();
  const first = daemonChild.spawnDaemon({
    nodePath: process.execPath,
    cliPath: CLI_PATH,
    dataDir,
    port: 0,
    env: childEnv(),
  });
  // Wait for the first daemon to be up before tearing it down.
  await first.url;
  await daemonChild.stopDaemonChild(first.child);

  const second = daemonChild.spawnDaemon({
    nodePath: process.execPath,
    cliPath: CLI_PATH,
    dataDir,
    port: 0,
    env: childEnv(),
  });
  const secondUrl = await second.url;
  try {
    assert.match(secondUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    // No assertion that the second URL differs from the first: the OS is
    // free to hand back the port the previous daemon just released.
    assert.equal(await daemonChild.healthCheck(secondUrl), true);
  } finally {
    await daemonChild.stopDaemonChild(second.child);
  }
});

test("healthCheck fails closed for an unreachable loopback URL", async () => {
  // Nothing listens here in the test environment (port 1 on loopback).
  assert.equal(await daemonChild.healthCheck("http://127.0.0.1:1"), false);
});

test("spawnDaemon rejects when no listening line ever arrives (timeout path)", async () => {
  const dir = await trackDir();
  // A stand-in "CLI" that prints unrelated noise forever: no listening line,
  // no loopback URL — the url promise must reject at the (short) timeout.
  const fakeCli = join(dir, "noisy-cli.cjs");
  await writeFile(fakeCli, "setInterval(() => console.log('noise'), 50);\n");
  const { child, url } = daemonChild.spawnDaemon({
    nodePath: process.execPath,
    cliPath: fakeCli,
    dataDir: dir,
    port: 0,
    env: childEnv(),
    urlTimeoutMs: 300,
  });
  await assert.rejects(url, /did not report a listen URL within 300ms/);
  await daemonChild.stopDaemonChild(child);
});

test("spawnDaemon rejects when the node binary itself is missing (bad nodePath)", async () => {
  const dir = await trackDir();
  // A path that does not exist: spawn emits ENOENT via the child's "error"
  // event (never an exception from spawn()), so the url promise must reject.
  const { url } = daemonChild.spawnDaemon({
    nodePath: join(dir, "not-a-real-node-binary"),
    cliPath: CLI_PATH,
    dataDir: dir,
    port: 0,
    env: childEnv(),
  });
  await assert.rejects(url);
});

test("stopDaemonChild resolves for a child that never successfully spawned", async () => {
  const dir = await trackDir();
  // No pid and no future "exit" event: stop must treat it as already gone
  // and resolve instead of hanging (previously it waited on "exit" forever).
  const { child, url } = daemonChild.spawnDaemon({
    nodePath: join(dir, "not-a-real-node-binary"),
    cliPath: CLI_PATH,
    dataDir: dir,
    port: 0,
    env: childEnv(),
  });
  url.catch(() => {}); // rejection is asserted in the companion test
  const stop = daemonChild.stopDaemonChild(child);
  const outcome = await Promise.race([
    stop.then(() => "resolved" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_000)),
  ]);
  assert.equal(outcome, "resolved", "stopDaemonChild must not hang on a never-spawned child");
  await stop;
});
