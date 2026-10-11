import type { AnalysisResult } from "@pi-fit-trace/core";
import { parseAnalysisResult } from "./validators.ts";
import { MalformedResponseError } from "./errors.ts";

/**
 * Browser-safe coaching session contracts (plan step B, first bounded batch).
 *
 * Pure TypeScript: no Node/pi/typebox imports, no clock, no randomness. The
 * runtime (pi RPC adapter in a later batch) owns processes and I/O;
 * everything here only describes shapes and deterministic transitions.
 *
 * Snapshot boundary (option (a): server-created handle):
 * - The client submits only a {@link CoachingSnapshotReference}
 *   (`snapshotId` + `source` + `accountId`). It MUST NOT send `recordIds` or
 *   `recordCount`; parsers reject those fields when present on the reference.
 * - The coaching run service (local pi bridge, later batch) resolves the
 *   handle against the snapshot store, enforces the `source`/`accountId`
 *   binding plus identity/content consistency, and attaches the resolved
 *   {@link CoachingDataSnapshot} to the stored run.
 * - `recordCount`/`recordIds` on the stored snapshot are server-resolved and
 *   are never treated as client authorization.
 */

export const COACHING_PROTOCOL_VERSION = 1;

export const COACHING_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type CoachingRunStatus = (typeof COACHING_RUN_STATUSES)[number];

export type CoachingTerminalStatus = "completed" | "failed" | "cancelled";

export interface CoachingRuntimeInfo {
  id: string;
  kind: string;
  displayName: string;
  available: boolean;
  version?: string;
}

export interface CoachingSession {
  id: string;
}

/** Stream identity a caller must supply when folding events. */
export interface CoachingStreamIdentity {
  sessionId: string;
  runId: string;
}

/**
 * Client-supplied handle to a server-created snapshot. Contains no records,
 * ids, or counts — only the binding the run service resolves.
 */
export interface CoachingSnapshotReference {
  snapshotId: string;
  source: string;
  accountId: string;
}

/** Server-resolved read-only input snapshot (never long-term storage). */
export interface CoachingDataSnapshot extends CoachingSnapshotReference {
  recordIds: string[];
  recordCount: number;
  from?: string;
  to?: string;
}

export interface CoachingRun {
  id: string;
  sessionId: string;
  status: CoachingRunStatus;
  idempotencyKey: string;
  prompt: string;
  snapshot: CoachingDataSnapshot;
  runtimeId: string;
  failure?: { code: string; message: string };
}

export type CoachingEventPayload =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; tool: string; callId: string }
  | { type: "tool_end"; tool: string; callId: string; ok: true; summary?: string }
  | { type: "tool_end"; tool: string; callId: string; ok: false; error: string }
  | { type: "analysis_result"; result: AnalysisResult }
  | { type: "run_error"; code: string; message: string }
  | { type: "terminal"; status: CoachingTerminalStatus; reason?: string };

export interface CoachingEventEnvelope {
  protocolVersion: number;
  sessionId: string;
  runId: string;
  seq: number;
  event: CoachingEventPayload;
}

export interface CreateCoachingSessionInput {
  id?: string;
}

export interface SubmitCoachingRunInput {
  sessionId: string;
  prompt: string;
  idempotencyKey: string;
  snapshot: CoachingSnapshotReference;
  runtimeId?: string;
}

export interface ReadCoachingRunResult {
  run: CoachingRun;
  lastSeq: number;
}

export interface SubscribeCoachingEventsInput {
  runId: string;
  fromSeq?: number;
}

export interface CancelCoachingRunInput {
  runId: string;
  reason?: string;
}

export const COACHING_ERROR_CODES = {
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  RUN_BUSY: "RUN_BUSY",
  EXPIRED_CURSOR: "EXPIRED_CURSOR",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
} as const;

export type CoachingErrorCode =
  (typeof COACHING_ERROR_CODES)[keyof typeof COACHING_ERROR_CODES];

export function isTerminalStatus(status: CoachingRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function nextRunStatus(
  current: CoachingRunStatus,
  terminal: CoachingTerminalStatus,
): CoachingRunStatus {
  if (isTerminalStatus(current)) return current;
  return terminal;
}

/** True for any event that represents run activity (everything but terminal). */
function isNonTerminalPayload(payload: CoachingEventPayload): boolean {
  return payload.type !== "terminal";
}

function fail(field: string, reason: string): never {
  throw new MalformedResponseError(field, reason);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    fail(field, "must be a string");
  }
  return value;
}

function assertNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(field, "must be a non-blank string");
  }
  return value;
}

function assertSafeNonNegativeInt(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(field, "must be a safe non-negative integer");
  }
  return value;
}

export function parseCoachingEventEnvelope(value: unknown): CoachingEventEnvelope {
  if (!isObject(value)) fail("(root)", "must be an object");
  const root = value;
  const protocolVersion = assertSafeNonNegativeInt(root.protocolVersion, "protocolVersion");
  if (protocolVersion !== COACHING_PROTOCOL_VERSION) {
    fail("protocolVersion", `must be ${COACHING_PROTOCOL_VERSION}`);
  }
  const sessionId = assertNonBlankString(root.sessionId, "sessionId");
  const runId = assertNonBlankString(root.runId, "runId");
  const seq = assertSafeNonNegativeInt(root.seq, "seq");
  if (!isObject(root.event)) fail("event", "must be an object");
  const event = parseCoachingEventPayload(root.event);
  return { protocolVersion, sessionId, runId, seq, event };
}

function parseCoachingEventPayload(value: Record<string, unknown>): CoachingEventPayload {
  const type = assertNonBlankString(value.type, "event.type");
  switch (type) {
    case "text_delta":
      // Content, not an identifier: empty and whitespace-only deltas are
      // valid (streaming providers emit spaces/newlines) and replay
      // preserves them byte-for-byte.
      return { type: "text_delta", delta: assertString(value.delta, "event.delta") };
    case "tool_start":
      return {
        type: "tool_start",
        tool: assertNonBlankString(value.tool, "event.tool"),
        callId: assertNonBlankString(value.callId, "event.callId"),
      };
    case "tool_end": {
      const tool = assertNonBlankString(value.tool, "event.tool");
      const callId = assertNonBlankString(value.callId, "event.callId");
      if (value.ok === true) {
        if (value.summary !== undefined) {
          return {
            type: "tool_end",
            tool,
            callId,
            ok: true,
            // Optional content: empty string is valid when present.
            summary: assertString(value.summary, "event.summary"),
          };
        }
        return { type: "tool_end", tool, callId, ok: true };
      }
      if (value.ok === false) {
        return {
          type: "tool_end",
          tool,
          callId,
          ok: false,
          error: assertNonBlankString(value.error, "event.error"),
        };
      }
      fail("event.ok", "must be a boolean");
    }
    case "analysis_result":
      return { type: "analysis_result", result: parseAnalysisResult(value.result) };
    case "run_error":
      return {
        type: "run_error",
        code: assertNonBlankString(value.code, "event.code"),
        message: assertNonBlankString(value.message, "event.message"),
      };
    case "terminal": {
      const status = assertNonBlankString(value.status, "event.status");
      if (status !== "completed" && status !== "failed" && status !== "cancelled") {
        fail("event.status", "must be one of completed, failed, cancelled");
      }
      const out: CoachingEventPayload = {
        type: "terminal",
        status: status as CoachingTerminalStatus,
      };
      if (value.reason !== undefined && out.type === "terminal") {
        // Optional content: empty string is valid when present.
        out.reason = assertString(value.reason, "event.reason");
      }
      return out;
    }
    default:
      fail("event.type", `unknown event type ${JSON.stringify(type)}`);
  }
}

function assertStreamIdentity(value: unknown, field: string): CoachingStreamIdentity {
  if (!isObject(value)) fail(field, "must be an object");
  return {
    sessionId: assertNonBlankString(value.sessionId, `${field}.sessionId`),
    runId: assertNonBlankString(value.runId, `${field}.runId`),
  };
}

function assertEnvelopeMatchesStream(
  envelope: CoachingEventEnvelope,
  expected: CoachingStreamIdentity,
  field: string,
): void {
  if (typeof envelope.seq !== "number" || !Number.isSafeInteger(envelope.seq) || envelope.seq < 0) {
    fail(`${field}.seq`, "must be a safe non-negative integer");
  }
  if (envelope.sessionId !== expected.sessionId || envelope.runId !== expected.runId) {
    fail(field, "mixed-stream event: sessionId/runId do not match expected stream");
  }
}

/**
 * Replay rule: every envelope must belong to `expected`; mixed streams throw.
 * Dedup by `seq` (first write wins), then sort ascending.
 */
export function dedupeEventsBySeq(
  events: CoachingEventEnvelope[],
  expected: CoachingStreamIdentity,
): CoachingEventEnvelope[] {
  const identity = assertStreamIdentity(expected, "expected");
  const bySeq = new Map<number, CoachingEventEnvelope>();
  for (const envelope of events) {
    assertEnvelopeMatchesStream(envelope, identity, "events");
    if (!bySeq.has(envelope.seq)) bySeq.set(envelope.seq, envelope);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export interface ReplayedRunState {
  status: CoachingRunStatus;
  text: string;
  toolFailures: string[];
  analysisResults: AnalysisResult[];
  error?: { code: string; message: string };
}

/**
 * Fold a (possibly duplicated/out-of-order) single-stream event list into run
 * state. The first non-terminal event moves `queued` → `running`; the first
 * terminal applies once and freezes all payload state — every event after it
 * (text, analysis, errors, conflicting terminals) is ignored.
 */
export function replayRunState(
  initial: CoachingRunStatus,
  events: CoachingEventEnvelope[],
  expected: CoachingStreamIdentity,
): ReplayedRunState {
  const ordered = dedupeEventsBySeq(events, expected);
  const state: ReplayedRunState = {
    status: initial,
    text: "",
    toolFailures: [],
    analysisResults: [],
  };
  let terminated = isTerminalStatus(initial);
  for (const envelope of ordered) {
    const payload = envelope.event;
    if (terminated) continue;
    if (payload.type === "terminal") {
      state.status = nextRunStatus(state.status, payload.status);
      terminated = true;
      continue;
    }
    if (state.status === "queued" && isNonTerminalPayload(payload)) {
      state.status = "running";
    }
    switch (payload.type) {
      case "text_delta":
        state.text += payload.delta;
        break;
      case "tool_end":
        if (!payload.ok) state.toolFailures.push(payload.error);
        break;
      case "analysis_result":
        state.analysisResults.push(payload.result);
        break;
      case "run_error":
        state.error = { code: payload.code, message: payload.message };
        break;
      default:
        break;
    }
  }
  return state;
}

function assertSnapshotReference(value: unknown, field: string, opts?: { allowResolved?: boolean }): CoachingSnapshotReference {
  const obj = isObject(value) ? value : fail(field, "must be an object");
  if (!opts?.allowResolved && ("recordIds" in obj || "recordCount" in obj)) {
    fail(field, "must be a snapshot handle only: recordIds/recordCount are server-resolved");
  }
  return {
    snapshotId: assertNonBlankString(obj.snapshotId, `${field}.snapshotId`),
    source: assertNonBlankString(obj.source, `${field}.source`),
    accountId: assertNonBlankString(obj.accountId, `${field}.accountId`),
  };
}

/** Guard the client-supplied snapshot handle (no records/counts). */
export function parseCoachingSnapshotReference(value: unknown): CoachingSnapshotReference {
  return assertSnapshotReference(value, "(root)");
}

/** Guard the server-resolved snapshot attached to a stored run. */
export function parseCoachingDataSnapshot(value: unknown): CoachingDataSnapshot {
  if (!isObject(value)) fail("(root)", "must be an object");
  const ref = assertSnapshotReference(value, "(root)", { allowResolved: true });
  const recordIds = Array.isArray(value.recordIds)
    ? value.recordIds.map((entry: unknown, index: number) =>
        assertNonBlankString(entry, `recordIds[${index}]`),
      )
    : fail("recordIds", "must be an array");
  const recordCount = assertSafeNonNegativeInt(value.recordCount, "recordCount");
  if (recordCount !== recordIds.length) {
    fail("recordCount", "must equal recordIds.length (server-resolved consistency)");
  }
  const snapshot: CoachingDataSnapshot = {
    ...ref,
    recordIds,
    recordCount,
  };
  if (value.from !== undefined) {
    snapshot.from = assertNonBlankString(value.from, "from");
  }
  if (value.to !== undefined) {
    snapshot.to = assertNonBlankString(value.to, "to");
  }
  return snapshot;
}

/** Guard the submit-run request: handle-only snapshot, non-blank ids/keys. */
export function parseSubmitCoachingRunInput(value: unknown): SubmitCoachingRunInput {
  if (!isObject(value)) fail("(root)", "must be an object");
  const input: SubmitCoachingRunInput = {
    sessionId: assertNonBlankString(value.sessionId, "sessionId"),
    prompt: assertNonBlankString(value.prompt, "prompt"),
    idempotencyKey: assertNonBlankString(value.idempotencyKey, "idempotencyKey"),
    snapshot: assertSnapshotReference(value.snapshot, "snapshot"),
  };
  if (value.runtimeId !== undefined) {
    input.runtimeId = assertNonBlankString(value.runtimeId, "runtimeId");
  }
  return input;
}

/** Guard the read-run response: resolved snapshot + safe cursor. */
export function parseReadCoachingRunResult(value: unknown): ReadCoachingRunResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (!isObject(value.run)) fail("run", "must be an object");
  const runObj = value.run;
  const statusRaw = assertNonBlankString(runObj.status, "run.status");
  if (
    statusRaw !== "queued" &&
    statusRaw !== "running" &&
    statusRaw !== "completed" &&
    statusRaw !== "failed" &&
    statusRaw !== "cancelled"
  ) {
    fail("run.status", "must be a known run status");
  }
  const run: CoachingRun = {
    id: assertNonBlankString(runObj.id, "run.id"),
    sessionId: assertNonBlankString(runObj.sessionId, "run.sessionId"),
    status: statusRaw as CoachingRunStatus,
    idempotencyKey: assertNonBlankString(runObj.idempotencyKey, "run.idempotencyKey"),
    prompt: assertNonBlankString(runObj.prompt, "run.prompt"),
    snapshot: parseCoachingDataSnapshot(runObj.snapshot),
    runtimeId: assertNonBlankString(runObj.runtimeId, "run.runtimeId"),
  };
  if (runObj.failure !== undefined) {
    if (!isObject(runObj.failure)) fail("run.failure", "must be an object");
    run.failure = {
      code: assertNonBlankString(runObj.failure.code, "run.failure.code"),
      message: assertNonBlankString(runObj.failure.message, "run.failure.message"),
    };
  }
  return {
    run,
    lastSeq: assertSafeNonNegativeInt(value.lastSeq, "lastSeq"),
  };
}
