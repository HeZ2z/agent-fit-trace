/**
 * Pure transport model for the mobile hosted cloud coach.
 *
 * This module owns the environment-free pieces of the mobile coaching slice:
 * API-base resolution, SSE/JSON event-frame parsing, the event -> chat-view
 * reducer, cursor/abort/cancel decisions, and redacted error classification.
 * It imports no React, expo, storage, DOM, fetch or clock, so the root
 * `node:test` suite can load it through Node's TypeScript type stripping (see
 * `tests/mobileCoachModel.test.ts`).
 *
 * The event envelope and wire budgets come from `@agent-fit-trace/api-contracts`
 * so the mobile and web clients validate the exact same protocol the server
 * writes. The hosted cloud coach is the only mobile coaching backend; the
 * local CLI coach stays on desktop.
 */

import {
  API_ERROR_CODES,
  CLOUD_ERROR_CODES,
  COACHING_ERROR_CODES,
  MAX_COACHING_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  parseCoachingEventEnvelope,
} from "@agent-fit-trace/api-contracts";
import type {
  CoachingEventEnvelope,
  CoachingEventPayload,
  CoachingTerminalStatus,
} from "@agent-fit-trace/api-contracts";

export {
  MAX_COACHING_SSE_FRAME_BYTES as MAX_COACH_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES as MAX_COACH_SSE_TOTAL_BYTES,
};

/** An SSE frame is the `id:`/`data:` block plus its two-byte `\n\n` separator. */
export const COACH_SSE_FRAME_OVERHEAD_BYTES = 2;

/** The typed event union the server emits (data-frame payloads). */
export type CoachEventPayload = CoachingEventPayload;

/** One validated run event. The union member is `envelope.event`. */
export type CoachEventEnvelope = CoachingEventEnvelope;

/** Identity an event frame must match before it can be folded. */
export interface CoachStreamIdentity {
  readonly sessionId: string;
  readonly runId: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * An unconfigured build is a first-class state, not a crash: the Coach screen
 * can render a setup hint while the rest of the local app keeps working.
 */
export type CoachConfig =
  | { readonly configured: true; readonly apiBaseUrl: string }
  | { readonly configured: false; readonly reason: "missing" | "invalid" };

export const UNCONFIGURED_COACH_CONFIG: CoachConfig = {
  configured: false,
  reason: "missing",
};

/**
 * Resolve `EXPO_PUBLIC_FIT_TRACE_API_URL` into the deployed API base.
 *
 * Accepted input is an absolute http(s) API origin (or its `/api/v1` base).
 * Credentials, query strings, fragments and non-http schemes are rejected.
 * The client appends `/api/v1/coaching/cloud/...`; a value that already ends
 * in `/api/v1` is used verbatim so both documented spellings work. A blank or
 * malformed value resolves to `configured: false`; this function never throws.
 */
export function resolveCoachConfig(raw: string | null | undefined): CoachConfig {
  if (typeof raw !== "string" || raw.trim() === "") {
    return UNCONFIGURED_COACH_CONFIG;
  }
  const apiBaseUrl = normalizeCoachApiBaseUrl(raw);
  if (apiBaseUrl === null) return { configured: false, reason: "invalid" };
  return { configured: true, apiBaseUrl };
}

/** Normalize one configured value; `null` means missing/invalid. */
export function normalizeCoachApiBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.hostname === "") return null;
  const path = url.pathname.replace(/\/+$/, "");
  const base = path === "" ? url.origin : `${url.origin}${path}`;
  return path.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

export function isCoachConfigured(config: CoachConfig): config is {
  readonly configured: true;
  readonly apiBaseUrl: string;
} {
  return config.configured;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CoachErrorCode =
  | "unconfigured"
  | "unauthenticated"
  | "forbidden"
  | "quota"
  | "kill-switch"
  | "busy"
  | "conflict"
  | "not-found"
  | "expired-cursor"
  | "validation"
  | "rate-limited"
  | "unavailable"
  | "network"
  | "timeout"
  | "malformed"
  | "cancelled"
  | "server";

export type CoachErrorCategory =
  | "config"
  | "auth"
  | "capacity"
  | "availability"
  | "network"
  | "protocol"
  | "input"
  | "cancelled"
  | "server";

const COACH_ERROR_CATEGORIES: Record<CoachErrorCode, CoachErrorCategory> = {
  unconfigured: "config",
  unauthenticated: "auth",
  forbidden: "auth",
  quota: "capacity",
  "kill-switch": "availability",
  busy: "capacity",
  conflict: "input",
  "not-found": "input",
  "expired-cursor": "input",
  validation: "input",
  "rate-limited": "availability",
  unavailable: "availability",
  network: "network",
  timeout: "network",
  malformed: "protocol",
  cancelled: "cancelled",
  server: "server",
};

const COACH_ERROR_RETRYABLE: Record<CoachErrorCode, boolean> = {
  unconfigured: false,
  unauthenticated: false,
  forbidden: false,
  quota: false,
  "kill-switch": false,
  busy: true,
  conflict: false,
  "not-found": false,
  "expired-cursor": false,
  validation: false,
  "rate-limited": true,
  unavailable: true,
  network: true,
  timeout: true,
  malformed: false,
  cancelled: false,
  server: true,
};

/** Stable i18n keys; the screen owns display copy and translation. */
export const COACH_ERROR_MESSAGE_KEYS: Readonly<Record<CoachErrorCode, string>> = {
  unconfigured: "coach.error.unconfigured",
  unauthenticated: "coach.error.unauthenticated",
  forbidden: "coach.error.forbidden",
  quota: "coach.error.quota",
  "kill-switch": "coach.error.killSwitch",
  busy: "coach.error.busy",
  conflict: "coach.error.conflict",
  "not-found": "coach.error.notFound",
  "expired-cursor": "coach.error.expiredCursor",
  validation: "coach.error.validation",
  "rate-limited": "coach.error.rateLimited",
  unavailable: "coach.error.unavailable",
  network: "coach.error.network",
  timeout: "coach.error.timeout",
  malformed: "coach.error.malformed",
  cancelled: "coach.error.cancelled",
  server: "coach.error.server",
};

/** English source strings. The screen translates via {@link coachErrorMessageKey}. */
const COACH_ERROR_MESSAGES: Readonly<Record<CoachErrorCode, string>> = {
  unconfigured:
    "Cloud coaching is not configured in this build. Set EXPO_PUBLIC_FIT_TRACE_API_URL to enable it.",
  unauthenticated: "Sign in to use the cloud coach.",
  forbidden: "This account cannot use cloud coaching. Sign in with a formal account.",
  quota: "Cloud coaching quota is exhausted or not configured. Try again later.",
  "kill-switch": "Cloud coaching is temporarily disabled.",
  busy: "A coaching run is already active. Wait for it to finish or cancel it.",
  conflict: "This coaching request conflicts with an earlier attempt.",
  "not-found": "The coaching run or session is no longer available.",
  "expired-cursor": "The coaching event cursor expired. Reload the run from the beginning.",
  validation: "The coaching request was rejected. Review it and try again.",
  "rate-limited": "Too many coaching requests. Wait a moment and try again.",
  unavailable: "Cloud coaching is temporarily unavailable. Try again later.",
  network: "The cloud coaching service could not be reached. Check your connection and try again.",
  timeout: "The coaching stream ended before the run finished. Reconnect to resume.",
  malformed: "The coaching service sent an unreadable response.",
  cancelled: "The coaching request was cancelled.",
  server: "The cloud coaching service failed. Try again later.",
};

function hasCode(code: string): code is CoachErrorCode {
  return Object.prototype.hasOwnProperty.call(COACH_ERROR_MESSAGES, code);
}

export function coachErrorMessageKey(code: string): string {
  return hasCode(code)
    ? (COACH_ERROR_MESSAGE_KEYS[code] ?? COACH_ERROR_MESSAGE_KEYS.server)
    : COACH_ERROR_MESSAGE_KEYS.server;
}

export function coachErrorMessage(code: string): string {
  return hasCode(code) ? COACH_ERROR_MESSAGES[code] : COACH_ERROR_MESSAGES.server;
}

export function coachErrorCategory(code: string): CoachErrorCategory {
  return hasCode(code) ? COACH_ERROR_CATEGORIES[code] : "server";
}

export function isRetryableCoachCode(code: string): boolean {
  return hasCode(code) ? COACH_ERROR_RETRYABLE[code] : true;
}

/**
 * Redacted typed failure. Messages never include a bearer token, prompt, raw
 * body or URL; callers may pass a short safe diagnostic only.
 */
export class CoachError extends Error {
  readonly code: CoachErrorCode;
  readonly category: CoachErrorCategory;
  readonly messageKey: string;
  readonly httpStatus: number | undefined;
  readonly serverCode: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: CoachErrorCode,
    options: {
      message?: string;
      httpStatus?: number;
      serverCode?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      options.message ?? coachErrorMessage(code),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CoachError";
    this.code = code;
    this.category = coachErrorCategory(code);
    this.messageKey = coachErrorMessageKey(code);
    this.httpStatus = options.httpStatus;
    this.serverCode = options.serverCode;
    this.retryable = isRetryableCoachCode(code);
  }
}

export function isCoachError(value: unknown): value is CoachError {
  return value instanceof CoachError;
}

/** True for our cancellation and for an aborted fetch/reader (`AbortError`). */
export function isCancelledError(value: unknown): boolean {
  if (value instanceof CoachError) return value.code === "cancelled";
  if (typeof value !== "object" || value === null) return false;
  const record = value as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

/** Normalize any thrown value to a typed, redacted coach failure. */
export function toCoachError(cause: unknown, fallback: CoachErrorCode = "network"): CoachError {
  if (cause instanceof CoachError) return cause;
  if (isCancelledError(cause)) {
    return new CoachError("cancelled", cause === undefined ? undefined : { cause });
  }
  if (cause instanceof TypeError) {
    return new CoachError("network", { cause });
  }
  return new CoachError(fallback, { cause });
}

export function isRetryableCoachError(error: unknown): boolean {
  return error instanceof CoachError && error.retryable;
}

function serverErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

function mapCloudServerCode(code: string | null): CoachErrorCode | null {
  switch (code) {
    case API_ERROR_CODES.UNAUTHENTICATED:
      return "unauthenticated";
    case API_ERROR_CODES.FORBIDDEN:
      return "forbidden";
    case API_ERROR_CODES.VALIDATION_ERROR:
      return "validation";
    case API_ERROR_CODES.STORAGE_UNAVAILABLE:
      return "unavailable";
    case CLOUD_ERROR_CODES.ACCOUNT_NOT_FORMAL:
      return "forbidden";
    case CLOUD_ERROR_CODES.QUOTA_EXHAUSTED:
    case CLOUD_ERROR_CODES.QUOTA_NOT_CONFIGURED:
      return "quota";
    case CLOUD_ERROR_CODES.KILL_SWITCH:
    case CLOUD_ERROR_CODES.CLOUD_DISABLED:
      return "kill-switch";
    case CLOUD_ERROR_CODES.PROVIDER_UNCONFIGURED:
    case CLOUD_ERROR_CODES.PROVIDER_NOT_ACCEPTED:
    case CLOUD_ERROR_CODES.LEASE_LOST:
    case CLOUD_ERROR_CODES.EXECUTION_UNCONFIRMED:
      return "unavailable";
    case COACHING_ERROR_CODES.RUN_BUSY:
      return "busy";
    case CLOUD_ERROR_CODES.IDEMPOTENCY_CONFLICT:
      return "conflict";
    case CLOUD_ERROR_CODES.SESSION_NOT_FOUND:
    case CLOUD_ERROR_CODES.SNAPSHOT_NOT_FOUND:
    case CLOUD_ERROR_CODES.RUN_NOT_FOUND:
      return "not-found";
    case CLOUD_ERROR_CODES.EXPIRED_CURSOR:
    case COACHING_ERROR_CODES.EXPIRED_CURSOR:
      return "expired-cursor";
    default:
      return null;
  }
}

function mapHttpStatus(status: number): CoachErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 402) return "quota";
  if (status === 400) return "validation";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 410) return "expired-cursor";
  if (status === 408) return "network";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  return "server";
}

/**
 * Classify a non-2xx cloud response. The server code wins (so a
 * `KILL_SWITCH`/`QUOTA_EXHAUSTED`/`EXPIRED_CURSOR` keeps its identity); the
 * HTTP status is the fallback. The raw message/body is deliberately dropped.
 */
export function coachErrorFromHttp(status: number, body: unknown): CoachError {
  const serverCode = serverErrorCode(body);
  const mapped = mapCloudServerCode(serverCode);
  const code = mapped ?? mapHttpStatus(status);
  return new CoachError(code, {
    httpStatus: status,
    ...(serverCode === null ? {} : { serverCode }),
  });
}

export function cancelledCoachError(): CoachError {
  return new CoachError("cancelled");
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

/** UTF-8 byte length without relying on `TextEncoder` (Hermes-safe, pure). */
export function coachUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      // Lone surrogates are replaced by U+FFFD on the wire.
      bytes += 3;
    }
  }
  return bytes;
}

export function coachFrameBytes(frame: string): number {
  return coachUtf8ByteLength(frame) + COACH_SSE_FRAME_OVERHEAD_BYTES;
}

export interface CoachFrameSizeOptions {
  /** Defaults to the shared one-megabyte frame budget. */
  readonly maxBytes?: number;
}

/** Reject a complete frame (including its two-byte separator) over budget. */
export function assertCoachFrameSize(frame: string, options: CoachFrameSizeOptions = {}): void {
  const maxBytes = options.maxBytes ?? MAX_COACHING_SSE_FRAME_BYTES;
  if (coachFrameBytes(frame) > maxBytes) {
    throw new CoachError("malformed", {
      message: "The coaching event frame exceeded the byte limit.",
    });
  }
}

/**
 * Split complete SSE blocks from an incrementally decoded buffer.
 *
 * Understands LF, CRLF and lone CR line endings, and keeps a trailing CR
 * pending so a chunk split inside `\r\n` is not misread. The returned `rest`
 * is the unterminated tail (normalized newlines) to prepend to the next chunk.
 */
export function takeCoachSseFrames(buffer: string): {
  readonly frames: readonly string[];
  readonly rest: string;
} {
  const normalized = normalizeSseNewlines(buffer);
  const frames: string[] = [];
  let start = 0;
  for (;;) {
    const boundary = normalized.indexOf("\n\n", start);
    if (boundary === -1) break;
    frames.push(normalized.slice(start, boundary));
    start = boundary + 2;
  }
  return { frames, rest: normalized.slice(start) };
}

function normalizeSseNewlines(value: string): string {
  if (!value.includes("\r")) return value;
  const endsWithCr = value.endsWith("\r");
  const body = endsWithCr ? value.slice(0, -1) : value;
  const normalized = body.replace(/\r\n?/g, "\n");
  return endsWithCr ? `${normalized}\r` : normalized;
}

export interface CoachEventParseOptions {
  /** Expected stream identity; a foreign id is a malformed frame. */
  readonly expected?: CoachStreamIdentity;
  /** Frame-size budget override (tests and defensive embedding). */
  readonly maxBytes?: number;
}

/**
 * Parse one `data:`-carrying SSE block into a validated event envelope.
 *
 * Comment-only keep-alives return `null`. Multi-line `data:` fields are joined
 * with `\n` per the SSE spec. An `id:` field, when present, must equal the
 * envelope's own dense `seq`. Malformed JSON, a protocol mismatch, a foreign
 * stream or an oversized frame throw {@link CoachError} `malformed`; the raw
 * frame is never included in the error.
 */
export function parseCoachSseBlock(
  block: string,
  options: CoachEventParseOptions = {},
): CoachEventEnvelope | null {
  assertCoachFrameSize(block, { maxBytes: options.maxBytes });
  const withoutBom = block.startsWith("\uFEFF") ? block.slice(1) : block;
  const dataLines: string[] = [];
  let idValue: string | null = null;
  for (const line of withoutBom.split(/\r\n|\r|\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "id") idValue = value;
  }
  if (dataLines.length === 0) return null;
  const envelope = parseCoachEventJson(dataLines.join("\n"), options);
  if (idValue !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(idValue)) {
      throw new CoachError("malformed", {
        message: "The coaching event frame has an invalid id field.",
      });
    }
    const id = Number(idValue);
    if (!Number.isSafeInteger(id) || id !== envelope.seq) {
      throw new CoachError("malformed", {
        message: "The coaching event frame id does not match its sequence.",
      });
    }
  }
  return envelope;
}

/** Parse a standalone JSON event frame (the cloud route's non-SSE shape). */
export function parseCoachEventJson(
  raw: string,
  options: CoachEventParseOptions = {},
): CoachEventEnvelope {
  if (options.maxBytes !== undefined) {
    if (coachUtf8ByteLength(raw) > options.maxBytes) {
      throw new CoachError("malformed", {
        message: "The coaching event frame exceeded the byte limit.",
      });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CoachError("malformed", {
      message: "The coaching event frame is not valid JSON.",
    });
  }
  let envelope: CoachEventEnvelope;
  try {
    envelope = parseCoachingEventEnvelope(parsed);
  } catch (error) {
    throw new CoachError("malformed", {
      message: "The coaching event frame does not match the protocol.",
      cause: error,
    });
  }
  const expected = options.expected;
  if (
    expected !== undefined &&
    (envelope.sessionId !== expected.sessionId || envelope.runId !== expected.runId)
  ) {
    throw new CoachError("malformed", {
      message: "The coaching event belongs to a different stream.",
    });
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// Chat view reducer
// ---------------------------------------------------------------------------

export type CoachTerminal = {
  readonly status: CoachingTerminalStatus;
  readonly reason: string | null;
  readonly seq: number;
};

export type CoachRunFailure = {
  readonly code: string;
  readonly message: string;
  readonly seq: number;
};

export type CoachStatusEntry =
  | {
      readonly kind: "tool-start";
      readonly seq: number;
      readonly tool: string;
      readonly callId: string;
    }
  | {
      readonly kind: "tool-end";
      readonly seq: number;
      readonly tool: string;
      readonly callId: string;
      readonly ok: boolean;
      readonly detail?: string;
    }
  | { readonly kind: "analysis-result"; readonly seq: number }
  | { readonly kind: "run-error"; readonly seq: number; readonly code: string };

/**
 * Everything the Coach screen needs to render one ask. Derived data only:
 * canonical run status still comes from the server's run read.
 */
export interface CoachChatState {
  readonly question: string;
  readonly assistantText: string;
  readonly statuses: readonly CoachStatusEntry[];
  readonly terminal: CoachTerminal | null;
  readonly runError: CoachRunFailure | null;
  /** Last folded seq; `-1` before the first event (dense 0-based log). */
  readonly lastSeq: number;
}

export type CoachFoldStatus = "applied" | "duplicate" | "gap" | "terminal-frozen";

export interface CoachFoldResult {
  readonly state: CoachChatState;
  readonly status: CoachFoldStatus;
  /** Seq the next event must carry for a gap-free fold. */
  readonly expectedSeq: number;
}

/** Start a fold at `fromSeq` (the first seq still needed; `0` for fresh). */
export function createCoachChatState(question: string, fromSeq = 0): CoachChatState {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new CoachError("validation", {
      message: "`fromSeq` must be a safe non-negative integer.",
    });
  }
  return {
    question,
    assistantText: "",
    statuses: [],
    terminal: null,
    runError: null,
    lastSeq: fromSeq - 1,
  };
}

export function applyCoachEvents(
  state: CoachChatState,
  envelopes: readonly CoachEventEnvelope[],
): CoachFoldResult {
  let result: CoachFoldResult = {
    state,
    status: "applied",
    expectedSeq: state.lastSeq + 1,
  };
  for (const envelope of envelopes) {
    result = applyCoachEvent(result.state, envelope);
    if (result.status === "gap") return result;
  }
  return result;
}

/**
 * Fold exactly one event without mutating the input state.
 *
 * - `duplicate`: already-consumed seq, ignored.
 * - `terminal-frozen`: any event after a confirmed terminal, ignored.
 * - `gap`: a missing seq; the caller must refetch from `firstSeq` and re-fold,
 *   never skip. The state is returned unchanged.
 */
export function applyCoachEvent(
  state: CoachChatState,
  envelope: CoachEventEnvelope,
): CoachFoldResult {
  const expectedSeq = state.lastSeq + 1;
  if (envelope.seq < expectedSeq) {
    return { state, status: "duplicate", expectedSeq };
  }
  if (state.terminal !== null) {
    return { state, status: "terminal-frozen", expectedSeq };
  }
  if (envelope.seq > expectedSeq) {
    return { state, status: "gap", expectedSeq };
  }

  const payload = envelope.event;
  switch (payload.type) {
    case "text_delta":
      return {
        state: {
          ...state,
          assistantText: state.assistantText + payload.delta,
          lastSeq: envelope.seq,
        },
        status: "applied",
        expectedSeq: envelope.seq + 1,
      };
    case "tool_start":
      return {
        state: {
          ...state,
          statuses: [
            ...state.statuses,
            {
              kind: "tool-start",
              seq: envelope.seq,
              tool: payload.tool,
              callId: payload.callId,
            },
          ],
          lastSeq: envelope.seq,
        },
        status: "applied",
        expectedSeq: envelope.seq + 1,
      };
    case "tool_end":
      return {
        state: {
          ...state,
          statuses: [
            ...state.statuses,
            {
              kind: "tool-end",
              seq: envelope.seq,
              tool: payload.tool,
              callId: payload.callId,
              ok: payload.ok,
              ...(payload.ok
                ? payload.summary === undefined
                  ? {}
                  : { detail: payload.summary }
                : { detail: payload.error }),
            },
          ],
          lastSeq: envelope.seq,
        },
        status: "applied",
        expectedSeq: envelope.seq + 1,
      };
    case "analysis_result":
      return {
        state: {
          ...state,
          statuses: [...state.statuses, { kind: "analysis-result", seq: envelope.seq }],
          lastSeq: envelope.seq,
        },
        status: "applied",
        expectedSeq: envelope.seq + 1,
      };
    case "run_error":
      return {
        state: {
          ...state,
          statuses: [
            ...state.statuses,
            { kind: "run-error", seq: envelope.seq, code: payload.code },
          ],
          runError: {
            code: payload.code,
            message: payload.message,
            seq: envelope.seq,
          },
          lastSeq: envelope.seq,
        },
        status: "applied",
        expectedSeq: envelope.seq + 1,
      };
    case "terminal":
      return {
        state: {
          ...state,
          terminal: {
            status: payload.status,
            reason: payload.reason ?? null,
            seq: envelope.seq,
          },
          lastSeq: envelope.seq,
        },
        status: "applied",
        expectedSeq: envelope.seq + 1,
      };
    default:
      // The contract parser rejects unknown payload types before this point;
      // consuming the seq keeps a future additive event gap-free rather than
      // inventing a status the protocol never sent.
      return {
        state: { ...state, lastSeq: envelope.seq },
        status: "applied",
        expectedSeq: envelope.seq + 1,
      };
  }
}

export function isCoachTerminalEvent(event: CoachEventPayload): boolean {
  return event.type === "terminal";
}

export function hasCoachTerminal(state: CoachChatState): boolean {
  return state.terminal !== null;
}

export type CoachPhase = "idle" | "streaming" | "done" | "failed" | "cancelled";

/** Coarse view phase; the transport owner still tracks connecting/retrying. */
export function coachPhase(state: CoachChatState): CoachPhase {
  if (state.terminal !== null) {
    if (state.terminal.status === "completed") return "done";
    if (state.terminal.status === "failed") return "failed";
    return "cancelled";
  }
  return state.lastSeq >= 0 ? "streaming" : "idle";
}

// ---------------------------------------------------------------------------
// Cursor / cancel decisions
// ---------------------------------------------------------------------------

/** First seq still needed after consuming `lastConsumed` (`-1` means none). */
export function coachNextFromSeq(lastConsumed: number): number {
  if (!Number.isSafeInteger(lastConsumed) || lastConsumed < -1) {
    throw new CoachError("validation", {
      message: "`lastConsumed` must be a safe integer >= -1.",
    });
  }
  return lastConsumed + 1;
}

/** Resume from the folded position without repeating the run POST. */
export function coachResumeFromSeq(state: CoachChatState): number {
  return coachNextFromSeq(state.lastSeq);
}

export function canResumeCoachStream(state: CoachChatState): boolean {
  return state.terminal === null;
}

export type CoachCancelPhase = "cancelling" | "cancelled" | "done" | "failed";

export interface CoachCancelPlan {
  /** Detach/reset the local stream; never a server run cancel on its own. */
  readonly abortStream: boolean;
  /** Send `POST /runs/:id/cancel` for this run. */
  readonly postCancel: boolean;
  readonly phase: CoachCancelPhase;
}

/**
 * Decide what Cancel means right now.
 *
 * A browser/mobile abort detaches only; it never cancels the run server-side.
 * A known non-terminal run therefore needs an explicit cancel POST, while a
 * confirmed terminal only needs the local stream detached. With no known run
 * there is nothing to cancel remotely, so Cancel resolves locally.
 */
export function planCoachCancel(input: {
  readonly runId: string | null;
  readonly terminal: CoachTerminal | null;
  readonly streamActive: boolean;
}): CoachCancelPlan {
  if (input.terminal !== null) {
    const phase: CoachCancelPhase =
      input.terminal.status === "completed"
        ? "done"
        : input.terminal.status === "failed"
          ? "failed"
          : "cancelled";
    return {
      abortStream: input.streamActive,
      postCancel: false,
      phase,
    };
  }
  if (input.runId !== null) {
    return {
      abortStream: input.streamActive,
      postCancel: true,
      phase: "cancelling",
    };
  }
  return {
    abortStream: input.streamActive,
    postCancel: false,
    phase: "cancelled",
  };
}
