#!/usr/bin/env node
/**
 * `agent-fit-trace` source-run launcher entry.
 *
 * Usage:
 *   node packages/fit-trace-cli/src/cli.ts start [--port N] [--no-open]
 *     [--upstream https://<app>/api/v1] [--dist <path>]
 *
 * Packaged `npx` distribution is not published; this file is the CLI start
 * interface run from source via `pnpm start` / `pnpm coach:local`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { executableIdentity, resolveExecutable } from "../../../server/coaching/executableResolution.ts";
import { toolchainPath } from "../../../server/coaching/toolchainPaths.ts";
import { buildCoachedEnv } from "../../../server/coaching/piProcessAdapter.ts";
import { BIND_HOST, checkNodeRuntime, checkPiCli, isSafeOpenUrl, resolveLauncherConfig } from "./config.ts";
import type { CoachingRuntimeId } from "@agent-fit-trace/api-contracts";
import { isCoachingRuntimeId, resolveCoachingBackendSelection } from "@agent-fit-trace/api-contracts";
import type { LauncherFlags } from "./config.ts";
import { startLauncherServer } from "./launcherServer.ts";
import { startDaemonServer } from "./daemonServer.ts";
import {
  STALE_JOURNAL_LOCK_EXIT_CODE,
  StaleJournalLockError,
} from "../../../server/coaching/coachingJournal.ts";
import { resolveDataDir } from "@agent-fit-trace/store";

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  agent-fit-trace start [--port N] [--no-open] [--upstream URL] [--dist PATH] [--runtime ID]",
      "  agent-fit-trace daemon [--port N] [--data PATH] [--dist PATH] [--runtime ID]",
      "",
      "start (fixed upstream composite):",
      "  --port N       preferred loopback port (default 5198, falls forward when busy)",
      "  --no-open      do not try to open a browser (for tests/headless)",
      "  --upstream URL fixed authenticated API base (default $FIT_TRACE_API_BASE_URL)",
      "  --dist PATH    built app directory (default <repo>/app/dist)",
      "  --runtime ID   local coaching runtime: pi (default), codex, or opencode",
      "",
      "daemon (standalone local data plane):",
      "  --port N       preferred loopback port (default 5199, falls forward when busy)",
      "  --data PATH    data directory (default $FIT_TRACE_DATA_DIR or ~/.fit-trace/data)",
      "  --dist PATH    built app shell directory (default <repo>/app/dist; the shell is",
      "                 served only when a build exists — headless data plane works without)",
      "  --runtime ID   DEFAULT local coaching backend for new runs: pi (default),",
      "                 codex, or opencode. It does NOT filter discovery: every",
      "                 installed CLI is still reported.",
      "  --extension PATH",
      "                 pi extension coached runs load (default <repo>/.pi/extensions/fit-trace).",
      "                 Packaged builds must set it; a missing file reports local coaching",
      "                 unavailable instead of advertising a coach that cannot start)",
    ].join("\n"),
  );
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): { command: string; flags: LauncherFlags } {
  const flags: LauncherFlags = {};
  let command = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--port") {
      flags.port = Number(takeValue(argv, index + 1, "--port"));
      index += 1;
    } else if (token === "--strict-port") {
      flags.strictPort = true;
    } else if (token === "--no-open") {
      flags.noOpen = true;
    } else if (token === "--upstream") {
      flags.upstream = takeValue(argv, index + 1, "--upstream");
      index += 1;
    } else if (token === "--dist") {
      flags.dist = takeValue(argv, index + 1, "--dist");
      index += 1;
    } else if (token === "--data") {
      flags.data = takeValue(argv, index + 1, "--data");
      index += 1;
    } else if (token === "--runtime") {
      flags.runtime = takeValue(argv, index + 1, "--runtime");
      index += 1;
    } else if (token === "--extension") {
      flags.extension = takeValue(argv, index + 1, "--extension");
      index += 1;
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    } else if (!token.startsWith("--") && command === "") {
      command = token;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return { command, flags };
}

/** Open only exact loopback URLs in a browser (argv array, no shell). */
function tryOpenBrowser(url: string): void {
  if (!isSafeOpenUrl(url)) {
    console.log(`Open this address manually: ${url}`);
    return;
  }
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "darwin" ? [url] : platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.log(`Open this address manually: ${url}`);
    });
    child.unref();
  } catch {
    console.log(`Open this address manually: ${url}`);
  }
}

/**
 * Parse `--runtime` for the daemon: only LOCAL runtimes are selectable.
 *
 * Mirrors the launcher's validation vocabulary so both commands reject the same
 * way, and deliberately refuses a cloud runtime: the daemon has no cloud
 * execution path (#69 adds that), so accepting `hosted-sdk` here would promise a
 * default it cannot run.
 */
function parseDaemonRuntime(raw: string): CoachingRuntimeId {
  if (!isCoachingRuntimeId(raw)) {
    throw new Error(`invalid coaching runtime: ${raw} (expected pi, codex, or opencode)`);
  }
  const selection = resolveCoachingBackendSelection({ runtimeId: raw });
  if (selection.executionLocation !== "local") {
    throw new Error(`the daemon cannot run the ${raw} cloud runtime`);
  }
  return raw;
}

/** `agent-fit-trace daemon`: resident local data plane (no browser open). */
async function runDaemon(flags: LauncherFlags): Promise<void> {
  checkNodeRuntime();
  const dataDir = flags.data ?? resolveDataDir(process.env);

  /**
   * Install the shutdown handlers BEFORE binding, not after.
   *
   * `startDaemonServer` acquires the coaching-journal process lock and binds a
   * listener. From the moment the lock exists until the handlers are installed
   * there is a window in which SIGTERM has no handler: the default action kills
   * the process immediately, `close()` never runs, and the lock file is left
   * behind. The next daemon then refuses to start with the fail-closed stale
   * lock error (exit code 3) — a supervisor restart loop caused by a signal
   * that arrived microseconds early.
   *
   * So the handlers are registered first and hold the server once it exists.
   * A signal that arrives during startup waits for `server` to settle and then
   * performs the same orderly close; nothing is skipped.
   */
  let server: Awaited<ReturnType<typeof startDaemonServer>> | null = null;
  let shuttingDown = false;
  let shutdownRequested = false;
  const shutdown = (signal: string): void => {
    void signal;
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    if (server === null) {
      // Startup still in flight: finish it, then close. Guarded by
      // `shutdownRequested` so the await below performs the close exactly once.
      shutdownRequested = true;
      return;
    }
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // `--runtime` names the DEFAULT backend for a new run; it never filters what
  // discovery reports (see `DaemonServerOptions.defaultRuntime`). Validated here
  // so a typo fails fast with a clear message instead of silently defaulting to
  // pi; `hosted-sdk`/cloud is refused because the daemon serves local coaching.
  const defaultRuntime =
    flags.runtime === undefined ? undefined : parseDaemonRuntime(flags.runtime);
  const started = await startDaemonServer({
    ...(flags.port !== undefined ? { port: flags.port } : {}),
    ...(flags.strictPort ? { strictPort: true } : {}),
    ...(defaultRuntime !== undefined ? { defaultRuntime } : {}),
    dataDir,
    ...(flags.dist !== undefined ? { distDir: flags.dist } : {}),
    ...(flags.extension !== undefined ? { extensionPath: resolve(flags.extension) } : {}),
  });
  server = started;
  console.log(`fit-trace daemon listening at ${server.url}`);
  console.log(`data directory: ${server.dataDir}`);
  console.log(`default coaching backend: ${server.defaultBackendId ?? "none (probe pending or unavailable)"}`);

  // A signal arrived while startup was in flight and deliberately did not
  // interrupt it (interrupting would have orphaned the journal lock). The
  // listener is up now, so honour it with the same orderly close.
  if (shutdownRequested) {
    await server.close();
    process.exit(0);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "daemon") {
    await runDaemon(flags);
    return;
  }
  if (command !== "start") {
    printUsage();
    process.exit(command === "" ? 0 : 2);
  }

  checkNodeRuntime();
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..", "..");
  const config = resolveLauncherConfig(process.env, flags, repoRoot);

  const piEnv = { ...process.env };
  piEnv.PATH = toolchainPath({ platform: process.platform, home: homedir(), env: piEnv });
  const piExecutable = resolveExecutable("pi", { pathEnv: piEnv.PATH, pathExtEnv: piEnv.PATHEXT }) ?? undefined;
  const piIdentity = piExecutable === undefined ? undefined : executableIdentity(piExecutable);
  if (piExecutable !== undefined) piEnv.PATH = [dirname(piExecutable), piEnv.PATH].join(delimiter);
  const pi = piExecutable === undefined || piIdentity === undefined
    ? { available: false, version: null }
    : await checkPiCli(5000, piExecutable, buildCoachedEnv(piEnv, ""));
  const piValid = piExecutable !== undefined && piIdentity !== undefined && executableIdentity(piExecutable) === piIdentity;
  if (pi.available && piValid) {
    console.log(`pi CLI detected${pi.version === null ? "" : `: ${pi.version}`}`);
  } else {
    console.log(
      "pi CLI not found on PATH — workout tracking works; coaching runs report unconfigured until pi is installed.",
    );
  }
  if (config.runtimeId !== "pi") {
    console.log(
      `configured runtime ${config.runtimeId} is experimental and fail-closed: this build wires no production tool-isolation verifier for it, so discovery reports it unavailable (legacy pi requests still map to local-pi).`,
    );
  }

  const server = await startLauncherServer({
    distDir: config.distDir,
    upstreamBaseUrl: config.upstreamBaseUrl,
    host: BIND_HOST,
    port: config.port,
    piAvailable: pi.available && piValid,
    ...(piExecutable !== undefined && piIdentity !== undefined ? {
      piExecutable, piEnv, piVersion: pi.version ?? undefined,
      validatePiExecutable: () => executableIdentity(piExecutable) === piIdentity,
    } : {}),
    runtimeId: config.runtimeId,
  });
  console.log(`fit-trace coach listening at ${server.url}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    void signal;
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const interactive = Boolean(process.stdout.isTTY);
  if (!config.noOpen && interactive) {
    tryOpenBrowser(server.url);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Distinct exit code so a supervisor that owns this process tree (the
  // desktop shell) can recognize a stale journal lock, reclaim the lock
  // file, and retry — every other failure keeps the generic exit code.
  if (error instanceof StaleJournalLockError) {
    process.exit(STALE_JOURNAL_LOCK_EXIT_CODE);
  }
  process.exit(2);
}
