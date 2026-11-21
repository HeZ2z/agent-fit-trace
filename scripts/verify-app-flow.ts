#!/usr/bin/env node
/**
 * Real-app acceptance harness: start the daemon + system Chrome, walk the user
 * flow through the actual UI over raw CDP, and keep evidence.
 *
 * Usage:
 *   node scripts/verify-app-flow.ts [--headed] [--evidence <dir>] [--keep-data]
 *                                  [--chrome <path>] [--timeout <ms>]
 *
 * Exit codes:
 *   0 = every step passed and cleanup was confirmed
 *   1 = a step/assertion failed, cleanup was unconfirmed, or required evidence
 *       could not be written (failure.png + logs + manifest kept as evidence)
 *   2 = app/dist is missing (run `pnpm build` first)
 *   3 = no Chrome found (skipped, not a pass)
 *
 * The harness only stops processes it started and never selects a process by
 * port. It reuses the desktop shell's daemon plumbing (spawn/listen-line/stop)
 * via `scripts/verification/daemon.ts`, and adds a confirmation layer because
 * the shared stop resolves on kill errors without proving the exit.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { launchChrome, findChrome } from "./verification/chrome.ts";
import type { LaunchedChrome } from "./verification/chrome.ts";
import {
  CdpClient,
  captureScreenshot,
  createPageTarget,
  dispatchClick,
  evaluate,
  navigate,
  prepareClick,
  reload,
  setFieldValue,
  waitFor,
} from "./verification/cdp.ts";
import {
  daemonHealthCheck,
  spawnVerificationDaemon,
  stopConfirmed,
} from "./verification/daemon.ts";
import type { ConfirmedStop, SpawnedDaemon } from "./verification/daemon.ts";
import {
  ANALYSIS_METRICS,
  COMBOBOX_SELECTOR,
  DATE_FIELD_SELECTOR,
  DURATION_FIELD_SELECTOR,
  SOURCE_COUNT_SELECTOR,
  SUBMIT_BUTTON_SELECTOR,
  assertionId,
  buildManifest,
  computeArtifactDigest,
  defaultEvidenceDir,
  evaluateCleanup,
  evidenceEntry,
  exerciseFieldSelector,
  exerciseOptionSelector,
  exitCodeForOutcome,
  historyRowDate,
  isGuestPublicConfig,
  parseInteger,
  parseMetricNumber,
  recordIdFromHref,
  recordIdFromPathname,
  sha256Hex,
  summarizeGitStatus,
} from "./verification/helpers.ts";
import type {
  AnalysisMetric,
  ArtifactFile,
  EvidenceEntry,
  ManifestAssertion,
  ManifestCleanup,
  ManifestInput,
  ManifestStep,
  ProcessCleanup,
  Provenance,
  VerificationOutcome,
} from "./verification/helpers.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_CLI = path.join(REPO_ROOT, "packages", "fit-trace-cli", "src", "cli.ts");
const APP_DIST = path.join(REPO_ROOT, "app", "dist");
const GUEST_BEARER = "fit-trace-local-daemon";
const CHROME_WIDTH = 1440;
const CHROME_HEIGHT = 1000;
const DAEMON_TIMEOUT_MS = 20_000;
/** Must exceed the desktop shell's SIGTERM → SIGKILL grace (3s). */
const STOP_CONFIRM_GRACE_MS = 10_000;

/** The canonical catalog name selected from the combobox suggestion list. */
const BENCH_PRESS = "Barbell Bench Press - Medium Grip";

/**
 * Files a passing run must leave behind. A failed write makes the run fail;
 * a failed run only still owes its daemon log.
 */
const REQUIRED_EVIDENCE = [
  "01-history-empty.png",
  "02-log-form.png",
  "03-summary.png",
  "04-history-persisted.png",
  "05-analysis.png",
  "daemon.log",
] as const;

const STEP_IDS = {
  preconditionBuild: "precondition-build",
  preconditionChrome: "precondition-chrome",
  daemonStart: "daemon-start",
  httpShell: "http-shell",
  chromeLaunch: "chrome-launch",
  historyEmpty: "history-empty",
  historyReload: "history-reload",
  analysisUi: "analysis-ui",
  analysisApi: "analysis-api",
  cleanup: "cleanup",
} as const;

interface WorkoutInput {
  /** Days relative to today (0 = today). */
  dayOffset: number;
  weight: number;
  reps: number;
  rpe: number;
}

const WORKOUTS: readonly WorkoutInput[] = [
  { dayOffset: 0, weight: 80, reps: 5, rpe: 7 },
  { dayOffset: -1, weight: 82.5, reps: 5, rpe: 7.5 },
  { dayOffset: -2, weight: 85, reps: 5, rpe: 8 },
];

const EXPECTED = {
  sessions: 3,
  sets: 3,
  reps: 15,
  volume: 1237.5,
  avgRpe: 7.5,
  sources: 3,
} as const;

interface CliOptions {
  help: boolean;
  headed: boolean;
  evidence: string | null;
  keepData: boolean;
  chrome: string | null;
  timeoutMs: number;
}

interface ApiAnalysis {
  metrics: {
    sessions: number;
    total_sets: number;
    total_reps: number;
    volume_kg: number;
    avg_rpe: number | null;
    avg_rest_days: number;
    max_gap_days: number;
  };
  source_records: string[];
}

interface UiMetrics {
  sessions: number | null;
  sets: number | null;
  reps: number | null;
  volume: number | null;
  avgRpe: number | null;
  avgRest: number | null;
  maxGap: number | null;
  sources: number | null;
}

/** One workout the UI saved during this run. */
interface SavedWorkout {
  id: string;
  date: string;
}

/** One history row as read back from the reloaded History screen. */
interface HistoryRowSnapshot {
  id: string | null;
  href: string;
  text: string;
}

interface StepContext {
  id: string;
  name: string;
}

function usage(): string {
  return [
    "Usage: node scripts/verify-app-flow.ts [options]",
    "",
    "  --headed             show Chrome instead of running headless",
    "  --evidence <dir>     evidence directory (default .fit-trace/verification/<UTC>)",
    "  --keep-data          keep the temp daemon/Chrome data dir (default delete)",
    "  --chrome <path>      Chrome binary (default discovery order)",
    "  --timeout <ms>       per-wait and per-CDP-command timeout (default 30000)",
    "  --help               print this help",
  ].join("\n");
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      headed: { type: "boolean", default: false },
      evidence: { type: "string" },
      "keep-data": { type: "boolean", default: false },
      chrome: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const timeoutRaw = parsed.values.timeout;
  const timeoutMs = timeoutRaw === undefined ? 30_000 : Number(timeoutRaw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error(`--timeout must be an integer >= 1000 (got ${String(timeoutRaw)})`);
  }
  return {
    help: parsed.values.help === true,
    headed: parsed.values.headed === true,
    evidence: parsed.values.evidence ?? null,
    keepData: parsed.values["keep-data"] === true,
    chrome: parsed.values.chrome ?? null,
    timeoutMs,
  };
}

function log(message: string): void {
  console.log(`[verify:app] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the git provenance the manifest records. */
function readGitProvenance(): {
  testedSha: string;
  branch: string;
  dirty: boolean;
  dirtyFileCount: number;
} {
  function git(args: readonly string[]): string | null {
    try {
      return execFileSync("git", [...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }
  const testedSha = git(["rev-parse", "HEAD"]) ?? "unknown";
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
  const status = git(["status", "--porcelain"]);
  const summary = summarizeGitStatus(status ?? "");
  return { testedSha, branch, dirty: summary.dirty, dirtyFileCount: summary.dirtyFileCount };
}

/** Every file under `root`, as sorted-by-path (POSIX) relative entries. */
async function readArtifactFiles(root: string): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ path: relative, bytes: await readFile(absolute) });
    }
  }
  await walk(root, "");
  return files;
}

function localDateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Resolve a promise but reject after `ms`; used around the daemon's URL line. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Wait until the history screen has settled into either rows or the empty state. */
async function waitForHistorySettled(
  client: CdpClient,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    client,
    sessionId,
    `document.querySelector('[data-screen="history"]') !== null && (
      document.querySelector('[data-screen="history"] .empty-state') !== null ||
      document.querySelectorAll('.history-row').length > 0 ||
      document.querySelector('[data-testid="history-error"]') !== null
    )`,
    { description: "history screen to settle", timeoutMs },
  );
}

/** Wait until the analysis screen has labelled metrics or an explicit error. */
async function waitForAnalysisSettled(
  client: CdpClient,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    client,
    sessionId,
    `document.querySelector('[data-screen="analysis"]') !== null && (
      document.querySelectorAll('ul.analysis-metrics li[data-metric]').length === 7 ||
      document.querySelector('[data-testid="analysis-error"]') !== null ||
      document.querySelector('[data-screen="analysis"] .empty-state') !== null
    )`,
    { description: "analysis screen to settle", timeoutMs },
  );
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`[verify:app] ${errorMessage(error)}\n\n${usage()}`);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const startedAt = new Date();
  const evidenceDir =
    options.evidence === null
      ? defaultEvidenceDir(REPO_ROOT, startedAt)
      : path.resolve(process.cwd(), options.evidence);
  await mkdir(evidenceDir, { recursive: true });

  const steps: ManifestStep[] = [];
  const assertions: ManifestAssertion[] = [];
  const assertionIds = new Set<string>();
  const evidenceFiles: EvidenceEntry[] = [];
  const gitProvenance = readGitProvenance();
  let currentStep: StepContext = { id: "harness", name: "harness" };
  let chromeVersion: string | null = null;
  let artifactSha256 = "missing";
  let tempRoot: string | null = null;
  let dataDir: string | null = null;
  let chrome: LaunchedChrome | null = null;
  let daemon: SpawnedDaemon | null = null;
  let client: CdpClient | null = null;
  let sessionId: string | null = null;
  let baseUrl: string | null = null;
  let uiMetrics: UiMetrics | null = null;
  let failure: Error | null = null;
  let cleanup: ManifestCleanup | null = null;
  let chromeStop: ConfirmedStop | null = null;
  let daemonStop: ConfirmedStop | null = null;
  let tempRootKept = options.keepData;
  let tempRootDeleted = false;
  const cleanupNotices: string[] = [];
  const savedWorkouts: SavedWorkout[] = [];
  const daemonLogs: string[] = [];

  function recordEvidence(pathName: string, bytes: Uint8Array): void {
    const entry = evidenceEntry(pathName, bytes);
    const index = evidenceFiles.findIndex((existing) => existing.path === pathName);
    if (index === -1) evidenceFiles.push(entry);
    else evidenceFiles[index] = entry;
  }

  async function writeEvidence(pathName: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path.join(evidenceDir, pathName), bytes);
    recordEvidence(pathName, bytes);
  }

  function recordAssertion(
    stepId: string,
    name: string,
    expected: unknown,
    actual: unknown,
    passed: boolean,
  ): void {
    const id = assertionId(stepId, name);
    if (assertionIds.has(id)) {
      throw new Error(`duplicate assertion id: ${id}`);
    }
    assertionIds.add(id);
    assertions.push({
      id,
      step: stepId,
      name,
      expected,
      actual,
      passed,
      required: true,
    });
  }

  function assertEqual(name: string, expected: unknown, actual: unknown): void {
    const passed = Object.is(expected, actual);
    recordAssertion(currentStep.id, name, expected, actual, passed);
    if (!passed) {
      throw new Error(
        `assertion failed: ${name}; expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
      );
    }
  }

  function assertNumber(name: string, expected: number, actual: unknown): void {
    const passed =
      typeof actual === "number" &&
      Number.isFinite(actual) &&
      Math.abs(actual - expected) < 1e-9;
    recordAssertion(currentStep.id, name, expected, actual, passed);
    if (!passed) {
      throw new Error(`assertion failed: ${name}; expected ${expected}, observed ${String(actual)}`);
    }
  }

  function assertDeepEqual(name: string, expected: unknown, actual: unknown): void {
    const passed = JSON.stringify(expected) === JSON.stringify(actual);
    recordAssertion(currentStep.id, name, expected, actual, passed);
    if (!passed) {
      throw new Error(
        `assertion failed: ${name}; expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
      );
    }
  }

  async function screenshot(name: string): Promise<void> {
    if (client === null || sessionId === null) {
      throw new Error(`cannot capture ${name}: no page session`);
    }
    const bytes = await captureScreenshot(client, sessionId);
    await writeEvidence(name, bytes);
  }

  /**
   * Click like a user: scroll into view, refuse covered/invisible elements, and
   * dispatch real pointer events at the element's center. The hit test is an
   * assertion, so a covered control is a visible failure, not a silent no-op.
   */
  async function clickAtCenter(label: string, selector: string): Promise<void> {
    if (client === null || sessionId === null) {
      throw new Error("browser session is not available");
    }
    const preparation = await prepareClick(client, sessionId, selector);
    recordAssertion(
      currentStep.id,
      `${label} is visible and not covered`,
      true,
      preparation.ok ? true : (preparation.reason ?? false),
      preparation.ok,
    );
    if (!preparation.ok) {
      throw new Error(`could not click ${label}: ${preparation.reason ?? "unknown reason"}`);
    }
    await dispatchClick(client, sessionId, preparation.x, preparation.y);
  }

  function provenance(): Provenance {
    return {
      testedSha: gitProvenance.testedSha,
      branch: gitProvenance.branch,
      dirty: gitProvenance.dirty,
      dirtyFileCount: gitProvenance.dirtyFileCount,
      artifactSha256,
      nodeVersion: process.version,
      chromeVersion,
      platform: process.platform,
      arch: process.arch,
    };
  }

  async function finishManifest(
    outcome: VerificationOutcome,
    error: string | null,
  ): Promise<boolean> {
    const input: ManifestInput = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      provenance: provenance(),
      baseUrl,
      evidenceDir,
      dataDir,
      outcome,
      steps,
      assertions,
      evidence: evidenceFiles,
      cleanup,
      error,
    };
    const manifest = buildManifest(input);
    try {
      await writeFile(
        path.join(evidenceDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      return true;
    } catch (writeError) {
      console.error(
        `[verify:app] could not write manifest.json: ${errorMessage(writeError)}`,
      );
      return false;
    }
  }

  async function runStep<T>(
    id: string,
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    currentStep = { id, name };
    const stepStartedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const result = await fn();
      steps.push({
        id,
        name,
        status: "passed",
        startedAt: stepStartedAt,
        durationMs: Date.now() - t0,
      });
      log(`✓ ${name} (${Date.now() - t0}ms)`);
      return result;
    } catch (error) {
      steps.push({
        id,
        name,
        status: "failed",
        startedAt: stepStartedAt,
        durationMs: Date.now() - t0,
        error: errorMessage(error),
      });
      log(`✗ ${name}: ${errorMessage(error)}`);
      throw error;
    }
  }

  // ---- Preconditions -------------------------------------------------------
  const distIndex = path.join(APP_DIST, "index.html");
  if (!existsSync(distIndex)) {
    steps.push({
      id: STEP_IDS.preconditionBuild,
      name: "built app shell",
      status: "skipped",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      error: `missing ${distIndex}`,
    });
    const written = await finishManifest("build-missing", `missing ${distIndex}`);
    log(`SKIP (not a pass): missing ${distIndex}; run 'pnpm build' first.`);
    log(`evidence: ${evidenceDir}`);
    return written ? exitCodeForOutcome("build-missing") : 1;
  }

  try {
    artifactSha256 = computeArtifactDigest(await readArtifactFiles(APP_DIST));
    log(`artifact sha256: ${artifactSha256}`);
  } catch (error) {
    const detail = `could not digest app/dist: ${errorMessage(error)}`;
    steps.push({
      id: STEP_IDS.preconditionBuild,
      name: "built app shell",
      status: "failed",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      error: detail,
    });
    const written = await finishManifest("failed", detail);
    log(`FAIL: ${detail}`);
    log(`evidence: ${evidenceDir}`);
    return written ? exitCodeForOutcome("failed") : 1;
  }

  const chromePath = options.chrome === null ? findChrome() : options.chrome;
  if (chromePath === null || chromePath === "") {
    steps.push({
      id: STEP_IDS.preconditionChrome,
      name: "Chrome discovery",
      status: "skipped",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      error: "no Chrome binary found",
    });
    const written = await finishManifest("chrome-missing", "no Chrome binary found");
    log("SKIP (not a pass): no Chrome found. Install Chrome or pass --chrome <path>.");
    log(`evidence: ${evidenceDir}`);
    return written ? exitCodeForOutcome("chrome-missing") : 1;
  }
  if (!existsSync(chromePath)) {
    steps.push({
      id: STEP_IDS.preconditionChrome,
      name: "Chrome discovery",
      status: "skipped",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      error: `not a file: ${chromePath}`,
    });
    const written = await finishManifest("chrome-missing", `not a file: ${chromePath}`);
    log(`SKIP (not a pass): Chrome path does not exist: ${chromePath}`);
    log(`evidence: ${evidenceDir}`);
    return written ? exitCodeForOutcome("chrome-missing") : 1;
  }

  log(`evidence: ${evidenceDir}`);
  log(`chrome: ${chromePath}`);
  log(
    `provenance: ${gitProvenance.testedSha.slice(0, 12)} (${gitProvenance.branch})` +
      `${gitProvenance.dirty ? `, dirty (${gitProvenance.dirtyFileCount} file(s))` : ", clean"}`,
  );

  try {
    // ---- Temp workspace + daemon ------------------------------------------
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fit-trace-verify-"));
    dataDir = path.join(tempRoot, "data");
    await mkdir(dataDir, { recursive: true });

    await runStep(
      STEP_IDS.daemonStart,
      "Start daemon with a fresh temp data dir",
      async () => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
        // Guest mode is the biggest silent-failure risk: an inherited Supabase
        // configuration would turn `/api/v1/public-config` into an account setup
        // and the UI would land on sign-in. Empty values mean "unconfigured".
        for (const key of [
          "SUPABASE_URL",
          "SUPABASE_PUBLISHABLE_KEY",
          "SUPABASE_ANON_KEY",
          "FIT_TRACE_GUEST_SIGN_IN",
          "FIT_TRACE_GUEST_UPGRADE",
          "FIT_TRACE_GUEST_CAPTCHA_REQUIRED",
          "FIT_TRACE_API_BASE_URL",
          "FIT_TRACE_SYNC_PUBLIC_KEYS",
          "FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH",
          "FIT_TRACE_CLOUD_API_BASE_URL",
        ]) {
          childEnv[key] = "";
        }
        delete childEnv.FIT_TRACE_DATA_DIR;

        const activeDataDir = dataDir;
        if (activeDataDir === null) throw new Error("temp data dir is not available");
        const spawned = spawnVerificationDaemon({
          nodePath: process.execPath,
          cliPath: DAEMON_CLI,
          dataDir: activeDataDir,
          distDir: APP_DIST,
          port: 0,
          env: childEnv,
          urlTimeoutMs: DAEMON_TIMEOUT_MS,
        });
        daemon = spawned;
        spawned.child.stdout?.on("data", (chunk: unknown) => daemonLogs.push(String(chunk)));
        spawned.child.stderr?.on("data", (chunk: unknown) => daemonLogs.push(String(chunk)));

        try {
          baseUrl = await withTimeout(
            spawned.url,
            DAEMON_TIMEOUT_MS + 2_000,
            "daemon listen line",
          );
        } catch (error) {
          throw new Error(
            `${errorMessage(error)}\n--- daemon output tail ---\n${daemonLogs.join("").split(/\r?\n/).slice(-24).join("\n")}`,
          );
        }
        const healthy = await daemonHealthCheck(baseUrl);
        assertEqual("daemon health check", true, healthy);
        log(`daemon: ${baseUrl} (pid ${String(spawned.child.pid ?? "?")})`);
      },
    );

    await runStep(
      STEP_IDS.httpShell,
      "HTTP shell, runtime mode, and guest public config",
      async () => {
        if (baseUrl === null) throw new Error("daemon URL is not available");

        const rootResponse = await fetch(`${baseUrl}/`);
        assertEqual("GET / status", 200, rootResponse.status);
        const contentType = rootResponse.headers.get("content-type") ?? "";
        assertEqual("GET / is HTML", true, contentType.includes("text/html"));
        const html = await rootResponse.text();
        assertEqual("GET / serves the app root", true, html.includes('id="root"'));

        const runtimeResponse = await fetch(`${baseUrl}/fit-trace-runtime.js`);
        assertEqual("runtime script status", 200, runtimeResponse.status);
        const runtime = await runtimeResponse.text();
        assertEqual("runtime script selects http mode", true, /mode:\s*"http"/.test(runtime));

        const configResponse = await fetch(`${baseUrl}/api/v1/public-config`);
        assertEqual("public-config status", 200, configResponse.status);
        const config: unknown = await configResponse.json();
        assertEqual("public-config is guest-local", true, isGuestPublicConfig(config));
      },
    );

    await runStep(
      STEP_IDS.chromeLaunch,
      "Launch system Chrome and connect over raw CDP",
      async () => {
        const root = tempRoot;
        if (root === null) throw new Error("temp workspace is not available");
        chrome = await launchChrome({
          chromePath,
          userDataDir: path.join(root, "chrome-profile"),
          headed: options.headed,
          width: CHROME_WIDTH,
          height: CHROME_HEIGHT,
          timeoutMs: Math.max(options.timeoutMs, 20_000),
        });
        client = await CdpClient.connect(
          chrome.browserWebSocketUrl,
          options.timeoutMs,
          options.timeoutMs,
        );
        const version = await client.send<{ product: string }>("Browser.getVersion");
        chromeVersion = version.product;
        const page = await createPageTarget(client, {
          width: CHROME_WIDTH,
          height: CHROME_HEIGHT,
        });
        sessionId = page.sessionId;
        log(`chrome: ${version.product}`);
      },
    );

    // ---- Flow -------------------------------------------------------------
    await runStep(STEP_IDS.historyEmpty, "History starts empty", async () => {
      if (client === null || sessionId === null || baseUrl === null) {
        throw new Error("browser session is not available");
      }
      await navigate(client, sessionId, `${baseUrl}/`, options.timeoutMs);
      await waitForHistorySettled(client, sessionId, options.timeoutMs);
      const rows = await evaluate<number>(
        client,
        sessionId,
        'document.querySelectorAll(".history-row").length',
      );
      assertEqual("history row count", 0, rows);
      const emptyState = await evaluate<boolean>(
        client,
        sessionId,
        `document.querySelector('[data-screen="history"] .empty-state') !== null`,
      );
      assertEqual("empty state rendered", true, emptyState);
      await screenshot("01-history-empty.png");
    });

    for (const [index, workout] of WORKOUTS.entries()) {
      const stepId = `log-workout-${index + 1}`;
      await runStep(stepId, `Log workout ${index + 1} through the UI`, async () => {
        if (client === null || sessionId === null || baseUrl === null) {
          throw new Error("browser session is not available");
        }
        const date = localDateOffset(workout.dayOffset);

        await navigate(client, sessionId, `${baseUrl}/workout/new`, options.timeoutMs);
        await waitFor(
          client,
          sessionId,
          `document.querySelector('[data-screen="log"]') !== null && document.querySelector(${JSON.stringify(DATE_FIELD_SELECTOR)}) !== null`,
          { description: "log form", timeoutMs: options.timeoutMs },
        );

        await setFieldValue(client, sessionId, COMBOBOX_SELECTOR, "bench press");
        await waitFor(
          client,
          sessionId,
          `document.querySelector(${JSON.stringify(exerciseOptionSelector(BENCH_PRESS))}) !== null`,
          { description: "bench press suggestion", timeoutMs: options.timeoutMs },
        );
        await clickAtCenter(
          "bench press suggestion",
          exerciseOptionSelector(BENCH_PRESS),
        );
        await waitFor(
          client,
          sessionId,
          `document.querySelector(${JSON.stringify(COMBOBOX_SELECTOR)}).value === ${JSON.stringify(BENCH_PRESS)}`,
          { description: "selected exercise name", timeoutMs: options.timeoutMs },
        );

        // Semantic: the first exercise's first set, not a hardcoded draft key.
        await setFieldValue(
          client,
          sessionId,
          exerciseFieldSelector("weight"),
          String(workout.weight),
        );
        await setFieldValue(
          client,
          sessionId,
          exerciseFieldSelector("reps"),
          String(workout.reps),
        );
        await setFieldValue(
          client,
          sessionId,
          exerciseFieldSelector("rpe"),
          String(workout.rpe),
        );
        await setFieldValue(client, sessionId, DATE_FIELD_SELECTOR, date);
        await setFieldValue(client, sessionId, DURATION_FIELD_SELECTOR, "45");

        if (index === 0) await screenshot("02-log-form.png");

        await clickAtCenter("save workout button", SUBMIT_BUTTON_SELECTOR);
        await waitFor(
          client,
          sessionId,
          `document.querySelector('[data-screen="summary"] .summary-details') !== null ||
           document.querySelector('[data-testid="validation-summary"]') !== null ||
           document.querySelector('[data-testid="warning-confirmation"]') !== null ||
           document.querySelector('[data-testid="save-error"]') !== null`,
          { description: "workout save outcome", timeoutMs: options.timeoutMs },
        );
        const outcome = await evaluate<string>(
          client,
          sessionId,
          `(() => {
            const summary = document.querySelector('[data-screen="summary"] .summary-details');
            if (summary !== null) return "summary";
            const validation = document.querySelector('[data-testid="validation-summary"]');
            if (validation !== null) return "validation: " + (validation.textContent ?? "");
            const warning = document.querySelector('[data-testid="warning-confirmation"]');
            if (warning !== null) return "warning-confirmation: " + (warning.textContent ?? "");
            const saveError = document.querySelector('[data-testid="save-error"]');
            if (saveError !== null) return "save-error: " + (saveError.textContent ?? "");
            return "unknown";
          })()`,
        );
        if (outcome !== "summary") {
          throw new Error(`workout ${index + 1} did not save (${outcome})`);
        }

        const pathname = await evaluate<string>(client, sessionId, "location.pathname");
        assertEqual(
          "workout route is a saved record",
          true,
          /^\/workout\/[^/]+$/.test(pathname) && pathname !== "/workout/new",
        );
        const recordId = recordIdFromPathname(pathname);
        assertEqual("summary route carries a record id", true, recordId !== null);
        if (recordId === null) throw new Error(`not a record route: ${pathname}`);
        savedWorkouts.push({ id: recordId, date });
        const summaryDate = await evaluate<string>(
          client,
          sessionId,
          'document.querySelector("[data-screen=\\"summary\\"] .summary-details dd")?.textContent ?? ""',
        );
        assertEqual("summary shows the submitted date", date, summaryDate.trim());

        if (index === 0) await screenshot("03-summary.png");
      });
    }

    await runStep(
      STEP_IDS.historyReload,
      "History persists three workouts across a reload",
      async () => {
        if (client === null || sessionId === null || baseUrl === null) {
          throw new Error("browser session is not available");
        }
        const savedIds = savedWorkouts.map((workout) => workout.id).sort();
        assertEqual("three unique saved record ids", 3, new Set(savedIds).size);

        await navigate(client, sessionId, `${baseUrl}/`, options.timeoutMs);
        await waitForHistorySettled(client, sessionId, options.timeoutMs);
        await reload(client, sessionId, options.timeoutMs);
        await waitForHistorySettled(client, sessionId, options.timeoutMs);
        const rows = await evaluate<HistoryRowSnapshot[]>(
          client,
          sessionId,
          `Array.from(document.querySelectorAll('[data-screen="history"] .history-row'), (row) => {
            const link = row.querySelector("a");
            return {
              id: row.getAttribute("data-record-id"),
              href: link instanceof HTMLAnchorElement ? (link.getAttribute("href") ?? "") : "",
              text: link instanceof HTMLAnchorElement ? (link.textContent ?? "") : (row.textContent ?? ""),
            };
          })`,
        );
        assertEqual("history rows after reload", 3, rows.length);
        assertEqual(
          "history rows expose record ids",
          true,
          rows.every((row) => row.id !== null && row.id !== ""),
        );

        const historyIds = rows
          .map((row) => row.id ?? recordIdFromHref(row.href) ?? "")
          .sort();
        assertDeepEqual("history shows exactly the saved record ids", savedIds, historyIds);

        for (const [index, saved] of savedWorkouts.entries()) {
          const row = rows.find(
            (candidate) =>
              (candidate.id ?? recordIdFromHref(candidate.href)) === saved.id,
          );
          assertEqual(
            `history date for workout ${index + 1}`,
            saved.date,
            row === undefined ? null : historyRowDate(row.text),
          );
          assertEqual(
            `history href for workout ${index + 1}`,
            `/workout/${saved.id}`,
            row === undefined ? null : row.href,
          );
        }
        await screenshot("04-history-persisted.png");
      },
    );

    await runStep(
      STEP_IDS.analysisUi,
      "Analysis screen shows the deterministic metrics",
      async () => {
        if (client === null || sessionId === null || baseUrl === null) {
          throw new Error("browser session is not available");
        }
        await navigate(client, sessionId, `${baseUrl}/analysis`, options.timeoutMs);
        await waitForAnalysisSettled(client, sessionId, options.timeoutMs);
        const errorText = await evaluate<string>(
          client,
          sessionId,
          'document.querySelector("[data-testid=\\"analysis-error\\"]")?.textContent ?? ""',
        );
        if (errorText !== "") throw new Error(`analysis screen error: ${errorText}`);

        const metricRows = await evaluate<{ metric: string; text: string }[]>(
          client,
          sessionId,
          `Array.from(document.querySelectorAll('ul.analysis-metrics li[data-metric]'), (el) => ({
            metric: el.getAttribute("data-metric") ?? "",
            text: el.textContent ?? "",
          }))`,
        );
        assertEqual("analysis metric rows", 7, metricRows.length);
        assertDeepEqual(
          "analysis metric keys",
          [...ANALYSIS_METRICS],
          metricRows.map((row) => row.metric),
        );

        const values = new Map<string, number | null>();
        for (const row of metricRows) {
          values.set(row.metric, parseMetricNumber(row.text));
        }
        const metricValue = (metric: AnalysisMetric): number | null =>
          values.get(metric) ?? null;

        uiMetrics = {
          sessions: metricValue("sessions"),
          sets: metricValue("sets"),
          reps: metricValue("reps"),
          volume: metricValue("volume"),
          avgRpe: metricValue("avg_rpe"),
          avgRest: metricValue("avg_rest"),
          maxGap: metricValue("max_gap"),
          sources: null,
        };
        assertNumber("UI sessions", EXPECTED.sessions, uiMetrics.sessions);
        assertNumber("UI sets", EXPECTED.sets, uiMetrics.sets);
        assertNumber("UI reps", EXPECTED.reps, uiMetrics.reps);
        assertNumber("UI volume", EXPECTED.volume, uiMetrics.volume);
        assertNumber("UI average RPE", EXPECTED.avgRpe, uiMetrics.avgRpe);

        const sourceText = await evaluate<string>(
          client,
          sessionId,
          `document.querySelector(${JSON.stringify(SOURCE_COUNT_SELECTOR)})?.textContent ?? ""`,
        );
        const sourceCount = parseInteger(sourceText);
        uiMetrics.sources = sourceCount;
        assertNumber("UI source record count", EXPECTED.sources, sourceCount);
        await screenshot("05-analysis.png");
      },
    );

    await runStep(
      STEP_IDS.analysisApi,
      "GET /api/v1/analysis matches the UI",
      async () => {
        if (baseUrl === null) throw new Error("daemon URL is not available");
        if (uiMetrics === null) throw new Error("UI metrics were not captured");
        const response = await fetch(`${baseUrl}/api/v1/analysis`, {
          headers: { authorization: `Bearer ${GUEST_BEARER}` },
        });
        assertEqual("analysis API status", 200, response.status);
        const payload = (await response.json()) as { data?: ApiAnalysis };
        if (payload.data === undefined) throw new Error("analysis API returned no data envelope");
        const analysis = payload.data;
        assertNumber("API sessions", EXPECTED.sessions, analysis.metrics.sessions);
        assertNumber("API sets", EXPECTED.sets, analysis.metrics.total_sets);
        assertNumber("API reps", EXPECTED.reps, analysis.metrics.total_reps);
        assertNumber("API volume", EXPECTED.volume, analysis.metrics.volume_kg);
        assertNumber("API average RPE", EXPECTED.avgRpe, analysis.metrics.avg_rpe);
        assertEqual("API source record count", EXPECTED.sources, analysis.source_records.length);
        assertEqual(
          "API source records are unique",
          true,
          new Set(analysis.source_records).size === analysis.source_records.length,
        );
        assertEqual(
          "API source records are ids",
          true,
          analysis.source_records.every((id) => typeof id === "string" && id.length > 0),
        );

        // Record identity: the analysis must be computed from exactly the
        // records this run saved through the UI.
        const savedIds = savedWorkouts.map((workout) => workout.id).sort();
        assertDeepEqual(
          "API source records equal saved record ids",
          savedIds,
          [...analysis.source_records].sort(),
        );

        // Cross-check: the UI and the API must agree on every displayed metric.
        assertEqual("UI/API sessions agree", analysis.metrics.sessions, uiMetrics.sessions);
        assertEqual("UI/API sets agree", analysis.metrics.total_sets, uiMetrics.sets);
        assertEqual("UI/API reps agree", analysis.metrics.total_reps, uiMetrics.reps);
        assertNumber("UI/API volume agree", analysis.metrics.volume_kg, uiMetrics.volume);
        assertNumber("UI/API average RPE agree", analysis.metrics.avg_rpe ?? NaN, uiMetrics.avgRpe);
        assertNumber(
          "UI/API average rest agree",
          analysis.metrics.avg_rest_days,
          uiMetrics.avgRest,
        );
        assertNumber("UI/API max gap agree", analysis.metrics.max_gap_days, uiMetrics.maxGap);
      },
    );
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    log(`FAIL: ${failure.message}`);
    if (client !== null && sessionId !== null) {
      try {
        await screenshot("failure.png");
      } catch (screenshotError) {
        log(`could not capture failure.png: ${errorMessage(screenshotError)}`);
      }
    }
  } finally {
    // TypeScript's flow analysis cannot see assignments made inside the
    // `runStep` callbacks above, so widen back to the declared unions.
    const activeClient = client as CdpClient | null;
    const activeChrome = chrome as LaunchedChrome | null;
    const activeDaemon = daemon as SpawnedDaemon | null;
    const activeTempRoot = tempRoot as string | null;

    if (activeClient !== null) {
      try {
        activeClient.close();
      } catch {
        // best effort
      }
    }

    if (activeChrome !== null) {
      try {
        chromeStop = await stopConfirmed(activeChrome.child, {
          graceMs: STOP_CONFIRM_GRACE_MS,
        });
      } catch (error) {
        chromeStop = { stopped: false, exitConfirmed: false };
        cleanupNotices.push(`chrome cleanup: ${errorMessage(error)}`);
      }
      if (chromeStop.detail !== undefined) {
        cleanupNotices.push(`chrome: ${chromeStop.detail}`);
      }
    }
    if (activeDaemon !== null) {
      try {
        daemonStop = await stopConfirmed(activeDaemon.child, {
          graceMs: STOP_CONFIRM_GRACE_MS,
        });
      } catch (error) {
        daemonStop = { stopped: false, exitConfirmed: false };
        cleanupNotices.push(`daemon cleanup: ${errorMessage(error)}`);
      }
      if (daemonStop.detail !== undefined) {
        cleanupNotices.push(`daemon: ${daemonStop.detail}`);
      }
    }

    // Daemon output is evidence for both passes and failures.
    try {
      await writeEvidence("daemon.log", Buffer.from(daemonLogs.join(""), "utf8"));
    } catch (error) {
      cleanupNotices.push(`daemon.log write failed: ${errorMessage(error)}`);
      log(`could not write daemon.log: ${errorMessage(error)}`);
    }
    if (activeChrome !== null) {
      try {
        await writeEvidence("chrome.log", Buffer.from(activeChrome.logs.join(""), "utf8"));
      } catch (error) {
        log(`could not write chrome.log: ${errorMessage(error)}`);
      }
    }

    if (activeTempRoot !== null) {
      if (options.keepData) {
        tempRootKept = true;
        log(`temp data kept at ${activeTempRoot}`);
      } else {
        try {
          await rm(activeTempRoot, { recursive: true, force: true });
          tempRootDeleted = !existsSync(activeTempRoot);
        } catch (error) {
          tempRootDeleted = false;
          cleanupNotices.push(`temp cleanup: ${errorMessage(error)}`);
        }
      }
    }
  }

  // ---- Cleanup confirmation ------------------------------------------------
  const chromeCleanup: ProcessCleanup =
    chromeStop === null
      ? { stopped: true, exitConfirmed: true }
      : { stopped: chromeStop.stopped, exitConfirmed: chromeStop.exitConfirmed };
  const daemonCleanupResult: ProcessCleanup =
    daemonStop === null
      ? { stopped: true, exitConfirmed: true }
      : { stopped: daemonStop.stopped, exitConfirmed: daemonStop.exitConfirmed };
  // A workspace that was never created leaves nothing behind, so it counts as
  // handled rather than as an undeleted directory.
  const noWorkspace = (tempRoot as string | null) === null;
  cleanup = {
    chrome: chromeCleanup,
    daemon: daemonCleanupResult,
    tempRoot: noWorkspace
      ? { kept: false, deleted: true }
      : { kept: tempRootKept, deleted: tempRootDeleted },
    ...(cleanupNotices.length === 0 ? {} : { error: cleanupNotices.join("; ") }),
  };

  const cleanupFailures: string[] = [...evaluateCleanup(cleanup).reasons];

  // Integrity: every evidence entry must be on disk with the recorded bytes.
  const integrityFailures: string[] = [];
  for (const entry of evidenceFiles) {
    try {
      const bytes = await readFile(path.join(evidenceDir, entry.path));
      if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
        integrityFailures.push(`${entry.path}: digest mismatch`);
      }
    } catch (error) {
      integrityFailures.push(`${entry.path}: unreadable (${errorMessage(error)})`);
    }
  }
  cleanupFailures.push(...integrityFailures);

  // Required evidence. A failed run only still owes its daemon log; a passing
  // run must leave all five screenshots plus that log.
  const requiredEvidence: readonly string[] = failure === null ? REQUIRED_EVIDENCE : ["daemon.log"];
  const presentEvidence = new Set(evidenceFiles.map((entry) => entry.path));
  const missingEvidence = requiredEvidence.filter((name) => !presentEvidence.has(name));
  if (missingEvidence.length > 0) {
    cleanupFailures.push(`missing required evidence: ${missingEvidence.join(", ")}`);
  }

  const cleanupStartedAt = new Date().toISOString();
  const cleanupFailed = cleanupFailures.length > 0;
  steps.push({
    id: STEP_IDS.cleanup,
    name: "Cleanup confirmed and evidence intact",
    status: cleanupFailed ? "failed" : "passed",
    startedAt: cleanupStartedAt,
    durationMs: 0,
    ...(cleanupFailed ? { error: cleanupFailures.join("; ") } : {}),
  });
  recordAssertion(
    STEP_IDS.cleanup,
    "chrome exit confirmed",
    true,
    chromeCleanup.exitConfirmed,
    chromeCleanup.exitConfirmed,
  );
  recordAssertion(
    STEP_IDS.cleanup,
    "daemon exit confirmed",
    true,
    daemonCleanupResult.exitConfirmed,
    daemonCleanupResult.exitConfirmed,
  );
  recordAssertion(
    STEP_IDS.cleanup,
    "temp workspace deleted or intentionally kept",
    "deleted or kept",
    { kept: cleanup.tempRoot.kept, deleted: cleanup.tempRoot.deleted },
    cleanup.tempRoot.kept || cleanup.tempRoot.deleted,
  );
  recordAssertion(
    STEP_IDS.cleanup,
    "required evidence present",
    [...requiredEvidence].sort(),
    [...presentEvidence].sort(),
    missingEvidence.length === 0,
  );
  recordAssertion(
    STEP_IDS.cleanup,
    "evidence digests match bytes on disk",
    true,
    integrityFailures.length === 0 ? true : integrityFailures,
    integrityFailures.length === 0,
  );

  if (cleanupFailed) {
    const cleanupError = `cleanup did not complete: ${cleanupFailures.join("; ")}`;
    log(`✗ ${cleanupError}`);
    if (failure === null) failure = new Error(cleanupError);
  } else {
    log("✓ cleanup confirmed");
  }

  const outcome: VerificationOutcome = failure === null ? "passed" : "failed";
  const manifestWritten = await finishManifest(
    outcome,
    failure === null ? null : failure.message,
  );

  const manifestPath = path.join(evidenceDir, "manifest.json");
  if (failure === null) {
    log(`PASS — ${steps.length} steps, ${assertions.length} assertions`);
    log(`evidence: ${evidenceDir}`);
    log(`manifest: ${manifestPath}`);
  } else {
    log(`FAIL — ${failure.message}`);
    log(`evidence: ${evidenceDir}`);
    log(`manifest: ${manifestPath}`);
  }
  return manifestWritten ? exitCodeForOutcome(outcome) : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`[verify:app] unexpected harness error: ${errorMessage(error)}`);
    process.exitCode = 1;
  },
);
