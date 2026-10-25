import { Platform } from "react-native";

import {
  aggregateSleepHours,
  createSingleFlightInit,
  evaluatePermissionGrant,
  importUnavailableReason,
  mapHealthConnectStatus,
  nightWindowFor,
  HEALTH_READ_SCOPES,
  type HealthAvailability,
  type HealthProvider,
  type PermissionRequestResult,
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

function createHealthConnectProvider(): HealthProvider {
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

    async requestReadPermissions(): Promise<PermissionRequestResult> {
      if (Platform.OS !== "android") return { granted: [], missing: [...HEALTH_READ_SCOPES] };
      const native = loadNativeHealthConnect();
      if (native === null) return { granted: [], missing: [...HEALTH_READ_SCOPES] };
      await ensureInitialized();
      const granted = grantedRecordTypes(await native.requestPermission(readPermissions()));
      return evaluatePermissionGrant(HEALTH_READ_SCOPES, granted);
    },

    async currentPermissions(): Promise<PermissionRequestResult> {
      if (Platform.OS !== "android") return { granted: [], missing: [...HEALTH_READ_SCOPES] };
      const native = loadNativeHealthConnect();
      if (native === null) return { granted: [], missing: [...HEALTH_READ_SCOPES] };
      await ensureInitialized();
      const granted = await grantedReadScopes(native);
      return evaluatePermissionGrant(HEALTH_READ_SCOPES, granted);
    },

    async sleepHoursForDate(workoutDate: string): Promise<SleepImportResult> {
      const availability = await this.availability();
      if (availability.kind !== "supported") {
        return { kind: "unavailable", reason: importUnavailableReason(availability) };
      }

      const native = loadNativeHealthConnect();
      if (native === null) return { kind: "unavailable", reason: "not-found" };

      // The read window must be computed before any await that could observe a
      // timezone change; the device offset is read once here.
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      const window = nightWindowFor(workoutDate, tzOffsetMinutes);
      if (window === null) {
        return { kind: "error", message: "Invalid workout date" };
      }

      await ensureInitialized();
      const granted = await grantedReadScopes(native);
      const grant = evaluatePermissionGrant(HEALTH_READ_SCOPES, granted);
      // Only sleep gates the import; resting heart rate is not read yet.
      if (!grant.granted.includes("SleepSession")) return { kind: "no-permission" };

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
      return aggregateSleepHours(sessions, workoutDate, tzOffsetMinutes);
    },
  };
}

let providerSingleton: HealthProvider | null = null;

/** The app-wide Health Connect provider (one instance per launch). */
export function getHealthConnectProvider(): HealthProvider {
  providerSingleton ??= createHealthConnectProvider();
  return providerSingleton;
}
