import assert from "node:assert/strict";
import { test } from "node:test";

import { detectFlags, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { loadFixture } from "./helpers.ts";

function record(overrides: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...overrides,
  }).record;
}

test("flags reported pain as critical", async () => {
  const pain = validateWorkoutRecord(await loadFixture("pain-extreme.json")).record;
  const flags = detectFlags([pain]);
  const painFlag = flags.find((flag) => flag.code === "PAIN_REPORTED");

  assert.ok(painFlag);
  assert.equal(painFlag.severity, "critical");
  assert.deepEqual(painFlag.evidence.record_ids, ["2026-09-05-pain"]);
});

test("flags extreme RPE as critical", async () => {
  const pain = validateWorkoutRecord(await loadFixture("pain-extreme.json")).record;
  const extreme = detectFlags([pain]).find((flag) => flag.code === "EXTREME_RPE");

  assert.ok(extreme);
  assert.equal(extreme.severity, "critical");
  assert.equal(extreme.evidence.max_rpe, 10);
  assert.equal(extreme.evidence.set_count, 1);
});

test("flags missing recovery data when no sleep_hours are recorded", async () => {
  const pain = validateWorkoutRecord(await loadFixture("pain-extreme.json")).record;
  const missing = detectFlags([pain]).find((flag) => flag.code === "MISSING_RECOVERY_DATA");
  assert.ok(missing);
  assert.equal(missing.severity, "warning");
});

test("flags insufficient history below the minimum session count", () => {
  const flags = detectFlags([record({ id: "a", date: "2026-09-01", sleep_hours: 7 })]);
  const insufficient = flags.find((flag) => flag.code === "INSUFFICIENT_HISTORY");
  assert.ok(insufficient);
  assert.equal(insufficient.severity, "info");
});

test("flags a volume spike above the threshold", () => {
  const flat = (id: string, date: string, weight: number): WorkoutRecord =>
    record({
      id,
      date,
      sleep_hours: 7,
      exercises: [{ name: "squat", sets: [{ weight, reps: 10, rpe: 7 }] }],
    });

  const flags = detectFlags([
    flat("a", "2026-09-01", 10),
    flat("b", "2026-09-03", 10),
    flat("c", "2026-09-05", 10),
    flat("d", "2026-09-07", 20),
  ]);

  const spike = flags.find((flag) => flag.code === "VOLUME_SPIKE");
  assert.ok(spike);
  assert.equal(spike.evidence.change_pct, 100);
});

test("flags a volume drop below the threshold", () => {
  const flat = (id: string, date: string, weight: number): WorkoutRecord =>
    record({
      id,
      date,
      sleep_hours: 7,
      exercises: [{ name: "squat", sets: [{ weight, reps: 10, rpe: 7 }] }],
    });

  const flags = detectFlags([
    flat("a", "2026-09-01", 20),
    flat("b", "2026-09-03", 20),
    flat("c", "2026-09-05", 20),
    flat("d", "2026-09-07", 10),
  ]);

  assert.ok(flags.find((flag) => flag.code === "VOLUME_DROP"));
});
