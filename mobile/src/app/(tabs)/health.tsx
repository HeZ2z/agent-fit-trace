import { todayLocalDate } from "@agent-fit-trace/workout-session";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { getCurrentPhoneBrand } from "@/health/healthConnect";
import {
  healthStatusView,
  recentWakeDates,
  sleepReadUsable,
  summarizeRecentNightsImport,
  supportedPhoneBrand,
  type AppleHealthStatusKey,
  type HealthAuthorization,
  type HealthAvailability,
  type HealthConnectStatusKey,
  type HealthImportUnavailableReason,
  type HealthPlatform,
  type ImportedNight,
} from "@/health/healthModel";
import { currentHealthPlatform, getHealthProvider } from "@/health/healthProvider";
import {
  deleteSleepEntry,
  listSleepEntriesDesc,
  parseManualSleepHours,
  readSleepEntries,
  readSleepStoreRevision,
  saveSleepEntry,
  saveSleepEntryIfUnchanged,
  type SleepEntry,
} from "@/health/sleepStore";
import { useI18n } from "@/i18n";
import {
  readHealthConnectEnabled,
  writeHealthConnectEnabled,
} from "@/preferences/deviceHealth";
import { SPACING } from "@/theme";
import { useSkin } from "@/theme/skin";
import {
  Banner,
  Body,
  Button,
  Card,
  DateField,
  Display,
  Field,
  Kicker,
  Screen,
  Title,
} from "@/ui";

/**
 * Health tab (bottom dock, issue #50 redesign).
 *
 * The screen owns everything Health Connect: the device-local opt-in with its
 * permission flow and status line, the one-tap import of the most recent
 * seven nights (button copy follows the device brand), manual entry for
 * devices without Health Connect, and the delete-able history of recorded
 * nights. The Log screen no longer imports sleep itself; saving a workout
 * attaches the recorded night for the draft date through the sleep store.
 */

const copy = {
  done: "Done",
  title: "Health",
  lede: "Optional and read-only. Reads from Health Connect happen only on this device; imported sleep becomes part of the workout record and syncs with it like a manually entered value.",
  ledeIos:
    "Optional and read-only. Reads from Apple Health happen only on this device; imported sleep becomes part of the workout record and syncs with it like a manually entered value.",
  connectKicker: "HEALTH CONNECT",
  connectTitle: "Health Connect",
  healthScopes: "Read-only scopes: sleep sessions and resting heart rate.",
  statusOff:
    "Off. Enable it to import sleep here; saving a workout for that date attaches it automatically.",
  statusSupported:
    "Connected. Saving a workout attaches that night's sleep automatically when it is recorded here.",
  statusNoPermission:
    "Sleep access has been revoked. Go to the system Health Connect settings and re-grant the read permission.",
  statusNeedsInstall:
    "Health Connect is not installed. Install it from the Google Play Store, then turn on “Sync with Health Connect” in Samsung Health settings.",
  statusNeedsUpdate:
    "Health Connect needs an update from the Google Play Store before sleep import can be used.",
  statusPlatform: "Health Connect is only available on Android devices.",
  statusNotFound: "Health Connect is not available on this device.",
  statusPartial:
    "Partially granted. Some Health Connect read permissions are missing; disable and enable again to grant them.",
  healthEnable: "Enable Health Connect",
  healthDisable: "Disable Health Connect",
  healthPermissionDenied:
    "Sleep import stays off. Grant Fit Trace read access to sleep and resting heart rate, and make sure Samsung Health has “Sync with Health Connect” turned on in its settings.",
  healthOffNote:
    "Off on this device. To revoke access entirely, remove Fit Trace from the Health Connect system settings.",
  healthError: "Health Connect error: {message}",
  sleepKicker: "SLEEP",
  sleepTitle: "Sleep",
  sleepLede: "Import your recent nights, or type the hours yourself.",
  importButtonSamsung: "Import from Samsung Health",
  importButtonApple: "Import from Apple Health",
  importButtonXiaomi: "Import from Mi Fitness",
  brandUnsupported: "Import from your phone brand is not supported yet",
  importButtonIos: "Import from Apple Health",
  importing: "Reading Health Connect…",
  importingIos: "Reading Apple Health…",
  importOkNights:
    "Imported {count} nights of sleep; latest night: {date} {hours} h",
  importNoData:
    "Health Connect has no records for the last 7 nights. Check that your data source (such as Samsung Health) has turned on syncing with Health Connect in its own settings.",
  importNoPermission:
    "Fit Trace has no Health Connect sleep access. Enable Health Connect above and grant the read permissions.",
  importPartial:
    "Only some Health Connect read permissions were granted. Disable and enable Health Connect above to grant the missing ones.",
  importError: "Could not import sleep: {message}",
  manualTitle: "Add sleep manually",
  manualLede:
    "No Health Connect? Record the night here; saving a workout for that date attaches it the same way.",
  manualLedeIos:
    "No Apple Health data? Record the night here; saving a workout for that date attaches it the same way.",
  manualDate: "Wake-up date",
  manualDateHint: "The night between the previous evening 20:00 and this date's 12:00.",
  manualHours: "Sleep (hours)",
  manualSave: "Save sleep entry",
  manualSaved: "Saved {hours} h of sleep for {date}.",
  manualInvalid: "Enter the sleep hours as a number between 0 and 24.",
  historyTitle: "Sleep history",
  historyEmpty: "No sleep recorded yet. Import a night or add one manually.",
  sourceManual: "Manual",
  entryRecorded: "Recorded {when}",
  entryDelete: "Delete",
  entryDeleted: "Sleep entry for {date} deleted.",
  sleepStoreError: "Could not update the sleep history: {message}",
  sleepStoreReadError: "Could not read the sleep history: {message}",
  importSuperseded:
    "That night's sleep changed while the import was running; the imported value was discarded to keep your newer entry.",

  /* iOS / Apple Health (issue #51) */
  appleKicker: "APPLE HEALTH",
  appleTitle: "Apple Health",
  appleScopes:
    "Read-only: sleep analysis and resting heart rate. Apple Health never tells an app whether read access was granted, so an empty import may mean limited access or simply no recorded sleep.",
  appleEnable: "Enable Apple Health",
  appleDisable: "Disable Apple Health",
  appleStatusOff:
    "Off. Enable it to import sleep here; saving a workout for that date attaches it automatically.",
  appleStatusSupported:
    "Enabled. Import your recent nights below; saving a workout attaches that night's sleep automatically when it is recorded here.",
  appleStatusAuthorizationUnknown:
    "Permissions requested. Apple Health does not reveal whether read access was granted; if an import comes back empty, check Settings › Health › Data Access & Devices › Fit Trace.",
  appleStatusPlatform: "Apple Health is only available on iOS devices.",
  appleStatusNotFound: "Apple Health is not available on this device.",
  applePermissionRequested:
    "The permission sheet was shown. Apple Health does not report read grants, so the import will tell you if there is no data to read.",
  appleImportNoData:
    "Apple Health has no sleep recorded for the last 7 nights. If you expect data, check Settings › Health › Data Access & Devices › Fit Trace and make sure your watch has synced.",
  appleOffNote:
    "Off on this device. To revoke access entirely, remove Fit Trace under Settings › Health › Data Access & Devices.",
  appleError: "Apple Health error: {message}",
  /*
   * The recovery read is surfaced with the limit stated in the same breath:
   * `WorkoutRecord` has only `sleep_hours`, so there is no field to persist a
   * resting heart rate in. Showing it as "imported" would be a claim the record
   * cannot back, so the line says exactly what was done and what was not.
   */
  restingHeartRateReadOnly:
    "Resting heart rate last night: {bpm} bpm. Read from Apple Health, not saved to the workout record.",
  appleRecoveryNote:
    "Resting heart rate is read for the same night window but not saved to the workout record yet.",
  sourceAppleHealth: "Apple Health",
};

/** Status-line copy per resolved Android key; keys come from the pure model. */
const HEALTH_STATUS_COPY: Record<HealthConnectStatusKey, string> = {
  off: copy.statusOff,
  supported: copy.statusSupported,
  "no-permission": copy.statusNoPermission,
  "needs-install": copy.statusNeedsInstall,
  "needs-update": copy.statusNeedsUpdate,
  platform: copy.statusPlatform,
  "not-found": copy.statusNotFound,
  partial: copy.statusPartial,
};

/**
 * Status-line copy per resolved iOS key. The set is deliberately smaller: there
 * is no install/update path and no observable revocation, so no key claims one.
 */
const APPLE_STATUS_COPY: Record<AppleHealthStatusKey, string> = {
  off: copy.appleStatusOff,
  supported: copy.appleStatusSupported,
  "authorization-unknown": copy.appleStatusAuthorizationUnknown,
  platform: copy.appleStatusPlatform,
  "not-found": copy.appleStatusNotFound,
};

/**
 * The status line's text for whichever platform this build runs on.
 *
 * `view.key` is resolved by the pure `healthStatusView`, so a key from one
 * platform's table can never be looked up in the other's — the fallback for a
 * cross-platform mix-up is the platform copy, which is true either way.
 */
function statusCopyFor(
  platform: HealthPlatform,
  viewKey: HealthConnectStatusKey | AppleHealthStatusKey | "platform",
): string {
  if (platform === "ios") {
    return APPLE_STATUS_COPY[viewKey as AppleHealthStatusKey] ?? copy.appleStatusPlatform;
  }
  if (platform === "android") {
    return HEALTH_STATUS_COPY[viewKey as HealthConnectStatusKey] ?? copy.statusPlatform;
  }
  return copy.statusPlatform;
}

/** Copy for an import blocked by the runtime, not by permissions or data. */
const UNAVAILABLE_COPY: Record<HealthImportUnavailableReason, string> = {
  platform: copy.statusPlatform,
  "not-found": copy.statusNotFound,
  "needs-install": copy.statusNeedsInstall,
  "needs-update": copy.statusNeedsUpdate,
};

/**
 * The history row's source label. Each stored source names its own store, so an
 * imported night always says whether Health Connect or Apple Health produced
 * it — never a generic "imported".
 */
function sourceLabelFor(source: SleepEntry["source"]): string {
  if (source === "manual") return copy.sourceManual;
  if (source === "apple-health") return copy.sourceAppleHealth;
  return copy.connectTitle;
}

/** Message for a health-store failure notice; never empty. */
function healthErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "Unknown error.";
}

/** Message for a sleep-store failure notice; never empty. */
function sleepStoreErrorMessage(cause: unknown): string {
  return healthErrorMessage(cause);
}

interface Notice {
  tone: "info" | "warn" | "danger";
  message: string;
}

export default function HealthScreen() {
  const { t } = useI18n();
  const { tokens } = useSkin();

  // Device-local health-store state. The provider is resolved per platform
  // (Health Connect on Android, Apple Health on iOS, nothing elsewhere), so this
  // screen never branches on `Platform.OS` itself. `null` means "still
  // hydrating"; the toggle and the status line render the off state until
  // hydration lands.
  const platform = useMemo(() => currentHealthPlatform(), []);
  const healthProvider = useMemo(() => getHealthProvider(), []);
  const [healthEnabled, setHealthEnabled] = useState<boolean | null>(null);
  const [healthAvailability, setHealthAvailability] = useState<HealthAvailability | null>(null);
  const [healthAuthorization, setHealthAuthorization] = useState<HealthAuthorization | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthNotice, setHealthNotice] = useState<string | null>(null);
  // True when hydration itself failed: the state falls back to safe defaults
  // and the status line shows the degraded "platform" copy instead of a
  // misleading "off" (the toggle value was never actually read). The flag is
  // sticky only until a later successful read (a focus re-read or the enable
  // flow) clears it — clearing it there lets the status line derive from the
  // freshly read availability/grants again, so a successful enable is never
  // permanently masked by an earlier hydration failure.
  const [healthHydrationFailed, setHealthHydrationFailed] = useState(false);

  // Generation token for focus-driven Health Connect refreshes. The toggle is
  // deliberately never disabled while a refresh is in flight (disabling it for
  // every slow read would cost more usability than the race is worth), so a
  // refresh that read the persisted opt-in before a toggle write landed could
  // otherwise apply the older value over the toggle's fresh state: the user
  // turns Health Connect off (the write succeeds), a late focus refresh that
  // had already read enabled=true applies it back, and the page would show
  // connected and offer sleep import while storage actually says off. Every
  // refresh captures the generation when it starts and drops its whole batch
  // of state writes if a toggle has bumped the generation in the meantime.
  const refreshGenerationRef = useRef(0);

  // The Health tab lives in the bottom dock, so it stays mounted after the
  // first visit and a mount-time read alone would go stale: the user can grant
  // or revoke the Health Connect permissions in the system settings and switch
  // back, and the status line would keep claiming the outdated connected or
  // revoked state indefinitely. Re-read the opt-in, availability and grants on
  // every focus instead (the log.tsx precedent); useFocusEffect also fires on
  // the first focus, so this covers the mount-time hydration too. A read that
  // lands after a newer focus loses to it via `cancelled`, and one that lands
  // after a toggle loses via the generation check, so a stale grant can never
  // overwrite the fresh one.
  const refreshHealthConnect = useCallback(() => {
    const generation = refreshGenerationRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const [enabled, availability, authorization] = await Promise.all([
          readHealthConnectEnabled(),
          healthProvider.availability(),
          healthProvider.currentPermissions(),
        ]);
        if (cancelled || refreshGenerationRef.current !== generation) return;
        setHealthHydrationFailed(false);
        setHealthEnabled(enabled);
        setHealthAvailability(availability);
        setHealthAuthorization(authorization);
      } catch {
        // A failed read must never reject into the effect: land on safe
        // defaults (off, unavailable, nothing granted) so the toggle stays
        // usable and can never wedge behind a permanent `null` (the on-device
        // QA deadlock).
        if (cancelled || refreshGenerationRef.current !== generation) return;
        setHealthHydrationFailed(true);
        setHealthEnabled(false);
        setHealthAvailability({ kind: "unavailable", reason: "platform" });
        setHealthAuthorization({ kind: "granted", granted: [], missing: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [healthProvider]);

  useFocusEffect(refreshHealthConnect);

  // One status-line decision, resolved per platform by the pure model, so the
  // render below looks up copy instead of branching. A failed hydration shows
  // the platform copy (the toggle value was never actually read) — the same
  // degraded state the Android-only version showed.
  const healthStatusLine = healthHydrationFailed
    ? "platform"
    : healthStatusView(platform, healthEnabled, healthAvailability, healthAuthorization).key;
  const healthStatusText = statusCopyFor(platform, healthStatusLine);

  /**
   * Toggle the device-local opt-in. Enabling first checks availability, then
   * requests the read permissions; a denied sleep grant keeps the toggle off
   * and shows guidance. The write is awaited: a failed persistence rethrows
   * after rolling the toggle back, so the in-app state stays off and the
   * catch reports the failure instead of the UI showing a state storage never
   * received. Disabling is in-app only (Health Connect grants are revoked
   * from the system settings, which the notice says).
   */
  async function handleToggleHealthConnect(): Promise<void> {
    if (healthBusy || healthEnabled === null) return;
    // Both toggle directions invalidate every in-flight focus refresh: each
    // pending refresh captured the pre-toggle generation and will drop its
    // whole batch instead of applying the opt-in value it read before this
    // write landed (see refreshGenerationRef above).
    refreshGenerationRef.current += 1;
    setHealthBusy(true);
    setHealthNotice(null);
    try {
      if (healthEnabled) {
        await writeHealthConnectEnabled(false);
        setHealthEnabled(false);
        setHealthNotice(t(copy.healthOffNote));
        return;
      }
      const availability = await healthProvider.availability();
      setHealthAvailability(availability);
      // This availability read succeeded, so the degraded hydration-failure
      // state is over: clear the flag so the status line derives from the
      // fresh state instead of being stuck on the "platform" copy.
      setHealthHydrationFailed(false);
      if (availability.kind !== "supported") {
        // Stay off; the status line and notice carry the install/update hint.
        const key =
          availability.kind === "unavailable"
            ? availability.reason === "platform"
              ? "platform"
              : "not-found"
            : availability.kind;
        setHealthNotice(t(HEALTH_STATUS_COPY[key]));
        return;
      }
      const authorization = await healthProvider.requestReadPermissions();
      setHealthAuthorization(authorization);
      setHealthHydrationFailed(false);
      if (!sleepReadUsable(authorization)) {
        // Android: the sleep scope was refused, so say so and stay off.
        // iOS: the sheet could not be shown at all (a throwing request reads as
        // `requested: false`), which is a failure to *ask* — never a denial.
        setHealthNotice(t(platform === "ios" ? copy.applePermissionRequested : copy.healthPermissionDenied));
        return;
      }
      await writeHealthConnectEnabled(true);
      setHealthEnabled(true);
      // iOS can only report that the sheet was shown, so say that and point at
      // Settings for the case where the user actually limited access.
      if (platform === "ios") setHealthNotice(t(copy.applePermissionRequested));
    } catch (cause) {
      setHealthNotice(
        t(platform === "ios" ? copy.appleError : copy.healthError, {
          message: healthErrorMessage(cause),
        }),
      );
    } finally {
      setHealthBusy(false);
    }
  }

  // The import button only exists when the opt-in is on and the runtime is
  // supported; every other state is explained by the status line above it.
  const importReady =
    !healthHydrationFailed &&
    healthEnabled === true &&
    healthAvailability?.kind === "supported";

  // Sleep history. `null` until the first read lands, so the empty-state copy
  // never flashes before the store answered.
  const [entries, setEntries] = useState<SleepEntry[] | null>(null);
  const [historyNotice, setHistoryNotice] = useState<Notice | null>(null);

  // Re-read the history on every focus: only this screen writes the store,
  // and this keeps imports and deletes visible after a round trip through
  // another screen without reloading the Health Connect hydration above. A
  // failed read is surfaced as a notice, never turned into an empty history —
  // the store's own writes refuse to run against a history they could not
  // read (issue #50).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readSleepEntries().then(
        (stored) => {
          if (cancelled) return;
          setEntries(stored);
        },
        (cause: unknown) => {
          if (cancelled) return;
          setHistoryNotice({
            tone: "danger",
            message: t(copy.sleepStoreReadError, { message: sleepStoreErrorMessage(cause) }),
          });
        },
      );
      return () => {
        cancelled = true;
      };
    }, [t]),
  );

  // The device's phone brand, read once per mount: it decides whether the
  // import area offers the one-tap button (and whose brand it names) or the
  // unsupported-brand note. The brand string itself comes from the native
  // adapter; the pure `supportedPhoneBrand` keeps the matching testable.
  const phoneBrand = useMemo(() => supportedPhoneBrand(getCurrentPhoneBrand()), []);

  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<Notice | null>(null);

  // Manual entry state (works without Health Connect). Its wake-up date
  // defaults to today: the D of the night window [D-1 20:00, D 12:00], i.e.
  // the morning the user woke up.
  const [manualDate, setManualDate] = useState(() => todayLocalDate());
  const [manualHoursText, setManualHoursText] = useState("");
  const [manualNotice, setManualNotice] = useState<Notice | null>(null);

  /**
   * Import the most recent seven nights (wake-up dates today, yesterday, …
   * today-6) from Health Connect and store each recorded night. The button is
   * busy for the whole run; every outcome — including the common "Health
   * Connect is empty" case — gets its own honest message.
   *
   * Only `ok` results write a sleep entry (replace-on-reimport by wake-up
   * date); a `no-data` night is simply skipped — the other nights still
   * import. Failure kinds (no permission, install/update needed, read error)
   * stop the run and reuse the existing single-night copy, because the same
   * failure would hit every remaining night.
   *
   * Each write is guarded by the store-level optimistic lock (issue #50):
   * manual saves and deletes stay available while the import runs, so every
   * night re-reads the store's revision immediately before its conditional
   * `upsertIfUnchanged`, which re-checks the revision and persists inside one
   * serialized store step. A mismatch means the user saved or deleted a night
   * in that window; the late import result for that night is discarded (the
   * user's newer entry wins) instead of overwriting or resurrecting it.
   */
  async function handleImportSleep(): Promise<void> {
    if (importing || !importReady) return;
    setImporting(true);
    setImportNotice(null);
    try {
      const imported: ImportedNight[] = [];
      let supersededCount = 0;
      // The recovery read is report-only (no persistence contract), so it is
      // collected for the notice, not stored: the newest imported night's value.
      let recoveryBpm: number | null = null;
      for (const date of recentWakeDates(todayLocalDate(), 7)) {
        const result = await healthProvider.sleepHoursForDate(date);
        if (result.kind === "no-data") continue;
        if (result.kind !== "ok") {
          if (result.kind === "error") {
            setImportNotice({
              tone: "danger",
              message: t(copy.importError, { message: result.message }),
            });
          } else if (result.kind === "no-permission") {
            setImportNotice({ tone: "warn", message: t(copy.importNoPermission) });
          } else if (result.kind === "partial-permission") {
            setImportNotice({ tone: "warn", message: t(copy.importPartial) });
          } else if (platform === "ios") {
            // iOS can only read "unavailable" here; its details differ enough
            // (no install/update path) to keep their own copy.
            setImportNotice({
              tone: "warn",
              message: t(result.reason === "platform" ? copy.appleStatusPlatform : copy.appleStatusNotFound),
            });
          } else {
            setImportNotice({ tone: "warn", message: t(UNAVAILABLE_COPY[result.reason]) });
          }
          return;
        }
        const baselineRevision = await readSleepStoreRevision();
        const stored = await saveSleepEntryIfUnchanged(
          {
            date,
            hours: Number(result.hoursText),
            hoursText: result.hoursText,
            sessionCount: result.sessionCount,
            importedAt: new Date().toISOString(),
            // The provider names the store it read, so a stored night always
            // records whether it came from Health Connect or Apple Health.
            source: healthProvider.sourceKind,
          },
          baselineRevision,
        );
        if (stored === null) {
          supersededCount += 1;
          continue;
        }
        imported.push({ date, hoursText: result.hoursText });
        setEntries(stored);
        // Only on iOS, and only for the first (newest) night that imported: a
        // recovery signal is per-night, and mixing nights would mislabel it.
        if (platform === "ios" && recoveryBpm === null) {
          recoveryBpm = await healthProvider.restingHeartRateForDate(date);
        }
      }
      const summary = summarizeRecentNightsImport(imported);
      if (summary.kind === "imported") {
        // The recovery line is appended only when a value was actually read, and
        // it states in the same breath that nothing was saved — the record has
        // no field for it (see the gap in docs/mobile.md).
        const recovery =
          recoveryBpm === null ? "" : ` ${t(copy.restingHeartRateReadOnly, { bpm: recoveryBpm })}`;
        setImportNotice({
          tone: "info",
          message:
            t(copy.importOkNights, {
              count: summary.count,
              date: summary.latestDate,
              hours: summary.latestHoursText,
            }) + recovery,
        });
      } else if (supersededCount > 0) {
        // Every read raced a user write and lost; the history keeps whatever
        // the user saved, so say that instead of claiming empty Health Connect.
        setImportNotice({ tone: "warn", message: t(copy.importSuperseded) });
      } else {
        // An empty read on iOS has three possible causes the platform will not
        // distinguish (denied, limited, or no samples), so its copy says that.
        setImportNotice({
          tone: "warn",
          message: t(platform === "ios" ? copy.appleImportNoData : copy.importNoData),
        });
      }
    } catch (cause) {
      setImportNotice({
        tone: "danger",
        message: t(platform === "ios" ? copy.appleError : copy.importError, {
          message: healthErrorMessage(cause),
        }),
      });
    } finally {
      setImporting(false);
    }
  }

  /** Store a manually typed night for the manual wake-up date (no Health Connect). */
  async function handleManualSave(): Promise<void> {
    setManualNotice(null);
    const parsed = parseManualSleepHours(manualHoursText);
    if (!parsed.ok) {
      setManualNotice({ tone: "warn", message: t(copy.manualInvalid) });
      return;
    }
    try {
      const stored = await saveSleepEntry({
        date: manualDate,
        hours: parsed.hours,
        hoursText: parsed.hoursText,
        sessionCount: 0,
        importedAt: new Date().toISOString(),
        source: "manual",
      });
      setEntries(stored);
      setManualHoursText("");
      setManualNotice({
        tone: "info",
        message: t(copy.manualSaved, { hours: parsed.hoursText, date: manualDate }),
      });
    } catch (cause) {
      setManualNotice({
        tone: "danger",
        message: t(copy.sleepStoreError, { message: sleepStoreErrorMessage(cause) }),
      });
    }
  }

  /** Delete one stored night. Already-saved workouts are never touched. */
  async function handleDeleteEntry(date: string): Promise<void> {
    setHistoryNotice(null);
    try {
      const stored = await deleteSleepEntry(date);
      setEntries(stored);
      setHistoryNotice({ tone: "info", message: t(copy.entryDeleted, { date }) });
    } catch (cause) {
      setHistoryNotice({
        tone: "danger",
        message: t(copy.sleepStoreError, { message: sleepStoreErrorMessage(cause) }),
      });
    }
  }

  const historyDesc = entries === null ? [] : listSleepEntriesDesc(entries);

  /** The opt-in button's label, naming this platform's health app. */
  const toggleLabel = t(
    platform === "ios"
      ? healthEnabled
        ? copy.appleDisable
        : copy.appleEnable
      : healthEnabled
        ? copy.healthDisable
        : copy.healthEnable,
  );

  return (
    <Screen bottomInset testID="screen-health">
      <Display>{t(copy.title)}</Display>
      <Body>{t(platform === "ios" ? copy.ledeIos : copy.lede)}</Body>

      <Card testID="health-connect-section">
        <Kicker>{t(platform === "ios" ? copy.appleKicker : copy.connectKicker)}</Kicker>
        <Title>{t(platform === "ios" ? copy.appleTitle : copy.connectTitle)}</Title>
        <Body
          testID="health-status"
          tone={
            healthStatusLine === "supported" ||
            healthStatusLine === "off" ||
            healthStatusLine === "authorization-unknown"
              ? "muted"
              : "warn"
          }>
          {t(healthStatusText)}
        </Body>
        <Body>{t(platform === "ios" ? copy.appleScopes : copy.healthScopes)}</Body>
        {healthNotice !== null ? (
          <Banner message={healthNotice} testID="health-notice" tone="info" />
        ) : null}
        <Button
          accessibilityLabel={toggleLabel}
          disabled={healthBusy || healthEnabled === null}
          fullWidth
          label={toggleLabel}
          onPress={() => {
            void handleToggleHealthConnect();
          }}
          testID="health-toggle"
          variant="secondary"
        />
        {/*
          * The recovery read has no persistence contract yet (WorkoutRecord has
          * only sleep_hours), so it is surfaced as read-only and never claimed
          * as imported. Shown only where the platform can read it at all.
          */}
        {platform === "ios" ? <Body testID="health-recovery-note">{t(copy.appleRecoveryNote)}</Body> : null}
      </Card>

      <Card testID="health-sleep-section">
        <Kicker>{t(copy.sleepKicker)}</Kicker>
        <Title>{t(copy.sleepTitle)}</Title>
        <Body>{t(copy.sleepLede)}</Body>

        {/*
          * Import copy per platform. iOS has exactly one health store, so the
          * button says "Apple Health" with no brand matching at all. Android
          * keeps the display-layer brand convention (issue #50): the button
          * names the device brand while the reader behind it is Health Connect.
          */}
        {importReady ? (
          platform === "ios" ? (
            <>
              <Button
                disabled={importing}
                label={t(importing ? copy.importingIos : copy.importButtonIos)}
                onPress={() => {
                  void handleImportSleep();
                }}
                testID="health-sleep-import"
                variant="secondary"
              />
              {importNotice !== null ? (
                <Banner
                  message={importNotice.message}
                  testID="health-import-notice"
                  tone={importNotice.tone}
                />
              ) : null}
            </>
          ) : phoneBrand === null ? (
            <Body testID="health-brand-unsupported">{t(copy.brandUnsupported)}</Body>
          ) : (
            <>
              <Button
                disabled={importing}
                label={
                  importing
                    ? t(copy.importing)
                    : t(
                        phoneBrand === "samsung"
                          ? copy.importButtonSamsung
                          : phoneBrand === "xiaomi"
                            ? copy.importButtonXiaomi
                            : copy.importButtonApple,
                      )
                }
                onPress={() => {
                  void handleImportSleep();
                }}
                testID="health-sleep-import"
                variant="secondary"
              />
              {importNotice !== null ? (
                <Banner
                  message={importNotice.message}
                  testID="health-import-notice"
                  tone={importNotice.tone}
                />
              ) : null}
            </>
          )
        ) : null}

        <View style={styles.manualBlock}>
          <Title>{t(copy.manualTitle)}</Title>
          <Body>{t(platform === "ios" ? copy.manualLedeIos : copy.manualLede)}</Body>
          <DateField
            accessibilityLabel={t(copy.manualDate)}
            doneLabel={t(copy.done)}
            hint={t(copy.manualDateHint)}
            label={t(copy.manualDate)}
            onConfirm={setManualDate}
            testID="health-manual-date"
            value={manualDate}
          />
          <Field
            keyboardType="decimal-pad"
            label={t(copy.manualHours)}
            onChangeText={setManualHoursText}
            testID="health-manual-hours"
            value={manualHoursText}
          />
          <Button
            fullWidth
            label={t(copy.manualSave)}
            onPress={() => {
              void handleManualSave();
            }}
            testID="health-manual-save"
            variant="secondary"
          />
          {manualNotice !== null ? (
            <Banner
              message={manualNotice.message}
              testID="health-manual-notice"
              tone={manualNotice.tone}
            />
          ) : null}
        </View>
      </Card>

      <Card testID="health-history-section">
        <Title>{t(copy.historyTitle)}</Title>
        {entries === null ? null : historyDesc.length === 0 ? (
          <Body testID="health-history-empty">{t(copy.historyEmpty)}</Body>
        ) : (
          historyDesc.map((entry) => (
            <View key={entry.date} style={styles.historyRow} testID="health-history-row">
              <View style={styles.historyCopy}>
                <Body tone="default" style={styles.historyDate}>
                  {entry.date} · {entry.hoursText} h · {t(sourceLabelFor(entry.source))}
                </Body>
                <Body>
                  {t(copy.entryRecorded, {
                    when: new Date(entry.importedAt).toLocaleString(),
                  })}
                </Body>
              </View>
              <Button
                accessibilityLabel={`${t(copy.entryDelete)} ${entry.date}`}
                label={t(copy.entryDelete)}
                onPress={() => {
                  void handleDeleteEntry(entry.date);
                }}
                testID={`health-history-delete-${entry.date}`}
                variant="secondary"
              />
            </View>
          ))
        )}
        {historyNotice !== null ? (
          <Banner
            message={historyNotice.message}
            testID="health-history-notice"
            tone={historyNotice.tone}
          />
        ) : null}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  manualBlock: { gap: SPACING[2] },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING[2],
  },
  historyCopy: { flex: 1, gap: SPACING[1] },
  historyDate: { fontWeight: "700" },
});
