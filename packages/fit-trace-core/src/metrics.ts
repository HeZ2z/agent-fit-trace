import { ValidationError } from "./errors.ts";
import { resolveExerciseName } from "./exercises/resolve.ts";
import { isValidIsoDate } from "./schema.ts";
import {
  EXTREME_RPE,
  MIN_HISTORY_SESSIONS,
  VOLUME_CHANGE_THRESHOLD_PCT,
} from "./types.ts";
import type {
  AnalysisFlag,
  AnalysisMetrics,
  ExerciseTrend,
  WorkoutRecord,
} from "./types.ts";

export interface FlatSet {
  recordId: string;
  date: string;
  sessionType: string;
  exercise: string;
  weight?: number;
  reps: number;
  rpe?: number;
  volumeKg: number;
  est1rm?: number;
}

/** Round to `dp` decimals without negative-zero artifacts. */
export function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Epley estimate: `weight * (1 + reps / 30)`. */
export function estimateOneRepMax(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

export function toEpochMs(date: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date;
  return new Date(normalized).getTime();
}

/** Normalize any accepted ISO 8601 value to a `YYYY-MM-DD` key for range filtering. */
export function toDateKey(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parsed = new Date(date);
  // Callers validate untrusted input; never let a malformed value throw RangeError here.
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Validate an untrusted date filter (for example one supplied by the LLM via a
 * tool call) and return it unchanged. Throws a readable {@link ValidationError}
 * instead of letting `toDateKey` surface an opaque `RangeError`.
 */
export function assertValidFilterDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !isValidIsoDate(value)) {
    throw new ValidationError(`\`${field}\` must be a valid ISO 8601 date (YYYY-MM-DD) or datetime.`, [
      { code: "INVALID_FILTER_DATE", message: `Invalid \`${field}\` value`, path: field },
    ]);
  }
  return value;
}

/** Reject an inverted filter range (`from` later than `to`) before it silently returns nothing. */
export function assertOrderedDateRange(from: string | undefined, to: string | undefined): void {
  if (from === undefined || to === undefined) return;
  if (toEpochMs(from) > toEpochMs(to)) {
    throw new ValidationError("`from` must not be later than `to`.", [
      { code: "INVALID_DATE_RANGE", message: "`from` is after `to`", path: "from" },
    ]);
  }
}

function daysBetween(a: string, b: string): number {
  return (toEpochMs(b) - toEpochMs(a)) / 86_400_000;
}

/** Sort by date ascending, then id, so every downstream result is deterministic. */
export function sortRecords(records: WorkoutRecord[]): WorkoutRecord[] {
  return [...records].sort((a, b) => {
    const byDate = toEpochMs(a.date) - toEpochMs(b.date);
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });
}

export function flattenSets(records: WorkoutRecord[]): FlatSet[] {
  const flat: FlatSet[] = [];
  for (const record of sortRecords(records)) {
    for (const exercise of record.exercises) {
      for (const set of exercise.sets) {
        const volumeKg = set.weight !== undefined ? set.weight * set.reps : 0;
        const entry: FlatSet = {
          recordId: record.id,
          date: record.date,
          sessionType: record.session_type,
          exercise: exercise.name,
          reps: set.reps,
          volumeKg,
        };
        if (set.weight !== undefined) {
          entry.weight = set.weight;
          entry.est1rm = round(estimateOneRepMax(set.weight, set.reps));
        }
        if (set.rpe !== undefined) entry.rpe = set.rpe;
        flat.push(entry);
      }
    }
  }
  return flat;
}

/** Per-session weighted volume, used for spike/drop detection. */
function sessionVolumes(records: WorkoutRecord[]): number[] {
  return sortRecords(records).map((record) =>
    record.exercises.reduce(
      (total, exercise) =>
        total +
        exercise.sets.reduce(
          (sum, set) => sum + (set.weight !== undefined ? set.weight * set.reps : 0),
          0,
        ),
      0,
    ),
  );
}

export function summarizeMetrics(records: WorkoutRecord[]): AnalysisMetrics {
  const flat = flattenSets(records);

  const volumeKg = flat.reduce((sum, set) => sum + set.volumeKg, 0);
  const totalReps = flat.reduce((sum, set) => sum + set.reps, 0);

  const rpes = flat
    .map((set) => set.rpe)
    .filter((rpe): rpe is number => rpe !== undefined);
  const avgRpe = rpes.length > 0 ? round(rpes.reduce((a, b) => a + b, 0) / rpes.length) : null;

  const distinctDates = [...new Set(sortRecords(records).map((r) => r.date))];
  let avgRestDays = 0;
  let maxGapDays = 0;
  if (distinctDates.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < distinctDates.length; i += 1) {
      const gap = daysBetween(distinctDates[i - 1], distinctDates[i]);
      gaps.push(gap);
      if (gap > maxGapDays) maxGapDays = gap;
    }
    avgRestDays = round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }

  return {
    sessions: records.length,
    total_sets: flat.length,
    total_reps: totalReps,
    volume_kg: round(volumeKg),
    avg_rpe: avgRpe,
    avg_rest_days: avgRestDays,
    max_gap_days: round(maxGapDays),
  };
}

/**
 * Stable analysis identity for a recorded exercise name.
 *
 * A name that resolves unambiguously to one bundled catalog entry is grouped by
 * that entry and labelled with its canonical English name, so `bench_press`,
 * `Bench Press`, and the canonical name share one trend. An unknown or
 * ambiguous name keeps its exact raw spelling: the catalog is a suggestion
 * layer and never guesses or rewrites user-authored names.
 */
interface ExerciseIdentity {
  /** Grouping key: stable per resolved catalog entry or exact raw name. */
  key: string;
  /** Label rendered in the trend: canonical English name or the raw name. */
  label: string;
}

function exerciseIdentity(name: string): ExerciseIdentity {
  const entry = resolveExerciseName(name);
  return entry === null
    ? { key: `raw:${name}`, label: name }
    : { key: `catalog:${entry.id}`, label: entry.name };
}

/** Order trends by resulting label, then identity key so ties stay stable. */
function compareExerciseIdentities(left: ExerciseIdentity, right: ExerciseIdentity): number {
  if (left.label < right.label) return -1;
  if (left.label > right.label) return 1;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

/**
 * Per-exercise strength trend based on the best estimated 1RM per session.
 *
 * Sets are grouped by resolved catalog identity: alias spellings of one catalog
 * entry merge into a single trend labelled with the canonical English name, and
 * the best estimated 1RM per session is taken across all merged spellings.
 * Unknown names stay separate and keep their raw label. Requires at least two
 * sessions that contain weighted sets for the exercise.
 */
export function exerciseTrends(records: WorkoutRecord[]): ExerciseTrend[] {
  const byExercise = new Map<
    string,
    { identity: ExerciseIdentity; sessions: Map<string, number> }
  >();

  for (const set of flattenSets(records)) {
    if (set.est1rm === undefined) continue;
    const identity = exerciseIdentity(set.exercise);
    const existing = byExercise.get(identity.key);
    const sessions = existing === undefined ? new Map<string, number>() : existing.sessions;
    const current = sessions.get(set.date);
    if (current === undefined || set.est1rm > current) {
      sessions.set(set.date, set.est1rm);
    }
    if (existing === undefined) {
      byExercise.set(identity.key, { identity, sessions });
    }
  }

  const groups = [...byExercise.values()].sort((left, right) =>
    compareExerciseIdentities(left.identity, right.identity),
  );

  const trends: ExerciseTrend[] = [];
  for (const { identity, sessions: sessionValues } of groups) {
    const sessions = [...sessionValues.entries()].sort(
      (a, b) => toEpochMs(a[0]) - toEpochMs(b[0]),
    );
    if (sessions.length < 2) continue;

    const first = sessions[0][1];
    const last = sessions[sessions.length - 1][1];
    const delta = round(last - first);
    const deltaPct = first === 0 ? 0 : round((delta / first) * 100);
    let direction: ExerciseTrend["direction"] = "flat";
    if (Math.abs(delta) >= 0.01) direction = delta > 0 ? "up" : "down";

    trends.push({
      exercise: identity.label,
      metric: "est_1rm_kg",
      sessions_compared: sessions.length,
      first: round(first),
      last: round(last),
      delta,
      delta_pct: deltaPct,
      direction,
    });
  }

  return trends;
}

export function detectFlags(records: WorkoutRecord[]): AnalysisFlag[] {
  const flags: AnalysisFlag[] = [];
  const sorted = sortRecords(records);

  const painRecords = sorted.filter((r) => (r.pain?.length ?? 0) > 0);
  if (painRecords.length > 0) {
    flags.push({
      code: "PAIN_REPORTED",
      severity: "critical",
      message: `Pain was reported in ${painRecords.length} session(s).`,
      evidence: { record_ids: painRecords.map((r) => r.id) },
    });
  }

  const extremeSets = flattenSets(records).filter(
    (set) => set.rpe !== undefined && set.rpe >= EXTREME_RPE,
  );
  if (extremeSets.length > 0) {
    flags.push({
      code: "EXTREME_RPE",
      severity: "critical",
      message: `${extremeSets.length} set(s) reached RPE ${EXTREME_RPE} or higher.`,
      evidence: {
        record_ids: [...new Set(extremeSets.map((s) => s.recordId))],
        set_count: extremeSets.length,
        max_rpe: Math.max(...extremeSets.map((s) => s.rpe as number)),
      },
    });
  }

  if (sorted.length >= 2) {
    const volumes = sessionVolumes(sorted);
    const latest = volumes[volumes.length - 1];
    const priorWindow = volumes.slice(Math.max(0, volumes.length - 4), volumes.length - 1);
    const priorMean = priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length;
    if (priorMean > 0) {
      const changePct = round(((latest - priorMean) / priorMean) * 100);
      if (changePct >= VOLUME_CHANGE_THRESHOLD_PCT) {
        flags.push({
          code: "VOLUME_SPIKE",
          severity: "warning",
          message: `Latest session volume is ${changePct}% above the recent average.`,
          evidence: { latest_volume_kg: round(latest), prior_avg_volume_kg: round(priorMean), change_pct: changePct },
        });
      } else if (changePct <= -VOLUME_CHANGE_THRESHOLD_PCT) {
        flags.push({
          code: "VOLUME_DROP",
          severity: "warning",
          message: `Latest session volume is ${Math.abs(changePct)}% below the recent average.`,
          evidence: { latest_volume_kg: round(latest), prior_avg_volume_kg: round(priorMean), change_pct: changePct },
        });
      }
    }
  }

  if (records.length > 0 && !sorted.some((r) => r.sleep_hours !== undefined)) {
    flags.push({
      code: "MISSING_RECOVERY_DATA",
      severity: "warning",
      message: "No recovery data (sleep_hours) was recorded in this period.",
      evidence: { sessions: records.length },
    });
  }

  if (records.length > 0 && records.length < MIN_HISTORY_SESSIONS) {
    flags.push({
      code: "INSUFFICIENT_HISTORY",
      severity: "info",
      message: `Only ${records.length} session(s) available; fewer than ${MIN_HISTORY_SESSIONS} limits trend confidence.`,
      evidence: { sessions: records.length, minimum: MIN_HISTORY_SESSIONS },
    });
  }

  return flags;
}
