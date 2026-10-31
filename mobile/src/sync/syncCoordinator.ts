import { isSessionExpired } from "../auth/authModel";
import { readSupabaseAuthConfig } from "../auth/authConfig";
import { readStoredAuthSession, revokeStoredSession, type StoredAuthSession } from "../auth/sessionStore";
import { refreshStoredSession } from "../auth/sessionRefresh";
import { openWorkoutDatabase, WorkoutRepository } from "../data/workoutRepository";
import { readSyncConfig } from "./syncClient";
import { WorkoutSyncClient } from "./syncClient";
import { runWorkoutSync, type RunWorkoutSyncOptions, type SyncRunAccount } from "./syncRunner";

/** Shared entry point for screen, reconnect, foreground and OS task triggers. */
export function coordinateWorkoutSync(options: RunWorkoutSyncOptions) {
  return runWorkoutSync(options);
}

async function recoverHeadlessSession(stored: StoredAuthSession): Promise<StoredAuthSession | null> {
  const authConfig = readSupabaseAuthConfig();
  if (authConfig === null) return null;
  if (!isSessionExpired(stored.session)) return stored;

  try {
    return await refreshStoredSession(authConfig, stored);
  } catch (error) {
    // A transient outage must leave the still-revocable session for the next
    // foreground/task attempt. Definitive rejection revokes only this epoch.
    const status = typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
    if (typeof status === "number" && status < 500 && status !== 429) {
      await revokeStoredSession(stored.generation).catch(() => false);
    }
    return null;
  }
}

/** Headless execution rechecks revocation, consent, config and identity. */
export async function runHeadlessWorkoutSync(): Promise<boolean> {
  const syncConfig = readSyncConfig();
  if (syncConfig.status !== "configured") return false;

  const stored = await readStoredAuthSession();
  if (stored === null) return false;
  const database = await openWorkoutDatabase();
  try {
    const repository = new WorkoutRepository(database);
    const scope = {
      accountId: stored.session.user.id,
      endpoint: syncConfig.baseUrl,
    };
    if (!(await repository.isSyncEnabled(scope))) return false;

    const recovered = await recoverHeadlessSession(stored);
    if (recovered === null) return false;
    if (recovered.session.user.id !== scope.accountId) return false;
    const current = await readStoredAuthSession();
    if (current === null || current.generation !== recovered.generation || current.session.user.id !== scope.accountId) return false;

    const account: SyncRunAccount = {
      userId: recovered.session.user.id,
      accessToken: recovered.session.accessToken,
      authGeneration: recovered.generation,
    };
    const client = new WorkoutSyncClient({ config: syncConfig }).withAccessToken(recovered.session.accessToken);
    const result = await coordinateWorkoutSync({
      repository,
      client,
      account,
      scope,
      getCurrentAccount: async () => {
        const current = await readStoredAuthSession();
        if (current === null) return { userId: null, accessToken: null };
        return {
          userId: current.session.user.id,
          accessToken: current.session.accessToken,
          authGeneration: current.generation,
        };
      },
    });
    return result.status === "done" && result.conflicts.length === 0;
  } finally {
    await database.closeAsync();
  }
}
