import { todayLocalDate } from "@agent-fit-trace/workout-session";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { getHealthConnectProvider, getCurrentPhoneBrand } from "@/health/healthConnect";
import {
  healthConnectStatusKey,
  recentWakeDates,
  SLEEP_READ_SCOPE,
  summarizeRecentNightsImport,
  supportedPhoneBrand,
  type HealthAvailability,
  type HealthConnectStatusKey,
  type HealthImportUnavailableReason,
  type ImportedNight,
  type PermissionRequestResult,
} from "@/health/healthModel";
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
  brandUnsupported: "Import from your phone brand is not supported yet",
  importing: "Reading Health Connect…",
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
};

/** Status-line copy per resolved key; keys come from the pure status model. */
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

/** Copy for an import blocked by the runtime, not by permissions or data. */
const UNAVAILABLE_COPY: Record<HealthImportUnavailableReason, string> = {
  platform: copy.statusPlatform,
  "not-found": copy.statusNotFound,
  "needs-install": copy.statusNeedsInstall,
  "needs-update": copy.statusNeedsUpdate,
};

/** Message for a Health Connect failure notice; never empty. */
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

  // Device-local Health Connect state, moved from the Me tab. `null` means
  // "still hydrating"; the toggle and the status line render the off state
  // until hydration lands.
  const healthProvider = useMemo(() => getHealthConnectProvider(), []);
  const [healthEnabled, setHealthEnabled] = useState<boolean | null>(null);
  const [healthAvailability, setHealthAvailability] = useState<HealthAvailability | null>(null);
  const [healthGrant, setHealthGrant] = useState<PermissionRequestResult | null>(null);
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
        const [enabled, availability, grant] = await Promise.all([
          readHealthConnectEnabled(),
          healthProvider.availability(),
          healthProvider.currentPermissions(),
        ]);
        if (cancelled || refreshGenerationRef.current !== generation) return;
        setHealthHydrationFailed(false);
        setHealthEnabled(enabled);
        setHealthAvailability(availability);
        setHealthGrant(grant);
      } catch {
        // A failed read must never reject into the effect: land on safe
        // defaults (off, unavailable, nothing granted) so the toggle stays
        // usable and can never wedge behind a permanent `null` (the on-device
        // QA deadlock).
        if (cancelled || refreshGenerationRef.current !== generation) return;
        setHealthHydrationFailed(true);
        setHealthEnabled(false);
        setHealthAvailability({ kind: "unavailable", reason: "platform" });
        setHealthGrant({ granted: [], missing: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [healthProvider]);

  useFocusEffect(refreshHealthConnect);

  const healthStatus = healthHydrationFailed
    ? "platform"
    : healthConnectStatusKey(healthEnabled, healthAvailability, healthGrant);

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
      const grant = await healthProvider.requestReadPermissions();
      setHealthGrant(grant);
      setHealthHydrationFailed(false);
      if (!grant.granted.includes(SLEEP_READ_SCOPE)) {
        setHealthNotice(t(copy.healthPermissionDenied));
        return;
      }
      await writeHealthConnectEnabled(true);
      setHealthEnabled(true);
    } catch (cause) {
      setHealthNotice(t(copy.healthError, { message: healthErrorMessage(cause) }));
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
            source: "health-connect",
          },
          baselineRevision,
        );
        if (stored === null) {
          supersededCount += 1;
          continue;
        }
        imported.push({ date, hoursText: result.hoursText });
        setEntries(stored);
      }
      const summary = summarizeRecentNightsImport(imported);
      if (summary.kind === "imported") {
        setImportNotice({
          tone: "info",
          message: t(copy.importOkNights, {
            count: summary.count,
            date: summary.latestDate,
            hours: summary.latestHoursText,
          }),
        });
      } else if (supersededCount > 0) {
        // Every read raced a user write and lost; the history keeps whatever
        // the user saved, so say that instead of claiming empty Health Connect.
        setImportNotice({ tone: "warn", message: t(copy.importSuperseded) });
      } else {
        setImportNotice({ tone: "warn", message: t(copy.importNoData) });
      }
    } catch (cause) {
      setImportNotice({
        tone: "danger",
        message: t(copy.importError, { message: healthErrorMessage(cause) }),
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

  return (
    <Screen bottomInset testID="screen-health">
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>

      <Card testID="health-connect-section">
        <Kicker>{t(copy.connectKicker)}</Kicker>
        <Title>{t(copy.connectTitle)}</Title>
        <Body
          testID="health-status"
          tone={healthStatus === "supported" || healthStatus === "off" ? "muted" : "warn"}>
          {t(HEALTH_STATUS_COPY[healthStatus])}
        </Body>
        <Body>{t(copy.healthScopes)}</Body>
        {healthNotice !== null ? (
          <Banner message={healthNotice} testID="health-notice" tone="info" />
        ) : null}
        <Button
          accessibilityLabel={t(healthEnabled ? copy.healthDisable : copy.healthEnable)}
          disabled={healthBusy || healthEnabled === null}
          fullWidth
          label={healthEnabled ? t(copy.healthDisable) : t(copy.healthEnable)}
          onPress={() => {
            void handleToggleHealthConnect();
          }}
          testID="health-toggle"
          variant="secondary"
        />
      </Card>

      <Card testID="health-sleep-section">
        <Kicker>{t(copy.sleepKicker)}</Kicker>
        <Title>{t(copy.sleepTitle)}</Title>
        <Body>{t(copy.sleepLede)}</Body>

        {/*
          * Display-layer brand convention (user-observed wording, issue #50):
          * the button names the current device's brand even though the reader
          * behind it is always Health Connect. On an Apple phone that means
          * the label already shows the Apple copy while HealthKit import is
          * not implemented yet — the tap simply runs the existing
          * availability flow, which reports the "platform" status there.
          */}
        {importReady ? (
          phoneBrand === null ? (
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
          <Body>{t(copy.manualLede)}</Body>
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
                  {entry.date} · {entry.hoursText} h ·{" "}
                  {t(entry.source === "manual" ? copy.sourceManual : copy.connectTitle)}
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
