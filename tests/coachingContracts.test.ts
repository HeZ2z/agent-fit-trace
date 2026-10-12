import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeProgress, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { AnalysisResult, WorkoutRecord } from "@pi-fit-trace/core";
import {
  COACHING_PROTOCOL_VERSION,
  dedupeEventsBySeq,
  isTerminalStatus,
  nextRunStatus,
  parseCancelCoachingRunBody,
  parseCoachingBootstrapResult,
  parseCoachingDataSnapshot,
  parseCoachingEventEnvelope,
  parseCoachingLogoutResult,
  parseCoachingRuntimeInfo,
  parseReadCoachingEventsResult,
  parseReadCoachingRunResult,
  parseRuntimeEventEnvelope,
  parseSnapshotFilter,
  parseSubmitCoachingRunInput,
  replayRunState,
} from "@pi-fit-trace/api-contracts";
import type {
  CoachingEventEnvelope,
  CoachingEventPayload,
  CoachingStreamIdentity,
} from "@pi-fit-trace/api-contracts";

function record(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

const r1 = record({ id: "wkt-1", date: "2026-09-01" });
const r2 = record({ id: "wkt-2", date: "2026-09-03" });
const analysis: AnalysisResult = analyzeProgress([r1, r2]);

const STREAM: CoachingStreamIdentity = { sessionId: "sess-1", runId: "run-1" };

function envelope(
  seq: number,
  event: CoachingEventPayload,
  stream: CoachingStreamIdentity = STREAM,
): CoachingEventEnvelope {
  return {
    protocolVersion: COACHING_PROTOCOL_VERSION,
    sessionId: stream.sessionId,
    runId: stream.runId,
    seq,
    event,
  };
}

function snapshotHandle(): Record<string, unknown> {
  return { snapshotId: "snap-1", source: "supabase-snapshot", accountId: "acct-1" };
}

function resolvedSnapshot(): Record<string, unknown> {
  return { ...snapshotHandle(), recordIds: ["wkt-1", "wkt-2"], recordCount: 2 };
}

test("terminal status never rolls back on late events", () => {
  assert.equal(nextRunStatus("completed", "failed"), "completed");
  assert.equal(nextRunStatus("failed", "completed"), "failed");
  assert.equal(nextRunStatus("cancelled", "completed"), "cancelled");
  assert.equal(nextRunStatus("running", "completed"), "completed");
  assert.equal(nextRunStatus("queued", "failed"), "failed");
  assert.ok(isTerminalStatus("completed"));
  assert.ok(!isTerminalStatus("running"));
  assert.ok(!isTerminalStatus("queued"));
});

test("first non-terminal event moves queued to running", () => {
  const events = [envelope(0, { type: "text_delta", delta: "hi" })];
  assert.equal(replayRunState("queued", events, STREAM).status, "running");
  const toolOnly = [envelope(0, { type: "tool_start", tool: "t", callId: "c1" })];
  assert.equal(replayRunState("queued", toolOnly, STREAM).status, "running");
  // Terminal-only stream never passes through running.
  const terminalOnly = [envelope(0, { type: "terminal", status: "completed" })];
  assert.equal(replayRunState("queued", terminalOnly, STREAM).status, "completed");
  // Empty stream stays queued.
  assert.equal(replayRunState("queued", [], STREAM).status, "queued");
});

test("terminal applies once and freezes payload state; late events ignored", () => {
  const events: CoachingEventEnvelope[] = [
    envelope(0, { type: "text_delta", delta: "ab" }),
    envelope(1, { type: "terminal", status: "completed" }),
    envelope(2, { type: "text_delta", delta: "LATE" }),
    envelope(3, { type: "analysis_result", result: analysis }),
    envelope(4, { type: "run_error", code: "E", message: "late" }),
    envelope(5, { type: "tool_end", tool: "t", callId: "c9", ok: false, error: "late-fail" }),
    envelope(6, { type: "terminal", status: "failed" }),
  ];
  const state = replayRunState("queued", events, STREAM);
  assert.equal(state.status, "completed");
  assert.equal(state.text, "ab");
  assert.equal(state.analysisResults.length, 0);
  assert.equal(state.toolFailures.length, 0);
  assert.equal(state.error, undefined);
});

test("seq dedup: duplicates collapse, first write wins, sorted ascending", () => {
  const events: CoachingEventEnvelope[] = [
    envelope(0, { type: "text_delta", delta: "hel" }),
    envelope(1, { type: "text_delta", delta: "lo" }),
    envelope(1, { type: "text_delta", delta: "SHOULD-NOT-WIN" }),
    envelope(2, { type: "terminal", status: "completed" }),
  ];
  const shuffled = [events[3], events[0], events[1], events[2]];
  const deduped = dedupeEventsBySeq(shuffled, STREAM);
  assert.deepEqual(deduped.map((e) => e.seq), [0, 1, 2]);
  const state = replayRunState("queued", shuffled, STREAM);
  assert.equal(state.text, "hello");
  assert.equal(state.status, "completed");
});

test("dedupe/replay enforce single-stream identity and reject mixed streams", () => {
  const other: CoachingStreamIdentity = { sessionId: "sess-1", runId: "run-OTHER" };
  const mixed = [envelope(0, { type: "text_delta", delta: "a" }), envelope(1, { type: "text_delta", delta: "b" }, other)];
  assert.throws(() => dedupeEventsBySeq(mixed, STREAM));
  assert.throws(() => replayRunState("queued", mixed, STREAM));
  // Cross-run equal-seq frames are fine when folded against their own stream.
  const a = [envelope(0, { type: "text_delta", delta: "a" })];
  const b = [envelope(0, { type: "text_delta", delta: "b" }, other)];
  assert.equal(replayRunState("queued", a, STREAM).text, "a");
  assert.equal(replayRunState("queued", b, other).text, "b");
  // Mismatched session rejected.
  const wrongSession = [envelope(0, { type: "text_delta", delta: "x" }, { sessionId: "sess-2", runId: "run-1" })];
  assert.throws(() => replayRunState("queued", wrongSession, STREAM));
});

test("envelope parser requires safe seq and non-blank ids/callIds/tool names", () => {
  const good = envelope(0, { type: "analysis_result", result: analysis });
  assert.deepEqual(parseCoachingEventEnvelope(JSON.parse(JSON.stringify(good))), good);
  const blankSession = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  blankSession.sessionId = "  ";
  assert.throws(() => parseCoachingEventEnvelope(blankSession));
  const unsafeSeq = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  unsafeSeq.seq = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseCoachingEventEnvelope(unsafeSeq));
  const blankCall = envelope(0, { type: "tool_start", tool: "t", callId: "" });
  assert.throws(() => parseCoachingEventEnvelope(JSON.parse(JSON.stringify(blankCall))));
  const blankTool = envelope(0, { type: "tool_start", tool: "  ", callId: "c1" });
  assert.throws(() => parseCoachingEventEnvelope(JSON.parse(JSON.stringify(blankTool))));
  assert.throws(() =>
    parseCoachingEventEnvelope({
      protocolVersion: COACHING_PROTOCOL_VERSION + 99,
      sessionId: "s",
      runId: "r",
      seq: 0,
      event: { type: "text_delta", delta: "hi" },
    }),
  );
  const badAnalysis = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  delete (badAnalysis.event as Record<string, unknown>).result;
  assert.throws(() => parseCoachingEventEnvelope(badAnalysis));
});

test("error and success stay separated: tool failure is not an analysis result", () => {
  const events: CoachingEventEnvelope[] = [
    envelope(0, { type: "tool_start", tool: "analyze_progress", callId: "c1" }),
    envelope(1, { type: "tool_end", tool: "analyze_progress", callId: "c1", ok: false, error: "timeout" }),
    envelope(2, { type: "run_error", code: "TOOL_FAILED", message: "timeout" }),
    envelope(3, { type: "terminal", status: "failed" }),
  ];
  const state = replayRunState("running", events, STREAM);
  assert.equal(state.status, "failed");
  assert.deepEqual(state.toolFailures, ["timeout"]);
  assert.equal(state.analysisResults.length, 0);
  assert.deepEqual(state.error, { code: "TOOL_FAILED", message: "timeout" });
});

test("submit parser accepts handle-only snapshot and rejects client counts", () => {
  const good = {
    sessionId: "sess-1",
    prompt: "analyze recent training",
    idempotencyKey: "key-1",
    snapshot: snapshotHandle(),
  };
  assert.deepEqual(parseSubmitCoachingRunInput(JSON.parse(JSON.stringify(good))), good);
  const withCounts = {
    ...good,
    snapshot: { ...snapshotHandle(), recordIds: ["wkt-1"], recordCount: 1 },
  };
  assert.throws(() => parseSubmitCoachingRunInput(withCounts));
  const blankKey = { ...good, idempotencyKey: "  " };
  assert.throws(() => parseSubmitCoachingRunInput(blankKey));
});

test("snapshot/read parsers enforce handle binding and server-resolved consistency", () => {
  assert.deepEqual(
    parseCoachingDataSnapshot(JSON.parse(JSON.stringify(resolvedSnapshot()))),
    resolvedSnapshot(),
  );
  // Missing account binding rejected.
  const noAccount = { snapshotId: "s", source: "supabase-snapshot", recordIds: [], recordCount: 0 };
  assert.throws(() => parseCoachingDataSnapshot(noAccount));
  // Count/ids mismatch rejected (identity/content consistency).
  const mismatch = { ...snapshotHandle(), recordIds: ["a"], recordCount: 2 };
  assert.throws(() => parseCoachingDataSnapshot(mismatch));
  // Read result round-trips a resolved snapshot and a safe cursor.
  const readValue = {
    run: {
      id: "run-1",
      sessionId: "sess-1",
      status: "running",
      idempotencyKey: "k",
      prompt: "p",
      snapshot: resolvedSnapshot(),
      runtimeId: "pi",
    },
    lastSeq: 3,
    firstSeq: 0,
    expiresAt: 9999999999999,
  };
  assert.deepEqual(parseReadCoachingRunResult(JSON.parse(JSON.stringify(readValue))), readValue);
  // Empty log cursor (-1) is accepted; below -1 rejects.
  const emptyCursor = { ...readValue, lastSeq: -1 };
  assert.deepEqual(parseReadCoachingRunResult(JSON.parse(JSON.stringify(emptyCursor))), emptyCursor);
  const badCursor = { ...readValue, lastSeq: -2 };
  assert.throws(() => parseReadCoachingRunResult(badCursor));
});

test("cancel body carries no runId; runtime ids are pi-only; calendar dates are strict", () => {
  assert.deepEqual(parseCancelCoachingRunBody(undefined), {});
  assert.deepEqual(parseCancelCoachingRunBody({}), {});
  assert.deepEqual(parseCancelCoachingRunBody({ reason: "stop" }), { reason: "stop" });
  // Stray runId is ignored (path owns the id).
  assert.deepEqual(parseCancelCoachingRunBody({ runId: "run-1", reason: "stop" }), { reason: "stop" });
  assert.throws(() => parseCancelCoachingRunBody({ reason: 42 }));
  // pi-only runtime ids.
  assert.deepEqual(
    parseSubmitCoachingRunInput({ sessionId: "s", prompt: "p", idempotencyKey: "k", snapshot: snapshotHandle(), runtimeId: "pi" }).runtimeId,
    "pi",
  );
  assert.throws(() =>
    parseSubmitCoachingRunInput({ sessionId: "s", prompt: "p", idempotencyKey: "k", snapshot: snapshotHandle(), runtimeId: "codex" }),
  );
  // Strict calendar dates: rollover rejects.
  assert.throws(() => parseSnapshotFilter({ from: "2026-02-30" }));
  assert.throws(() => parseSnapshotFilter({ from: "2026-09-10", to: "2026-09-01" }));
  assert.deepEqual(parseSnapshotFilter({ from: "2026-09-01", to: "2026-09-03" }), { from: "2026-09-01", to: "2026-09-03" });
});

test("bootstrap/logout/runtime/events guards round-trip", () => {
  assert.deepEqual(
    parseCoachingBootstrapResult({ capability: "coachcap_abc123xyz456", expiresInMs: 600000 }),
    { capability: "coachcap_abc123xyz456", expiresInMs: 600000 },
  );
  assert.throws(() => parseCoachingBootstrapResult({ capability: "  ", expiresInMs: 1 }));
  assert.deepEqual(parseCoachingLogoutResult({ loggedOut: true }), { loggedOut: true });
  assert.throws(() => parseCoachingLogoutResult({ loggedOut: false }));
  assert.deepEqual(
    parseCoachingRuntimeInfo({ id: "pi", kind: "local", displayName: "Pi", available: true }),
    { id: "pi", kind: "local", displayName: "Pi", available: true },
  );
  assert.throws(() => parseCoachingRuntimeInfo({ id: "codex", kind: "x", displayName: "X", available: true }));
  const env = envelope(0, { type: "text_delta", delta: "hi" });
  assert.deepEqual(parseRuntimeEventEnvelope(JSON.parse(JSON.stringify(env))), env);
  assert.throws(() => parseRuntimeEventEnvelope({ ...JSON.parse(JSON.stringify(env)), seq: -1 }));
  const page = {
    events: [env],
    run: {
      id: "run-1",
      sessionId: "sess-1",
      status: "running",
      idempotencyKey: "k",
      prompt: "p",
      snapshot: resolvedSnapshot(),
      runtimeId: "pi",
    },
    lastSeq: 0,
    firstSeq: 0,
    expiresAt: Date.now() + 1000,
  };
  assert.ok(parseReadCoachingEventsResult(JSON.parse(JSON.stringify(page))).events.length === 1);
  const emptyPage = { ...page, events: [], lastSeq: -1 };
  assert.deepEqual(parseReadCoachingEventsResult(JSON.parse(JSON.stringify(emptyPage))).lastSeq, -1);
});

test("whitespace-only and empty text deltas are content: preserved byte-for-byte", () => {
  for (const delta of [" ", "\n", ""]) {
    const parsed = parseCoachingEventEnvelope({
      protocolVersion: COACHING_PROTOCOL_VERSION,
      sessionId: STREAM.sessionId,
      runId: STREAM.runId,
      seq: 0,
      event: { type: "text_delta", delta },
    });
    assert.equal(parsed.event.type, "text_delta");
    if (parsed.event.type === "text_delta") {
      assert.equal(parsed.event.delta, delta);
    }
  }
  const events: CoachingEventEnvelope[] = [
    envelope(0, { type: "text_delta", delta: "a" }),
    envelope(1, { type: "text_delta", delta: " " }),
    envelope(2, { type: "text_delta", delta: "\n" }),
    envelope(3, { type: "text_delta", delta: "" }),
    envelope(4, { type: "text_delta", delta: "b" }),
  ];
  assert.equal(replayRunState("queued", events, STREAM).text, "a \nb");
  // Non-string deltas are still rejected.
  assert.throws(() =>
    parseCoachingEventEnvelope({
      protocolVersion: COACHING_PROTOCOL_VERSION,
      sessionId: STREAM.sessionId,
      runId: STREAM.runId,
      seq: 0,
      event: { type: "text_delta" },
    }),
  );
});

test("empty-string summary and reason are valid when present", () => {
  const toolEnd = parseCoachingEventEnvelope({
    protocolVersion: COACHING_PROTOCOL_VERSION,
    sessionId: STREAM.sessionId,
    runId: STREAM.runId,
    seq: 0,
    event: { type: "tool_end", tool: "t", callId: "c1", ok: true, summary: "" },
  });
  assert.deepEqual(toolEnd.event, { type: "tool_end", tool: "t", callId: "c1", ok: true, summary: "" });
  const terminal = parseCoachingEventEnvelope({
    protocolVersion: COACHING_PROTOCOL_VERSION,
    sessionId: STREAM.sessionId,
    runId: STREAM.runId,
    seq: 1,
    event: { type: "terminal", status: "completed", reason: "" },
  });
  assert.deepEqual(terminal.event, { type: "terminal", status: "completed", reason: "" });
});
