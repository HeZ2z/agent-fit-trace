/**
 * Durable local coaching journal (Node-only).
 *
 * The coaching service keeps its hot state in Maps; this module is the
 * optional durable projection of that state. It lives outside the shared
 * browser-safe core because it owns filesystem I/O:
 *
 * - one app-owned JSON file, default `.pi/fit-trace/coaching-journal.json`;
 * - parent directory mode `0700`, file mode `0600`;
 * - writes go to a temp file in the same directory and are atomically
 *   renamed, with a monotonic generation for stale-read detection;
 * - loading is strict: ownership, event sequence/identity, canonical request,
 *   idempotency, and native backend/runtime/version boundaries are validated.
 *   A malformed or outdated file throws `CORRUPT_STORE` and is never silently
 *   reset or overwritten.
 *
 * The journal stores product state only. Ephemeral bearer tokens, provider
 * credentials, runtime handles, and process ids are never serialized.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CoachingBackendId,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingRun,
  CoachingRuntimeId,
  CoachingTerminalStatus,
} from "@pi-fit-trace/api-contracts";
import {
  COACHING_PROTOCOL_VERSION,
  MAX_COACHING_SESSION_ID_LENGTH,
  coachingEventFrameBytes,
  isTerminalStatus,
  parseCoachingDataSnapshot,
  parseCoachingEventPayload,
  parseSubmitCoachingRunResult,
  resolveCoachingBackendSelection,
} from "@pi-fit-trace/api-contracts";
import { validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { canonicalizeCoachingSubmit } from "./coachingCanonical.ts";
import { NATIVE_SESSION_VERSION_BY_BACKEND } from "./runtimeRegistry.ts";

export const COACHING_JOURNAL_VERSION = 1;

/** Raised when a previously written journal cannot be trusted. */
export class CoachingJournalCorruptError extends Error {
  readonly code = "CORRUPT_STORE";
  constructor(path: string, detail: string) {
    super(`coaching journal ${path} is corrupt: ${detail}`);
    this.name = "CoachingJournalCorruptError";
  }
}

export interface CoachingJournalSession {
  id: string;
  accountId: string;
  /** Fixed native session dir owned by this product session. */
  nativeSessionDir: string;
  nativeSessionFile?: string;
  nativeSessionHandle?: string;
  nativeSessionBackendId?: CoachingBackendId;
  nativeSessionRuntimeId?: CoachingRuntimeId;
  nativeSessionVersion?: string;
  expiresAt: number;
}

export interface CoachingJournalSnapshot {
  snapshot: CoachingDataSnapshot;
  accountId: string;
  records: WorkoutRecord[];
  expiresAt: number;
}

/** Serializable shape of a stored run (the live runtime handle is omitted). */
export interface CoachingJournalRun {
  run: CoachingRun;
  accountId: string;
  canonical: string;
  events: CoachingEventEnvelope[];
  eventBytes: number;
  snapshotDir: string | null;
  cancelRequested: boolean;
  cancelReason?: string;
  sealed: { status: CoachingTerminalStatus; reason: string } | null;
  terminalIntent: { status: CoachingTerminalStatus; reason?: string } | null;
  terminated: boolean;
  capacityHeld: boolean;
  cleanupConfirmed: boolean;
  processExitConfirmed: boolean;
  toolRefused: boolean;
  hasAnalysis: boolean;
  fatalError: { code: string; message: string } | null;
  expiresAt: number;
}

export interface CoachingJournalIdempotency {
  accountId: string;
  sessionId: string;
  key: string;
  runId: string;
}

export interface CoachingJournalState {
  sessions: CoachingJournalSession[];
  snapshots: CoachingJournalSnapshot[];
  runs: CoachingJournalRun[];
  idempotency: CoachingJournalIdempotency[];
}

export interface LoadedCoachingJournal {
  path: string;
  generation: number;
  state: CoachingJournalState;
}

const EMPTY_STATE: CoachingJournalState = {
  sessions: [],
  snapshots: [],
  runs: [],
  idempotency: [],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, detail: string): never {
  throw new CoachingJournalCorruptError(path, detail);
}

function asObject(path: string, value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, `${field} must be an object`);
  return value;
}

function asArray(path: string, value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `${field} must be an array`);
  return value;
}

function asString(path: string, value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") fail(path, `${field} must be a string`);
  if (!allowEmpty && value.trim() === "") fail(path, `${field} must be non-blank`);
  return value;
}

function asBoolean(path: string, value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(path, `${field} must be a boolean`);
  return value;
}

function asSafeInteger(path: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, `${field} must be a non-negative safe integer`);
  }
  return value;
}

function asFiniteNumber(path: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, `${field} must be a finite number`);
  }
  return value;
}

function asOptionalString(
  path: string,
  value: unknown,
  field: string,
  allowEmpty = false,
): string | undefined {
  if (value === undefined) return undefined;
  return asString(path, value, field, allowEmpty);
}

function parseRun(path: string, value: unknown, field: string): CoachingRun {
  try {
    return parseSubmitCoachingRunResult({ run: value, lastSeq: 0, replayed: false }).run;
  } catch (error) {
    fail(path, `${field} is not a valid coaching run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseSnapshot(path: string, value: unknown, field: string): CoachingDataSnapshot {
  try {
    return parseCoachingDataSnapshot(value);
  } catch (error) {
    fail(path, `${field} is not a valid coaching snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseEventEnvelope(
  path: string,
  value: unknown,
  field: string,
  runId: string,
  sessionId: string,
  expectedSeq: number,
): CoachingEventEnvelope {
  const obj = asObject(path, value, field);
  const protocolVersion = asSafeInteger(path, obj.protocolVersion, `${field}.protocolVersion`);
  if (protocolVersion !== COACHING_PROTOCOL_VERSION) {
    fail(path, `${field}.protocolVersion must be ${COACHING_PROTOCOL_VERSION}`);
  }
  const envelopeSessionId = asString(path, obj.sessionId, `${field}.sessionId`);
  if (envelopeSessionId !== sessionId) {
    fail(path, `${field}.sessionId does not match the stored run session`);
  }
  const envelopeRunId = asString(path, obj.runId, `${field}.runId`);
  if (envelopeRunId !== runId) {
    fail(path, `${field}.runId does not match the stored run`);
  }
  const seq = asSafeInteger(path, obj.seq, `${field}.seq`);
  if (seq !== expectedSeq) {
    fail(path, `${field}.seq must be ${expectedSeq} (events must start at 0 and be contiguous)`);
  }
  let event;
  try {
    event = parseCoachingEventPayload(asObject(path, obj.event, `${field}.event`));
  } catch (error) {
    if (error instanceof CoachingJournalCorruptError) throw error;
    fail(path, `${field}.event is not a valid coaching payload: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { protocolVersion, sessionId: envelopeSessionId, runId: envelopeRunId, seq, event };
}

function parseTerminalIntent(
  path: string,
  value: unknown,
  field: string,
): { status: CoachingTerminalStatus; reason?: string } | null {
  if (value === null) return null;
  const obj = asObject(path, value, field);
  const status = asString(path, obj.status, `${field}.status`);
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    fail(path, `${field}.status must be a terminal status`);
  }
  const reason = asOptionalString(path, obj.reason, `${field}.reason`, true);
  return reason === undefined ? { status } : { status, reason };
}

function parseSealed(
  path: string,
  value: unknown,
  field: string,
): { status: CoachingTerminalStatus; reason: string } | null {
  if (value === null) return null;
  const obj = asObject(path, value, field);
  const status = asString(path, obj.status, `${field}.status`);
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    fail(path, `${field}.status must be a terminal status`);
  }
  return {
    status,
    reason: asString(path, obj.reason, `${field}.reason`, true),
  };
}

function parseFatalError(
  path: string,
  value: unknown,
  field: string,
): { code: string; message: string } | null {
  if (value === null) return null;
  const obj = asObject(path, value, field);
  return {
    code: asString(path, obj.code, `${field}.code`),
    message: asString(path, obj.message, `${field}.message`, true),
  };
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

const NATIVE_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Scratch dirs are app-created with a fixed prefix under the OS temp root.
 * Validating both prevents a tampered journal from aiming later cleanup at an
 * arbitrary directory. */
const APP_SCRATCH_ROOT = resolve(tmpdir());

function parseScratchDir(path: string, value: unknown, field: string, prefix: string): string {
  const dir = asString(path, value, field);
  if (!isAbsolute(dir)) fail(path, `${field} must be absolute`);
  const resolved = resolve(dir);
  if (resolved === APP_SCRATCH_ROOT || !resolved.startsWith(`${APP_SCRATCH_ROOT}${sep}`)) {
    fail(path, `${field} must stay under the app-owned scratch root`);
  }
  if (!basename(resolved).startsWith(prefix)) {
    fail(path, `${field} is not an app-owned ${prefix} directory`);
  }
  return dir;
}

function parseSession(path: string, value: unknown, field: string): CoachingJournalSession {
  const obj = asObject(path, value, field);
  const id = asString(path, obj.id, `${field}.id`);
  if (id.length > MAX_COACHING_SESSION_ID_LENGTH) {
    fail(path, `${field}.id exceeds the session id bound`);
  }
  const accountId = asString(path, obj.accountId, `${field}.accountId`);
  const nativeSessionDir = parseScratchDir(
    path,
    obj.nativeSessionDir,
    `${field}.nativeSessionDir`,
    "fit-trace-sess-",
  );
  const nativeSessionFile = asOptionalString(path, obj.nativeSessionFile, `${field}.nativeSessionFile`);
  const nativeSessionHandle = asOptionalString(path, obj.nativeSessionHandle, `${field}.nativeSessionHandle`);
  const backendRaw = obj.nativeSessionBackendId;
  const runtimeRaw = obj.nativeSessionRuntimeId;
  const versionRaw = obj.nativeSessionVersion;
  const backendId = backendRaw === undefined
    ? undefined
    : asString(path, backendRaw, `${field}.nativeSessionBackendId`);
  const runtimeId = runtimeRaw === undefined
    ? undefined
    : asString(path, runtimeRaw, `${field}.nativeSessionRuntimeId`);
  const version = versionRaw === undefined
    ? undefined
    : asString(path, versionRaw, `${field}.nativeSessionVersion`);
  const hasOwnership =
    backendId !== undefined || runtimeId !== undefined || version !== undefined ||
    nativeSessionFile !== undefined || nativeSessionHandle !== undefined;
  if (hasOwnership) {
    if (backendId === undefined || runtimeId === undefined || version === undefined) {
      fail(path, `${field} native session ownership needs backend, runtime, and version`);
    }
    let selection: ReturnType<typeof resolveCoachingBackendSelection>;
    try {
      selection = resolveCoachingBackendSelection({ backendId, runtimeId });
    } catch {
      fail(path, `${field} native backend/runtime pair is invalid`);
    }
    if (selection.backendId !== backendId || selection.runtimeId !== runtimeId) {
      fail(path, `${field} native backend/runtime pair is inconsistent`);
    }
    const expectedVersion = NATIVE_SESSION_VERSION_BY_BACKEND[selection.backendId];
    if (expectedVersion === undefined || version !== expectedVersion) {
      fail(path, `${field} native session version does not match backend ${selection.backendId}`);
    }
    if (nativeSessionFile === undefined && nativeSessionHandle === undefined) {
      fail(path, `${field} native session ownership requires a handle or file`);
    }
    if (nativeSessionFile !== undefined && nativeSessionHandle !== undefined) {
      fail(path, `${field} must not retain two native handles`);
    }
    if (nativeSessionHandle !== undefined && !NATIVE_HANDLE_PATTERN.test(nativeSessionHandle)) {
      fail(path, `${field}.nativeSessionHandle is not a safe opaque handle`);
    }
    if (nativeSessionFile !== undefined && !isWithinDir(nativeSessionDir, nativeSessionFile)) {
      fail(path, `${field}.nativeSessionFile escapes the owned session dir`);
    }
  }
  return {
    id,
    accountId,
    nativeSessionDir,
    ...(nativeSessionFile === undefined ? {} : { nativeSessionFile }),
    ...(nativeSessionHandle === undefined ? {} : { nativeSessionHandle }),
    ...(selectionOwnership(backendId, runtimeId, version)),
    expiresAt: asFiniteNumber(path, obj.expiresAt, `${field}.expiresAt`),
  };
}

function selectionOwnership(
  backendId: string | undefined,
  runtimeId: string | undefined,
  version: string | undefined,
): {
  nativeSessionBackendId?: CoachingBackendId;
  nativeSessionRuntimeId?: CoachingRuntimeId;
  nativeSessionVersion?: string;
} {
  if (backendId === undefined || runtimeId === undefined || version === undefined) return {};
  return {
    nativeSessionBackendId: backendId as CoachingBackendId,
    nativeSessionRuntimeId: runtimeId as CoachingRuntimeId,
    nativeSessionVersion: version,
  };
}

function parseSnapshotRecord(
  path: string,
  value: unknown,
  field: string,
): CoachingJournalSnapshot {
  const obj = asObject(path, value, field);
  const snapshot = parseSnapshot(path, obj.snapshot, `${field}.snapshot`);
  const accountId = asString(path, obj.accountId, `${field}.accountId`);
  if (snapshot.accountId !== accountId) {
    fail(path, `${field}.accountId does not match the embedded snapshot account`);
  }
  const records = asArray(path, obj.records, `${field}.records`).map((entry, index) => {
    try {
      return validateWorkoutRecord(entry).record;
    } catch (error) {
      fail(
        path,
        `${field}.records[${index}] is not a valid workout record: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  const actualIds = records.map((record) => record.id).sort();
  if (
    actualIds.length !== snapshot.recordIds.length ||
    actualIds.some((recordId, index) => recordId !== snapshot.recordIds[index])
  ) {
    fail(path, `${field}.records do not match the embedded snapshot recordIds`);
  }
  return {
    snapshot,
    accountId,
    records,
    expiresAt: asFiniteNumber(path, obj.expiresAt, `${field}.expiresAt`),
  };
}

function parseRunRecord(
  path: string,
  value: unknown,
  field: string,
): CoachingJournalRun {
  const obj = asObject(path, value, field);
  const run = parseRun(path, obj.run, `${field}.run`);
  const accountId = asString(path, obj.accountId, `${field}.accountId`);
  if (run.snapshot.accountId !== accountId) {
    fail(path, `${field}.accountId does not match the embedded snapshot account`);
  }
  const canonical = asString(path, obj.canonical, `${field}.canonical`, true);
  let selection: ReturnType<typeof resolveCoachingBackendSelection>;
  try {
    selection = resolveCoachingBackendSelection({
      backendId: run.backendId,
      runtimeId: run.runtimeId,
    });
  } catch {
    fail(path, `${field}.run has an invalid backend/runtime selection`);
  }
  const expectedCanonical = canonicalizeCoachingSubmit({
    prompt: run.prompt,
    backendId: selection.backendId,
    runtimeId: selection.runtimeId,
    snapshot: run.snapshot,
  });
  if (canonical !== expectedCanonical) {
    fail(path, `${field}.canonical does not match the stored run request`);
  }
  const events = asArray(path, obj.events, `${field}.events`).map((entry, index) =>
    parseEventEnvelope(path, entry, `${field}.events[${index}]`, run.id, run.sessionId, index),
  );
  const eventBytes = asSafeInteger(path, obj.eventBytes, `${field}.eventBytes`);
  const actualBytes = events.reduce((sum, envelope) => sum + coachingEventFrameBytes(envelope), 0);
  if (eventBytes !== actualBytes) {
    fail(path, `${field}.eventBytes does not match the stored event frames`);
  }
  let terminalIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.event.type !== "terminal") continue;
    if (terminalIndex !== -1) fail(path, `${field}.events contains more than one terminal`);
    terminalIndex = index;
  }
  if (isTerminalStatus(run.status)) {
    if (terminalIndex !== events.length - 1) {
      fail(path, `${field} terminal run must end with exactly one terminal event`);
    }
    const terminal = events[terminalIndex]?.event;
    if (terminal?.type !== "terminal" || terminal.status !== run.status) {
      fail(path, `${field} terminal event does not match the stored run status`);
    }
  } else if (terminalIndex !== -1) {
    fail(path, `${field} nonterminal run must not contain a terminal event`);
  }
  const snapshotDirValue = obj.snapshotDir;
  const snapshotDir = snapshotDirValue === null
    ? null
    : parseScratchDir(path, snapshotDirValue, `${field}.snapshotDir`, "fit-trace-coach-");
  const terminated = asBoolean(path, obj.terminated, `${field}.terminated`);
  const capacityHeld = asBoolean(path, obj.capacityHeld, `${field}.capacityHeld`);
  const cleanupConfirmed = asBoolean(path, obj.cleanupConfirmed, `${field}.cleanupConfirmed`);
  const processExitConfirmed = asBoolean(path, obj.processExitConfirmed, `${field}.processExitConfirmed`);
  if (cleanupConfirmed && !terminated) {
    fail(path, `${field}.cleanupConfirmed requires a terminated run`);
  }
  if (processExitConfirmed && !terminated) {
    fail(path, `${field}.processExitConfirmed requires a terminated run`);
  }
  if (terminated && cleanupConfirmed && capacityHeld) {
    fail(path, `${field} cannot hold capacity after confirmed cleanup`);
  }
  if (isTerminalStatus(run.status) !== terminated) {
    fail(path, `${field}.terminated must agree with the run status`);
  }
  if (!terminated && !capacityHeld) {
    fail(path, `${field} active run must hold capacity`);
  }
  if (terminated && !cleanupConfirmed && !capacityHeld) {
    fail(path, `${field} unconfirmed terminal run must retain capacity`);
  }
  const cancelReason = asOptionalString(path, obj.cancelReason, `${field}.cancelReason`, true);
  return {
    run,
    accountId,
    canonical,
    events,
    eventBytes,
    snapshotDir,
    cancelRequested: asBoolean(path, obj.cancelRequested, `${field}.cancelRequested`),
    ...(cancelReason === undefined ? {} : { cancelReason }),
    sealed: parseSealed(path, obj.sealed, `${field}.sealed`),
    terminalIntent: parseTerminalIntent(path, obj.terminalIntent, `${field}.terminalIntent`),
    terminated,
    capacityHeld,
    cleanupConfirmed,
    processExitConfirmed,
    toolRefused: asBoolean(path, obj.toolRefused, `${field}.toolRefused`),
    hasAnalysis: asBoolean(path, obj.hasAnalysis, `${field}.hasAnalysis`),
    fatalError: parseFatalError(path, obj.fatalError, `${field}.fatalError`),
    expiresAt: asFiniteNumber(path, obj.expiresAt, `${field}.expiresAt`),
  };
}

function parseIdempotency(
  path: string,
  value: unknown,
  field: string,
): CoachingJournalIdempotency {
  const obj = asObject(path, value, field);
  return {
    accountId: asString(path, obj.accountId, `${field}.accountId`),
    sessionId: asString(path, obj.sessionId, `${field}.sessionId`),
    key: asString(path, obj.key, `${field}.key`),
    runId: asString(path, obj.runId, `${field}.runId`),
  };
}

function validateJournal(path: string, raw: unknown): LoadedCoachingJournal {
  const root = asObject(path, raw, "root");
  if (root.version !== COACHING_JOURNAL_VERSION) {
    fail(path, `unsupported journal version ${JSON.stringify(root.version)}`);
  }
  const generation = asSafeInteger(path, root.generation, "generation");
  const sessions = asArray(path, root.sessions, "sessions").map((entry, index) =>
    parseSession(path, entry, `sessions[${index}]`),
  );
  const snapshots = asArray(path, root.snapshots, "snapshots").map((entry, index) =>
    parseSnapshotRecord(path, entry, `snapshots[${index}]`),
  );
  const runs = asArray(path, root.runs, "runs").map((entry, index) =>
    parseRunRecord(path, entry, `runs[${index}]`),
  );
  const idempotency = asArray(path, root.idempotency, "idempotency").map((entry, index) =>
    parseIdempotency(path, entry, `idempotency[${index}]`),
  );

  const sessionById = new Map<string, CoachingJournalSession>();
  for (const session of sessions) {
    if (sessionById.has(session.id)) fail(path, `duplicate session id ${JSON.stringify(session.id)}`);
    sessionById.set(session.id, session);
  }
  const snapshotById = new Map<string, CoachingJournalSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshotById.has(snapshot.snapshot.snapshotId)) {
      fail(path, `duplicate snapshot id ${JSON.stringify(snapshot.snapshot.snapshotId)}`);
    }
    snapshotById.set(snapshot.snapshot.snapshotId, snapshot);
  }
  const runById = new Map<string, CoachingJournalRun>();
  for (const stored of runs) {
    if (runById.has(stored.run.id)) fail(path, `duplicate run id ${JSON.stringify(stored.run.id)}`);
    runById.set(stored.run.id, stored);
  }

  let capacityHeld = 0;
  for (const stored of runs) {
    const session = sessionById.get(stored.run.sessionId);
    if (session === undefined) {
      fail(path, `run ${stored.run.id} references missing session ${JSON.stringify(stored.run.sessionId)}`);
    }
    if (session.accountId !== stored.accountId) {
      fail(path, `run ${stored.run.id} crosses account boundaries with its session`);
    }
    if (stored.capacityHeld) capacityHeld += 1;
  }
  if (capacityHeld > 1) {
    fail(path, "more than one run retains global execution capacity");
  }

  const seenIdempotency = new Set<string>();
  const seenRunMapping = new Set<string>();
  for (const entry of idempotency) {
    const stored = runById.get(entry.runId);
    if (stored === undefined) {
      fail(path, `idempotency entry references missing run ${JSON.stringify(entry.runId)}`);
    }
    if (
      stored.accountId !== entry.accountId ||
      stored.run.sessionId !== entry.sessionId ||
      stored.run.idempotencyKey !== entry.key
    ) {
      fail(path, `idempotency entry does not match run ${JSON.stringify(entry.runId)}`);
    }
    const mapKey = `${entry.accountId}\n${entry.sessionId}\n${entry.key}`;
    if (seenIdempotency.has(mapKey)) fail(path, "duplicate idempotency entry");
    seenIdempotency.add(mapKey);
    if (seenRunMapping.has(entry.runId)) fail(path, "run has more than one idempotency entry");
    seenRunMapping.add(entry.runId);
  }

  return {
    path,
    generation,
    state: { sessions, snapshots, runs, idempotency },
  };
}

/** Load and validate the journal. A missing file is an empty, writable state. */
export function loadCoachingJournal(path: string): LoadedCoachingJournal {
  const resolved = resolve(path);
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { path: resolved, generation: 0, state: EMPTY_STATE };
    }
    throw new CoachingJournalCorruptError(
      resolved,
      `cannot read the journal (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CoachingJournalCorruptError(resolved, "file is not valid JSON");
  }
  return validateJournal(resolved, raw);
}

function ensureJournalDirectory(path: string): string {
  const directory = dirname(resolve(path));
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stats = statSync(directory);
  if (!stats.isDirectory()) {
    throw new CoachingJournalCorruptError(resolve(path), "parent path is not a directory");
  }
  // The journal directory is app-owned: keep it private even when it already
  // existed with a wider mode.
  chmodSync(directory, 0o700);
  return directory;
}

/**
 * Refuse to replace a journal another writer advanced. The in-memory generation
 * is not sufficient: two launchers can both load generation N and then race to
 * write N+1, silently dropping the other's sessions/runs/idempotency.
 */
function assertCurrentGeneration(path: string, expected: number): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      if (expected === 0) return;
      fail(path, `journal disappeared (expected generation ${expected})`);
    }
    fail(
      path,
      `cannot verify the journal generation (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    fail(path, "file is not valid JSON");
  }
  const root = asObject(path, raw, "root");
  const onDisk = asSafeInteger(path, root.generation, "generation");
  if (onDisk !== expected) {
    fail(
      path,
      `journal generation changed from ${expected} to ${onDisk}; refusing to overwrite another writer`,
    );
  }
}

export interface CoachingJournalLock {
  readonly path: string;
  release(): void;
}

interface JournalLockFile {
  pid: number;
  token: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readLockFile(path: string): JournalLockFile | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isObject(raw)) return null;
    if (typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid <= 0) {
      return null;
    }
    if (typeof raw.token !== "string" || raw.token === "") return null;
    return { pid: raw.pid, token: raw.token };
  } catch {
    return null;
  }
}

/**
 * Claim the journal for this launcher process. The lock is removed on clean
 * close; a dead owner's lock is reclaimed once, while an unreadable lock fails
 * closed rather than guessing. This is advisory process ownership, not a
 * security boundary against a hostile local user.
 */
export function acquireCoachingJournalLock(path: string): CoachingJournalLock {
  const resolved = resolve(path);
  const lockPath = `${resolved}.lock`;
  ensureJournalDirectory(resolved);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          { encoding: "utf8" },
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path: lockPath,
        release(): void {
          if (released) return;
          released = true;
          const current = readLockFile(lockPath);
          if (current !== null && current.token === token) {
            rmSync(lockPath, { force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const current = readLockFile(lockPath);
      if (current === null) {
        fail(
          lockPath,
          "lock file exists but is unreadable; remove it manually after confirming no launcher is running",
        );
      }
      if (processIsAlive(current.pid)) {
        fail(lockPath, `another launcher (pid ${String(current.pid)}) already owns this journal`);
      }
      rmSync(lockPath, { force: true });
    }
  }
  fail(lockPath, "could not acquire the journal lock");
}

/**
 * Atomically replace the journal with `state` at `previousGeneration + 1`.
 * Synchronous by design: callers flush before acknowledging a mutation.
 */
export function writeCoachingJournal(
  path: string,
  previousGeneration: number,
  state: CoachingJournalState,
): number {
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0) {
    throw new CoachingJournalCorruptError(resolve(path), "invalid previous journal generation");
  }
  const resolved = resolve(path);
  ensureJournalDirectory(resolved);
  assertCurrentGeneration(resolved, previousGeneration);
  const generation = previousGeneration + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new CoachingJournalCorruptError(resolved, "journal generation overflow");
  }
  const temp = `${resolved}.${process.pid}.${generation}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify({
    version: COACHING_JOURNAL_VERSION,
    generation,
    sessions: state.sessions,
    snapshots: state.snapshots,
    runs: state.runs,
    idempotency: state.idempotency,
  })}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, payload, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, resolved);
    chmodSync(resolved, 0o600);
    // Best-effort directory durability. Some platforms/filesystems reject
    // opening a directory; the file fsync + rename above still hold.
    try {
      const dirFd = openSync(dirname(resolved), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not portable; the atomic rename is still in place.
    }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort after the write failure.
      }
    }
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best-effort; the original error is what matters.
    }
    throw error;
  }
  return generation;
}
