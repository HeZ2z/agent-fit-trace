import {
  assertOrderedDateRange,
  assertValidFilterDate,
  createExerciseMatcher,
  toDateKey,
} from "@agent-fit-trace/core";
import type { HistoryFilter, WorkoutRecord } from "@agent-fit-trace/core";

export interface QueryResult {
  records: WorkoutRecord[];
  total: number;
  offset: number;
  limit: number | null;
}

/**
 * Validate a history filter up front: invalid or inverted date bounds throw a
 * readable ValidationError. Backends call this before touching storage so a
 * corrupt store cannot mask the filter error with CORRUPT_STORE.
 */
export function assertValidHistoryFilter(filter: HistoryFilter = {}): void {
  const from = filter.from === undefined ? undefined : assertValidFilterDate(filter.from, "from");
  const to = filter.to === undefined ? undefined : assertValidFilterDate(filter.to, "to");
  assertOrderedDateRange(from, to);
}

/**
 * Pure history filtering shared by the JSON and SQLite backends: validated date
 * bounds, alias-aware exercise match, then offset/limit paging. Callers sort
 * their records before invoking this so page ordering stays identical across
 * backends.
 *
 * The exercise match reuses core's analysis matcher, so `get_training_history`
 * selects exactly the records `analyze_progress` would: raw case-insensitive
 * equality OR the same resolved catalog entry (aliases, canonical names,
 * `_`/`-`/space variants). Unknown custom names stay exact-only.
 */
export function filterRecordsPage(
  records: WorkoutRecord[],
  filter: HistoryFilter = {},
): QueryResult {
  assertValidHistoryFilter(filter);

  // The bounds are validated above; use them as given.
  const from = filter.from;
  const to = filter.to;

  let filtered = records;

  if (from !== undefined) {
    const fromKey = toDateKey(from);
    filtered = filtered.filter((record) => toDateKey(record.date) >= fromKey);
  }
  if (to !== undefined) {
    const toKey = toDateKey(to);
    filtered = filtered.filter((record) => toDateKey(record.date) <= toKey);
  }
  if (filter.exercise !== undefined) {
    const matchesExercise = createExerciseMatcher([filter.exercise]);
    filtered = filtered.filter((record) =>
      record.exercises.some((exercise) => matchesExercise(exercise.name)),
    );
  }

  const total = filtered.length;
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? null;
  const page = limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + limit);

  return { records: page, total, offset, limit };
}
