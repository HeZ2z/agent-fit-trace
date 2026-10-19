/**
 * Pure screen model for the mobile Coach tab.
 *
 * This module owns the deterministic parts of the hosted-cloud Coach screen:
 * gate resolution, prompt validation, the turn phase machine, redacted error
 * copy, and the status/activity labels. It imports no React, expo, fetch,
 * clock or storage, and every transition returns a NEW state object (the
 * input is never mutated). The screen keeps the transport and reducer calls;
 * `tests/mobileCoachScreenModel.test.ts` exercises only this file.
 *
 * The hosted cloud coach is the only mobile coaching backend. There is no
 * local-agent state here on purpose: a mobile build either talks to the
 * configured cloud API or explains why it cannot.
 */

import {
  isCancelledError,
  coachErrorMessage,
  coachErrorMessageKey,
  planCoachCancel,
  toCoachError,
  type CoachCancelPlan,
  type CoachChatState,
  type CoachErrorCode,
  type CoachStatusEntry,
  type CoachTerminal,
} from "./coachModel.ts";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** What the Coach tab may render before any network call is made. */
export type CoachGate = "loading" | "signed-out" | "unconfigured" | "ready";

export interface CoachGateInput {
  /**
   * `AuthStatus` from `useAuth()`. Kept as a string so this module stays
   * independent of the auth package (and loads under `node:test`).
   */
  readonly authStatus: string;
  /** `readCoachConfig().configured` for `EXPO_PUBLIC_FIT_TRACE_API_URL`. */
  readonly coachConfigured: boolean;
}

/**
 * Resolve the one gate the screen renders.
 *
 * A build with no cloud API URL is "unconfigured" no matter who is signed in:
 * promising a sign-in button would not make the hosted coach reachable. Auth
 * restore is "loading"; only a verified signed-in account over a configured
 * build reaches "ready". Every other auth state (signed-out, error,
 * unconfigured auth) shows the sign-in gate, whose button opens the sign-in
 * screen that explains an auth-unconfigured build.
 */
export function resolveCoachGate(input: CoachGateInput): CoachGate {
  if (!input.coachConfigured) return "unconfigured";
  if (input.authStatus === "loading") return "loading";
  if (input.authStatus === "signed-in") return "ready";
  return "signed-out";
}

/** True only for the state where a cloud coaching request may be started. */
export function canUseCoachGate(gate: CoachGate): gate is "ready" {
  return gate === "ready";
}

// ---------------------------------------------------------------------------
// Prompt validation
// ---------------------------------------------------------------------------

/** Match the shared cloud submit guard (`MAX_PROMPT_LENGTH` in the contract). */
export const COACH_PROMPT_MAX_LENGTH = 64 * 1024;

export type CoachPromptIssue = "empty" | "too-long";

export type CoachPromptValidation =
  | { readonly ok: true; readonly prompt: string }
  | { readonly ok: false; readonly issue: CoachPromptIssue };

/**
 * Validate one ask. The submitted prompt is the trimmed value: a prompt of
 * only whitespace is empty, and the 64 KiB bound is measured on the same
 * UTF-16 length the server contract checks.
 */
export function validateCoachPrompt(
  raw: string,
  maxLength = COACH_PROMPT_MAX_LENGTH,
): CoachPromptValidation {
  const prompt = typeof raw === "string" ? raw.trim() : "";
  if (prompt === "") return { ok: false, issue: "empty" };
  if (prompt.length > maxLength) return { ok: false, issue: "too-long" };
  return { ok: true, prompt };
}

/** English source for a prompt issue; the screen passes it through `t()`. */
export function coachPromptIssueMessage(issue: CoachPromptIssue): string {
  return issue === "empty"
    ? "Enter a question for the coach."
    : "Your question is too long. Shorten it and try again.";
}

// ---------------------------------------------------------------------------
// Turn phase machine
// ---------------------------------------------------------------------------

/**
 * One ask's lifecycle:
 *
 * `idle` -> `creating` (session/snapshot/submit in flight)
 *        -> `streaming` (run established, events folding)
 *        -> `terminal` (completed/failed terminal envelope)
 *        -> `cancelled` (server confirmed cancelled, or no run was created)
 *
 * A cancelled/terminal turn may be followed by a new `creating` turn. The
 * session id is preserved across turns (the conversation reuses it); the run
 * id belongs to the current turn only. `cancelRequested` records intent while
 * the server cancel / in-flight submit resolves, so the UI never invents a
 * cancelled result before the server confirms it.
 */
export type CoachScreenPhase = "idle" | "creating" | "streaming" | "terminal" | "cancelled";

export interface CoachTurnState {
  readonly phase: CoachScreenPhase;
  /** Coaching session reused for every ask in this conversation. */
  readonly sessionId: string | null;
  /** The current run; null until the submit is accepted (and after reset). */
  readonly runId: string | null;
  /** A cancel was requested and is waiting for the transport to resolve it. */
  readonly cancelRequested: boolean;
}

export const INITIAL_COACH_TURN_STATE: CoachTurnState = Object.freeze({
  phase: "idle",
  sessionId: null,
  runId: null,
  cancelRequested: false,
});

/** True while a turn owns an in-flight setup or a nonterminal run. */
export function isCoachTurnActive(state: CoachTurnState): boolean {
  return state.phase === "creating" || state.phase === "streaming";
}

/** Only idle/terminal/cancelled turns may start a new ask. */
export function canStartCoachTurn(state: CoachTurnState): boolean {
  return state.phase === "idle" || state.phase === "terminal" || state.phase === "cancelled";
}

/** A pre-run setup and a live run are both cancellable. */
export function canCancelCoachTurn(state: CoachTurnState): boolean {
  return isCoachTurnActive(state);
}

/**
 * Enter `creating`. Refuses (returns the same state) while a turn is already
 * active, so a double tap cannot dispatch a second run. The conversation's
 * session is carried over; the previous run id is not.
 */
export function startCoachTurn(state: CoachTurnState): CoachTurnState {
  if (!canStartCoachTurn(state)) return state;
  return {
    phase: "creating",
    sessionId: state.sessionId,
    runId: null,
    cancelRequested: false,
  };
}

/** Record the lazily created session so later asks reuse it. */
export function rememberCoachSession(
  state: CoachTurnState,
  sessionId: string,
): CoachTurnState {
  if (state.phase !== "creating") return state;
  if (typeof sessionId !== "string" || sessionId.trim() === "") return state;
  if (state.sessionId === sessionId) return state;
  return { ...state, sessionId };
}

/** The submit was accepted and the run now streams. */
export function markCoachRunStarted(
  state: CoachTurnState,
  runId: string,
): CoachTurnState {
  if (state.phase !== "creating") return state;
  if (typeof runId !== "string" || runId.trim() === "") return state;
  return { ...state, phase: "streaming", runId };
}

/**
 * Record a cancel intent without claiming the run is cancelled. The screen
 * keeps the stream attached (or reattaches) so the server terminal confirms
 * the outcome; a pre-submit setup resolves through
 * {@link cancelCoachTurnBeforeRun}.
 */
export function requestCoachTurnCancel(state: CoachTurnState): CoachTurnState {
  if (!isCoachTurnActive(state) || state.cancelRequested) return state;
  return { ...state, cancelRequested: true };
}

/**
 * A cancel attempt failed (network/refusal): the run is still active and the
 * server never confirmed a cancellation, so stop claiming one. The user may
 * retry the explicit cancel.
 */
export function clearCoachTurnCancel(state: CoachTurnState): CoachTurnState {
  if (!state.cancelRequested) return state;
  return { ...state, cancelRequested: false };
}

/**
 * Resolve a cancel that landed before any run existed (session/snapshot
 * setup, or a submit that provably never left). This is the only local
 * cancellation claim: no server run is outstanding.
 */
export function cancelCoachTurnBeforeRun(state: CoachTurnState): CoachTurnState {
  if (state.phase !== "creating" || !state.cancelRequested) return state;
  return {
    phase: "cancelled",
    sessionId: state.sessionId,
    runId: null,
    cancelRequested: false,
  };
}

/**
 * Fold the server's terminal status. `cancelled` moves to the cancelled
 * phase; `completed`/`failed` move to terminal. Any non-streaming turn is
 * left untouched (a terminal never rewrites a local pre-run cancellation).
 */
export function completeCoachTurn(
  state: CoachTurnState,
  status: CoachTerminal["status"],
): CoachTurnState {
  if (state.phase !== "streaming") return state;
  return {
    ...state,
    phase: status === "cancelled" ? "cancelled" : "terminal",
    cancelRequested: false,
  };
}

/**
 * A setup failure before the submit was dispatched cannot leave a run, so the
 * turn returns to idle and the question can be retried. A streaming failure
 * keeps the turn and its run id: the run may still be live server-side, so
 * the only honest actions remain cancel (explicit POST) and status.
 */
export function failCoachTurn(state: CoachTurnState): CoachTurnState {
  if (state.phase !== "creating") return state;
  return {
    phase: "idle",
    sessionId: state.sessionId,
    runId: null,
    cancelRequested: false,
  };
}

/** Return a finished turn to idle while keeping the reusable session. */
export function resetCoachTurn(state: CoachTurnState): CoachTurnState {
  if (!canStartCoachTurn(state)) return state;
  return {
    phase: "idle",
    sessionId: state.sessionId,
    runId: null,
    cancelRequested: false,
  };
}

/** Delegate the detach-vs-explicit-cancel decision to the transport model. */
export function coachTurnCancelPlan(
  state: CoachTurnState,
  input: { readonly terminal: CoachTerminal | null; readonly streamActive: boolean },
): CoachCancelPlan {
  return planCoachCancel({
    runId: state.runId,
    terminal: input.terminal,
    streamActive: input.streamActive,
  });
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Redacted, localizable view of a failed coach operation. */
export interface CoachErrorCopy {
  readonly code: CoachErrorCode;
  /** Stable i18n key from the transport model (`coach.error.*`). */
  readonly key: string;
  /**
   * English display source for `t()`. It is always the canonical message for
   * the code, never the thrown error's own message (which may carry a raw
   * server diagnostic), never a token.
   */
  readonly source: string;
}

/**
 * Map any thrown value to display copy.
 *
 * Cancellation (our `CoachError("cancelled")` or a fetch `AbortError`) is not
 * an error the screen shows: it returns `null`. Everything else is normalized
 * with `toCoachError` (so an unknown cause degrades to `server` and a fetch
 * `TypeError` to `network`) and mapped to its stable key + canonical English
 * source.
 */
export function coachErrorCopy(cause: unknown): CoachErrorCopy | null {
  if (isCancelledError(cause)) return null;
  const error = toCoachError(cause, "server");
  return {
    code: error.code,
    key: coachErrorMessageKey(error.code),
    source: coachErrorMessage(error.code),
  };
}

// ---------------------------------------------------------------------------
// Status and activity copy
// ---------------------------------------------------------------------------

/**
 * The one run-status line, derived from the turn plus the folded chat state.
 * The returned string is an English source for `t()`.
 */
export function coachStatusMessage(
  state: CoachTurnState,
  chat: CoachChatState,
): string {
  switch (state.phase) {
    case "creating":
      return state.cancelRequested
        ? "Cancelling the coach run…"
        : "Preparing the cloud coach…";
    case "streaming":
      if (state.cancelRequested) return "Cancelling the coach run…";
      return chat.assistantText === ""
        ? "Coach is working…"
        : "Coach is responding…";
    case "terminal":
      return chat.terminal?.status === "failed"
        ? "Coach run failed."
        : "Coach run completed.";
    case "cancelled":
      return "Coach run cancelled. Partial output above is frozen.";
    default:
      return "Ready for your question.";
  }
}

/**
 * Label one folded tool/status entry. Only the tool name and a fixed label
 * are rendered: summaries and error details stay out of the UI so a server
 * diagnostic can never become copy.
 */
export function coachActivityMessage(entry: CoachStatusEntry): string {
  switch (entry.kind) {
    case "tool-start":
      return "Running {tool}…";
    case "tool-end":
      return entry.ok ? "Finished {tool}" : "Tool {tool} failed.";
    case "analysis-result":
      return "Analysis ready.";
    case "run-error":
      return "The coaching run reported an error.";
    default:
      return "The coaching run reported an error.";
  }
}
