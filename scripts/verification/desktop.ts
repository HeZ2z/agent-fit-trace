/**
 * Packaged-desktop plumbing for `scripts/verify-desktop.ts`.
 *
 * This is the layer above `verify:app`: instead of spawning a daemon and
 * Chrome, the harness launches the real packaged `.app`, connects to its
 * renderer over the Chromium DevTools protocol, logs a workout through the UI,
 * quits, and reopens the same data directory.
 *
 * Everything that can be unit-tested without launching Electron is a pure
 * function here (bundle resolution, tree digesting, DevTools line parsing, page
 * target selection, process-table walking, launch env/argv). The remaining
 * functions own real I/O (fs, ps, TCP, CDP) and are used only by the harness.
 *
 * Keep this file erasable TypeScript (no enum / parameter properties): the
 * repository typechecks and runs it with Node's type stripping.
 */

import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CdpClient } from "./cdp.ts";

// ---------------------------------------------------------------------------
// Scenario constants (shared by the harness and its tests)
// ---------------------------------------------------------------------------

/** The canonical exercise the desktop scenario logs. */
export const DESKTOP_EXERCISE = "Barbell Bench Press - Medium Grip" as const;

/** The one workout the desktop scenario logs through the UI. */
export const DESKTOP_WORKOUT = {
  exercise: DESKTOP_EXERCISE,
  weight: 80,
  reps: 5,
  rpe: 7,
  durationMinutes: 45,
} as const;

/** Deterministic analysis the daemon must compute from that one record. */
export const DESKTOP_SCENARIO_EXPECTED = {
  sessions: 1,
  totalSets: 1,
  totalReps: DESKTOP_WORKOUT.reps,
  volumeKg: DESKTOP_WORKOUT.weight * DESKTOP_WORKOUT.reps,
  avgRpe: DESKTOP_WORKOUT.rpe,
  sourceRecords: 1,
} as const;

/** Stable step ids, recorded in the manifest. */
export const DESKTOP_STEP_IDS = {
  launch: "desktop-launch",
  guestConfig: "desktop-guest-config",
  log: "desktop-log",
  reload: "desktop-reload",
  quit: "desktop-quit",
  reopen: "desktop-reopen",
  persisted: "desktop-persisted",
  analysis: "desktop-analysis",
  cleanup: "desktop-cleanup",
} as const;

/** Screenshot/log names the desktop run produces. */
export const DESKTOP_EVIDENCE = {
  empty: "01-desktop-empty.png",
  log: "02-desktop-log.png",
  summary: "03-desktop-summary.png",
  reload: "04-desktop-reload.png",
  reopened: "05-desktop-reopened.png",
  analysis: "06-desktop-analysis.png",
  failure: "failure.png",
  appLog: "app.log",
} as const;

/** Both evidence sets a passing desktop run must leave behind. */
export const DESKTOP_REQUIRED_EVIDENCE: readonly string[] = [
  DESKTOP_EVIDENCE.empty,
  DESKTOP_EVIDENCE.log,
  DESKTOP_EVIDENCE.summary,
  DESKTOP_EVIDENCE.reload,
  DESKTOP_EVIDENCE.reopened,
  DESKTOP_EVIDENCE.analysis,
  DESKTOP_EVIDENCE.appLog,
];

/** Release-channel output directory for the host architecture. */
export function defaultDesktopAppPath(
  repoRoot: string,
  arch: string,
  exists: (candidate: string) => boolean,
): string {
  const release = path.join(repoRoot, "packages", "fit-trace-desktop", "release");
  // electron-builder names the unpacked mac directory `mac-arm64` for arm64 and
  // `mac` otherwise. Check the arch-specific spelling first, then the generic
  // one, so an x64/universal layout is still found.
  const candidates = [
    path.join(release, `mac-${arch}`, "fit-trace.app"),
    path.join(release, "mac", "fit-trace.app"),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface DesktopCliOptions {
  help: boolean;
  /** Explicit `--app` path, or null to use the default release location. */
  app: string | null;
  headed: boolean;
  evidence: string | null;
  keepData: boolean;
  timeoutMs: number;
}

/**
 * Parse the desktop harness argv. Throws on anything invalid so the harness can
 * print usage and exit 2 without spawning a process.
 */
export function parseDesktopCliOptions(argv: readonly string[]): DesktopCliOptions {
  let help = false;
  let app: string | null = null;
  let headed = false;
  let evidence: string | null = null;
  let keepData = false;
  let timeoutMs = 30_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--headed":
        headed = true;
        break;
      case "--keep-data":
        keepData = true;
        break;
      case "--app": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--app requires a path");
        }
        app = value;
        index += 1;
        break;
      }
      case "--evidence": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--evidence requires a path");
        }
        evidence = value;
        index += 1;
        break;
      }
      case "--timeout": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--timeout requires milliseconds");
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
          throw new Error(`--timeout must be an integer >= 1000 (got ${value})`);
        }
        timeoutMs = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help, app, headed, evidence, keepData, timeoutMs };
}

// ---------------------------------------------------------------------------
// Launch environment and argv
// ---------------------------------------------------------------------------

/**
 * Environment overrides a packaged launch must not inherit.
 *
 * Guest mode is the biggest silent-failure risk (an inherited Supabase
 * configuration flips `/api/v1/public-config` to the release shape), and
 * `ELECTRON_RUN_AS_NODE` would make the shell behave as Node and never open a
 * window.
 */
const DROPPED_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "FIT_TRACE_API_BASE_URL",
  "FIT_TRACE_CLOUD_API_BASE_URL",
  "FIT_TRACE_DATA_DIR",
  "ELECTRON_RUN_AS_NODE",
] as const;

/** Prefixes removed wholesale (sync/cloud configuration). */
const DROPPED_ENV_PREFIXES = ["FIT_TRACE_SYNC_"] as const;

/**
 * Build the packaged app's launch environment: a private HOME and data
 * directory, no inherited auth/sync/cloud configuration, Node color noise off.
 */
export function desktopLaunchEnvironment(
  baseEnv: Readonly<Record<string, string | undefined>>,
  options: { home: string; dataDir: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, HOME: options.home, NO_COLOR: "1" };
  for (const key of DROPPED_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (DROPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  env.FIT_TRACE_DATA_DIR = options.dataDir;
  return env;
}

/** Chromium switches the harness passes to the packaged app. */
export function desktopLaunchArgs(options: {
  userDataDir: string;
  headed: boolean;
}): string[] {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    ...(options.headed ? [] : ["--headless=new"]),
  ];
}

// ---------------------------------------------------------------------------
// Bundle resolution and metadata
// ---------------------------------------------------------------------------

export interface DesktopAppInfo {
  /** Absolute path to the `.app` bundle. */
  appPath: string;
  /** Absolute path to `Contents/MacOS/<CFBundleExecutable>`. */
  executable: string;
  version: string | null;
  bundleId: string | null;
}

/** Injectable filesystem/plist access, so bundle resolution is unit-testable. */
export interface DesktopAppDeps {
  exists: (candidate: string) => boolean;
  isDirectory: (candidate: string) => boolean;
  readDirectory: (candidate: string) => string[];
  readPlistValue: (plistPath: string, key: string) => string | null;
}

/** Read one raw key from an Info.plist via `plutil`; null when unavailable. */
export function readPlistValue(plistPath: string, key: string): string | null {
  try {
    const value = execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Filesystem-backed deps for {@link resolveDesktopApp}. */
export function defaultDesktopAppDeps(): DesktopAppDeps {
  return {
    exists: (candidate) => existsSync(candidate),
    isDirectory: (candidate) => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    },
    readDirectory: (candidate) => readdirSync(candidate),
    readPlistValue,
  };
}

/**
 * Resolve a `.app` bundle to its executable and identity.
 *
 * The executable comes from `CFBundleExecutable` when the declared file exists;
 * otherwise the conventional `fit-trace` name and a single-entry `MacOS`
 * directory are tried. Metadata is best-effort: a missing/unreadable plist
 * yields nulls rather than failing the run.
 */
export function resolveDesktopApp(
  appPath: string,
  deps: DesktopAppDeps,
): DesktopAppInfo | null {
  const resolved = path.resolve(appPath);
  if (!deps.exists(resolved) || !deps.isDirectory(resolved)) return null;
  const contents = path.join(resolved, "Contents");
  const macos = path.join(contents, "MacOS");
  if (!deps.exists(macos) || !deps.isDirectory(macos)) return null;

  const plist = path.join(contents, "Info.plist");
  const declared = deps.readPlistValue(plist, "CFBundleExecutable");
  const candidates: string[] = [];
  if (declared !== null && declared !== "" && !declared.includes("/")) {
    candidates.push(declared);
  }
  candidates.push("fit-trace");
  let entries: string[] = [];
  try {
    entries = deps.readDirectory(macos);
  } catch {
    entries = [];
  }
  if (entries.length === 1) candidates.push(entries[0]);

  const executableName = candidates.find((name) => deps.exists(path.join(macos, name)));
  if (executableName === undefined) return null;

  return {
    appPath: resolved,
    executable: path.join(macos, executableName),
    version: deps.readPlistValue(plist, "CFBundleShortVersionString"),
    bundleId: deps.readPlistValue(plist, "CFBundleIdentifier"),
  };
}

// ---------------------------------------------------------------------------
// Deterministic tree digest
// ---------------------------------------------------------------------------

/** One hashed entry in a `.app` tree. */
export type AppTreeEntry =
  | { path: string; kind: "file"; bytes: Uint8Array }
  | { path: string; kind: "symlink"; target: string };

export interface AppTreeDigest {
  sha256: string;
  /** Regular files hashed. */
  fileCount: number;
  /** Total bytes of regular files. */
  bytes: number;
}

/**
 * Deterministic sha256 over a `.app` tree.
 *
 * Entries are sorted by their POSIX relative path (ordinal) so directory
 * listing order never changes the digest. Each entry contributes
 * `path \0 file \0 <byteLength> \0 <bytes> \0` or
 * `path \0 link \0 link:<target> \0`; symlink targets are hashed as text and
 * never followed, which keeps framework bundles stable and cycle-free.
 */
export function computeAppTreeDigest(entries: readonly AppTreeEntry[]): AppTreeDigest {
  // Imported lazily at module scope would be fine too, but keeping the hash
  // helper local mirrors the existing artifact digest in `helpers.ts`.
  const hash = createHash("sha256");
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  let previous: string | null = null;
  let fileCount = 0;
  let bytes = 0;
  for (const entry of sorted) {
    if (entry.path === previous) throw new Error(`duplicate tree path: ${entry.path}`);
    previous = entry.path;
    hash.update(entry.path, "utf8");
    hash.update("\0");
    if (entry.kind === "file") {
      fileCount += 1;
      bytes += entry.bytes.byteLength;
      hash.update("file\0", "utf8");
      hash.update(String(entry.bytes.byteLength), "utf8");
      hash.update("\0");
      hash.update(entry.bytes);
    } else {
      hash.update("link\0", "utf8");
      hash.update(`link:${entry.target}`, "utf8");
    }
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount, bytes };
}

/** Walk a `.app` tree without following symlinks. */
export async function readAppTreeEntries(root: string): Promise<AppTreeEntry[]> {
  const entries: AppTreeEntry[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (child.isSymbolicLink()) {
        entries.push({ path: relative, kind: "symlink", target: await readlink(absolute) });
        continue;
      }
      if (child.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (child.isFile()) {
        entries.push({ path: relative, kind: "file", bytes: await readFile(absolute) });
      }
    }
  }
  await walk(root, "");
  return entries;
}

// ---------------------------------------------------------------------------
// DevTools endpoint discovery
// ---------------------------------------------------------------------------

export interface DevToolsEndpoint {
  port: number;
  browserWebSocketUrl: string;
}

/** Parse `<userDataDir>/DevToolsActivePort` (`PORT\n/devtools/browser/<id>`). */
export function parseDevToolsActivePort(content: string): DevToolsEndpoint | null {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return null;
  const port = Number(lines[0].trim());
  const browserPath = lines[1].trim();
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !browserPath.startsWith("/devtools/")
  ) {
    return null;
  }
  return { port, browserWebSocketUrl: `ws://127.0.0.1:${port}${browserPath}` };
}

/** Parse Chromium's stderr fallback: `DevTools listening on ws://127.0.0.1:<port>/...`. */
export function parseDevToolsListeningLine(text: string): DevToolsEndpoint | null {
  const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/.exec(text);
  if (match === null) return null;
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  return { port, browserWebSocketUrl: match[1] };
}

function tail(text: string, lines = 20): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .slice(-lines)
    .join("\n");
}

export interface DevToolsDiscoveryOptions {
  userDataDir: string;
  timeoutMs: number;
  pollMs?: number;
  /** The app process has exited (a read timeout means it never started). */
  isExited: () => boolean;
  /** Accumulated app stderr/stdout, for the listening-line fallback. */
  logs: () => string;
}

/**
 * Wait for the app's DevTools endpoint.
 *
 * Primary source is the profile's `DevToolsActivePort`; the stderr
 * "DevTools listening on …" line is only a fallback because it appears before
 * the port file is guaranteed flushable.
 */
export async function discoverDevToolsEndpoint(
  options: DevToolsDiscoveryOptions,
): Promise<DevToolsEndpoint> {
  const portFile = path.join(options.userDataDir, "DevToolsActivePort");
  const pollMs = options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : 100;
  const deadline = Date.now() + options.timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (options.isExited()) {
      throw new Error(
        `desktop app exited before publishing DevToolsActivePort.\n${tail(options.logs())}`,
      );
    }
    try {
      const parsed = parseDevToolsActivePort(await readFile(portFile, "utf8"));
      if (parsed !== null) return parsed;
      lastError = `unexpected DevToolsActivePort content at ${portFile}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const fromLog = parseDevToolsListeningLine(options.logs());
    if (fromLog !== null) return fromLog;
    await delay(pollMs);
  }
  throw new Error(
    `desktop app did not publish a DevTools endpoint within ${options.timeoutMs}ms ` +
      `(${lastError}).\n${tail(options.logs())}`,
  );
}

// ---------------------------------------------------------------------------
// Page target selection
// ---------------------------------------------------------------------------

/** The subset of `Target.getTargets` needed to pick the app page. */
export interface TargetDescriptor {
  targetId: string;
  type: string;
  url: string;
  title?: string;
}

/** True for the daemon's loopback origin, false for data:/devtools:/chrome://. */
export function isLoopbackAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port !== "" &&
      parsed.port !== "0"
    );
  } catch {
    return false;
  }
}

/** Loopback port of a daemon URL (`http://127.0.0.1:5199/` → 5199). */
export function portFromLoopbackUrl(url: string): number | null {
  if (!isLoopbackAppUrl(url)) return null;
  const port = Number(new URL(url).port);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/**
 * Pick the app's page target.
 *
 * A failed daemon shows a `data:text/html` retry page and DevTools itself may
 * expose `devtools://` targets; both must be ignored, otherwise the harness
 * would attach to the wrong document and every UI assertion would fail with a
 * confusing message.
 */
export function selectDesktopPageTarget(
  targets: readonly TargetDescriptor[],
): TargetDescriptor | null {
  return (
    targets.find((target) => target.type === "page" && isLoopbackAppUrl(target.url)) ?? null
  );
}

export interface DesktopPage {
  target: TargetDescriptor;
  baseUrl: string;
  port: number;
}

/** Poll `Target.getTargets` until the daemon-served page exists. */
export async function waitForDesktopPageTarget(
  client: CdpClient,
  options: { timeoutMs: number; pollMs?: number },
): Promise<DesktopPage> {
  const pollMs = options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : 100;
  const deadline = Date.now() + options.timeoutMs;
  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    const response = await client.send<{ targetInfos?: TargetDescriptor[] }>(
      "Target.getTargets",
    );
    const targets = response.targetInfos ?? [];
    lastSeen = targets.map((target) => `${target.type}:${target.url}`);
    const target = selectDesktopPageTarget(targets);
    if (target !== null) {
      const port = portFromLoopbackUrl(target.url);
      if (port === null) throw new Error(`page target has no loopback port: ${target.url}`);
      return { target, baseUrl: new URL(target.url).origin, port };
    }
    await delay(pollMs);
  }
  throw new Error(
    `no daemon page target within ${options.timeoutMs}ms; saw [${lastSeen.join(", ")}]`,
  );
}

/** Attach to the page target (flattened) and enable Page/Runtime. */
export async function attachDesktopPage(
  client: CdpClient,
  targetId: string,
): Promise<string> {
  const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const { sessionId } = attached;
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  return sessionId;
}

// ---------------------------------------------------------------------------
// Process table, port release, quit confirmation
// ---------------------------------------------------------------------------

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,command=` output. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/** Live process table via `ps` (macOS/Linux). */
export function readProcessTable(): ProcessRow[] {
  try {
    return parseProcessTable(
      execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return [];
  }
}

/**
 * The daemon descendant of the app process.
 *
 * The packaged shell runs `<app>/Contents/MacOS/fit-trace <resources>/daemon.mjs
 * daemon …` with `ELECTRON_RUN_AS_NODE=1`, so the command line is the only
 * stable marker. Returns null when the daemon has not started or already gone.
 */
export function findDaemonDescendant(
  rows: readonly ProcessRow[],
  rootPid: number,
): number | null {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const existing = children.get(row.ppid);
    if (existing === undefined) children.set(row.ppid, [row]);
    else existing.push(row);
  }
  const queue: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) break;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (child.command.includes("daemon.mjs")) return child.pid;
      queue.push(child.pid);
    }
  }
  return null;
}

/** True while `process.kill(pid, 0)` reports a live (or unconfirmable) process. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Best-effort asynchronous SIGTERM/SIGKILL for a recorded pid. */
export async function stopRecordedPid(
  pid: number,
  options: { graceMs: number; pollMs?: number },
): Promise<boolean> {
  if (!processAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  const pollMs = options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : 100;
  const deadline = Date.now() + options.graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await delay(pollMs);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true;
  }
  return !processAlive(pid);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Poll a child handle until the OS has reaped it (exitCode/signalCode set). */
export async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited(child)) return true;
    await delay(pollMs);
  }
  return hasExited(child);
}

export interface AppStopResult {
  stopped: boolean;
  exitConfirmed: boolean;
  /** The strongest signal the stop needed. */
  escalated: "none" | "sigterm" | "sigkill";
}

/**
 * Stop the packaged app: SIGTERM, wait, then SIGKILL as a last resort.
 *
 * `Browser.close` (or a graceful quit) is attempted by the caller first; this
 * is the fallback contract that guarantees the harness does not leave the app
 * (and therefore an orphan daemon) running.
 */
export async function stopAppConfirmed(
  child: ChildProcess | null,
  options: { graceMs: number; pollMs?: number },
): Promise<AppStopResult> {
  if (child === null || child.pid === undefined) {
    return { stopped: true, exitConfirmed: true, escalated: "none" };
  }
  if (hasExited(child)) return { stopped: true, exitConfirmed: true, escalated: "none" };
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  if (await waitForProcessExit(child, options.graceMs, options.pollMs ?? 50)) {
    return { stopped: true, exitConfirmed: true, escalated: "sigterm" };
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  return {
    stopped: true,
    exitConfirmed: await waitForProcessExit(child, 2_000, options.pollMs ?? 50),
    escalated: "sigkill",
  };
}

/** Ask the browser to quit; a socket close is the expected success signal. */
export async function closeBrowserTolerantly(
  client: CdpClient,
  timeoutMs: number,
): Promise<void> {
  try {
    await client.send("Browser.close", {}, undefined, { timeoutMs });
  } catch {
    // The app drops the socket while quitting; that is success, not failure.
  }
}

/** True iff a TCP connection to the loopback port is accepted. */
export function isPortAcceptingConnections(
  port: number,
  options: { host?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const host = options.host ?? "127.0.0.1";
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(options.timeoutMs ?? 500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Poll until the port refuses connections; returns whether that happened. */
export async function waitForPortRelease(
  port: number,
  options: { timeoutMs: number; pollMs?: number },
): Promise<boolean> {
  const pollMs = options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : 100;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortAcceptingConnections(port))) return true;
    await delay(pollMs);
  }
  return !(await isPortAcceptingConnections(port));
}
