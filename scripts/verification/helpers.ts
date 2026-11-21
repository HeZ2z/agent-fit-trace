/**
 * Pure helpers for the real-app acceptance harness (`scripts/verify-app-flow.ts`).
 *
 * Everything here is deterministic and side-effect free so the harness can be
 * unit-tested without spawning Chrome or the daemon: evidence/manifest
 * construction and hashing, provenance parsing, locale-tolerant metric text
 * parsing, semantic selector builders, Chrome discovery precedence,
 * listening-line parsing, guest public-config validation, and the exit-code
 * contract.
 *
 * Keep this file erasable TypeScript (no enum / parameter properties): the
 * repository typechecks and runs it with Node's type stripping.
 */

import { createHash } from "node:crypto";
import path from "node:path";

/** Exit codes the harness contract exposes to CI and humans. */
export type VerificationOutcome =
  | "passed"
  | "failed"
  | "build-missing"
  | "chrome-missing"
  | "precondition-missing";

/** The one scenario this harness drives; recorded so evidence is self-describing. */
export const SCENARIO_ID = "guest-app-log-analyze" as const;

/** The packaged-desktop scenario id (`scripts/verify-desktop.ts`). */
export const DESKTOP_SCENARIO_ID = "desktop-app-log-reopen" as const;

/** Version of the manifest document written by this harness. */
export const MANIFEST_SCHEMA = 2 as const;

/**
 * Map a harness outcome to its process exit code.
 *
 * 0 = every step passed, 1 = a real failure, 2 = the built app shell or packaged
 * app is missing (run `pnpm build` / `desktop:build` + `package:dir`),
 * 3 = no Chrome was found (skipped, not a pass; browser scenario only).
 */
export function exitCodeForOutcome(outcome: VerificationOutcome): number {
  switch (outcome) {
    case "passed":
      return 0;
    case "failed":
      return 1;
    case "build-missing":
    case "precondition-missing":
      return 2;
    case "chrome-missing":
      return 3;
  }
}

/**
 * A filesystem-safe UTC timestamp for the default evidence directory, e.g.
 * `2026-11-21T10-14-05-123Z`. Colons and dots are not portable in some archive
 * tooling, so they are replaced rather than stripped.
 */
export function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Default evidence directory under the repository root. */
export function defaultEvidenceDir(repoRoot: string, now: Date): string {
  return path.join(repoRoot, ".fit-trace", "verification", utcTimestamp(now));
}

/**
 * Parse the first number in a metric line, tolerating thousands separators
 * (`"Volume: 1,237.5 kg"` → `1237.5`). Returns null when the line has no
 * numeric value (for example a localized `"n/a"`).
 */
export function parseMetricNumber(text: string): number | null {
  const cleaned = text.replace(/[\u00a0\u202f]/g, " ");
  // Grouping-aware: `1,237.5` and `1 237.5` both parse as 1237.5, while a
  // plain `1237.5` keeps its digits together.
  const match = /-?\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/.exec(cleaned);
  if (match === null) return null;
  const value = Number(match[0].replace(/[ ,]/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** Parse the first integer in a sentence (e.g. source-record counts). */
export function parseInteger(text: string): number | null {
  const match = /\d[\d,]*/.exec(text.replace(/\u00a0/g, " "));
  if (match === null) return null;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isSafeInteger(value) ? value : null;
}

/** True when this is the daemon's zero-config local guest public config. */
export function isGuestPublicConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    record.daemon === true &&
    record.auth_configured === false &&
    !("supabaseUrl" in record) &&
    !("supabasePublishableKey" in record)
  );
}

/**
 * Parse the daemon's canonical startup announcement:
 * `fit-trace daemon listening at http://127.0.0.1:<port>`.
 */
export function parseListeningLine(text: string): string | null {
  const match = /^fit-trace daemon listening at (\S+)$/m.exec(text);
  return match === null ? null : match[1];
}

/** Dependencies for Chrome discovery, injected so precedence is unit-testable. */
export interface ChromeDiscoveryDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  exists: (candidate: string) => boolean;
  which: (command: string) => string | null;
}

/** macOS bundle path. */
const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** PATH command names, checked in this order. */
const PATH_COMMANDS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/**
 * Resolve a Chrome binary in the documented precedence order:
 * `FIT_TRACE_CHROME` → macOS app bundle → PATH → common Windows install paths.
 * Returns null when none of the candidates exist.
 */
export function discoverChrome(deps: ChromeDiscoveryDeps): string | null {
  const explicit = deps.env.FIT_TRACE_CHROME?.trim();
  if (explicit !== undefined && explicit !== "" && deps.exists(explicit)) return explicit;

  if (deps.platform === "darwin" && deps.exists(MACOS_CHROME)) return MACOS_CHROME;

  for (const command of PATH_COMMANDS) {
    const located = deps.which(command);
    if (located !== null && located !== "") return located;
  }

  if (deps.platform === "win32") {
    const programFiles = deps.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = deps.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = deps.env.LOCALAPPDATA;
    const candidates = [
      path.win32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(localAppData === undefined || localAppData === ""
        ? []
        : [path.win32.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")]),
    ];
    for (const candidate of candidates) {
      if (deps.exists(candidate)) return candidate;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Where the tested build came from, so a passing manifest is self-describing. */
export interface Provenance {
  /** `git rev-parse HEAD`; `"unknown"` outside a git checkout. */
  testedSha: string;
  /** `git rev-parse --abbrev-ref HEAD`; `"unknown"` outside a git checkout. */
  branch: string;
  /** True when `git status --porcelain` listed anything. A dirty tree may pass. */
  dirty: boolean;
  /** Number of `git status --porcelain` entries (renames count once). */
  dirtyFileCount: number;
  /** Deterministic sha256 over `app/dist` (sorted relative paths + file bytes). */
  artifactSha256: string;
  nodeVersion: string;
  chromeVersion: string | null;
  platform: string;
  arch: string;
}

/** What `git status --porcelain` tells us, without spawning git in tests. */
export interface GitStatusSummary {
  dirty: boolean;
  dirtyFileCount: number;
}

/**
 * Summarize `git status --porcelain` output. Each non-empty line is one entry;
 * a rename/copy is a single `old -> new` line, so it counts once.
 */
export function summarizeGitStatus(porcelain: string): GitStatusSummary {
  const dirtyFileCount = porcelain
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "").length;
  return { dirty: dirtyFileCount > 0, dirtyFileCount };
}

/** One file participating in the built-artifact digest. */
export interface ArtifactFile {
  /** POSIX-style path relative to `app/dist` (e.g. `assets/index-abc.js`). */
  path: string;
  bytes: Uint8Array;
}

/** Hex sha256 of arbitrary bytes (used for artifacts and evidence files). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Deterministic digest over the built app shell.
 *
 * Files are sorted by their relative path (ordinal, locale-independent) before
 * hashing, so directory-listing order never changes the digest. Each entry
 * contributes `path \0 byteLength \0 bytes \0`, which keeps path and content
 * boundaries unambiguous. Duplicate paths are rejected rather than silently
 * hashing one of them.
 */
export function computeArtifactDigest(files: readonly ArtifactFile[]): string {
  const sorted = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const hash = createHash("sha256");
  let previous: string | null = null;
  for (const file of sorted) {
    if (file.path === previous) {
      throw new Error(`duplicate artifact path: ${file.path}`);
    }
    previous = file.path;
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.bytes.byteLength), "utf8");
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Semantic DOM selectors used by the flow
// ---------------------------------------------------------------------------

/** The Log Workout screen root. */
export const LOG_SCREEN_SELECTOR = '[data-screen="log"]';
/** The first exercise card; `querySelector` returns document order. */
export const FIRST_EXERCISE_SELECTOR = `${LOG_SCREEN_SELECTOR} .exercise-editor`;
/** The exercise-name combobox input. */
export const COMBOBOX_SELECTOR = `${LOG_SCREEN_SELECTOR} input[role="combobox"]`;
/** The form's submit button (the one "Save workout" control). */
export const SUBMIT_BUTTON_SELECTOR = `${LOG_SCREEN_SELECTOR} form button[type="submit"]`;
/** The session date field. */
export const DATE_FIELD_SELECTOR = "#workout-date";
/** The manual duration field (untimed draft only). */
export const DURATION_FIELD_SELECTOR = "#workout-duration-minutes";
/** Analysis metric hooks rendered by `AnalysisView`. */
export type AnalysisMetric =
  | "sessions"
  | "sets"
  | "reps"
  | "volume"
  | "avg_rpe"
  | "avg_rest"
  | "max_gap";

/** The fixed metric order rendered by `AnalysisView`. */
export const ANALYSIS_METRICS: readonly AnalysisMetric[] = [
  "sessions",
  "sets",
  "reps",
  "volume",
  "avg_rpe",
  "avg_rest",
  "max_gap",
];

/** Exercise field suffixes the editor renders for every set. */
export type ExerciseField = "weight" | "reps" | "rpe";

/**
 * Selector for a field of the FIRST exercise's FIRST set, without hardcoding
 * the draft's internal key. `querySelector` returns the first match in document
 * order, which is the first set of the first exercise card.
 */
export function exerciseFieldSelector(field: ExerciseField): string {
  return `${FIRST_EXERCISE_SELECTOR} input[id$="-${field}"]`;
}

/** Selector for one analysis metric, read by key rather than by index. */
export function metricSelector(metric: AnalysisMetric): string {
  return `[data-screen="analysis"] ul.analysis-metrics li[data-metric="${metric}"]`;
}

/** Selector for the source-record count line. */
export const SOURCE_COUNT_SELECTOR = '[data-screen="analysis"] [data-metric="sources"]';

/** Selector for the exercise suggestion option of one canonical name. */
export function exerciseOptionSelector(canonicalName: string): string {
  return `li[role="option"][data-exercise-name=${JSON.stringify(canonicalName)}]`;
}

/**
 * Extract the saved record id from a `/workout/<id>` pathname.
 *
 * The id is decoded exactly once (React Router matches the encoded segment);
 * `/workout/new` and any other route return null.
 */
export function recordIdFromPathname(pathname: string): string | null {
  const match = /^\/workout\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  const raw = match[1];
  if (raw === "new") return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
}

/** The record id a history anchor links to, or null when it is not a record link. */
export function recordIdFromHref(href: string): string | null {
  const withoutOrigin = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  const withoutQuery = withoutOrigin.split(/[?#]/, 1)[0];
  return recordIdFromPathname(withoutQuery);
}

/** Leading ISO date of a history row's link text (`YYYY-MM-DD — …`). */
export function historyRowDate(text: string): string | null {
  const match = /^\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  return match === null ? null : match[1];
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** One harness step, recorded in the manifest. */
export interface ManifestStep {
  /** Stable kebab-case identifier (e.g. `history-reload`). */
  id: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  durationMs: number;
  error?: string;
}

/** One concrete assertion, recorded with expected and observed values. */
export interface ManifestAssertion {
  /** `<stepId>.<slug>`; stable across runs and independent of display order. */
  id: string;
  /** The owning step's id. */
  step: string;
  name: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  /** Every harness assertion is required for a pass. */
  required: true;
}

/** Kebab-case slug used to build assertion ids. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `<stepId>.<slug>` — the assertion id convention. */
export function assertionId(stepId: string, name: string): string {
  return `${stepId}.${slugify(name)}`;
}

/** One evidence file with its size and content digest. */
export interface EvidenceEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** Hash a written evidence file so the manifest proves what it describes. */
export function evidenceEntry(pathName: string, bytes: Uint8Array): EvidenceEntry {
  return { path: pathName, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
}

/** Stop result for one child process the harness started. */
export interface ProcessCleanup {
  /** The stop request was issued (or no process existed). */
  stopped: boolean;
  /** `exitCode`/`signalCode` was observed after the stop, so the OS reaped it. */
  exitConfirmed: boolean;
}

/** The packaged `.app` tree the desktop scenario exercised. */
export interface DesktopArtifact {
  kind: "desktop-app";
  /** Absolute path to the `.app` bundle. */
  path: string;
  /** Deterministic sha256 over the bundle tree (see `computeAppTreeDigest`). */
  sha256: string;
  /** Regular files hashed (symlinks are hashed too, but not counted here). */
  fileCount: number;
  /** Total bytes of regular files. */
  bytes: number;
  /** `CFBundleShortVersionString`, or null when the plist was unreadable. */
  version: string | null;
  /** `CFBundleIdentifier`, or null when the plist was unreadable. */
  bundleId: string | null;
}

/** One app launch the desktop scenario performed. */
export interface LaunchRecord {
  phase: "first" | "reopen";
  pid: number | null;
  baseUrl: string | null;
  /** Loopback port of the daemon this launch used. */
  port: number | null;
  appVersion: string | null;
  /** Descendant process running `daemon.mjs`, when it could be observed. */
  daemonPid?: number;
  /** The app process was observed to exit. */
  exitConfirmed: boolean;
  /** The daemon port stopped accepting connections after the quit. */
  portReleased: boolean;
}

/** Post-quit confirmation for one loopback port. */
export interface DaemonPortCleanup {
  port: number;
  released: boolean;
}

/** Temp-workspace cleanup result. */
export interface TempRootCleanup {
  /** `--keep-data` asked for the workspace to survive. */
  kept: boolean;
  /** The recursive delete resolved and the directory is gone. */
  deleted: boolean;
}

/** Cleanup outcome for the manifest. */
export interface ManifestCleanup {
  /** Browser-scenario Chrome process; absent in the desktop scenario. */
  chrome?: ProcessCleanup;
  /** Browser-scenario daemon process; absent in the desktop scenario. */
  daemon?: ProcessCleanup;
  /** The packaged app the desktop scenario launched (its final launch). */
  desktopApp?: ProcessCleanup;
  /** Every daemon port a desktop launch had to release. */
  daemonPorts?: DaemonPortCleanup[];
  tempRoot: TempRootCleanup;
  error?: string;
}

/** A cleanup that must make the run fail, with human-readable reasons. */
export interface CleanupEvaluation {
  failed: boolean;
  reasons: string[];
}

/**
 * Enforce the cleanup contract: every process the scenario started must have a
 * confirmed exit, every desktop daemon port must be released, and the temp
 * workspace must be gone unless `--keep-data` asked for it.
 */
export function evaluateCleanup(cleanup: ManifestCleanup): CleanupEvaluation {
  const reasons: string[] = [];
  if (cleanup.chrome !== undefined && !cleanup.chrome.exitConfirmed) {
    reasons.push("chrome process exit was not confirmed");
  }
  if (cleanup.daemon !== undefined && !cleanup.daemon.exitConfirmed) {
    reasons.push("daemon process exit was not confirmed");
  }
  if (cleanup.desktopApp !== undefined && !cleanup.desktopApp.exitConfirmed) {
    reasons.push("desktop app process exit was not confirmed");
  }
  for (const port of cleanup.daemonPorts ?? []) {
    if (!port.released) reasons.push(`daemon port ${port.port} was not released`);
  }
  if (!cleanup.tempRoot.kept && !cleanup.tempRoot.deleted) {
    reasons.push("temporary workspace was not deleted");
  }
  return { failed: reasons.length > 0, reasons };
}

/** Everything the manifest needs; `buildManifest` adds schema and scenario. */
export interface ManifestInput {
  startedAt: string;
  finishedAt: string;
  provenance: Provenance;
  baseUrl: string | null;
  evidenceDir: string;
  dataDir: string | null;
  outcome: VerificationOutcome;
  steps: ManifestStep[];
  assertions: ManifestAssertion[];
  evidence: EvidenceEntry[];
  cleanup: ManifestCleanup | null;
  error?: string | null;
  /** Defaults to the browser scenario's id. */
  scenarioId?: string;
  /** Packaged `.app` tree the desktop scenario exercised. */
  artifact?: DesktopArtifact | null;
  /** App launches the desktop scenario performed. */
  launches?: LaunchRecord[];
}

/** The JSON document written to `<evidence>/manifest.json`. */
export interface Manifest extends ManifestInput {
  schema: typeof MANIFEST_SCHEMA;
  scenarioId: string;
}

/**
 * Build the manifest without mutating the caller's arrays. Undefined optional
 * fields are omitted by `JSON.stringify`, keeping the document stable.
 */
export function buildManifest(input: ManifestInput): Manifest {
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    ...input,
    scenarioId: input.scenarioId ?? SCENARIO_ID,
    provenance: { ...input.provenance },
    steps: input.steps.map((step) => ({ ...step })),
    assertions: input.assertions.map((assertion) => ({ ...assertion })),
    evidence: input.evidence.map((entry) => ({ ...entry })),
    ...(input.artifact === undefined || input.artifact === null
      ? {}
      : { artifact: { ...input.artifact } }),
    ...(input.launches === undefined
      ? {}
      : { launches: input.launches.map((launch) => ({ ...launch })) }),
    cleanup:
      input.cleanup === null
        ? null
        : {
            ...(input.cleanup.chrome === undefined
              ? {}
              : { chrome: { ...input.cleanup.chrome } }),
            ...(input.cleanup.daemon === undefined
              ? {}
              : { daemon: { ...input.cleanup.daemon } }),
            ...(input.cleanup.desktopApp === undefined
              ? {}
              : { desktopApp: { ...input.cleanup.desktopApp } }),
            ...(input.cleanup.daemonPorts === undefined
              ? {}
              : {
                  daemonPorts: input.cleanup.daemonPorts.map((port) => ({ ...port })),
                }),
            tempRoot: { ...input.cleanup.tempRoot },
            ...(input.cleanup.error === undefined ? {} : { error: input.cleanup.error }),
          },
  };
  // `...input` carries an explicit `undefined`/`null` key through. Drop it so
  // the JSON document (not just the serialized form) omits scenario-specific
  // fields the run did not produce.
  if (manifest.artifact === undefined || manifest.artifact === null) delete manifest.artifact;
  if (manifest.launches === undefined) delete manifest.launches;
  return manifest;
}
