import {
  assertOrderedDateRange,
  assertValidFilterDate,
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
 * Pure history filtering shared by the JSON and SQLite backends: validated date
 * bounds, case-insensitive exercise match, then offset/limit paging. Callers
 * sort their records before invoking this so page ordering stays identical
 * across backends.
 */
export function filterRecordsPage(
  records: WorkoutRecord[],
  filter: HistoryFilter = {},
): QueryResult {
  const from = filter.from === undefined ? undefined : assertValidFilterDate(filter.from, "from");
  const to = filter.to === undefined ? undefined : assertValidFilterDate(filter.to, "to");
  assertOrderedDateRange(from, to);

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
    const needle = filter.exercise.toLowerCase();
    filtered = filtered.filter((record) =>
      record.exercises.some((exercise) => exercise.name.toLowerCase() === needle),
    );
  }

  const total = filtered.length;
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? null;
  const page = limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + limit);

  return { records: page, total, offset, limit };
}
