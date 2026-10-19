import { openDatabaseAsync } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { ConflictError, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  WORKOUTS_DB_NAME,
  classifyWorkoutWrite,
  fromWorkoutRow,
  pendingWorkoutMigrations,
  prepareWorkoutId,
  toWorkoutRow,
} from "./schema";
import type { WorkoutRow } from "./schema";

/**
 * Local-first workout repository on expo-sqlite.
 *
 * The on-device database is the source of truth: reads and writes go here
 * first and the network is optional. Records stay canonical English JSON in
 * `payload`; rows are validated on every read. Storage errors are never caught
 * and converted into an empty list, so a failed read cannot look like an empty
 * history.
 */

const WORKOUT_COLUMNS = "id, schema_version, date, session_type, payload, created_at";
const SELECT_WORKOUTS_NEWEST_FIRST_SQL =
  `SELECT ${WORKOUT_COLUMNS} FROM workouts ORDER BY date DESC, id DESC;`;
const SELECT_WORKOUT_BY_ID_SQL = `SELECT ${WORKOUT_COLUMNS} FROM workouts WHERE id = ? LIMIT 1;`;
// `DO NOTHING` (rather than `OR REPLACE`) is the database-level guarantee that
// an existing id is never overwritten. `changes === 0` means the id was
// already present; the caller then classifies it as duplicate or conflict.
const INSERT_WORKOUT_SQL = `INSERT INTO workouts (${WORKOUT_COLUMNS})
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING;`;
const COUNT_WORKOUTS_SQL = "SELECT COUNT(*) AS count FROM workouts;";

/** Result of an idempotent save: the record id plus whether a row was inserted. */
export interface SaveWorkoutResult {
  id: string;
  created: boolean;
}

export interface WorkoutRepositoryOptions {
  /** Injectable clock for `created_at`; production uses the system clock. */
  now?: () => Date;
}

/**
 * Apply pending migrations using `PRAGMA user_version`.
 *
 * Each migration is transactional: the DDL and its version bump commit
 * together. Calling this again on an up-to-date database is a no-op, and a
 * database written by a newer app version is rejected by
 * {@link pendingWorkoutMigrations}.
 */
export async function migrateWorkoutDatabase(database: SQLiteDatabase): Promise<void> {
  const row = await database.getFirstAsync<{ user_version: number }>("PRAGMA user_version;");
  const currentVersion = row?.user_version ?? 0;
  for (const migration of pendingWorkoutMigrations(currentVersion)) {
    await database.withTransactionAsync(async () => {
      for (const statement of migration.statements) {
        await database.execAsync(statement);
      }
      await database.execAsync(`PRAGMA user_version = ${migration.version};`);
    });
  }
}

/**
 * Open the local workout database, enable WAL and apply migrations.
 *
 * The database is closed again if setup fails, so a half-configured connection
 * is never handed to the repository.
 */
export async function openWorkoutDatabase(): Promise<SQLiteDatabase> {
  const database = await openDatabaseAsync(WORKOUTS_DB_NAME);
  try {
    const journalMode = await database.getFirstAsync<{ journal_mode: string }>(
      "PRAGMA journal_mode = WAL;",
    );
    if (journalMode === null || journalMode.journal_mode.toLowerCase() !== "wal") {
      throw new Error("Unable to enable SQLite WAL journal mode for the workout store.");
    }
    await migrateWorkoutDatabase(database);
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

/**
 * Append-only workout repository.
 *
 * `saveWorkout` is idempotent by id: an existing identical record is a
 * `created: false` no-op, and the same id with different content throws
 * {@link ConflictError}. The insert statement itself never overwrites, so
 * concurrent saves cannot replace an original record either.
 */
export class WorkoutRepository {
  private readonly database: SQLiteDatabase;
  private readonly now: () => Date;

  constructor(database: SQLiteDatabase, options: WorkoutRepositoryOptions = {}) {
    this.database = database;
    this.now = options.now ?? (() => new Date());
  }

  /** Every stored workout, newest first. Stored rows are re-validated. */
  async listWorkouts(): Promise<WorkoutRecord[]> {
    const rows = await this.database.getAllAsync<WorkoutRow>(SELECT_WORKOUTS_NEWEST_FIRST_SQL);
    return rows.map(fromWorkoutRow);
  }

  /** One workout by id, or `null` when it is not stored. */
  async getWorkout(id: string): Promise<WorkoutRecord | null> {
    if (typeof id !== "string" || id.trim() === "") {
      throw new TypeError("Workout id must be a non-empty string.");
    }
    const row = await this.database.getFirstAsync<WorkoutRow>(SELECT_WORKOUT_BY_ID_SQL, id);
    return row === null ? null : fromWorkoutRow(row);
  }

  /**
   * Validate and insert a workout, deriving an id from content only when the
   * caller supplied none. This matches the web local/HTTP clients: a supplied
   * id is preserved so retried submits stay idempotent across transports.
   */
  async saveWorkout(record: WorkoutRecord): Promise<SaveWorkoutResult> {
    const normalized = validateWorkoutRecord({
      ...record,
      id: prepareWorkoutId(record),
    }).record;
    const row = toWorkoutRow(normalized, this.now().toISOString());

    const result = await this.database.runAsync(INSERT_WORKOUT_SQL, [
      row.id,
      row.schema_version,
      row.date,
      row.session_type,
      row.payload,
      row.created_at,
    ]);
    if (result.changes > 0) {
      return { id: row.id, created: true };
    }

    // The insert was ignored because this id already exists. Read the stored
    // row and classify it; never fall back to an update.
    const existingRow = await this.database.getFirstAsync<WorkoutRow>(
      SELECT_WORKOUT_BY_ID_SQL,
      row.id,
    );
    if (existingRow === null) {
      throw new Error(`Workout "${row.id}" was not inserted but no existing row was found.`);
    }

    switch (classifyWorkoutWrite(fromWorkoutRow(existingRow), normalized).action) {
      case "duplicate":
        return { id: row.id, created: false };
      case "conflict":
        throw new ConflictError(row.id);
      case "insert":
        throw new Error(`Workout "${row.id}" exists but was classified as absent.`);
    }
  }

  /** Number of stored workouts; fails closed if the count cannot be read. */
  async countWorkouts(): Promise<number> {
    const row = await this.database.getFirstAsync<{ count: number }>(COUNT_WORKOUTS_SQL);
    if (row === null) {
      throw new Error("Unable to count stored workouts.");
    }
    return row.count;
  }
}
