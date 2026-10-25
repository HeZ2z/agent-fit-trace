import AsyncStorageModule from "@react-native-async-storage/async-storage";

import { parseStoredHealthConnectEnabled } from "../health/healthModel.ts";

/**
 * Device-local Health Connect opt-in.
 *
 * The toggle deliberately lives in AsyncStorage, not in `preferencesModel.ts`:
 * account preferences sync to the account, while health-data access is a
 * per-device grant that must never be mirrored, restored or shared across
 * devices (a guest device stays safe by construction). The storage pattern
 * follows `theme/skin.tsx`: one versioned key, reads and writes are both
 * best-effort and fail soft to the off state. The pure rules live in
 * `healthModel.ts` (`parseStoredHealthConnectEnabled`, re-exported here).
 */

/** Versioned key so a future migration can coexist with v1. */
export const HEALTH_CONNECT_STORAGE_KEY = "agent-fit-trace:health-connect:v1";

export { parseStoredHealthConnectEnabled };

/** The storage surface this module uses. */
interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * The AsyncStorage instance, unwrapped once.
 *
 * Metro's interop binds the package's default export directly, while the root
 * NodeNext typecheck (no esModuleInterop) sees the CJS namespace whose
 * instance sits on `default`. Accept whichever shape shows up; both failures
 * stay fail-soft in the readers/writers below.
 */
const AsyncStorage: AsyncStorageLike = (() => {
  const candidate = AsyncStorageModule as unknown as AsyncStorageLike & {
    default?: AsyncStorageLike;
  };
  return candidate.default ?? candidate;
})();

/** Read the persisted opt-in; any storage failure reads as off. */
export async function readHealthConnectEnabled(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(HEALTH_CONNECT_STORAGE_KEY);
    return parseStoredHealthConnectEnabled(stored);
  } catch {
    // Memory-only fallback: the import stays off and never blocks startup.
    return false;
  }
}

/**
 * Persist the opt-in. Writes are best-effort: a rejected write keeps the
 * in-session state that the caller already applied.
 */
export function writeHealthConnectEnabled(enabled: boolean): void {
  try {
    void AsyncStorage.setItem(HEALTH_CONNECT_STORAGE_KEY, enabled ? "true" : "false").catch(
      () => {
        // Durability is lost; the toggle still applies for this launch.
      },
    );
  } catch {
    // The native storage module can be unavailable (tests, web fallback, ...).
  }
}
