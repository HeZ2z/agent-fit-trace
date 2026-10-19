import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COACH_ERROR_MESSAGE_KEYS,
  CoachError,
  coachErrorMessage,
  createCoachChatState,
} from "../mobile/src/coach/coachModel.ts";
import type {
  CoachChatState,
  CoachErrorCode,
  CoachTerminal,
} from "../mobile/src/coach/coachModel.ts";
import {
  COACH_PROMPT_MAX_LENGTH,
  INITIAL_COACH_TURN_STATE,
  canCancelCoachTurn,
  canStartCoachTurn,
  canUseCoachGate,
  cancelCoachTurnBeforeRun,
  coachActivityMessage,
  coachErrorCopy,
  coachPromptIssueMessage,
  coachStatusMessage,
  coachTurnCancelPlan,
  clearCoachTurnCancel,
  completeCoachTurn,
  failCoachTurn,
  isCoachTurnActive,
  markCoachRunStarted,
  rememberCoachSession,
  requestCoachTurnCancel,
  resetCoachTurn,
  resolveCoachGate,
  startCoachTurn,
  validateCoachPrompt,
} from "../mobile/src/coach/coachScreenModel.ts";
import type {
  CoachGate,
  CoachTurnState,
} from "../mobile/src/coach/coachScreenModel.ts";

/**
 * Pure coverage for the mobile Coach screen model. No React, expo, fetch,
 * token or clock is imported: gating, prompt validation, the turn phase
 * machine, error copy and the cancel decision are deterministic.
 */

function creatingTurn(sessionId: string | null = "sess-1"): CoachTurnState {
  return startCoachTurn({ ...INITIAL_COACH_TURN_STATE, sessionId });
}

function streamingTurn(sessionId = "sess-1", runId = "run-1"): CoachTurnState {
  return markCoachRunStarted(rememberCoachSession(creatingTurn(null), sessionId), runId);
}

function chatWith(overrides: Partial<CoachChatState> = {}): CoachChatState {
  return { ...createCoachChatState("How is my squat progressing?"), ...overrides };
}

function terminal(status: CoachTerminal["status"]): CoachTerminal {
  return { status, reason: null, seq: 2 };
}

function codeOf(key: string): CoachErrorCode {
  const code = (Object.entries(COACH_ERROR_MESSAGE_KEYS) as [CoachErrorCode, string][]).find(
    ([, value]) => value === key,
  )?.[0];
  assert.ok(code, `no coach error code for key ${key}`);
  return code;
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

test("gate: a configured build is ready only for a verified signed-in account", () => {
  assert.equal(resolveCoachGate({ authStatus: "signed-in", coachConfigured: true }), "ready");
  assert.equal(resolveCoachGate({ authStatus: "signed-out", coachConfigured: true }), "signed-out");
  assert.equal(resolveCoachGate({ authStatus: "error", coachConfigured: true }), "signed-out");
  assert.equal(resolveCoachGate({ authStatus: "unconfigured", coachConfigured: true }), "signed-out");
  assert.equal(resolveCoachGate({ authStatus: "loading", coachConfigured: true }), "loading");
});

test("gate: a missing cloud API is unconfigured regardless of auth state", () => {
  for (const authStatus of ["signed-in", "signed-out", "loading", "error", "unconfigured"]) {
    assert.equal(resolveCoachGate({ authStatus, coachConfigured: false }), "unconfigured");
  }
});

test("gate: only `ready` permits chat and no state needs a local coach", () => {
  const states: CoachGate[] = ["loading", "signed-out", "unconfigured", "ready"];
  assert.deepEqual(
    states.filter((gate) => canUseCoachGate(gate)),
    ["ready"],
  );
});

// ---------------------------------------------------------------------------
// Prompt validation
// ---------------------------------------------------------------------------

test("prompt: blank and whitespace-only asks are empty", () => {
  assert.deepEqual(validateCoachPrompt(""), { ok: false, issue: "empty" });
  assert.deepEqual(validateCoachPrompt("   \n\t "), { ok: false, issue: "empty" });
  assert.equal(coachPromptIssueMessage("empty"), "Enter a question for the coach.");
});

test("prompt: the valid ask is trimmed and never mutated", () => {
  const raw = "  How is my squat progressing?  ";
  assert.deepEqual(validateCoachPrompt(raw), {
    ok: true,
    prompt: "How is my squat progressing?",
  });
  assert.equal(raw, "  How is my squat progressing?  ");
});

test("prompt: the contract length bound rejects one character over", () => {
  assert.deepEqual(validateCoachPrompt("abcde", 5), { ok: true, prompt: "abcde" });
  assert.deepEqual(validateCoachPrompt("  abcde  ", 5), { ok: true, prompt: "abcde" });
  assert.deepEqual(validateCoachPrompt("abcdef", 5), { ok: false, issue: "too-long" });
  assert.equal(
    validateCoachPrompt("a".repeat(COACH_PROMPT_MAX_LENGTH)).ok,
    true,
    "the exact server bound is accepted",
  );
  assert.deepEqual(
    validateCoachPrompt("a".repeat(COACH_PROMPT_MAX_LENGTH + 1)),
    { ok: false, issue: "too-long" },
  );
  assert.equal(
    coachPromptIssueMessage("too-long"),
    "Your question is too long. Shorten it and try again.",
  );
});

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

test("phase: idle can start; creating cannot start a second turn", () => {
  const idle = { ...INITIAL_COACH_TURN_STATE, sessionId: "sess-1" };
  assert.equal(isCoachTurnActive(idle), false);
  assert.equal(canStartCoachTurn(idle), true);
  assert.equal(canCancelCoachTurn(idle), false);

  const creating = startCoachTurn(idle);
  assert.deepEqual(creating, {
    phase: "creating",
    sessionId: "sess-1",
    runId: null,
    cancelRequested: false,
  });
  assert.equal(isCoachTurnActive(creating), true);
  assert.equal(canStartCoachTurn(creating), false);
  assert.equal(canCancelCoachTurn(creating), true);
  assert.equal(startCoachTurn(creating), creating, "a double tap returns the same state");
});

test("phase: creating remembers the session, then the accepted run starts streaming", () => {
  const withSession = rememberCoachSession(creatingTurn(null), "sess-1");
  assert.equal(withSession.sessionId, "sess-1");
  assert.equal(rememberCoachSession(withSession, "   "), withSession, "blank ids are ignored");

  const streaming = markCoachRunStarted(withSession, "run-1");
  assert.deepEqual(streaming, {
    phase: "streaming",
    sessionId: "sess-1",
    runId: "run-1",
    cancelRequested: false,
  });
  assert.equal(canStartCoachTurn(streaming), false);
  assert.equal(canCancelCoachTurn(streaming), true);
  assert.equal(markCoachRunStarted(streaming, "run-2"), streaming, "no reset while streaming");
  const blankRun = markCoachRunStarted(withSession, "  ");
  assert.equal(blankRun, withSession, "blank run ids are ignored");
});

test("phase: a run terminal moves to terminal/cancelled and frees the next ask", () => {
  const streaming = streamingTurn();

  const completed = completeCoachTurn(streaming, "completed");
  assert.equal(completed.phase, "terminal");
  assert.equal(completed.runId, "run-1");
  assert.equal(completed.sessionId, "sess-1");
  assert.equal(canStartCoachTurn(completed), true);
  assert.equal(isCoachTurnActive(completed), false);

  assert.equal(completeCoachTurn(streaming, "failed").phase, "terminal");
  assert.equal(completeCoachTurn(streaming, "cancelled").phase, "cancelled");
  const stillCreating = creatingTurn();
  assert.equal(
    completeCoachTurn(stillCreating, "completed"),
    stillCreating,
    "complete without a streaming run is a no-op",
  );
});

test("phase: cancel intent resolves locally only before a run exists", () => {
  const creating = creatingTurn();
  const requested = requestCoachTurnCancel(creating);
  assert.equal(requested.cancelRequested, true);
  assert.equal(requested.phase, "creating", "never claim cancelled while setup is unresolved");
  assert.equal(requestCoachTurnCancel(requested), requested, "a second tap is idempotent");

  const cancelled = cancelCoachTurnBeforeRun(requested);
  assert.deepEqual(cancelled, {
    phase: "cancelled",
    sessionId: "sess-1",
    runId: null,
    cancelRequested: false,
  });
  assert.equal(canStartCoachTurn(cancelled), true);
  assert.equal(cancelCoachTurnBeforeRun(creating), creating, "no request means no local cancel");
});

test("phase: a streaming cancel waits for the server terminal", () => {
  const requested = requestCoachTurnCancel(streamingTurn());
  assert.equal(requested.phase, "streaming");
  assert.equal(requested.cancelRequested, true);
  assert.equal(cancelCoachTurnBeforeRun(requested), requested, "a live run is never a local cancel");

  const cancelled = completeCoachTurn(requested, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.cancelRequested, false);
  assert.equal(cancelled.runId, "run-1");

  // A terminal that wins the race keeps its verdict.
  assert.equal(completeCoachTurn(requested, "completed").phase, "terminal");
});

test("phase: a failed cancel stops claiming cancellation without touching the run", () => {
  const requested = requestCoachTurnCancel(streamingTurn());
  const cleared = clearCoachTurnCancel(requested);
  assert.deepEqual(cleared, {
    phase: "streaming",
    sessionId: "sess-1",
    runId: "run-1",
    cancelRequested: false,
  });
  assert.equal(clearCoachTurnCancel(cleared), cleared, "already clear is a no-op");
  assert.equal(clearCoachTurnCancel(INITIAL_COACH_TURN_STATE), INITIAL_COACH_TURN_STATE);
});

test("phase: setup failure returns to idle; streaming failure keeps the live run", () => {
  const failedSetup = failCoachTurn(creatingTurn());
  assert.deepEqual(failedSetup, {
    phase: "idle",
    sessionId: "sess-1",
    runId: null,
    cancelRequested: false,
  });
  assert.equal(canStartCoachTurn(failedSetup), true);

  const streaming = streamingTurn();
  assert.equal(failCoachTurn(streaming), streaming, "a streaming run id is never dropped");
});

test("phase: reset/new conversation keeps the reusable session", () => {
  const terminal = completeCoachTurn(streamingTurn(), "completed");
  const reset = resetCoachTurn(terminal);
  assert.deepEqual(reset, {
    phase: "idle",
    sessionId: "sess-1",
    runId: null,
    cancelRequested: false,
  });
  const live = streamingTurn();
  assert.equal(resetCoachTurn(live), live, "active turns cannot reset");

  const next = startCoachTurn(completeCoachTurn(streamingTurn(), "cancelled"));
  assert.equal(next.phase, "creating");
  assert.equal(next.sessionId, "sess-1", "the conversation session is reused");
  assert.equal(next.runId, null);
});

test("phase: transitions never mutate the input state", () => {
  const inputs = [
    Object.freeze({ ...INITIAL_COACH_TURN_STATE, sessionId: "sess-1" }),
    Object.freeze(creatingTurn()),
    Object.freeze(requestCoachTurnCancel(creatingTurn())),
    Object.freeze(streamingTurn()),
    Object.freeze(requestCoachTurnCancel(streamingTurn())),
    Object.freeze(completeCoachTurn(streamingTurn(), "completed")),
  ];
  const snapshots = inputs.map((state) => ({ ...state }));
  for (const state of inputs) {
    startCoachTurn(state);
    rememberCoachSession(state, "sess-2");
    markCoachRunStarted(state, "run-2");
    requestCoachTurnCancel(state);
    clearCoachTurnCancel(state);
    cancelCoachTurnBeforeRun(state);
    completeCoachTurn(state, "failed");
    failCoachTurn(state);
    resetCoachTurn(state);
  }
  assert.deepEqual(inputs, snapshots);
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test("error: codes map to stable keys and canonical English sources", () => {
  const copy = coachErrorCopy(new CoachError("network"));
  assert.ok(copy);
  assert.equal(copy.code, "network");
  assert.equal(copy.key, COACH_ERROR_MESSAGE_KEYS.network);
  assert.equal(copy.source, coachErrorMessage("network"));
  assert.match(copy.key, /^coach\.error\./);

  const http = coachErrorCopy(new CoachError("rate-limited"));
  assert.ok(http);
  assert.equal(http.key, COACH_ERROR_MESSAGE_KEYS["rate-limited"]);

  for (const key of Object.values(COACH_ERROR_MESSAGE_KEYS)) {
    if (key === COACH_ERROR_MESSAGE_KEYS.cancelled) continue;
    const code = codeOf(key);
    const entry = coachErrorCopy(new CoachError(code));
    assert.ok(entry, `expected copy for ${code}`);
    assert.equal(entry.key, key);
    assert.equal(entry.source, coachErrorMessage(code));
    assert.notEqual(entry.source.trim(), "");
  }
});

test("error: raw thrown messages never become display copy", () => {
  const copy = coachErrorCopy(
    new CoachError("server", {
      message: "Bearer secret-token-123 was rejected by upstream",
    }),
  );
  assert.ok(copy);
  assert.equal(copy.key, COACH_ERROR_MESSAGE_KEYS.server);
  assert.doesNotMatch(copy.source, /secret-token-123|Bearer/);
  assert.equal(copy.source, coachErrorMessage("server"));

  const unknown = coachErrorCopy(new Error("raw parser detail with token abc"));
  assert.ok(unknown);
  assert.equal(unknown.code, "server");
  assert.doesNotMatch(unknown.source, /raw parser detail|abc/);
});

test("error: unknown failures degrade to server and fetch TypeErrors to network", () => {
  assert.equal(coachErrorCopy(new Error("boom"))?.code, "server");
  assert.equal(coachErrorCopy("not even an error")?.code, "server");
  assert.equal(coachErrorCopy(new TypeError("fetch failed"))?.code, "network");
});

test("error: cancellation is not rendered as an error", () => {
  assert.equal(coachErrorCopy(new CoachError("cancelled")), null);
  assert.equal(coachErrorCopy({ name: "AbortError" }), null);
  assert.equal(coachErrorCopy({ code: "ABORT_ERR" }), null);
});

// ---------------------------------------------------------------------------
// Status / activity labels
// ---------------------------------------------------------------------------

test("status: every phase has one deterministic status line", () => {
  const idle = chatWith();
  assert.equal(coachStatusMessage(INITIAL_COACH_TURN_STATE, idle), "Ready for your question.");
  assert.equal(coachStatusMessage(creatingTurn(), idle), "Preparing the cloud coach…");
  assert.equal(
    coachStatusMessage(requestCoachTurnCancel(creatingTurn()), idle),
    "Cancelling the coach run…",
  );
  assert.equal(coachStatusMessage(streamingTurn(), idle), "Coach is working…");
  assert.equal(
    coachStatusMessage(streamingTurn(), chatWith({ assistantText: "Answer" })),
    "Coach is responding…",
  );
  assert.equal(
    coachStatusMessage(requestCoachTurnCancel(streamingTurn()), idle),
    "Cancelling the coach run…",
  );
  assert.equal(
    coachStatusMessage(completeCoachTurn(streamingTurn(), "completed"), chatWith({
      terminal: terminal("completed"),
    })),
    "Coach run completed.",
  );
  assert.equal(
    coachStatusMessage(completeCoachTurn(streamingTurn(), "failed"), chatWith({
      terminal: terminal("failed"),
    })),
    "Coach run failed.",
  );
  assert.equal(
    coachStatusMessage(completeCoachTurn(streamingTurn(), "cancelled"), chatWith({
      terminal: terminal("cancelled"),
    })),
    "Coach run cancelled. Partial output above is frozen.",
  );
});

test("activity: tool labels use fixed copy, never a server summary", () => {
  assert.equal(
    coachActivityMessage({ kind: "tool-start", seq: 0, tool: "analyze_progress", callId: "c1" }),
    "Running {tool}…",
  );
  assert.equal(
    coachActivityMessage({
      kind: "tool-end",
      seq: 1,
      tool: "analyze_progress",
      callId: "c1",
      ok: true,
      detail: "raw server summary",
    }),
    "Finished {tool}",
  );
  assert.equal(
    coachActivityMessage({
      kind: "tool-end",
      seq: 2,
      tool: "analyze_progress",
      callId: "c2",
      ok: false,
      detail: "raw server error",
    }),
    "Tool {tool} failed.",
  );
  assert.equal(coachActivityMessage({ kind: "analysis-result", seq: 3 }), "Analysis ready.");
  assert.equal(
    coachActivityMessage({ kind: "run-error", seq: 4, code: "EVENT_CAP" }),
    "The coaching run reported an error.",
  );
});

// ---------------------------------------------------------------------------
// Cancel plan (delegated to the transport model)
// ---------------------------------------------------------------------------

test("cancel plan: detach-only vs explicit server cancel", () => {
  const local = coachTurnCancelPlan(INITIAL_COACH_TURN_STATE, {
    terminal: null,
    streamActive: false,
  });
  assert.deepEqual(local, { abortStream: false, postCancel: false, phase: "cancelled" });

  const live = coachTurnCancelPlan(streamingTurn(), {
    terminal: null,
    streamActive: true,
  });
  assert.deepEqual(live, { abortStream: true, postCancel: true, phase: "cancelling" });

  const done = coachTurnCancelPlan(completeCoachTurn(streamingTurn(), "completed"), {
    terminal: terminal("completed"),
    streamActive: true,
  });
  assert.deepEqual(done, { abortStream: true, postCancel: false, phase: "done" });

  const failed = coachTurnCancelPlan(completeCoachTurn(streamingTurn(), "failed"), {
    terminal: terminal("failed"),
    streamActive: false,
  });
  assert.equal(failed.postCancel, false);
  assert.equal(failed.phase, "failed");

  const cancelled = coachTurnCancelPlan(completeCoachTurn(streamingTurn(), "cancelled"), {
    terminal: terminal("cancelled"),
    streamActive: false,
  });
  assert.equal(cancelled.postCancel, false);
  assert.equal(cancelled.phase, "cancelled");
});
