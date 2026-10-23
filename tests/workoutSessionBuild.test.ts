import assert from "node:assert/strict";
import { test } from "node:test";

import { CURRENT_SCHEMA_VERSION } from "@agent-fit-trace/core";
import {
  DRAFT_PLACEHOLDER_ID,
  buildWorkoutRecord,
  createSessionDraft,
  createSessionRuntime,
  reduceSessionState,
  toSaveInput,
  validateSessionDraft,
} from "../packages/fit-trace-workout-session/src/index.ts";
import type {
  DraftExercise,
  DraftPain,
  DraftSet,
  SessionDraft,
  SessionState,
  SessionTiming,
} from "../packages/fit-trace-workout-session/src/index.ts";

const DATE = "2026-10-23";

function makeSet(overrides: Partial<DraftSet> = {}): DraftSet {
  return { key: 10, reps: "", weight: "", rpe: "", done: false, prefilled: false, ...overrides };
}

function makeExercise(
  key: number,
  sets: DraftSet[],
  overrides: Partial<DraftExercise> = {},
): DraftExercise {
  return { key, name: "squat", restSeconds: 90, sets, ...overrides };
}

function makePain(key: number, overrides: Partial<DraftPain> = {}): DraftPain {
  return { key, area: "", level: "", ...overrides };
}

function untimedDraft(overrides: Partial<SessionDraft> = {}): SessionDraft {
  return { ...createSessionDraft(DATE), ...overrides };
}

function activeTiming(overrides: Partial<SessionTiming> = {}): SessionTiming {
  return {
    startedAtMs: 0,
    endedAtMs: null,
    pausedAtMs: null,
    pausedTotalMs: 0,
    lastActiveAtMs: 0,
    ...overrides,
  };
}

/** A draft the core validator accepts. */
function validDraft(): SessionDraft {
  return untimedDraft({
    exercises: [makeExercise(1, [makeSet({ key: 2, reps: "5", weight: "80", rpe: "8" })])],
  });
}

/** Active timed state started at 1s. */
function startedState(nowMs = 1_000): SessionState {
  return reduceSessionState(
    { draft: createSessionDraft(DATE), runtime: createSessionRuntime() },
    { type: "startSession", nowMs },
  );
}

test("drops fully blank sets and exercises but keeps partially filled sets", () => {
  const draft = untimedDraft({
    exercises: [
      makeExercise(1, [
        makeSet({ key: 2 }),
        makeSet({ key: 3, reps: "5" }),
        makeSet({ key: 4, weight: "80" }),
        makeSet({ key: 5, rpe: "8" }),
        makeSet({ key: 6, reps: " ", weight: " ", rpe: " " }),
      ]),
      makeExercise(7, [makeSet({ key: 8 }), makeSet({ key: 9, reps: "" })], { name: "" }),
    ],
  });

  const record = buildWorkoutRecord(draft, 0);

  assert.equal(record.exercises.length, 1, "the all-blank exercise is dropped");
  const sets = record.exercises[0].sets;
  assert.equal(sets.length, 3, "only all-blank sets are dropped");

  assert.equal(sets[0].reps, 5);
  assert.equal(sets[0].weight, undefined);
  assert.equal(sets[0].rpe, undefined);

  assert.ok(Number.isNaN(sets[1].reps), "a missing rep count stays invalid, not 0");
  assert.equal(sets[1].weight, 80);

  assert.ok(Number.isNaN(sets[2].reps));
  assert.equal(sets[2].rpe, 8);
});

test("partially filled sets reach the core and report their field issues", () => {
  const draft = untimedDraft({
    exercises: [
      makeExercise(1, [
        makeSet({ key: 2, weight: "80" }), // reps missing
        makeSet({ key: 3, reps: "abc" }), // unparsable reps
        makeSet({ key: 4, reps: "5", weight: "abc" }), // unparsable weight
        makeSet({ key: 5, reps: "5", rpe: "abc" }), // unparsable rpe
      ]),
    ],
  });

  const result = validateSessionDraft(draft, 0);
  assert.equal(result.ok, false);
  if (result.ok) return;

  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("INVALID_REPS"));
  assert.ok(codes.includes("INVALID_WEIGHT"));
  assert.ok(codes.includes("INVALID_RPE"));
});

test("an all-blank draft builds empty exercises and reports MISSING_EXERCISES", () => {
  const draft = untimedDraft({
    exercises: [makeExercise(1, [makeSet({ key: 2 })])],
  });

  const record = buildWorkoutRecord(draft, 0);
  assert.deepEqual(record.exercises, []);

  const result = validateSessionDraft(draft, 0);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_EXERCISES"));
});

test("a blank exercise name with usable sets reports MISSING_EXERCISE_NAME", () => {
  const draft = untimedDraft({
    exercises: [makeExercise(1, [makeSet({ key: 2, reps: "5" })], { name: "" })],
  });

  const result = validateSessionDraft(draft, 0);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_EXERCISE_NAME"));
});

test("derives timed duration from elapsed with a one-minute floor", () => {
  const draft = untimedDraft({ timing: activeTiming({ startedAtMs: 1_000 }) });

  assert.equal(buildWorkoutRecord(draft, 1_000).duration_minutes, 1, "just started");
  assert.equal(buildWorkoutRecord(draft, 31_000).duration_minutes, 1, "30 seconds");
  assert.equal(buildWorkoutRecord(draft, 90_999).duration_minutes, 1, "89.999 seconds");
  assert.equal(buildWorkoutRecord(draft, 91_000).duration_minutes, 2, "90 seconds rounds to 2");
  assert.equal(buildWorkoutRecord(draft, 151_000).duration_minutes, 3, "150 seconds rounds to 3");
});

test("timed duration freezes at pause/finish and ignores the manual field", () => {
  const paused = untimedDraft({ timing: activeTiming({ pausedAtMs: 61_000 }) });
  assert.equal(buildWorkoutRecord(paused, 999_999).duration_minutes, 1);

  const finished = untimedDraft({ timing: activeTiming({ endedAtMs: 121_000 }) });
  assert.equal(buildWorkoutRecord(finished, 999_999).duration_minutes, 2);

  const pausedTotal = untimedDraft({ timing: activeTiming({ pausedTotalMs: 300_000 }) });
  assert.equal(buildWorkoutRecord(pausedTotal, 600_000).duration_minutes, 5);

  const manualIgnored = untimedDraft({
    timing: activeTiming({ endedAtMs: 61_000 }),
    durationMinutes: "45",
  });
  assert.equal(buildWorkoutRecord(manualIgnored, 0).duration_minutes, 1);
});

test("untimed duration uses the manual field only when non-blank", () => {
  assert.equal(
    buildWorkoutRecord(untimedDraft({ durationMinutes: "45" }), 999_999).duration_minutes,
    45,
  );
  assert.equal(
    "duration_minutes" in buildWorkoutRecord(untimedDraft({ durationMinutes: "  " }), 0),
    false,
  );
  assert.equal(
    buildWorkoutRecord(untimedDraft({ durationMinutes: "0" }), 0).duration_minutes,
    0,
    "a manually entered 0 is passed through for the core to reject",
  );
});

test("maps sleep, trimmed notes and multiple pain reports", () => {
  const draft = untimedDraft({
    exercises: [makeExercise(1, [makeSet({ key: 2, reps: "5" })])],
    sleepHours: "7.5",
    notes: "  felt strong  ",
    pain: [
      makePain(10, { area: " knee ", level: "3" }),
      makePain(11),
      makePain(12, { level: "2" }),
      makePain(13, { area: "lower back" }),
    ],
  });

  const record = buildWorkoutRecord(draft, 0);
  assert.equal(record.sleep_hours, 7.5);
  assert.equal(record.notes, "felt strong");
  assert.deepEqual(record.pain, [
    { area: "knee", level: 3 },
    { level: 2 },
    { area: "lower back" },
  ]);
});

test("omits blank optional fields", () => {
  const record = buildWorkoutRecord(
    untimedDraft({
      exercises: [makeExercise(1, [makeSet({ key: 2, reps: "5" })])],
      sleepHours: " ",
      notes: "   ",
      pain: [makePain(10), makePain(11, { area: "  ", level: " " })],
    }),
    0,
  );

  assert.equal("sleep_hours" in record, false);
  assert.equal("notes" in record, false);
  assert.equal("pain" in record, false);
});

test("builds a placeholder-id record and strips it for the repository", () => {
  const draft = validDraft();

  const built = buildWorkoutRecord(draft, 0);
  assert.equal(built.id, DRAFT_PLACEHOLDER_ID);
  assert.equal(built.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(built.date, DATE);
  assert.equal(built.session_type, "strength");

  const result = validateSessionDraft(draft, 0);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.id, DRAFT_PLACEHOLDER_ID);

  const saveInput = toSaveInput(result.record);
  assert.equal(saveInput.id, "");
  assert.deepEqual({ ...saveInput, id: DRAFT_PLACEHOLDER_ID }, result.record);
  assert.notEqual(saveInput, result.record);
  assert.equal(result.record.id, DRAFT_PLACEHOLDER_ID, "toSaveInput does not mutate its input");
});

test("passes accepted-but-suspicious values through as warnings", () => {
  const draft = untimedDraft({
    exercises: [
      makeExercise(1, [
        makeSet({ key: 2, reps: "5", weight: "0" }), // zero weight with reps
        makeSet({ key: 3, reps: "0", weight: "20" }), // zero reps
      ]),
    ],
  });

  const result = validateSessionDraft(draft, 0);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("ZERO_WEIGHT"));
  assert.ok(codes.includes("ZERO_REPS"));
});

test("never leaks draft-only fields into the core record", () => {
  const draft = untimedDraft({
    durationMinutes: "45",
    sleepHours: "7.5",
    notes: "note",
    pain: [makePain(10, { area: "knee", level: "3" })],
    exercises: [
      makeExercise(1, [makeSet({ key: 2, reps: "5", weight: "80", rpe: "8", done: true })]),
    ],
  });

  const record = buildWorkoutRecord(draft, 0);
  assert.deepEqual(Object.keys(record).sort(), [
    "date",
    "duration_minutes",
    "exercises",
    "id",
    "notes",
    "pain",
    "schema_version",
    "session_type",
    "sleep_hours",
  ]);
  assert.deepEqual(Object.keys(record.exercises[0]).sort(), ["name", "sets"]);
  assert.deepEqual(Object.keys(record.exercises[0].sets[0]).sort(), ["reps", "rpe", "weight"]);

  const serialized = JSON.stringify(record);
  for (const forbidden of ["restSeconds", "done", "prefilled", "timing", "key"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not leak`);
  }
});

test("invalid content is reported by the core validator, not pre-thrown", () => {
  const draft = untimedDraft({
    date: "",
    exercises: [makeExercise(1, [makeSet({ key: 2, reps: "5" })])],
  });

  const result = validateSessionDraft(draft, 0);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.code === "INVALID_DATE"));
});

test("a timed save excludes the auto-prefilled unchecked next set", () => {
  let state = startedState(1_000);
  state = reduceSessionState(state, {
    type: "setSetField",
    exerciseKey: 1,
    setKey: 2,
    field: "weight",
    value: "100",
  });
  state = reduceSessionState(state, {
    type: "setSetField",
    exerciseKey: 1,
    setKey: 2,
    field: "reps",
    value: "5",
  });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 61_000,
  });

  const prefilled = state.draft.exercises[0].sets[1];
  assert.equal(prefilled.prefilled, true);
  assert.equal(prefilled.done, false);

  state = reduceSessionState(state, { type: "finishSession", nowMs: 120_000 });

  const record = buildWorkoutRecord(state.draft, 120_000);
  assert.equal(
    record.exercises[0].sets.length,
    1,
    "the unchecked suggestion is not saved as a performed set",
  );
  assert.deepEqual(record.exercises[0].sets[0], { reps: 5, weight: 100 });
  assert.equal(record.duration_minutes, 2);
});

test("a checked prefilled set counts as performed content", () => {
  let state = startedState(1_000);
  for (const [field, value] of [
    ["weight", "100"],
    ["reps", "5"],
  ] as const) {
    state = reduceSessionState(state, {
      type: "setSetField",
      exerciseKey: 1,
      setKey: 2,
      field,
      value,
    });
  }
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 61_000,
  });
  // Check the prefilled suggestion: it becomes performed and a new trailing
  // suggestion is created.
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 3,
    nowMs: 120_000,
  });

  const record = buildWorkoutRecord(state.draft, 120_000);
  assert.equal(record.exercises[0].sets.length, 2, "only the trailing suggestion is dropped");
  assert.deepEqual(record.exercises[0].sets, [
    { reps: 5, weight: 100 },
    { reps: 5, weight: 100 },
  ]);
});

test("an edited unchecked prefilled suggestion is included in a timed save", () => {
  let state = startedState(1_000);
  for (const [field, value] of [
    ["weight", "100"],
    ["reps", "5"],
  ] as const) {
    state = reduceSessionState(state, {
      type: "setSetField",
      exerciseKey: 1,
      setKey: 2,
      field,
      value,
    });
  }
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 61_000,
  });

  // Edit the suggestion (which clears `prefilled`) but never check it.
  state = reduceSessionState(state, {
    type: "setSetField",
    exerciseKey: 1,
    setKey: 3,
    field: "reps",
    value: "6",
  });

  const record = buildWorkoutRecord(state.draft, 120_000);
  assert.equal(record.exercises[0].sets.length, 2);
  assert.deepEqual(record.exercises[0].sets[1], { reps: 6, weight: 100 });
});

test("manually added unchecked sets stay content-based in a timed save", () => {
  let state = startedState(1_000);
  state = reduceSessionState(state, { type: "addSet", exerciseKey: 1 });
  state = reduceSessionState(state, {
    type: "setSetField",
    exerciseKey: 1,
    setKey: 3,
    field: "reps",
    value: "8",
  });

  const record = buildWorkoutRecord(state.draft, 60_000);
  assert.equal(record.exercises[0].sets.length, 1, "a manually added set is never treated as a suggestion");
  assert.deepEqual(record.exercises[0].sets[0], { reps: 8 });
});

test("untimed builds ignore the prefilled marker", () => {
  const draft = untimedDraft({
    exercises: [makeExercise(1, [makeSet({ key: 2, reps: "5", weight: "80", prefilled: true })])],
  });

  const record = buildWorkoutRecord(draft, 0);
  assert.equal(record.exercises[0].sets.length, 1);
  assert.deepEqual(record.exercises[0].sets[0], { reps: 5, weight: 80 });
});

test("checking then unchecking a prefilled set keeps its content in a timed save", () => {
  let state = startedState(1_000);
  for (const [field, value] of [
    ["weight", "100"],
    ["reps", "5"],
  ] as const) {
    state = reduceSessionState(state, {
      type: "setSetField",
      exerciseKey: 1,
      setKey: 2,
      field,
      value,
    });
  }

  // Check the real set, then the appended suggestion: checking promotes the
  // suggestion to content and appends a fresh trailing suggestion.
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 2,
    nowMs: 61_000,
  });
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 3,
    nowMs: 120_000,
  });

  const promoted = state.draft.exercises[0].sets[1];
  assert.equal(promoted.done, true);
  assert.equal(promoted.prefilled, false, "checking clears the suggestion marker");

  // Unchecking must not delete content the user already performed.
  state = reduceSessionState(state, {
    type: "toggleSetDone",
    exerciseKey: 1,
    setKey: 3,
    nowMs: 180_000,
  });

  const record = buildWorkoutRecord(state.draft, 180_000);
  assert.equal(record.exercises[0].sets.length, 2, "only the fresh trailing suggestion is dropped");
  assert.deepEqual(record.exercises[0].sets, [
    { reps: 5, weight: 100 },
    { reps: 5, weight: 100 },
  ]);
});
