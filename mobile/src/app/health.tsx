import { todayLocalDate } from "@agent-fit-trace/workout-session";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { getHealthConnectProvider } from "@/health/healthConnect";
import {
  healthConnectStatusKey,
  SLEEP_READ_SCOPE,
  type HealthAvailability,
  type HealthConnectStatusKey,
  type HealthImportUnavailableReason,
  type PermissionRequestResult,
} from "@/health/healthModel";
import {
  deleteSleepEntry,
  listSleepEntriesDesc,
  parseManualSleepHours,
  readSleepEntries,
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
 * Health screen (stack route, reached from Me — issue #50 redesign).
 *
 * The screen owns everything Health Connect: the device-local opt-in with its
 * permission flow and status line (moved verbatim from the Me tab), the
 * wake-up-date sleep import, manual entry for devices without Health Connect,
 * and the delete-able history of recorded nights. The Log screen no longer
 * imports sleep itself; saving a workout attaches the recorded night for the
 * draft date through the sleep store.
 */

const copy = {
  back: "Back",
  backLabel: "Go back",
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
  sleepLede: "Import the night behind the wake-up date, or type the hours yourself.",
  wakeDate: "Wake-up date",
  wakeDateHint: "The night between the previous evening 20:00 and this date's 12:00.",
  importButton: "Import sleep from Health Connect",
  importing: "Reading Health Connect…",
  importOkOne: "Imported {hours} h of sleep from 1 Health Connect session.",
  importOkMany: "Imported {hours} h of sleep from {count} Health Connect sessions.",
  importNoData:
    "Health Connect has no records for that night. Check that your data source (such as Samsung Health) has turned on syncing with Health Connect in its own settings.",
  importNoPermission:
    "Fit Trace has no Health Connect sleep access. Enable Health Connect above and grant the read permissions.",
  importPartial:
    "Only some Health Connect read permissions were granted. Disable and enable Health Connect above to grant the missing ones.",
  importError: "Could not import sleep: {message}",
  manualTitle: "Add sleep manually",
  manualLede:
    "No Health Connect? Record the night here; saving a workout for that date attaches it the same way.",
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
  const router = useRouter();
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
  // sticky only until a later manual refresh succeeds — clearing it there lets
  // the status line derive from the freshly read availability/grants again,
  // so a successful enable is never permanently masked by an earlier
  // hydration failure.
  const [healthHydrationFailed, setHealthHydrationFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [enabled, availability, grant] = await Promise.all([
          readHealthConnectEnabled(),
          healthProvider.availability(),
          healthProvider.currentPermissions(),
        ]);
        if (cancelled) return;
        setHealthHydrationFailed(false);
        setHealthEnabled(enabled);
        setHealthAvailability(availability);
        setHealthGrant(grant);
      } catch {
        // Hydration must never reject into the effect: land on safe defaults
        // (off, unavailable, nothing granted) so the toggle stays usable and
        // can never wedge behind a permanent `null` (the on-device QA deadlock).
        if (cancelled) return;
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

  // The wake-up date defaults to today: the D of the night window
  // [D-1 20:00, D 12:00], i.e. the morning the user woke up.
  const [wakeDate, setWakeDate] = useState(() => todayLocalDate());

  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<Notice | null>(null);

  // Manual entry state (works without Health Connect).
  const [manualHoursText, setManualHoursText] = useState("");
  const [manualNotice, setManualNotice] = useState<Notice | null>(null);

  /**
   * Import the chosen night from Health Connect and store it. Every outcome —
   * including the common "Health Connect is empty" case — gets its own honest
   * message; only an `ok` result writes a sleep entry (replace-on-reimport by
   * wake-up date).
   *
   * The write is guarded by a per-night optimistic lock that lives in the
   * store itself (issue #50): manual saves and deletes stay available while
   * an import runs (disabling the whole page for a slow Health Connect read
   * would cost more usability than the rare race), so the import captures the
   * night's version token — its `importedAt`, or the absence of an entry — at
   * the start and hands it to `saveSleepEntryIfUnchanged`, which re-checks the
   * token and persists inside one serialized store step. A mismatch means the
   * user saved, re-recorded or deleted that night meanwhile, and the late
   * import result is discarded with a notice instead of overwriting the newer
   * entry or resurrecting a deleted one.
   */
  async function handleImportSleep(): Promise<void> {
    if (importing || !importReady) return;
    setImporting(true);
    setImportNotice(null);
    const capturedDate = wakeDate;
    try {
      const snapshot = entries ?? (await readSleepEntries());
      const baselineToken =
        snapshot.find((night) => night.date === capturedDate)?.importedAt ?? null;
      const result = await healthProvider.sleepHoursForDate(capturedDate);
      if (result.kind === "ok") {
        const stored = await saveSleepEntryIfUnchanged(
          {
            date: capturedDate,
            hours: Number(result.hoursText),
            hoursText: result.hoursText,
            sessionCount: result.sessionCount,
            importedAt: new Date().toISOString(),
            source: "health-connect",
          },
          baselineToken,
        );
        if (stored === null) {
          setImportNotice({ tone: "warn", message: t(copy.importSuperseded) });
          return;
        }
        setEntries(stored);
        setImportNotice({
          tone: "info",
          message: t(
            result.sessionCount === 1 ? copy.importOkOne : copy.importOkMany,
            { hours: result.hoursText, count: result.sessionCount },
          ),
        });
        return;
      }
      if (result.kind === "error") {
        setImportNotice({
          tone: "danger",
          message: t(copy.importError, { message: result.message }),
        });
        return;
      }
      if (result.kind === "no-data") {
        setImportNotice({ tone: "warn", message: t(copy.importNoData) });
        return;
      }
      if (result.kind === "no-permission") {
        setImportNotice({ tone: "warn", message: t(copy.importNoPermission) });
        return;
      }
      if (result.kind === "partial-permission") {
        setImportNotice({ tone: "warn", message: t(copy.importPartial) });
        return;
      }
      setImportNotice({
        tone: "warn",
        message: t(UNAVAILABLE_COPY[result.reason]),
      });
    } catch (cause) {
      setImportNotice({
        tone: "danger",
        message: t(copy.importError, { message: healthErrorMessage(cause) }),
      });
    } finally {
      setImporting(false);
    }
  }

  /** Store a manually typed night for the wake-up date (no Health Connect). */
  async function handleManualSave(): Promise<void> {
    setManualNotice(null);
    const parsed = parseManualSleepHours(manualHoursText);
    if (!parsed.ok) {
      setManualNotice({ tone: "warn", message: t(copy.manualInvalid) });
      return;
    }
    try {
      const stored = await saveSleepEntry({
        date: wakeDate,
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
        message: t(copy.manualSaved, { hours: parsed.hoursText, date: wakeDate }),
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

        <DateField
          accessibilityLabel={t(copy.wakeDate)}
          doneLabel={t(copy.done)}
          hint={t(copy.wakeDateHint)}
          label={t(copy.wakeDate)}
          onConfirm={setWakeDate}
          testID="health-wake-date"
          value={wakeDate}
        />

        {importReady ? (
          <>
            <Button
              disabled={importing}
              label={importing ? t(copy.importing) : t(copy.importButton)}
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
        ) : null}

        <View style={styles.manualBlock}>
          <Title>{t(copy.manualTitle)}</Title>
          <Body>{t(copy.manualLede)}</Body>
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

      <Button
        accessibilityLabel={t(copy.backLabel)}
        label={t(copy.back)}
        onPress={() => router.back()}
        testID="health-back"
        variant="secondary"
      />
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
