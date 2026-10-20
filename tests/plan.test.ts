import assert from "node:assert/strict";
import { test } from "node:test";

import { generateNextPlan, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { loadFixture } from "./helpers.ts";

async function history(rpe: number): Promise<WorkoutRecord[]> {
  const raw = await loadFixture<Record<string, unknown>[]>("history-strength.json");
  return raw.map((entry) => {
    const clone = structuredClone(entry);
    const exercises = clone.exercises as Array<{ sets: Array<{ rpe?: number }> }>;
    for (const exercise of exercises) {
      for (const set of exercise.sets) set.rpe = rpe;
    }
    return validateWorkoutRecord(clone).record;
  });
}

test("empty history returns an import recommendation and stays a draft", () => {
  const draft = generateNextPlan([]);

  assert.equal(draft.is_draft, true);
  assert.equal(draft.requires_confirmation, true);
  assert.equal(draft.recommendations[0].action, "import_history");
  assert.equal(draft.professional_care_prompt, null);
});

test("pain plus extreme RPE yields conservative guidance and a care prompt", async () => {
  const pain = validateWorkoutRecord(await loadFixture("pain-extreme.json")).record;
  const draft = generateNextPlan([pain]);
  const actions = draft.recommendations.map((recommendation) => recommendation.action);

  assert.ok(actions.includes("reduce_or_pause_loading"));
  assert.ok(actions.includes("cap_intensity"));
  assert.ok(draft.professional_care_prompt !== null);
  assert.ok(draft.safety_notes.length >= 2);
  assert.deepEqual(draft.based_on.source_records, ["2026-09-05-pain"]);
});

test("rising trend at moderate RPE yields progressive overload citing evidence", async () => {
  const draft = generateNextPlan(await history(6));
  const overload = draft.recommendations.find(
    (recommendation) => recommendation.action === "progressive_overload",
  );

  assert.ok(overload);
  assert.match(overload.reason, /Estimated 1RM/);
  // Plan text/evidence reuse the analysis trend identity, i.e. the resolved
  // canonical catalog name rather than the raw `bench_press` spelling.
  assert.equal(overload.evidence.exercise, "Barbell Bench Press - Medium Grip");
});

test("high average RPE suppresses progression", async () => {
  const draft = generateNextPlan(await history(8));
  const actions = draft.recommendations.map((recommendation) => recommendation.action);

  assert.ok(actions.includes("maintain"));
  assert.ok(!actions.includes("progressive_overload"));
});

test("surfaces caller constraints", async () => {
  const draft = generateNextPlan(await history(8), {
    goal: "hypertrophy",
    days_available: 3,
    equipment: ["barbell"],
    constraints: ["no overhead pressing"],
  });
  const actions = draft.recommendations.map((recommendation) => recommendation.action);

  assert.equal(draft.goal, "hypertrophy");
  assert.ok(actions.includes("schedule"));
  assert.ok(actions.includes("equipment"));
  assert.ok(draft.safety_notes.some((note) => note.includes("no overhead pressing")));
});
