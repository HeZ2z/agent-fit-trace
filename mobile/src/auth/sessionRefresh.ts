import type { SupabaseAuthConfig, SupabaseSession } from "./authModel";
import { refreshSession } from "./supabaseAuth";
import {
  acquireAuthRefreshLease,
  isAuthRefreshLeaseCurrent,
  readStoredAuthSession,
  releaseAuthRefreshLease,
  replaceStoredSession,
  revokeStoredSession,
  type StoredAuthSession,
} from "./sessionStore";

const REFRESH_LEASE_TTL_MS = 25_000;
const REFRESH_WAIT_MS = 250;
const REFRESH_MAX_WAIT_MS = 20_000;

function refreshOwner(): string {
  return `refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Refreshes at most once across foreground and headless JS runtimes. A waiter
 * adopts the winner's newly persisted session rather than reusing a rotated
 * refresh token. Refresh persistence is fenced by both auth generation and
 * the exact refresh token that was submitted.
 */
export async function refreshStoredSession(
  config: SupabaseAuthConfig,
  stored: StoredAuthSession,
): Promise<StoredAuthSession | null> {
  const owner = refreshOwner();
  const startedAt = Date.now();
  while (!(await acquireAuthRefreshLease(stored.generation, owner, new Date(), REFRESH_LEASE_TTL_MS))) {
    const latest = await readStoredAuthSession();
    if (latest === null || latest.generation !== stored.generation) return latest;
    if (latest.session.refreshToken !== stored.session.refreshToken) return latest;
    if (Date.now() - startedAt >= REFRESH_MAX_WAIT_MS) return null;
    await pause(REFRESH_WAIT_MS);
  }

  try {
    const current = await readStoredAuthSession();
    if (current === null || current.generation !== stored.generation) return current;
    if (current.session.refreshToken !== stored.session.refreshToken) return current;

    let refreshed: SupabaseSession;
    try {
      refreshed = await refreshSession(config, stored.session.refreshToken);
    } catch (error) {
      if (await isAuthRefreshLeaseCurrent(stored.generation, owner).catch(() => false)) throw error;
      return readStoredAuthSession();
    }
    if (!(await isAuthRefreshLeaseCurrent(stored.generation, owner).catch(() => false))) {
      return readStoredAuthSession();
    }
    if (refreshed.user.id !== stored.session.user.id) {
      await revokeStoredSession(stored.generation);
      return null;
    }
    const session: SupabaseSession = { ...refreshed, user: stored.session.user };
    if (!(await replaceStoredSession(session, stored.generation, stored.session.refreshToken, owner))) {
      return readStoredAuthSession();
    }
    return { session, generation: stored.generation };
  } finally {
    await releaseAuthRefreshLease(stored.generation, owner).catch(() => undefined);
  }
}
