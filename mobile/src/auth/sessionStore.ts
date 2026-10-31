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
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

/** Read only a session whose durable generation is still active. */
export async function readStoredAuthSession(): Promise<StoredAuthSession | null> {
  const database = await openControlDatabase();
  try {
    let result: StoredAuthSession | null = null;
    await database.withTransactionAsync(async () => {
      let state = await database.getFirstAsync<{ generation: number; revoked: number }>(
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
        await database.runAsync(
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

/** Start a fresh authentication identity, invalidating older async refreshes. */
export async function saveNewStoredSession(session: SupabaseSession): Promise<number> {
  const database = await openControlDatabase();
  try {
    let generation = 0;
    await database.withTransactionAsync(async () => {
      const state = await database.getFirstAsync<{ generation: number }>(
        "SELECT generation FROM auth_control WHERE singleton = 1 LIMIT 1",
      );
      generation = (state?.generation ?? 0) + 1;
      // Write the token first; if SecureStore fails, transaction rollback keeps
      // the previous durable generation active and this sign-in is not applied.
      await SecureStore.setItemAsync(MOBILE_AUTH_SESSION_KEY, serializeEnvelope(session, generation));
      await database.runAsync(
        `INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, ?, 0)
         ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, revoked = 0`,
        generation,
      );
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
    await database.withTransactionAsync(async () => {
      const state = await database.getFirstAsync<{ generation: number; revoked: number }>(
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
        const lease = await database.getFirstAsync<{ owner: string }>(
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
    await database.withTransactionAsync(async () => {
      if (expectedGeneration === undefined) {
        await database.runAsync(
          `INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, 1, 1)
           ON CONFLICT(singleton) DO UPDATE SET generation = auth_control.generation + 1, revoked = 1`,
        );
        revoked = true;
      } else {
        const result = await database.runAsync(
          `UPDATE auth_control SET generation = generation + 1, revoked = 1
           WHERE singleton = 1 AND generation = ? AND revoked = 0`,
          expectedGeneration,
        );
        revoked = result.changes === 1;
      }
      if (revoked) {
        const state = await database.getFirstAsync<{ generation: number }>(
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
      await database.withTransactionAsync(async () => {
        const state = await database.getFirstAsync<{ generation: number; revoked: number }>(
          "SELECT generation, revoked FROM auth_control WHERE singleton = 1 LIMIT 1",
        );
        if (state !== null && shouldDeleteRevokedSession(state.generation, deleteGeneration, state.revoked === 1)) {
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
