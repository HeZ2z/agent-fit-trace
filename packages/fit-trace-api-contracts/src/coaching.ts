import type { AnalysisResult } from "@pi-fit-trace/core";
import { assertOrderedDateRange, isValidIsoDate, ValidationError } from "@pi-fit-trace/core";
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

/** Only the local pi runtime is wired today; other ids reject, never route. */
export const COACHING_RUNTIME_IDS = ["pi"] as const;

export type CoachingRuntimeId = (typeof COACHING_RUNTIME_IDS)[number];

/**
 * Cursor semantics (shared by the run service, HTTP server, and SSE):
 * - Event `seq` values are dense 0-based indexes into the run's event log.
 * - `lastSeq` is the seq of the last stored event, or `-1` when the log is
 *   empty. It is NOT one-past-final: a client holding every event up to and
 *   including `lastSeq` is fully caught up.
 * - `fromSeq` is the first seq the client still needs (the seq AFTER its
 *   last successfully consumed event; `0` for a fresh subscribe). Valid
 *   range: `0 <= fromSeq <= lastSeq + 1`; `fromSeq === lastSeq + 1` returns
 *   an empty page (caught up), anything beyond is `EXPIRED_CURSOR`.
 * - An expired cursor is never an instruction to skip: the client must
 *   refetch from `firstSeq` (always `0` in this service — no prefix
 *   trimming) and re-fold; the server returns current run state + retention
 *   so gaps are recoverable, never silently lost.
 */
export interface CoachingCursor {
  lastSeq: number;
  firstSeq: number;
  expiresAt: number;
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

/**
 * Shared SSE wire budgets (single source of truth).
 *
 * The run service, the loopback HTTP server, and the browser client all
 * consume these so the wire has one framing + size rule:
 * - A single encoded frame (the full `id:`/`data:` envelope, measured in UTF-8
 *   bytes with metadata overhead) must not exceed
 *   {@link MAX_COACHING_SSE_FRAME_BYTES}.
 * - The whole stream body for one run must not exceed
 *   {@link MAX_COACHING_SSE_TOTAL_BYTES}.
 *
 * `MAX_COACHING_SSE_FRAME_BYTES <= MAX_COACHING_SSE_TOTAL_BYTES` so any event
 * the service accepts is readable by the client. The service additionally
 * reserves {@link COACHING_SSE_TERMINAL_RESERVE_BYTES} of the total budget for
 * the cap-seal `run_error` frame and the terminal frame, so tripping the
 * content budget still leaves a readable terminal (never a silent truncation).
 * The service never exceeds the content budget (a configured per-run byte cap
 * is clamped to `MAX_COACHING_SSE_TOTAL_BYTES - reserve`), bounds each reserved
 * frame (cap-seal + terminal) to {@link COACHING_SSE_RESERVED_FRAME_BYTES} of
 * ENCODED bytes with {@link boundCoachingDiagnostic}, and bounds session
 * ids to {@link MAX_COACHING_SESSION_ID_LENGTH}, so content + cap-seal +
 * terminal always fit `MAX_COACHING_SSE_TOTAL_BYTES`. The server emits NO
 * heartbeat/keepalive frames, so the client's total counter sees only those
 * accepted frames (the reserve is not shared with heartbeat overhead).
 */
export const MAX_COACHING_SSE_FRAME_BYTES = 1024 * 1024;
export const MAX_COACHING_SSE_TOTAL_BYTES = 4 * 1024 * 1024;
export const COACHING_SSE_TERMINAL_RESERVE_BYTES = 8 * 1024;

/**
 * Per-frame byte budget for the two frames that BYPASS the content cap: the
 * cap-seal `run_error` frame and the terminal frame. Exactly two such frames
 * exist and the reserve must cover BOTH, so each gets half of
 * {@link COACHING_SSE_TERMINAL_RESERVE_BYTES}. Both diagnostics are bounded to
 * this ENCODED-frame budget by {@link boundCoachingDiagnostic}, so
 * `content + seal + terminal` can never exceed
 * {@link MAX_COACHING_SSE_TOTAL_BYTES}.
 */
export const COACHING_SSE_RESERVED_FRAME_BYTES = COACHING_SSE_TERMINAL_RESERVE_BYTES / 2;

/**
 * Explicit marker appended when a diagnostic `reason`/`message` is shortened
 * to fit the wire budget, so a shortened terminal is visible — never silently
 * truncated. Ordinary small diagnostics are preserved verbatim.
 */
export const COACHING_TRUNCATION_MARKER = "…[truncated]";

/**
 * Max code units for a caller-supplied coaching session id.
 *
 * Every SSE frame carries `sessionId` in its metadata, so an unbounded id
 * would inflate every frame (including the reserved terminal/cap-seal frames)
 * past the wire budget. Ids longer than this reject at session creation with
 * `VALIDATION_ERROR`. The bound is generous relative to generated
 * `sess-<uuid>` ids (~41 code units) and keeps multibyte ids well inside the
 * terminal reserve.
 */
export const MAX_COACHING_SESSION_ID_LENGTH = 128;

const utf8Encoder = new TextEncoder();

/** UTF-8 byte length of a string (never its code-unit/character length). */
export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

/**
 * Truncate `value` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * surrogate pair / multi-byte codepoint (the result is always valid UTF-8 and
 * `utf8ByteLength(result) <= maxBytes`). Returns `value` unchanged when it
 * already fits.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * The ONE framing rule: how an envelope becomes an SSE frame on the wire.
 * The server writes exactly this string; size checks measure exactly this
 * string, so the cap and the bytes on the wire can never drift apart.
 */
export function encodeCoachingEventFrame(envelope: CoachingEventEnvelope): string {
  return `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** Encoded UTF-8 bytes of one full envelope frame, metadata overhead included. */
export function coachingEventFrameBytes(envelope: CoachingEventEnvelope): number {
  return utf8ByteLength(encodeCoachingEventFrame(envelope));
}

/**
 * Fit a diagnostic text (a terminal `reason` or a cap-seal `message`) so the
 * frame built by `buildEnvelope(text)` fits `maxFrameBytes` EXACTLY.
 *
 * Measured on the ENCODED frame — the same bytes the server writes — NOT on
 * raw UTF-8 length. A raw-byte bound is unsound because JSON escaping expands
 * characters: a control character is 1 raw byte but 6 wire bytes (`\u0000`),
 * and `"`/`\` double, so a raw reason can overflow the reserve by up to 6x.
 * Because the frame embeds the live `sessionId`/`runId`, a max-length escaped
 * session id is accounted for too.
 *
 * Returns the text unchanged (`shortened: false`) when it already fits;
 * otherwise the longest codepoint-safe prefix that fits WITH the explicit
 * {@link COACHING_TRUNCATION_MARKER} appended (`shortened: true`). The scan is
 * forward-only and only ever stops at the first overflow: completing a
 * surrogate pair can only shrink the encoded length, so never over-admitting.
 */
export function boundCoachingDiagnostic(
  buildEnvelope: (text: string) => CoachingEventEnvelope,
  text: string,
  maxFrameBytes: number,
): { text: string; shortened: boolean } {
  if (coachingEventFrameBytes(buildEnvelope(text)) <= maxFrameBytes) {
    return { text, shortened: false };
  }
  const withMarker = (value: string): number =>
    coachingEventFrameBytes(buildEnvelope(`${value}${COACHING_TRUNCATION_MARKER}`));
  if (withMarker("") > maxFrameBytes) {
    // Metadata alone already exceeds the budget (should never happen with the
    // bounded session/run ids): drop the diagnostic rather than overflow.
    return { text: "", shortened: true };
  }
  let prefix = "";
  for (const char of text) {
    const candidate = prefix + char;
    if (withMarker(candidate) > maxFrameBytes) break;
    prefix = candidate;
  }
  return { text: `${prefix}${COACHING_TRUNCATION_MARKER}`, shortened: true };
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
  /** Seq of the last stored event, or `-1` when the log is empty (queued, no events yet). */
  lastSeq: number;
  firstSeq: number;
  expiresAt: number;
}

export interface SubscribeCoachingEventsInput {
  runId: string;
  fromSeq?: number;
}

export interface CancelCoachingRunInput {
  runId: string;
  reason?: string;
}

/** HTTP cancel request body: path carries `runId`, so the body holds only `{ reason? }`. */
export interface CancelCoachingRunBody {
  reason?: string;
}

/** Stored cancel result: the run plus its cursor (`-1` when the log is empty). */
export interface CancelCoachingRunResult {
  run: CoachingRun;
  lastSeq: number;
}

/** `POST /coaching/runs` response: created/replayed run + cursor + dedup signal. */
export interface SubmitCoachingRunResult {
  run: CoachingRun;
  lastSeq: number;
  replayed: boolean;
}

/** `GET /coaching/runs/:id/events` page: sliced envelopes + coherent run state + retention. */
export interface ReadCoachingEventsResult {
  events: CoachingEventEnvelope[];
  run: CoachingRun;
  lastSeq: number;
  firstSeq: number;
  expiresAt: number;
}

/** `POST /coaching/bootstrap` response: short-TTL launcher capability. */
export interface CoachingBootstrapResult {
  capability: string;
  expiresInMs: number;
}

/** `POST /coaching/logout` response. */
export interface CoachingLogoutResult {
  loggedOut: boolean;
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

/** Guard a single runtime event payload (used by the run service to validate runtime output before forwarding). */
export function parseCoachingEventPayload(value: Record<string, unknown>): CoachingEventPayload {
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

function assertLastSeq(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    fail(field, "must be a safe integer >= -1 (-1 when the event log is empty)");
  }
  return value;
}

function assertFirstSeq(value: unknown, field: string): number {
  return assertSafeNonNegativeInt(value, field);
}

function assertExpiresAt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(field, "must be a finite positive timestamp");
  }
  return value;
}

function parseStoredRun(value: unknown, field: string): CoachingRun {
  if (!isObject(value)) fail(field, "must be an object");
  const runObj = value;
  const statusRaw = assertNonBlankString(runObj.status, `${field}.status`);
  if (
    statusRaw !== "queued" &&
    statusRaw !== "running" &&
    statusRaw !== "completed" &&
    statusRaw !== "failed" &&
    statusRaw !== "cancelled"
  ) {
    fail(`${field}.status`, "must be a known run status");
  }
  const run: CoachingRun = {
    id: assertNonBlankString(runObj.id, `${field}.id`),
    sessionId: assertNonBlankString(runObj.sessionId, `${field}.sessionId`),
    status: statusRaw as CoachingRunStatus,
    idempotencyKey: assertNonBlankString(runObj.idempotencyKey, `${field}.idempotencyKey`),
    prompt: assertNonBlankString(runObj.prompt, `${field}.prompt`),
    snapshot: parseCoachingDataSnapshot(runObj.snapshot),
    runtimeId: assertNonBlankString(runObj.runtimeId, `${field}.runtimeId`),
  };
  if ((COACHING_RUNTIME_IDS as readonly string[]).includes(run.runtimeId) === false) {
    fail(`${field}.runtimeId`, `must be one of ${(COACHING_RUNTIME_IDS as readonly string[]).join(", ")} (only pi is wired)`);
  }
  if (runObj.failure !== undefined) {
    if (!isObject(runObj.failure)) fail(`${field}.failure`, "must be an object");
    run.failure = {
      code: assertNonBlankString(runObj.failure.code, `${field}.failure.code`),
      message: assertNonBlankString(runObj.failure.message, `${field}.failure.message`),
    };
  }
  return run;
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
    const runtimeId = assertNonBlankString(value.runtimeId, "runtimeId");
    if (!(COACHING_RUNTIME_IDS as readonly string[]).includes(runtimeId)) {
      fail("runtimeId", `must be one of ${(COACHING_RUNTIME_IDS as readonly string[]).join(", ")} (only pi is wired)`);
    }
    input.runtimeId = runtimeId;
  }
  return input;
}

/** Guard the create-session request body (`{ id? }`; absent body means auto-id). */
export function parseCreateCoachingSessionInput(value: unknown): CreateCoachingSessionInput {
  if (value === undefined) return {};
  if (!isObject(value)) fail("(root)", "must be an object");
  if (value.id === undefined) return {};
  return { id: assertNonBlankString(value.id, "id") };
}

/**
 * Strict calendar check on top of core `isValidIsoDate`: the core accepts any
 * datetime `new Date()` parses, so rollover values like `2026-02-30T10:00Z`
 * (parsed as Mar 2) would pass. Reject when the leading `YYYY-MM-DD` date
 * part is not a real calendar date. End-date inclusivity is owned by core
 * `filterRecords`/`toDateKey` (a `to: "2026-09-03"` filter includes datetime
 * records on that day); this guard only validates, never string-compares.
 */
function assertFilterDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !isValidIsoDate(value)) {
    fail(field, "must be a valid ISO 8601 date (YYYY-MM-DD) or datetime; invalid calendar dates reject");
  }
  const datePart = value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const parsed = new Date(`${datePart}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== datePart) {
      fail(field, "must be a valid ISO 8601 date (YYYY-MM-DD) or datetime; invalid calendar dates reject");
    }
  }
  return value;
}

/** Guard the snapshot-create filter (`{ from?, to? }`); reuses core date validation + ordering. */
export function parseSnapshotFilter(value: unknown): { from?: string; to?: string } {
  if (value === undefined) return {};
  if (!isObject(value)) fail("(root)", "must be an object");
  const out: { from?: string; to?: string } = {};
  if (value.from !== undefined) out.from = assertFilterDate(value.from, "from");
  if (value.to !== undefined) out.to = assertFilterDate(value.to, "to");
  try {
    assertOrderedDateRange(out.from, out.to);
  } catch (error) {
    if (error instanceof ValidationError) fail("from", error.message);
    throw error;
  }
  return out;
}

/**
 * Guard the cancel-run request body (`{ reason? }`). The run id travels in
 * the path, so the body carries no `runId` — see {@link CancelCoachingRunBody}.
 */
export function parseCancelCoachingRunBody(value: unknown): CancelCoachingRunBody {
  if (value === undefined) return {};
  if (!isObject(value)) fail("(root)", "must be an object");
  if (value.reason === undefined) return {};
  if (typeof value.reason !== "string") fail("reason", "must be a string");
  return { reason: value.reason };
}

/** @deprecated Use {@link parseCancelCoachingRunBody}: the body never carries `runId`. */
export function parseCancelCoachingRunInput(value: unknown): CancelCoachingRunBody {
  return parseCancelCoachingRunBody(value);
}

/** Guard the read-run response (`{ run, lastSeq, firstSeq, expiresAt }`). */
export function parseReadCoachingRunResult(value: unknown): ReadCoachingRunResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  return {
    run: parseStoredRun(value.run, "run"),
    lastSeq: assertLastSeq(value.lastSeq, "lastSeq"),
    firstSeq: assertFirstSeq(value.firstSeq, "firstSeq"),
    expiresAt: assertExpiresAt(value.expiresAt, "expiresAt"),
  };
}

/** Guard one runtime event envelope (validates envelope + payload, reusing helpers). */
export function parseRuntimeEventEnvelope(value: unknown): CoachingEventEnvelope {
  return parseCoachingEventEnvelope(value);
}

/** Guard the events page (`{ events, run, lastSeq, firstSeq, expiresAt }`); every envelope is validated. */
export function parseReadCoachingEventsResult(value: unknown): ReadCoachingEventsResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (!Array.isArray(value.events)) fail("events", "must be an array");
  return {
    events: value.events.map((entry: unknown, index: number) => {
      try {
        return parseCoachingEventEnvelope(entry);
      } catch (error) {
        if (error instanceof MalformedResponseError) fail(`events[${index}]`, error.message);
        throw error;
      }
    }),
    run: parseStoredRun(value.run, "run"),
    lastSeq: assertLastSeq(value.lastSeq, "lastSeq"),
    firstSeq: assertFirstSeq(value.firstSeq, "firstSeq"),
    expiresAt: assertExpiresAt(value.expiresAt, "expiresAt"),
  };
}

/**
 * Guard the create/read session response (`{ id }` only).
 *
 * The public session contract is id-only: ownership is verified server-side
 * (a cross-account read is `SESSION_NOT_FOUND`), so no `accountId` is exposed
 * or trusted here.
 */
export function parseCoachingSession(value: unknown): CoachingSession {
  if (!isObject(value)) fail("(root)", "must be an object");
  return { id: assertNonBlankString(value.id, "id") };
}

/** Guard the snapshot-create response: the server-resolved snapshot. */
export function parseSnapshotCreateResult(value: unknown): CoachingDataSnapshot {
  return parseCoachingDataSnapshot(value);
}

/** Guard the submit-run response (`{ run, lastSeq, replayed }`; queued runs report `lastSeq: -1`). */
export function parseSubmitCoachingRunResult(value: unknown): SubmitCoachingRunResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (typeof value.replayed !== "boolean") fail("replayed", "must be a boolean");
  return {
    run: parseStoredRun(value.run, "run"),
    lastSeq: assertLastSeq(value.lastSeq, "lastSeq"),
    replayed: value.replayed,
  };
}

/** Guard the cancel-run response (`{ run, lastSeq }`). */
export function parseCancelCoachingRunResult(value: unknown): CancelCoachingRunResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  return {
    run: parseStoredRun(value.run, "run"),
    lastSeq: assertLastSeq(value.lastSeq, "lastSeq"),
  };
}

/** Guard the bootstrap response (`{ capability, expiresInMs }`). */
export function parseCoachingBootstrapResult(value: unknown): CoachingBootstrapResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  const capability = assertNonBlankString(value.capability, "capability");
  if (typeof value.expiresInMs !== "number" || !Number.isFinite(value.expiresInMs) || value.expiresInMs <= 0) {
    fail("expiresInMs", "must be a finite positive number");
  }
  return { capability, expiresInMs: value.expiresInMs };
}

/** Guard the logout response (`{ loggedOut: true }`). */
export function parseCoachingLogoutResult(value: unknown): CoachingLogoutResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (value.loggedOut !== true) fail("loggedOut", "must be true");
  return { loggedOut: true };
}

/** Guard one runtime descriptor (`CoachingRuntimeInfo`); only `pi` is wired. */
export function parseCoachingRuntimeInfo(value: unknown): CoachingRuntimeInfo {
  if (!isObject(value)) fail("(root)", "must be an object");
  const id = assertNonBlankString(value.id, "id");
  if (!(COACHING_RUNTIME_IDS as readonly string[]).includes(id)) {
    fail("id", `must be one of ${(COACHING_RUNTIME_IDS as readonly string[]).join(", ")} (only pi is wired)`);
  }
  if (typeof value.available !== "boolean") fail("available", "must be a boolean");
  return {
    id,
    kind: assertNonBlankString(value.kind, "kind"),
    displayName: assertNonBlankString(value.displayName, "displayName"),
    available: value.available,
    ...(value.version === undefined ? {} : { version: assertNonBlankString(value.version, "version") }),
  };
}

/** Guard the public bootstrap config (`{ supabaseUrl, supabasePublishableKey }`). */
export function parsePublicApiConfig(value: unknown): { supabaseUrl: string; supabasePublishableKey: string } {
  if (!isObject(value)) fail("(root)", "must be an object");
  return {
    supabaseUrl: assertNonBlankString(value.supabaseUrl, "supabaseUrl"),
    supabasePublishableKey: assertNonBlankString(value.supabasePublishableKey, "supabasePublishableKey"),
  };
}
