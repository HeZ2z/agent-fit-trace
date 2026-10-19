import assert from "node:assert/strict";
import { test } from "node:test";

import { CURRENT_SCHEMA_VERSION } from "@pi-fit-trace/core";
import type { Recommendation, WorkoutRecord } from "@pi-fit-trace/core";
import {
  buildPlanModel,
  buildRecommendationView,
  localizeSafetyNotes,
} from "../mobile/src/data/planModel.ts";

/**
 * Pure coverage for the Plan screen model. The screen, expo-sqlite repository
 * and React are intentionally not imported: the model has no React, expo,
 * storage, DOM or clock dependency, so the root `node:test` suite stays
 * runtime-free.
 */

function record(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "wkt_2026-09-01_strength_00000001",
    schema_version: CURRENT_SCHEMA_VERSION,
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "Back squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

test("empty history yields an import draft, low confidence and no application state", () => {
  const model = buildPlanModel([], "zh");

  assert.equal(model.isEmpty, true);
  assert.deepEqual(model.summary, {
    sessions: 0,
    from: null,
    to: null,
    confidence: "low",
  });
  assert.equal(model.isDraft, true);
  assert.equal(model.requiresConfirmation, true);
  assert.equal(model.applied, false);
  assert.equal(model.carePrompt, null);
  assert.deepEqual(model.safetyNotes, []);

  const [importRecommendation] = model.recommendations;
  assert.equal(importRecommendation?.code, "import_history");
  assert.equal(importRecommendation?.action, "导入历史");
  assert.equal(importRecommendation?.detail, "在生成计划前至少导入一条训练记录。");
});

test("short history stays a low-confidence draft with localized safety copy", () => {
  const model = buildPlanModel([record()], "zh");

  assert.equal(model.isEmpty, false);
  assert.equal(model.summary.sessions, 1);
  assert.equal(model.summary.confidence, "low");
  assert.ok(
    model.safetyNotes.some((note) => note.includes("低置信度")),
    "the core's low-confidence note is localized",
  );

  const maintain = model.recommendations.find((entry) => entry.code === "maintain");
  assert.equal(maintain?.action, "维持");
  assert.match(maintain?.reason ?? "", /没有动作拥有足够的负重历史/);
});

test("a full history exposes standard confidence and localized recommendations", () => {
  const records = [
    record({
      id: "rising-1",
      date: "2026-09-01",
      sleep_hours: 8,
      exercises: [{ name: "Bench press", sets: [{ weight: 100, reps: 5, rpe: 6 }] }],
    }),
    record({
      id: "rising-2",
      date: "2026-09-04",
      sleep_hours: 8,
      exercises: [{ name: "Bench press", sets: [{ weight: 105, reps: 5, rpe: 6 }] }],
    }),
    record({
      id: "rising-3",
      date: "2026-09-08",
      sleep_hours: 8,
      exercises: [{ name: "Bench press", sets: [{ weight: 110, reps: 5, rpe: 6 }] }],
    }),
    record({
      id: "rising-4",
      date: "2026-09-14",
      sleep_hours: 8,
      exercises: [{ name: "Bench press", sets: [{ weight: 115, reps: 5, rpe: 6 }] }],
    }),
  ];

  const model = buildPlanModel(records, "zh");
  assert.deepEqual(model.summary, {
    sessions: 4,
    from: "2026-09-01",
    to: "2026-09-14",
    confidence: "standard",
  });
  assert.deepEqual(model.safetyNotes, []);
  assert.equal(model.carePrompt, null);

  const overload = model.recommendations.find((entry) => entry.code === "progressive_overload");
  assert.equal(overload?.action, "渐进超负荷");
  assert.match(overload?.detail ?? "", /Bench press/);
  assert.match(overload?.reason ?? "", /1RM/);

  const english = buildPlanModel(records, "en");
  const englishOverload = english.recommendations.find(
    (entry) => entry.code === "progressive_overload",
  );
  assert.equal(englishOverload?.action, "progressive_overload");
  assert.match(englishOverload?.detail ?? "", /~2\.5% load/);
});

test("pain maps to localized safety notes and drives the localized care prompt", () => {
  const model = buildPlanModel(
    [
      record({
        id: "pain",
        date: "2026-09-05",
        pain: [{ area: "knee", level: 4 }],
        exercises: [{ name: "Back squat", sets: [{ weight: 100, reps: 5, rpe: 10 }] }],
      }),
    ],
    "zh",
  );

  const reduce = model.recommendations.find(
    (entry) => entry.code === "reduce_or_pause_loading",
  );
  assert.equal(reduce?.action, "降低或暂停负荷");
  assert.match(reduce?.detail ?? "", /不要加重负荷/);
  assert.ok(
    model.safetyNotes.includes("已记录疼痛。避免对受影响部位施加负荷，优先恢复。"),
  );
  assert.match(model.carePrompt ?? "", /专业医疗评估/);
  assert.equal(model.applied, false);
});

test("unknown recommendation codes and notes fall back to canonical English", () => {
  const custom: Recommendation = {
    action: "future_action",
    detail: "Future detail.",
    reason: "Future reason.",
    evidence: { some: "evidence" },
  };

  assert.deepEqual(buildRecommendationView("zh", custom), {
    code: "future_action",
    action: "future_action",
    detail: "Future detail.",
    reason: "Future reason.",
  });

  assert.deepEqual(
    localizeSafetyNotes("zh", [
      "Custom note.",
      "At least one set reached RPE 9 or higher.",
    ]),
    ["Custom note.", "至少有一组达到 RPE 9 或更高。"],
  );
  assert.deepEqual(localizeSafetyNotes("en", ["At least one set reached RPE 9 or higher."]), [
    "At least one set reached RPE 9 or higher.",
  ]);
});

test("building the model never mutates records or claims an applied plan", () => {
  const records = [
    record({ id: "a", date: "2026-09-01" }),
    record({ id: "b", date: "2026-09-03", exercises: [{ name: "Deadlift", sets: [{ weight: 140, reps: 3 }] }] }),
  ];
  const before = structuredClone(records);

  const model = buildPlanModel(records, "en");

  assert.deepEqual(records, before, "input records are untouched");
  assert.deepEqual(
    records.map((entry) => entry.id),
    ["a", "b"],
    "input order is not mutated",
  );
  assert.equal(model.isDraft, true);
  assert.equal(model.requiresConfirmation, true);
  assert.equal(model.applied, false);
});
