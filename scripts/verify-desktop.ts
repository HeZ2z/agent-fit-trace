#!/usr/bin/env node
/**
 * Packaged-desktop acceptance harness: launch the real guest-only `.app`, log
 * one workout through its UI over raw CDP, quit, reopen the same data
 * directory, and prove history and analysis survived.
 *
 * This is the layer above `pnpm verify:app`: that harness starts its own
 * daemon and system Chrome; this one exercises the packaged Electron shell
 * (window, bundled daemon, bundled web shell) end to end.
 *
 * Usage:
 *   node scripts/verify-desktop.ts [--app <path>] [--headed]
 *                                  [--evidence <dir>] [--keep-data]
 *                                  [--timeout <ms>]
 *
 * Exit codes:
 *   0 = every step passed and cleanup was confirmed
 *   1 = a step/assertion failed, cleanup was unconfirmed, or evidence could not
 *       be written (failure.png + app.log + manifest kept as evidence)
 *   2 = precondition (not macOS, `.app` missing, invalid arguments)
 *
 * There is no exit 3: unlike the browser scenario, this harness never depends
 * on an installed Chrome.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CdpClient,
  captureScreenshot,
  dispatchClick,
  evaluate,
  navigate,
  prepareClick,
  reload,
  setFieldValue,
  waitFor,
} from "./verification/cdp.ts";
import {
  DESKTOP_EVIDENCE,
  DESKTOP_EXERCISE,
  DESKTOP_REQUIRED_EVIDENCE,
  DESKTOP_SCENARIO_EXPECTED,
  DESKTOP_STEP_IDS,
  DESKTOP_WORKOUT,
  attachDesktopPage,
  closeBrowserTolerantly,
  computeAppTreeDigest,
  defaultDesktopAppDeps,
  defaultDesktopAppPath,
  desktopLaunchArgs,
  desktopLaunchEnvironment,
  discoverDevToolsEndpoint,
  findDaemonDescendant,
  parseDesktopCliOptions,
  readAppTreeEntries,
  readProcessTable,
  resolveDesktopApp,
  stopAppConfirmed,
  stopRecordedPid,
  waitForDesktopPageTarget,
  waitForPortRelease,
  waitForProcessExit,
} from "./verification/desktop.ts";
import type {
  DesktopAppInfo,
  DesktopCliOptions,
} from "./verification/desktop.ts";
import {
  COMBOBOX_SELECTOR,
  DATE_FIELD_SELECTOR,
  DESKTOP_SCENARIO_ID,
  DURATION_FIELD_SELECTOR,
  SUBMIT_BUTTON_SELECTOR,
  assertionId,
  buildManifest,
  defaultEvidenceDir,
  evaluateCleanup,
  evidenceEntry,
  exerciseFieldSelector,
  exerciseOptionSelector,
  exitCodeForOutcome,
  historyRowDate,
  isGuestPublicConfig,
  recordIdFromHref,
  recordIdFromPathname,
  sha256Hex,
  summarizeGitStatus,
} from "./verification/helpers.ts";
import type {
  DesktopArtifact,
  EvidenceEntry,
  LaunchRecord,
  ManifestAssertion,
  ManifestCleanup,
  ManifestInput,
  ManifestStep,
  ProcessCleanup,
  Provenance,
  VerificationOutcome,
} from "./verification/helpers.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUEST_BEARER = "fit-trace-local-daemon";
/** Spec: the DevTools endpoint must appear within 30s. */
const DEVTOOLS_TIMEOUT_MS = 30_000;
/** How long the app gets to exit after `Browser.close` before SIGTERM. */
const APP_QUIT_GRACE_MS = 15_000;
/** How long the daemon port gets to stop accepting after the app exits. */
const PORT_RELEASE_GRACE_MS = 20_000;
/** Must exceed the desktop shell's SIGTERM → SIGKILL grace (3s). */
const STOP_CONFIRM_GRACE_MS = 10_000;

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

interface HistoryRowSnapshot {
  id: string | null;
  href: string;
  text: string;
}

interface StepContext {
  id: string;
  name: string;
}

interface SavedWorkout {
  id: string;
  date: string;
}

/** One running app launch. */
interface LaunchState {
  phase: "first" | "reopen";
  child: ChildProcess;
  client: CdpClient;
  sessionId: string;
  baseUrl: string;
  port: number;
  daemonPid: number | null;
}

function usage(): string {
  return [
    "Usage: node scripts/verify-desktop.ts [options]",
    "",
    "  --app <path>         packaged .app (default release/mac-<arch>/fit-trace.app)",
    "  --headed             show the Electron window instead of --headless=new",
    "  --evidence <dir>     evidence directory (default .fit-trace/verification/<UTC>)",
    "  --keep-data          keep the temp data/home/userData dirs (default delete)",
    "  --timeout <ms>       per-wait and per-CDP-command timeout (default 30000)",
    "  --help               print this help",
    "",
    "Exit codes: 0 pass, 1 failure, 2 precondition (not macOS / app missing / bad args).",
  ].join("\n");
}

function log(message: string): void {
  console.log(`[verify:desktop] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const summary = summarizeGitStatus(git(["status", "--porcelain"]) ?? "");
  return { testedSha, branch, dirty: summary.dirty, dirtyFileCount: summary.dirtyFileCount };
}

/** `YYYY-MM-DD` for today in the host timezone (matches the UI's date input). */
function localDateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Wait until the history screen has settled into either rows or an empty state. */
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

async function readHistoryRows(
  client: CdpClient,
  sessionId: string,
): Promise<HistoryRowSnapshot[]> {
  return await evaluate<HistoryRowSnapshot[]>(
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
}

async function main(): Promise<number> {
  let options: DesktopCliOptions;
  try {
    options = parseDesktopCliOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`[verify:desktop] ${errorMessage(error)}\n\n${usage()}`);
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
  const launches: LaunchRecord[] = [];
  const logsByPhase = new Map<"first" | "reopen", string[]>();
  const cleanupNotices: string[] = [];
  const gitProvenance = readGitProvenance();
  let currentStep: StepContext = { id: "harness", name: "harness" };
  let artifactSha256 = "missing";
  let artifact: DesktopArtifact | null = null;
  let appInfo: DesktopAppInfo | null = null;
  let tempRoot: string | null = null;
  let dataDir: string | null = null;
  let active: LaunchState | null = null;
  let baseUrl: string | null = null;
  let failure: Error | null = null;
  let cleanup: ManifestCleanup | null = null;
  let lastStop: ProcessCleanup | null = null;
  let tempRootKept = false;
  let tempRootDeleted = false;
  const savedWorkouts: SavedWorkout[] = [];

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
    if (assertionIds.has(id)) throw new Error(`duplicate assertion id: ${id}`);
    assertionIds.add(id);
    assertions.push({ id, step: stepId, name, expected, actual, passed, required: true });
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
      typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9;
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

  /** The running app page, or a clear error when none is attached. */
  function page(): LaunchState {
    if (active === null) throw new Error("no running app page");
    return active;
  }

  async function screenshot(name: string): Promise<void> {
    if (active === null) throw new Error(`cannot capture ${name}: no page session`);
    // Route/row entry transitions take a few frames; capturing mid-fade makes
    // the evidence hard to read even though every DOM assertion already passed.
    await delay(350);
    const bytes = await captureScreenshot(active.client, active.sessionId);
    await writeEvidence(name, bytes);
  }

  /** Click like a user: hit-test the element, then dispatch real pointer events. */
  async function clickAtCenter(label: string, selector: string): Promise<void> {
    const current = page();
    const preparation = await prepareClick(current.client, current.sessionId, selector);
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
    await dispatchClick(current.client, current.sessionId, preparation.x, preparation.y);
  }

  function provenance(): Provenance {
    return {
      testedSha: gitProvenance.testedSha,
      branch: gitProvenance.branch,
      dirty: gitProvenance.dirty,
      dirtyFileCount: gitProvenance.dirtyFileCount,
      artifactSha256,
      nodeVersion: process.version,
      chromeVersion: null,
      platform: process.platform,
      arch: process.arch,
    };
  }

  async function finishManifest(outcome: VerificationOutcome, error: string | null): Promise<boolean> {
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
      scenarioId: DESKTOP_SCENARIO_ID,
      artifact,
      launches,
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
      console.error(`[verify:desktop] could not write manifest.json: ${errorMessage(writeError)}`);
      return false;
    }
  }

  async function runStep<T>(id: string, name: string, fn: () => Promise<T>): Promise<T> {
    currentStep = { id, name };
    const stepStartedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const result = await fn();
      steps.push({ id, name, status: "passed", startedAt: stepStartedAt, durationMs: Date.now() - t0 });
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

  function launchRecord(phase: "first" | "reopen"): LaunchRecord {
    const record = launches.find((candidate) => candidate.phase === phase);
    if (record === undefined) throw new Error(`launch ${phase} was never recorded`);
    return record;
  }

  // ---- Preconditions -------------------------------------------------------
  if (process.platform !== "darwin") {
    steps.push({
      id: DESKTOP_STEP_IDS.launch,
      name: "macOS packaged app",
      status: "skipped",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      error: `requires darwin (got ${process.platform})`,
    });
    const written = await finishManifest(
      "precondition-missing",
      `packaged desktop verification requires macOS (got ${process.platform})`,
    );
    log(`SKIP (not a pass): packaged desktop verification requires macOS; got ${process.platform}.`);
    log(`evidence: ${evidenceDir}`);
    return written ? exitCodeForOutcome("precondition-missing") : 1;
  }

  const requestedApp =
    options.app === null
      ? defaultDesktopAppPath(REPO_ROOT, process.arch, existsSync)
      : path.resolve(process.cwd(), options.app);
  const resolvedApp = resolveDesktopApp(requestedApp, defaultDesktopAppDeps());
  if (resolvedApp === null) {
    steps.push({
      id: DESKTOP_STEP_IDS.launch,
      name: "packaged desktop app",
      status: "skipped",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      error: `not a readable .app bundle: ${requestedApp}`,
    });
    const written = await finishManifest(
      "precondition-missing",
      `packaged app not found: ${requestedApp} ` +
        "(build it with FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm desktop:build && " +
        "pnpm --filter @agent-fit-trace/desktop run package:dir, or pass --app)",
    );
    log(`SKIP (not a pass): no packaged app at ${requestedApp}.`);
    log(
      "Build one: FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm build && " +
        "FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm desktop:build && " +
        "pnpm --filter @agent-fit-trace/desktop run package:dir",
    );
    log(`evidence: ${evidenceDir}`);
    return written ? exitCodeForOutcome("precondition-missing") : 1;
  }
  appInfo = resolvedApp;

  log(`evidence: ${evidenceDir}`);
  log(`app: ${appInfo.appPath}`);
  log(
    `bundle: version ${appInfo.version ?? "unknown"}, id ${appInfo.bundleId ?? "unknown"}, ` +
      `executable ${path.basename(appInfo.executable)}`,
  );
  log(
    `provenance: ${gitProvenance.testedSha.slice(0, 12)} (${gitProvenance.branch})` +
      `${gitProvenance.dirty ? `, dirty (${gitProvenance.dirtyFileCount} file(s))` : ", clean"}`,
  );

  // ---- Launch / quit helpers ----------------------------------------------

  async function launchApp(phase: "first" | "reopen"): Promise<LaunchState> {
    const root = tempRoot;
    if (root === null) throw new Error("temp workspace is not available");
    if (appInfo === null) throw new Error("app bundle is not resolved");
    const userDataDir = path.join(root, phase === "first" ? "electron-a" : "electron-b");
    await mkdir(userDataDir, { recursive: true });
    const logs: string[] = [];
    logsByPhase.set(phase, logs);
    const data = dataDir;
    if (data === null) throw new Error("temp data dir is not available");

    const child: ChildProcess = spawn(
      appInfo.executable,
      desktopLaunchArgs({ userDataDir, headed: options.headed }),
      {
        env: desktopLaunchEnvironment(process.env, { home: path.join(root, "home"), dataDir: data }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let exited = false;
    child.stdout?.on("data", (chunk: unknown) => logs.push(String(chunk)));
    child.stderr?.on("data", (chunk: unknown) => logs.push(String(chunk)));
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", (error: Error) => {
      exited = true;
      logs.push(`spawn error: ${error.message}\n`);
    });

    try {
      const endpoint = await discoverDevToolsEndpoint({
        userDataDir,
        timeoutMs: Math.min(options.timeoutMs, DEVTOOLS_TIMEOUT_MS),
        isExited: () => exited || child.exitCode !== null || child.signalCode !== null,
        logs: () => logs.join(""),
      });
      const appClient = await CdpClient.connect(
        endpoint.browserWebSocketUrl,
        options.timeoutMs,
        options.timeoutMs,
      );
      const pageTarget = await waitForDesktopPageTarget(appClient, {
        timeoutMs: options.timeoutMs,
      });
      const sessionId = await attachDesktopPage(appClient, pageTarget.target.targetId);
      const daemonPid =
        child.pid === undefined
          ? null
          : (findDaemonDescendant(readProcessTable(), child.pid) ?? null);

      const state: LaunchState = {
        phase,
        child,
        client: appClient,
        sessionId,
        baseUrl: pageTarget.baseUrl,
        port: pageTarget.port,
        daemonPid,
      };
      launches.push({
        phase,
        pid: child.pid ?? null,
        baseUrl: state.baseUrl,
        port: state.port,
        appVersion: appInfo.version,
        ...(daemonPid === null ? {} : { daemonPid }),
        exitConfirmed: false,
        portReleased: false,
      });
      active = state;
      baseUrl = state.baseUrl;
      log(
        `launch ${phase}: ${state.baseUrl} (app pid ${child.pid ?? "?"}` +
          `${daemonPid === null ? "" : `, daemon pid ${daemonPid}`})`,
      );
      return state;
    } catch (error) {
      // Locate the daemon before the app exits: once orphaned it is reparented
      // to launchd and can no longer be found from the app's pid.
      const daemonPidBefore =
        child.pid === undefined
          ? null
          : (findDaemonDescendant(readProcessTable(), child.pid) ?? null);
      const stop = await stopAppConfirmed(child, { graceMs: STOP_CONFIRM_GRACE_MS });
      lastStop = { stopped: stop.stopped, exitConfirmed: stop.exitConfirmed };
      if (daemonPidBefore !== null) {
        await stopRecordedPid(daemonPidBefore, { graceMs: 5_000 });
      }
      throw error;
    }
  }

  /**
   * Quit a launch: Browser.close first (the shell's `window-all-closed` →
   * before-quit path stops the daemon), then SIGTERM/SIGKILL fallbacks. Never
   * throws; the caller turns the recorded booleans into assertions.
   */
  async function quitLaunch(
    state: LaunchState,
  ): Promise<{ exitConfirmed: boolean; portReleased: boolean }> {
    const record = launches.find((candidate) => candidate.phase === state.phase);
    if (state.daemonPid === null && state.child.pid !== undefined) {
      state.daemonPid = findDaemonDescendant(readProcessTable(), state.child.pid) ?? null;
      if (record !== undefined && state.daemonPid !== null) record.daemonPid = state.daemonPid;
    }

    await closeBrowserTolerantly(state.client, 5_000);
    state.client.close();
    let exitConfirmed = await waitForProcessExit(state.child, APP_QUIT_GRACE_MS);
    if (!exitConfirmed) {
      const stop = await stopAppConfirmed(state.child, { graceMs: STOP_CONFIRM_GRACE_MS });
      exitConfirmed = stop.exitConfirmed;
      cleanupNotices.push(
        `${state.phase}: app needed ${stop.escalated} (Browser.close did not end it)`,
      );
    }

    const portReleased = await waitForPortRelease(state.port, {
      timeoutMs: PORT_RELEASE_GRACE_MS,
    });
    if (!portReleased) {
      cleanupNotices.push(
        `${state.phase}: daemon port ${state.port} still accepted connections after the app exited`,
      );
      if (state.daemonPid !== null) {
        const gone = await stopRecordedPid(state.daemonPid, { graceMs: 5_000 });
        cleanupNotices.push(
          `${state.phase}: killed recorded daemon pid ${state.daemonPid} ` +
            `(${gone ? "gone" : "still alive"})`,
        );
      }
    }

    if (record !== undefined) {
      record.exitConfirmed = exitConfirmed;
      record.portReleased = portReleased;
    }
    lastStop = { stopped: true, exitConfirmed };
    if (active === state) active = null;
    return { exitConfirmed, portReleased };
  }

  try {
    // ---- Fresh workspace --------------------------------------------------
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fit-trace-verify-desktop-"));
    dataDir = path.join(tempRoot, "data");
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.join(tempRoot, "home"), { recursive: true });

    // ---- Artifact digest --------------------------------------------------
    artifactSha256 = await runStep(
      DESKTOP_STEP_IDS.launch,
      "Digest the packaged app and launch it",
      async () => {
        const resolved = appInfo;
        if (resolved === null) throw new Error("app bundle is not resolved");
        const digest = computeAppTreeDigest(await readAppTreeEntries(resolved.appPath));
        artifact = {
          kind: "desktop-app",
          path: resolved.appPath,
          sha256: digest.sha256,
          fileCount: digest.fileCount,
          bytes: digest.bytes,
          version: resolved.version,
          bundleId: resolved.bundleId,
        };
        log(
          `artifact: ${digest.sha256.slice(0, 16)}… (${digest.fileCount} files, ` +
            `${(digest.bytes / 1024 / 1024).toFixed(1)} MB)`,
        );
        await launchApp("first");
        assertEqual("first launch recorded its phase", "first", launchRecord("first").phase);
        assertEqual("first launch runs a page at the daemon origin", true, isDaemonOrigin(baseUrl));
        return digest.sha256;
      },
    );

    // ---- Guest public config ---------------------------------------------
    await runStep(
      DESKTOP_STEP_IDS.guestConfig,
      "The packaged shell serves the guest-local surface",
      async () => {
        const current = page();
        const response = await fetch(`${current.baseUrl}/api/v1/public-config`);
        assertEqual("public-config status", 200, response.status);
        const config: unknown = await response.json();
        assertEqual("public-config is guest-local", true, isGuestPublicConfig(config));

        const historyResponse = await fetch(`${current.baseUrl}/`, {
          headers: { authorization: `Bearer ${GUEST_BEARER}` },
        });
        assertEqual("daemon serves the app shell", 200, historyResponse.status);
        const html = await historyResponse.text();
        assertEqual("GET / serves the app root", true, html.includes('id="root"'));
      },
    );

    // ---- First launch: empty history -------------------------------------
    await runStep(
      DESKTOP_STEP_IDS.log,
      `Log one workout through the packaged UI`,
      async () => {
        const current = page();
        await navigate(current.client, current.sessionId, `${current.baseUrl}/`, options.timeoutMs);
        await waitForHistorySettled(current.client, current.sessionId, options.timeoutMs);
        const rows = await evaluate<number>(
          current.client,
          current.sessionId,
          'document.querySelectorAll(".history-row").length',
        );
        assertEqual("history starts empty", 0, rows);
        const emptyState = await evaluate<boolean>(
          current.client,
          current.sessionId,
          `document.querySelector('[data-screen="history"] .empty-state') !== null`,
        );
        assertEqual("empty state rendered", true, emptyState);
        await screenshot(DESKTOP_EVIDENCE.empty);

        const date = localDateOffset(0);
        await navigate(
          current.client,
          current.sessionId,
          `${current.baseUrl}/workout/new`,
          options.timeoutMs,
        );
        await waitFor(
          current.client,
          current.sessionId,
          `document.querySelector('[data-screen="log"]') !== null && document.querySelector(${JSON.stringify(DATE_FIELD_SELECTOR)}) !== null`,
          { description: "log form", timeoutMs: options.timeoutMs },
        );

        await setFieldValue(current.client, current.sessionId, COMBOBOX_SELECTOR, "bench press");
        await waitFor(
          current.client,
          current.sessionId,
          `document.querySelector(${JSON.stringify(exerciseOptionSelector(DESKTOP_EXERCISE))}) !== null`,
          { description: "bench press suggestion", timeoutMs: options.timeoutMs },
        );
        await clickAtCenter(
          "bench press suggestion",
          exerciseOptionSelector(DESKTOP_EXERCISE),
        );
        await waitFor(
          current.client,
          current.sessionId,
          `document.querySelector(${JSON.stringify(COMBOBOX_SELECTOR)}).value === ${JSON.stringify(DESKTOP_EXERCISE)}`,
          { description: "selected exercise name", timeoutMs: options.timeoutMs },
        );

        await setFieldValue(
          current.client,
          current.sessionId,
          exerciseFieldSelector("weight"),
          String(DESKTOP_WORKOUT.weight),
        );
        await setFieldValue(
          current.client,
          current.sessionId,
          exerciseFieldSelector("reps"),
          String(DESKTOP_WORKOUT.reps),
        );
        await setFieldValue(
          current.client,
          current.sessionId,
          exerciseFieldSelector("rpe"),
          String(DESKTOP_WORKOUT.rpe),
        );
        await setFieldValue(current.client, current.sessionId, DATE_FIELD_SELECTOR, date);
        await setFieldValue(
          current.client,
          current.sessionId,
          DURATION_FIELD_SELECTOR,
          String(DESKTOP_WORKOUT.durationMinutes),
        );

        await screenshot(DESKTOP_EVIDENCE.log);

        await clickAtCenter("save workout button", SUBMIT_BUTTON_SELECTOR);
        await waitFor(
          current.client,
          current.sessionId,
          `document.querySelector('[data-screen="summary"] .summary-details') !== null ||
           document.querySelector('[data-testid="validation-summary"]') !== null ||
           document.querySelector('[data-testid="warning-confirmation"]') !== null ||
           document.querySelector('[data-testid="save-error"]') !== null`,
          { description: "workout save outcome", timeoutMs: options.timeoutMs },
        );
        const outcome = await evaluate<string>(
          current.client,
          current.sessionId,
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
        if (outcome !== "summary") throw new Error(`workout did not save (${outcome})`);

        const pathname = await evaluate<string>(current.client, current.sessionId, "location.pathname");
        assertEqual(
          "workout route is a saved record",
          true,
          /^\/workout\/[^/]+$/.test(pathname) && pathname !== "/workout/new",
        );
        const recordId = recordIdFromPathname(pathname);
        if (recordId === null) throw new Error(`not a record route: ${pathname}`);
        savedWorkouts.push({ id: recordId, date });
        const summaryDate = await evaluate<string>(
          current.client,
          current.sessionId,
          'document.querySelector("[data-screen=\\"summary\\"] .summary-details dd")?.textContent ?? ""',
        );
        assertEqual("summary shows today's date", date, summaryDate.trim());
        await screenshot(DESKTOP_EVIDENCE.summary);
      },
    );

    // ---- Reload within the first launch ----------------------------------
    await runStep(
      DESKTOP_STEP_IDS.reload,
      "History shows the saved workout after a reload",
      async () => {
        const current = page();
        const saved = savedWorkouts[0];
        await navigate(current.client, current.sessionId, `${current.baseUrl}/`, options.timeoutMs);
        await waitForHistorySettled(current.client, current.sessionId, options.timeoutMs);
        await reload(current.client, current.sessionId, options.timeoutMs);
        await waitForHistorySettled(current.client, current.sessionId, options.timeoutMs);

        const rows = await readHistoryRows(current.client, current.sessionId);
        assertEqual("history rows after reload", 1, rows.length);
        const row = rows[0];
        assertEqual("history row is the saved record", saved.id, row?.id ?? recordIdFromHref(row?.href ?? ""));
        assertEqual("history href points at the record", `/workout/${saved.id}`, row?.href ?? null);
        assertEqual("history row shows the saved date", saved.date, historyRowDate(row?.text ?? ""));
        await screenshot(DESKTOP_EVIDENCE.reload);
      },
    );

    // ---- Quit the first launch -------------------------------------------
    await runStep(DESKTOP_STEP_IDS.quit, "Quit the app and release its daemon port", async () => {
      const current = page();
      const port = current.port;
      const daemonPid = current.daemonPid;
      const result = await quitLaunch(current);
      assertEqual("app process exit confirmed", true, result.exitConfirmed);
      assertEqual("daemon port released", true, result.portReleased);
      const record = launchRecord("first");
      assertEqual("first launch exit recorded", true, record.exitConfirmed);
      assertEqual("first launch port release recorded", true, record.portReleased);
      assertEqual("first launch port recorded", port, record.port);
      log(
        `first launch stopped (pid ${record.pid ?? "?"}` +
          `${daemonPid === null ? "" : `, daemon ${daemonPid}`}), port ${port} released`,
      );
    });

    // ---- Reopen on the same data dir -------------------------------------
    await runStep(DESKTOP_STEP_IDS.reopen, "Reopen the packaged app on the same data dir", async () => {
      const state = await launchApp("reopen");
      const record = launchRecord("reopen");
      assertEqual("reopen launch ran a page at the daemon origin", true, isDaemonOrigin(state.baseUrl));
      assertEqual(
        "reopen launch recorded a loopback daemon port",
        true,
        record.port !== null && record.port > 0,
      );
      const response = await fetch(`${state.baseUrl}/api/v1/public-config`);
      assertEqual("reopen public-config status", 200, response.status);
      assertEqual("reopen public-config is guest-local", true, isGuestPublicConfig(await response.json()));
    });

    // ---- Persisted record after the restart -------------------------------
    await runStep(
      DESKTOP_STEP_IDS.persisted,
      "Reopened history contains the saved workout exactly once",
      async () => {
        const current = page();
        const saved = savedWorkouts[0];
        await waitForHistorySettled(current.client, current.sessionId, options.timeoutMs);
        const rows = await readHistoryRows(current.client, current.sessionId);
        assertEqual("reopened history has exactly one row", 1, rows.length);
        const row = rows[0];
        const rowId = row?.id ?? recordIdFromHref(row?.href ?? "");
        assertEqual("reopened history contains the saved record", saved.id, rowId);
        assertEqual(
          "reopened history has no duplicate",
          1,
          rows.filter(
            (candidate) =>
              (candidate.id ?? recordIdFromHref(candidate.href)) === saved.id,
          ).length,
        );
        assertEqual("reopened history shows the saved date", saved.date, historyRowDate(row?.text ?? ""));
        await screenshot(DESKTOP_EVIDENCE.reopened);
      },
    );

    // ---- Persisted record + analysis -------------------------------------
    await runStep(
      DESKTOP_STEP_IDS.analysis,
      "Analysis of the reopened record matches the deterministic metrics",
      async () => {
        const current = page();
        const saved = savedWorkouts[0];
        await navigate(
          current.client,
          current.sessionId,
          `${current.baseUrl}/analysis`,
          options.timeoutMs,
        );
        await waitForAnalysisSettled(current.client, current.sessionId, options.timeoutMs);
        const errorText = await evaluate<string>(
          current.client,
          current.sessionId,
          'document.querySelector("[data-testid=\\"analysis-error\\"]")?.textContent ?? ""',
        );
        if (errorText !== "") throw new Error(`analysis screen error: ${errorText}`);
        const metricRows = await evaluate<number>(
          current.client,
          current.sessionId,
          `document.querySelectorAll('ul.analysis-metrics li[data-metric]').length`,
        );
        assertEqual("analysis metric rows", 7, metricRows);
        await screenshot(DESKTOP_EVIDENCE.analysis);

        const response = await fetch(`${current.baseUrl}/api/v1/analysis`, {
          headers: { authorization: `Bearer ${GUEST_BEARER}` },
        });
        assertEqual("analysis API status", 200, response.status);
        const payload = (await response.json()) as { data?: ApiAnalysis };
        if (payload.data === undefined) throw new Error("analysis API returned no data envelope");
        const analysis = payload.data;
        assertNumber("API sessions", DESKTOP_SCENARIO_EXPECTED.sessions, analysis.metrics.sessions);
        assertNumber("API sets", DESKTOP_SCENARIO_EXPECTED.totalSets, analysis.metrics.total_sets);
        assertNumber("API reps", DESKTOP_SCENARIO_EXPECTED.totalReps, analysis.metrics.total_reps);
        assertNumber("API volume", DESKTOP_SCENARIO_EXPECTED.volumeKg, analysis.metrics.volume_kg);
        assertNumber("API average RPE", DESKTOP_SCENARIO_EXPECTED.avgRpe, analysis.metrics.avg_rpe);
        assertDeepEqual("API source records are exactly the saved record", [saved.id], analysis.source_records);
        assertEqual(
          "API volume equals the logged set",
          DESKTOP_WORKOUT.weight * DESKTOP_WORKOUT.reps,
          analysis.metrics.volume_kg,
        );
      },
    );
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    log(`FAIL: ${failure.message}`);
    if (active !== null) {
      // A live page session can still show what the UI looked like.
      try {
        await screenshot(DESKTOP_EVIDENCE.failure);
      } catch (screenshotError) {
        log(`could not capture ${DESKTOP_EVIDENCE.failure}: ${errorMessage(screenshotError)}`);
      }
    }
  } finally {
    // Failure safety net: only the app this harness started is stopped.
    const remaining = active as LaunchState | null;
    if (remaining !== null) {
      try {
        await quitLaunch(remaining);
      } catch (error) {
        cleanupNotices.push(`shutdown: ${errorMessage(error)}`);
      }
    }

    // App output is evidence for both passes and failures.
    const appLogText = [...logsByPhase.entries()]
      .map(([phase, lines]) => `===== ${phase} launch =====\n${lines.join("")}`)
      .join("\n");
    try {
      await writeEvidence(DESKTOP_EVIDENCE.appLog, Buffer.from(appLogText, "utf8"));
    } catch (error) {
      cleanupNotices.push(`app.log write failed: ${errorMessage(error)}`);
      log(`could not write ${DESKTOP_EVIDENCE.appLog}: ${errorMessage(error)}`);
    }

    const root = tempRoot as string | null;
    if (root !== null) {
      if (options.keepData) {
        tempRootKept = true;
        log(`temp data kept at ${root}`);
      } else {
        try {
          await rm(root, { recursive: true, force: true });
          tempRootDeleted = !existsSync(root);
        } catch (error) {
          tempRootDeleted = false;
          cleanupNotices.push(`temp cleanup: ${errorMessage(error)}`);
        }
      }
    }
  }

  // ---- Cleanup confirmation ------------------------------------------------
  const desktopAppCleanup: ProcessCleanup = lastStop ?? {
    stopped: true,
    exitConfirmed: true,
  };
  const daemonPorts = launches
    .filter((launch) => launch.port !== null)
    .map((launch) => ({ port: launch.port as number, released: launch.portReleased }));
  const noWorkspace = (tempRoot as string | null) === null;
  cleanup = {
    desktopApp: desktopAppCleanup,
    daemonPorts,
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

  const requiredEvidence: readonly string[] =
    failure === null ? DESKTOP_REQUIRED_EVIDENCE : [DESKTOP_EVIDENCE.appLog];
  const presentEvidence = new Set(evidenceFiles.map((entry) => entry.path));
  const missingEvidence = requiredEvidence.filter((name) => !presentEvidence.has(name));
  if (missingEvidence.length > 0) {
    cleanupFailures.push(`missing required evidence: ${missingEvidence.join(", ")}`);
  }

  currentStep = { id: DESKTOP_STEP_IDS.cleanup, name: "cleanup and evidence" };
  const cleanupStartedAt = new Date().toISOString();
  const cleanupFailed = cleanupFailures.length > 0;
  steps.push({
    id: DESKTOP_STEP_IDS.cleanup,
    name: "App quit, daemon ports released, and evidence intact",
    status: cleanupFailed ? "failed" : "passed",
    startedAt: cleanupStartedAt,
    durationMs: 0,
    ...(cleanupFailed ? { error: cleanupFailures.join("; ") } : {}),
  });
  recordAssertion(
    DESKTOP_STEP_IDS.cleanup,
    "desktop app exit confirmed",
    true,
    desktopAppCleanup.exitConfirmed,
    desktopAppCleanup.exitConfirmed,
  );
  recordAssertion(
    DESKTOP_STEP_IDS.cleanup,
    "two launches recorded",
    ["first", "reopen"],
    launches.map((launch) => launch.phase),
    launches.length === 2,
  );
  for (const port of daemonPorts) {
    recordAssertion(
      DESKTOP_STEP_IDS.cleanup,
      `daemon port ${port.port} released`,
      true,
      port.released,
      port.released,
    );
  }
  recordAssertion(
    DESKTOP_STEP_IDS.cleanup,
    "temp workspace deleted or intentionally kept",
    "deleted or kept",
    { kept: cleanup.tempRoot.kept, deleted: cleanup.tempRoot.deleted },
    cleanup.tempRoot.kept || cleanup.tempRoot.deleted,
  );
  recordAssertion(
    DESKTOP_STEP_IDS.cleanup,
    "required evidence present",
    [...requiredEvidence].sort(),
    [...presentEvidence].sort(),
    missingEvidence.length === 0,
  );
  recordAssertion(
    DESKTOP_STEP_IDS.cleanup,
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
  const manifestWritten = await finishManifest(outcome, failure === null ? null : failure.message);
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

/** True when `url` is a daemon loopback origin (the page's own base URL). */
function isDaemonOrigin(url: string | null): boolean {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`[verify:desktop] unexpected harness error: ${errorMessage(error)}`);
    process.exitCode = 1;
  },
);
