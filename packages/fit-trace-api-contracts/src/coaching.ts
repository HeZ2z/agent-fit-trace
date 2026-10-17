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

/**
 * Execution engine ids. An engine is NOT an execution location: `pi` can run
 * on the user's machine (`local-pi`) while `hosted-sdk` always runs in the
 * hosted cloud backend. See {@link COACHING_BACKEND_DEFINITIONS}.
 *
 * Only `pi` is implemented today. The other ids are accepted by the
 * versioned contract so discovery can describe them truthfully as
 * unavailable; they never route without a matching registered adapter.
 */
export const COACHING_RUNTIME_IDS = ["pi", "codex", "opencode", "hosted-sdk"] as const;

export type CoachingRuntimeId = (typeof COACHING_RUNTIME_IDS)[number];

/** Where a backend executes. Never inferred from the runtime id. */
export const COACHING_EXECUTION_LOCATIONS = ["local", "cloud"] as const;

export type CoachingExecutionLocation = (typeof COACHING_EXECUTION_LOCATIONS)[number];

/**
 * Backend ids identify a concrete deployable execution capability. The pair
 * (backend, runtime) is fixed: a request that names both must match exactly.
 */
export const COACHING_BACKEND_IDS = [
  "local-pi",
  "local-codex",
  "local-opencode",
  "cloud-default",
] as const;

export type CoachingBackendId = (typeof COACHING_BACKEND_IDS)[number];

export const COACHING_BACKEND_DEFINITIONS = {
  "local-pi": { runtimeId: "pi", executionLocation: "local" },
  "local-codex": { runtimeId: "codex", executionLocation: "local" },
  "local-opencode": { runtimeId: "opencode", executionLocation: "local" },
  "cloud-default": { runtimeId: "hosted-sdk", executionLocation: "cloud" },
} as const satisfies Record<
  CoachingBackendId,
  { runtimeId: CoachingRuntimeId; executionLocation: CoachingExecutionLocation }
>;

/**
 * Discovery/capability schema version. Separate from the event-line
 * protocol version: capabilities can grow without changing event framing.
 */
export const COACHING_CAPABILITY_VERSION = 1;
export const COACHING_DISCOVERY_VERSION = 1;

export function isCoachingBackendId(value: unknown): value is CoachingBackendId {
  return typeof value === "string" && (COACHING_BACKEND_IDS as readonly string[]).includes(value);
}

export function isCoachingRuntimeId(value: unknown): value is CoachingRuntimeId {
  return typeof value === "string" && (COACHING_RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * Resolve the backend/runtime/location selection for a submitted run.
 *
 * Compatibility rule: a v1 request that omits BOTH fields maps to the legacy
 * `local-pi` backend — never to a paid cloud backend. Naming only a runtime
 * maps to that runtime's one backend. Naming a backend resolves its fixed
 * runtime; if both are named they must agree.
 */
export function resolveCoachingBackendSelection(selection: {
  backendId?: unknown;
  runtimeId?: unknown;
}): {
  backendId: CoachingBackendId;
  runtimeId: CoachingRuntimeId;
  executionLocation: CoachingExecutionLocation;
} {
  const { backendId, runtimeId } = selection;
  if (backendId !== undefined) {
    if (!isCoachingBackendId(backendId)) fail("backendId", `must be one of ${COACHING_BACKEND_IDS.join(", ")}`);
    const definition = COACHING_BACKEND_DEFINITIONS[backendId];
    if (runtimeId !== undefined) {
      if (!isCoachingRuntimeId(runtimeId)) {
        fail("runtimeId", `must be one of ${COACHING_RUNTIME_IDS.join(", ")}`);
      }
      if (definition.runtimeId !== runtimeId) {
        fail(
          "runtimeId",
          `backend ${backendId} requires runtime ${definition.runtimeId}, not ${runtimeId}`,
        );
      }
    }
    return {
      backendId,
      runtimeId: definition.runtimeId,
      executionLocation: definition.executionLocation,
    };
  }
  // No backend named. Omitted runtime keeps the legacy local-pi mapping.
  if (runtimeId === undefined) {
    return { backendId: "local-pi", runtimeId: "pi", executionLocation: "local" };
  }
  if (!isCoachingRuntimeId(runtimeId)) {
    fail("runtimeId", `must be one of ${COACHING_RUNTIME_IDS.join(", ")}`);
  }
  const backendIdForRuntime = (Object.entries(COACHING_BACKEND_DEFINITIONS) as Array<
    [CoachingBackendId, (typeof COACHING_BACKEND_DEFINITIONS)[CoachingBackendId]]
  >).find(([, definition]) => definition.runtimeId === runtimeId)?.[0];
  if (backendIdForRuntime === undefined) {
    fail("runtimeId", `runtime ${runtimeId} has no registered backend`);
  }
  const definition = COACHING_BACKEND_DEFINITIONS[backendIdForRuntime];
  return {
    backendId: backendIdForRuntime,
    runtimeId,
    executionLocation: definition.executionLocation,
  };
}

/**
 * Read-only tools a coached (analysis-only) run may expose. Single source of
 * the names; each trust boundary (extension registration probe, RPC adapter
 * allowlist, service-side event allowlist, host `--tools` flag) still applies
 * its own check against this list.
 */
export const COACHED_TOOL_NAMES = ["get_training_history", "analyze_progress"] as const;

export type CoachingToolName = (typeof COACHED_TOOL_NAMES)[number];

/**
 * Why a backend cannot run. Reasons are server-derived: CLI presence/auth,
 * configured adapter, provider configuration, trusted account classification,
 * and quota are separate facts. The browser cannot assert any of them.
 */
export const COACHING_AVAILABILITY_REASON_CODES = [
  "cli-not-installed",
  "cli-auth-required",
  "cli-version-unsupported",
  "adapter-not-implemented",
  "provider-unconfigured",
  "identity-unverified",
  "guest-cloud-forbidden",
  "quota-not-configured",
  "quota-exhausted",
  "policy-not-configured",
] as const;

export type CoachingAvailabilityReasonCode = (typeof COACHING_AVAILABILITY_REASON_CODES)[number];

export interface CoachingAvailabilityReason {
  code: CoachingAvailabilityReasonCode;
  message: string;
}

export type CoachingCancelConfirmation = "process-exit" | "provider" | "unsupported";

export interface CoachingBackendCapabilities {
  /** Version of this capability shape. */
  capabilityVersion: number;
  /** Event-line protocol this backend emits. */
  protocolVersion: number;
  /** Read-only tools this backend can actually expose (subset of COACHED_TOOL_NAMES). */
  tools: CoachingToolName[];
  /** Product-level replay from stored events. */
  productReplay: boolean;
  /** Native continuation of the same backend's own session. */
  nativeContinuation: boolean;
  /** What counts as proof the execution stopped (capacity release). */
  cancelConfirmation: CoachingCancelConfirmation;
  maxInputBytes: number;
  maxEvents: number;
  maxEventBytes: number;
  /** Cloud backends REQUIRE server-verified account qualification. */
  accountEligibility: "not-required" | "required";
  /** Cloud backends REQUIRE a configured quota reservation. */
  quotaReservation: "not-required" | "required";
  /**
   * Where prompts/snapshots are sent. Never inferred from the runtime name.
   * A local CLI executes on the user's device but still sends the prompt and
   * snapshot-derived context to the CLI's configured model provider, so
   * `cli-provider` describes the data destination for local backends.
   */
  dataDestination: "cli-provider" | "vendor-api";
}

export interface CoachingBackendDescriptor {
  backendId: CoachingBackendId;
  runtimeId: CoachingRuntimeId;
  executionLocation: CoachingExecutionLocation;
  displayName: string;
  available: boolean;
  /** Required when `available` is false; forbidden when true. */
  unavailableReason?: CoachingAvailabilityReason;
  version?: string;
  capabilities: CoachingBackendCapabilities;
}

export interface CoachingCapabilityDiscovery {
  discoveryVersion: number;
  protocolVersion: number;
  /** Read-only tool names shared by this deployment (never write tools). */
  tools: CoachingToolName[];
  backends: CoachingBackendDescriptor[];
}

/**
 * Trusted account classification supplied by the identity layer (#5).
 *
 * MUST be derived from a validated bearer/server session, never from request
 * body fields, guest flags, local storage, or UI state. A missing/unset
 * classification fails cloud qualification closed.
 */
export interface CoachingTrustedIdentity {
  accountId: string;
  isAnonymous: boolean;
}

/** Server-configured cloud quota. Missing configuration is NOT unlimited. */
export interface CoachingCloudQuota {
  configured: boolean;
  remaining: number;
  /**
   * False when the quota has only a concurrency count and no finite
   * token/request budget. Omitted for legacy callers, but a present false
   * fails cloud qualification closed.
   */
  budgetConfigured?: boolean;
}

export interface CoachingCloudQualificationInput {
  identity?: CoachingTrustedIdentity | null;
  quota?: CoachingCloudQuota | null;
  providerConfigured?: boolean;
}

export interface CoachingCloudQualification {
  eligible: boolean;
  reason?: CoachingAvailabilityReason;
}

/**
 * Fail-closed cloud gate. Guests (anonymous accounts) may use their own LOCAL
 * agent only; cloud requires an authoritative formal-account classification
 * AND configured remaining quota AND configured provider. There is
 * deliberately no client-controlled guest/entitlement flag in this input.
 */
export function qualifyCloudBackend(input: CoachingCloudQualificationInput): CoachingCloudQualification {
  const identity = input.identity;
  if (
    identity === undefined ||
    identity === null ||
    typeof identity.accountId !== "string" ||
    identity.accountId.trim() === "" ||
    typeof identity.isAnonymous !== "boolean"
  ) {
    return unavailable("identity-unverified", "Cloud coaching requires a server-verified account identity.");
  }
  if (identity.isAnonymous) {
    return unavailable(
      "guest-cloud-forbidden",
      "Guest accounts can use their own local agent only; cloud coaching requires a formal account.",
    );
  }
  if (input.providerConfigured !== true) {
    return unavailable("provider-unconfigured", "Cloud coaching is not configured on this server.");
  }
  const quota = input.quota;
  if (quota === undefined || quota === null || quota.configured !== true) {
    return unavailable("quota-not-configured", "Cloud coaching quota is not configured.");
  }
  if (quota.budgetConfigured === false) {
    return unavailable(
      "quota-not-configured",
      "Cloud coaching quota has no finite execution budget configured.",
    );
  }
  if (typeof quota.remaining !== "number" || !Number.isFinite(quota.remaining) || quota.remaining < 1) {
    return unavailable("quota-exhausted", "No cloud coaching quota remains for this account.");
  }
  return { eligible: true };
}

function unavailable(
  code: CoachingAvailabilityReasonCode,
  message: string,
): CoachingCloudQualification {
  return { eligible: false, reason: { code, message } };
}

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
  /**
   * Execution engine. Kept for v1 clients; always paired with the backend
   * recorded below. Legacy runs without `backendId` are local-pi.
   */
  runtimeId: string;
  /** Backend pinned at run creation (replay/cancel resolve against it). */
  backendId?: CoachingBackendId;
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
  /**
   * Optional backend selection. Omit both fields for the legacy local-pi
   * mapping; a cloud backend must be named explicitly and is rejected unless
   * the server has already qualified the trusted account.
   */
  backendId?: CoachingBackendId;
  runtimeId?: CoachingRuntimeId;
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
  if (!isCoachingRuntimeId(run.runtimeId)) {
    fail(`${field}.runtimeId`, `must be one of ${COACHING_RUNTIME_IDS.join(", ")}`);
  }
  if (runObj.backendId !== undefined) {
    if (!isCoachingBackendId(runObj.backendId)) {
      fail(`${field}.backendId`, `must be one of ${COACHING_BACKEND_IDS.join(", ")}`);
    }
    const definition = COACHING_BACKEND_DEFINITIONS[runObj.backendId];
    if (definition.runtimeId !== run.runtimeId) {
      fail(
        `${field}.backendId`,
        `backend ${runObj.backendId} requires runtime ${definition.runtimeId}`,
      );
    }
    run.backendId = runObj.backendId;
  }
  // A legacy v1 run without backendId remains readable; clients resolve it as
  // local-pi via resolveCoachingBackendSelection({ runtimeId }), never cloud.
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
  // Validate the selection as a unit (backend/runtime must agree) but keep
  // omitted fields omitted: the service applies the legacy local-pi default.
  const selection = resolveCoachingBackendSelection({
    backendId: value.backendId,
    runtimeId: value.runtimeId,
  });
  if (value.backendId !== undefined) input.backendId = selection.backendId;
  if (value.runtimeId !== undefined) input.runtimeId = selection.runtimeId;
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

/** Guard the legacy runtime descriptor; ids are validated, `kind` is informational. */
export function parseCoachingRuntimeInfo(value: unknown): CoachingRuntimeInfo {
  if (!isObject(value)) fail("(root)", "must be an object");
  const id = assertNonBlankString(value.id, "id");
  if (!isCoachingRuntimeId(id)) {
    fail("id", `must be one of ${COACHING_RUNTIME_IDS.join(", ")}`);
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

function parseToolNames(value: unknown, field: string): CoachingToolName[] {
  if (!Array.isArray(value) || value.length === 0) fail(field, "must be a non-empty array");
  const seen = new Set<string>();
  return value.map((entry: unknown, index: number) => {
    const name = assertNonBlankString(entry, `${field}[${index}]`);
    if (!(COACHED_TOOL_NAMES as readonly string[]).includes(name)) {
      fail(`${field}[${index}]`, `must be a read-only coached tool (${COACHED_TOOL_NAMES.join(", ")})`);
    }
    if (seen.has(name)) fail(`${field}[${index}]`, "duplicate tool name");
    seen.add(name);
    return name as CoachingToolName;
  });
}

function parseAvailabilityReason(value: unknown, field: string): CoachingAvailabilityReason {
  if (!isObject(value)) fail(field, "must be an object");
  const code = assertNonBlankString(value.code, `${field}.code`);
  if (!(COACHING_AVAILABILITY_REASON_CODES as readonly string[]).includes(code)) {
    fail(`${field}.code`, `must be one of ${COACHING_AVAILABILITY_REASON_CODES.join(", ")}`);
  }
  return { code: code as CoachingAvailabilityReasonCode, message: assertNonBlankString(value.message, `${field}.message`) };
}

function assertPositiveInt(value: unknown, field: string): number {
  const parsed = assertSafeNonNegativeInt(value, field);
  if (parsed === 0) fail(field, "must be > 0");
  return parsed;
}

/** Guard one backend capability block. */
export function parseCoachingBackendCapabilities(value: unknown): CoachingBackendCapabilities {
  if (!isObject(value)) fail("(root)", "must be an object");
  const capabilityVersion = assertSafeNonNegativeInt(value.capabilityVersion, "capabilityVersion");
  if (capabilityVersion !== COACHING_CAPABILITY_VERSION) {
    fail("capabilityVersion", `must be ${COACHING_CAPABILITY_VERSION}`);
  }
  const protocolVersion = assertSafeNonNegativeInt(value.protocolVersion, "protocolVersion");
  if (protocolVersion !== COACHING_PROTOCOL_VERSION) {
    fail("protocolVersion", `must be ${COACHING_PROTOCOL_VERSION}`);
  }
  const cancelConfirmation = assertNonBlankString(value.cancelConfirmation, "cancelConfirmation");
  if (
    cancelConfirmation !== "process-exit" &&
    cancelConfirmation !== "provider" &&
    cancelConfirmation !== "unsupported"
  ) {
    fail("cancelConfirmation", "must be one of process-exit, provider, unsupported");
  }
  const accountEligibility = assertNonBlankString(value.accountEligibility, "accountEligibility");
  if (accountEligibility !== "not-required" && accountEligibility !== "required") {
    fail("accountEligibility", "must be one of not-required, required");
  }
  const quotaReservation = assertNonBlankString(value.quotaReservation, "quotaReservation");
  if (quotaReservation !== "not-required" && quotaReservation !== "required") {
    fail("quotaReservation", "must be one of not-required, required");
  }
  const dataDestination = assertNonBlankString(value.dataDestination, "dataDestination");
  if (dataDestination !== "cli-provider" && dataDestination !== "vendor-api") {
    fail("dataDestination", "must be one of cli-provider, vendor-api");
  }
  for (const flag of ["productReplay", "nativeContinuation"] as const) {
    if (typeof value[flag] !== "boolean") fail(flag, "must be a boolean");
  }
  return {
    capabilityVersion,
    protocolVersion,
    tools: parseToolNames(value.tools, "tools"),
    productReplay: value.productReplay as boolean,
    nativeContinuation: value.nativeContinuation as boolean,
    cancelConfirmation: cancelConfirmation as CoachingCancelConfirmation,
    maxInputBytes: assertPositiveInt(value.maxInputBytes, "maxInputBytes"),
    maxEvents: assertPositiveInt(value.maxEvents, "maxEvents"),
    maxEventBytes: assertPositiveInt(value.maxEventBytes, "maxEventBytes"),
    accountEligibility,
    quotaReservation,
    dataDestination,
  };
}

/**
 * Guard one backend descriptor. Invariants enforced here (not just in
 * adapters): backend/runtime pairs are fixed, unavailable implies a reason,
 * available forbids one, and a cloud backend must require account
 * qualification and quota reservation.
 */
export function parseCoachingBackendDescriptor(value: unknown): CoachingBackendDescriptor {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (!isCoachingBackendId(value.backendId)) {
    fail("backendId", `must be one of ${COACHING_BACKEND_IDS.join(", ")}`);
  }
  if (!isCoachingRuntimeId(value.runtimeId)) {
    fail("runtimeId", `must be one of ${COACHING_RUNTIME_IDS.join(", ")}`);
  }
  const definition = COACHING_BACKEND_DEFINITIONS[value.backendId];
  if (definition.runtimeId !== value.runtimeId) {
    fail("runtimeId", `backend ${value.backendId} requires runtime ${definition.runtimeId}`);
  }
  if (value.executionLocation !== definition.executionLocation) {
    fail("executionLocation", `backend ${value.backendId} requires ${definition.executionLocation}`);
  }
  if (typeof value.available !== "boolean") fail("available", "must be a boolean");
  let unavailableReason: CoachingAvailabilityReason | undefined;
  if (value.available) {
    if (value.unavailableReason !== undefined) {
      fail("unavailableReason", "must be omitted when the backend is available");
    }
  } else {
    unavailableReason = parseAvailabilityReason(value.unavailableReason, "unavailableReason");
  }
  const capabilities = parseCoachingBackendCapabilities(value.capabilities);
  if (definition.executionLocation === "cloud") {
    if (capabilities.accountEligibility !== "required") {
      fail("capabilities.accountEligibility", "cloud backends must require server-verified account eligibility");
    }
    if (capabilities.quotaReservation !== "required") {
      fail("capabilities.quotaReservation", "cloud backends must require a quota reservation");
    }
    if (capabilities.dataDestination !== "vendor-api") {
      fail("capabilities.dataDestination", "cloud backends must send data to the vendor API");
    }
  }
  const descriptor: CoachingBackendDescriptor = {
    backendId: value.backendId,
    runtimeId: value.runtimeId,
    executionLocation: definition.executionLocation,
    displayName: assertNonBlankString(value.displayName, "displayName"),
    available: value.available,
    capabilities,
  };
  if (unavailableReason !== undefined) descriptor.unavailableReason = unavailableReason;
  if (value.version !== undefined) descriptor.version = assertNonBlankString(value.version, "version");
  return descriptor;
}

/** Guard the versioned discovery response returned to clients. */
export function parseCoachingCapabilityDiscovery(value: unknown): CoachingCapabilityDiscovery {
  if (!isObject(value)) fail("(root)", "must be an object");
  const discoveryVersion = assertSafeNonNegativeInt(value.discoveryVersion, "discoveryVersion");
  if (discoveryVersion !== COACHING_DISCOVERY_VERSION) {
    fail("discoveryVersion", `must be ${COACHING_DISCOVERY_VERSION}`);
  }
  const protocolVersion = assertSafeNonNegativeInt(value.protocolVersion, "protocolVersion");
  if (protocolVersion !== COACHING_PROTOCOL_VERSION) {
    fail("protocolVersion", `must be ${COACHING_PROTOCOL_VERSION}`);
  }
  if (!Array.isArray(value.backends) || value.backends.length === 0) {
    fail("backends", "must be a non-empty array");
  }
  const seen = new Set<string>();
  const backends = value.backends.map((entry: unknown, index: number) => {
    let descriptor: CoachingBackendDescriptor;
    try {
      descriptor = parseCoachingBackendDescriptor(entry);
    } catch (error) {
      if (error instanceof MalformedResponseError) fail(`backends[${index}]`, error.message);
      throw error;
    }
    if (seen.has(descriptor.backendId)) fail(`backends[${index}].backendId`, "duplicate backend");
    seen.add(descriptor.backendId);
    return descriptor;
  });
  return {
    discoveryVersion,
    protocolVersion,
    tools: parseToolNames(value.tools, "tools"),
    backends,
  };
}

/** Guard the public bootstrap config (`{ supabaseUrl, supabasePublishableKey }`). */
export function parsePublicApiConfig(value: unknown): {
  supabaseUrl: string;
  supabasePublishableKey: string;
  guestSignInEnabled?: boolean;
  guestUpgradeEnabled?: boolean;
  guestSignInCaptchaRequired?: boolean;
} {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (value.guestSignInEnabled !== undefined && typeof value.guestSignInEnabled !== "boolean") {
    fail("guestSignInEnabled", "must be a boolean");
  }
  if (value.guestUpgradeEnabled !== undefined && typeof value.guestUpgradeEnabled !== "boolean") {
    fail("guestUpgradeEnabled", "must be a boolean");
  }
  if (
    value.guestSignInCaptchaRequired !== undefined &&
    typeof value.guestSignInCaptchaRequired !== "boolean"
  ) {
    fail("guestSignInCaptchaRequired", "must be a boolean");
  }
  return {
    supabaseUrl: assertNonBlankString(value.supabaseUrl, "supabaseUrl"),
    supabasePublishableKey: assertNonBlankString(value.supabasePublishableKey, "supabasePublishableKey"),
    ...(value.guestSignInEnabled === undefined
      ? {}
      : { guestSignInEnabled: value.guestSignInEnabled }),
    ...(value.guestUpgradeEnabled === undefined
      ? {}
      : { guestUpgradeEnabled: value.guestUpgradeEnabled }),
    ...(value.guestSignInCaptchaRequired === undefined
      ? {}
      : { guestSignInCaptchaRequired: value.guestSignInCaptchaRequired }),
  };
}
