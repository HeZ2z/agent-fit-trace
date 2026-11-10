/**
 * In-memory coaching run service: session/snapshot/run/event lifecycle.
 *
 * Owns NOTHING over the wire (see `coachingServer.ts`): every method takes
 * an already-verified {@link AuthPrincipal} and binds sessions, snapshots,
 * and runs to `principal.id`. Client-supplied `snapshot.accountId` is NEVER
 * trusted — it must equal the verified principal and match a stored snapshot
 * created for that principal via `createSnapshot`.
 *
 * Runtime is injectable (`RuntimeFactory`): production wires
 * `CoachedPiProcess`, tests inject fakes — no real pi in unit tests.
 *
 * Lifecycle confirmation: global capacity and per-run snapshot dirs are
 * released ONLY after the runtime reports `onDone` with
 * `processExitConfirmed === true`. An unconfirmed termination withholds
 * success (a `completed` report becomes `failed`), keeps the runtime handle
 * and snapshot, and keeps capacity held so no orphaned child is ever
 * silently forgotten. Cancel always wins over a late completion, and the
 * cancel grace path invokes `close()` and awaits its confirmation.
 *
 * A runtime `terminal` event payload is only an INTENT: it is buffered and
 * the single terminal event is emitted by the confirmed `onDone` (cancel,
 * cap-seal, and tool-refusal outcomes win over the intent). Late
 * nonterminal payloads after an intent are dropped, so clients observe
 * exactly one terminal.
 *
 * Snapshots: the snapshot store keeps source records only, for a bounded
 * lifetime (`snapshotTtlMs`). Every run writes its own fresh immutable
 * validated file (`writeSnapshotDir`) — snapshot handles are never reused
 * across runs after a file is unlinked. Idempotent replay outlives the
 * snapshot: a retained run resolves from its OWN canonical stored snapshot,
 * so an identical retry returns that same run (no runtime launch) after the
 * handle expires. The incoming prompt/runtime/ref is compared against that
 * stored canonical request (never blindly substituted), and a NEW run always
 * requires an owned live snapshot. Native pi session state (session
 * dir + last native handle) belongs to the product session/account and is
 * passed to subsequent launches of that session for resume.
 *
 * Expiry runs on every read/write AND on an automatic bounded sweep timer,
 * so retention applies even with no subsequent calls. Confirmed-terminal
 * runs are swept after `retentionMs`; idle sessions with no runs left go
 * with their private dir; unused snapshots go after `snapshotTtlMs`.
 * Terminal-but-unconfirmed runs (and any session still referenced by a
 * run) are never swept — a live child may hold the files.
 *
 * The fixed-upstream workout reader lives ONLY in `coachingServer.ts`
 * (`createAuthenticatedUpstreamSource`: bearer-required, fixed `{ data }`
 * envelope, bounded body, URL validation, 401/403 vs 503 split). This
 * module carries no second copy: the test seam is `storeFactorySource` and
 * production wiring injects its source via `CoachingServiceOptions.source`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import type {
  CoachingBackendId,
  CoachingCapabilityDiscovery,
  CoachingCloudQuota,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingEventPayload,
  CoachingRun,
  CoachingRunStatus,
  CoachingRuntimeId,
  CoachingSession,
  CoachingSnapshotReference,
  CoachingTerminalStatus,
  CoachingTrustedIdentity,
  SubmitCoachingRunInput,
} from "@agent-fit-trace/api-contracts";
import {
  COACHED_TOOL_NAMES,
  COACHING_PROTOCOL_VERSION,
  COACHING_SSE_RESERVED_FRAME_BYTES,
  COACHING_SSE_TERMINAL_RESERVE_BYTES,
  MAX_COACHING_SESSION_ID_LENGTH,
  MAX_COACHING_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  boundCoachingDiagnostic,
  coachingEventFrameBytes,
  isTerminalStatus,
  nextRunStatus,
  parseAnalysisResult,
  parseCoachingEventPayload,
  qualifyCloudBackend,
  resolveCoachingBackendSelection,
} from "@agent-fit-trace/api-contracts";
import { MalformedResponseError } from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import {
  assertOrderedDateRange,
  assertValidFilterDate,
  filterRecords,
  ValidationError,
} from "@agent-fit-trace/core";
import type { PrincipalStoreFactory } from "../auth/verifier.ts";
import {
  asCoachingRuntimeRegistry,
  buildCoachingDiscovery,
  NATIVE_SESSION_VERSION_BY_BACKEND,
} from "./runtimeRegistry.ts";
import type {
  CoachingRuntimeRegistration,
  CoachingRuntimeRegistry,
  RuntimeDoneInfo,
  RuntimeFactory,
  RuntimeHandle,
  RuntimeLaunchOptions,
} from "./runtimeRegistry.ts";
import { cleanupSnapshotDir, writeSnapshotDir } from "./snapshotFile.ts";
import type { SnapshotDir } from "./snapshotFile.ts";
import { canonicalizeCoachingSubmit } from "./coachingCanonical.ts";
import {
  CoachingJournalCorruptError,
  loadCoachingJournal,
  writeCoachingJournal,
} from "./coachingJournal.ts";
import type {
  CoachingJournalIdempotency,
  CoachingJournalRun,
  CoachingJournalSession,
  CoachingJournalSnapshot,
  CoachingJournalState,
} from "./coachingJournal.ts";

export type {
  RuntimeDoneInfo,
  RuntimeFactory,
  RuntimeHandle,
  RuntimeLaunchOptions,
} from "./runtimeRegistry.ts";

/** Per-request read context. The bearer token is ephemeral: it is used only
 * as an `Authorization` header value against the fixed server-configured
 * upstream for this read, never stored and never forwarded to the runtime. */
export interface WorkoutReadContext {
  bearerToken?: string;
}

/** Server-side workout read for the verified principal (never browser records). */
export interface WorkoutSource {
  listWorkouts(principal: AuthPrincipal, ctx?: WorkoutReadContext): Promise<WorkoutRecord[]>;
}

/** Thrown when the workout source is unreachable/rejects: maps to 503, never
 * 400 and never an empty-history impersonation. */
export class WorkoutSourceUnavailable extends Error {
  constructor(message = "Workout history is temporarily unavailable.") {
    super(message);
    this.name = "WorkoutSourceUnavailable";
  }
}

/** Test-seam source reading isolated per-principal memory stores. */
export function storeFactorySource(stores: PrincipalStoreFactory): WorkoutSource {
  return {
    listWorkouts(principal: AuthPrincipal): Promise<WorkoutRecord[]> {
      return stores.storeFor(principal).listWorkouts();
    },
  };
}

export interface CoachingServiceOptions {
  source: WorkoutSource;
  /**
   * Legacy local-pi factory. Retained for v1 compatibility and existing
   * launcher wiring; it is never used as a silent fallback for another
   * backend. Prefer `runtimeRegistry` for all new backends.
   */
  runtimeFactory?: RuntimeFactory;
  /** Registered backends (metadata + optional factories). */
  runtimeRegistry?: CoachingRuntimeRegistry | readonly CoachingRuntimeRegistration[];
  /**
   * #5 seam: authoritative account classification from the validated
   * identity layer. Returning null/undefined keeps cloud qualification
   * closed. Request bodies or guest flags must never supply this.
   */
  trustedIdentity?: (principal: AuthPrincipal) => CoachingTrustedIdentity | null | undefined;
  /** Server-configured cloud quota; absent/unconfigured fails closed. */
  cloudQuota?: CoachingCloudQuota | null;
  /** True only when a real cloud provider adapter is configured. */
  cloudProviderConfigured?: boolean;
  /**
   * Backend a run should use when it names none, published in discovery so a
   * client can preselect it.
   *
   * Server-configured only (the daemon's `--runtime`); never read from a
   * request. It does NOT change how an unnamed run resolves — the shared
   * contract still maps that to `local-pi` — so the client must send the id
   * explicitly. Storing the choice without publishing it is what let an
   * operator's `--runtime codex` be silently ignored.
   */
  defaultBackendId?: CoachingBackendId;
  automaticLocalDefault?: boolean;
  /** Max stored events per run (tripping the cap fails the run explicitly). */
  maxEventsPerRun?: number;
  /** Max stored event bytes per run (UTF-8 frame bytes; tripping the cap fails the run explicitly). */
  maxEventBytesPerRun?: number;
  /** Max retained runs; oldest terminal runs evicted first. */
  maxRuns?: number;
  /** Max product sessions per account. */
  maxSessionsPerAccount?: number;
  /** Max live snapshots per account. */
  maxSnapshotsPerAccount?: number;
  /** Max records materialized into one snapshot (most recent by date win). */
  maxRecordsPerSnapshot?: number;
  /** Terminal-run retention before expiry/deletion. */
  retentionMs?: number;
  /** Unused-snapshot lifetime: source records persist only this long. */
  snapshotTtlMs?: number;
  /** Grace for a runtime to report terminal after cancel() before close(). */
  cancelGraceMs?: number;
  /** Snapshot source label attached to created snapshots. */
  snapshotSource?: string;
  /**
   * Test seam for the per-run snapshot workspace writer: replaces the real
   * validated {@link writeSnapshotDir} so tests can bound/observe the awaited
   * workspace write window. Production never overrides it.
   */
  writeSnapshot?: (records: WorkoutRecord[]) => Promise<SnapshotDir>;
  /**
   * Durable local journal path. The launcher defaults to
   * `.pi/fit-trace/coaching-journal.json` in the process cwd; omitted/null
   * keeps the service in-process only (direct unit tests).
   */
  journalPath?: string | null;
}

export const DEFAULT_MAX_EVENTS_PER_RUN = 1000;
/**
 * Per-run content budget: the shared SSE total minus the terminal reserve, so
 * any run the service accepts fits the stream the client reads.
 */
export const DEFAULT_MAX_EVENT_BYTES_PER_RUN =
  MAX_COACHING_SSE_TOTAL_BYTES - COACHING_SSE_TERMINAL_RESERVE_BYTES;

/**
 * Normalize `maxEventBytesPerRun` to a SAFE FINITE bound: a non-finite value
 * (`NaN`/`±Infinity`, which defeats `Math.min` and leaves the cap untripped) or
 * a negative one falls back to {@link DEFAULT_MAX_EVENT_BYTES_PER_RUN}, and a
 * finite value above it is clamped down so the service never accepts more
 * content than the client will read.
 */
export function normalizeMaxEventBytesPerRun(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_EVENT_BYTES_PER_RUN;
  }
  return Math.min(value, DEFAULT_MAX_EVENT_BYTES_PER_RUN);
}

export const DEFAULT_MAX_RUNS = 200;
export const DEFAULT_MAX_SESSIONS_PER_ACCOUNT = 50;
export const DEFAULT_MAX_SNAPSHOTS_PER_ACCOUNT = 50;
export const DEFAULT_MAX_RECORDS_PER_SNAPSHOT = 5000;
export const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
export const DEFAULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/**
 * Native engine handles are opaque ids, never paths, and are bounded. The
 * service stores them per backend and only replays one to the same backend.
 */
export function isSafeNativeSessionHandle(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}
export const DEFAULT_CANCEL_GRACE_MS = 5000;

export const COACHED_SERVICE_ALLOWLIST = COACHED_TOOL_NAMES;

function isServiceToolAllowed(tool: string): boolean {
  return (COACHED_SERVICE_ALLOWLIST as readonly string[]).includes(tool);
}

export const EMPTY_HISTORY_REASON =
  "empty-history: record a workout first — no analysis was started";

export type ServiceErrorCode =
  | "SESSION_NOT_FOUND"
  | "SNAPSHOT_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "IDEMPOTENCY_CONFLICT"
  | "RUN_BUSY"
  | "STORAGE_UNAVAILABLE"
  | "EXPIRED_CURSOR";

export class CoachingServiceError extends Error {
  readonly code: ServiceErrorCode;
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "CoachingServiceError";
    this.code = code;
  }
}

type StoredSession = CoachingJournalSession;

type StoredSnapshot = CoachingJournalSnapshot;

interface StoredRun extends CoachingJournalRun {
  runtime: RuntimeHandle | null;
  /** This run's OWN fresh snapshot dir (never shared, never reused). */
  snapshotDir: string | null;
}

export interface CoachingService {
  createSession(principal: AuthPrincipal, id?: string): CoachingSession;
  readSession(principal: AuthPrincipal, id: string): CoachingSession;
  createSnapshot(
    principal: AuthPrincipal,
    filter?: { from?: string; to?: string },
    ctx?: WorkoutReadContext,
  ): Promise<CoachingDataSnapshot>;
  submitRun(
    principal: AuthPrincipal,
    input: SubmitCoachingRunInput,
  ): Promise<{ run: CoachingRun; lastSeq: number; replayed: boolean; created: boolean }>;
  readRun(
    principal: AuthPrincipal,
    runId: string,
  ): { run: CoachingRun; lastSeq: number; firstSeq: number; expiresAt: number };
  readEvents(
    principal: AuthPrincipal,
    runId: string,
    fromSeq?: number,
  ): { events: CoachingEventEnvelope[]; run: CoachingRun; lastSeq: number; firstSeq: number; expiresAt: number };
  cancelRun(principal: AuthPrincipal, runId: string, reason?: string): { run: CoachingRun; lastSeq: number };
  /** Versioned backend capability discovery for the verified caller. */
  discoverBackends(principal: AuthPrincipal): CoachingCapabilityDiscovery;
  /** Logout support: cancel the caller's active runs and drop their sessions/snapshots. */
  logoutAccount(principal: AuthPrincipal): Promise<void>;
  activeRunCount(): number;
  runCount(): number;
  shutdown(): Promise<void>;
}

export function createCoachingService(options: CoachingServiceOptions): CoachingService {
  const maxEventsPerRun = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;
  // Normalize a possibly non-finite/out-of-range override: a run the service
  // accepts must fit the client's total stream budget, so `maxEventBytesPerRun`
  // is clamped to `total - terminal reserve` and NaN/Infinity/negative values
  // fall back to that bound instead of defeating the cap.
  const maxEventBytesPerRun = normalizeMaxEventBytesPerRun(options.maxEventBytesPerRun);
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const maxSessionsPerAccount = options.maxSessionsPerAccount ?? DEFAULT_MAX_SESSIONS_PER_ACCOUNT;
  const maxSnapshotsPerAccount = options.maxSnapshotsPerAccount ?? DEFAULT_MAX_SNAPSHOTS_PER_ACCOUNT;
  const maxRecordsPerSnapshot = options.maxRecordsPerSnapshot ?? DEFAULT_MAX_RECORDS_PER_SNAPSHOT;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const snapshotSource = options.snapshotSource ?? "authenticated-store";
  const writeSnapshot = options.writeSnapshot ?? writeSnapshotDir;
  const runtimeRegistry = asCoachingRuntimeRegistry(options.runtimeRegistry);
  const legacyRuntimeFactory = options.runtimeFactory;

  /**
   * Resolve ONE registration for a backend. An EXPLICIT registry entry always
   * wins, including an unavailable local-pi entry, so discovery and submit
   * cannot disagree. The legacy factory is only a fallback when the registry
   * has no local-pi entry at all; it never backs codex/opencode/cloud.
   */
  function resolveRuntimeRegistration(backendId: CoachingBackendId): {
    factory: RuntimeFactory;
    available: boolean;
    unavailableMessage?: string;
  } {
    const registration = runtimeRegistry.get(backendId);
    if (registration !== undefined) {
      if (!registration.available) {
        throw new CoachingServiceError(
          "VALIDATION_ERROR",
          registration.unavailableReason?.message ?? `Coaching backend ${backendId} is unavailable.`,
        );
      }
      if (registration.factory === undefined) {
        throw new CoachingServiceError("VALIDATION_ERROR", `Coaching backend ${backendId} has no runtime adapter.`);
      }
      return { factory: registration.factory, available: true };
    }
    if (backendId === "local-pi" && legacyRuntimeFactory !== undefined) {
      return { factory: legacyRuntimeFactory, available: true };
    }
    throw new CoachingServiceError("VALIDATION_ERROR", `Coaching backend ${backendId} is not configured.`);
  }

  /** Fail-closed cloud gate used by BOTH discovery and run submission. */
  function cloudQualification(principal: AuthPrincipal) {
    const identity = options.trustedIdentity?.(principal) ?? null;
    return qualifyCloudBackend({
      identity,
      quota: options.cloudQuota ?? null,
      providerConfigured: options.cloudProviderConfigured === true,
    });
  }

  const sessions = new Map<string, StoredSession>();
  const snapshots = new Map<string, StoredSnapshot>();
  const runs = new Map<string, StoredRun>();
  // Idempotency scope: account + session; compare canonical whole content.
  const idempotency = new Map<string, string>();
  const cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Outstanding close-confirmation timeouts (cleared on settle + shutdown). */
  const closeTimers = new Set<ReturnType<typeof setTimeout>>();
  let globalActive = 0;
  let shutDown = false;

  const journalPath = options.journalPath ?? null;
  let journalGeneration = 0;

  function journalState(): CoachingJournalState {
    const idempotencyEntries: CoachingJournalIdempotency[] = [];
    for (const runId of idempotency.values()) {
      const stored = runs.get(runId);
      if (stored === undefined) continue;
      idempotencyEntries.push({
        accountId: stored.accountId,
        sessionId: stored.run.sessionId,
        key: stored.run.idempotencyKey,
        runId,
      });
    }
    return {
      sessions: [...sessions.values()].map((session) => structuredClone(session)),
      snapshots: [...snapshots.values()].map((snapshot) => ({
        snapshot: structuredClone(snapshot.snapshot),
        accountId: snapshot.accountId,
        records: snapshot.records.map((record) => structuredClone(record)),
        expiresAt: snapshot.expiresAt,
      })),
      // The live runtime handle is process state, never journal state.
      runs: [...runs.values()].map(({ runtime: _runtime, ...stored }) => structuredClone(stored)),
      idempotency: idempotencyEntries,
    };
  }

  /** Flush the current product state before acknowledging a mutation. */
  function persistJournal(): void {
    if (journalPath === null) return;
    try {
      journalGeneration = writeCoachingJournal(journalPath, journalGeneration, journalState());
    } catch (error) {
      if (error instanceof CoachingJournalCorruptError) throw error;
      throw new CoachingServiceError("STORAGE_UNAVAILABLE", "The coaching journal is temporarily unavailable.");
    }
  }

  function hydrateJournal(): void {
    if (journalPath === null) return;
    const loaded = loadCoachingJournal(journalPath);
    journalGeneration = loaded.generation;
    for (const session of loaded.state.sessions) sessions.set(session.id, session);
    for (const snapshot of loaded.state.snapshots) {
      snapshots.set(snapshot.snapshot.snapshotId, snapshot);
    }
    for (const stored of loaded.state.runs) {
      runs.set(stored.run.id, { ...stored, runtime: null });
    }
    for (const entry of loaded.state.idempotency) {
      idempotency.set(idemKey(entry.accountId, entry.sessionId, entry.key), entry.runId);
    }
    globalActive = [...runs.values()].filter((stored) => stored.capacityHeld).length;
    // A process restart loses every runtime handle. A run that was still
    // active cannot be adopted: mark it execution-unconfirmed, keep its
    // capacity (so no second process is spawned) and retain its history.
    for (const stored of [...runs.values()]) {
      if (stored.terminated) continue;
      applyTerminal(
        stored,
        "failed",
        "process execution unconfirmed after server restart; outcome unknown",
        false,
      );
    }
    expireSweep();
  }

  hydrateJournal();

  // Automatic expiry: idle retention applies even with no subsequent calls.
  // The interval scales with the configured lifetimes so small-TTL tests
  // observe sweeps promptly; the timer never keeps the process alive and
  // is cleared on shutdown.
  const sweepIntervalMs = Math.max(25, Math.min(60_000, retentionMs, snapshotTtlMs));
  const sweepTimer = setInterval(() => {
    if (shutDown) return;
    try {
      expireSweep();
    } catch {
      // A journal write failure must never escape a timer callback and kill
      // the process mid-stream. The next mutation retries persistence and
      // surfaces STORAGE_UNAVAILABLE if the filesystem is still unhealthy.
      clearInterval(sweepTimer);
    }
  }, sweepIntervalMs);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  function allocSessionDir(): string {
    const dir = mkdtempSync(`${tmpdir()}/fit-trace-sess-`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function isWithinDir(dir: string, file: string): boolean {
    try {
      const absDir = resolve(dir);
      const absFile = isAbsolute(file) ? resolve(file) : resolve(absDir, file);
      const rel = relative(absDir, absFile);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    } catch {
      return false;
    }
  }

  function cloneSession(session: StoredSession): CoachingSession {
    return { id: session.id };
  }

  function cloneRun(run: CoachingRun): CoachingRun {
    return structuredClone(run);
  }

  function cloneEvents(events: CoachingEventEnvelope[]): CoachingEventEnvelope[] {
    return structuredClone(events);
  }

  function idemKey(accountId: string, sessionId: string, key: string): string {
    return `${accountId}\n${sessionId}\n${key}`;
  }

  function lastSeqOf(stored: StoredRun): number {
    return stored.events.length - 1;
  }

  function getSessionOwned(principal: AuthPrincipal, id: string): StoredSession {
    const session = sessions.get(id);
    if (session === undefined || session.accountId !== principal.id) {
      throw new CoachingServiceError("SESSION_NOT_FOUND", "Coaching session not found.");
    }
    return session;
  }

  function getRunOwned(principal: AuthPrincipal, runId: string): StoredRun {
    const stored = runs.get(runId);
    if (stored === undefined || stored.accountId !== principal.id) {
      throw new CoachingServiceError("RUN_NOT_FOUND", "Coaching run not found.");
    }
    return stored;
  }

  /** Resolve a client-supplied handle to a live snapshot OWNED by the caller.
   * An expired entry is dropped from the map (never served, never reused) and
   * resolves to `null`; a live source mismatch is FORBIDDEN exactly as before.
   * `null` is fatal only for a NEW run: an owned retained run replays from its
   * own stored canonical snapshot after the snapshot lifetime has passed. */
  function resolveLiveSnapshot(
    principal: AuthPrincipal,
    ref: CoachingSnapshotReference,
  ): StoredSnapshot | null {
    const stored = snapshots.get(ref.snapshotId);
    if (stored === undefined) return null;
    if (stored.expiresAt <= Date.now()) {
      snapshots.delete(ref.snapshotId);
      return null;
    }
    if (stored.accountId !== principal.id) return null;
    if (stored.snapshot.source !== ref.source) {
      throw new CoachingServiceError("FORBIDDEN", "Snapshot source mismatch.");
    }
    return stored;
  }

  function releaseCapacity(stored: StoredRun): void {
    if (stored.capacityHeld) {
      stored.capacityHeld = false;
      stored.runtime = null;
      globalActive = Math.max(0, globalActive - 1);
    }
  }

  function evictOverflow(): void {
    if (runs.size <= maxRuns) return;
    const terminal = [...runs.values()]
      .filter((entry) => isTerminalStatus(entry.run.status) && entry.terminated && entry.cleanupConfirmed)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    for (const entry of terminal) {
      if (runs.size <= maxRuns) break;
      deleteRun(entry.run.id);
    }
  }

  function deleteRun(runId: string): void {
    const stored = runs.get(runId);
    if (stored === undefined) return;
    // Never delete the snapshot dir of a run whose cleanup is unconfirmed:
    // a live child may still hold the file.
    if (!stored.terminated || !stored.cleanupConfirmed) return;
    runs.delete(runId);
    for (const [key, id] of idempotency) {
      if (id === runId) idempotency.delete(key);
    }
    if (stored.snapshotDir !== null) {
      const dir = stored.snapshotDir;
      stored.snapshotDir = null;
      void cleanupSnapshotDir(dir).catch(() => undefined);
    }
    persistJournal();
  }

  function expireSweep(): void {
    const now = Date.now();
    // Bounded sweep (cap 50/sweep per map): expired terminal-CONFIRMED runs
    // go regardless of capacityHeld — a confirmed applyTerminal already
    // released capacity, so requiring it would leak every normal run — then
    // expired idle sessions (only when no run references them, so an
    // active/unconfirmed run's private dir is never deleted), then unused
    // snapshots. Terminal-but-unconfirmed runs are NEVER swept (a live
    // child may hold files); active runs holding capacity past retention
    // are force-cancelled via the grace path so capacity cannot leak
    // without a subsequent call.
    let removed = 0;
    for (const stored of [...runs.values()]) {
      if (removed >= 50) break;
      if (stored.terminated && stored.cleanupConfirmed && stored.expiresAt <= now) {
        deleteRun(stored.run.id);
        removed += 1;
      }
    }
    let sessRemoved = 0;
    for (const [id, session] of [...sessions.entries()]) {
      if (sessRemoved >= 50) break;
      if ((session.expiresAt ?? 0) > now) continue;
      const referenced = [...runs.values()].some((entry) => entry.run.sessionId === id);
      if (referenced) continue;
      sessions.delete(id);
      const dir = session.nativeSessionDir;
      void cleanupSnapshotDir(dir).catch(() => undefined);
      sessRemoved += 1;
    }
    let snapRemoved = 0;
    for (const [id, snapshot] of [...snapshots.entries()]) {
      if (snapRemoved >= 50) break;
      if (snapshot.expiresAt <= now) {
        snapshots.delete(id);
        snapRemoved += 1;
      }
    }
    if (sessRemoved > 0 || snapRemoved > 0) persistJournal();
  }

  /** The next envelope for a run: `seq` is the current log length and the
   * stream identity comes from the run. One place builds every stored event,
   * so all paths measure the SAME frame bytes. */
  function buildEventEnvelope(stored: StoredRun, event: CoachingEventPayload): CoachingEventEnvelope {
    return {
      protocolVersion: COACHING_PROTOCOL_VERSION,
      sessionId: stored.run.sessionId,
      runId: stored.run.id,
      seq: stored.events.length,
      event,
    };
  }

  /** Push an envelope and count its exact wire-frame bytes. Returns the bytes
   * added so callers can reason about the budget consistently. */
  function pushCountedEvent(stored: StoredRun, envelope: CoachingEventEnvelope): number {
    const bytes = coachingEventFrameBytes(envelope);
    stored.events.push(envelope);
    stored.eventBytes += bytes;
    return bytes;
  }

  /** Terminal transition. Capacity + snapshot release happen ONLY when
   * `confirmed` (runtime exit confirmed). Unconfirmed runs keep their handle,
   * snapshot dir, and capacity so orphans are visible, never silently freed. */
  function applyTerminal(
    stored: StoredRun,
    status: CoachingTerminalStatus,
    reason: string | undefined,
    confirmed: boolean,
  ): void {
    if (stored.terminated) return;
    stored.terminated = true;
    stored.terminalIntent = null;
    stored.cleanupConfirmed = confirmed;
    stored.processExitConfirmed = confirmed;
    let finalStatus: CoachingTerminalStatus = nextRunStatus(stored.run.status, status) as CoachingTerminalStatus;
    // Compose the FULL final reason first (caller/runtime-supplied text plus any
    // internal suffix), then bound it by the ENCODED terminal frame bytes below
    // so the frame — escapes + live session id included — fits the reserved
    // budget. Raw UTF-8 length under-counts JSON escapes by up to 6x.
    let candidateReason = reason;
    if (!confirmed && finalStatus === "completed") {
      // Success is withheld while the child may still be alive.
      finalStatus = "failed";
      candidateReason = candidateReason !== undefined
        ? `${candidateReason}: process exit unconfirmed; completion withheld`
        : "process exit unconfirmed; completion withheld";
    }
    const finalReason = candidateReason === undefined
      ? undefined
      : boundCoachingDiagnostic(
        (text) => buildEventEnvelope(stored, { type: "terminal", status: finalStatus, reason: text }),
        candidateReason,
        COACHING_SSE_RESERVED_FRAME_BYTES,
      ).text;
    stored.run = {
      ...stored.run,
      status: finalStatus,
      ...(finalStatus === "failed"
        ? { failure: { code: "RUN_FAILED", message: finalReason ?? "coached run failed" } }
        : {}),
    };
    // The terminal frame BYPASSES appendEvent (it is not subject to the content
    // cap), so it must be counted here with the same exact measure — content +
    // cap-seal + terminal then never exceeds the shared total budget.
    pushCountedEvent(stored, buildEventEnvelope(stored, {
      type: "terminal",
      status: finalStatus,
      ...(finalReason === undefined ? {} : { reason: finalReason }),
    }));
    stored.expiresAt = Date.now() + retentionMs;
    const timer = cancelTimers.get(stored.run.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      cancelTimers.delete(stored.run.id);
    }
    if (confirmed) {
      const handle = stored.runtime;
      releaseCapacity(stored);
      if (handle !== null) {
        try {
          void handle.close().catch(() => undefined);
        } catch {
          // Teardown is best-effort once confirmed.
        }
      }
    }
    evictOverflow();
    persistJournal();
  }

  /** A journal persistence failure (as opposed to a programming error). */
  function isJournalWriteFailure(error: unknown): boolean {
    return (
      error instanceof CoachingJournalCorruptError ||
      (error instanceof CoachingServiceError && error.code === "STORAGE_UNAVAILABLE")
    );
  }

  function journalFailureText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Record a journal persistence failure on the run so it is never silently
   * swallowed: the visible run failure (when one exists) and the internal
   * fatal state both name the storage problem. The last durable journal write
   * remains authoritative after a crash, so a restart re-reports the run as
   * execution-unconfirmed instead of losing it or claiming success.
   */
  function recordJournalFailure(stored: StoredRun, error: unknown): void {
    const detail = `coaching journal write failed (${journalFailureText(error)})`;
    if (stored.fatalError === null) {
      stored.fatalError = {
        code: "STORAGE_UNAVAILABLE",
        message: `${detail}; the last durable state is recovered as execution-unconfirmed after restart`,
      };
    }
    const failure = stored.run.failure;
    if (failure !== undefined && !failure.message.includes(detail)) {
      stored.run = {
        ...stored.run,
        failure: { code: failure.code, message: `${failure.message} (${detail})` },
      };
    }
  }

  /**
   * Apply a terminal transition from a runtime callback or another deferred
   * path. `applyTerminal` flushes the journal and may throw when the disk is
   * failing; letting that escape a stdout/socket callback (or reject an
   * unawaited close continuation) would kill the launcher while the child may
   * keep running. The in-memory terminal still applies, the storage failure is
   * recorded on the run, and the next successful mutation flushes it. The last
   * durable state stays recoverable and is never silently reset.
   */
  function applyTerminalSafely(
    stored: StoredRun,
    status: CoachingTerminalStatus,
    reason: string | undefined,
    confirmed: boolean,
  ): void {
    try {
      applyTerminal(stored, status, reason, confirmed);
    } catch (error) {
      if (!isJournalWriteFailure(error)) throw error;
      recordJournalFailure(stored, error);
    }
  }

  /**
   * Stop a run whose runtime callback could not flush the journal. The failure
   * is sealed as a `failed` intent (so later runtime payloads never retry the
   * failing write), the child is cancelled and bounded-closed, and the terminal
   * is applied only after that close settles (unconfirmed when it cannot), so
   * capacity is never silently freed while the process may still be alive. The
   * in-memory terminal stays honest; the last durable journal state (the active
   * run) is recovered as execution-unconfirmed after a restart.
   */
  function stopRunAfterJournalFailure(stored: StoredRun, error: unknown): void {
    recordJournalFailure(stored, error);
    if (stored.terminated) return;
    const reason = `coaching journal write failed during the run (${journalFailureText(error)})`;
    if (stored.sealed === null) {
      stored.sealed = { status: "failed", reason };
    }
    const handle = stored.runtime;
    if (handle === null) {
      if (stored.sealed.reason === reason) {
        applyTerminalSafely(stored, "failed", `${reason}; run outcome unconfirmed`, false);
      }
      return;
    }
    try {
      handle.cancel(reason);
    } catch {
      // Fall through to the bounded close below.
    }
    void (async () => {
      const confirmed = await closeConfirmed(handle);
      const current = runs.get(stored.run.id);
      if (current === undefined || current.terminated) return;
      const terminalReason = current.sealed?.reason ?? reason;
      applyTerminalSafely(
        current,
        current.sealed?.status ?? "failed",
        confirmed
          ? `${terminalReason}; the child was stopped but the journal update is unconfirmed`
          : `${terminalReason}; cleanup unconfirmed; snapshot retained`,
        confirmed,
      );
    })();
  }

  /** Settle a runtime's onDone: native ownership capture + the single terminal.
   * Called from the runtime callback boundary (see the launch wiring), which
   * catches journal persistence failures so they never escape the adapter. */
  function settleRuntimeDone(
    stored: StoredRun,
    status: CoachingTerminalStatus,
    reason?: string,
    info?: RuntimeDoneInfo,
  ): void {
    // Strict confirmation: only === true counts. Missing/false keeps
    // capacity + snapshot and withholds success.
    const confirmed = info?.processExitConfirmed === true;
    stored.processExitConfirmed = confirmed;
    const runBackendId = stored.run.backendId ?? "local-pi";
    const runRuntimeId = stored.run.runtimeId as CoachingRuntimeId;
    const runNativeVersion = NATIVE_SESSION_VERSION_BY_BACKEND[runBackendId];
    const owner = sessions.get(stored.run.sessionId);
    if (owner !== undefined && owner.accountId === stored.accountId && runNativeVersion !== undefined) {
      if (info?.sessionFile !== undefined && isWithinDir(owner.nativeSessionDir, info.sessionFile)) {
        owner.nativeSessionFile = info.sessionFile;
        delete owner.nativeSessionHandle;
        owner.nativeSessionBackendId = runBackendId;
        owner.nativeSessionRuntimeId = runRuntimeId;
        owner.nativeSessionVersion = runNativeVersion;
      }
      if (info?.nativeSessionHandle !== undefined && isSafeNativeSessionHandle(info.nativeSessionHandle)) {
        owner.nativeSessionHandle = info.nativeSessionHandle;
        delete owner.nativeSessionFile;
        owner.nativeSessionBackendId = runBackendId;
        owner.nativeSessionRuntimeId = runRuntimeId;
        owner.nativeSessionVersion = runNativeVersion;
      }
    }
    // Cancel wins over any late completion arriving during the grace.
    if (stored.cancelRequested) {
      applyTerminal(stored, "cancelled", stored.cancelReason ?? "cancel requested", confirmed);
      return;
    }
    if (stored.sealed !== null) {
      applyTerminal(stored, stored.sealed.status, stored.sealed.reason, confirmed);
      return;
    }
    // The buffered onEvent terminal intent resolves here: the single terminal
    // event comes only from applyTerminal below. onDone status/reason is the
    // fallback when no intent arrived (runtimes that only call onDone).
    const intent = stored.terminalIntent;
    const terminalStatus = intent?.status ?? status;
    const terminalReason = intent?.reason ?? reason;
    if (terminalStatus === "completed" && stored.toolRefused) {
      applyTerminal(stored, "failed", "a non-allowlisted tool was refused during this run", confirmed);
      return;
    }
    if (terminalStatus === "completed" && stored.fatalError !== null) {
      applyTerminal(stored, "failed", stored.fatalError.message, confirmed);
      return;
    }
    if (terminalStatus === "completed" && !stored.hasAnalysis) {
      applyTerminal(
        stored,
        "failed",
        "run completed without a validated analysis result",
        confirmed,
      );
      return;
    }
    applyTerminal(stored, terminalStatus, terminalReason, confirmed);
  }

  /** Stop the child after an event/byte cap trip; the terminal applies only
   * after close() confirms (or records unconfirmed when it rejects). */
  function sealRunForCap(stored: StoredRun, reason: string): void {
    if (stored.terminated || stored.sealed !== null) return;
    stored.sealed = { status: "failed", reason };
    // The cap-seal run_error also bypasses the content cap. Bound + count it so
    // the seal frame plus the terminal frame both fit the reserved headroom;
    // the bound measures ENCODED bytes (escapes + live session id included).
    const message = boundCoachingDiagnostic(
      (text) => buildEventEnvelope(stored, { type: "run_error", code: "EVENT_CAP", message: text }),
      reason,
      COACHING_SSE_RESERVED_FRAME_BYTES,
    ).text;
    pushCountedEvent(stored, buildEventEnvelope(stored, {
      type: "run_error",
      code: "EVENT_CAP",
      message,
    }));
    persistJournal();
    const handle = stored.runtime;
    if (handle !== null) {
      try {
        handle.cancel(reason);
      } catch {
        // Fall through to close().
      }
      void (async () => {
        const confirmed = await closeConfirmed(handle);
        const current = runs.get(stored.run.id);
        if (current === undefined || current.terminated) return;
        applyTerminalSafely(
          current,
          "failed",
          confirmed ? reason : `${reason} (cleanup unconfirmed; snapshot retained)`,
          confirmed,
        );
      })();
    } else {
      applyTerminalSafely(stored, "failed", reason, true);
    }
  }

  function appendEvent(stored: StoredRun, payload: CoachingEventPayload): void {
    if (stored.terminated || stored.sealed !== null || stored.terminalIntent !== null) return;
    const envelope = buildEventEnvelope(stored, payload);
    // Size the exact frame the server will write (UTF-8, metadata included). A
    // single event that cannot fit one frame is rejected explicitly (cap-seal →
    // safe terminal); it is never stored or truncated.
    const bytes = coachingEventFrameBytes(envelope);
    if (bytes > MAX_COACHING_SSE_FRAME_BYTES) {
      sealRunForCap(stored, "event exceeds the maximum SSE frame size");
      return;
    }
    if (stored.events.length >= maxEventsPerRun || stored.eventBytes + bytes > maxEventBytesPerRun) {
      // Caps are explicit: stop the child and fail the run — never silently drop.
      sealRunForCap(stored, "event cap exceeded");
      return;
    }
    pushCountedEvent(stored, envelope);
    if (payload.type !== "terminal" && stored.run.status === "queued") {
      stored.run = { ...stored.run, status: "running" };
    }
    persistJournal();
  }

  /** Validate runtime analysis output before forwarding; malformed analysis
   * and tool/result failures are tracked as fatal so a later completed
   * onDone becomes failed (except the empty-history path, which never runs).
   * A runtime `terminal` payload is only an INTENT: it is buffered (never
   * appended) until the confirmed onDone emits the single terminal event.
   * Late nonterminals after an intent are dropped so the terminal stays
   * exactly-once. Mirrors the real pi adapter (settle requires a validated
   * analysis and no pending/failed tools). */
  function appendRuntimeEvent(stored: StoredRun, raw: unknown): void {
    let payload: CoachingEventPayload;
    try {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new MalformedResponseError("event", "must be an object");
      }
      payload = parseCoachingEventPayload(raw as Record<string, unknown>);
    } catch {
      if (stored.terminated || stored.sealed !== null || stored.terminalIntent !== null) return;
      // An analysis_result envelope with a malformed result is a fatal
      // result failure (not a generic malformed event): record it so a
      // later completed onDone becomes failed with a clear reason.
      const asRecord = raw as Record<string, unknown>;
      if (typeof raw === "object" && raw !== null && (asRecord as { type?: unknown }).type === "analysis_result") {
        if (stored.fatalError === null) {
          stored.fatalError = { code: "INVALID_ANALYSIS", message: "runtime emitted a malformed analysis result" };
        }
        appendEvent(stored, {
          type: "run_error",
          code: "INVALID_ANALYSIS",
          message: "runtime emitted a malformed analysis result",
        });
        return;
      }
      sealRunForCap(stored, "runtime emitted a malformed event; run failed");
      return;
    }
    if (payload.type === "terminal") {
      // The real adapter emits onEvent(terminal) THEN onDone with the same
      // outcome: buffer the intent and wait for confirmation. First intent
      // wins; a sealed run ignores runtime intents (cap failure stands).
      if (stored.terminated || stored.sealed !== null) return;
      if (stored.terminalIntent === null) {
        stored.terminalIntent = {
          status: payload.status,
          ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        };
      }
      return;
    }
    if (stored.terminalIntent !== null) return;
    if (payload.type === "tool_start" && !isServiceToolAllowed(payload.tool)) {
      stored.toolRefused = true;
      appendEvent(stored, {
        type: "run_error",
        code: "TOOL_REFUSED",
        message: `tool ${JSON.stringify(payload.tool)} is not allowlisted for coached runs`,
      });
      return;
    }
    if (payload.type === "tool_end" && !isServiceToolAllowed(payload.tool)) {
      stored.toolRefused = true;
      appendEvent(stored, {
        type: "run_error",
        code: "TOOL_REFUSED",
        message: `tool ${JSON.stringify(payload.tool)} is not allowlisted for coached runs`,
      });
      return;
    }
    if (payload.type === "analysis_result") {
      try {
        parseAnalysisResult(payload.result);
      } catch {
        if (stored.fatalError === null) {
          stored.fatalError = { code: "INVALID_ANALYSIS", message: "runtime emitted a malformed analysis result" };
        }
        appendEvent(stored, {
          type: "run_error",
          code: "INVALID_ANALYSIS",
          message: "runtime emitted a malformed analysis result",
        });
        return;
      }
      stored.hasAnalysis = true;
      appendEvent(stored, payload);
      return;
    }
    if (payload.type === "tool_end" && payload.ok === false) {
      if (stored.fatalError === null) {
        stored.fatalError = { code: "TOOL_FAILED", message: payload.error };
      }
      appendEvent(stored, payload);
      return;
    }
    if (payload.type === "run_error") {
      if (stored.fatalError === null) {
        stored.fatalError = { code: payload.code, message: payload.message };
      }
      appendEvent(stored, payload);
      return;
    }
    appendEvent(stored, payload);
  }

  function forceCancelAfterGrace(runId: string): void {
    const stored = runs.get(runId);
    if (stored === undefined || stored.terminated) return;
    const handle = stored.runtime;
    if (handle === null) {
      applyTerminalSafely(stored, "cancelled", stored.cancelReason ?? "cancel requested", true);
      return;
    }
    // Cancel grace invokes close() and awaits its confirmation (bounded: a
    // kill-refusing runtime times out instead of hanging teardown): cancel
    // wins over any late completion, and capacity releases only when
    // confirmed. This runs from a timer, so a journal failure is recorded on
    // the run instead of escaping as an uncaught exception.
    void (async () => {
      const confirmed = await closeConfirmed(handle);
      const current = runs.get(runId);
      if (current === undefined || current.terminated) return;
      const reason = current.cancelReason ?? "cancel requested";
      applyTerminalSafely(
        current,
        "cancelled",
        confirmed ? reason : `${reason} (cleanup unconfirmed; snapshot retained)`,
        confirmed,
      );
    })();
  }

  /** Await close() with a bound: true only on resolved close (confirmed
   * cleanup). A rejecting or never-settling close is unconfirmed — the child
   * may still be alive — and the caller must retain capacity + snapshot. */
  async function closeConfirmed(handle: RuntimeHandle): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        handle.close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("close timeout")), cancelGraceMs);
          if (typeof timer.unref === "function") timer.unref();
          closeTimers.add(timer);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        closeTimers.delete(timer);
      }
    }
  }

  function armCancelGrace(stored: StoredRun): void {
    if (cancelTimers.has(stored.run.id)) return;
    const timer = setTimeout(() => {
      cancelTimers.delete(stored.run.id);
      forceCancelAfterGrace(stored.run.id);
    }, cancelGraceMs);
    // A pending grace must not keep test servers alive on its own.
    if (typeof timer.unref === "function") timer.unref();
    cancelTimers.set(stored.run.id, timer);
  }

  return {
    createSession(principal: AuthPrincipal, id?: string): CoachingSession {
      if (shutDown) throw new CoachingServiceError("VALIDATION_ERROR", "Service is shut down.");
      const sessionId = id !== undefined ? id : `sess-${randomUUID()}`;
      if (sessionId.trim() === "") {
        throw new CoachingServiceError("VALIDATION_ERROR", "Session id must be non-blank.");
      }
      // Every SSE frame carries the session id in its metadata, so an unbounded
      // id would inflate (even) the reserved terminal frame past the wire
      // budget. Bound it at creation; generated ids are ~41 code units.
      if (sessionId.length > MAX_COACHING_SESSION_ID_LENGTH) {
        throw new CoachingServiceError(
          "VALIDATION_ERROR",
          `Session id must be at most ${MAX_COACHING_SESSION_ID_LENGTH} characters.`,
        );
      }
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        if (existing.accountId !== principal.id) {
          throw new CoachingServiceError("SESSION_NOT_FOUND", "Coaching session not found.");
        }
        existing.expiresAt = Date.now() + retentionMs;
        persistJournal();
        return cloneSession(existing);
      }
      let owned = 0;
      for (const session of sessions.values()) {
        if (session.accountId === principal.id) owned += 1;
      }
      if (owned >= maxSessionsPerAccount) {
        throw new CoachingServiceError("VALIDATION_ERROR", "Session limit reached for this account.");
      }
      const session: StoredSession = {
        id: sessionId,
        accountId: principal.id,
        nativeSessionDir: allocSessionDir(),
        expiresAt: Date.now() + retentionMs,
      };
      sessions.set(sessionId, session);
      persistJournal();
      return cloneSession(session);
    },

    readSession(principal: AuthPrincipal, id: string): CoachingSession {
      const session = getSessionOwned(principal, id);
      session.expiresAt = Date.now() + retentionMs;
      persistJournal();
      return cloneSession(session);
    },

    async createSnapshot(
      principal: AuthPrincipal,
      filter?: { from?: string; to?: string },
      ctx?: WorkoutReadContext,
    ): Promise<CoachingDataSnapshot> {
      if (shutDown) throw new CoachingServiceError("VALIDATION_ERROR", "Service is shut down.");
      // Reuse core date validation: invalid calendar dates and inverted
      // ranges throw VALIDATION_ERROR (never an opaque RangeError).
      let from: string | undefined;
      let to: string | undefined;
      try {
        from = filter?.from === undefined ? undefined : assertValidFilterDate(filter.from, "from");
        to = filter?.to === undefined ? undefined : assertValidFilterDate(filter.to, "to");
        assertOrderedDateRange(from, to);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new CoachingServiceError("VALIDATION_ERROR", error.message);
        }
        throw error;
      }
      let records: WorkoutRecord[];
      try {
        records = await options.source.listWorkouts(principal, ctx);
      } catch (error) {
        if (error instanceof CoachingServiceError) throw error;
        // Storage/auth outages are 503 — never 400, never empty history.
        throw new CoachingServiceError("STORAGE_UNAVAILABLE", "Workout history is temporarily unavailable.");
      }
      // Reuse core filtering (datetime-safe date keys) + deterministic sorting.
      let scoped: WorkoutRecord[];
      try {
        scoped = filterRecords(records, { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new CoachingServiceError("VALIDATION_ERROR", error.message);
        }
        throw error;
      }
      // Bounded snapshot: oversized ranges reject explicitly so analysis
      // never silently covers a subset. The client narrows from/to and retries.
      if (scoped.length > maxRecordsPerSnapshot) {
        throw new CoachingServiceError(
          "VALIDATION_ERROR",
          `Requested range contains ${scoped.length} records, exceeding the per-snapshot limit of ${maxRecordsPerSnapshot}; narrow the date range (from/to) and retry.`,
        );
      }
      const capped = scoped;
      const recordIds = capped.map((record) => record.id).sort();
      let live = 0;
      for (const snapshot of snapshots.values()) {
        if (snapshot.accountId === principal.id) live += 1;
      }
      if (live >= maxSnapshotsPerAccount) {
        expireSweep();
        let recount = 0;
        for (const snapshot of snapshots.values()) {
          if (snapshot.accountId === principal.id) recount += 1;
        }
        if (recount >= maxSnapshotsPerAccount) {
          throw new CoachingServiceError("VALIDATION_ERROR", "Snapshot limit reached for this account.");
        }
      }
      const snapshotId = `snap-${randomUUID()}`;
      const snapshot: CoachingDataSnapshot = {
        snapshotId,
        source: snapshotSource,
        accountId: principal.id,
        recordIds,
        recordCount: recordIds.length,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      };
      // The store keeps source records only, for a bounded lifetime. Each
      // run writes its own fresh immutable file from these records.
      const byId = new Map(capped.map((record) => [record.id, record]));
      const ordered = recordIds.map((id) => byId.get(id)).filter((r) => r !== undefined) as WorkoutRecord[];
      snapshots.set(snapshotId, { snapshot, accountId: principal.id, records: ordered, expiresAt: Date.now() + snapshotTtlMs });
      persistJournal();
      return structuredClone(snapshot);
    },

    async submitRun(
      principal: AuthPrincipal,
      input: SubmitCoachingRunInput,
    ): Promise<{ run: CoachingRun; lastSeq: number; replayed: boolean; created: boolean }> {
      if (shutDown) throw new CoachingServiceError("VALIDATION_ERROR", "Service is shut down.");
      expireSweep();
      const session = getSessionOwned(principal, input.sessionId);
      session.expiresAt = Date.now() + retentionMs;
      // NEVER trust snapshot.accountId: it must equal the verified principal.
      const ref: CoachingSnapshotReference = input.snapshot;
      if (ref.accountId !== principal.id) {
        throw new CoachingServiceError("FORBIDDEN", "Snapshot is not bound to this account.");
      }
      // Resolve the handle only when it is still live. Expiry drops the entry
      // (stale-map deletion) and resolves to null — it is NOT fatal yet,
      // because an owned retained run replays from its own stored snapshot.
      const stored = resolveLiveSnapshot(principal, ref);
      // Validate the backend/runtime/location triple in depth (the contract
      // guard already did). A runtime change under an existing key is never a
      // replay: backendId is part of the canonical request.
      let selection: ReturnType<typeof resolveCoachingBackendSelection>;
      try {
        selection = resolveCoachingBackendSelection({
          backendId: input.backendId,
          runtimeId: input.runtimeId,
        });
      } catch {
        throw new CoachingServiceError("VALIDATION_ERROR", "Invalid backend/runtime selection.");
      }
      const { backendId, runtimeId, executionLocation } = selection;

      const key = idemKey(principal.id, session.id, input.idempotencyKey);
      const existingId = idempotency.get(key);
      if (existingId !== undefined) {
        const existing = runs.get(existingId);
        if (existing !== undefined && existing.accountId === principal.id && existing.run.sessionId === session.id) {
          // Compare the INCOMING prompt/runtime/ref against the run's own
          // canonical stored snapshot instead of substituting it: only the
          // client-supplied ref fields are replaced, so a changed prompt,
          // source, snapshotId, or principal is refused rather than replayed.
          // This runs BEFORE the live-snapshot requirement, so an identical
          // retry still resolves after the snapshot TTL has passed.
          if (
            existing.run.snapshot.snapshotId === ref.snapshotId &&
            existing.run.snapshot.source !== ref.source
          ) {
            throw new CoachingServiceError("FORBIDDEN", "Snapshot source mismatch.");
          }
          const requested = canonicalizeCoachingSubmit({
            prompt: input.prompt,
            backendId,
            runtimeId,
            snapshot: {
              ...existing.run.snapshot,
              snapshotId: ref.snapshotId,
              source: ref.source,
              accountId: ref.accountId,
            },
          });
          if (existing.canonical !== requested) {
            throw new CoachingServiceError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was already used with different content.",
            );
          }
          return { run: cloneRun(existing.run), lastSeq: lastSeqOf(existing), replayed: true, created: false };
        }
        // Stale mapping (expired/evicted run or cross-session reuse): drop it
        // and fall through to create a fresh run. Never serve removed data.
        idempotency.delete(key);
      }
      // A NEW run still requires an owned, live snapshot: the replay above is
      // the only path that survives expiry. Sessions with retained runs stay
      // resolvable by that run reference (see the sweep).
      if (stored === null) {
        throw new CoachingServiceError("SNAPSHOT_NOT_FOUND", "Snapshot not found or expired.");
      }
      // Only a NEW execution is gated: an identical retained replay above is
      // served even if quota/config changed after the original run.
      if (executionLocation === "cloud") {
        // Guests and unverified identities NEVER reach cloud dispatch, no
        // matter what the request selected. Qualification is server-derived.
        const qualification = cloudQualification(principal);
        if (!qualification.eligible) {
          throw new CoachingServiceError(
            "VALIDATION_ERROR",
            qualification.reason?.message ?? "Cloud coaching is not available for this account.",
          );
        }
      }
      const runtimeRegistration = resolveRuntimeRegistration(backendId);
      const resolved: CoachingDataSnapshot = stored.snapshot;
      const canonical = canonicalizeCoachingSubmit({ prompt: input.prompt, backendId, runtimeId, snapshot: resolved });

      // 1 active run per session + 1 global pi process; never queue implicitly.
      for (const entry of runs.values()) {
        if (
          entry.accountId === principal.id &&
          entry.run.sessionId === session.id &&
          !isTerminalStatus(entry.run.status)
        ) {
          throw new CoachingServiceError("RUN_BUSY", "Session already has an active run.");
        }
      }
      if (globalActive >= 1) {
        throw new CoachingServiceError("RUN_BUSY", "Another coaching run is active.");
      }

      const runId = `run-${randomUUID()}`;
      const run: CoachingRun = {
        id: runId,
        sessionId: session.id,
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        prompt: input.prompt,
        snapshot: resolved,
        runtimeId,
        backendId,
      };
      const entry: StoredRun = {
        run,
        accountId: principal.id,
        canonical,
        events: [],
        eventBytes: 0,
        runtime: null,
        snapshotDir: null,
        cancelRequested: false,
        sealed: null,
        terminalIntent: null,
        terminated: false,
        capacityHeld: false,
        cleanupConfirmed: false,
        processExitConfirmed: false,
        toolRefused: false,
        hasAnalysis: false,
        fatalError: null,
        expiresAt: Date.now() + retentionMs,
      };
      // Reserve BEFORE any await (concurrent dedup race): capacity is held
      // synchronously so a racing duplicate sees the reservation.
      runs.set(runId, entry);
      idempotency.set(key, runId);
      globalActive += 1;
      entry.capacityHeld = true;
      evictOverflow();
      try {
        persistJournal();
      } catch (error) {
        // The caller never received a run id, so it cannot cancel this ghost
        // reservation. Roll it back before surfacing the storage failure.
        if (runs.get(runId) === entry) runs.delete(runId);
        if (idempotency.get(key) === runId) idempotency.delete(key);
        releaseCapacity(entry);
        throw error;
      }

      // Empty history is a normal new-user state: explicit completed result,
      // runtime never invoked, no capacity consumed beyond this tick.
      if (resolved.recordCount === 0) {
        applyTerminal(entry, "completed", EMPTY_HISTORY_REASON, true);
        entry.processExitConfirmed = true;
        return { run: cloneRun(entry.run), lastSeq: lastSeqOf(entry), replayed: false, created: true };
      }

      // Fresh immutable validated file per run from the snapshot's bounded
      // records. The snapshot handle itself is never reused as a file.
      let dir: string;
      let snapshotFile: string;
      try {
        ({ dir, snapshotFile } = await writeSnapshot(stored.records));
      } catch {
        // Release ONLY what this reservation still owns: after a concurrent
        // cancel/logout/shutdown the idempotency mapping may already describe
        // a NEWER run (same account/session/key), so an unconditional delete
        // would erase unrelated idempotency state.
        if (runs.get(runId) === entry) runs.delete(runId);
        if (idempotency.get(key) === runId) idempotency.delete(key);
        releaseCapacity(entry);
        persistJournal();
        throw new CoachingServiceError("STORAGE_UNAVAILABLE", "Snapshot workspace is temporarily unavailable.");
      }

      // The await yielded: logout/cancel/shutdown may have terminated or
      // removed this reservation and released its capacity meanwhile. Re-verify
      // run + session ownership and service liveness BEFORE constructing the
      // runtime: a stale continuation must never spawn an orphan child, must
      // not recreate removed state, and only cleans up its OWN fresh dir (the
      // session dir belongs to the session and is never touched here).
      const stillReserved =
        !shutDown &&
        runs.get(runId) === entry &&
        !entry.terminated &&
        !entry.cancelRequested &&
        // This reservation must still hold global execution AUTHORITY, not
        // merely nonterminal identity: a confirmed cancel/shutdown releases
        // capacity (capacityHeld=false) while keeping the run for reads, and a
        // stale continuation must never spawn a child after that.
        entry.capacityHeld &&
        sessions.get(session.id) === session &&
        session.accountId === principal.id;
      if (!stillReserved) {
        // Await the cleanup: the caller must never observe a completed
        // cancellation while the fresh workspace is still on disk.
        await cleanupSnapshotDir(dir).catch(() => undefined);
        releaseCapacity(entry);
        if (runs.get(runId) === entry) {
          // cancelRun/shutdown keep the run: report its real terminal state and
          // RETAIN the idempotency mapping so an identical retry replays this
          // same cancelled run (never launches a second run under the key). The
          // mapping is dropped with the run on retention/eviction, keeping the
          // idempotency contract honest for as long as the run itself survives.
          return { run: cloneRun(entry.run), lastSeq: lastSeqOf(entry), replayed: false, created: true };
        }
        // Removed (logout/eviction): nothing remains to serve, so the mapping is
        // dropped only here — never erasing another reservation's mapping.
        if (idempotency.get(key) === runId) idempotency.delete(key);
        throw new CoachingServiceError("RUN_NOT_FOUND", "Coaching run was cancelled before it started.");
      }
      entry.snapshotDir = dir;

      // Fixed per-product-session native dir (never the snapshot default).
      // Backfill once for sessions created before the field existed.
      if ((session as { nativeSessionDir?: string }).nativeSessionDir === undefined) {
        session.nativeSessionDir = allocSessionDir();
      }
      const sessionDir = session.nativeSessionDir;
      try {
        // The workspace + native session ownership are durable before launch.
        persistJournal();
      } catch (error) {
        // The caller never received a run id, so it cannot cancel this queued
        // ghost. Roll the reservation back like the first pre-launch flush and
        // remove the fresh workspace this continuation just wrote; a same-key
        // retry must start a real run, never replay a reservation that never
        // launched.
        if (runs.get(runId) === entry) runs.delete(runId);
        if (idempotency.get(key) === runId) idempotency.delete(key);
        entry.snapshotDir = null;
        releaseCapacity(entry);
        await cleanupSnapshotDir(dir).catch(() => undefined);
        throw error;
      }
      const expectedNativeVersion = NATIVE_SESSION_VERSION_BY_BACKEND[backendId];
      // A native handle belongs to one backend + runtime + protocol version.
      // Switching any of them starts fresh: a pi session file is NEVER handed
      // to Codex/OpenCode, and an engine id is never treated as a pi path.
      const ownsStoredNativeSession =
        expectedNativeVersion !== undefined &&
        session.nativeSessionBackendId === backendId &&
        session.nativeSessionRuntimeId === runtimeId &&
        session.nativeSessionVersion === expectedNativeVersion;
      const resumeCandidate = ownsStoredNativeSession ? session.nativeSessionFile : undefined;
      const resumeNativeCandidate = ownsStoredNativeSession
        ? session.nativeSessionHandle
        : undefined;
      const launch: RuntimeLaunchOptions = {
        sessionId: session.id,
        runId,
        prompt: input.prompt,
        snapshotFile,
        snapshotDir: dir,
        sessionDir,
        // Native resume: the last handle captured for THIS product
        // session/account is passed back only when it still lives inside the
        // fixed session dir; never across sessions/accounts.
        ...(resumeCandidate !== undefined && isWithinDir(sessionDir, resumeCandidate)
          ? { resumeSessionFile: resumeCandidate }
          : {}),
        ...(resumeNativeCandidate !== undefined && isSafeNativeSessionHandle(resumeNativeCandidate)
          ? { resumeNativeSessionHandle: resumeNativeCandidate }
          : {}),
        // Runtime callbacks ARE the persistence boundary: adapters invoke them
        // from stdout/socket/timer callbacks where a thrown journal error would
        // kill the launcher while the child kept running. A storage failure is
        // recorded on the run, the child is stopped, and the last durable
        // journal state stays recoverable — never silently swallowed.
        onEvent: (payload) => {
          const current = runs.get(runId);
          if (current === undefined) return;
          try {
            appendRuntimeEvent(current, payload as unknown);
          } catch (error) {
            if (!isJournalWriteFailure(error)) throw error;
            stopRunAfterJournalFailure(current, error);
          }
        },
        onDone: (status, reason, info) => {
          const current = runs.get(runId);
          if (current === undefined || current.terminated) return;
          try {
            settleRuntimeDone(current, status, reason, info);
          } catch (error) {
            if (!isJournalWriteFailure(error)) throw error;
            stopRunAfterJournalFailure(current, error);
          }
        },
      };
      let handle: RuntimeHandle;
      try {
        handle = runtimeRegistration.factory(launch);
      } catch {
        // Construction threw before any child existed: no exit to confirm,
        // but the reservation must still be released (capacity + workspace).
        // The run is recorded as confirmed-failed so capacity is freed and
        // the failure is visible; workspace is cleaned via the confirmed path.
        applyTerminal(entry, "failed", "runtime failed to start", true);
        if (entry.snapshotDir !== null) {
          const failedDir = entry.snapshotDir;
          entry.snapshotDir = null;
          void cleanupSnapshotDir(failedDir).catch(() => undefined);
        }
        entry.runtime = null;
        const failed = runs.get(runId);
        return {
          run: cloneRun(failed?.run ?? entry.run),
          lastSeq: failed !== undefined ? lastSeqOf(failed) : lastSeqOf(entry),
          replayed: false,
          created: true,
        };
      }
      // Assign BEFORE start(): a synchronous runtime may call onDone inside
      // start(), and the terminal path must see the live handle.
      entry.runtime = handle;
      try {
        handle.start();
      } catch {
        // start() threw after a partial spawn: attempt a bounded close but
        // never assume success — the terminal is marked confirmed only when
        // close() resolves. Deferred so the sync throw does not claim cleanup.
        const partial = runs.get(runId);
        void (async () => {
          const confirmed = await closeConfirmed(handle);
          const current = runs.get(runId);
          if (current === undefined || current.terminated) return;
          if (partial !== undefined) partial.processExitConfirmed = confirmed;
          applyTerminalSafely(
            current,
            "failed",
            confirmed ? "runtime failed to start" : "runtime failed to start (cleanup unconfirmed; snapshot retained)",
            confirmed,
          );
        })();
      }
      // start() may already have terminated the run (sync fake runtimes).
      if (entry.terminated && entry.runtime !== null && entry.cleanupConfirmed) {
        entry.runtime = null;
      }
      const current = runs.get(runId);
      if (current === undefined) {
        throw new CoachingServiceError("STORAGE_UNAVAILABLE", "Runtime failed to start.");
      }
      return {
        run: cloneRun(current.run),
        lastSeq: lastSeqOf(current),
        replayed: false,
        created: true,
      };
    },

    readRun(principal: AuthPrincipal, runId: string) {
      expireSweep();
      const stored = getRunOwned(principal, runId);
      return {
        run: cloneRun(stored.run),
        lastSeq: lastSeqOf(stored),
        firstSeq: 0,
        expiresAt: stored.expiresAt,
      };
    },

    readEvents(principal: AuthPrincipal, runId: string, fromSeq?: number) {
      expireSweep();
      const stored = getRunOwned(principal, runId);
      const from = fromSeq ?? 0;
      if (!Number.isSafeInteger(from) || from < 0) {
        throw new CoachingServiceError("VALIDATION_ERROR", "`fromSeq` must be a safe non-negative integer.");
      }
      // Cursor contract: `from` is the first seq still needed
      // (last-consumed + 1). `lastSeq + 1` means caught up (empty page);
      // anything beyond is EXPIRED_CURSOR with recovery state — the client
      // must refetch from firstSeq, never silently skip.
      if (from > stored.events.length) {
        throw new CoachingServiceError(
          "EXPIRED_CURSOR",
          `Cursor ${from} is beyond retained events (firstSeq 0, lastSeq ${lastSeqOf(stored)}); refetch events from fromSeq=0 and re-fold — do not skip, events may be missing.`,
        );
      }
      return {
        events: cloneEvents(stored.events.slice(from)),
        run: cloneRun(stored.run),
        lastSeq: lastSeqOf(stored),
        firstSeq: 0,
        expiresAt: stored.expiresAt,
      };
    },

    cancelRun(principal: AuthPrincipal, runId: string, reason?: string) {
      const stored = getRunOwned(principal, runId);
      if (isTerminalStatus(stored.run.status) || stored.terminated) {
        return { run: cloneRun(stored.run), lastSeq: lastSeqOf(stored) };
      }
      stored.cancelRequested = true;
      stored.cancelReason = reason ?? "cancel requested";
      const handle = stored.runtime;
      if (handle === null) {
        applyTerminal(stored, "cancelled", stored.cancelReason, true);
        stored.processExitConfirmed = true;
        return { run: cloneRun(stored.run), lastSeq: lastSeqOf(stored) };
      }
      try {
        handle.cancel(stored.cancelReason);
      } catch {
        // Fall through to the grace path, which invokes close().
      }
      // The runtime reports terminal via onDone; if it never does, the
      // grace path invokes close() and awaits confirmation. Cancel wins
      // over any late completion via onDone's cancelRequested branch.
      armCancelGrace(stored);
      persistJournal();
      return { run: cloneRun(stored.run), lastSeq: lastSeqOf(stored) };
    },

    discoverBackends(principal: AuthPrincipal): CoachingCapabilityDiscovery {
      return buildCoachingDiscovery({
        registry: runtimeRegistry,
        ...(legacyRuntimeFactory === undefined ? {} : { legacyLocalPiFactory: legacyRuntimeFactory }),
        identity: options.trustedIdentity?.(principal) ?? null,
        cloudQuota: options.cloudQuota ?? null,
        cloudProviderConfigured: options.cloudProviderConfigured === true,
        ...(options.defaultBackendId === undefined
          ? {}
          : { defaultBackendId: options.defaultBackendId }),
        ...(options.automaticLocalDefault === true ? { automaticLocalDefault: true } : {}),
      });
    },

    async logoutAccount(principal: AuthPrincipal): Promise<void> {
      // Cancel the caller's own active runs (best-effort close + confirmed
      // terminal), then drop their sessions/snapshots. Other accounts are
      // untouched; capabilities are invalidated by the server.
      for (const stored of [...runs.values()]) {
        if (stored.accountId !== principal.id) continue;
        if (isTerminalStatus(stored.run.status) || stored.terminated) continue;
        stored.cancelRequested = true;
        stored.cancelReason = "logout";
        try {
          stored.runtime?.cancel("logout");
        } catch {
          // Teardown is best-effort.
        }
        const handle = stored.runtime;
        const confirmed = handle === null ? true : await closeConfirmed(handle);
        if (!stored.terminated) {
          applyTerminal(
            stored,
            "cancelled",
            confirmed ? "logout" : "logout (cleanup unconfirmed; snapshot retained)",
            confirmed,
          );
        }
      }
      // Completed runs of this account: clear outputs so a stale signed-in
      // reuse cannot read them; unconfirmed runs keep files/handles.
      for (const stored of [...runs.values()]) {
        if (stored.accountId !== principal.id) continue;
        if (stored.terminated && stored.cleanupConfirmed) {
          stored.events.length = 0;
          stored.eventBytes = 0;
          deleteRun(stored.run.id);
        }
      }
      for (const [id, session] of [...sessions.entries()]) {
        if (session.accountId !== principal.id) continue;
        // A retained (active or unconfirmed-terminal) run still references
        // this session, and the journal loader requires every run to have its
        // session metadata: deleting it would write a journal the next startup
        // refuses to load (CORRUPT_STORE). Keep the metadata (and its native
        // dir — a live child may still hold it) while any run remains.
        const retained = [...runs.values()].some((entry) => entry.run.sessionId === id);
        if (retained) continue;
        const dir = (session as { nativeSessionDir?: string }).nativeSessionDir;
        sessions.delete(id);
        if (dir !== undefined) {
          await cleanupSnapshotDir(dir).catch(() => undefined);
        }
      }
      for (const [id, snapshot] of [...snapshots.entries()]) {
        if (snapshot.accountId === principal.id) snapshots.delete(id);
      }
      for (const [key, id] of [...idempotency.entries()]) {
        const run = runs.get(id);
        if (run === undefined || run.accountId === principal.id) idempotency.delete(key);
      }
      for (const [runId, timer] of [...cancelTimers.entries()]) {
        const run = runs.get(runId);
        if (run === undefined || run.accountId === principal.id) {
          clearTimeout(timer);
          cancelTimers.delete(runId);
        }
      }
      persistJournal();
    },

    activeRunCount(): number {
      return globalActive;
    },

    runCount(): number {
      return runs.size;
    },

    async shutdown(): Promise<void> {
      shutDown = true;
      clearInterval(sweepTimer);
      for (const timer of cancelTimers.values()) clearTimeout(timer);
      cancelTimers.clear();
      for (const timer of closeTimers) clearTimeout(timer);
      closeTimers.clear();
      const live = [...runs.values()].filter((entry) => !entry.terminated);
      // Every active run (all with held capacity) is cancelled first.
      for (const entry of live) {
        entry.cancelRequested = true;
        entry.cancelReason = "server shutdown";
        try {
          entry.runtime?.cancel("server shutdown");
        } catch {
          // Teardown is best-effort.
        }
      }
      // Bounded close per active run — including terminal-but-unconfirmed
      // handles, which still hold a live child. Unconfirmed files/handles
      // are preserved; a failed shutdown is surfaced via throw, never
      // suppressed, and live dirs are never deleted.
      const unconfirmed: string[] = [];
      const targets = [...runs.values()].filter((entry) => !entry.terminated || !entry.cleanupConfirmed);
      for (const entry of targets) {
        const handle = entry.runtime;
        const confirmed = handle === null ? true : await closeConfirmed(handle);
        if (!entry.terminated) {
          applyTerminal(
            entry,
            "cancelled",
            confirmed ? "server shutdown" : "server shutdown (cleanup unconfirmed; snapshot retained)",
            confirmed,
          );
        }
        if (!confirmed) unconfirmed.push(entry.run.id);
      }
      // Persist BEFORE workspace cleanup: shutdown retains product history
      // (runs/events/sessions) while scratch dirs may be removed.
      persistJournal();
      // Workspace cleanup: only confirmed-terminal run dirs go. Session dirs
      // go only when every run of that session is confirmed-terminal. With a
      // durable journal the native session dirs are retained so a restart can
      // still honor the persisted native ownership boundary.
      for (const entry of [...runs.values()]) {
        if (entry.snapshotDir !== null && entry.terminated && entry.cleanupConfirmed) {
          const dir = entry.snapshotDir;
          entry.snapshotDir = null;
          await cleanupSnapshotDir(dir).catch(() => undefined);
        }
      }
      for (const [id, session] of [...sessions.entries()]) {
        const pending = [...runs.values()].some(
          (entry) => entry.run.sessionId === id && (!entry.terminated || !entry.cleanupConfirmed),
        );
        if (!pending) {
          const dir = (session as { nativeSessionDir?: string }).nativeSessionDir;
          sessions.delete(id);
          if (journalPath === null && dir !== undefined) {
            await cleanupSnapshotDir(dir).catch(() => undefined);
          }
        }
      }
      snapshots.clear();
      if (unconfirmed.length > 0) {
        throw new Error(
          `shutdown incomplete: ${unconfirmed.length} run(s) with unconfirmed process exit retained`,
        );
      }
    },
  };
}
