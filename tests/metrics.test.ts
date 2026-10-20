import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ValidationError,
  analyzeProgress,
  detectFlags,
  exerciseTrends,
  flattenSets,
  summarizeMetrics,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { loadFixture } from "./helpers.ts";

async function history(): Promise<WorkoutRecord[]> {
  const raw = await loadFixture<unknown[]>("history-strength.json");
  return raw.map((entry) => validateWorkoutRecord(entry).record);
}

/** Build one validated strength record with a single 5-rep set per exercise. */
function strengthRecord(
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

test("computes volume, reps, sets, and average RPE from a fixed fixture", async () => {
  const metrics = summarizeMetrics(await history());

  assert.equal(metrics.sessions, 3);
  assert.equal(metrics.total_sets, 18);
  assert.equal(metrics.total_reps, 90);
  // (80*15 + 100*15) + (82.5*15 + 102.5*15) + (85*15 + 105*15) = 2700 + 2775 + 2850
  assert.equal(metrics.volume_kg, 8325);
  assert.equal(metrics.avg_rpe, 8);
});

test("computes training intervals from distinct session dates", async () => {
  const metrics = summarizeMetrics(await history());
  assert.equal(metrics.avg_rest_days, 3.5);
  assert.equal(metrics.max_gap_days, 4);
});

test("computes per-exercise estimated-1RM trends with canonical catalog labels", async () => {
  const trends = exerciseTrends(await history());
  assert.deepEqual(trends.map((trend) => trend.exercise), [
    "Barbell Bench Press - Medium Grip",
    "Barbell Squat",
  ]);

  const bench = trends.find((trend) => trend.exercise === "Barbell Bench Press - Medium Grip");
  assert.ok(bench);
  assert.equal(bench.first, 93.33);
  assert.equal(bench.last, 99.17);
  assert.equal(bench.delta_pct, 6.26);
  assert.equal(bench.direction, "up");
  // The fixture records `bench_press`; the trend label is the resolved canonical name.
  assert.ok(!trends.some((trend) => trend.exercise === "bench_press"));
});

test("merges raw names that resolve to the same catalog entry into one trend", () => {
  const trends = exerciseTrends([
    strengthRecord("alias-1", "2026-09-01", [{ name: "bench_press", weight: 80 }]),
    strengthRecord("alias-2", "2026-09-04", [{ name: "Bench Press", weight: 82.5 }]),
    strengthRecord("alias-3", "2026-09-08", [
      { name: "Barbell Bench Press - Medium Grip", weight: 85 },
    ]),
  ]);

  assert.equal(trends.length, 1);
  const bench = trends[0];
  assert.equal(bench.exercise, "Barbell Bench Press - Medium Grip");
  assert.equal(bench.sessions_compared, 3);
  assert.equal(bench.first, 93.33);
  assert.equal(bench.last, 99.17);
  assert.equal(bench.direction, "up");
});

test("keeps the best estimated 1RM per session when aliases share a date", () => {
  const trends = exerciseTrends([
    strengthRecord("same-1", "2026-09-01", [
      { name: "bench_press", weight: 80 },
      { name: "Bench Press", weight: 85 },
    ]),
    strengthRecord("same-2", "2026-09-04", [{ name: "Bench Press", weight: 90 }]),
  ]);

  assert.equal(trends.length, 1);
  assert.equal(trends[0].exercise, "Barbell Bench Press - Medium Grip");
  assert.equal(trends[0].sessions_compared, 2);
  assert.equal(trends[0].first, 99.17);
  assert.equal(trends[0].last, 105);
});

test("keeps unresolved custom names separate, raw-labelled, and sorted by label", () => {
  const trends = exerciseTrends([
    strengthRecord("custom-1", "2026-09-01", [
      { name: "Zercher Carry", weight: 40 },
      { name: "Sled Drag", weight: 20 },
      { name: "squat", weight: 100 },
    ]),
    strengthRecord("custom-2", "2026-09-04", [
      { name: "Zercher Carry", weight: 45 },
      { name: "Sled Drag", weight: 25 },
      { name: "squat", weight: 105 },
    ]),
  ]);

  assert.deepEqual(
    trends.map((trend) => trend.exercise),
    ["Barbell Squat", "Sled Drag", "Zercher Carry"],
  );
  // Resolved names use canonical identity; unknown names never merge with each other.
  const zercher = trends.find((trend) => trend.exercise === "Zercher Carry");
  assert.equal(zercher?.sessions_compared, 2);
  const sled = trends.find((trend) => trend.exercise === "Sled Drag");
  assert.equal(sled?.sessions_compared, 2);
});

test("flattens sets deterministically in date order", async () => {
  const flat = flattenSets(await history());
  assert.equal(flat.length, 18);
  assert.equal(flat[0].recordId, "2026-09-01-strength");
  assert.equal(flat[17].recordId, "2026-09-08-strength");
  assert.equal(flat[0].est1rm, 93.33);
});

test("returns zeroed metrics for empty history", () => {
  const metrics = summarizeMetrics([]);
  assert.equal(metrics.sessions, 0);
  assert.equal(metrics.volume_kg, 0);
  assert.equal(metrics.avg_rpe, null);
  assert.equal(metrics.avg_rest_days, 0);
  assert.deepEqual(detectFlags([]), []);
});

test("rejects an invalid analysis filter date with a readable error", async () => {
  const records = await history();
  assert.throws(() => analyzeProgress(records, { from: "not-a-date" }), ValidationError);
});

test("rejects an inverted analysis filter range", async () => {
  const records = await history();
  assert.throws(
    () => analyzeProgress(records, { from: "2026-09-10", to: "2026-09-01" }),
    ValidationError,
  );
});
