/**
 * Pure Health Connect model for the mobile app.
 *
 * This module owns the environment-free rules behind the sleep import: the
 * provider contract, the night-window aggregation that turns Health Connect
 * sleep sessions into one `sleepHours` string for the Log draft, the SDK-status
 * mapping and the granular permission bookkeeping (sleep and resting heart rate
 * are tracked separately).
 *
 * It imports no React, no React Native, no platform or native module and no
 * Node built-ins, so the root `node:test` suite can load it through Node's
 * TypeScript type stripping. The thin native adapter lives in
 * `healthConnect.ts` (never imported by tests).
 */

/**
 * Numeric sleep-stage codes from Android Health Connect's
 * `androidx.health.connect.client.records.SleepStageType`, mirrored as a plain
 * const object. The installed native library exports these as a TypeScript
 * enum (values verified against its `constants.d.ts`), which this pure module
 * must not import.
 */
export const SLEEP_STAGE = {
  UNKNOWN: 0,
  AWAKE: 1,
  SLEEPING: 2,
  OUT_OF_BED: 3,
  LIGHT: 4,
  DEEP: 5,
  REM: 6,
} as const;

/** Stage codes that count toward sleep duration (everything but wake states). */
const VALID_SLEEP_STAGES: ReadonlySet<number> = new Set([
  SLEEP_STAGE.UNKNOWN,
  SLEEP_STAGE.SLEEPING,
  SLEEP_STAGE.LIGHT,
  SLEEP_STAGE.DEEP,
  SLEEP_STAGE.REM,
]);

/**
 * `getSdkStatus` status codes of the installed native library
 * (`SdkAvailabilityStatus`, verified against its `constants.d.ts`), mirrored
 * as a plain const object for the same no-enum reason as `SLEEP_STAGE`.
 */
export const SDK_AVAILABILITY_STATUS = {
  SDK_UNAVAILABLE: 1,
  SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED: 2,
  SDK_AVAILABLE: 3,
} as const;

/** Why Health Connect cannot be used on this device right now. */
export type HealthUnavailableReason = "platform" | "not-found";

/** Why one import attempt could not reach Health Connect at all. */
export type HealthImportUnavailableReason =
  | HealthUnavailableReason
  | "needs-install"
  | "needs-update";

/** Runtime availability of Health Connect on this device. */
export type HealthAvailability =
  | { kind: "supported" }
  | { kind: "needs-install" }
  | { kind: "needs-update" }
  | { kind: "unavailable"; reason: HealthUnavailableReason };

/**
 * The scope that gates the whole import: without the sleep read there is no
 * sleep to import, no matter what else is granted.
 */
export const SLEEP_READ_SCOPE = "SleepSession";

/**
 * The read scopes this app requests. Resting heart rate is requested and shown
 * in the Me status line but is not read yet (issue #50 scope: sleep only).
 */
export const HEALTH_READ_SCOPES: readonly string[] = [
  SLEEP_READ_SCOPE,
  "RestingHeartRate",
] as const;

/** Granular permission bookkeeping: granted and missing record types. */
export interface PermissionRequestResult {
  granted: string[];
  missing: string[];
}

/**
 * One sleep session in a provider-neutral shape, with instants as ISO strings.
 * The native adapter normalizes `SleepSessionRecord`s into this; the model
 * never sees library types.
 */
export interface SleepSessionLike {
  start: string;
  end: string;
  stages?: Array<{ stage: number; start: string; end: string }>;
}

/** Result of asking the provider for the sleep behind one workout date. */
export type SleepImportResult =
  | {
      kind: "ok";
      /** One-decimal string ready for the Log draft's `sleepHours` field. */
      hoursText: string;
      /** Unrounded valid-sleep total, in whole minutes. */
      totalMinutes: number;
      /** Sessions inside the night window (fragmented nights are summed). */
      sessionCount: number;
    }
  | { kind: "no-permission" }
  | { kind: "partial-permission"; granted: string[]; missing: string[] }
  | { kind: "unavailable"; reason: HealthImportUnavailableReason }
  | { kind: "no-data" }
  | { kind: "error"; message: string };

/**
 * Map a non-supported availability to an import-result reason, so the Log
 * screen can say "install Health Connect" instead of a generic failure.
 */
export function importUnavailableReason(
  availability: Exclude<HealthAvailability, { kind: "supported" }>,
): HealthImportUnavailableReason {
  if (availability.kind === "unavailable") return availability.reason;
  return availability.kind;
}

/* ── phone-brand gate (display-layer convention) ─────────────────── */

/** The phone brands whose health platform the import copy names explicitly. */
export type SupportedPhoneBrand = "samsung" | "apple" | "xiaomi";

/**
 * Lowercased `Platform.constants.Brand` value → the supported brand. Some Redmi
 * firmware reports the brand as "Redmi"; it is the same Mi Fitness path, so it
 * folds into the xiaomi brand.
 */
const SUPPORTED_PHONE_BRANDS: Readonly<Record<string, SupportedPhoneBrand>> = {
  samsung: "samsung",
  apple: "apple",
  xiaomi: "xiaomi",
  redmi: "xiaomi",
};

/**
 * Map a device brand string (Android's `Platform.constants.Brand` —
 * "samsung", "Xiaomi", "vivo", …) to the import button's supported brand.
 * Matching is case-insensitive on purpose: the raw constants differ in casing
 * across OEMs and firmwares. Anything else — unknown, empty — reads as an
 * unsupported brand and the import area says so instead of offering a button.
 */
export function supportedPhoneBrand(brand: string): SupportedPhoneBrand | null {
  return SUPPORTED_PHONE_BRANDS[brand.trim().toLowerCase()] ?? null;
}

/**
 * The most recent `nights` wake-up dates, newest first: the D of each night
 * window [D-1 20:00, D 12:00] for tonight, yesterday, … D-(nights-1).
 *
 * The calendar math uses `Date.UTC` on the date's numeric parts, so month,
 * year and leap-day rollovers are correct by construction — never string
 * arithmetic on the date itself. An invalid `endDate` (or a non-positive
 * `nights`) yields an empty list, which the caller renders as no import at
 * all rather than a crash.
 */
export function recentWakeDates(endDate: string, nights: number): string[] {
  if (!isIsoDate(endDate) || !Number.isInteger(nights) || nights <= 0) return [];
  const [year, month, day] = endDate.split("-").map(Number);
  const dates: string[] = [];
  for (let offset = 0; offset < nights; offset += 1) {
    // `Date.UTC` normalizes day 0 / month overflow, so every back-step is
    // rollover-safe; the ISO slice round-trips the UTC instant.
    dates.push(new Date(Date.UTC(year, month - 1, day - offset)).toISOString().slice(0, 10));
  }
  return dates;
}

/** One night that a recent-nights import stored successfully. */
export interface ImportedNight {
  /** Wake-up date "YYYY-MM-DD" of the stored night. */
  date: string;
  /** The one-decimal hours string that was stored for it. */
  hoursText: string;
}

/**
 * The notice decision for a finished recent-nights import: at least one
 * stored night summarizes into the success line driven by the latest night;
 * none reads as the source-sync no-data guidance. Pure so the screen only
 * picks the copy — the outcome rules stay testable without React.
 */
export type RecentNightsImportSummary =
  | { kind: "imported"; count: number; latestDate: string; latestHoursText: string }
  | { kind: "no-data" };

export function summarizeRecentNightsImport(
  imported: readonly ImportedNight[],
): RecentNightsImportSummary {
  if (imported.length === 0) return { kind: "no-data" };
  // ISO dates sort lexicographically: scan for the newest stored night,
  // independent of the order the loop happened to store them in.
  let latest = imported[0];
  for (const night of imported) {
    if (night.date > latest.date) latest = night;
  }
  return {
    kind: "imported",
    count: imported.length,
    latestDate: latest.date,
    latestHoursText: latest.hoursText,
  };
}

/**
 * Turn an idempotent `initialize` thunk into a single-flight guard.
 *
 * The returned function shares one in-flight promise across concurrent
 * callers, so the wrapped work runs at most once while it succeeds. A rejected
 * run is never cached — the promise is dropped before the rejection propagates
 * so the next caller retries from scratch. The Health Connect adapter wraps
 * the native `initialize()` with this, because every native call except
 * `getSdkStatus` needs an initialized client.
 */
export function createSingleFlightInit(
  initialize: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    inFlight ??= initialize().catch((cause: unknown) => {
      inFlight = null;
      throw cause;
    });
    return inFlight;
  };
}

/**
 * The device-local health-store platform this app runs on, resolved from
 * `Platform.OS`. Anything that is neither Android nor iOS (a web bundle, a test
 * shell) reads as "other" and offers no import at all, instead of guessing.
 */
export type HealthPlatform = "android" | "ios" | "other";

/** Map a `Platform.OS` value to the platform whose health store to read. */
export function healthPlatformFor(os: string): HealthPlatform {
  if (os === "android") return "android";
  if (os === "ios") return "ios";
  return "other";
}

/**
 * Which device health store a provider reads. It doubles as the sleep-store
 * source recorded with every imported night, so a stored entry always names the
 * store it came from.
 */
export type HealthSourceKind = "health-connect" | "apple-health";

/**
 * Read authorization as each platform can actually observe it.
 *
 * Android Health Connect answers with granular per-scope grants, so a denied
 * sleep read is a fact the UI can state. HealthKit deliberately does not: for
 * read types it reports neither a grant nor a denial (its `AuthorizationStatus`
 * covers sharing — write — access, and `getRequestStatusForAuthorization` only
 * says whether the sheet was already shown). The iOS arm is therefore
 * `unknown`: the request was made (`requested`) or not, and the app must never
 * translate that into "denied", nor read an empty result as a revoked
 * permission.
 */
export type HealthAuthorization =
  | { kind: "granted"; granted: string[]; missing: string[] }
  | { kind: "unknown"; requested: boolean };

/**
 * Whether a sleep read may proceed.
 *
 * Android: the sleep scope must be in the granted set. iOS: the authorization
 * sheet must already have been shown — the answer is `unknown` either way, so
 * the read goes ahead and an empty result is reported as no data. Treating
 * "not yet requested" as unusable is what keeps the first attempt from reading
 * before the sheet, which the HealthKit bridge treats as a crash.
 */
export function sleepReadUsable(authorization: HealthAuthorization): boolean {
  if (authorization.kind === "granted") return authorization.granted.includes(SLEEP_READ_SCOPE);
  return authorization.requested;
}

/**
 * Status-line key for the iOS Health section. Deliberately a different set from
 * `HealthConnectStatusKey`: there is no install/update path and no observable
 * revocation, so a "no-permission" state would be a claim the platform cannot
 * support.
 */
export type AppleHealthStatusKey =
  | "off"
  | "supported"
  | "authorization-unknown"
  | "platform"
  | "not-found";

/**
 * Resolve the iOS status line. Toggle first (off hides the rest), then
 * availability, then the authorization fact: a completed request reads as
 * "authorization-unknown" — *not* granted — because HealthKit hides read
 * grants. "Unknown" describes what this app knows, never what the user chose.
 */
export function appleHealthStatusKey(
  enabled: boolean | null,
  availability: HealthAvailability | null,
  authorization: HealthAuthorization | null,
): AppleHealthStatusKey {
  if (enabled !== true) return "off";
  if (availability === null) return "off";
  if (availability.kind === "unavailable") {
    return availability.reason === "platform" ? "platform" : "not-found";
  }
  // HealthKit has no Health Connect-style install/update state; a provider that
  // reports one is misconfigured, and "not-found" is the honest fallback.
  if (availability.kind === "needs-install" || availability.kind === "needs-update") {
    return "not-found";
  }
  if (authorization?.kind === "unknown" && authorization.requested) {
    return "authorization-unknown";
  }
  return "supported";
}

/**
 * `HKAuthorizationRequestStatus` values from
 * `@react-native-healthkit/core`'s `AuthorizationRequestStatus`, mirrored as a
 * plain const object: the pure layer must stay erasable and must not import
 * the native library's TypeScript enum.
 *
 * This is the only authorization fact HealthKit exposes for read types. It
 * says whether the request sheet was already shown — `unnecessary` means shown,
 * `shouldRequest` means not yet, `unknown` means the platform could not tell.
 * None of the three is a grant or a denial.
 */
export const HEALTHKIT_AUTHORIZATION_REQUEST_STATUS = {
  unknown: 0,
  shouldRequest: 1,
  unnecessary: 2,
} as const;

/**
 * Normalize `getRequestStatusForAuthorization`'s answer into the neutral
 * authorization model. `unnecessary` is the only state in which the read may
 * proceed without prompting; anything else — including a `null` the adapter
 * passes after a failed read — reads as "not requested yet", never as a grant
 * and never as a denial. That conservatism is what keeps a query from running
 * before the sheet has been shown, which the HealthKit bridge treats as a
 * crash.
 */
export function healthKitAuthorizationFromStatus(status: number | null): HealthAuthorization {
  return {
    kind: "unknown",
    requested: status === HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unnecessary,
  };
}

/**
 * Whether the adapter must show the authorization sheet before reading.
 *
 * Only `unnecessary` proves the sheet was already shown. `shouldRequest`,
 * `unknown` and a failed status read (`null`) all require the request first:
 * re-showing the sheet is harmless (the system does not prompt twice for the
 * same types), while querying before it exists crashes the bridge.
 */
export function needsHealthKitAuthorizationRequest(status: number | null): boolean {
  return status !== HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unnecessary;
}

/**
 * The UTC offset (minutes east of UTC) in effect at local noon of `date`
 * ("YYYY-MM-DD", validated by the caller through `isIsoDate`).
 *
 * Noon is sampled because DST transitions happen in the early morning, so the
 * offset at noon is the offset that date's evening and daytime hours use — the
 * offset each night-window edge must carry on a DST switch day. A malformed
 * date yields `NaN`, which the caller rejects via the window check.
 *
 * Shared by both platform adapters (`healthConnect.ts`, `healthKit.ts`) so the
 * night window is computed by one rule, not two drifting copies.
 */
export function tzOffsetMinutesForDate(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const localNoon = new Date(year, month - 1, day, 12, 0, 0);
  return -localNoon.getTimezoneOffset();
}

/** The calendar day before `workoutDate` ("YYYY-MM-DD"), rollover-safe. */
export function previousIsoDate(workoutDate: string): string | null {
  if (!isIsoDate(workoutDate)) return null;
  const [year, month, day] = workoutDate.split("-").map(Number);
  // `Date.UTC` normalizes day 0 / month overflow; the ISO slice round-trips.
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * One status-line decision, already resolved for the current platform, so the
 * Health screen renders a key instead of branching on `Platform.OS` itself.
 */
export type HealthStatusView =
  | { platform: "android"; key: HealthConnectStatusKey }
  | { platform: "ios"; key: AppleHealthStatusKey }
  | { platform: "other"; key: "platform" };

/**
 * Resolve the status line for whichever health store this platform has.
 *
 * The Android arm delegates to `healthConnectStatusKey` with the granular grant
 * (or `null` while hydrating), so the existing Android status behavior is
 * untouched by the iOS addition. An iOS `unknown` authorization carries no
 * grant, so the Android rule must never see it.
 */
export function healthStatusView(
  platform: HealthPlatform,
  enabled: boolean | null,
  availability: HealthAvailability | null,
  authorization: HealthAuthorization | null,
): HealthStatusView {
  if (platform === "android") {
    const grant =
      authorization !== null && authorization.kind === "granted"
        ? { granted: authorization.granted, missing: authorization.missing }
        : null;
    return {
      platform: "android",
      key: healthConnectStatusKey(enabled, availability, grant),
    };
  }
  if (platform === "ios") {
    return {
      platform: "ios",
      key: appleHealthStatusKey(enabled, availability, authorization),
    };
  }
  return { platform: "other", key: "platform" };
}

/**
 * The device-local Health Connect provider. Implementations must be usable
 * without React; the native adapter is the only implementation in the app.
 */
export interface HealthProvider {
  availability(): Promise<HealthAvailability>;
  /**
   * Request the read scopes. Returns the granular outcome; a rejection of one
   * scope never hides the grant of the other.
   */
  requestReadPermissions(): Promise<PermissionRequestResult>;
  /** Currently granted read scopes, without showing any system dialog. */
  currentPermissions(): Promise<PermissionRequestResult>;
  /** Aggregate the sleep behind `workoutDate` ("YYYY-MM-DD") into a draft value. */
  sleepHoursForDate(workoutDate: string): Promise<SleepImportResult>;
}

/**
 * Map the native SDK status number to a neutral availability.
 *
 * On Android 9–13 Health Connect is a separate APK, so `SDK_UNAVAILABLE`
 * usually means "not installed yet"; `SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED`
 * means an outdated module must be updated from the Play Store.
 */
export function mapHealthConnectStatus(sdkStatus: number): HealthAvailability {
  if (sdkStatus === SDK_AVAILABILITY_STATUS.SDK_AVAILABLE) return { kind: "supported" };
  if (sdkStatus === SDK_AVAILABILITY_STATUS.SDK_UNAVAILABLE) return { kind: "needs-install" };
  if (sdkStatus === SDK_AVAILABILITY_STATUS.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
    return { kind: "needs-update" };
  }
  return { kind: "unavailable", reason: "not-found" };
}

/**
 * Split the requested scopes into granted and missing record types.
 *
 * Both sides are plain record-type strings, so the native `Permission` objects
 * are flattened by the adapter before they reach this pure rule.
 */
export function evaluatePermissionGrant(
  requested: readonly string[],
  granted: readonly string[],
): PermissionRequestResult {
  const grantedSet = new Set(granted);
  return {
    granted: requested.filter((scope) => grantedSet.has(scope)),
    missing: requested.filter((scope) => !grantedSet.has(scope)),
  };
}

/** True for a real `YYYY-MM-DD` calendar date string (leap years included). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  // `Date.UTC` silently normalizes overflow (2026-02-29 → 2026-03-01), so the
  // round-trip must confirm the components survived unchanged.
  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

/** Night-window boundaries in UTC epoch milliseconds. */
interface NightWindow {
  startMs: number;
  endMs: number;
}

/**
 * Local night window for `workoutDate`: [D-1 20:00, D 12:00], where each edge
 * carries its own UTC offset.
 *
 * The two offsets are separate because the window can span a DST switch: the
 * D-1 evening edge belongs to the previous day's offset, the D noon edge to
 * the workout date's. With one offset for both edges the window drifts by the
 * DST hour on switch days. `nightWindowFor` is the single-offset convenience
 * for callers that know both edges share a timezone offset.
 *
 * Offsets are in minutes east of UTC (UTC+8 → 480, i.e. minus
 * `Date#getTimezoneOffset`). The calendar math uses `Date.UTC` on the date's
 * numeric parts so month and leap-year rollovers are correct by construction —
 * never string arithmetic on the date itself.
 */
export function nightWindowRange(
  workoutDate: string,
  startOffsetMinutes: number,
  endOffsetMinutes: number,
): NightWindow | null {
  if (!isIsoDate(workoutDate)) return null;
  const [year, month, day] = workoutDate.split("-").map(Number);
  return {
    // `Date.UTC` normalizes day 0 / month overflow, so D-1 is rollover-safe.
    startMs: Date.UTC(year, month - 1, day - 1, 20, 0, 0) - startOffsetMinutes * 60_000,
    endMs: Date.UTC(year, month - 1, day, 12, 0, 0) - endOffsetMinutes * 60_000,
  };
}

/** Single-offset form of `nightWindowRange` (both edges use the same offset). */
export function nightWindowFor(workoutDate: string, tzOffsetMinutes: number): NightWindow | null {
  return nightWindowRange(workoutDate, tzOffsetMinutes, tzOffsetMinutes);
}

/** One-decimal hours string, e.g. 451 minutes → "7.5". */
export function formatSleepHours(totalMinutes: number): string {
  return (Math.round(totalMinutes / 6) / 10).toFixed(1);
}

/** Intersection of [aStart, aEnd) and [bStart, bEnd), or null when empty. */
function overlapMs(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number | null {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return end > start ? end - start : null;
}

/**
 * Aggregate the sleep sessions that fall into `workoutDate`'s night window.
 *
 * - Every session overlapping the window contributes (fragmented nights are
 *   summed, never deduplicated or dropped — the core domain accepts 0–24 h).
 * - Sessions with stage data sum their valid stages (everything except AWAKE
 *   and OUT_OF_BED); sessions without stages fall back to their duration.
 * - All instants are UTC epoch milliseconds; the window is local because the
 *   caller passes each edge's own device offset (they differ on DST switch
 *   days — see `nightWindowRange`).
 * - A total beyond 24 h is the core domain's hard limit and returns an error
 *   kind instead of a value that the record build would reject.
 */
export function aggregateSleepHours(
  sessions: readonly SleepSessionLike[],
  workoutDate: string,
  startOffsetMinutes: number,
  endOffsetMinutes: number,
): SleepImportResult {
  const window = nightWindowRange(workoutDate, startOffsetMinutes, endOffsetMinutes);
  if (window === null) {
    return { kind: "error", message: "Invalid workout date" };
  }

  let totalMs = 0;
  let sessionCount = 0;
  for (const session of sessions) {
    const startMs = Date.parse(session.start);
    const endMs = Date.parse(session.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) continue;
    const sessionOverlap = overlapMs(startMs, endMs, window.startMs, window.endMs);
    if (sessionOverlap === null) continue;
    sessionCount += 1;

    const stages = session.stages ?? [];
    if (stages.length > 0) {
      for (const stage of stages) {
        if (!VALID_SLEEP_STAGES.has(stage.stage)) continue;
        const stageStart = Date.parse(stage.start);
        const stageEnd = Date.parse(stage.end);
        if (Number.isNaN(stageStart) || Number.isNaN(stageEnd) || stageEnd <= stageStart) {
          continue;
        }
        const stageOverlap = overlapMs(stageStart, stageEnd, window.startMs, window.endMs);
        if (stageOverlap !== null) totalMs += stageOverlap;
      }
    } else {
      totalMs += sessionOverlap;
    }
  }

  if (sessionCount === 0) return { kind: "no-data" };

  const totalMinutes = Math.round(totalMs / 60_000);
  if (totalMinutes > 24 * 60) {
    return {
      kind: "error",
      message: `Imported sleep total ${formatSleepHours(totalMinutes)} h exceeds the 24 h record limit`,
    };
  }

  return {
    kind: "ok",
    hoursText: formatSleepHours(totalMinutes),
    totalMinutes,
    sessionCount,
  };
}

/**
 * Parse the stored device-local toggle value into the effective state.
 *
 * Only the explicit `"true"` enables the import; a missing, unreadable or
 * wrongly-typed stored value is off. Pure so `deviceHealth.ts` (which owns the
 * AsyncStorage side and cannot be loaded by the node:test suite) stays thin.
 */
export function parseStoredHealthConnectEnabled(stored: string | null | undefined): boolean {
  return stored === "true";
}

/** The draft identity a sleep import is started for. */
export interface SleepImportDraftSnapshot {
  /** The workout date the night window is computed from. */
  date: string;
  /** The editor's draft revision at capture time (bumped by every edit/clear). */
  revision: number;
}

/**
 * Whether a finished sleep-import result may still be applied to the editor's
 * current draft.
 *
 * The native read is started for one draft snapshot, but the date field stays
 * editable and the draft can be cleared (or a different owner's draft loaded)
 * while the read is in flight. A result whose snapshot no longer matches the
 * current draft must be discarded: otherwise a stale night's sleep lands in a
 * newly edited date, or a late result resurrects a cleared draft.
 */
export function sleepImportMatchesDraft(
  captured: SleepImportDraftSnapshot,
  current: SleepImportDraftSnapshot,
): boolean {
  return captured.date === current.date && captured.revision === current.revision;
}

/** The storage surface the device-local opt-in persists through. */
export interface HealthConnectToggleStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Memory-first read/write state machine for the device-local Health Connect
 * opt-in.
 *
 * `read` prefers the in-memory value and only falls back to storage on the
 * first read (a miss, not a failure — a storage error reads as off and is not
 * cached, so a later read retries). `write` applies the memory value first and
 * only then persists; a failed persistence rolls the memory value back and
 * rethrows, so memory and storage can never silently disagree. The Me screen's
 * toggle handler surfaces the rejection and the Log screen's later reads stay
 * consistent with what is actually durable.
 */
export interface HealthConnectToggle {
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<void>;
}

export function createHealthConnectToggle(
  storage: HealthConnectToggleStorage,
  key: string,
): HealthConnectToggle {
  /** `null` until the first successful storage read populates the cache. */
  let memoryEnabled: boolean | null = null;
  return {
    async read(): Promise<boolean> {
      if (memoryEnabled !== null) return memoryEnabled;
      try {
        const enabled = parseStoredHealthConnectEnabled(await storage.getItem(key));
        memoryEnabled = enabled;
        return enabled;
      } catch {
        // Unreadable storage reads as off; the miss is not cached so a later
        // read retries the storage instead of pinning the failure.
        return false;
      }
    },
    async write(enabled: boolean): Promise<void> {
      const previous = memoryEnabled;
      memoryEnabled = enabled;
      try {
        await storage.setItem(key, enabled ? "true" : "false");
      } catch (cause) {
        // Durability failed: roll the memory value back so the in-session
        // state matches what storage actually holds, and let the caller
        // report the failure instead of swallowing it.
        memoryEnabled = previous;
        throw cause;
      }
    },
  };
}

/**
 * Status-line key for the Me screen's Health Connect section, resolved from
 * the device-local toggle, the runtime availability and the last grant.
 *
 * The toggle wins first (off hides everything else); then availability; then
 * the granular grant: the sleep read gates the whole import, so a missing
 * sleep grant is "no-permission" even when other scopes are granted, while a
 * missing resting-heart-rate grant beside a granted sleep scope stays
 * "partial".
 */
export type HealthConnectStatusKey =
  | "off"
  | "supported"
  | "no-permission"
  | "needs-install"
  | "needs-update"
  | "platform"
  | "not-found"
  | "partial";

export function healthConnectStatusKey(
  enabled: boolean | null,
  availability: HealthAvailability | null,
  grant: PermissionRequestResult | null,
): HealthConnectStatusKey {
  if (enabled !== true) return "off";
  if (availability === null || availability.kind === "unavailable") {
    return availability === null
      ? "off"
      : availability.reason === "platform"
        ? "platform"
        : "not-found";
  }
  if (availability.kind === "needs-install") return "needs-install";
  if (availability.kind === "needs-update") return "needs-update";
  if (grant !== null) {
    if (!grant.granted.includes(SLEEP_READ_SCOPE)) return "no-permission";
    return grant.missing.length > 0 ? "partial" : "supported";
  }
  return "supported";
}
