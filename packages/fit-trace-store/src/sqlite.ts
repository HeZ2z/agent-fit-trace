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
import { filterRecordsPage } from "./filter.ts";
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
    // busy_timeout must come first: every later statement then waits on a
    // locked db instead of failing fast with SQLITE_BUSY. The WAL switch is
    // the one exception (see enableWal) and gets its own bounded retry.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(this.db);
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(CREATE_SQL);
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
    const canonical = stableStringify(record);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT canonical FROM workouts WHERE id = ?")
        .get(record.id) as { canonical: string } | undefined;

      if (existing !== undefined) {
        this.db.exec("ROLLBACK");
        if (existing.canonical === canonical) {
          return { duplicate: true, total: this.countRecords() };
        }
        throw new ConflictError(record.id);
      }

      try {
        this.db
          .prepare("INSERT INTO workouts (id, date, canonical, record) VALUES (?, ?, ?, ?)")
          .run(record.id, record.date, canonical, JSON.stringify(record));
      } catch (error) {
        // A racing writer may have inserted the same id between BEGIN and the
        // INSERT hitting the PRIMARY KEY: map it to the same CONFLICT contract
        // as the JSON backend. SQLITE_BUSY is left to busy_timeout to absorb.
        if (isSqliteConstraintError(error)) {
          throw new ConflictError(record.id);
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
    return filterRecordsPage(await this.all(), filter);
  }

  private countRecords(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM workouts").get() as {
      count: number;
    };
    return row.count;
  }
}
