import AsyncStorageModule from "@react-native-async-storage/async-storage";

import { createHealthConnectToggle, parseStoredHealthConnectEnabled } from "../health/healthModel.ts";

/**
 * Device-local Health Connect opt-in.
 *
 * The toggle deliberately lives in AsyncStorage, not in `preferencesModel.ts`:
 * account preferences sync to the account, while health-data access is a
 * per-device grant that must never be mirrored, restored or shared across
 * devices (a guest device stays safe by construction). The storage pattern
 * follows `theme/skin.tsx`: one versioned key, backed by the pure
 * memory-first state machine in `healthModel.ts`
 * (`createHealthConnectToggle`) — reads prefer the in-memory value, and a
 * write applies the memory value first, so a failed persistence rolls the
 * memory value back and rethrows instead of leaving the UI showing a state
 * storage never received. The pure rules live in `healthModel.ts`
 * (`parseStoredHealthConnectEnabled`, `createHealthConnectToggle`, re-exported
 * here).
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
 * Metro's interop binds the package's default export directly, while the
 * root NodeNext typecheck (no esModuleInterop) sees the CJS namespace whose
 * instance sits on `default`. Accept whichever shape shows up; both failures
 * stay fail-soft in the readers/writers below.
 */
const AsyncStorage: AsyncStorageLike = (() => {
  const candidate = AsyncStorageModule as unknown as AsyncStorageLike & {
    default?: AsyncStorageLike;
  };
  return candidate.default ?? candidate;
})();

/** The app-wide toggle state machine (one memory cache per launch). */
const toggle = createHealthConnectToggle(AsyncStorage, HEALTH_CONNECT_STORAGE_KEY);

/**
 * Read the persisted opt-in. Memory-first: the value cached by an earlier
 * read or write wins over storage, so a read after a toggle reflects the
 * toggle's outcome (including a rolled-back failed write) without waiting on
 * a storage round-trip. A storage failure before anything was cached reads as
 * off and is not cached, so a later read retries.
 */
export function readHealthConnectEnabled(): Promise<boolean> {
  return toggle.read();
}

/**
 * Persist the opt-in. The memory value is applied before the storage write;
 * a rejected write rolls the memory value back and rethrows, so the caller
 * (the Me toggle handler) can surface the failure instead of the UI showing
 * an opt-in state that storage never received.
 */
export function writeHealthConnectEnabled(enabled: boolean): Promise<void> {
  return toggle.write(enabled);
}
