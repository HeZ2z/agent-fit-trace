import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeProgress, filterRecords, generateNextPlan, validateWorkoutRecord } from "@agent-fit-trace/core";
import { MemoryStorage, WorkoutStore } from "../.pi/extensions/fit-trace/store.ts";
import { loadFixture } from "./helpers.ts";

test("end-to-end: import -> history -> analyze -> draft plan, without mutating records", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  const raw = await loadFixture<unknown[]>("history-strength.json");

  for (const entry of raw) {
    const { record, warnings } = validateWorkoutRecord(entry);
    assert.deepEqual(warnings, []);
    await store.import(record);
  }

  const history = await store.query({});
  assert.equal(history.total, 3);

  const snapshot = structuredClone(await store.all());

  const analysis = analyzeProgress(history.records, {});
  assert.equal(analysis.metrics.sessions, 3);
  assert.equal(analysis.metrics.volume_kg, 8325);
  assert.equal(analysis.metrics.avg_rpe, 8);
  assert.deepEqual(analysis.source_records, [
    "2026-09-01-strength",
    "2026-09-04-strength",
    "2026-09-08-strength",
  ]);
  // Trends are grouped and labelled through the resolved catalog identity.
  assert.deepEqual(analysis.trends.map((trend) => trend.exercise), [
    "Barbell Bench Press - Medium Grip",
    "Barbell Squat",
  ]);

  const draft = generateNextPlan(history.records, { goal: "strength" });
  assert.equal(draft.is_draft, true);
  assert.equal(draft.requires_confirmation, true);
  assert.equal(draft.based_on.sessions, 3);
  assert.ok(draft.recommendations.length > 0);
  for (const recommendation of draft.recommendations) {
    assert.ok(recommendation.reason.length > 0, "every recommendation must carry a reason");
  }

  assert.deepEqual(await store.all(), snapshot, "plan generation must not modify stored records");
});

test("end-to-end: alias spellings merge into one trend while stored names stay raw", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  const entries = [
    {
      id: "2026-09-01-alias",
      schema_version: 1,
      date: "2026-09-01",
      session_type: "strength",
      exercises: [
        { name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 8 }] },
        { name: "Zercher Carry", sets: [{ weight: 40, reps: 5, rpe: 8 }] },
      ],
    },
    {
      id: "2026-09-04-alias",
      schema_version: 1,
      date: "2026-09-04",
      session_type: "strength",
      exercises: [
        { name: "Bench Press", sets: [{ weight: 82.5, reps: 5, rpe: 8 }] },
        { name: "Zercher Carry", sets: [{ weight: 45, reps: 5, rpe: 8 }] },
      ],
    },
    {
      id: "2026-09-08-alias",
      schema_version: 1,
      date: "2026-09-08",
      session_type: "strength",
      exercises: [{ name: "barbell_bench_press", sets: [{ weight: 85, reps: 5, rpe: 8 }] }],
    },
  ];

  for (const entry of entries) {
    const { record, warnings } = validateWorkoutRecord(entry);
    assert.deepEqual(warnings, []);
    await store.import(record);
  }

  const stored = await store.query({});
  // Stored records are never rewritten: the raw spellings remain on disk.
  assert.deepEqual(
    stored.records.map((record) => record.exercises[0].name),
    ["bench_press", "Bench Press", "barbell_bench_press"],
  );

  const analysis = analyzeProgress(stored.records, {});
  assert.deepEqual(analysis.trends.map((trend) => trend.exercise), [
    "Barbell Bench Press - Medium Grip",
    "Zercher Carry",
  ]);
  const bench = analysis.trends.find(
    (trend) => trend.exercise === "Barbell Bench Press - Medium Grip",
  );
  assert.equal(bench?.sessions_compared, 3);
  // The unresolved custom name keeps its raw label and own trend.
  const custom = analysis.trends.find((trend) => trend.exercise === "Zercher Carry");
  assert.equal(custom?.sessions_compared, 2);

  // Filtering by any alias/canonical spelling selects the same records.
  assert.deepEqual(
    filterRecords(stored.records, { exercises: ["Bench Press"] }).map((record) => record.id),
    ["2026-09-01-alias", "2026-09-04-alias", "2026-09-08-alias"],
  );
});

test("the same fixture always produces the same analysis (determinism)", async () => {
  const raw = await loadFixture<unknown[]>("history-strength.json");
  const records = raw.map((entry) => validateWorkoutRecord(entry).record);

  const first = analyzeProgress(records, {});
  const second = analyzeProgress(records, {});

  assert.deepEqual(first, second);
});
