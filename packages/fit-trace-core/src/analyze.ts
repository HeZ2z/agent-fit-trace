import { resolveExerciseName } from "./exercises/resolve.ts";
import {
  assertOrderedDateRange,
  assertValidFilterDate,
  detectFlags,
  exerciseTrends,
  sortRecords,
  summarizeMetrics,
  toDateKey,
} from "./metrics.ts";
import type { AnalysisFilter, AnalysisResult, WorkoutRecord } from "./types.ts";

/**
 * Build a predicate for the analysis exercise filter.
 *
 * A recorded exercise matches when either:
 * - its raw name equals a wanted value ignoring case (the pre-catalog
 *   behaviour, retained for unresolved custom names), or
 * - both the recorded name and a wanted value resolve to the same catalog
 *   entry, which also covers aliases, canonical names, and `_`/`-`/space and
 *   case variants of a catalog name.
 *
 * Unresolved custom names are never normalized, so the catalog remains a
 * suggestion layer rather than a gate.
 */
function exerciseFilterMatcher(wanted: readonly string[]): (name: string) => boolean {
  const rawWanted = new Set(wanted.map((name) => name.toLowerCase()));
  const wantedEntryIds = new Set<string>();
  for (const name of wanted) {
    const entry = resolveExerciseName(name);
    if (entry !== null) wantedEntryIds.add(entry.id);
  }

  return (name) => {
    if (rawWanted.has(name.toLowerCase())) return true;
    if (wantedEntryIds.size === 0) return false;
    const entry = resolveExerciseName(name);
    return entry !== null && wantedEntryIds.has(entry.id);
  };
}

/**
 * Apply date-range and exercise filters, returning records sorted by date.
 *
 * Date validation and its errors are unchanged. Exercise filters match raw
 * names case-insensitively or through resolved catalog identity (alias-aware).
 */
export function filterRecords(records: WorkoutRecord[], filter: AnalysisFilter = {}): WorkoutRecord[] {
  const from = filter.from === undefined ? undefined : assertValidFilterDate(filter.from, "from");
  const to = filter.to === undefined ? undefined : assertValidFilterDate(filter.to, "to");
  assertOrderedDateRange(from, to);

  let scoped = sortRecords(records);

  if (from !== undefined) {
    const fromKey = toDateKey(from);
    scoped = scoped.filter((record) => toDateKey(record.date) >= fromKey);
  }
  if (to !== undefined) {
    const toKey = toDateKey(to);
    scoped = scoped.filter((record) => toDateKey(record.date) <= toKey);
  }
  if (filter.exercises !== undefined && filter.exercises.length > 0) {
    const matchesExercise = exerciseFilterMatcher(filter.exercises);
    scoped = scoped.filter((record) =>
      record.exercises.some((exercise) => matchesExercise(exercise.name)),
    );
  }

  return scoped;
}

/**
 * Deterministic progress analysis. Pure function: no clock, no randomness, no
 * LLM. Identical input always yields identical output.
 */
export function analyzeProgress(records: WorkoutRecord[], filter: AnalysisFilter = {}): AnalysisResult {
  const scoped = filterRecords(records, filter);

  return {
    period: {
      from: scoped.length > 0 ? toDateKey(scoped[0].date) : null,
      to: scoped.length > 0 ? toDateKey(scoped[scoped.length - 1].date) : null,
    },
    metrics: summarizeMetrics(scoped),
    trends: exerciseTrends(scoped),
    flags: detectFlags(scoped),
    source_records: scoped.map((record) => record.id),
  };
}
