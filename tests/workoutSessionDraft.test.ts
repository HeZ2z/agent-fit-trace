import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_REST_SECONDS,
  SESSION_DRAFT_VERSION,
  allocateKey,
  createDraftExercise,
  createDraftPain,
  createDraftSet,
  createSessionDraft,
  reduceSessionState,
  todayLocalDate,
} from "../packages/fit-trace-workout-session/src/index.ts";
import type {
  SessionDraft,
  SessionState,
  SessionTiming,
} from "../packages/fit-trace-workout-session/src/index.ts";

const DATE = "2026-10-23";

function createState(draft: SessionDraft = createSessionDraft(DATE)): SessionState {
  return { draft, runtime: { rest: null, restEndedAtMs: null } };
}

function timing(overrides: Partial<SessionTiming> = {}): SessionTiming {
  return {
    startedAtMs: 1_000,
    endedAtMs: null,
    pausedAtMs: null,
    pausedTotalMs: 0,
    lastActiveAtMs: 2_000,
    ...overrides,
  };
}

test("creates an untimed draft with one blank exercise and one blank set", () => {
  const draft = createSessionDraft(DATE);

  assert.equal(SESSION_DRAFT_VERSION, 1);
  assert.equal(draft.version, SESSION_DRAFT_VERSION);
  assert.equal(draft.date, DATE);
  assert.equal(draft.sessionType, "strength");
  assert.equal(draft.durationMinutes, "");
  assert.equal(draft.sleepHours, "");
  assert.equal(draft.notes, "");
  assert.equal(draft.timing, null);
  assert.deepEqual(draft.pain, []);
  assert.equal(draft.exercises.length, 1);
  assert.deepEqual(draft.exercises[0], {
    key: 1,
    name: "",
    restSeconds: DEFAULT_REST_SECONDS,
    sets: [{ key: 2, reps: "", weight: "", rpe: "", done: false }],
  });
});

test("creates blank entities deterministically", () => {
  assert.deepEqual(createDraftSet(7), { key: 7, reps: "", weight: "", rpe: "", done: false });
  assert.deepEqual(createDraftPain(3), { key: 3, area: "", level: "" });
  assert.deepEqual(createDraftExercise(4), {
    key: 4,
    name: "",
    restSeconds: DEFAULT_REST_SECONDS,
    sets: [{ key: 5, reps: "", weight: "", rpe: "", done: false }],
  });

  // No ambient state: identical arguments always produce identical values.
  assert.deepEqual(createDraftExercise(4), createDraftExercise(4));
  assert.deepEqual(createSessionDraft(DATE), createSessionDraft(DATE));
});

test("allocates keys as the highest existing key plus one", () => {
  const empty: SessionDraft = { ...createSessionDraft(DATE), exercises: [], pain: [] };
  assert.equal(allocateKey(empty), 1);
  assert.equal(allocateKey(createSessionDraft(DATE)), 3);

  // Keys count up across exercises, sets, and pain entries together.
  const sparse: SessionDraft = {
    ...createSessionDraft(DATE),
    exercises: [{ ...createDraftExercise(10), sets: [{ ...createDraftSet(12) }] }],
    pain: [createDraftPain(7)],
  };
  assert.equal(allocateKey(sparse), 13);
});

test("add actions allocate unique, monotonic keys", () => {
  let state = createState();
  state = reduceSessionState(state, { type: "addSet", exerciseKey: 1 });
  assert.equal(state.draft.exercises[0].sets[1].key, 3);
  assert.equal(allocateKey(state.draft), 4);

  state = reduceSessionState(state, { type: "addPain" });
  assert.equal(state.draft.pain[0].key, 4);
  assert.equal(allocateKey(state.draft), 5);

  state = reduceSessionState(state, { type: "addExercise" });
  assert.equal(state.draft.exercises[1].key, 5);
  assert.equal(state.draft.exercises[1].sets[0].key, 6);
  assert.equal(allocateKey(state.draft), 7);

  const keys = [
    ...state.draft.exercises.flatMap((exercise) => [
      exercise.key,
      ...exercise.sets.map((set) => set.key),
    ]),
    ...state.draft.pain.map((entry) => entry.key),
  ];
  assert.deepEqual(keys, [1, 2, 3, 5, 6, 4]);
  assert.equal(new Set(keys).size, keys.length, "every key is unique");
  assert.equal(Math.max(...keys) + 1, allocateKey(state.draft), "next key is max + 1");
});

test("edits session-level fields", () => {
  let state = createState();
  state = reduceSessionState(state, { type: "setDate", date: "2026-10-24" });
  state = reduceSessionState(state, { type: "setSessionType", sessionType: "cardio" });
  state = reduceSessionState(state, { type: "setDurationMinutes", value: "45" });
  state = reduceSessionState(state, { type: "setSleepHours", value: "7.5" });
  state = reduceSessionState(state, { type: "setNotes", value: "felt strong" });

  assert.equal(state.draft.date, "2026-10-24");
  assert.equal(state.draft.sessionType, "cardio");
  assert.equal(state.draft.durationMinutes, "45");
  assert.equal(state.draft.sleepHours, "7.5");
  assert.equal(state.draft.notes, "felt strong");

  // Repeating the same value is a reference-stable no-op.
  const before = state;
  state = reduceSessionState(state, { type: "setNotes", value: "felt strong" });
  assert.equal(state, before);
});

test("adds, renames, reconfigures, and removes exercises", () => {
  let state = createState();
  state = reduceSessionState(state, { type: "addExercise" });

  assert.equal(state.draft.exercises.length, 2);
  const added = state.draft.exercises[1];
  assert.equal(added.name, "");
  assert.equal(added.restSeconds, DEFAULT_REST_SECONDS);
  assert.equal(added.sets.length, 1);

  state = reduceSessionState(state, {
    type: "setExerciseName",
    exerciseKey: added.key,
    name: "bench_press",
  });
  assert.equal(state.draft.exercises[1].name, "bench_press");

  state = reduceSessionState(state, {
    type: "setExerciseRestSeconds",
    exerciseKey: added.key,
    restSeconds: 120,
  });
  assert.equal(state.draft.exercises[1].restSeconds, 120);

  const unknownKey = reduceSessionState(state, {
    type: "setExerciseName",
    exerciseKey: 999,
    name: "nope",
  });
  assert.equal(unknownKey, state, "unknown exercise keys are ignored");
  assert.equal(
    reduceSessionState(state, {
      type: "setExerciseRestSeconds",
      exerciseKey: added.key,
      restSeconds: -5,
    }),
    state,
    "negative rest is rejected",
  );

  state = reduceSessionState(state, { type: "removeExercise", exerciseKey: added.key });
  assert.equal(state.draft.exercises.length, 1);

  // The session always keeps one exercise.
  const lastExercise = reduceSessionState(state, { type: "removeExercise", exerciseKey: 1 });
  assert.equal(lastExercise, state);
  assert.equal(lastExercise.draft.exercises.length, 1);
});

test("adds, edits, and removes sets while keeping one set per exercise", () => {
  let state = createState();

  const lastSet = reduceSessionState(state, { type: "removeSet", exerciseKey: 1, setKey: 2 });
  assert.equal(lastSet, state, "the only set of an exercise cannot be removed");

  state = reduceSessionState(state, { type: "addSet", exerciseKey: 1 });
  assert.equal(state.draft.exercises[0].sets.length, 2);
  const added = state.draft.exercises[0].sets[1];
  assert.deepEqual(added, { key: 3, reps: "", weight: "", rpe: "", done: false });

  for (const [field, value] of [
    ["reps", "5"],
    ["weight", "100"],
    ["rpe", "8"],
  ] as const) {
    state = reduceSessionState(state, {
      type: "setSetField",
      exerciseKey: 1,
      setKey: added.key,
      field,
      value,
    });
  }
  assert.deepEqual(state.draft.exercises[0].sets[1], {
    key: 3,
    reps: "5",
    weight: "100",
    rpe: "8",
    done: false,
  });

  const wrongExercise = reduceSessionState(state, {
    type: "setSetField",
    exerciseKey: 2,
    setKey: added.key,
    field: "reps",
    value: "1",
  });
  assert.equal(wrongExercise, state, "a set is only reachable through its exercise");

  state = reduceSessionState(state, { type: "removeSet", exerciseKey: 1, setKey: added.key });
  assert.equal(state.draft.exercises[0].sets.length, 1);

  const unknownSet = reduceSessionState(state, {
    type: "removeSet",
    exerciseKey: 1,
    setKey: 404,
  });
  assert.equal(unknownSet, state);
});

test("adds, edits, and removes pain reports", () => {
  let state = createState();
  state = reduceSessionState(state, { type: "addPain" });
  assert.deepEqual(state.draft.pain, [{ key: 3, area: "", level: "" }]);

  state = reduceSessionState(state, {
    type: "setPainField",
    painKey: 3,
    field: "area",
    value: "lower_back",
  });
  state = reduceSessionState(state, {
    type: "setPainField",
    painKey: 3,
    field: "level",
    value: "2",
  });
  assert.deepEqual(state.draft.pain, [{ key: 3, area: "lower_back", level: "2" }]);

  const before = state;
  assert.equal(
    reduceSessionState(state, {
      type: "setPainField",
      painKey: 3,
      field: "area",
      value: "lower_back",
    }),
    before,
    "repeating a pain value is a no-op",
  );
  assert.equal(
    reduceSessionState(state, {
      type: "setPainField",
      painKey: 99,
      field: "area",
      value: "x",
    }),
    before,
    "unknown pain keys are ignored",
  );

  state = reduceSessionState(state, { type: "removePain", painKey: 3 });
  assert.deepEqual(state.draft.pain, []);
  assert.equal(reduceSessionState(state, { type: "removePain", painKey: 3 }), state);
});

test("toggles set done only for a started session", () => {
  const untimed = createState();
  assert.equal(
    reduceSessionState(untimed, { type: "toggleSetDone", exerciseKey: 1, setKey: 2, nowMs: 3_000 }),
    untimed,
    "an untimed draft has no meaningful done state",
  );

  let state: SessionState = createState();
  const timed: SessionState = {
    ...state,
    draft: { ...state.draft, timing: timing() },
  };
  state = reduceSessionState(timed, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 3_000,
  });
  assert.equal(state.draft.exercises[0].sets[0].done, true);

  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 4_000,
  });
  assert.equal(state.draft.exercises[0].sets[0].done, false);

  assert.equal(
    reduceSessionState(state, {
      type: "toggleSetDone",
      exerciseKey: 1,
      setKey: 999,
      nowMs: 5_000,
    }),
    state,
    "unknown set keys are ignored",
  );
});

test("formats the injected local calendar date as YYYY-MM-DD", () => {
  // Constructed in local time, so the assertion is timezone-independent.
  assert.equal(todayLocalDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(todayLocalDate(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
  assert.equal(todayLocalDate(new Date(2027, 8, 9, 12, 0)), "2027-09-09");
});

test("reducer transitions never mutate their input state", () => {
  const state = createState();
  const snapshot = structuredClone(state);

  reduceSessionState(state, { type: "addExercise" });
  reduceSessionState(state, { type: "addSet", exerciseKey: 1 });
  reduceSessionState(state, { type: "setExerciseName", exerciseKey: 1, name: "squat" });
  reduceSessionState(state, { type: "setSetField", exerciseKey: 1, setKey: 2, field: "reps", value: "5" });
  reduceSessionState(state, { type: "addPain" });
  reduceSessionState(state, {
    type: "setPainField",
    painKey: 3,
    field: "area",
    value: "knee",
  });
  reduceSessionState(state, { type: "removeExercise", exerciseKey: 1 });

  assert.deepEqual(state, snapshot);
});
