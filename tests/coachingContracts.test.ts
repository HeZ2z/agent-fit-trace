import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { AnalysisResult, WorkoutRecord } from "@agent-fit-trace/core";
import {
  COACHING_CAPABILITY_VERSION,
  COACHING_DISCOVERY_VERSION,
  COACHING_PROTOCOL_VERSION,
  COACHING_SSE_RESERVED_FRAME_BYTES,
  COACHING_SSE_TERMINAL_RESERVE_BYTES,
  COACHING_TRUNCATION_MARKER,
  MAX_COACHING_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  MAX_COACHING_SESSION_ID_LENGTH,
  boundCoachingDiagnostic,
  coachingEventFrameBytes,
  dedupeEventsBySeq,
  encodeCoachingEventFrame,
  isTerminalStatus,
  nextRunStatus,
  parseCancelCoachingRunBody,
  parseCoachingBackendDescriptor,
  parseCoachingBootstrapResult,
  parseCoachingCapabilityDiscovery,
  parseCoachingDataSnapshot,
  parseCoachingEventEnvelope,
  parseCoachingLogoutResult,
  parseCoachingRuntimeInfo,
  parseReadCoachingEventsResult,
  parseReadCoachingRunResult,
  parseRuntimeEventEnvelope,
  parseSnapshotFilter,
  parseSubmitCoachingRunInput,
  qualifyCloudBackend,
  replayRunState,
  resolveCoachingBackendSelection,
  utf8ByteLength,
} from "@agent-fit-trace/api-contracts";
import type {
  CoachingEventEnvelope,
  CoachingEventPayload,
  CoachingStreamIdentity,
} from "@agent-fit-trace/api-contracts";

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

test("cancel body carries no runId; runtime ids are strict; calendar dates are strict", () => {
  assert.deepEqual(parseCancelCoachingRunBody(undefined), {});
  assert.deepEqual(parseCancelCoachingRunBody({}), {});
  assert.deepEqual(parseCancelCoachingRunBody({ reason: "stop" }), { reason: "stop" });
  // Stray runId is ignored (path owns the id).
  assert.deepEqual(parseCancelCoachingRunBody({ runId: "run-1", reason: "stop" }), { reason: "stop" });
  assert.throws(() => parseCancelCoachingRunBody({ reason: 42 }));
  // v1 omitted selection stays omitted (service maps it to local-pi).
  const legacy = parseSubmitCoachingRunInput({
    sessionId: "s",
    prompt: "p",
    idempotencyKey: "k",
    snapshot: snapshotHandle(),
  });
  assert.equal(legacy.backendId, undefined);
  assert.equal(legacy.runtimeId, undefined);
  assert.deepEqual(
    parseSubmitCoachingRunInput({ sessionId: "s", prompt: "p", idempotencyKey: "k", snapshot: snapshotHandle(), runtimeId: "pi" }).runtimeId,
    "pi",
  );
  assert.throws(() =>
    parseSubmitCoachingRunInput({ sessionId: "s", prompt: "p", idempotencyKey: "k", snapshot: snapshotHandle(), runtimeId: "shell" }),
  );
  // Backend/runtime pairs must agree.
  assert.throws(() =>
    parseSubmitCoachingRunInput({
      sessionId: "s",
      prompt: "p",
      idempotencyKey: "k",
      snapshot: snapshotHandle(),
      backendId: "local-codex",
      runtimeId: "pi",
    }),
  );
  assert.deepEqual(
    parseSubmitCoachingRunInput({
      sessionId: "s",
      prompt: "p",
      idempotencyKey: "k",
      snapshot: snapshotHandle(),
      backendId: "local-codex",
    }),
    { sessionId: "s", prompt: "p", idempotencyKey: "k", snapshot: snapshotHandle(), backendId: "local-codex" },
  );
  // Strict calendar dates: rollover rejects.
  assert.throws(() => parseSnapshotFilter({ from: "2026-02-30" }));
  assert.throws(() => parseSnapshotFilter({ from: "2026-09-10", to: "2026-09-01" }));
  assert.deepEqual(parseSnapshotFilter({ from: "2026-09-01", to: "2026-09-03" }), { from: "2026-09-01", to: "2026-09-03" });
});

test("backend/runtime selection defaults to local-pi and never silently chooses cloud", () => {
  assert.deepEqual(resolveCoachingBackendSelection({}), {
    backendId: "local-pi",
    runtimeId: "pi",
    executionLocation: "local",
  });
  assert.deepEqual(resolveCoachingBackendSelection({ runtimeId: "pi" }), {
    backendId: "local-pi",
    runtimeId: "pi",
    executionLocation: "local",
  });
  assert.deepEqual(resolveCoachingBackendSelection({ backendId: "local-codex" }), {
    backendId: "local-codex",
    runtimeId: "codex",
    executionLocation: "local",
  });
  assert.deepEqual(resolveCoachingBackendSelection({ backendId: "cloud-default" }), {
    backendId: "cloud-default",
    runtimeId: "hosted-sdk",
    executionLocation: "cloud",
  });
  assert.deepEqual(resolveCoachingBackendSelection({ runtimeId: "hosted-sdk" }), {
    backendId: "cloud-default",
    runtimeId: "hosted-sdk",
    executionLocation: "cloud",
  });
  // Mismatches and unknown ids fail closed.
  assert.throws(() => resolveCoachingBackendSelection({ backendId: "local-opencode", runtimeId: "codex" }));
  assert.throws(() => resolveCoachingBackendSelection({ backendId: "cloud-default", runtimeId: "pi" }));
  assert.throws(() => resolveCoachingBackendSelection({ runtimeId: "shell" }));
  assert.throws(() => resolveCoachingBackendSelection({ backendId: "local-cloud" }));
});

function capabilities(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    capabilityVersion: COACHING_CAPABILITY_VERSION,
    protocolVersion: COACHING_PROTOCOL_VERSION,
    tools: ["get_training_history", "analyze_progress"],
    productReplay: true,
    nativeContinuation: true,
    cancelConfirmation: "process-exit",
    maxInputBytes: 65536,
    maxEvents: 1000,
    maxEventBytes: 4 * 1024 * 1024,
    accountEligibility: "not-required",
    quotaReservation: "not-required",
    dataDestination: "cli-provider",
    ...over,
  };
}

function backend(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    backendId: "local-pi",
    runtimeId: "pi",
    executionLocation: "local",
    displayName: "pi CLI (local)",
    available: true,
    capabilities: capabilities(),
    ...over,
  };
}

test("capability discovery is versioned, strict, and keeps planned backends unavailable", () => {
  const discovery = {
    discoveryVersion: COACHING_DISCOVERY_VERSION,
    protocolVersion: COACHING_PROTOCOL_VERSION,
    tools: ["get_training_history", "analyze_progress"],
    backends: [
      backend(),
      backend({
        backendId: "local-codex",
        runtimeId: "codex",
        displayName: "Codex CLI (local)",
        available: false,
        capabilities: capabilities({ nativeContinuation: false, cancelConfirmation: "unsupported" }),
        unavailableReason: { code: "adapter-not-implemented", message: "not implemented" },
      }),
      backend({
        backendId: "cloud-default",
        runtimeId: "hosted-sdk",
        executionLocation: "cloud",
        displayName: "Cloud coach",
        available: false,
        capabilities: capabilities({
          nativeContinuation: false,
          cancelConfirmation: "unsupported",
          accountEligibility: "required",
          quotaReservation: "required",
          dataDestination: "vendor-api",
        }),
        unavailableReason: { code: "identity-unverified", message: "identity missing" },
      }),
    ],
  };
  assert.deepEqual(parseCoachingCapabilityDiscovery(JSON.parse(JSON.stringify(discovery))), discovery);

  // Unavailable requires a reason; available forbids one.
  assert.throws(() => parseCoachingBackendDescriptor(backend({ available: false })));
  assert.throws(() =>
    parseCoachingBackendDescriptor(backend({ unavailableReason: { code: "adapter-not-implemented", message: "x" } })),
  );
  // Unknown reason codes and non-read-only tools reject.
  assert.throws(() =>
    parseCoachingBackendDescriptor(
      backend({ available: false, unavailableReason: { code: "because", message: "x" } }),
    ),
  );
  assert.throws(() =>
    parseCoachingBackendDescriptor(backend({ capabilities: capabilities({ tools: ["bash"] }) })),
  );
  // `executablePath` is ADDITIVE (issue #68): a settings page needs to show
  // which binary will run, but a client that ignores the field must keep
  // parsing byte-identically — hence `discoveryVersion` stays 1.
  const withPath = parseCoachingBackendDescriptor(
    backend({ executablePath: "/usr/local/bin/codex" }),
  );
  assert.equal(withPath.executablePath, "/usr/local/bin/codex");
  // Absent stays absent: an old server payload parses to no extra field.
  const withoutPath = parseCoachingBackendDescriptor(backend());
  assert.equal(withoutPath.executablePath, undefined);
  assert.deepEqual(Object.keys(withoutPath).sort(), [
    "available",
    "backendId",
    "capabilities",
    "displayName",
    "executionLocation",
    "runtimeId",
  ]);
  // A blank or non-string path is not a path.
  assert.throws(() =>
    parseCoachingBackendDescriptor(backend({ executablePath: "  " })),
  );
  assert.throws(() =>
    parseCoachingBackendDescriptor(backend({ executablePath: 42 })),
  );
  // Cloud descriptors must require account qualification + quota.
  assert.throws(() =>
    parseCoachingBackendDescriptor(
      backend({
        backendId: "cloud-default",
        runtimeId: "hosted-sdk",
        available: false,
        capabilities: capabilities({ accountEligibility: "not-required", quotaReservation: "required" }),
        unavailableReason: { code: "quota-not-configured", message: "x" },
      }),
    ),
  );
  // Cloud descriptors must declare a vendor data destination.
  assert.throws(() =>
    parseCoachingBackendDescriptor(
      backend({
        backendId: "cloud-default",
        runtimeId: "hosted-sdk",
        executionLocation: "cloud",
        available: false,
        capabilities: capabilities({
          accountEligibility: "required",
          quotaReservation: "required",
          dataDestination: "cli-provider",
        }),
        unavailableReason: { code: "quota-not-configured", message: "x" },
      }),
    ),
  );
  // The location is fixed by the backend and must not be misreported.
  assert.throws(() => parseCoachingBackendDescriptor(backend({ executionLocation: "cloud" })));
  // Backend/runtime mismatch and duplicate backends reject.
  assert.throws(() => parseCoachingBackendDescriptor(backend({ runtimeId: "codex" })));
  assert.throws(() =>
    parseCoachingCapabilityDiscovery({
      ...discovery,
      backends: [backend(), backend()],
    }),
  );
  // Wrong discovery version rejects instead of guessing.
  assert.throws(() =>
    parseCoachingCapabilityDiscovery({ ...discovery, discoveryVersion: COACHING_DISCOVERY_VERSION + 1 }),
  );
});

test("cloud qualification fails closed for missing/guest identity and missing quota", () => {
  const formal = { accountId: "user-1", isAnonymous: false };
  const guest = { accountId: "guest-1", isAnonymous: true };
  const quota = { configured: true, remaining: 5 };

  assert.equal(qualifyCloudBackend({}).eligible, false);
  assert.equal(qualifyCloudBackend({}).reason?.code, "identity-unverified");
  assert.equal(qualifyCloudBackend({ quota, providerConfigured: true }).eligible, false);
  assert.equal(qualifyCloudBackend({ identity: guest, quota, providerConfigured: true }).reason?.code, "guest-cloud-forbidden");
  assert.equal(qualifyCloudBackend({ identity: formal, providerConfigured: true }).reason?.code, "quota-not-configured");
  assert.equal(
    qualifyCloudBackend({ identity: formal, quota: { configured: false, remaining: 5 }, providerConfigured: true }).reason?.code,
    "quota-not-configured",
  );
  assert.equal(
    qualifyCloudBackend({ identity: formal, quota: { configured: true, remaining: 0 }, providerConfigured: true }).reason?.code,
    "quota-exhausted",
  );
  assert.equal(qualifyCloudBackend({ identity: formal, quota, providerConfigured: false }).reason?.code, "provider-unconfigured");
  assert.deepEqual(qualifyCloudBackend({ identity: formal, quota, providerConfigured: true }), { eligible: true });

  // A caller-supplied guest/entitlement flag is not an input: the trusted
  // classification is authoritative, so a forged object cannot unlock cloud.
  assert.equal(
    qualifyCloudBackend({
      identity: { ...guest, guestAllowed: true, isAnonymous: true } as { accountId: string; isAnonymous: boolean },
      quota,
      providerConfigured: true,
    }).eligible,
    false,
  );
  assert.equal(
    qualifyCloudBackend({
      identity: { ...formal, isAnonymous: undefined } as unknown as { accountId: string; isAnonymous: boolean },
      quota,
      providerConfigured: true,
    }).reason?.code,
    "identity-unverified",
  );
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
  assert.deepEqual(
    parseCoachingRuntimeInfo({ id: "codex", kind: "local", displayName: "Codex", available: false }),
    { id: "codex", kind: "local", displayName: "Codex", available: false },
  );
  assert.throws(() => parseCoachingRuntimeInfo({ id: "shell", kind: "x", displayName: "X", available: true }));
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

test("SSE wire budgets are coherent and measured in UTF-8 full-frame bytes", () => {
  // One framing rule: the frame the server writes is the one the helper sizes.
  const env = envelope(7, { type: "text_delta", delta: "é" });
  const frame = encodeCoachingEventFrame(env);
  assert.equal(frame, `id: 7\ndata: ${JSON.stringify(env)}\n\n`);
  assert.ok(frame.startsWith("id: 7\ndata: "));
  assert.ok(frame.endsWith("\n\n"));
  // Bytes, not characters: the 1-code-unit "é" is 2 UTF-8 bytes in the frame.
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength(frame), frame.length + 1);
  assert.equal(coachingEventFrameBytes(env), utf8ByteLength(frame));
  // Budgets are coherent: a single frame never exceeds the whole-stream budget.
  assert.ok(MAX_COACHING_SSE_FRAME_BYTES > 0);
  assert.ok(MAX_COACHING_SSE_FRAME_BYTES <= MAX_COACHING_SSE_TOTAL_BYTES);
  assert.ok(COACHING_SSE_TERMINAL_RESERVE_BYTES > 0);
  assert.ok(COACHING_SSE_TERMINAL_RESERVE_BYTES * 4 <= MAX_COACHING_SSE_FRAME_BYTES);
});

test("diagnostic text is bounded by ENCODED frame bytes, not raw UTF-8 (worst-case JSON escaping)", () => {
  // A max-length session id made of control characters: 128 code units that
  // JSON-escape to 6 wire bytes each (768 bytes of metadata in every frame).
  const sessionId = "\u0000".repeat(MAX_COACHING_SESSION_ID_LENGTH);
  const terminal = (reason: string): CoachingEventEnvelope => ({
    protocolVersion: COACHING_PROTOCOL_VERSION,
    sessionId,
    runId: "run-1",
    seq: 0,
    event: { type: "terminal", status: "failed", reason },
  });
  const seal = (message: string): CoachingEventEnvelope => ({
    protocolVersion: COACHING_PROTOCOL_VERSION,
    sessionId,
    runId: "run-1",
    seq: 0,
    event: { type: "run_error", code: "EVENT_CAP", message },
  });
  // Each U+0000 is 1 raw UTF-8 byte but `\u0000` (6 bytes) on the wire, so a
  // raw-byte bound under-counts by 6x and can overflow the whole reserve.
  const raw = "\u0000".repeat(4000);
  assert.equal(utf8ByteLength(raw), 4000);
  assert.ok(
    utf8ByteLength(encodeCoachingEventFrame(terminal(raw))) > COACHING_SSE_TERMINAL_RESERVE_BYTES,
    "the raw reason alone would already blow the reserve through escapes",
  );

  const boundedTerminal = boundCoachingDiagnostic(terminal, raw, COACHING_SSE_RESERVED_FRAME_BYTES);
  const boundedSeal = boundCoachingDiagnostic(seal, raw, COACHING_SSE_RESERVED_FRAME_BYTES);
  assert.equal(boundedTerminal.shortened, true);
  assert.ok(boundedTerminal.text.endsWith(COACHING_TRUNCATION_MARKER), "shortening must be explicit");
  assert.ok(boundedTerminal.text.startsWith("\u0000"), "a prefix of the diagnostic must survive");
  assert.ok(coachingEventFrameBytes(terminal(boundedTerminal.text)) <= COACHING_SSE_RESERVED_FRAME_BYTES);
  assert.ok(coachingEventFrameBytes(seal(boundedSeal.text)) <= COACHING_SSE_RESERVED_FRAME_BYTES);
  // Both reserved frames (cap-seal + terminal) fit the reserve together.
  assert.ok(
    coachingEventFrameBytes(seal(boundedSeal.text)) + coachingEventFrameBytes(terminal(boundedTerminal.text)) <=
      COACHING_SSE_TERMINAL_RESERVE_BYTES,
  );
  assert.equal(COACHING_SSE_RESERVED_FRAME_BYTES * 2, COACHING_SSE_TERMINAL_RESERVE_BYTES);
});

test("an ordinary short diagnostic is preserved verbatim with no truncation marker", () => {
  const build = (reason: string): CoachingEventEnvelope => ({
    protocolVersion: COACHING_PROTOCOL_VERSION,
    sessionId: "s-1",
    runId: "run-1",
    seq: 0,
    event: { type: "terminal", status: "cancelled", reason },
  });
  const bounded = boundCoachingDiagnostic(build, "user cancelled", COACHING_SSE_RESERVED_FRAME_BYTES);
  assert.equal(bounded.shortened, false);
  assert.equal(bounded.text, "user cancelled");
  assert.ok(!bounded.text.includes(COACHING_TRUNCATION_MARKER));
});

test("frame byte measure includes envelope metadata overhead, not just payload length", () => {
  const env = envelope(123, { type: "text_delta", delta: "abc" });
  const payloadOnly = JSON.stringify(env.event).length;
  const measured = coachingEventFrameBytes(env);
  // The `id:` line, the `data: ` prefix, and the blank-line delimiter all
  // count, so the measured frame is strictly larger than the bare payload.
  assert.ok(measured > payloadOnly);
  assert.ok(measured > JSON.stringify(env).length);
});
