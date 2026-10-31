import * as SecureStore from "expo-secure-store";
import { openDatabaseAsync } from "expo-sqlite";

import {
  MOBILE_AUTH_SESSION_KEY,
  parseStoredSession,
  serializeSession,
  type SupabaseSession,
} from "./authModel";
import {
  AUTH_CONTROL_TABLE_SQL,
  AUTH_REFRESH_LEASE_ACQUIRE_SQL,
  AUTH_REFRESH_LEASE_RELEASE_SQL,
  AUTH_REFRESH_LEASE_TABLE_SQL,
  AUTH_SIGN_IN_ATTEMPT_BEGIN_SQL,
  AUTH_SIGN_IN_ATTEMPT_CURRENT_SQL,
  AUTH_SIGN_IN_ATTEMPT_INVALIDATE_SQL,
  AUTH_SIGN_IN_ATTEMPT_TABLE_SQL,
  isRefreshCredentialCurrent,
  isSessionGenerationCurrent,
  shouldDeleteRevokedSession,
} from "./authControlModel";

/** Secret-free cross-runtime revocation state; tokens remain in SecureStore. */
const AUTH_CONTROL_DB_NAME = "fit-trace-auth-control.db";
interface StoredEnvelope {
  version: 2;
  generation: number;
  session: SupabaseSession;
}

export interface StoredAuthSession {
  session: SupabaseSession;
  generation: number;
}

function parseEnvelope(raw: string | null): StoredEnvelope | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const generation = parsed.generation;
    const session = parseStoredSession(JSON.stringify(parsed.session));
    if (parsed.version !== 2 || !Number.isSafeInteger(generation) || (generation as number) < 0 || session === null) {
      return null;
    }
    return { version: 2, generation: generation as number, session };
  } catch {
    return null;
  }
}

function serializeEnvelope(session: SupabaseSession, generation: number): string {
  return JSON.stringify({ version: 2, generation, session: JSON.parse(serializeSession(session)) });
}

async function openControlDatabase() {
  const database = await openDatabaseAsync(AUTH_CONTROL_DB_NAME);
  try {
    await database.execAsync(AUTH_CONTROL_TABLE_SQL);
    await database.execAsync(AUTH_REFRESH_LEASE_TABLE_SQL);
    await database.execAsync(AUTH_SIGN_IN_ATTEMPT_TABLE_SQL);
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

type AuthControlDatabase = Awaited<ReturnType<typeof openControlDatabase>>;
type AuthTransactionTask = Parameters<AuthControlDatabase["withExclusiveTransactionAsync"]>[0];

function isSQLiteBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)|SQLITE_BUSY/i.test(error.message);
}

async function waitForSQLite(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Wait for another runtime's short SecureStore transaction instead of losing sign-out/sign-in intent. */
async function withExclusiveAuthTransaction(
  database: AuthControlDatabase,
  task: AuthTransactionTask,
): Promise<void> {
  let delayMs = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await database.withExclusiveTransactionAsync(task);
      return;
    } catch (error) {
      if (!isSQLiteBusy(error) || attempt >= 24) throw error;
      await waitForSQLite(delayMs);
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
}

/** Read only a session whose durable generation is still active. */
export async function readStoredAuthSession(): Promise<StoredAuthSession | null> {
  const database = await openControlDatabase();
  try {
    let result: StoredAuthSession | null = null;
    await withExclusiveAuthTransaction(database, async (transaction) => {
      await transaction.runAsync("UPDATE auth_control SET generation = generation WHERE singleton = 1");
      let state = await transaction.getFirstAsync<{ generation: number; revoked: number }>(
        "SELECT generation, revoked FROM auth_control WHERE singleton = 1 LIMIT 1",
      );
      if (state?.revoked === 1) return;
      let raw = await SecureStore.getItemAsync(MOBILE_AUTH_SESSION_KEY);
      if (state === null) {
        // Upgrade the legacy SecureStore-only format once. Never trust that
        // format again after a durable revocation generation exists.
        const legacy = parseStoredSession(raw);
        const generation = legacy === null ? 0 : 1;
        const revoked = legacy === null ? 1 : 0;
        await transaction.runAsync(
          "INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, ?, ?)",
          generation,
          revoked,
        );
        if (legacy !== null) {
          raw = serializeEnvelope(legacy, generation);
          await SecureStore.setItemAsync(MOBILE_AUTH_SESSION_KEY, raw);
        }
        state = { generation, revoked };
      }
      if (state.revoked !== 0) return;
      const envelope = parseEnvelope(raw);
      if (envelope !== null && isSessionGenerationCurrent(envelope.generation, state.generation, state.revoked !== 0)) {
        result = { session: envelope.session, generation: envelope.generation };
      }
    });
    return result;
  } finally {
    await database.closeAsync();
  }
}

/** Reserve the latest sign-in intent before any network request starts. */
export async function beginStoredSignInAttempt(): Promise<number> {
  const database = await openControlDatabase();
  try {
    let attempt = 0;
    await withExclusiveAuthTransaction(database, async (transaction) => {
      await transaction.runAsync(AUTH_SIGN_IN_ATTEMPT_BEGIN_SQL);
      const row = await transaction.getFirstAsync<{ attempt: number }>(AUTH_SIGN_IN_ATTEMPT_CURRENT_SQL);
      attempt = row?.attempt ?? 0;
    });
    return attempt;
  } finally {
    await database.closeAsync();
  }
}

/** Commit a fresh identity only while its sign-in intent is still latest. */
export async function saveNewStoredSession(
  session: SupabaseSession,
  expectedAttempt: number,
): Promise<number | null> {
  const database = await openControlDatabase();
  try {
    let generation: number | null = null;
    await withExclusiveAuthTransaction(database, async (transaction) => {
      await transaction.runAsync("UPDATE auth_sign_in_attempt SET attempt = attempt WHERE singleton = 1");
      const attempt = await transaction.getFirstAsync<{ attempt: number }>(AUTH_SIGN_IN_ATTEMPT_CURRENT_SQL);
      if (attempt?.attempt !== expectedAttempt) return;
      const state = await transaction.getFirstAsync<{ generation: number }>(
        "SELECT generation FROM auth_control WHERE singleton = 1 LIMIT 1",
      );
      const nextGeneration = (state?.generation ?? 0) + 1;
      // Write the token first; if SecureStore fails, transaction rollback keeps
      // the previous durable generation active and this sign-in is not applied.
      await SecureStore.setItemAsync(MOBILE_AUTH_SESSION_KEY, serializeEnvelope(session, nextGeneration));
      await transaction.runAsync(
        `INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, ?, 0)
         ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, revoked = 0`,
        nextGeneration,
      );
      generation = nextGeneration;
    });
    return generation;
  } finally {
    await database.closeAsync();
  }
}

/**
 * Persist a refresh only if sign-out or another sign-in has not changed the
 * durable epoch while the network request was in flight.
 */
export async function replaceStoredSession(
  session: SupabaseSession,
  expectedGeneration: number,
  expectedRefreshToken?: string,
  expectedRefreshOwner?: string,
): Promise<boolean> {
  const database = await openControlDatabase();
  try {
    let stored = false;
    await withExclusiveAuthTransaction(database, async (transaction) => {
      await transaction.runAsync("UPDATE auth_control SET generation = generation WHERE singleton = 1");
      const state = await transaction.getFirstAsync<{ generation: number; revoked: number }>(
        "SELECT generation, revoked FROM auth_control WHERE singleton = 1 LIMIT 1",
      );
      if (state === null || state.generation !== expectedGeneration || state.revoked !== 0) return;
      if (expectedRefreshToken !== undefined) {
        const current = parseEnvelope(await SecureStore.getItemAsync(MOBILE_AUTH_SESSION_KEY));
        if (current === null || !isRefreshCredentialCurrent(
          current.generation,
          expectedGeneration,
          false,
          current.session.refreshToken,
          expectedRefreshToken,
        )) return;
      }
      if (expectedRefreshOwner !== undefined) {
        const lease = await transaction.getFirstAsync<{ owner: string }>(
          `SELECT owner FROM auth_refresh_lease WHERE singleton = 1 AND generation = ?
           AND owner = ? AND expires_at > ? LIMIT 1`,
          expectedGeneration,
          expectedRefreshOwner,
          new Date().toISOString(),
        );
        if (lease === null) return;
      }
      await SecureStore.setItemAsync(MOBILE_AUTH_SESSION_KEY, serializeEnvelope(session, expectedGeneration));
      stored = true;
    });
    return stored;
  } finally {
    await database.closeAsync();
  }
}

/** Confirm the exact auth refresh lease still owns its unexpired generation. */
export async function isAuthRefreshLeaseCurrent(
  generation: number,
  owner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const database = await openControlDatabase();
  try {
    const lease = await database.getFirstAsync<{ owner: string }>(
      `SELECT owner FROM auth_refresh_lease WHERE singleton = 1 AND generation = ?
       AND owner = ? AND expires_at > ? LIMIT 1`,
      generation,
      owner,
      now.toISOString(),
    );
    return lease !== null;
  } finally {
    await database.closeAsync();
  }
}

/** Claim the single cross-runtime refresh slot for the current auth epoch. */
export async function acquireAuthRefreshLease(
  generation: number,
  owner: string,
  now: Date,
  ttlMs: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(generation) || !owner.trim() || !Number.isFinite(ttlMs) || ttlMs < 1) return false;
  const database = await openControlDatabase();
  try {
    let acquired = false;
    await database.withTransactionAsync(async () => {
      const result = await database.runAsync(
        AUTH_REFRESH_LEASE_ACQUIRE_SQL,
        owner,
        generation,
        new Date(now.getTime() + ttlMs).toISOString(),
        generation,
        now.toISOString(),
      );
      acquired = result.changes === 1;
    });
    return acquired;
  } finally {
    await database.closeAsync();
  }
}

/** Release only the exact refresh lease acquired by this runtime. */
export async function releaseAuthRefreshLease(generation: number, owner: string): Promise<void> {
  const database = await openControlDatabase();
  try {
    await database.runAsync(
      AUTH_REFRESH_LEASE_RELEASE_SQL,
      generation,
      owner,
    );
  } finally {
    await database.closeAsync();
  }
}

/**
 * Revoke durably before best-effort secret deletion. Even if SecureStore
 * refuses deletion or restores an old backup, readers reject the old epoch.
 */
export async function revokeStoredSession(expectedGeneration?: number): Promise<boolean> {
  let database: Awaited<ReturnType<typeof openControlDatabase>>;
  try {
    database = await openControlDatabase();
  } catch (error) {
    // If the durable control store is unavailable during explicit sign-out,
    // still attempt to remove the only secret-bearing copy.
    await SecureStore.deleteItemAsync(MOBILE_AUTH_SESSION_KEY).catch(() => undefined);
    throw error;
  }
  let revoked = false;
  let revokedGeneration: number | null = null;
  try {
    await withExclusiveAuthTransaction(database, async (transaction) => {
      // A newer durable intent fences a sign-in which has not committed yet.
      if (expectedGeneration === undefined) {
        await transaction.runAsync(AUTH_SIGN_IN_ATTEMPT_INVALIDATE_SQL);
        await transaction.runAsync(
          `INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, 1, 1)
           ON CONFLICT(singleton) DO UPDATE SET generation = auth_control.generation + 1, revoked = 1`,
        );
        revoked = true;
      } else {
        const result = await transaction.runAsync(
          `UPDATE auth_control SET generation = generation + 1, revoked = 1
           WHERE singleton = 1 AND generation = ? AND revoked = 0`,
          expectedGeneration,
        );
        revoked = result.changes === 1;
      }
      if (revoked) {
        const state = await transaction.getFirstAsync<{ generation: number }>(
          "SELECT generation FROM auth_control WHERE singleton = 1 LIMIT 1",
        );
        revokedGeneration = state?.generation ?? null;
      }
    });
    if (revoked && revokedGeneration !== null) {
      const deleteGeneration = revokedGeneration;
      // Serialize deletion against a new sign-in. Without the second SQLite
      // guard, a delayed keychain delete could erase credentials written by a
      // newer identity after this revocation committed.
      await withExclusiveAuthTransaction(database, async (transaction) => {
        const state = await transaction.getFirstAsync<{ generation: number; revoked: number }>(
          "SELECT generation, revoked FROM auth_control WHERE singleton = 1 LIMIT 1",
        );
        if (state !== null && shouldDeleteRevokedSession(state.generation, deleteGeneration, state.revoked === 1)) {
          await transaction.runAsync("UPDATE auth_control SET generation = generation WHERE singleton = 1");
          await SecureStore.deleteItemAsync(MOBILE_AUTH_SESSION_KEY);
        }
      });
    }
  } catch (error) {
    if (!revoked) await SecureStore.deleteItemAsync(MOBILE_AUTH_SESSION_KEY).catch(() => undefined);
    throw error;
  } finally {
    await database.closeAsync();
  }
  return revoked;
}
