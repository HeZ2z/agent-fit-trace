import { Platform } from "react-native";

import {
  aggregateSleepHours,
  createSingleFlightInit,
  evaluatePermissionGrant,
  importUnavailableReason,
  mapHealthConnectStatus,
  nightWindowRange,
  previousIsoDate,
  tzOffsetMinutesForDate,
  HEALTH_READ_SCOPES,
  SLEEP_READ_SCOPE,
  type HealthAuthorization,
  type HealthAvailability,
  type PermissionRequestResult,
  type PlatformHealthProvider,
  type SleepImportResult,
  type SleepSessionLike,
} from "./healthModel.ts";

/**
 * Thin native adapter between `react-native-health-connect` and the pure
 * `healthModel`. Everything domain-shaped happens in the model; this file only
 * checks the platform, calls the SDK and normalizes its records.
 *
 * Read-only by contract: data flows from Health Connect into the app, never
 * the other way. A guarded node:test case pins this invariant against the
 * source text.
 *
 * Tests never import this module: the native side only exists on an Android
 * device build, and `getHealthConnectProvider()` keeps one provider instance
 * for the app's lifetime.
 */

/** The native module's surface used here; only `import type` reaches it. */
interface HealthConnectNative {
  getSdkStatus(providerPackageName?: string): Promise<number>;
  initialize(providerPackageName?: string): Promise<boolean>;
  requestPermission(
    permissions: Array<{ accessType: "read" | "write"; recordType: string }>,
  ): Promise<Array<{ accessType: string; recordType: string }>>;
  getGrantedPermissions(): Promise<Array<{ accessType: string; recordType: string }>>;
  readRecords(
    recordType: string,
    options: {
      timeRangeFilter: { operator: "between"; startTime: string; endTime: string };
    },
  ): Promise<{ records: Array<Record<string, unknown>> }>;
}

/**
 * Load the native module lazily and only on Android. A static import would
 * touch the TurboModule on every platform; on iOS (and in non-native shells)
 * that is a hard crash, so non-Android never requires it and a failed require
 * degrades to "not found" instead of throwing at import time.
 */
function loadNativeHealthConnect(): HealthConnectNative | null {
  if (Platform.OS !== "android") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require("react-native-health-connect") as HealthConnectNative;
    return native;
  } catch {
    return null;
  }
}

/** Request bodies for the two read scopes, in the SDK's permission shape. */
function readPermissions(): Array<{ accessType: "read"; recordType: string }> {
  return HEALTH_READ_SCOPES.map((recordType) => ({
    accessType: "read" as const,
    recordType,
  }));
}

/** Flatten granted `Permission` objects to the model's record-type strings. */
function grantedRecordTypes(
  granted: Array<{ accessType: string; recordType: string }>,
): string[] {
  return granted
    .filter((permission) => permission.accessType === "read")
    .map((permission) => permission.recordType);
}

/** Normalize one SDK `SleepSessionRecord` into the model's neutral shape. */
function toSleepSessionLike(record: Record<string, unknown>): SleepSessionLike | null {
  const start = record.startTime;
  const end = record.endTime;
  if (typeof start !== "string" || typeof end !== "string") return null;
  const rawStages = Array.isArray(record.stages) ? record.stages : [];
  const stages = rawStages
    .map((stage) => stage as { stage?: unknown; startTime?: unknown; endTime?: unknown })
    .filter(
      (stage): stage is { stage: number; startTime: string; endTime: string } =>
        typeof stage.stage === "number" &&
        typeof stage.startTime === "string" &&
        typeof stage.endTime === "string",
    )
    .map((stage) => ({ stage: stage.stage, start: stage.startTime, end: stage.endTime }));
  return { start, end, stages };
}

/**
 * Adapt the granular Android outcome to the shared `HealthAuthorization`.
 *
 * Android is the one platform that can state a grant, so its `granted`/
 * `missing` pair passes through untouched — the screen's Android copy keeps
 * reading exactly the fields it read before issue #51.
 */
function grantedAuthorization(
  grant: PermissionRequestResult,
): HealthAuthorization {
  return { kind: "granted", granted: grant.granted, missing: grant.missing };
}

function createHealthConnectProvider(): PlatformHealthProvider {
  /**
   * Idempotent initialize guard for every native call that needs a client. In
   * react-native-health-connect 4.1.3 `requestPermission`,
   * `getGrantedPermissions` and `readRecords` reject with `ClientNotInitialized`
   * until `initialize()` has resolved (only `getSdkStatus` is safe before).
   * `loadNativeHealthConnect()` returns the same module on every Android call,
   * so the thunk below always initializes the same native client.
   */
  const ensureInitialized = createSingleFlightInit(async (): Promise<void> => {
    const native = loadNativeHealthConnect();
    if (native === null) {
      throw new Error("Health Connect native module is unavailable");
    }
    const initialized = await native.initialize();
    if (initialized !== true) {
      throw new Error("Health Connect failed to initialize");
    }
  });

  /** Read the granted set; a native failure reads as "nothing granted". */
  async function grantedReadScopes(native: HealthConnectNative): Promise<string[]> {
    try {
      return grantedRecordTypes(await native.getGrantedPermissions());
    } catch (cause) {
      // The permission state must surface as unauthorized, never reject into
      // the UI mount chain (a stale or uninitialized client is not fatal here).
      console.warn("[healthConnect] getGrantedPermissions failed; treating as unauthorized", cause);
      return [];
    }
  }

  return {
    sourceKind: "health-connect",

    async availability(): Promise<HealthAvailability> {
      // The platform gate comes first and never touches the native module.
      if (Platform.OS !== "android") return { kind: "unavailable", reason: "platform" };
      const native = loadNativeHealthConnect();
      if (native === null) return { kind: "unavailable", reason: "not-found" };
      try {
        return mapHealthConnectStatus(await native.getSdkStatus());
      } catch {
        return { kind: "unavailable", reason: "not-found" };
      }
    },

    async requestReadPermissions(): Promise<HealthAuthorization> {
      if (Platform.OS !== "android") {
        return grantedAuthorization(evaluatePermissionGrant(HEALTH_READ_SCOPES, []));
      }
      const native = loadNativeHealthConnect();
      if (native === null) {
        return grantedAuthorization(evaluatePermissionGrant(HEALTH_READ_SCOPES, []));
      }
      await ensureInitialized();
      const granted = grantedRecordTypes(await native.requestPermission(readPermissions()));
      return grantedAuthorization(evaluatePermissionGrant(HEALTH_READ_SCOPES, granted));
    },

    async currentPermissions(): Promise<HealthAuthorization> {
      if (Platform.OS !== "android") {
        return grantedAuthorization(evaluatePermissionGrant(HEALTH_READ_SCOPES, []));
      }
      const native = loadNativeHealthConnect();
      if (native === null) {
        return grantedAuthorization(evaluatePermissionGrant(HEALTH_READ_SCOPES, []));
      }
      await ensureInitialized();
      const granted = await grantedReadScopes(native);
      return grantedAuthorization(evaluatePermissionGrant(HEALTH_READ_SCOPES, granted));
    },

    async sleepHoursForDate(workoutDate: string): Promise<SleepImportResult> {
      const availability = await this.availability();
      if (availability.kind !== "supported") {
        return { kind: "unavailable", reason: importUnavailableReason(availability) };
      }

      const native = loadNativeHealthConnect();
      if (native === null) return { kind: "unavailable", reason: "not-found" };

      // The read window must be computed before any await that could observe a
      // timezone change: each edge gets the offset of its own calendar day, so
      // a window spanning a DST switch keeps both boundaries on local
      // 20:00/12:00 instead of drifting by the switched hour.
      const previousDate = previousIsoDate(workoutDate);
      if (previousDate === null) {
        return { kind: "error", message: "Invalid workout date" };
      }
      const startOffsetMinutes = tzOffsetMinutesForDate(previousDate);
      const endOffsetMinutes = tzOffsetMinutesForDate(workoutDate);
      const window = nightWindowRange(workoutDate, startOffsetMinutes, endOffsetMinutes);
      if (window === null) {
        return { kind: "error", message: "Invalid workout date" };
      }

      await ensureInitialized();
      const granted = await grantedReadScopes(native);
      const grant = evaluatePermissionGrant(HEALTH_READ_SCOPES, granted);
      // Only sleep gates the import; resting heart rate is not read yet.
      if (!grant.granted.includes(SLEEP_READ_SCOPE)) return { kind: "no-permission" };

      let result: { records: Array<Record<string, unknown>> };
      try {
        result = await native.readRecords("SleepSession", {
          timeRangeFilter: {
            operator: "between",
            startTime: new Date(window.startMs).toISOString(),
            endTime: new Date(window.endMs).toISOString(),
          },
        });
      } catch (cause) {
        // The Log screen renders this as a dismissable danger notice; a native
        // read failure must not escape the adapter as a rejection.
        return {
          kind: "error",
          message: cause instanceof Error && cause.message !== "" ? cause.message : "Sleep read failed",
        };
      }
      const sessions = result.records
        .map(toSleepSessionLike)
        .filter((session): session is SleepSessionLike => session !== null);
      return aggregateSleepHours(sessions, workoutDate, startOffsetMinutes, endOffsetMinutes);
    },

    /**
     * Resting heart rate is deliberately unread on Android in this slice
     * (issue #50 scoped the import to sleep; the scope is requested and shown
     * in the status line but no query runs). Returning `null` keeps the
     * contract honest for the platform-agnostic screen: "this store has no
     * value to offer", never a fabricated 0 or a claim that none was recorded.
     */
    async restingHeartRateForDate(): Promise<number | null> {
      return null;
    },
  };
}

let providerSingleton: PlatformHealthProvider | null = null;

/** The app-wide Health Connect provider (one instance per launch). */
export function getHealthConnectProvider(): PlatformHealthProvider {
  providerSingleton ??= createHealthConnectProvider();
  return providerSingleton;
}

/**
 * The current device's phone brand, as the Android import-button brand gate
 * reads it: Android exposes `Platform.constants.Brand` ("samsung", "Xiaomi",
 * "vivo", …). iOS constants carry no brand field, so an iOS device reads as
 * "apple" directly — the iOS import button no longer depends on this at all
 * (it names Apple Health unconditionally, issue #51); the value only remains
 * the Android brand table's input. Other shells read as an unknown brand.
 */
export function getCurrentPhoneBrand(): string {
  if (Platform.OS === "android") return Platform.constants.Brand;
  return Platform.OS === "ios" ? "apple" : "";
}
