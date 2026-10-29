import { Platform } from "react-native";

import {
  formatSleepHours,
  healthKitAuthorizationFromStatus,
  needsHealthKitAuthorizationRequest,
  nightWindowRange,
  previousIsoDate,
  sleepReadUsable,
  tzOffsetMinutesForDate,
  type HealthAuthorization,
  type HealthAvailability,
  type PlatformHealthProvider,
  type SleepImportResult,
} from "./healthModel.ts";
import {
  isAsleepValue,
  selectRestingHeartRate,
  unionAsleepMinutes,
  type RestingHeartRateSample,
  type SleepInterval,
} from "./sleepIntervals.ts";

/**
 * Thin native adapter between `@kingstinct/react-native-healthkit` and the pure
 * `healthModel` / `sleepIntervals` rules. Everything domain-shaped — the night
 * window, the interval union, the aggregate — happens in those modules; this
 * file checks the platform, calls the SDK and normalizes its samples.
 *
 * Read-only by contract: HealthKit is read for sleep stages and resting heart
 * rate, never written. There is no `save*` call here, no sharing (write) scope and no
 * background delivery (`background: false` in the Expo plugin config), and a
 * guarded node:test case pins that against the source text.
 *
 * Tests never import this module: the native side only exists on an iOS device
 * build, and `getHealthKitProvider()` keeps one provider instance for the app's
 * lifetime.
 */

/**
 * The native module's surface used here. Only this file's own type declaration
 * describes it — the library is never imported statically, because touching it
 * off-iOS (or in a JS-only shell) is a hard crash.
 *
 * Every member below was checked against the installed package's own
 * declarations (`lib/typescript/healthkit.d.ts`,
 * `lib/typescript/specs/CoreModule.nitro.d.ts`,
 * `lib/typescript/types/CategoryType.d.ts`,
 * `lib/typescript/types/QuantitySample.d.ts`,
 * `@react-native-healthkit/core/lib/typescript/types/Auth.d.ts`):
 * - `queryCategorySamples` returns a plain array (v16, not the anchored
 *   `{ samples }` object).
 * - sleep-analysis samples carry `startDate`/`endDate` as `Date` objects and a
 *   numeric `value`.
 * - `getRequestStatusForAuthorization` takes `{ toRead }` and returns the
 *   `AuthorizationRequestStatus` number.
 */
interface HealthKitNative {
  isHealthDataAvailable(): boolean;
  requestAuthorization(request: { readonly toRead: readonly string[] }): Promise<boolean>;
  getRequestStatusForAuthorization(request: {
    readonly toRead: readonly string[];
  }): Promise<number>;
  queryCategorySamples(
    categoryTypeIdentifier: string,
    options: {
      readonly limit: number;
      readonly ascending?: boolean;
      readonly filter?: { readonly date?: { readonly startDate?: Date; readonly endDate?: Date } };
    },
  ): Promise<readonly HealthKitCategorySample[]>;
  queryQuantitySamples(
    identifier: string,
    options: {
      readonly limit: number;
      readonly ascending?: boolean;
      readonly unit?: string;
      readonly filter?: { readonly date?: { readonly startDate?: Date; readonly endDate?: Date } };
    },
  ): Promise<readonly HealthKitQuantitySample[]>;
}

/** One sleep-analysis category sample, as the library hands it over. */
interface HealthKitCategorySample {
  readonly startDate: Date;
  readonly endDate: Date;
  readonly value: number;
}

/** One quantity sample (resting heart rate), as the library hands it over. */
interface HealthKitQuantitySample {
  readonly startDate: Date;
  readonly quantity: number;
}

/**
 * The HealthKit object identifiers read here. Sleep analysis is a category type,
 * resting heart rate a quantity type; `HKObjectType` identifiers are the
 * library's string alphabet.
 */
const SLEEP_ANALYSIS_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";
const RESTING_HEART_RATE_TYPE = "HKQuantityTypeIdentifierRestingHeartRate";

/** The unit the resting-heart-rate query is normalized to (bpm). */
const RESTING_HEART_RATE_UNIT = "count/min";

/**
 * Load the native module lazily and only on iOS. A static import would touch
 * the Nitro module on every platform; on Android (and in non-native shells)
 * that is a hard crash, so non-iOS never requires it and a failed require
 * degrades to "not found" instead of throwing at import time.
 */
function loadNativeHealthKit(): HealthKitNative | null {
  if (Platform.OS !== "ios") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@kingstinct/react-native-healthkit") as HealthKitNative;
  } catch {
    return null;
  }
}

/** The read scopes this app requests: sleep analysis and resting heart rate. */
const HEALTHKIT_READ_SCOPES: readonly string[] = [
  SLEEP_ANALYSIS_TYPE,
  RESTING_HEART_RATE_TYPE,
] as const;

/** `null` when the workout date is unusable; the caller reports an error. */
interface NightWindowMs {
  startMs: number;
  endMs: number;
}

/**
 * The same night window the Android adapter uses: local [D-1 20:00, D 12:00],
 * each edge carrying its own calendar day's UTC offset so a DST switch inside
 * the window cannot drift a boundary.
 */
function nightWindowForDate(workoutDate: string): NightWindowMs | null {
  const previousDate = previousIsoDate(workoutDate);
  if (previousDate === null) return null;
  return nightWindowRange(
    workoutDate,
    tzOffsetMinutesForDate(previousDate),
    tzOffsetMinutesForDate(workoutDate),
  );
}

/** Normalize one category sample into a half-open ISO interval, or `null`. */
function toSleepInterval(sample: HealthKitCategorySample): SleepInterval | null {
  if (!isAsleepValue(sample.value)) return null;
  const startMs = sample.startDate instanceof Date ? sample.startDate.getTime() : Number.NaN;
  const endMs = sample.endDate instanceof Date ? sample.endDate.getTime() : Number.NaN;
  // The union drops malformed intervals too; rejecting here keeps the mapper's
  // own output honest instead of relying on the downstream rule.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

/** Message for a native failure; never empty. */
function nativeErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return fallback;
}

function createHealthKitProvider(): PlatformHealthProvider {
  /**
   * Ask the user for the read scopes, then report the only fact HealthKit
   * exposes: whether the sheet was already shown. A throwing/rejected request
   * reads as `requested: false` — never as a denial, because HealthKit does not
   * tell us the user's answer for read types and guessing "denied" would make
   * the screen claim something the platform never said.
   */
  async function requestReadAuthorization(native: HealthKitNative): Promise<HealthAuthorization> {
    try {
      await native.requestAuthorization({ toRead: HEALTHKIT_READ_SCOPES });
    } catch (cause) {
      console.warn("[healthKit] requestAuthorization failed; not treating it as a denial", cause);
      return { kind: "unknown", requested: false };
    }
    // The request resolved: the sheet has been shown. That is not a grant, and
    // the screen's iOS copy says exactly that.
    return { kind: "unknown", requested: true };
  }

  /**
   * Make sure the authorization sheet was shown before any query, because the
   * library crashes when a read runs first (its README states this). A failed
   * status read is treated as "not yet requested", so the sheet is shown again
   * rather than risking the crash.
   *
   * Returns whether querying is now safe. The boolean is deliberately not
   * `void`: when the sheet was still required and the request itself failed,
   * the read must stop. Proceeding would query without satisfying the
   * library's prerequisite (a crash risk) and would then report the empty
   * answer as `no-data`, hiding a failure to *ask* behind "nothing recorded".
   * A sheet that was already shown (`unnecessary`) needs no request and stays
   * safe, so only a genuinely failed request blocks the read.
   */
  async function ensureAuthorizationRequested(native: HealthKitNative): Promise<boolean> {
    let status: number | null = null;
    try {
      status = await native.getRequestStatusForAuthorization({ toRead: HEALTHKIT_READ_SCOPES });
    } catch (cause) {
      console.warn("[healthKit] getRequestStatusForAuthorization failed; requesting first", cause);
    }
    if (!needsHealthKitAuthorizationRequest(status)) return true;
    // Reuse the same tested rule the screen's enable flow uses rather than
    // restating it: `requested: false` (a failed request) is not usable, and a
    // completed request is usable even though it is not a grant.
    return sleepReadUsable(await requestReadAuthorization(native));
  }

  return {
    sourceKind: "apple-health",

    async availability(): Promise<HealthAvailability> {
      // The platform gate comes first and never touches the native module.
      if (Platform.OS !== "ios") return { kind: "unavailable", reason: "platform" };
      const native = loadNativeHealthKit();
      if (native === null) return { kind: "unavailable", reason: "not-found" };
      try {
        return native.isHealthDataAvailable()
          ? { kind: "supported" }
          : { kind: "unavailable", reason: "not-found" };
      } catch {
        return { kind: "unavailable", reason: "not-found" };
      }
    },

    async requestReadPermissions(): Promise<HealthAuthorization> {
      if (Platform.OS !== "ios") return { kind: "unknown", requested: false };
      const native = loadNativeHealthKit();
      if (native === null) return { kind: "unknown", requested: false };
      return requestReadAuthorization(native);
    },

    async currentPermissions(): Promise<HealthAuthorization> {
      if (Platform.OS !== "ios") return { kind: "unknown", requested: false };
      const native = loadNativeHealthKit();
      if (native === null) return { kind: "unknown", requested: false };
      try {
        const status = await native.getRequestStatusForAuthorization({
          toRead: HEALTHKIT_READ_SCOPES,
        });
        return healthKitAuthorizationFromStatus(status);
      } catch (cause) {
        console.warn("[healthKit] getRequestStatusForAuthorization failed; unknown state", cause);
        return { kind: "unknown", requested: false };
      }
    },

    async sleepHoursForDate(workoutDate: string): Promise<SleepImportResult> {
      const availability = await this.availability();
      if (availability.kind !== "supported") {
        return {
          kind: "unavailable",
          reason: availability.kind === "unavailable" ? availability.reason : availability.kind,
        };
      }

      const native = loadNativeHealthKit();
      if (native === null) return { kind: "unavailable", reason: "not-found" };

      // The read window must be computed before any await that could observe a
      // timezone change (same reasoning as the Android adapter).
      const window = nightWindowForDate(workoutDate);
      if (window === null) return { kind: "error", message: "Invalid workout date" };

      // The query must not run before the sheet exists, and a request that
      // failed is reported as its own error — not as "no sleep recorded".
      if (!(await ensureAuthorizationRequested(native))) {
        return {
          kind: "error",
          message:
            "Apple Health authorization could not be requested. Open the Health app or Settings once, then try again.",
        };
      }

      let samples: readonly HealthKitCategorySample[];
      try {
        samples = await native.queryCategorySamples(SLEEP_ANALYSIS_TYPE, {
          limit: 0,
          ascending: true,
          filter: {
            date: {
              startDate: new Date(window.startMs),
              endDate: new Date(window.endMs),
            },
          },
        });
      } catch (cause) {
        // The screen renders this as a dismissable danger notice; a native read
        // failure must not escape the adapter as a rejection.
        return { kind: "error", message: nativeErrorMessage(cause, "Sleep read failed") };
      }

      const intervals = samples
        .map(toSleepInterval)
        .filter((interval): interval is SleepInterval => interval !== null);
      const total = unionAsleepMinutes(intervals, window.startMs, window.endMs);

      // No asleep sample in the window. HealthKit cannot say *why*: the user may
      // have denied read access, granted limited access, or simply have no
      // recorded sleep. All three are "no data" here — never "no permission",
      // which the platform never told us.
      if (total.intervalCount === 0) return { kind: "no-data" };

      if (total.totalMinutes > 24 * 60) {
        return {
          kind: "error",
          message: `Imported sleep total ${formatSleepHours(total.totalMinutes)} h exceeds the 24 h record limit`,
        };
      }

      return {
        kind: "ok",
        hoursText: formatSleepHours(total.totalMinutes),
        totalMinutes: total.totalMinutes,
        sessionCount: total.intervalCount,
      };
    },

    /**
     * The resting heart rate recorded inside the same night window: the latest
     * plausible sample, rounded to a whole bpm, or `null` when none is readable.
     *
     * Read but not persisted — `WorkoutRecord` carries only `sleep_hours`, so
     * there is no contract to store it in yet (see the gap documented in
     * `docs/mobile.md`). Callers may display it; nothing claims it reached the
     * workout record.
     */
    async restingHeartRateForDate(workoutDate: string): Promise<number | null> {
      const availability = await this.availability();
      if (availability.kind !== "supported") return null;

      const native = loadNativeHealthKit();
      if (native === null) return null;

      const window = nightWindowForDate(workoutDate);
      if (window === null) return null;

      // The recovery read is optional: a failed authorization request reads as
      // "no value", never as a reason to fail the night's sleep import.
      if (!(await ensureAuthorizationRequested(native))) return null;

      let samples: readonly HealthKitQuantitySample[];
      try {
        samples = await native.queryQuantitySamples(RESTING_HEART_RATE_TYPE, {
          limit: 0,
          ascending: true,
          unit: RESTING_HEART_RATE_UNIT,
          filter: {
            date: {
              startDate: new Date(window.startMs),
              endDate: new Date(window.endMs),
            },
          },
        });
      } catch (cause) {
        // Recovery data is a bonus beside the sleep import: a failed read reads
        // as "no value", not as a failure of the night's import.
        console.warn("[healthKit] resting heart rate read failed; reporting no value", cause);
        return null;
      }

      const normalized: RestingHeartRateSample[] = samples
        .filter(
          (sample): sample is HealthKitQuantitySample =>
            sample.startDate instanceof Date && Number.isFinite(sample.quantity),
        )
        .map((sample) => ({ start: sample.startDate.toISOString(), bpm: sample.quantity }));
      return selectRestingHeartRate(normalized, window.startMs, window.endMs);
    },
  };
}

let providerSingleton: PlatformHealthProvider | null = null;

/** The app-wide Apple Health provider (one instance per launch). */
export function getHealthKitProvider(): PlatformHealthProvider {
  providerSingleton ??= createHealthKitProvider();
  return providerSingleton;
}
