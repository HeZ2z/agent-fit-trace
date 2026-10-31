import { openDatabaseAsync } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { ConflictError, stableStringify, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import {
  WORKOUTS_DB_NAME,
  classifyWorkoutWrite,
  fromWorkoutRow,
  sortWorkoutsNewestFirst,
  pendingWorkoutMigrations,
  prepareWorkoutId,
  toWorkoutRow,
} from "./schema.ts";
import type { WorkoutRow } from "./schema.ts";
import type { SyncLease, SyncScope } from "./schema.ts";

/**
 * Local-first workout repository on expo-sqlite.
 *
 * The on-device database is the source of truth: reads and writes go here
 * first and the network is optional. Records stay canonical English JSON in
 * `payload`; rows are validated on every read. Storage errors are never caught
 * and converted into an empty list, so a failed read cannot look like an empty
 * history.
 */

const WORKOUT_COLUMNS = "id, schema_version, date, session_type, payload, created_at, origin";
const SELECT_WORKOUTS_NEWEST_FIRST_SQL =
  `SELECT ${WORKOUT_COLUMNS} FROM workouts ORDER BY date DESC, id DESC;`;
const SELECT_WORKOUT_BY_ID_SQL = `SELECT ${WORKOUT_COLUMNS} FROM workouts WHERE id = ? LIMIT 1;`;
// `DO NOTHING` (rather than `OR REPLACE`) is the database-level guarantee that
// an existing id is never overwritten. `changes === 0` means the id was
// already present; the caller then classifies it as duplicate or conflict.
const INSERT_WORKOUT_SQL = `INSERT INTO workouts (id, schema_version, date, session_type, payload, created_at, origin)
VALUES (?, ?, ?, ?, ?, ?, ?)
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

export interface SyncConflictAcknowledgement {
  workoutId: string;
  localFingerprint: string;
  remoteFingerprint: string;
  action: "keep-cloud" | "keep-local" | "export-local";
}

export interface SyncStatusSnapshot {
  pendingCount: number;
  lastSuccessAt: string | null;
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

  /** Acquire an expired/free per-account lease; takeover increments its fence. */
  async acquireSyncLease(scope: SyncScope, owner: string, now: Date, ttlMs = 30_000): Promise<SyncLease | null> {
    if (!owner.trim() || !Number.isFinite(ttlMs) || ttlMs < 1) return null;
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    let changes = 0;
    await this.database.withTransactionAsync(async () => {
      const result = await this.database.runAsync(
        `INSERT INTO sync_lease (account_id, endpoint, owner, generation, expires_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(account_id, endpoint) DO UPDATE SET owner = excluded.owner,
           generation = sync_lease.generation + 1, expires_at = excluded.expires_at
         WHERE sync_lease.expires_at <= ?`,
        scope.accountId, scope.endpoint, owner, expiresAt, nowIso,
      );
      changes = result.changes;
    });
    if (changes === 0) return null;
    const row = await this.database.getFirstAsync<SyncLease>(
      "SELECT owner, generation, expires_at AS expiresAt FROM sync_lease WHERE account_id = ? AND endpoint = ? LIMIT 1",
      scope.accountId, scope.endpoint,
    );
    return row?.owner === owner ? row : null;
  }

  async renewSyncLease(scope: SyncScope, now: Date, ttlMs = 30_000): Promise<boolean> {
    if (scope.leaseOwner === undefined || scope.leaseGeneration === undefined) return false;
    const result = await this.database.runAsync(
      `UPDATE sync_lease SET expires_at = ? WHERE account_id = ? AND endpoint = ?
       AND owner = ? AND generation = ? AND expires_at > ?`,
      new Date(now.getTime() + ttlMs).toISOString(), scope.accountId, scope.endpoint,
      scope.leaseOwner, scope.leaseGeneration, now.toISOString(),
    );
    return result.changes === 1;
  }

  async isSyncLeaseCurrent(scope: SyncScope, now: Date): Promise<boolean> {
    if (scope.leaseOwner === undefined || scope.leaseGeneration === undefined) return false;
    const row = await this.database.getFirstAsync<{ owner: string }>(
      `SELECT owner FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ?
       AND generation = ? AND expires_at > ? LIMIT 1`,
      scope.accountId, scope.endpoint, scope.leaseOwner, scope.leaseGeneration, now.toISOString(),
    );
    return row !== null;
  }

  async releaseSyncLease(scope: SyncScope): Promise<void> {
    if (scope.leaseOwner === undefined || scope.leaseGeneration === undefined) return;
    await this.database.runAsync(
      `DELETE FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ? AND generation = ?`,
      scope.accountId, scope.endpoint, scope.leaseOwner, scope.leaseGeneration,
    );
  }

  /** Every stored workout, newest first. Stored rows are re-validated. */
  async listWorkouts(): Promise<WorkoutRecord[]> {
    const rows = await this.database.getAllAsync<WorkoutRow>(SELECT_WORKOUTS_NEWEST_FIRST_SQL);
    // SQL ordering is lexical; re-sort by instant so offset timestamps stay correct.
    return sortWorkoutsNewestFirst(rows.map(fromWorkoutRow));
  }

  /** Local history plus remote records reconciled for this exact account/API. */
  async listSyncWorkouts(scope: SyncScope): Promise<WorkoutRecord[]> {
    const rows = await this.database.getAllAsync<WorkoutRow>(
      `SELECT w.id, w.schema_version, w.date, w.session_type, w.payload, w.created_at, w.origin
       FROM workouts w WHERE w.origin IN ('local', 'legacy') OR EXISTS (
         SELECT 1 FROM sync_remote_membership m WHERE m.workout_id = w.id
           AND m.account_id = ? AND m.endpoint = ? AND m.fingerprint = w.payload
       ) ORDER BY w.date DESC, w.id DESC;`,
      scope.accountId,
      scope.endpoint,
    );
    return sortWorkoutsNewestFirst(rows.map(fromWorkoutRow));
  }

  async linkRemoteMembership(scope: SyncScope, record: WorkoutRecord): Promise<void> {
    const now = this.now().toISOString();
    const fenced = scope.leaseOwner !== undefined && scope.leaseGeneration !== undefined;
    const result = await this.database.runAsync(
      fenced
        ? `INSERT INTO sync_remote_membership (account_id, endpoint, workout_id, fingerprint, pulled_at)
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ?
               AND generation = ? AND expires_at > ?
           ) AND EXISTS (
             SELECT 1 FROM sync_consent WHERE account_id = ? AND endpoint = ? AND enabled = 1
           ) ON CONFLICT(account_id, endpoint, workout_id) DO UPDATE SET
             fingerprint = excluded.fingerprint, pulled_at = excluded.pulled_at`
        : `INSERT INTO sync_remote_membership (account_id, endpoint, workout_id, fingerprint, pulled_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, endpoint, workout_id) DO UPDATE SET
             fingerprint = excluded.fingerprint, pulled_at = excluded.pulled_at`,
      ...(fenced
        ? [scope.accountId, scope.endpoint, record.id, stableStringify(record), now,
            scope.accountId, scope.endpoint, scope.leaseOwner!, scope.leaseGeneration!, now,
            scope.accountId, scope.endpoint]
        : [scope.accountId, scope.endpoint, record.id, stableStringify(record), now]),
    );
    if (fenced && result.changes !== 1) throw new Error("Sync lease expired before remote membership was stored.");
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
  async saveWorkout(
    record: WorkoutRecord,
    options: { origin?: "local" | "remote"; scope?: SyncScope } = {},
  ): Promise<SaveWorkoutResult> {
    const normalized = validateWorkoutRecord({
      ...record,
      id: prepareWorkoutId(record),
    }).record;
    const row = toWorkoutRow(normalized, this.now().toISOString());

    const origin = options.origin ?? "local";
    let inserted = false;
    await this.database.withTransactionAsync(async () => {
      const scope = options.scope;
      const fenced = origin === "remote" && scope?.leaseOwner !== undefined && scope.leaseGeneration !== undefined;
      const insertSql = fenced
        ? `INSERT INTO workouts (id, schema_version, date, session_type, payload, created_at, origin)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ?
               AND generation = ? AND expires_at > ?
             ) AND EXISTS (
               SELECT 1 FROM sync_consent WHERE account_id = ? AND endpoint = ? AND enabled = 1
           ) ON CONFLICT(id) DO NOTHING;`
        : INSERT_WORKOUT_SQL;
      const values: (string | number)[] = [
        row.id,
        row.schema_version,
        row.date,
        row.session_type,
        row.payload,
        row.created_at,
        origin,
      ];
      if (fenced && scope !== undefined) {
        values.push(scope.accountId, scope.endpoint, scope.leaseOwner!, scope.leaseGeneration!, this.now().toISOString(),
          scope.accountId, scope.endpoint);
      }
      const result = await this.database.runAsync(insertSql, values);
      inserted = result.changes > 0;
      if (inserted && origin === "local") {
        const scope = options.scope;
        if (scope !== undefined) {
          await this.database.runAsync(
            `INSERT INTO sync_outbox (workout_id, account_id, endpoint, state, updated_at)
             SELECT ?, ?, ?, 'pending', ? WHERE EXISTS (
               SELECT 1 FROM sync_consent WHERE account_id = ? AND endpoint = ? AND enabled = 1
             )`,
            row.id, scope.accountId, scope.endpoint, row.created_at, scope.accountId, scope.endpoint,
          );
        }
        const count = await this.database.getFirstAsync<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sync_outbox WHERE workout_id = ?",
          row.id,
        );
        if ((count?.count ?? 0) === 0) {
          await this.database.runAsync(
            `INSERT INTO sync_outbox (workout_id, state, updated_at) VALUES (?, 'unassigned', ?)`,
            row.id, row.created_at,
          );
        }
      }
      if (inserted && origin === "remote" && options.scope !== undefined) {
        await this.database.runAsync(
          `INSERT INTO sync_remote_membership (account_id, endpoint, workout_id, fingerprint, pulled_at)
           VALUES (?, ?, ?, ?, ?)`,
          options.scope.accountId,
          options.scope.endpoint,
          row.id,
          stableStringify(normalized),
          row.created_at,
        );
      }
    });
    if (inserted) {
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
    throw new Error(`Workout "${row.id}" has an unknown write classification.`);
  }

  /** Pending records explicitly enrolled for this account and endpoint only. */
  async listUploadCandidates(scope: SyncScope): Promise<WorkoutRecord[]> {
    const rows = await this.database.getAllAsync<WorkoutRow>(
      `SELECT w.${"id"}, w.schema_version, w.date, w.session_type, w.payload, w.created_at, w.origin
       FROM workouts w JOIN sync_outbox o ON o.workout_id = w.id
       WHERE o.account_id = ? AND o.endpoint = ? AND o.state IN ('pending', 'retry')
         AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
       ORDER BY w.date DESC, w.id DESC;`,
      scope.accountId,
      scope.endpoint,
      this.now().toISOString(),
    );
    return sortWorkoutsNewestFirst(rows.map(fromWorkoutRow));
  }

  async isSyncEnabled(scope: SyncScope): Promise<boolean> {
    const row = await this.database.getFirstAsync<{ enabled: number }>(
      "SELECT enabled FROM sync_consent WHERE account_id = ? AND endpoint = ? LIMIT 1",
      scope.accountId,
      scope.endpoint,
    );
    return row?.enabled === 1;
  }

  async countUnassignedLocalWorkouts(): Promise<number> {
    const row = await this.database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workouts w LEFT JOIN sync_outbox o ON o.workout_id = w.id
       WHERE w.origin IN ('local', 'legacy') AND (o.workout_id IS NULL OR o.state IN ('unassigned', 'device-only'))`,
    );
    return row?.count ?? 0;
  }

  async getSyncStatus(scope: SyncScope): Promise<SyncStatusSnapshot> {
    const [pending, success] = await Promise.all([
      this.database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sync_outbox WHERE account_id = ? AND endpoint = ?
         AND state IN ('pending', 'retry')`, scope.accountId, scope.endpoint,
      ),
      this.database.getFirstAsync<{ last_success_at: string | null }>(
        "SELECT last_success_at FROM sync_status WHERE account_id = ? AND endpoint = ? LIMIT 1",
        scope.accountId, scope.endpoint,
      ),
    ]);
    return { pendingCount: pending?.count ?? 0, lastSuccessAt: success?.last_success_at ?? null };
  }

  async recordSuccessfulReconciliation(scope: SyncScope): Promise<void> {
    const timestamp = this.now().toISOString();
    const fenced = scope.leaseOwner !== undefined && scope.leaseGeneration !== undefined;
    const result = await this.database.runAsync(
      fenced
        ? `INSERT INTO sync_status (account_id, endpoint, last_success_at, updated_at)
           SELECT ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ?
               AND generation = ? AND expires_at > ?
           ) AND EXISTS (
             SELECT 1 FROM sync_consent WHERE account_id = ? AND endpoint = ? AND enabled = 1
           ) ON CONFLICT(account_id, endpoint) DO UPDATE SET last_success_at = excluded.last_success_at,
             updated_at = excluded.updated_at`
        : `INSERT INTO sync_status (account_id, endpoint, last_success_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, endpoint) DO UPDATE SET last_success_at = excluded.last_success_at,
             updated_at = excluded.updated_at`,
      ...(fenced
        ? [scope.accountId, scope.endpoint, timestamp, timestamp,
          scope.accountId, scope.endpoint, scope.leaseOwner!, scope.leaseGeneration!, timestamp,
          scope.accountId, scope.endpoint]
        : [scope.accountId, scope.endpoint, timestamp, timestamp]),
    );
    if (fenced && result.changes !== 1) throw new Error("Sync lease or consent expired before reconciliation status was stored.");
  }

  async markUploadComplete(scope: SyncScope, workoutId: string): Promise<void> {
    const now = this.now().toISOString();
    const fenced = scope.leaseOwner !== undefined && scope.leaseGeneration !== undefined;
    const result = await this.database.runAsync(
      fenced
        ? `UPDATE sync_outbox SET state = 'complete', last_error = NULL, next_attempt_at = NULL, updated_at = ?
           WHERE workout_id = ? AND account_id = ? AND endpoint = ? AND EXISTS (
             SELECT 1 FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ?
               AND generation = ? AND expires_at > ?
           ) AND EXISTS (
             SELECT 1 FROM sync_consent WHERE account_id = ? AND endpoint = ? AND enabled = 1
           )`
        : `UPDATE sync_outbox SET state = 'complete', last_error = NULL, next_attempt_at = NULL, updated_at = ?
           WHERE workout_id = ? AND account_id = ? AND endpoint = ?`,
      ...(fenced
        ? [now, workoutId, scope.accountId, scope.endpoint, scope.accountId, scope.endpoint,
            scope.leaseOwner!, scope.leaseGeneration!, now, scope.accountId, scope.endpoint]
        : [now, workoutId, scope.accountId, scope.endpoint]),
    );
    if (fenced && result.changes !== 1) throw new Error("Sync lease expired before upload completion was stored.");
  }

  async markConflictDeviceOnly(scope: SyncScope, workoutId: string): Promise<void> {
    await this.database.runAsync(
      `UPDATE sync_outbox SET state = 'device-only', next_attempt_at = NULL, updated_at = ?
       WHERE workout_id = ? AND account_id = ? AND endpoint = ?`,
      this.now().toISOString(), workoutId, scope.accountId, scope.endpoint,
    );
  }

  async scheduleUploadRetry(
    scope: SyncScope,
    workoutId: string,
  ): Promise<void> {
    const now = this.now();
    const row = await this.database.getFirstAsync<{ attempts: number }>(
      `SELECT attempts FROM sync_outbox WHERE workout_id = ? AND account_id = ? AND endpoint = ? LIMIT 1`,
      workoutId, scope.accountId, scope.endpoint,
    );
    if (row === null) return;
    const delayMs = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(row.attempts, 10));
    const jitteredDelay = Math.round(delayMs * (0.8 + Math.random() * 0.4));
    const nextAttemptAt = new Date(now.getTime() + jitteredDelay).toISOString();
    const fenced = scope.leaseOwner !== undefined && scope.leaseGeneration !== undefined;
    const result = await this.database.runAsync(
      fenced
        ? `UPDATE sync_outbox SET state = 'retry', attempts = attempts + 1, next_attempt_at = ?,
           last_error = 'retryable', updated_at = ? WHERE workout_id = ? AND account_id = ? AND endpoint = ?
           AND EXISTS (SELECT 1 FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ?
             AND generation = ? AND expires_at > ?) AND EXISTS (
               SELECT 1 FROM sync_consent WHERE account_id = ? AND endpoint = ? AND enabled = 1
             )`
        : `UPDATE sync_outbox SET state = 'retry', attempts = attempts + 1, next_attempt_at = ?,
           last_error = 'retryable', updated_at = ? WHERE workout_id = ? AND account_id = ? AND endpoint = ?`,
      ...(fenced
        ? [nextAttemptAt, now.toISOString(), workoutId, scope.accountId, scope.endpoint,
          scope.accountId, scope.endpoint, scope.leaseOwner!, scope.leaseGeneration!, now.toISOString(),
          scope.accountId, scope.endpoint]
        : [nextAttemptAt, now.toISOString(), workoutId, scope.accountId, scope.endpoint]),
    );
    if (fenced && result.changes !== 1) throw new Error("Sync lease expired before upload retry was stored.");
  }

  async listConflictAcknowledgements(scope: SyncScope): Promise<SyncConflictAcknowledgement[]> {
    return this.database.getAllAsync<SyncConflictAcknowledgement>(
      `SELECT workout_id AS workoutId, local_fingerprint AS localFingerprint,
       remote_fingerprint AS remoteFingerprint, action FROM sync_conflict_ack
       WHERE account_id = ? AND endpoint = ?`,
      scope.accountId,
      scope.endpoint,
    );
  }

  async acknowledgeConflict(
    scope: SyncScope,
    acknowledgement: SyncConflictAcknowledgement,
  ): Promise<void> {
    await this.database.runAsync(
      `INSERT INTO sync_conflict_ack (account_id, endpoint, workout_id, local_fingerprint,
       remote_fingerprint, action, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, endpoint, workout_id) DO UPDATE SET
       local_fingerprint = excluded.local_fingerprint, remote_fingerprint = excluded.remote_fingerprint,
       action = excluded.action, acknowledged_at = excluded.acknowledged_at`,
      scope.accountId, scope.endpoint, acknowledgement.workoutId,
      acknowledgement.localFingerprint, acknowledgement.remoteFingerprint,
      acknowledgement.action, this.now().toISOString(),
    );
  }

  /**
   * Explicitly enables sync for one account/endpoint. Existing rows are
   * enrolled only when the user selected that option; future local saves are
   * enrolled by the coordinator while consent remains enabled.
   */
  async enableSync(scope: SyncScope, includeExisting: boolean): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.database.withTransactionAsync(async () => {
      await this.database.runAsync(
        `INSERT INTO sync_consent (account_id, endpoint, enabled, include_existing, enrollment_cutoff, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(account_id, endpoint) DO UPDATE SET enabled = 1, include_existing = excluded.include_existing,
           enrollment_cutoff = excluded.enrollment_cutoff, updated_at = excluded.updated_at`,
        scope.accountId,
        scope.endpoint,
        includeExisting ? 1 : 0,
        timestamp,
        timestamp,
      );
      if (includeExisting) {
        await this.database.runAsync(
          `UPDATE sync_outbox SET account_id = ?, endpoint = ?, state = 'pending', updated_at = ?
           WHERE (state = 'unassigned' OR (state = 'device-only' AND (account_id IS NULL OR (account_id = ? AND endpoint = ?))))
             AND workout_id IN (SELECT id FROM workouts WHERE origin IN ('local', 'legacy'))`,
          scope.accountId,
          scope.endpoint,
          timestamp,
          scope.accountId,
          scope.endpoint,
        );
      } else {
        await this.database.runAsync(
          `UPDATE sync_outbox SET state = 'device-only', updated_at = ? WHERE state = 'unassigned'`,
          timestamp,
        );
      }
    });
  }

  async disableSync(scope: SyncScope): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.database.withTransactionAsync(async () => {
      await this.database.runAsync(
        `UPDATE sync_consent SET enabled = 0, updated_at = ? WHERE account_id = ? AND endpoint = ?`,
        timestamp, scope.accountId, scope.endpoint,
      );
      await this.database.runAsync(
        `UPDATE sync_outbox SET state = 'device-only', updated_at = ? WHERE account_id = ? AND endpoint = ?`,
        timestamp, scope.accountId, scope.endpoint,
      );
    });
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
