import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ConflictError,
  CorruptStoreError,
  ValidationError,
  sortRecords,
  stableStringify,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type { HistoryFilter, WorkoutRecord } from "@agent-fit-trace/core";
import { assertValidHistoryFilter, filterRecordsPage } from "./filter.ts";
import type { QueryResult } from "./filter.ts";

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    canonical TEXT NOT NULL,
    record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workouts_date_idx ON workouts(date);
`;

/** Migration is serialized with all other store writers, including MCP and pi. */
function migrateSyncSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version === 0) {
      db.exec(`
        ALTER TABLE workouts ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'
          CHECK (origin IN ('local', 'remote'));
        CREATE TABLE sync_outbox (
          workout_id TEXT PRIMARY KEY NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          account_id TEXT, endpoint TEXT,
          state TEXT NOT NULL DEFAULT 'unassigned'
            CHECK (state IN ('unassigned', 'pending', 'retry', 'complete', 'device-only')),
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT,
          updated_at TEXT NOT NULL,
          CHECK ((account_id IS NULL AND endpoint IS NULL) OR (account_id IS NOT NULL AND endpoint IS NOT NULL))
        );
        CREATE TABLE sync_revoked_session (
          issuer TEXT NOT NULL, account_id TEXT NOT NULL, session_id TEXT NOT NULL,
          PRIMARY KEY (issuer, account_id, session_id)
        );
        CREATE TABLE sync_consent (
          account_id TEXT NOT NULL, endpoint TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          PRIMARY KEY (account_id, endpoint)
        );
        CREATE TABLE sync_lease (
          account_id TEXT NOT NULL, endpoint TEXT NOT NULL, owner TEXT NOT NULL,
          generation INTEGER NOT NULL, expires_at TEXT NOT NULL, issuer TEXT NOT NULL, session_id TEXT NOT NULL,
          PRIMARY KEY (account_id, endpoint)
        );
        CREATE TABLE sync_remote_membership (
          account_id TEXT NOT NULL, endpoint TEXT NOT NULL, workout_id TEXT NOT NULL REFERENCES workouts(id),
          fingerprint TEXT NOT NULL, PRIMARY KEY (account_id, endpoint, workout_id)
        );
        CREATE TABLE sync_status (
          account_id TEXT NOT NULL, endpoint TEXT NOT NULL, last_success_at TEXT,
          PRIMARY KEY (account_id, endpoint)
        );
        INSERT INTO sync_outbox (workout_id, updated_at)
          SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM workouts;
        CREATE TRIGGER workouts_enqueue_local AFTER INSERT ON workouts
          WHEN NEW.origin = 'local'
          BEGIN
            INSERT INTO sync_outbox (workout_id, updated_at)
              VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
          END;
        PRAGMA user_version = 1;
      `);
    } else if (version !== 1) {
      throw new Error(`Unsupported workout database schema version: ${version}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

/** Milliseconds a writer waits on a locked database before giving up (busy_timeout). */
const BUSY_TIMEOUT_MS = 5000;

/**
 * The WAL switch is the one PRAGMA that can fail fast with `SQLITE_BUSY`
 * without honoring busy_timeout (another opener mid-transaction or mid-switch).
 * The mode is a persistent database property, so check-then-switch with a
 * bounded retry settles it: whichever process gets there first sets WAL for
 * everyone, and later openers only read the current mode.
 */
const WAL_SWITCH_ATTEMPTS = 10;
const WAL_SWITCH_BACKOFF_MS = 25;

function isSqliteConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function isSqliteBusyError(error: unknown): boolean {
  // node:sqlite reports SQLITE_BUSY as errcode 5 (errstr "database is locked").
  return (error as { errcode?: unknown }).errcode === 5;
}

function currentJournalMode(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  return row?.journal_mode ?? "";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function enableWal(db: DatabaseSync): void {
  for (let attempt = 1; ; attempt += 1) {
    if (currentJournalMode(db) === "wal") return;
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= WAL_SWITCH_ATTEMPTS) throw error;
      sleepSync(WAL_SWITCH_BACKOFF_MS);
    }
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction was open (already committed/rolled back) — nothing to do.
  }
}

/** Parse and re-validate one stored row; a bad row surfaces as CORRUPT_STORE with its row index. */
function parseStoredRecord(row: { record: string }, rowIndex: number): WorkoutRecord {
  try {
    return validateWorkoutRecord(JSON.parse(row.record) as unknown).record;
  } catch (error) {
    const reason =
      error instanceof ValidationError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    throw new CorruptStoreError(rowIndex, reason);
  }
}

/**
 * Multi-process-safe SQLite backend over `node:sqlite` (Node >= 24, no extra
 * dependency). WAL + busy_timeout let the daemon, the MCP server, and pi open
 * the same per-identity database file concurrently, while the public surface
 * stays identical to the JSON {@link WorkoutStore}: Promise-based
 * `all()`/`import()`/`query()` and the same error contract.
 *
 * `DatabaseSync` is synchronous, so each `BEGIN IMMEDIATE`..`COMMIT` window
 * runs to completion inside one tick and cannot interleave in-process;
 * cross-process serialization is SQLite's job.
 */
export class SqliteWorkoutStore {
  db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    try {
      // busy_timeout must come first: every later statement then waits on a
      // locked db instead of failing fast with SQLITE_BUSY. The WAL switch is
      // the one exception (see enableWal) and gets its own bounded retry.
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      enableWal(this.db);
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(CREATE_SQL);
      migrateSyncSchema(this.db);
    } catch (error) {
      // Setup failed (e.g. the file is not a database): release the handle
      // before propagating, or the descriptor leaks for the process lifetime.
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  async all(): Promise<WorkoutRecord[]> {
    const rows = this.db
      .prepare("SELECT record FROM workouts ORDER BY date")
      .all() as { record: string }[];
    return sortRecords(rows.map((row, index) => parseStoredRecord(row, index)));
  }

  async import(record: WorkoutRecord): Promise<{ duplicate: boolean; total: number }> {
    // Canonicalize the validated, normalized record (names trimmed, dates
    // coerced, ...) so stored content matches what `all()` returns and a
    // read-back re-import stays an idempotent no-op instead of a false CONFLICT.
    const validated = validateWorkoutRecord(record).record;
    const canonical = stableStringify(validated);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT canonical FROM workouts WHERE id = ?")
        .get(validated.id) as { canonical: string } | undefined;

      if (existing !== undefined) {
        this.db.exec("ROLLBACK");
        if (existing.canonical === canonical) {
          return { duplicate: true, total: this.countRecords() };
        }
        throw new ConflictError(validated.id);
      }

      try {
        this.db
          .prepare("INSERT INTO workouts (id, date, canonical, record) VALUES (?, ?, ?, ?)")
          .run(validated.id, validated.date, canonical, JSON.stringify(validated));
      } catch (error) {
        // A racing writer may have inserted the same id between BEGIN and the
        // INSERT hitting the PRIMARY KEY: map it to the same CONFLICT contract
        // as the JSON backend. SQLITE_BUSY is left to busy_timeout to absorb.
        if (isSqliteConstraintError(error)) {
          throw new ConflictError(validated.id);
        }
        throw error;
      }

      this.db.exec("COMMIT");
      return { duplicate: false, total: this.countRecords() };
    } catch (error) {
      rollbackQuietly(this.db);
      throw error;
    }
  }

  async query(filter: HistoryFilter = {}): Promise<QueryResult> {
    // Validate the filter before reading storage so a corrupt store cannot
    // mask an invalid date range with CORRUPT_STORE.
    assertValidHistoryFilter(filter);
    return filterRecordsPage(await this.all(), filter);
  }

  private countRecords(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM workouts").get() as {
      count: number;
    };
    return row.count;
  }
}
