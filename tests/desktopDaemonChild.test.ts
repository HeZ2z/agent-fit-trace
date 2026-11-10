import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
  STALE_JOURNAL_LOCK_EXIT_CODE: number;
  parseDaemonUrl: (text: string) => string | null;
  nextRestartDelay: (attempt: number) => number;
  healthCheck: (url: string) => Promise<boolean>;
  spawnDaemon: (options: {
    nodePath: string;
    cliPath: string;
    dataDir?: string;
    distDir?: string;
    extensionPath?: string;
    port?: number;
    env?: NodeJS.ProcessEnv;
    urlTimeoutMs?: number;
  }) => { child: import("node:child_process").ChildProcess; url: Promise<string> };
  stopDaemonChild: (child: import("node:child_process").ChildProcess | null) => Promise<void>;
  reclaimStaleJournalLock: (dataDir: string | undefined) => number | false;
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

test("spawnDaemon stops the child when the URL timeout rejects", async () => {
  const dir = await trackDir();
  // A program that starts fine but never prints a listening line and never
  // exits: the url promise must reject at the (short) timeout AND the child
  // must have been stopped by spawnDaemon itself (SIGTERM → SIGKILL), not be
  // left running for a caller's stopDaemonChild to clean up.
  const silentCli = join(dir, "silent-forever.cjs");
  await writeFile(silentCli, "setTimeout(() => {}, 100000);\n");
  const { child, url } = daemonChild.spawnDaemon({
    nodePath: process.execPath,
    cliPath: silentCli,
    dataDir: dir,
    port: 0,
    env: childEnv(),
    urlTimeoutMs: 300,
  });
  await assert.rejects(url, /did not report a listen URL within 300ms/);
  // Guard rail: gone within ~1s. Node has no SIGTERM handler here, so the
  // graceful phase alone should terminate it long before SIGKILL.
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    gone = child.exitCode !== null || child.signalCode !== null;
    if (!gone) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(gone, "child process was terminated after the URL timeout");
  // A caller-level stop afterwards must stay safe (idempotent, no hang).
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

/** Spawn a child that exits immediately and return its confirmed-dead pid. */
function confirmedDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5_000 });
    const pid = child.pid;
    if (pid === undefined) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return pid;
    }
  }
  throw new Error("could not obtain a confirmed-dead pid");
}

test("reclaimStaleJournalLock removes only a lock owned by a confirmed-dead pid", async () => {
  assert.equal(daemonChild.STALE_JOURNAL_LOCK_EXIT_CODE, 3, "mirrors the CLI's stale-lock exit code");
  const dir = await trackDir();
  const lockPath = join(dir, "coaching-journal.json.lock");

  // Dead owner (an exited child, like a SIGKILLed daemon): reclaimed.
  const deadPid = confirmedDeadPid();
  await writeFile(lockPath, `${JSON.stringify({ pid: deadPid, token: "dead-owner" })}\n`);
  assert.equal(daemonChild.reclaimStaleJournalLock(dir), deadPid, "a dead owner's lock is reclaimed");
  assert.equal(existsSync(lockPath), false, "the stale lock file is gone");

  // Live owner (this test process): left strictly alone.
  const liveLock = `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`;
  await writeFile(lockPath, liveLock);
  assert.equal(daemonChild.reclaimStaleJournalLock(dir), false, "a live owner's lock is not reclaimed");
  assert.equal(existsSync(lockPath), true, "the live lock file is untouched");
  assert.equal(await readFile(lockPath, "utf8"), liveLock, "the live lock file content is untouched");

  // No lock file at all: nothing to do.
  await rm(lockPath);
  assert.equal(daemonChild.reclaimStaleJournalLock(dir), false);
});

test("spawnDaemon forwards --extension only when a path is supplied", async () => {
  // A stand-in for the CLI that behaves like `daemon` far enough for the URL
  // promise to settle, and echoes the argv it actually received. The real CLI
  // cannot be used here: it would probe for pi and boot a listener, and the
  // assertion is about the flag, not about the daemon.
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-argv-"));
  const argvLog = join(dir, "argv.json");
  const fakeCli = join(dir, "fake-cli.mjs");
  await writeFile(
    fakeCli,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
      'console.log("fit-trace daemon listening at http://127.0.0.1:9");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  try {
    // With an extension: the flag and its value are adjacent, in that order.
    const withExtension = daemonChild.spawnDaemon({
      nodePath: process.execPath,
      cliPath: fakeCli,
      extensionPath: "/app/Contents/Resources/pi-extension.mjs",
      port: 0,
      env: childEnv(),
    });
    await withExtension.url;
    await daemonChild.stopDaemonChild(withExtension.child);
    const forwarded = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    const index = forwarded.indexOf("--extension");
    assert.notEqual(index, -1, "--extension must be forwarded");
    assert.equal(forwarded[index + 1], "/app/Contents/Resources/pi-extension.mjs");

    // Without one (dev): the flag is absent, so the daemon keeps its own
    // repo-relative default.
    const withoutExtension = daemonChild.spawnDaemon({
      nodePath: process.execPath,
      cliPath: fakeCli,
      port: 0,
      env: childEnv(),
    });
    await withoutExtension.url;
    await daemonChild.stopDaemonChild(withoutExtension.child);
    const plain = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.equal(plain.includes("--extension"), false, "dev must not pass an explicit extension");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desktop child fails on an occupied saved port without connecting to the occupant", async () => {
  let requests = 0;
  const occupant = createServer((_request, response) => { requests += 1; response.end("occupant"); });
  await new Promise<void>((resolve) => occupant.listen(0, "127.0.0.1", resolve));
  const address = occupant.address();
  assert.ok(address && typeof address !== "string");
  const dataDir = await trackDir();
  const { child, url } = daemonChild.spawnDaemon({ nodePath: process.execPath, cliPath: CLI_PATH, dataDir, port: address.port, env: childEnv() });
  try { await assert.rejects(url); assert.equal(requests, 0); }
  finally { await daemonChild.stopDaemonChild(child); await new Promise<void>((resolve, reject) => occupant.close((error) => error ? reject(error) : resolve())); }
});

test("desktop daemon restarts on the same saved port", async () => {
  const dataDir = await trackDir();
  const first = daemonChild.spawnDaemon({ nodePath: process.execPath, cliPath: CLI_PATH, dataDir, port: 0, env: childEnv() });
  const origin = await first.url;
  await daemonChild.stopDaemonChild(first.child);
  const second = daemonChild.spawnDaemon({ nodePath: process.execPath, cliPath: CLI_PATH, dataDir, port: Number(new URL(origin).port), env: childEnv() });
  try { assert.equal(await second.url, origin); assert.equal(await daemonChild.healthCheck(origin), true); }
  finally { await daemonChild.stopDaemonChild(second.child); }
});

test("spawnDaemon waits for a complete listening line when the port is split across chunks", async () => {
  const dir = await trackDir();
  const fakeCli = join(dir, "split-port.cjs");
  await writeFile(fakeCli, "process.stdout.write('fit-trace daemon listening at http://127.0.0.1:42'); setTimeout(() => process.stdout.write('123\\n'), 100); setInterval(() => {}, 1000);\n");
  for (const port of [0, 42123]) {
    const { child, url } = daemonChild.spawnDaemon({ nodePath: process.execPath, cliPath: fakeCli, port, env: childEnv(), urlTimeoutMs: 2000 });
    try { assert.equal(await url, "http://127.0.0.1:42123"); }
    finally { await daemonChild.stopDaemonChild(child); }
  }
});

test("spawnDaemon rejects an unterminated listening announcement", async () => {
  const dir = await trackDir();
  const fakeCli = join(dir, "incomplete-listen.cjs");
  await writeFile(fakeCli, "process.stdout.write('fit-trace daemon listening at http://127.0.0.1:42'); setInterval(() => {}, 1000);\n");
  const { child, url } = daemonChild.spawnDaemon({ nodePath: process.execPath, cliPath: fakeCli, port: 0, env: childEnv(), urlTimeoutMs: 300 });
  try { await assert.rejects(url, /did not report a listen URL/); }
  finally { await daemonChild.stopDaemonChild(child); }
});
