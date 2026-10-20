import assert from "node:assert/strict";
import { test } from "node:test";

import { CURRENT_SCHEMA_VERSION } from "@pi-fit-trace/core";
import type { AnalysisFlag, ExerciseTrend, WorkoutRecord } from "@pi-fit-trace/core";
import {
  buildAnalysisSummary,
  buildFlagViews,
  formatNumber,
  formatVolumeKg,
  selectPrimaryTrend,
  sessionSpan,
  sortFlagsBySeverity,
} from "../mobile/src/data/analysisModel.ts";

/**
 * Pure coverage for the Analysis screen model. The screen and the SQLite
 * repository are intentionally not imported: the model imports no React,
 * expo or native module, so the root `node:test` suite stays runtime-free.
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

function trend(exercise: string, deltaPct: number): ExerciseTrend {
  return {
    exercise,
    metric: "est_1rm_kg",
    sessions_compared: 2,
    first: 100,
    last: 100 + deltaPct,
    delta: deltaPct,
    delta_pct: deltaPct,
    direction: deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat",
  };
}

function flag(code: string, severity: AnalysisFlag["severity"], message = code): AnalysisFlag {
  return { code, severity, message, evidence: {} };
}

test("an empty history produces an empty summary with no flags or trend", () => {
  const summary = buildAnalysisSummary([]);

  assert.equal(summary.isEmpty, true);
  assert.equal(summary.metrics.sessions, 0);
  assert.equal(summary.metrics.volume_kg, 0);
  assert.deepEqual(summary.period, { from: null, to: null });
  assert.deepEqual(summary.span, {
    first: null,
    last: null,
    activeWeeks: 0,
    days: 0,
  });
  assert.equal(summary.trend, null);
  assert.deepEqual(summary.trends, []);
  assert.deepEqual(summary.flags, []);
  assert.equal(summary.sourceCount, 0);
});

test("a non-empty history exposes metrics, span, primary trend and the source count", () => {
  const records = [
    record({
      id: "a",
      date: "2026-09-01",
      exercises: [{ name: "Back squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    }),
    record({
      id: "b",
      date: "2026-09-03",
      exercises: [{ name: "Bench press", sets: [{ weight: 80, reps: 5, rpe: 8 }] }],
    }),
    record({
      id: "c",
      date: "2026-09-08",
      exercises: [{ name: "Back squat", sets: [{ weight: 110, reps: 5, rpe: 8 }] }],
    }),
    record({
      id: "d",
      date: "2026-09-14",
      exercises: [{ name: "Back squat", sets: [{ weight: 115, reps: 5, rpe: 8 }] }],
    }),
  ];

  const summary = buildAnalysisSummary(records);

  assert.equal(summary.isEmpty, false);
  assert.equal(summary.metrics.sessions, 4);
  assert.equal(summary.metrics.total_sets, 4);
  assert.equal(summary.metrics.volume_kg, 2025);
  assert.deepEqual(summary.period, { from: "2026-09-01", to: "2026-09-14" });
  assert.deepEqual(summary.span, {
    first: "2026-09-01",
    last: "2026-09-14",
    activeWeeks: 3,
    days: 13,
  });
  assert.equal(summary.sourceCount, 4);
  assert.equal(summary.trends.length, 1);
  // The core labels trends by resolved catalog identity (the canonical English
  // name), so the stored `Back squat` alias surfaces as `Barbell Squat`.
  assert.equal(summary.trend?.exercise, "Barbell Squat");
  assert.equal(summary.trend?.direction, "up");

  assert.deepEqual(
    records.map((entry) => entry.id),
    ["a", "b", "c", "d"],
    "building the summary never reorders the caller's records",
  );
});

test("active weeks follow Monday buckets and the span ignores the clock", () => {
  const sameWeek = sessionSpan([
    record({ id: "tue", date: "2026-09-01" }),
    record({ id: "sun", date: "2026-09-06" }),
  ]);
  assert.equal(sameWeek.activeWeeks, 1);
  assert.equal(sameWeek.days, 5);

  const nextWeek = sessionSpan([
    record({ id: "sun", date: "2026-09-06" }),
    record({ id: "mon", date: "2026-09-07" }),
  ]);
  assert.equal(nextWeek.activeWeeks, 2);
  assert.equal(nextWeek.days, 1);

  const duplicateDay = sessionSpan([
    record({ id: "one", date: "2026-09-01" }),
    record({ id: "two", date: "2026-09-01" }),
  ]);
  assert.equal(duplicateDay.activeWeeks, 1);
  assert.equal(duplicateDay.days, 0);
});

test("selectPrimaryTrend prefers the largest absolute change with a stable tie-break", () => {
  assert.equal(selectPrimaryTrend([]), null);
  assert.equal(
    selectPrimaryTrend([trend("Deadlift", 5), trend("Bench press", -30)])?.exercise,
    "Bench press",
  );
  assert.equal(
    selectPrimaryTrend([trend("Bench press", -20), trend("Back squat", 20)])?.exercise,
    "Back squat",
    "a percentage-point tie is broken by exercise name",
  );
});

test("flags are ordered by severity and keep the core order within one severity", () => {
  const flags: AnalysisFlag[] = [
    flag("INFO_ONE", "info"),
    flag("WARN_ONE", "warning"),
    flag("CRIT_ONE", "critical"),
    flag("CRIT_TWO", "critical"),
    flag("WARN_TWO", "warning"),
  ];

  assert.deepEqual(
    sortFlagsBySeverity(flags).map((entry) => entry.code),
    ["CRIT_ONE", "CRIT_TWO", "WARN_ONE", "WARN_TWO", "INFO_ONE"],
  );
  assert.deepEqual(
    flags.map((entry) => entry.code),
    ["INFO_ONE", "WARN_ONE", "CRIT_ONE", "CRIT_TWO", "WARN_TWO"],
    "the input list is not mutated",
  );
});

test("real core flags are grouped critical, warning, then info", () => {
  const summary = buildAnalysisSummary([
    record({
      id: "pain",
      date: "2026-09-01",
      pain: [{ area: "knee", level: 4 }],
      exercises: [{ name: "Back squat", sets: [{ weight: 100, reps: 5, rpe: 10 }] }],
    }),
  ]);

  assert.deepEqual(
    summary.flags.map((entry) => entry.code),
    ["PAIN_REPORTED", "EXTREME_RPE", "MISSING_RECOVERY_DATA", "INSUFFICIENT_HISTORY"],
  );
});

test("flag views use the shared domain translation and fall back to core English", () => {
  const pain = flag("PAIN_REPORTED", "critical", "Pain was reported in 1 session(s).");
  pain.evidence = { record_ids: ["pain"] };

  const [zhPain] = buildFlagViews("zh", [pain]);
  assert.equal(zhPain?.severityLabel, "严重");
  assert.equal(zhPain?.message, "已记录疼痛：1 次训练中出现疼痛。");

  const [enPain] = buildFlagViews("en", [pain]);
  assert.equal(enPain?.message, "Pain was reported in 1 session(s).");

  const [unknownCode] = buildFlagViews("zh", [
    flag("FUTURE_RULE", "warning", "A future rule fired."),
  ]);
  assert.equal(unknownCode?.message, "A future rule fired.");
  assert.equal(unknownCode?.severityLabel, "警告");

  const incomplete = flag("PAIN_REPORTED", "critical", "Core message without evidence.");
  const [unknownEvidence] = buildFlagViews("zh", [incomplete]);
  assert.equal(unknownEvidence?.message, "Core message without evidence.");

  const exotic = {
    code: "EXOTIC",
    severity: "experimental",
    message: "Exotic severity.",
    evidence: {},
  } as unknown as AnalysisFlag;
  const [unknownSeverity] = buildFlagViews("zh", [exotic]);
  assert.equal(unknownSeverity?.severityLabel, "experimental");
  assert.equal(unknownSeverity?.message, "Exotic severity.");
});

test("metric formatting is deterministic, grouped, and trims trailing zeros", () => {
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(7), "7");
  assert.equal(formatNumber(1234), "1,234");
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatNumber(-1234.5, 1), "-1,234.5");
  assert.equal(formatNumber(Number.NaN), "—");

  assert.equal(formatVolumeKg(0), "0");
  assert.equal(formatVolumeKg(1000), "1,000");
  assert.equal(formatVolumeKg(102.5), "102.5");
  assert.equal(formatVolumeKg(1234.567), "1,234.57");
});
