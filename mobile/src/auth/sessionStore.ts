import * as SecureStore from "expo-secure-store";

import {
  MOBILE_AUTH_SESSION_KEY,
  parseStoredSession,
  serializeSession,
  type SupabaseSession,
} from "./authModel";

/**
 * The only on-device home for auth tokens.
 *
 * Tokens live in `expo-secure-store` — never AsyncStorage, never the workout
 * database, never a log. Every operation fails soft: a SecureStore read/write
 * error falls back to a module-scoped in-memory copy and is never surfaced as
 * a crash. The in-memory fallback also means "write failed" still leaves the
 * current app session usable; only persistence across a restart is lost.
 *
 * `expo-secure-store` is already registered in `mobile/app.json` plugins, so no
 * config field is added by this slice.
 */

let memoryRaw: string | null = null;

function parse(raw: string | null): SupabaseSession | null {
  return parseStoredSession(raw);
}

/**
 * Read a stored session. Storage errors and malformed values return the
 * in-memory fallback (or `null`), never throw.
 */
export async function readStoredSession(): Promise<SupabaseSession | null> {
  try {
    const stored = await SecureStore.getItemAsync(MOBILE_AUTH_SESSION_KEY);
    const parsed = parse(stored);
    if (parsed !== null) return parsed;
  } catch {
    // Fall through to the in-memory copy; the provider starts signed-out if
    // neither source has a usable session.
  }
  return parse(memoryRaw);
}

/**
 * Persist a session, or clear it when `session` is `null`. The memory copy is
 * updated first so the current app is coherent even if the native write fails.
 */
export async function writeStoredSession(session: SupabaseSession | null): Promise<void> {
  const raw = session === null ? null : serializeSession(session);
  memoryRaw = raw;
  try {
    if (raw === null) {
      await SecureStore.deleteItemAsync(MOBILE_AUTH_SESSION_KEY);
    } else {
      await SecureStore.setItemAsync(MOBILE_AUTH_SESSION_KEY, raw);
    }
  } catch {
    // Best-effort persistence: keep using the in-memory session.
  }
}
