import assert from "node:assert/strict";
import { test } from "node:test";

import { COACHING_PROTOCOL_VERSION } from "@pi-fit-trace/api-contracts";
import type { CoachingEventPayload } from "@pi-fit-trace/api-contracts";

import {
  COACH_ERROR_MESSAGE_KEYS,
  CoachError,
  MAX_COACH_SSE_FRAME_BYTES,
  applyCoachEvent,
  applyCoachEvents,
  assertCoachFrameSize,
  canResumeCoachStream,
  coachErrorFromHttp,
  coachErrorMessageKey,
  coachFrameBytes,
  coachNextFromSeq,
  coachPhase,
  coachResumeFromSeq,
  coachUtf8ByteLength,
  createCoachChatState,
  hasCoachTerminal,
  isCancelledError,
  isCoachTerminalEvent,
  isRetryableCoachError,
  parseCoachEventJson,
  parseCoachSseBlock,
  planCoachCancel,
  resolveCoachConfig,
  takeCoachSseFrames,
  toCoachError,
} from "../mobile/src/coach/coachModel.ts";
import type {
  CoachChatState,
  CoachEventEnvelope,
  CoachStreamIdentity,
  CoachTerminal,
} from "../mobile/src/coach/coachModel.ts";

/**
 * Pure coverage for the mobile cloud-coach transport model. No client, network,
 * expo module or clock is imported: frame parsing, the fold, cursor/cancel
 * decisions and error classification are deterministic.
 */

const STREAM: CoachStreamIdentity = { sessionId: "sess-1", runId: "run-1" };

function event(
  seq: number,
  payload: CoachingEventPayload,
  identity: CoachStreamIdentity = STREAM,
): CoachEventEnvelope {
  return {
    protocolVersion: COACHING_PROTOCOL_VERSION,
    sessionId: identity.sessionId,
    runId: identity.runId,
    seq,
    event: payload,
  };
}

function dataFrame(
  seq: number,
  payload: CoachingEventPayload,
  options: { id?: string; identity?: CoachStreamIdentity } = {},
): string {
  const id = options.id ?? String(seq);
  return `id: ${id}\ndata: ${JSON.stringify(event(seq, payload, options.identity))}`;
}

function fold(state: CoachChatState, envelopes: CoachEventEnvelope[]): CoachChatState {
  return applyCoachEvents(state, envelopes).state;
}

function assertCoachCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CoachError, `expected CoachError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("blank or missing API URLs resolve to unconfigured, never a crash", () => {
  assert.deepEqual(resolveCoachConfig(undefined), {
    configured: false,
    reason: "missing",
  });
  assert.deepEqual(resolveCoachConfig(null), {
    configured: false,
    reason: "missing",
  });
  assert.deepEqual(resolveCoachConfig("   "), {
    configured: false,
    reason: "missing",
  });
  assert.deepEqual(resolveCoachConfig("not a url"), {
    configured: false,
    reason: "invalid",
  });
});

test("only absolute http(s) API bases are accepted and /api/v1 is normalized once", () => {
  assert.deepEqual(resolveCoachConfig(" https://api.example.com/ "), {
    configured: true,
    apiBaseUrl: "https://api.example.com/api/v1",
  });
  assert.deepEqual(resolveCoachConfig("http://127.0.0.1:5199"), {
    configured: true,
    apiBaseUrl: "http://127.0.0.1:5199/api/v1",
  });
  assert.deepEqual(resolveCoachConfig("https://api.example.com/prefix/"), {
    configured: true,
    apiBaseUrl: "https://api.example.com/prefix/api/v1",
  });
  assert.deepEqual(resolveCoachConfig("https://api.example.com/api/v1/"), {
    configured: true,
    apiBaseUrl: "https://api.example.com/api/v1",
  });

  for (const invalid of [
    "ftp://api.example.com",
    "file:///tmp/api",
    "javascript:alert(1)",
    "api.example.com",
    "https://user:pass@api.example.com",
    "https://api.example.com?from=1",
    "https://api.example.com/#fragment",
  ]) {
    assert.equal(resolveCoachConfig(invalid).configured, false, invalid);
  }
});

// ---------------------------------------------------------------------------
// SSE/JSON frame parsing
// ---------------------------------------------------------------------------

test("one data frame parses into a typed envelope and ignores comments/unknown fields", () => {
  const block = [
    ": keep-alive comment",
    "event: message",
    "retry: 1000",
    dataFrame(3, { type: "text_delta", delta: "hello" }, { id: "3" }),
    ": trailing comment",
  ].join("\n");

  const envelope = parseCoachSseBlock(block, { expected: STREAM });
  assert.ok(envelope);
  assert.equal(envelope.seq, 3);
  assert.deepEqual(envelope.event, { type: "text_delta", delta: "hello" });
  assert.equal(envelope.sessionId, STREAM.sessionId);
  assert.equal(envelope.runId, STREAM.runId);

  assert.equal(parseCoachSseBlock(""), null);
  assert.equal(parseCoachSseBlock(": comment only\n: still comment"), null);
});

test("multi-line data fields are joined with newlines", () => {
  const json = JSON.stringify(event(0, { type: "text_delta", delta: "multi-line" })).replace(
    ',"sessionId"',
    ',\n"sessionId"',
  );
  const block = json
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");

  const envelope = parseCoachSseBlock(block, { expected: STREAM });
  assert.ok(envelope);
  assert.deepEqual(envelope.event, { type: "text_delta", delta: "multi-line" });
});

test("the id field must match the envelope seq", () => {
  assertCoachCode(
    () => parseCoachSseBlock(dataFrame(1, { type: "text_delta", delta: "x" }, { id: "2" })),
    "malformed",
  );
  assertCoachCode(
    () => parseCoachSseBlock(dataFrame(1, { type: "text_delta", delta: "x" }, { id: "1.0" })),
    "malformed",
  );
});

test("malformed JSON and protocol mismatches are typed malformed errors", () => {
  assertCoachCode(() => parseCoachSseBlock("id: 0\ndata: {not json}"), "malformed");

  const wrongVersion = JSON.stringify({
    ...event(0, { type: "text_delta", delta: "x" }),
    protocolVersion: COACHING_PROTOCOL_VERSION + 1,
  });
  assertCoachCode(() => parseCoachSseBlock(`data: ${wrongVersion}`), "malformed");

  const unknownType = JSON.stringify({
    ...event(0, { type: "text_delta", delta: "x" }),
    event: { type: "future_event" },
  });
  assertCoachCode(() => parseCoachSseBlock(`data: ${unknownType}`), "malformed");

  assertCoachCode(() => parseCoachEventJson("[1,2,3]"), "malformed");
  assertCoachCode(() => parseCoachEventJson("not json"), "malformed");
});

test("a foreign session/run id never folds into this stream", () => {
  assertCoachCode(
    () =>
      parseCoachSseBlock(dataFrame(0, { type: "text_delta", delta: "x" }), {
        expected: { sessionId: "sess-1", runId: "other-run" },
      }),
    "malformed",
  );
});

test("oversized frames are rejected by bytes, including multibyte content", () => {
  assert.equal(coachUtf8ByteLength("abc"), 3);
  assert.equal(coachUtf8ByteLength("é"), 2);
  assert.equal(coachUtf8ByteLength("中"), 3);
  assert.equal(coachUtf8ByteLength("😀"), 4);
  assert.equal(coachUtf8ByteLength("\uD800"), 3, "a lone surrogate is replaced by U+FFFD");
  assert.equal(coachFrameBytes("id: 0"), "id: 0".length + 2);

  assertCoachFrameSize("small", { maxBytes: 7 });
  assertCoachCode(() => assertCoachFrameSize("too-large", { maxBytes: 6 }), "malformed");
  assertCoachCode(
    () =>
      parseCoachSseBlock(
        `data: ${JSON.stringify(event(0, { type: "text_delta", delta: "中".repeat(20) }))}`,
        { maxBytes: 40 },
      ),
    "malformed",
  );
  assert.equal(MAX_COACH_SSE_FRAME_BYTES, 1024 * 1024);
});

test("takeCoachSseFrames handles chunk boundaries, comments and CRLF", () => {
  const first = takeCoachSseFrames(
    `${dataFrame(0, { type: "text_delta", delta: "a" })}\n\nid: 1\nda`,
  );
  assert.deepEqual(first.frames, [
    dataFrame(0, { type: "text_delta", delta: "a" }),
  ]);
  assert.equal(first.rest, "id: 1\nda");

  const second = takeCoachSseFrames(
    `${first.rest}ta: ${JSON.stringify(event(1, { type: "text_delta", delta: "b" }))}\n\n`,
  );
  assert.equal(second.frames.length, 1);
  assert.equal(second.rest, "");
  const envelope = parseCoachSseBlock(second.frames[0] ?? "");
  assert.ok(envelope);
  assert.deepEqual(envelope.event, { type: "text_delta", delta: "b" });

  const crlf = takeCoachSseFrames("id: 0\r\ndata: {}\r");
  assert.equal(crlf.frames.length, 0, "a trailing CR is held for the next chunk");
  const completed = takeCoachSseFrames(`${crlf.rest}\n\r\n`);
  assert.deepEqual(completed.frames, ["id: 0\ndata: {}"]);
  assert.equal(completed.rest, "");
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

test("text deltas concatenate in order and the fold never mutates its inputs", () => {
  const initial = Object.freeze(createCoachChatState("How is my squat?"));
  const deltas = Object.freeze([
    Object.freeze(event(0, { type: "text_delta", delta: "Your " })),
    Object.freeze(event(1, { type: "text_delta", delta: "squat is up." })),
  ]);

  const result = applyCoachEvents(initial, deltas);
  assert.equal(result.status, "applied");
  assert.equal(result.state.question, "How is my squat?");
  assert.equal(result.state.assistantText, "Your squat is up.");
  assert.equal(result.state.lastSeq, 1);
  assert.equal(result.expectedSeq, 2);
  assert.equal(coachPhase(result.state), "streaming");

  assert.equal(initial.assistantText, "");
  assert.equal(initial.lastSeq, -1);
  assert.deepEqual(initial.statuses, []);
});

test("duplicate, gap and post-terminal events are classified without changing state", () => {
  const start = createCoachChatState("q");
  const first = applyCoachEvent(start, event(0, { type: "text_delta", delta: "a" }));
  assert.equal(first.status, "applied");

  const duplicate = applyCoachEvent(first.state, event(0, { type: "text_delta", delta: "a" }));
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.state, first.state);
  assert.equal(duplicate.expectedSeq, 1);

  const gap = applyCoachEvent(first.state, event(3, { type: "text_delta", delta: "c" }));
  assert.equal(gap.status, "gap");
  assert.equal(gap.state, first.state);
  assert.equal(gap.expectedSeq, 1);

  const terminal = applyCoachEvent(
    first.state,
    event(1, { type: "terminal", status: "completed" }),
  );
  assert.equal(terminal.status, "applied");
  assert.equal(hasCoachTerminal(terminal.state), true);
  assert.equal(coachPhase(terminal.state), "done");

  const late = applyCoachEvent(terminal.state, event(2, { type: "text_delta", delta: "late" }));
  assert.equal(late.status, "terminal-frozen");
  assert.equal(late.state, terminal.state);
  assert.equal(late.state.assistantText, "a");
});

test("tool activity, run errors and the terminal are folded into the chat view", () => {
  const state = fold(createCoachChatState("Read my history"), [
    event(0, { type: "text_delta", delta: "Checking. " }),
    event(1, { type: "tool_start", tool: "list_workouts", callId: "call-1" }),
    event(2, {
      type: "tool_end",
      tool: "list_workouts",
      callId: "call-1",
      ok: true,
      summary: "12 records",
    }),
    event(3, {
      type: "tool_end",
      tool: "list_workouts",
      callId: "call-2",
      ok: false,
      error: "source unavailable",
    }),
    event(4, {
      type: "run_error",
      code: "EVENT_CAP",
      message: "The run event budget was exceeded.",
    }),
    event(5, { type: "terminal", status: "failed", reason: "budget" }),
  ]);

  assert.equal(state.assistantText, "Checking. ");
  assert.deepEqual(
    state.statuses.map((entry) => entry.kind),
    ["tool-start", "tool-end", "tool-end", "run-error"],
  );
  assert.deepEqual(state.statuses[1], {
    kind: "tool-end",
    seq: 2,
    tool: "list_workouts",
    callId: "call-1",
    ok: true,
    detail: "12 records",
  });
  assert.deepEqual(state.statuses[2], {
    kind: "tool-end",
    seq: 3,
    tool: "list_workouts",
    callId: "call-2",
    ok: false,
    detail: "source unavailable",
  });
  assert.deepEqual(state.runError, {
    code: "EVENT_CAP",
    message: "The run event budget was exceeded.",
    seq: 4,
  });
  assert.deepEqual(state.terminal, { status: "failed", reason: "budget", seq: 5 });
  assert.equal(coachPhase(state), "failed");

  const terminalEvent = event(5, { type: "terminal", status: "failed" });
  assert.equal(isCoachTerminalEvent(terminalEvent.event), true);
  assert.equal(isCoachTerminalEvent({ type: "text_delta", delta: "x" }), false);
});

// ---------------------------------------------------------------------------
// Resume / abort / cancel decisions
// ---------------------------------------------------------------------------

test("the resume cursor is the last consumed seq + 1 and never skips", () => {
  assert.equal(coachNextFromSeq(-1), 0);
  assert.equal(coachNextFromSeq(0), 1);
  assert.equal(coachNextFromSeq(41), 42);
  assertCoachCode(() => coachNextFromSeq(-2), "validation");

  const state = fold(createCoachChatState("q", 5), [
    event(5, { type: "text_delta", delta: "a" }),
    event(6, { type: "terminal", status: "cancelled" }),
  ]);
  assert.equal(state.lastSeq, 6);
  assert.equal(coachResumeFromSeq(state), 7);
  assert.equal(canResumeCoachStream(state), false);

  const running = fold(createCoachChatState("q"), [
    event(0, { type: "text_delta", delta: "a" }),
  ]);
  assert.equal(canResumeCoachStream(running), true);
  assert.equal(coachResumeFromSeq(running), 1);
});

test("cancel aborts the stream only, and posts a server cancel only for a known run", () => {
  assert.deepEqual(
    planCoachCancel({ runId: "run-1", terminal: null, streamActive: true }),
    { abortStream: true, postCancel: true, phase: "cancelling" },
  );
  assert.deepEqual(
    planCoachCancel({ runId: null, terminal: null, streamActive: true }),
    { abortStream: true, postCancel: false, phase: "cancelled" },
  );
  assert.deepEqual(
    planCoachCancel({ runId: null, terminal: null, streamActive: false }),
    { abortStream: false, postCancel: false, phase: "cancelled" },
  );

  const completed: CoachTerminal = { status: "completed", reason: null, seq: 4 };
  assert.deepEqual(
    planCoachCancel({ runId: "run-1", terminal: completed, streamActive: true }),
    { abortStream: true, postCancel: false, phase: "done" },
  );
  assert.deepEqual(
    planCoachCancel({
      runId: "run-1",
      terminal: { status: "failed", reason: "x", seq: 4 },
      streamActive: false,
    }),
    { abortStream: false, postCancel: false, phase: "failed" },
  );
  assert.deepEqual(
    planCoachCancel({
      runId: "run-1",
      terminal: { status: "cancelled", reason: null, seq: 4 },
      streamActive: false,
    }),
    { abortStream: false, postCancel: false, phase: "cancelled" },
  );
});

test("abort detection maps to a typed cancelled error and keeps retryability", () => {
  assert.equal(isCancelledError({ name: "AbortError" }), true);
  assert.equal(isCancelledError(new CoachError("cancelled")), true);
  assert.equal(isCancelledError(new Error("nope")), false);

  const abort = toCoachError({ name: "AbortError" });
  assert.equal(abort.code, "cancelled");
  assert.equal(abort.retryable, false);

  assert.equal(toCoachError(new TypeError("fetch failed")).code, "network");
  assert.equal(toCoachError("opaque", "server").code, "server");
  assert.equal(isRetryableCoachError(new CoachError("network")), true);
  assert.equal(isRetryableCoachError(new CoachError("timeout")), true);
  assert.equal(isRetryableCoachError(new CoachError("unauthenticated")), false);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("HTTP status and server codes map to distinct typed coach errors", () => {
  assert.equal(coachErrorFromHttp(401, null).code, "unauthenticated");
  assert.equal(coachErrorFromHttp(403, null).code, "forbidden");
  assert.equal(
    coachErrorFromHttp(403, { error: { code: "ACCOUNT_NOT_FORMAL", message: "guest" } }).code,
    "forbidden",
  );
  assert.equal(
    coachErrorFromHttp(403, { error: { code: "QUOTA_EXHAUSTED", message: "no tokens" } }).code,
    "quota",
  );
  assert.equal(
    coachErrorFromHttp(503, { error: { code: "KILL_SWITCH", message: "off" } }).code,
    "kill-switch",
  );
  assert.equal(
    coachErrorFromHttp(503, { error: { code: "CLOUD_DISABLED", message: "off" } }).code,
    "kill-switch",
  );
  assert.equal(
    coachErrorFromHttp(503, { error: { code: "PROVIDER_UNCONFIGURED", message: "off" } }).code,
    "unavailable",
  );
  assert.equal(
    coachErrorFromHttp(409, { error: { code: "RUN_BUSY", message: "busy" } }).code,
    "busy",
  );
  assert.equal(
    coachErrorFromHttp(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "same key" } })
      .code,
    "conflict",
  );
  assert.equal(
    coachErrorFromHttp(404, { error: { code: "RUN_NOT_FOUND", message: "gone" } }).code,
    "not-found",
  );
  assert.equal(
    coachErrorFromHttp(410, { error: { code: "EXPIRED_CURSOR", message: "expired" } }).code,
    "expired-cursor",
  );
  assert.equal(coachErrorFromHttp(400, null).code, "validation");
  assert.equal(coachErrorFromHttp(429, null).code, "rate-limited");
  assert.equal(coachErrorFromHttp(500, null).code, "unavailable");
  assert.equal(coachErrorFromHttp(418, null).code, "server");
});

test("typed errors expose i18n keys, categories, retryability and redacted copy", () => {
  const quota = coachErrorFromHttp(403, {
    error: { code: "QUOTA_EXHAUSTED", message: "secret prompt text must not leak" },
  });
  assert.equal(quota.messageKey, COACH_ERROR_MESSAGE_KEYS.quota);
  assert.equal(quota.serverCode, "QUOTA_EXHAUSTED");
  assert.equal(quota.httpStatus, 403);
  assert.equal(quota.category, "capacity");
  assert.equal(quota.retryable, false);
  assert.equal(coachErrorMessageKey(quota.code), COACH_ERROR_MESSAGE_KEYS.quota);
  assert.equal(quota.message.includes("secret"), false);

  assert.equal(coachErrorMessageKey("future-code"), COACH_ERROR_MESSAGE_KEYS.server);
  assert.equal(coachErrorFromHttp(401, null).retryable, false);
  assert.equal(coachErrorFromHttp(503, null).retryable, true);
});

test("a folded state and every event stay immutable under deep freeze", () => {
  const events = Object.freeze([
    Object.freeze(event(0, { type: "text_delta", delta: "a" })),
    Object.freeze(event(1, { type: "tool_start", tool: "t", callId: "c" })),
    Object.freeze(event(2, { type: "terminal", status: "completed" })),
  ]);
  const statuses = Object.freeze([]);
  const state: CoachChatState = Object.freeze({
    question: "q",
    assistantText: "",
    statuses,
    terminal: null,
    runError: null,
    lastSeq: -1,
  });

  const result = applyCoachEvents(state, events);
  assert.equal(result.status, "applied");
  assert.equal(result.state.assistantText, "a");
  assert.equal(result.state.statuses.length, 1);
  assert.equal(result.state.terminal?.status, "completed");
  assert.equal(state.lastSeq, -1);
  assert.equal(state.assistantText, "");
  assert.equal(state.statuses.length, 0);
});
