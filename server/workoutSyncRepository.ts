import { ConflictError, stableStringify, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { SqliteWorkoutStore } from "@agent-fit-trace/store";
import type { SyncLease, SyncScope } from "../packages/fit-trace-sync/src/types.ts";
import type { SyncRunRepository } from "../packages/fit-trace-sync/src/syncRunner.ts";

/** Node adapter. All sync-owned local mutations check consent and lease while holding the SQLite write lock. */
export class WorkoutSyncRepository implements SyncRunRepository {
  private readonly store: SqliteWorkoutStore;
  private readonly guard: () => void;
  private heldLease: SyncLease | null = null;
  constructor(store: SqliteWorkoutStore, guard: () => void = () => {}) { this.store = store; this.guard = guard; }

  private transaction<T>(fn: () => T): T {
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private assertSessionAllowed(scope: SyncScope): void {
    this.guard();
    if (!scope.issuer || !scope.sessionId || this.store.db.prepare(
      "SELECT 1 FROM sync_revoked_session WHERE issuer=? AND account_id=? AND session_id=?"
    ).get(scope.issuer, scope.accountId, scope.sessionId)) throw new Error("Sync session is revoked or missing.");
  }

  isSessionAllowed(scope: SyncScope): boolean {
    try { this.assertSessionAllowed(scope); return true; } catch { return false; }
  }

  hasRevokedSession(scope: SyncScope): boolean {
    if (!scope.issuer || !scope.sessionId) throw new Error("Verified sync session required.");
    return !!this.store.db.prepare("SELECT 1 FROM sync_revoked_session WHERE issuer=? AND account_id=? AND session_id=?")
      .get(scope.issuer, scope.accountId, scope.sessionId);
  }

  revokeSessionLeases(scope: SyncScope): void {
    if (!scope.issuer || !scope.sessionId) throw new Error("Verified sync session required.");
    this.transaction(() => {
      this.assertSessionAllowed(scope);
      this.store.db.prepare("DELETE FROM sync_lease WHERE account_id=? AND issuer=? AND session_id=?")
        .run(scope.accountId, scope.issuer!, scope.sessionId!);
    });
  }

  /** Persist before acknowledging logout; no access-token TTL can safely expire this record. */
  revokeSession(scope: SyncScope): void {
    if (!scope.issuer || !scope.sessionId) throw new Error("Verified sync session required.");
    // The revocation must reach durable storage before a later active-session
    // commit can acknowledge the transition, even after sudden power loss.
    this.store.db.exec("PRAGMA synchronous=FULL");
    this.transaction(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO sync_revoked_session VALUES (?, ?, ?)")
        .run(scope.issuer!, scope.accountId, scope.sessionId!);
      this.store.db.prepare("DELETE FROM sync_lease WHERE account_id=? AND issuer=? AND session_id=?")
        .run(scope.accountId, scope.issuer!, scope.sessionId!);
    });
  }

  private fence(scope: SyncScope): void {
    this.assertSessionAllowed(scope);
    if (!scope.leaseOwner || scope.leaseGeneration === undefined || !this.store.db.prepare(`
      SELECT 1 FROM sync_lease l JOIN sync_consent c ON c.account_id=l.account_id AND c.endpoint=l.endpoint
      WHERE l.account_id=? AND l.endpoint=? AND l.owner=? AND l.generation=? AND l.expires_at>? AND c.enabled=1 AND l.issuer=? AND l.session_id=?
    `).get(scope.accountId, scope.endpoint, scope.leaseOwner, scope.leaseGeneration, new Date().toISOString(), scope.issuer!, scope.sessionId!)) {
      throw new Error("Sync consent or lease is no longer valid.");
    }
  }

  /** Check the exact lease this repository acquired immediately before network I/O. */
  assertNetworkLeaseCurrent(scope: SyncScope): void {
    if (this.heldLease === null) throw new Error("Sync lease is not held.");
    this.fence({ ...scope, leaseOwner: this.heldLease.owner, leaseGeneration: this.heldLease.generation });
  }

  /** A deliberate whole-account opt-in; old local rows are included. */
  enableSync(scope: SyncScope): void {
    this.transaction(() => {
      this.assertSessionAllowed(scope);
      // A change of destination revokes the previous destination's consent and leases.
      this.store.db.prepare("UPDATE sync_consent SET enabled=0 WHERE account_id=? AND endpoint<>?").run(scope.accountId, scope.endpoint);
      this.store.db.prepare("DELETE FROM sync_lease WHERE account_id=? AND endpoint<>?").run(scope.accountId, scope.endpoint);
      this.store.db.prepare(`INSERT INTO sync_consent VALUES (?, ?, 1)
        ON CONFLICT(account_id, endpoint) DO UPDATE SET enabled=1`).run(scope.accountId, scope.endpoint);
      this.store.db.prepare(`UPDATE sync_outbox SET account_id=?, endpoint=?, state='pending', updated_at=?
        WHERE state='unassigned' OR account_id=?`)
        .run(scope.accountId, scope.endpoint, new Date().toISOString(), scope.accountId);
    });
  }

  disableSync(scope: SyncScope): void {
    this.transaction(() => {
      this.assertSessionAllowed(scope);
      this.store.db.prepare("UPDATE sync_consent SET enabled=0 WHERE account_id=? AND endpoint=?").run(scope.accountId, scope.endpoint);
      this.store.db.prepare("DELETE FROM sync_lease WHERE account_id=? AND endpoint=?").run(scope.accountId, scope.endpoint);
    });
  }

  async isSyncEnabled(scope: SyncScope): Promise<boolean> {
    return !!this.store.db.prepare("SELECT 1 FROM sync_consent WHERE account_id=? AND endpoint=? AND enabled=1").get(scope.accountId, scope.endpoint);
  }
  async acquireSyncLease(scope: SyncScope, owner: string, now: Date, ttlMs = 30_000): Promise<SyncLease | null> {
    return this.transaction(() => {
      this.assertSessionAllowed(scope);
      if (!owner.trim() || !Number.isFinite(ttlMs) || ttlMs < 1) return null;
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const result = this.store.db.prepare(`INSERT INTO sync_lease VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(account_id, endpoint) DO UPDATE SET owner=excluded.owner, generation=sync_lease.generation+1,
          expires_at=excluded.expires_at, issuer=excluded.issuer, session_id=excluded.session_id
        WHERE sync_lease.expires_at<=?`).run(scope.accountId, scope.endpoint, owner, expiresAt, scope.issuer!, scope.sessionId!, now.toISOString());
      if (!result.changes) return null;
      const lease = this.store.db.prepare("SELECT owner, generation, expires_at AS expiresAt FROM sync_lease WHERE account_id=? AND endpoint=?")
        .get(scope.accountId, scope.endpoint) as unknown as SyncLease;
      this.heldLease = lease;
      return lease;
    });
  }
  async renewSyncLease(scope: SyncScope, now: Date, ttlMs = 30_000): Promise<boolean> {
    if (!scope.leaseOwner || scope.leaseGeneration === undefined) return false;
    return this.store.db.prepare(`UPDATE sync_lease SET expires_at=? WHERE account_id=? AND endpoint=? AND owner=? AND generation=? AND expires_at>?`)
      .run(new Date(now.getTime()+ttlMs).toISOString(), scope.accountId, scope.endpoint, scope.leaseOwner, scope.leaseGeneration, now.toISOString()).changes === 1;
  }
  async isSyncLeaseCurrent(scope: SyncScope, now: Date): Promise<boolean> {
    if (!scope.leaseOwner || scope.leaseGeneration === undefined) return false;
    return !!this.store.db.prepare("SELECT 1 FROM sync_lease WHERE account_id=? AND endpoint=? AND owner=? AND generation=? AND expires_at>?")
      .get(scope.accountId, scope.endpoint, scope.leaseOwner, scope.leaseGeneration, now.toISOString());
  }
  async releaseSyncLease(scope: SyncScope): Promise<void> {
    if (!scope.leaseOwner || scope.leaseGeneration === undefined) return;
    this.store.db.prepare("DELETE FROM sync_lease WHERE account_id=? AND endpoint=? AND owner=? AND generation=?")
      .run(scope.accountId, scope.endpoint, scope.leaseOwner, scope.leaseGeneration);
  }
  async listWorkouts(): Promise<WorkoutRecord[]> { return this.store.all(); }
  private records(sql: string, ...args: string[]): WorkoutRecord[] {
    const rows = this.store.db.prepare(sql).all(...args) as { record: string }[];
    return rows.map(row => validateWorkoutRecord(JSON.parse(row.record)).record);
  }
  async listSyncWorkouts(scope: SyncScope): Promise<WorkoutRecord[]> {
    return this.records(`SELECT w.record FROM workouts w WHERE w.origin='local' OR EXISTS
      (SELECT 1 FROM sync_remote_membership m WHERE m.workout_id=w.id AND m.account_id=? AND m.endpoint=? AND m.fingerprint=w.canonical)`, scope.accountId, scope.endpoint);
  }
  async getWorkout(id: string): Promise<WorkoutRecord | null> {
    return this.records("SELECT record FROM workouts WHERE id=?", id)[0] ?? null;
  }
  async saveWorkout(record: WorkoutRecord, options?: { origin?: "local" | "remote"; scope?: SyncScope }): Promise<{ created: boolean }> {
    if (options?.origin !== "remote" || !options.scope) throw new Error("Remote sync scope required.");
    const scope = options.scope;
    const validated = validateWorkoutRecord(record).record;
    const canonical = stableStringify(validated);
    return this.transaction(() => {
      this.fence(scope);
      const existing = this.store.db.prepare("SELECT canonical FROM workouts WHERE id=?").get(validated.id) as { canonical: string } | undefined;
      if (existing && existing.canonical !== canonical) throw new ConflictError(validated.id);
      if (!existing) this.store.db.prepare("INSERT INTO workouts (id,date,canonical,record,origin) VALUES (?,?,?,?, 'remote')")
        .run(validated.id, validated.date, canonical, JSON.stringify(validated));
      this.store.db.prepare(`INSERT INTO sync_remote_membership VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, endpoint, workout_id) DO UPDATE SET fingerprint=excluded.fingerprint`)
        .run(scope.accountId, scope.endpoint, validated.id, canonical);
      return { created: !existing };
    });
  }
  async linkRemoteMembership(scope: SyncScope, record: WorkoutRecord): Promise<void> {
    this.transaction(() => {
      this.fence(scope);
      const canonical = stableStringify(validateWorkoutRecord(record).record);
      const row = this.store.db.prepare("SELECT canonical FROM workouts WHERE id=?").get(record.id) as { canonical: string } | undefined;
      if (!row || row.canonical !== canonical) throw new Error("Remote membership content changed.");
      this.store.db.prepare(`INSERT INTO sync_remote_membership VALUES (?, ?, ?, ?) ON CONFLICT(account_id, endpoint, workout_id)
        DO UPDATE SET fingerprint=excluded.fingerprint`).run(scope.accountId, scope.endpoint, record.id, canonical);
    });
  }
  async listUploadCandidates(scope: SyncScope): Promise<WorkoutRecord[]> {
    return this.transaction(() => {
      this.fence(scope);
      this.store.db.prepare("UPDATE sync_outbox SET account_id=?, endpoint=?, state='pending', updated_at=? WHERE state='unassigned'")
        .run(scope.accountId, scope.endpoint, new Date().toISOString());
      return this.records(`SELECT w.record FROM workouts w JOIN sync_outbox o ON o.workout_id=w.id
        WHERE o.account_id=? AND o.endpoint=? AND o.state IN ('pending','retry') AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?)`,
        scope.accountId, scope.endpoint, new Date().toISOString());
    });
  }
  async markUploadComplete(scope: SyncScope, id: string): Promise<void> {
    this.transaction(() => {
      this.fence(scope);
      const result = this.store.db.prepare("UPDATE sync_outbox SET state='complete', next_attempt_at=NULL, updated_at=? WHERE workout_id=? AND account_id=? AND endpoint=?")
        .run(new Date().toISOString(), id, scope.accountId, scope.endpoint);
      if (result.changes !== 1) throw new Error("Sync upload candidate no longer exists.");
    });
  }
  async scheduleUploadRetry(scope: SyncScope, id: string): Promise<void> {
    this.transaction(() => {
      this.fence(scope);
      const row = this.store.db.prepare("SELECT attempts FROM sync_outbox WHERE workout_id=? AND account_id=? AND endpoint=?")
        .get(id, scope.accountId, scope.endpoint) as { attempts: number } | undefined;
      if (!row) throw new Error("Sync upload candidate no longer exists.");
      const now = new Date();
      const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(row.attempts, 7));
      this.store.db.prepare("UPDATE sync_outbox SET state='retry', attempts=attempts+1, next_attempt_at=?, updated_at=? WHERE workout_id=? AND account_id=? AND endpoint=?")
        .run(new Date(now.getTime() + delay).toISOString(), now.toISOString(), id, scope.accountId, scope.endpoint);
    });
  }
  async getSyncStatus(scope: SyncScope): Promise<{ pendingCount: number; lastSuccessAt: string | null }> {
    const pending = this.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE state='unassigned' OR (account_id=? AND endpoint=? AND state IN ('pending','retry'))").get(scope.accountId, scope.endpoint) as { n: number };
    const status = this.store.db.prepare("SELECT last_success_at FROM sync_status WHERE account_id=? AND endpoint=?").get(scope.accountId, scope.endpoint) as { last_success_at: string | null } | undefined;
    return { pendingCount: pending.n, lastSuccessAt: status?.last_success_at ?? null };
  }
  async recordSuccessfulReconciliation(scope: SyncScope): Promise<void> {
    this.transaction(() => {
      this.fence(scope);
      this.store.db.prepare(`INSERT INTO sync_status VALUES (?, ?, ?) ON CONFLICT(account_id, endpoint)
        DO UPDATE SET last_success_at=excluded.last_success_at`).run(scope.accountId, scope.endpoint, new Date().toISOString());
    });
  }
}
