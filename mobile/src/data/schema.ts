import { stableStringify, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { deriveWorkoutId } from "@agent-fit-trace/api-contracts";

/**
 * Pure schema, row mapping and write-classification helpers for the mobile
 * workout store.
 *
 * This module imports no `expo-sqlite`, DOM or Node values, so the root
 * `node:test` suite can load it through Node's TypeScript type stripping. The
 * device repository owns every native call. Persisted records are canonical
 * English JSON identical to the API/export shape; the extra columns are
 * denormalized copies used for lookup and newest-first ordering.
 */

/** Device database filename inside the app sandbox. */
export const WORKOUTS_DB_NAME = "fit-trace.db";

/** A stored workout row. `payload` is the source of truth for the record. */
export interface WorkoutRow {
  id: string;
  schema_version: number;
  date: string;
  session_type: string;
  payload: string;
  created_at: string;
}

/** One ordered, idempotent schema migration applied via `PRAGMA user_version`. */
export interface WorkoutMigration {
  version: number;
  statements: readonly string[];
}

export const WORKOUTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  date TEXT NOT NULL,
  session_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

export const WORKOUTS_NEWEST_FIRST_INDEX_SQL = `CREATE INDEX IF NOT EXISTS workouts_newest_first_idx
  ON workouts (date DESC, id DESC);`;

/** Ordered migrations; every entry is applied once and recorded in user_version. */
export const WORKOUTS_MIGRATIONS: readonly WorkoutMigration[] = [
  {
    version: 1,
    statements: [WORKOUTS_TABLE_SQL, WORKOUTS_NEWEST_FIRST_INDEX_SQL],
  },
];

/** Highest migration version understood by this build. */
export function latestWorkoutSchemaVersion(): number {
  let latest = 0;
  for (const migration of WORKOUTS_MIGRATIONS) {
    if (migration.version > latest) latest = migration.version;
  }
  return latest;
}

/** Current on-device schema version; bumped only by adding a migration. */
export const WORKOUTS_DB_SCHEMA_VERSION = latestWorkoutSchemaVersion();

/**
 * Migrations that still need to run for `currentVersion`.
 *
 * A database newer than this build is rejected rather than opened, so an old
 * app can never write to a schema it does not understand. `currentVersion` is
 * read from `PRAGMA user_version`; 0 means a fresh database.
 */
export function pendingWorkoutMigrations(currentVersion: number): readonly WorkoutMigration[] {
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new RangeError(`Invalid workout database schema version: ${currentVersion}.`);
  }
  if (currentVersion > WORKOUTS_DB_SCHEMA_VERSION) {
    throw new Error(
      `Workout database schema version ${currentVersion} is newer than supported ${WORKOUTS_DB_SCHEMA_VERSION}.`,
    );
  }
  return WORKOUTS_MIGRATIONS.filter((migration) => migration.version > currentVersion);
}

/**
 * Raised when a stored row or payload no longer matches the canonical shape.
 * The code mirrors the store-wide `CORRUPT_STORE` contract and the row id (when
 * known) lets the caller identify the bad record without logging its content.
 */
export class WorkoutStoreCorruptionError extends Error {
  readonly code = "CORRUPT_STORE";
  readonly rowId: string | null;

  constructor(reason: string, rowId: string | null = null) {
    super(
      rowId === null
        ? `Corrupt workout store: ${reason}`
        : `Stored workout row "${rowId}" is invalid: ${reason}`,
    );
    this.name = "WorkoutStoreCorruptionError";
    this.rowId = rowId;
  }
}

/**
 * Resolve the id for a save attempt.
 *
 * Mirrors the app clients: a caller-supplied non-empty id is preserved, so an
 * API/import record keeps its identity and retries stay idempotent. A draft
 * without an id gets the deterministic content-derived id. The id is prepared
 * before validation, exactly as the web local and HTTP clients do.
 */
export function prepareWorkoutId(record: WorkoutRecord): string {
  return typeof record.id === "string" && record.id.trim() !== ""
    ? record.id
    : deriveWorkoutId(record);
}

/** Canonical English JSON for the payload column (sorted keys, no `undefined`). */
export function encodeWorkoutPayload(record: WorkoutRecord): string {
  return stableStringify(record);
}

/**
 * Parse and re-validate a stored payload. Malformed JSON and records that no
 * longer validate both throw {@link WorkoutStoreCorruptionError} instead of
 * returning untrusted data.
 */
export function decodeWorkoutPayload(
  payload: string,
  rowId: string | null = null,
): WorkoutRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WorkoutStoreCorruptionError("payload is not valid JSON", rowId);
  }
  try {
    return validateWorkoutRecord(parsed).record;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkoutStoreCorruptionError(`payload failed validation: ${reason}`, rowId);
  }
}

/**
 * Map a validated record onto its row.
 *
 * `createdAt` is supplied by the caller so this module never reads a clock and
 * the repository can inject one in tests.
 */
export function toWorkoutRow(record: WorkoutRecord, createdAt: string): WorkoutRow {
  if (typeof createdAt !== "string" || createdAt.trim() === "") {
    throw new TypeError("createdAt must be a non-empty ISO timestamp");
  }
  return {
    id: record.id,
    schema_version: record.schema_version,
    date: record.date,
    session_type: record.session_type,
    payload: encodeWorkoutPayload(record),
    created_at: createdAt,
  };
}

/**
 * Rebuild a record from a row, failing closed if the denormalized columns no
 * longer agree with the canonical payload (for example after a partial write
 * or manual edit). The payload remains the source of truth.
 */
export function fromWorkoutRow(row: WorkoutRow): WorkoutRecord {
  const rowId = typeof row.id === "string" && row.id !== "" ? row.id : null;
  if (rowId === null) {
    throw new WorkoutStoreCorruptionError("`id` column is missing or empty");
  }
  if (typeof row.payload !== "string" || row.payload === "") {
    throw new WorkoutStoreCorruptionError("`payload` column is missing or empty", rowId);
  }
  if (typeof row.schema_version !== "number" || !Number.isInteger(row.schema_version)) {
    throw new WorkoutStoreCorruptionError("`schema_version` column is not an integer", rowId);
  }
  if (typeof row.date !== "string" || row.date === "") {
    throw new WorkoutStoreCorruptionError("`date` column is missing or empty", rowId);
  }
  if (typeof row.session_type !== "string" || row.session_type === "") {
    throw new WorkoutStoreCorruptionError("`session_type` column is missing or empty", rowId);
  }
  if (typeof row.created_at !== "string" || row.created_at === "") {
    throw new WorkoutStoreCorruptionError("`created_at` column is missing or empty", rowId);
  }

  const record = decodeWorkoutPayload(row.payload, rowId);
  if (record.id !== row.id) {
    throw new WorkoutStoreCorruptionError("`id` column does not match the payload", rowId);
  }
  if (record.schema_version !== row.schema_version) {
    throw new WorkoutStoreCorruptionError(
      "`schema_version` column does not match the payload",
      rowId,
    );
  }
  if (record.date !== row.date) {
    throw new WorkoutStoreCorruptionError("`date` column does not match the payload", rowId);
  }
  if (record.session_type !== row.session_type) {
    throw new WorkoutStoreCorruptionError(
      "`session_type` column does not match the payload",
      rowId,
    );
  }
  return record;
}

function compareDescending(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/** The instant a workout date denotes; malformed values sort as oldest. */
function workoutInstant(date: string): number {
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Newest workout first by the instant the date denotes, not by its text: the
 * validator accepts ISO timestamps, and the same instant can be written with
 * different offsets. The date text then the id provide deterministic
 * tie-breaks for equal instants.
 */
export function compareWorkoutsNewestFirst(a: WorkoutRecord, b: WorkoutRecord): number {
  const timeA = workoutInstant(a.date);
  const timeB = workoutInstant(b.date);
  if (timeA !== timeB) return timeA > timeB ? -1 : 1;
  const byDate = compareDescending(a.date, b.date);
  return byDate !== 0 ? byDate : compareDescending(a.id, b.id);
}

/** Return a newest-first copy without mutating the input. */
export function sortWorkoutsNewestFirst(records: readonly WorkoutRecord[]): WorkoutRecord[] {
  return [...records].sort(compareWorkoutsNewestFirst);
}

export type WorkoutWriteDecision =
  | { action: "insert" }
  | { action: "duplicate"; existing: WorkoutRecord }
  | { action: "conflict"; existing: WorkoutRecord };

/**
 * Compare an already-stored record with an incoming record under the same id.
 * Identical canonical content is a duplicate no-op; any difference is a
 * conflict. There is deliberately no "replace"/"overwrite" outcome.
 */
export function classifyWorkoutWrite(
  existing: WorkoutRecord | null,
  incoming: WorkoutRecord,
): WorkoutWriteDecision {
  if (existing === null) return { action: "insert" };
  if (stableStringify(existing) === stableStringify(incoming)) {
    return { action: "duplicate", existing };
  }
  return { action: "conflict", existing };
}
