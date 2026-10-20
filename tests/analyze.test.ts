import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ValidationError,
  analyzeProgress,
  filterRecords,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { loadFixture } from "./helpers.ts";

/** Record ids of `history-strength.json`, in ascending date order. */
const HISTORY_IDS = [
  "2026-09-01-strength",
  "2026-09-04-strength",
  "2026-09-08-strength",
];

async function history(): Promise<WorkoutRecord[]> {
  const raw = await loadFixture<unknown[]>("history-strength.json");
  return raw.map((entry) => validateWorkoutRecord(entry).record);
}

/** Build one validated strength record with a single 5-rep set per exercise. */
function record(
  id: string,
  date: string,
  exercises: Array<{ name: string; weight: number }>,
): WorkoutRecord {
  return validateWorkoutRecord({
    id,
    schema_version: 1,
    date,
    session_type: "strength",
    exercises: exercises.map(({ name, weight }) => ({
      name,
      sets: [{ weight, reps: 5, rpe: 8 }],
    })),
  }).record;
}

test("matches exercise filters by raw name ignoring case", async () => {
  const records = await history();
  for (const wanted of ["SQUAT", "sQuAt", "bEnCh_PrEsS"]) {
    assert.deepEqual(
      filterRecords(records, { exercises: [wanted] }).map((entry) => entry.id),
      HISTORY_IDS,
      `filter ${JSON.stringify(wanted)}`,
    );
  }
});

test("matches exercise filters through catalog aliases, canonical names, and separators", async () => {
  const records = await history();
  // The fixture stores `bench_press`; every spelling below resolves to the same
  // `barbell_bench_press` catalog entry.
  for (const wanted of [
    "Bench Press",
    "Barbell Bench Press",
    "Barbell Bench Press - Medium Grip",
    "barbell_bench_press",
  ]) {
    assert.deepEqual(
      filterRecords(records, { exercises: [wanted] }).map((entry) => entry.id),
      HISTORY_IDS,
      `filter ${JSON.stringify(wanted)}`,
    );
  }
  for (const wanted of ["Squat", "Barbell Squat", "BARBELL_SQUAT"]) {
    assert.deepEqual(
      filterRecords(records, { exercises: [wanted] }).map((entry) => entry.id),
      HISTORY_IDS,
      `filter ${JSON.stringify(wanted)}`,
    );
  }
});

test("matches a canonical stored name by alias and separator variants", () => {
  const records = [record("canonical-1", "2026-09-01", [{ name: "Barbell Squat", weight: 100 }])];

  for (const wanted of ["squat", "Squat", "barbell_squat", "BARBELL-SQUAT"]) {
    assert.equal(
      filterRecords(records, { exercises: [wanted] }).length,
      1,
      `filter ${JSON.stringify(wanted)}`,
    );
  }
  // A different catalog entry must not match.
  assert.equal(filterRecords(records, { exercises: ["front squat"] }).length, 0);
});

test("keeps unresolved custom names raw: case-insensitive text only, no guessing", () => {
  const records = [
    record("custom-1", "2026-09-01", [{ name: "Zercher Carry", weight: 40 }]),
    record("custom-2", "2026-09-04", [{ name: "Sled Drag", weight: 20 }]),
  ];

  assert.deepEqual(
    filterRecords(records, { exercises: ["zercher carry"] }).map((entry) => entry.id),
    ["custom-1"],
  );
  // No catalog entry exists, so separator normalization must not apply.
  assert.deepEqual(filterRecords(records, { exercises: ["zercher_carry"] }), []);
  // A nearby resolved entry must not capture an unresolved custom name.
  assert.deepEqual(filterRecords(records, { exercises: ["Zercher Squat"] }), []);
});

test("matches a record when any of its exercise names matches any wanted value", () => {
  const records = [
    record("mixed-1", "2026-09-01", [
      { name: "bench_press", weight: 80 },
      { name: "squat", weight: 100 },
    ]),
    record("mixed-2", "2026-09-04", [{ name: "deadlift", weight: 120 }]),
  ];

  assert.deepEqual(
    filterRecords(records, { exercises: ["Squat"] }).map((entry) => entry.id),
    ["mixed-1"],
  );
  assert.deepEqual(
    filterRecords(records, { exercises: ["squat", "deadlift"] }).map((entry) => entry.id),
    ["mixed-1", "mixed-2"],
  );
  assert.deepEqual(
    filterRecords(records, { exercises: [] }).map((entry) => entry.id),
    ["mixed-1", "mixed-2"],
  );
});

test("does not match a different catalog entry", async () => {
  const records = await history();
  assert.deepEqual(filterRecords(records, { exercises: ["deadlift"] }), []);
  assert.deepEqual(filterRecords(records, { exercises: ["Barbell Deadlift"] }), []);
});

test("an alias filter selects the same records and analysis as the raw name", async () => {
  const records = await history();
  const byRaw = analyzeProgress(records, { exercises: ["bench_press"] });
  const byAlias = analyzeProgress(records, { exercises: ["Barbell Bench Press"] });

  assert.deepEqual(byAlias, byRaw);
  assert.equal(byAlias.metrics.sessions, 3);
  // The filter selects records, so every exercise in the selected records
  // still contributes a trend; only the identity label is catalog-resolved.
  assert.deepEqual(byAlias.trends.map((trend) => trend.exercise), [
    "Barbell Bench Press - Medium Grip",
    "Barbell Squat",
  ]);
});

test("preserves date-range validation and errors while matching aliases", async () => {
  const records = await history();

  assert.throws(() => filterRecords(records, { from: "not-a-date" }), ValidationError);
  assert.throws(
    () => filterRecords(records, { from: "2026-09-10", to: "2026-09-01" }),
    ValidationError,
  );

  assert.deepEqual(
    filterRecords(records, {
      from: "2026-09-04",
      to: "2026-09-04",
      exercises: ["Bench Press"],
    }).map((entry) => entry.id),
    ["2026-09-04-strength"],
  );
});
