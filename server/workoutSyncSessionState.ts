import { randomBytes } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkoutStore, principalDbPath } from "@agent-fit-trace/store";
import { acquireCoachingJournalLock } from "./coaching/coachingJournal.ts";
import type { CoachingJournalLock } from "./coaching/coachingJournal.ts";
import { WorkoutSyncRepository } from "./workoutSyncRepository.ts";

export interface SyncIdentity { issuer: string; accountId: string; sessionId: string; endpoint: string }
interface Active extends SyncIdentity { generation: number }
function same(a: SyncIdentity, b: SyncIdentity): boolean {
  return a.issuer === b.issuer && a.accountId === b.accountId && a.sessionId === b.sessionId && a.endpoint === b.endpoint;
}

/**
 * Verify that a disabled daemon has no active sync session. The dedicated
 * lock excludes another daemon while inspecting the durable state. A missing
 * database means sync never started; malformed or unreadable state throws.
 * The result does not claim that any bearer was durably revoked.
 */
export function hasNoActiveSyncSession(dataDir: string): boolean {
  const lock = acquireCoachingJournalLock(join(dataDir, "workout-sync-session"));
  try {
    const path = join(dataDir, "workout-sync-session.db");
    try {
      if (!statSync(path).isFile()) throw new Error("Invalid sync state file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("SELECT id, generation, issuer, account_id, session_id, endpoint FROM state").all() as {
        id: number; generation: number; issuer: string | null; account_id: string | null;
        session_id: string | null; endpoint: string | null;
      }[];
      if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].generation) || rows[0].generation < 0) {
        throw new Error("Invalid sync session state.");
      }
      const row = rows[0];
      return row.issuer === null && row.account_id === null && row.session_id === null && row.endpoint === null;
    } finally { db.close(); }
  } finally { lock.release(); }
}

/** Single-process, durable active session. No asynchronous work occurs in transitions. */
export class WorkoutSyncSessionState {
  private readonly db: DatabaseSync;
  private readonly lock: CoachingJournalLock;
  private readonly dataDir: string;
  private readonly capabilities = new Map<string, Active>();
  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.lock = acquireCoachingJournalLock(join(dataDir, "workout-sync-session"));
    try {
      this.db = new DatabaseSync(join(dataDir, "workout-sync-session.db"));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), generation INTEGER NOT NULL,
          issuer TEXT, account_id TEXT, session_id TEXT, endpoint TEXT);
        INSERT OR IGNORE INTO state (id,generation) VALUES (1,0);`);
    } catch (error) { this.lock.release(); throw error; }
  }
  close(): void { this.db.close(); this.lock.release(); }
  private active(): Active | null {
    const row = this.db.prepare("SELECT generation,issuer,account_id,session_id,endpoint FROM state WHERE id=1").get() as
      { generation: number; issuer: string | null; account_id: string | null; session_id: string | null; endpoint: string | null };
    if (row.issuer === null && row.account_id === null && row.session_id === null && row.endpoint === null) return null;
    if (!row.issuer || !row.account_id || !row.session_id || !row.endpoint) throw new Error("Invalid sync session state.");
    return { issuer: row.issuer, accountId: row.account_id, sessionId: row.session_id, endpoint: row.endpoint, generation: row.generation };
  }
  private allowed(identity: SyncIdentity): boolean {
    const store = new SqliteWorkoutStore(principalDbPath(this.dataDir, identity.accountId));
    try { return new WorkoutSyncRepository(store).isSessionAllowed(identity); } finally { store.close(); }
  }
  private revoke(identity: SyncIdentity): void {
    const store = new SqliteWorkoutStore(principalDbPath(this.dataDir, identity.accountId));
    try { new WorkoutSyncRepository(store).revokeSession(identity); } finally { store.close(); }
  }
  private revokeLeases(identity: SyncIdentity): void {
    const store = new SqliteWorkoutStore(principalDbPath(this.dataDir, identity.accountId));
    try { new WorkoutSyncRepository(store).revokeSessionLeases(identity); } finally { store.close(); }
  }
  private issue(identity: Active): string {
    if (this.capabilities.size >= 128) throw new Error("Sync capability capacity reached.");
    const cap = randomBytes(32).toString("base64url");
    this.capabilities.set(cap, identity);
    return cap;
  }
  version(): number {
    return (this.db.prepare("SELECT generation FROM state WHERE id=1").get() as { generation: number }).generation;
  }
  private write(identity: SyncIdentity | null): void {
    this.db.prepare("UPDATE state SET generation=generation+1,issuer=?,account_id=?,session_id=?,endpoint=? WHERE id=1")
      .run(identity?.issuer ?? null, identity?.accountId ?? null, identity?.sessionId ?? null, identity?.endpoint ?? null);
  }
  /** Candidate must have already passed Auth verification for its exact bearer. */
  bootstrap(candidate: SyncIdentity, expectedVersion: number): string {
    if (this.version() !== expectedVersion) throw new Error("Sync identity changed during verification.");
    const active = this.active();
    if (!this.allowed(candidate)) throw new Error("Sync session is revoked.");
    if (active === null) { this.write(candidate); return this.issue(this.active()!); }
    // Also detects an interrupted transition (active remains set but revoked).
    if (!this.allowed(active)) throw new Error("Sync session recovery required.");
    if (!same(active, candidate)) throw new Error("Sync identity transition requires the active capability.");
    return this.issue(active);
  }
  /** Synchronous guard used inside the per-account write transaction. */
  requireCurrent(capability: string, candidate: SyncIdentity): void {
    const bound = this.capabilities.get(capability);
    const active = this.active();
    if (!bound || !active || bound.generation !== active.generation || !same(bound, active) || !same(candidate, active)) {
      throw new Error("Sync capability is not current.");
    }
  }
  require(capability: string, candidate?: SyncIdentity): Active {
    const bound = this.capabilities.get(capability);
    const active = this.active();
    if (!bound || !active || bound.generation !== active.generation || !same(bound, active) ||
        (candidate && !same(candidate, active)) || !this.allowed(active)) throw new Error("Sync capability is not current.");
    return active;
  }
  transition(capability: string, candidate: SyncIdentity, cancel: (identity: SyncIdentity) => void): string {
    const old = this.require(capability);
    if (!this.allowed(candidate)) throw new Error("Sync session is revoked.");
    if (same(old, candidate)) return capability;
    // Revocation commits first. If the next operation fails or the process
    // dies, the old active tuple remains revoked and bootstrap fails closed.
    // A destination change is not a new Auth session. Cancel its old lease
    // without revoking the session; the new destination still needs consent.
    if (old.issuer === candidate.issuer && old.accountId === candidate.accountId && old.sessionId === candidate.sessionId) {
      this.revokeLeases(old);
    } else {
      this.revoke(old);
    }
    this.capabilities.clear();
    cancel(old);
    this.write(candidate);
    return this.issue(this.active()!);
  }
  /**
   * Revoke only the session authenticated by the daemon. Unlike a capability,
   * a valid bearer can recover after a renderer or daemon restart. This is
   * deliberately idempotent, including the interrupted-transition state.
   */
  revokeVerifiedSession(identity: SyncIdentity, cancel: (identity: SyncIdentity) => void): void {
    const active = this.active();
    const revokesActive = active !== null && active.issuer === identity.issuer &&
      active.accountId === identity.accountId && active.sessionId === identity.sessionId;
    // Persist before acknowledging; if a later write fails, bootstrap remains
    // fail-closed because the old active session is already revoked.
    this.revoke(identity);
    cancel(identity);
    if (revokesActive) {
      this.capabilities.clear();
      this.write(null);
    }
  }
  /** Confirm an existing durable revocation; never create one on this path. */
  confirmRevoked(identity: SyncIdentity, cancel: (identity: SyncIdentity) => void): boolean {
    const store = new SqliteWorkoutStore(principalDbPath(this.dataDir, identity.accountId));
    try {
      if (!new WorkoutSyncRepository(store).hasRevokedSession(identity)) return false;
      const active = this.active();
      if (active && active.issuer === identity.issuer && active.accountId === identity.accountId && active.sessionId === identity.sessionId) {
        cancel(active);
        this.capabilities.clear();
        this.write(null);
      }
      return true;
    } finally { store.close(); }
  }
  logout(capability: string, cancel: (identity: SyncIdentity) => void): void {
    const old = this.require(capability);
    this.revoke(old);
    this.capabilities.clear();
    cancel(old);
    this.write(null);
  }
}
