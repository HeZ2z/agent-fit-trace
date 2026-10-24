import type { SQLiteDatabase } from "expo-sqlite";
import type { SessionDraft } from "@agent-fit-trace/workout-session";
import {
  fromSessionDraftRow,
  requireSessionDraftOwnerId,
  toSessionDraftRow,
} from "./sessionDraftSchema";
import type { SessionDraftRow } from "./sessionDraftSchema";

/**
 * Native persistence for the single unfinished workout-session draft.
 *
 * The draft shares the on-device database connection with the workout store, so
 * the SQLite setup, WAL mode and versioned migrations under `PRAGMA
 * user_version` apply to both. Only the draft is stored: the live rest timer
 * belongs to `SessionRuntime` and never reaches this repository.
 *
 * One row per owner (the table's primary key). `save` upserts that row and
 * `load` returns `null` when the owner has no draft. Corruption is never
 * converted into "no draft": a bad payload surfaces the shared
 * `SessionDraftCorruptionError` so the UI can ask for an explicit discard, and
 * storage errors propagate untouched.
 */
const SESSION_DRAFT_COLUMNS = "owner_id, payload, updated_at";
const SELECT_SESSION_DRAFT_SQL =
  `SELECT ${SESSION_DRAFT_COLUMNS} FROM session_draft WHERE owner_id = ? LIMIT 1;`;
const UPSERT_SESSION_DRAFT_SQL = `INSERT INTO session_draft (${SESSION_DRAFT_COLUMNS})
VALUES (?, ?, ?)
ON CONFLICT(owner_id) DO UPDATE SET
  payload = excluded.payload,
  updated_at = excluded.updated_at;`;
const DELETE_SESSION_DRAFT_SQL = "DELETE FROM session_draft WHERE owner_id = ?;";

export interface SessionDraftRepositoryOptions {
  /** Injectable clock for `updated_at`; production uses the system clock. */
  now?: () => Date;
}

/** Owner-scoped read/write access to the single stored session draft. */
export class SessionDraftRepository {
  private readonly database: SQLiteDatabase;
  private readonly now: () => Date;

  constructor(database: SQLiteDatabase, options: SessionDraftRepositoryOptions = {}) {
    this.database = database;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Read and decode the owner's draft, or `null` when none is stored.
   *
   * A corrupt or unsupported payload throws the shared
   * `SessionDraftCorruptionError`; a storage failure is never reported as an
   * empty draft.
   */
  async load(ownerId: string): Promise<SessionDraft | null> {
    const row = await this.database.getFirstAsync<SessionDraftRow>(
      SELECT_SESSION_DRAFT_SQL,
      requireSessionDraftOwnerId(ownerId),
    );
    return row === null ? null : fromSessionDraftRow(row);
  }

  /** Persist exactly one draft for the owner, replacing any previous row. */
  async save(ownerId: string, draft: SessionDraft): Promise<void> {
    const row = toSessionDraftRow(ownerId, draft, this.now().toISOString());
    await this.database.runAsync(UPSERT_SESSION_DRAFT_SQL, [
      row.owner_id,
      row.payload,
      row.updated_at,
    ]);
  }

  /** Delete the owner's draft (successful save or an explicit discard). */
  async clear(ownerId: string): Promise<void> {
    await this.database.runAsync(DELETE_SESSION_DRAFT_SQL, [requireSessionDraftOwnerId(ownerId)]);
  }
}
