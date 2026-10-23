import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSessionDraft,
  createSessionRuntime,
  elapsedMs,
  reduceSessionState,
  rehydrateSessionDraft,
  sessionPhase,
} from "../packages/fit-trace-workout-session/src/index.ts";
import type { SessionAction, SessionState } from "../packages/fit-trace-workout-session/src/index.ts";

/**
 * Timing and transient-rest behavior with an injected clock.
 *
 * The reducer never reads `Date.now()`; every test drives it through `nowMs`, so
 * pause/resume/finish and rest countdowns are exact and deterministic. Rest
 * state is transient: the tests assert it never leaks into the draft and that
 * a restore starts from an empty runtime.
 */

const DATE = "2026-10-23";

function untimedState(): SessionState {
  return { draft: createSessionDraft(DATE), runtime: createSessionRuntime() };
}

function startedState(nowMs = 1_000): SessionState {
  return reduceSessionState(untimedState(), { type: "startSession", nowMs });
}

/** Active timing with a running 90s rest for exercise 1 / set 2 (ends at t=92s). */
function restingState(): SessionState {
  return reduceSessionState(startedState(1_000), {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 2_000,
  });
}

function run(state: SessionState, ...actions: SessionAction[]): SessionState {
  return actions.reduce((current, action) => reduceSessionState(current, action), state);
}

// ---------------------------------------------------------------------------
// Start / pause / resume / finish
// ---------------------------------------------------------------------------

test("startSession creates an active timing from an untimed draft", () => {
  const next = reduceSessionState(untimedState(), { type: "startSession", nowMs: 5_000 });

  assert.deepEqual(next.draft.timing, {
    startedAtMs: 5_000,
    endedAtMs: null,
    pausedAtMs: null,
    pausedTotalMs: 0,
    lastActiveAtMs: 5_000,
  });
  assert.deepEqual(next.runtime, { rest: null, restEndedAtMs: null });
  assert.equal(elapsedMs(next.draft, 5_000), 0);
  assert.equal(sessionPhase(next, 5_000), "active");
});

test("startSession is a no-op for an already timed session", () => {
  const started = startedState(1_000);
  assert.equal(reduceSessionState(started, { type: "startSession", nowMs: 9_000 }), started);
});

test("pause freezes elapsed time and resume accumulates pausedTotalMs", () => {
  let state = startedState(1_000);

  state = reduceSessionState(state, { type: "pauseSession", nowMs: 6_000 });
  assert.equal(state.draft.timing?.pausedAtMs, 6_000);
  assert.equal(state.draft.timing?.lastActiveAtMs, 6_000);
  assert.equal(elapsedMs(state.draft, 6_000), 5_000);
  assert.equal(elapsedMs(state.draft, 60_000), 5_000, "a pause stops the clock");
  assert.equal(sessionPhase(state, 60_000), "paused");

  state = reduceSessionState(state, { type: "resumeSession", nowMs: 16_000 });
  assert.equal(state.draft.timing?.pausedAtMs, null);
  assert.equal(state.draft.timing?.pausedTotalMs, 10_000);
  assert.equal(state.draft.timing?.lastActiveAtMs, 16_000);
  assert.equal(elapsedMs(state.draft, 16_000), 5_000);
  assert.equal(elapsedMs(state.draft, 20_000), 9_000);
  assert.equal(sessionPhase(state, 20_000), "active");
});

test("pause, resume and finish ignore out-of-phase sessions", () => {
  const untimed = untimedState();
  assert.equal(reduceSessionState(untimed, { type: "pauseSession", nowMs: 5_000 }), untimed);
  assert.equal(reduceSessionState(untimed, { type: "resumeSession", nowMs: 5_000 }), untimed);
  assert.equal(reduceSessionState(untimed, { type: "finishSession", nowMs: 5_000 }), untimed);

  const started = startedState(1_000);
  assert.equal(
    reduceSessionState(started, { type: "resumeSession", nowMs: 2_000 }),
    started,
    "resume requires a paused session",
  );

  const finished = reduceSessionState(started, { type: "finishSession", nowMs: 9_000 });
  assert.equal(reduceSessionState(finished, { type: "pauseSession", nowMs: 10_000 }), finished);
  assert.equal(reduceSessionState(finished, { type: "resumeSession", nowMs: 10_000 }), finished);
  assert.equal(reduceSessionState(finished, { type: "finishSession", nowMs: 11_000 }), finished);
});

test("finish freezes duration and clears a running rest without a cue", () => {
  let state = restingState();
  assert.notEqual(state.runtime.rest, null);

  state = reduceSessionState(state, { type: "finishSession", nowMs: 30_000 });

  assert.equal(state.draft.timing?.endedAtMs, 30_000);
  assert.equal(state.draft.timing?.lastActiveAtMs, 30_000);
  assert.equal(state.runtime.rest, null);
  assert.equal(state.runtime.restEndedAtMs, null, "finish must not emit the rest-ended cue");
  assert.equal(elapsedMs(state.draft, 30_000), 29_000);
  assert.equal(elapsedMs(state.draft, 90_000), 29_000, "finished elapsed is frozen");
  assert.equal(sessionPhase(state, 90_000), "finished");
});

test("finish while paused does not count the paused interval", () => {
  let state = startedState(1_000);
  state = reduceSessionState(state, { type: "pauseSession", nowMs: 6_000 }); // 5s active
  state = reduceSessionState(state, { type: "finishSession", nowMs: 20_000 });

  assert.equal(state.draft.timing?.pausedAtMs, null);
  assert.equal(state.draft.timing?.pausedTotalMs, 14_000);
  assert.equal(elapsedMs(state.draft, 20_000), 5_000);
});

// ---------------------------------------------------------------------------
// Derived timing helpers
// ---------------------------------------------------------------------------

test("elapsedMs returns null when untimed and clamps clock anomalies at zero", () => {
  assert.equal(elapsedMs(createSessionDraft(DATE), 1_000), null);

  const started = startedState(5_000).draft;
  assert.equal(elapsedMs(started, 1_000), 0, "a backwards clock clamps to zero");
  assert.equal(elapsedMs(started, 65_000), 60_000);
});

test("sessionPhase derives editing, active, resting, paused and finished", () => {
  assert.equal(sessionPhase(untimedState(), 0), "editing");
  assert.equal(sessionPhase(startedState(1_000), 2_000), "active");
  assert.equal(sessionPhase(restingState(), 2_000), "resting");
  assert.equal(
    sessionPhase(restingState(), 200_000),
    "active",
    "an expired rest that has not been ticked reads as active",
  );

  const paused = reduceSessionState(startedState(1_000), { type: "pauseSession", nowMs: 5_000 });
  assert.equal(sessionPhase(paused, 1_000_000), "paused");

  const finished = reduceSessionState(startedState(1_000), { type: "finishSession", nowMs: 5_000 });
  assert.equal(sessionPhase(finished, 1_000_000), "finished");
});

// ---------------------------------------------------------------------------
// Checking sets: prefill and rest start
// ---------------------------------------------------------------------------

test("checking the last set pre-fills a follow-up set and starts its rest", () => {
  let state = startedState(1_000);
  state = run(
    state,
    { type: "setSetField", exerciseKey: 1, setKey: 2, field: "weight", value: "100" },
    { type: "setSetField", exerciseKey: 1, setKey: 2, field: "reps", value: "5" },
    { type: "setSetField", exerciseKey: 1, setKey: 2, field: "rpe", value: "8" },
  );
  const setCount = state.draft.exercises[0].sets.length;

  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 10_000,
  });

  const exercise = state.draft.exercises[0];
  assert.equal(exercise.sets.length, setCount + 1, "checking the last set appends the next one");
  assert.equal(exercise.sets[0].done, true);
  assert.equal(exercise.sets[0].rpe, "8", "the checked set keeps its content");
  assert.deepEqual(exercise.sets[1], {
    key: 3,
    reps: "5",
    weight: "100",
    rpe: "",
    done: false,
    prefilled: true,
  });
  assert.equal(state.draft.timing?.lastActiveAtMs, 10_000, "checking a set counts as activity");

  assert.deepEqual(state.runtime.rest, {
    exerciseKey: 1,
    setKey: 2,
    durationMs: 90_000,
    endsAtMs: 100_000,
    remainingMs: null,
  });
  assert.equal(sessionPhase(state, 10_000), "resting");
});

test("checking a non-last set starts rest without appending", () => {
  let state = reduceSessionState(startedState(1_000), { type: "addSet", exerciseKey: 1 });
  const setCount = state.draft.exercises[0].sets.length;

  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 4_000,
  });

  assert.equal(state.draft.exercises[0].sets.length, setCount);
  assert.equal(state.draft.exercises[0].sets[0].done, true);
  assert.equal(state.runtime.rest?.setKey, 2);
});

test("editing a prefilled suggestion promotes it to user content", () => {
  let state = reduceSessionState(startedState(1_000), {
    type: "setSetField",
    exerciseKey: 1,
    setKey: 2,
    field: "weight",
    value: "100",
  });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 10_000,
  });
  const prefilledSet = state.draft.exercises[0].sets[1];
  assert.equal(prefilledSet.prefilled, true);

  // Repeating the same value is a no-op and must not silently promote it.
  const unchanged = reduceSessionState(state, {
    type: "setSetField",
    exerciseKey: 1,
    setKey: prefilledSet.key,
    field: "weight",
    value: "100",
  });
  assert.equal(unchanged.draft.exercises[0].sets[1].prefilled, true);

  // Actually editing the suggestion makes it real content.
  state = reduceSessionState(state, {
    type: "setSetField",
    exerciseKey: 1,
    setKey: prefilledSet.key,
    field: "rpe",
    value: "8",
  });
  const edited = state.draft.exercises[0].sets[1];
  assert.equal(edited.prefilled, false);
  assert.equal(edited.rpe, "8");
  assert.equal(edited.weight, "100");
});

test("a zero restSeconds disables rest and a paused session never starts one", () => {
  let noRest = startedState(1_000);
  noRest = reduceSessionState(noRest, {
    type: "setExerciseRestSeconds",
    exerciseKey: 1,
    restSeconds: 0,
  });
  noRest = reduceSessionState(noRest, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 2_000,
  });
  assert.equal(noRest.runtime.rest, null);
  assert.equal(noRest.draft.exercises[0].sets[0].done, true);

  let paused = reduceSessionState(startedState(1_000), { type: "pauseSession", nowMs: 2_000 });
  paused = reduceSessionState(paused, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 3_000,
  });
  assert.equal(paused.runtime.rest, null);
  assert.equal(paused.draft.exercises[0].sets[0].done, true);
});

test("starting a new rest replaces a running one", () => {
  let state = reduceSessionState(startedState(1_000), { type: "addExercise" });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 2_000,
  });
  assert.equal(state.runtime.rest?.exerciseKey, 1);

  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 3,
    setKey: 4,
    nowMs: 5_000,
  });
  assert.deepEqual(state.runtime.rest, {
    exerciseKey: 3,
    setKey: 4,
    durationMs: 90_000,
    endsAtMs: 95_000,
    remainingMs: null,
  });
});

test("a rest-ended cue is cleared when a new rest starts", () => {
  let state = reduceSessionState(startedState(1_000), { type: "addExercise" });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 2_000,
  });
  state = reduceSessionState(state, { type: "tick", nowMs: 92_000 });
  assert.equal(state.runtime.restEndedAtMs, 92_000);

  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 3,
    setKey: 4,
    nowMs: 93_000,
  });
  assert.equal(state.runtime.restEndedAtMs, null);
});

test("unchecking a set clears only the rest it started", () => {
  let state = reduceSessionState(startedState(1_000), { type: "addExercise" });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 2_000,
  });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 3,
    setKey: 4,
    nowMs: 3_000,
  });
  assert.equal(state.runtime.rest?.exerciseKey, 3);

  const uncheckOther = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 4_000,
  });
  assert.equal(uncheckOther.draft.exercises[0].sets[0].done, false);
  assert.equal(uncheckOther.runtime.rest?.exerciseKey, 3, "another set's rest is untouched");

  const uncheckRest = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 3,
    setKey: 4,
    nowMs: 5_000,
  });
  assert.equal(uncheckRest.draft.exercises[1].sets[0].done, false);
  assert.equal(uncheckRest.runtime.rest, null);
  assert.equal(uncheckRest.runtime.restEndedAtMs, null, "unchecking never cues");
});

test("set toggles are ignored for untimed and finished sessions", () => {
  const untimed = untimedState();
  assert.equal(
    reduceSessionState(untimed, {
      type: "toggleSetDone",
      exerciseKey: 1,
      setKey: 2,
      nowMs: 1_000,
    }),
    untimed,
  );

  const finished = reduceSessionState(startedState(1_000), {
    type: "finishSession",
    nowMs: 5_000,
  });
  assert.equal(
    reduceSessionState(finished, {
      type: "toggleSetDone",
      exerciseKey: 1,
      setKey: 2,
      nowMs: 6_000,
    }),
    finished,
  );
});

// ---------------------------------------------------------------------------
// Ticking, background jumps and the single cue
// ---------------------------------------------------------------------------

test("tick settles an elapsed rest exactly once", () => {
  const state = restingState();

  const early = reduceSessionState(state, { type: "tick", nowMs: 50_000 });
  assert.equal(early, state, "before the end, tick is a no-op");

  const boundary = reduceSessionState(state, { type: "tick", nowMs: 92_000 });
  assert.equal(boundary.runtime.rest, null);
  assert.equal(boundary.runtime.restEndedAtMs, 92_000);

  // A background jump (app was suspended) settles on the first tick back.
  const jumped = reduceSessionState(state, { type: "tick", nowMs: 500_000 });
  assert.equal(jumped.runtime.rest, null);
  assert.equal(jumped.runtime.restEndedAtMs, 500_000);

  const again = reduceSessionState(jumped, { type: "tick", nowMs: 600_000 });
  assert.equal(again, jumped, "the cue is emitted once");
  assert.equal(again.runtime.restEndedAtMs, 500_000);
});

test("tick ignores a frozen rest while the session is paused", () => {
  let state = restingState();
  state = reduceSessionState(state, { type: "pauseSession", nowMs: 20_000 });
  assert.equal(state.runtime.rest?.remainingMs, 72_000);

  const ticked = reduceSessionState(state, { type: "tick", nowMs: 200_000 });
  assert.equal(ticked, state);
  assert.equal(ticked.runtime.restEndedAtMs, null);
});

// ---------------------------------------------------------------------------
// Adjust / skip
// ---------------------------------------------------------------------------

test("adjusting rest shifts its duration and end time", () => {
  let state = restingState();
  state = reduceSessionState(state, { type: "adjustRest", deltaMs: 15_000 });
  assert.equal(state.runtime.rest?.durationMs, 105_000);
  assert.equal(state.runtime.rest?.endsAtMs, 107_000);

  state = reduceSessionState(state, { type: "adjustRest", deltaMs: -30_000 });
  assert.equal(state.runtime.rest?.durationMs, 75_000);
  assert.equal(state.runtime.rest?.endsAtMs, 77_000);
});

test("adjusting rest to zero or below clears it without a cue", () => {
  const state = reduceSessionState(restingState(), { type: "adjustRest", deltaMs: -90_000 });
  assert.equal(state.runtime.rest, null);
  assert.equal(state.runtime.restEndedAtMs, null);
});

test("adjusting a frozen rest shifts its remaining time", () => {
  let state = reduceSessionState(restingState(), { type: "pauseSession", nowMs: 20_000 });
  state = reduceSessionState(state, { type: "adjustRest", deltaMs: -15_000 });

  assert.equal(state.runtime.rest?.durationMs, 75_000);
  assert.equal(state.runtime.rest?.remainingMs, 57_000);
  assert.equal(state.runtime.rest?.endsAtMs, 92_000, "endsAtMs is rebuilt on resume, not adjusted");

  state = reduceSessionState(state, { type: "resumeSession", nowMs: 60_000 });
  assert.equal(state.runtime.rest?.endsAtMs, 117_000);
  assert.equal(state.runtime.rest?.remainingMs, null);
});

test("skip rest clears the countdown without a cue or a draft change", () => {
  const state = restingState();
  const skipped = reduceSessionState(state, { type: "skipRest" });

  assert.equal(skipped.runtime.rest, null);
  assert.equal(skipped.runtime.restEndedAtMs, null);
  assert.equal(skipped.draft, state.draft, "rest is not persisted state");
});

test("rest actions are no-ops when no rest is running", () => {
  const state = startedState(1_000);
  assert.equal(reduceSessionState(state, { type: "skipRest" }), state);
  assert.equal(reduceSessionState(state, { type: "adjustRest", deltaMs: 15_000 }), state);
  assert.equal(reduceSessionState(state, { type: "tick", nowMs: 10_000 }), state);
});

// ---------------------------------------------------------------------------
// Pause freezes rest / resume rebuilds it
// ---------------------------------------------------------------------------

test("pause freezes a running rest and resume rebuilds its end from the remainder", () => {
  let state = restingState(); // ends at t=92s
  state = reduceSessionState(state, { type: "pauseSession", nowMs: 20_000 });

  assert.deepEqual(state.runtime.rest, {
    exerciseKey: 1,
    setKey: 2,
    durationMs: 90_000,
    endsAtMs: 92_000,
    remainingMs: 72_000,
  });
  assert.equal(sessionPhase(state, 20_000), "paused");

  state = reduceSessionState(state, { type: "resumeSession", nowMs: 60_000 });
  assert.deepEqual(state.runtime.rest, {
    exerciseKey: 1,
    setKey: 2,
    durationMs: 90_000,
    endsAtMs: 132_000,
    remainingMs: null,
  });
  assert.equal(sessionPhase(state, 60_000), "resting");
});

// ---------------------------------------------------------------------------
// Restore policy
// ---------------------------------------------------------------------------

test("rehydrate auto-pauses an active timing at the last active moment", () => {
  let state = startedState(10_000);
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 30_000,
  });

  const draft = rehydrateSessionDraft(state.draft, 3_600_000);
  assert.equal(draft.timing?.pausedAtMs, 30_000, "closed time is not counted");
  assert.equal(elapsedMs(draft, 3_600_000), 20_000);

  // The caller rebuilds the runtime: a stale rest is not restored.
  const restored: SessionState = { draft, runtime: createSessionRuntime() };
  assert.equal(restored.runtime.rest, null);
  assert.equal(restored.runtime.restEndedAtMs, null);
  assert.equal(sessionPhase(restored, 3_600_000), "paused");
});

test("rehydrate clamps the pause to now and never precedes the start", () => {
  assert.equal(rehydrateSessionDraft(startedState(10_000).draft, 5_000).timing?.pausedAtMs, 10_000);

  let state = startedState(10_000);
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 30_000,
  });
  // A backwards clock reports now before lastActiveAtMs; clamp to now.
  assert.equal(rehydrateSessionDraft(state.draft, 20_000).timing?.pausedAtMs, 20_000);
});

test("rehydrate leaves paused, finished and untimed drafts unchanged", () => {
  const untimed = createSessionDraft(DATE);
  assert.equal(rehydrateSessionDraft(untimed, 1_000), untimed);

  const paused = reduceSessionState(startedState(1_000), {
    type: "pauseSession",
    nowMs: 5_000,
  }).draft;
  assert.equal(rehydrateSessionDraft(paused, 9_000), paused);

  const finished = reduceSessionState(startedState(1_000), {
    type: "finishSession",
    nowMs: 5_000,
  }).draft;
  assert.equal(rehydrateSessionDraft(finished, 9_000), finished);
});

// ---------------------------------------------------------------------------
// Removing entities clears their stale rest
// ---------------------------------------------------------------------------

test("removing the resting exercise clears its rest without a cue", () => {
  let state = reduceSessionState(startedState(1_000), { type: "addExercise" });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 3,
    setKey: 4,
    nowMs: 2_000,
  });
  assert.equal(state.runtime.rest?.exerciseKey, 3);

  const removed = reduceSessionState(state, { type: "removeExercise", exerciseKey: 3 });
  assert.equal(removed.runtime.rest, null);
  assert.equal(removed.runtime.restEndedAtMs, null);

  // Removing a different exercise leaves the rest alone.
  let other = reduceSessionState(startedState(1_000), { type: "addExercise" });
  other = reduceSessionState(other, {
    type: "toggleSetDone",
    exerciseKey: 3,
    setKey: 4,
    nowMs: 2_000,
  });
  const kept = reduceSessionState(other, { type: "removeExercise", exerciseKey: 1 });
  assert.equal(kept.runtime.rest?.exerciseKey, 3);
});

test("removing the resting set clears its rest without a cue", () => {
  let state = reduceSessionState(startedState(1_000), { type: "addSet", exerciseKey: 1 });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 2_000,
  });
  assert.equal(state.runtime.rest?.setKey, 2);

  const removed = reduceSessionState(state, {
    type: "removeSet",
    exerciseKey: 1,
    setKey: 2,
  });
  assert.equal(removed.runtime.rest, null);
  assert.equal(removed.runtime.restEndedAtMs, null);

  // Removing a different set leaves the rest alone.
  let other = reduceSessionState(startedState(1_000), { type: "addSet", exerciseKey: 1 });
  other = reduceSessionState(other, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 2_000,
  });
  const kept = reduceSessionState(other, { type: "removeSet", exerciseKey: 1, setKey: 3 });
  assert.equal(kept.runtime.rest?.setKey, 2);
});
