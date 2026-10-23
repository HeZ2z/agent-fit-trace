import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionDraft, reduceSessionState } from "../packages/fit-trace-workout-session/src/index.ts";
import type { SessionAction, SessionState } from "../packages/fit-trace-workout-session/src/index.ts";

/**
 * Exhaustive reducer coverage, one case per action variant.
 *
 * The table is a `Record<SessionAction["type"], ActionCase>`, so adding a
 * variant to the union without adding a case here (or in the reducer's
 * exhaustive switch) is a TypeScript error.
 *
 * The detailed timing/rest behavior has its own file
 * (`workoutSessionTiming.test.ts`); this table proves every action is routed to
 * a real transition.
 */

const DATE = "2026-10-23";

interface ActionCase {
  /** State the action is applied to. */
  state: () => SessionState;
  action: SessionAction;
  /** Assert the observable result of applying `action`. */
  verify: (next: SessionState, before: SessionState) => void;
}

function untimedState(): SessionState {
  return { draft: createSessionDraft(DATE), runtime: { rest: null, restEndedAtMs: null } };
}

/** Active timing started at 1s. */
function startedState(): SessionState {
  return reduceSessionState(untimedState(), { type: "startSession", nowMs: 1_000 });
}

/** Paused timing: started at 1s, paused at 5s. */
function pausedState(): SessionState {
  return reduceSessionState(startedState(), { type: "pauseSession", nowMs: 5_000 });
}

/** Active timing with a 90s rest running for exercise 1 / set 2 from t=3s. */
function restingState(): SessionState {
  return reduceSessionState(startedState(), {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 3_000,
  });
}

function stateWithTwoExercises(): SessionState {
  return reduceSessionState(untimedState(), { type: "addExercise" });
}

function stateWithTwoSets(): SessionState {
  return reduceSessionState(untimedState(), { type: "addSet", exerciseKey: 1 });
}

function stateWithPain(): SessionState {
  return reduceSessionState(untimedState(), { type: "addPain" });
}

const CASES: Record<SessionAction["type"], ActionCase> = {
  setDate: {
    state: untimedState,
    action: { type: "setDate", date: "2026-10-24" },
    verify: (next) => assert.equal(next.draft.date, "2026-10-24"),
  },
  setSessionType: {
    state: untimedState,
    action: { type: "setSessionType", sessionType: "mobility" },
    verify: (next) => assert.equal(next.draft.sessionType, "mobility"),
  },
  setDurationMinutes: {
    state: untimedState,
    action: { type: "setDurationMinutes", value: "45" },
    verify: (next) => assert.equal(next.draft.durationMinutes, "45"),
  },
  setSleepHours: {
    state: untimedState,
    action: { type: "setSleepHours", value: "7.5" },
    verify: (next) => assert.equal(next.draft.sleepHours, "7.5"),
  },
  setNotes: {
    state: untimedState,
    action: { type: "setNotes", value: "felt strong" },
    verify: (next) => assert.equal(next.draft.notes, "felt strong"),
  },
  addExercise: {
    state: untimedState,
    action: { type: "addExercise" },
    verify: (next, before) => {
      assert.equal(next.draft.exercises.length, before.draft.exercises.length + 1);
      const added = next.draft.exercises[next.draft.exercises.length - 1];
      assert.equal(added.name, "");
      assert.equal(added.sets.length, 1);
    },
  },
  removeExercise: {
    state: stateWithTwoExercises,
    action: { type: "removeExercise", exerciseKey: 1 },
    verify: (next) => {
      assert.equal(next.draft.exercises.length, 1);
      assert.equal(next.draft.exercises[0].key, 3);
    },
  },
  setExerciseName: {
    state: untimedState,
    action: { type: "setExerciseName", exerciseKey: 1, name: "squat" },
    verify: (next) => assert.equal(next.draft.exercises[0].name, "squat"),
  },
  setExerciseRestSeconds: {
    state: untimedState,
    action: { type: "setExerciseRestSeconds", exerciseKey: 1, restSeconds: 120 },
    verify: (next) => assert.equal(next.draft.exercises[0].restSeconds, 120),
  },
  addSet: {
    state: untimedState,
    action: { type: "addSet", exerciseKey: 1 },
    verify: (next, before) => {
      assert.equal(next.draft.exercises[0].sets.length, before.draft.exercises[0].sets.length + 1);
      const added = next.draft.exercises[0].sets[next.draft.exercises[0].sets.length - 1];
      assert.equal(added.reps, "");
    },
  },
  removeSet: {
    state: stateWithTwoSets,
    action: { type: "removeSet", exerciseKey: 1, setKey: 3 },
    verify: (next) => assert.equal(next.draft.exercises[0].sets.length, 1),
  },
  setSetField: {
    state: untimedState,
    action: { type: "setSetField", exerciseKey: 1, setKey: 2, field: "weight", value: "80" },
    verify: (next) => assert.equal(next.draft.exercises[0].sets[0].weight, "80"),
  },
  toggleSetDone: {
    state: startedState,
    action: { type: "toggleSetDone", exerciseKey: 1, setKey: 2, nowMs: 3_000 },
    verify: (next) => {
      assert.equal(next.draft.exercises[0].sets[0].done, true);
      assert.equal(next.runtime.rest?.setKey, 2, "checking a set starts its rest");
    },
  },
  addPain: {
    state: untimedState,
    action: { type: "addPain" },
    verify: (next, before) => {
      assert.equal(next.draft.pain.length, before.draft.pain.length + 1);
      assert.equal(next.draft.pain[next.draft.pain.length - 1].area, "");
    },
  },
  removePain: {
    state: stateWithPain,
    action: { type: "removePain", painKey: 3 },
    verify: (next) => assert.deepEqual(next.draft.pain, []),
  },
  setPainField: {
    state: stateWithPain,
    action: { type: "setPainField", painKey: 3, field: "area", value: "lower_back" },
    verify: (next) => assert.equal(next.draft.pain[0].area, "lower_back"),
  },

  // Persisted timing.
  startSession: {
    state: untimedState,
    action: { type: "startSession", nowMs: 5_000 },
    verify: (next) => {
      assert.deepEqual(next.draft.timing, {
        startedAtMs: 5_000,
        endedAtMs: null,
        pausedAtMs: null,
        pausedTotalMs: 0,
        lastActiveAtMs: 5_000,
      });
      assert.deepEqual(next.runtime, { rest: null, restEndedAtMs: null });
    },
  },
  pauseSession: {
    state: startedState,
    action: { type: "pauseSession", nowMs: 5_000 },
    verify: (next) => {
      assert.equal(next.draft.timing?.pausedAtMs, 5_000);
      assert.equal(next.draft.timing?.lastActiveAtMs, 5_000);
    },
  },
  resumeSession: {
    state: pausedState,
    action: { type: "resumeSession", nowMs: 8_000 },
    verify: (next) => {
      assert.equal(next.draft.timing?.pausedAtMs, null);
      assert.equal(next.draft.timing?.pausedTotalMs, 3_000);
      assert.equal(next.draft.timing?.lastActiveAtMs, 8_000);
    },
  },
  finishSession: {
    state: startedState,
    action: { type: "finishSession", nowMs: 10_000 },
    verify: (next) => {
      assert.equal(next.draft.timing?.endedAtMs, 10_000);
      assert.equal(next.draft.timing?.lastActiveAtMs, 10_000);
      assert.equal(next.runtime.rest, null);
      assert.equal(next.runtime.restEndedAtMs, null, "finishing never cues");
    },
  },

  // Transient rest.
  skipRest: {
    state: restingState,
    action: { type: "skipRest" },
    verify: (next) => {
      assert.equal(next.runtime.rest, null);
      assert.equal(next.runtime.restEndedAtMs, null, "skipping never cues");
    },
  },
  adjustRest: {
    state: restingState,
    action: { type: "adjustRest", deltaMs: 15_000 },
    verify: (next) => {
      assert.equal(next.runtime.rest?.durationMs, 105_000);
      assert.equal(next.runtime.rest?.endsAtMs, 108_000);
    },
  },
  tick: {
    state: restingState,
    action: { type: "tick", nowMs: 93_000 },
    verify: (next) => {
      assert.equal(next.runtime.rest, null);
      assert.equal(next.runtime.restEndedAtMs, 93_000);
    },
  },
};

for (const [type, testCase] of Object.entries(CASES)) {
  test(`reduces the ${type} action`, () => {
    assert.equal(testCase.action.type, type, "table key matches the action variant");

    const before = testCase.state();
    const snapshot = structuredClone(before);
    const next = reduceSessionState(before, testCase.action);

    assert.deepEqual(before, snapshot, `${type} must not mutate the input state`);
    testCase.verify(next, snapshot);
  });
}

test("covers every documented action variant", () => {
  // Compile-time completeness comes from the Record annotation above. This
  // asserts the runtime table is non-empty and every entry carries its own
  // variant, which catches copy/paste mistakes.
  const entries = Object.entries(CASES);
  assert.ok(entries.length >= 20, "all action variants have a case");
  for (const [type, testCase] of entries) {
    assert.equal(testCase.action.type, type);
  }
});
