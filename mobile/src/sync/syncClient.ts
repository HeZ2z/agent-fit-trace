import Constants from "expo-constants";
import { WorkoutSyncClient as SharedWorkoutSyncClient, resolveSyncConfig, SYNC_API_URL_ENV } from "../../../packages/fit-trace-sync/src/syncClient.ts";
import type { SyncConfig, WorkoutSyncClientOptions } from "../../../packages/fit-trace-sync/src/syncClient.ts";
export * from "../../../packages/fit-trace-sync/src/syncClient.ts";

function extraString(
  extra: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = extra?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Ignore blank entries so a lower-priority source can still apply. */
function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Read the API base from `process.env` (Expo inlines the statically accessed
 * `EXPO_PUBLIC_*` value) and fall back to `expo-constants` `extra`.
 *
 * The Expo-specific read lives here rather than in `syncConfig.ts` so the pure
 * resolver stays loadable by the root `node:test` suite. A missing/blank value
 * is `unconfigured`; a non-http(s) value is `invalid`.
 */
export function readSyncConfig(): SyncConfig {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | null | undefined;
  return resolveSyncConfig(
    firstNonBlank(
      process.env.EXPO_PUBLIC_FIT_TRACE_API_URL,
      extraString(extra, SYNC_API_URL_ENV),
      extraString(extra, "fitTraceApiUrl"),
    ),
  );
}

/** Mobile supplies Expo configuration; the shared client has no platform dependency. */
export class WorkoutSyncClient extends SharedWorkoutSyncClient {
  constructor(options: WorkoutSyncClientOptions = {}) {
    super({ ...options, config: options.config ?? readSyncConfig() });
  }
}
