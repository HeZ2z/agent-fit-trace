import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeProgress,
  formatAnalysisText,
  formatHistoryText,
  formatPlanText,
  generateNextPlan,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { filterRecordsPage } from "@agent-fit-trace/store";

import { loadFixture } from "./helpers.ts";

/** Build one validated strength record; every exercise uses the supplied sets. */
function record(
  id: string,
  date: string,
  exercises: Array<{ name: string; sets: Array<{ weight?: number; reps: number; rpe?: number }> }>,
  extra: Record<string, unknown> = {},
): WorkoutRecord {
  return validateWorkoutRecord({
    id,
    schema_version: 1,
    date,
    session_type: "strength",
    exercises,
    ...extra,
  }).record;
}

function bench(id: string, date: string, name = "bench_press", weight = 80): WorkoutRecord {
  return record(id, date, [{ name, sets: [{ weight, reps: 5, rpe: 7 }] }]);
}

// ---------------------------------------------------------------------------
// Alias-aware history filter (shared with analyze_progress).
// ---------------------------------------------------------------------------

test("history filter matches a catalog alias from a separator variant", () => {
  const records = [bench("r1", "2026-09-01")];
  assert.deepEqual(
    filterRecordsPage(records, { exercise: "bench press" }).records.map((entry) => entry.id),
    ["r1"],
  );
});

test("history filter matches an alias spelling of a canonical stored name", () => {
  // This is the canonical label for the `barbell_bench_press` catalog entry.
  const records = [bench("r1", "2026-09-01", "Barbell Bench Press - Medium Grip")];
  assert.deepEqual(
    filterRecordsPage(records, { exercise: "bench press" }).records.map((entry) => entry.id),
    ["r1"],
  );
});

test("history filter keeps unknown custom names exact-only without false positives", () => {
  const records = [
    bench("r1", "2026-09-01", "Zercher Carry", 40),
    bench("r2", "2026-09-02", "Sled Drag", 20),
  ];
  assert.deepEqual(
    filterRecordsPage(records, { exercise: "zercher carry" }).records.map((entry) => entry.id),
    ["r1"],
  );
  // No catalog entry exists, so separator normalization must not apply.
  assert.deepEqual(filterRecordsPage(records, { exercise: "zercher_carry" }).records, []);
  // A nearby resolved entry must not capture an unresolved custom name.
  assert.deepEqual(filterRecordsPage(records, { exercise: "Zercher Squat" }).records, []);
  assert.deepEqual(filterRecordsPage(records, { exercise: "deadlift" }).records, []);
});

test("history filter keeps total and paging semantics unchanged", () => {
  const records = [0, 1, 2, 3, 4].map((index) =>
    bench(`r-${index}`, `2026-09-0${index + 1}`),
  );
  const page = filterRecordsPage(records, { exercise: "Bench Press", limit: 2, offset: 1 });
  assert.equal(page.total, 5);
  assert.equal(page.offset, 1);
  assert.equal(page.limit, 2);
  assert.deepEqual(page.records.map((entry) => entry.id), ["r-1", "r-2"]);
});

// ---------------------------------------------------------------------------
// formatHistoryText
// ---------------------------------------------------------------------------

test("history text keeps its prefix and lists bounded record details", () => {
  const records = Array.from({ length: 12 }, (_, index) =>
    bench(`record-${String(index).padStart(2, "0")}`, `2026-09-${String(index + 1).padStart(2, "0")}`),
  );
  const before = structuredClone(records);
  const text = formatHistoryText(records, { total: 25, offset: 0, limit: 12 });
  const lines = text.split("\n");

  assert.equal(lines[0], "Returned 12 of 25 matching record(s).");
  assert.match(text, /record-00 \| 2026-09-01 \| strength \| bench_press \(1 set\) \| 80 kg x 5 @RPE 7/);
  // Ten record lines plus the paging hint, never all 12.
  assert.equal(lines.filter((line) => line.startsWith("- ")).length, 10);
  assert.match(text, /2 more returned record\(s\) not shown; call again with offset 10 and limit 12\./);
  assert.deepEqual(records, before, "formatter must not mutate records");
});

test("history text explains how to page when the page is shorter than the total", () => {
  const records = [bench("r-1", "2026-09-01"), bench("r-2", "2026-09-02")];
  const text = formatHistoryText(records, { total: 5, offset: 0, limit: 2 });
  assert.match(text, /3 more matching record\(s\) exist; call again with offset 2 and limit 2\./);
});

test("history text reports an empty result without fabricating records", () => {
  const text = formatHistoryText([], { total: 0, offset: 0, limit: null });
  assert.equal(text.split("\n")[0], "Returned 0 of 0 matching record(s).");
  assert.match(text, /No matching records/);
});

// ---------------------------------------------------------------------------
// formatAnalysisText
// ---------------------------------------------------------------------------

test("analysis text carries prefix, period, trends, flags, and source ids", () => {
  const records = [
    bench("pe-02-a", "2026-02-02", "bench_press", 80),
    bench("pe-02-b", "2026-02-09", "bench_press", 82.5),
    bench("pe-02-c", "2026-02-16", "bench_press", 85),
  ];
  const analysis = analyzeProgress(records);
  const before = structuredClone(analysis);
  const lines = formatAnalysisText(analysis).split("\n");

  assert.match(
    lines[0],
    /^Analyzed 3 session\(s\): volume [\d.]+ kg, avg RPE (?:[\d.]+|n\/a), \d+ flag\(s\)\.$/,
  );
  assert.match(lines[1], /^Period: 2026-02-02 -> 2026-02-16; sets 3, reps 15/);
  assert.match(
    formatAnalysisText(analysis),
    /Barbell Bench Press - Medium Grip: 93\.33 -> 99\.17 kg \(\+5\.84, \+6\.26%\), up, 3 sessions/,
  );
  assert.match(formatAnalysisText(analysis), /Source records: pe-02-a, pe-02-b, pe-02-c\./);
  assert.deepEqual(analysis, before, "formatter must not mutate the analysis");
});

test("analysis text bounds trends, flags, and source ids", () => {
  const records = Array.from({ length: 30 }, (_, index) =>
    record(`bounded-${String(index).padStart(2, "0")}`, `2026-08-${String(index + 1).padStart(2, "0")}`, [
      { name: `custom exercise ${index}`, sets: [{ weight: 50, reps: 5 }] },
    ]),
  );
  const analysis = analyzeProgress(records);
  // Force more than the display caps without touching input semantics.
  analysis.trends = Array.from({ length: 12 }, (_, index) => ({
    exercise: `trend ${index}`,
    metric: "est_1rm_kg" as const,
    sessions_compared: 2,
    first: 50,
    last: 55,
    delta: 5,
    delta_pct: 10,
    direction: "up" as const,
  }));
  analysis.flags = Array.from({ length: 12 }, (_, index) => ({
    code: `FLAG_${index}`,
    severity: "info" as const,
    message: `flag ${index}`,
    evidence: {},
  }));
  const text = formatAnalysisText(analysis);

  assert.match(text, /2 more trend\(s\) not shown/);
  assert.match(text, /2 more flag\(s\) not shown/);
  assert.match(text, /\(\+10 more\)\./);
  assert.doesNotMatch(text, /FLAG_11/);
  assert.doesNotMatch(text, /trend 11/);
});

// ---------------------------------------------------------------------------
// formatPlanText
// ---------------------------------------------------------------------------

test("plan text carries draft status, period, recommendations with evidence, and notes", () => {
  const records = [
    bench("pe-03-a", "2026-02-02", "bench_press", 80),
    bench("pe-03-b", "2026-02-09", "bench_press", 82.5),
    bench("pe-03-c", "2026-02-16", "bench_press", 85),
  ];
  records[0].pain = [{ area: "shoulder", level: 3 }];
  const draft = generateNextPlan(records);
  const before = structuredClone(draft);
  const lines = formatPlanText(draft).split("\n");

  assert.equal(
    lines[0],
    `Generated a draft plan with ${draft.recommendations.length} recommendation(s). This is a draft and requires user confirmation.`,
  );
  assert.match(lines[1], /^Based on 3 session\(s\) from 2026-02-02 to 2026-02-16/);
  assert.match(formatPlanText(draft), /Source records: pe-03-a, pe-03-b, pe-03-c\./);
  assert.match(formatPlanText(draft), /^Recommendations:$/m);
  assert.match(formatPlanText(draft), /- reduce_or_pause_loading: .* Evidence: \{"record_ids":\["pe-03-a"\]\}/);
  assert.match(formatPlanText(draft), /^Safety notes:$/m);
  assert.match(formatPlanText(draft), /^Professional care: /m);
  assert.deepEqual(draft, before, "formatter must not mutate the draft");
});

test("plan text bounds recommendations and safety notes", () => {
  const records = [bench("one", "2026-09-01", "bench_press", 80)];
  const draft = generateNextPlan(records);
  draft.recommendations = Array.from({ length: 12 }, (_, index) => ({
    action: `action_${index}`,
    detail: `detail ${index}`,
    reason: `reason ${index}`,
    evidence: { index },
  }));
  draft.safety_notes = Array.from({ length: 12 }, (_, index) => `note ${index}`);
  const text = formatPlanText(draft);

  assert.match(text, /2 more recommendation\(s\) not shown/);
  assert.match(text, /2 more note\(s\) not shown/);
  assert.doesNotMatch(text, /action_11/);
  assert.doesNotMatch(text, /note 11/);
});

// ---------------------------------------------------------------------------
// Fixture smoke: the prompt-eval traceable-numbers cell stays traceable in text.
// ---------------------------------------------------------------------------

test("renderings of the traceable-numbers fixture cite ids, numbers, and evidence", async () => {
  const raw = await loadFixture<WorkoutRecord[]>("prompt-eval/02-traceable-numbers/workouts.json");
  const records = raw.map((entry) => validateWorkoutRecord(entry).record);

  const history = formatHistoryText(records, { total: records.length, offset: 0, limit: null });
  assert.match(history, /pe-02-2026-02-02-bench/);

  const analysisText = formatAnalysisText(analyzeProgress(records));
  assert.match(analysisText, /93\.33 -> 99\.17/);
  assert.match(analysisText, /\+5\.84/);
  assert.match(analysisText, /pe-02-2026-02-16-bench/);

  const planText = formatPlanText(generateNextPlan(records));
  assert.match(planText, /Evidence: \{/);
  assert.match(planText, /pe-02-2026-02-02-bench/);
});
