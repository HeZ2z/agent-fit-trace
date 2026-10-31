import { displaySessionType } from "@agent-fit-trace/i18n/domain";
import { stableStringify } from "@agent-fit-trace/core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Share, StyleSheet, View } from "react-native";

import { useAuth } from "@/auth";
import { useWorkoutData } from "@/data/provider";
import { useI18n } from "@/i18n";
import {
  abortSyncRun,
  acknowledgeSyncConflict,
  conflictExportJson,
  decideSyncConflict,
  type SyncConflictAction,
  type SyncRunResult,
} from "@/sync/syncApplyModel";
import { WorkoutSyncClient } from "@/sync/syncClient";
import type { SyncConflict } from "@/sync/syncModel";
import { runWorkoutSync, type SyncRunAccount } from "@/sync/syncRunner";
import { SPACING } from "@/theme";
import { Banner, Body, Button, Card, Display, Kicker, Screen, Title } from "@/ui";

/**
 * Manual cloud-sync screen.
 *
 * The screen owns only UI lifecycle (idle/syncing/done/error). All writes go
 * through `runWorkoutSync`; conflict acknowledgements only edit the current
 * result in memory. Nothing persists, so the next manual sync plans the same
 * unresolved local/cloud difference again. Each run pins the signed-in account
 * and token, and an account switch or unmount stops later writes and discards
 * any late result.
 */

const copy = {
  kicker: "SYNC",
  title: "Cloud sync",
  lede:
    "Optional and manual. Nothing is uploaded until you start a sync; your device stays the source of truth.",
  statusKicker: "Sync status",
  statusIdle: "Idle",
  statusSyncing: "Syncing…",
  statusDone: "Done",
  statusError: "Error",
  syncNow: "Sync now",
  thisRun: "This run",
  pushed: "Pushed: {count}",
  pulled: "Pulled: {count}",
  identical: "Identical: {count}",
  conflictsCount: "Conflicts: {count}",
  conflictsTitle: "Conflicts",
  conflictsLede:
    "Same workout id, different content. Nothing is overwritten and nothing is deleted.",
  conflictsNote:
    "Your choice is remembered for these exact copies. If either copy changes, the conflict appears again. Both records remain unchanged.",
  conflictsImmutable:
    "Keeping the cloud copy does not delete your device copy. Keeping local leaves it device-only; exporting shares the local copy.",
  deviceCopy: "Device copy: {date} · {type}",
  cloudCopy: "Cloud copy: {date} · {type}",
  keepCloud: "Keep cloud",
  keepLocal: "Keep local only",
  exportLocal: "Export local",
  keepCloudLabel: "Keep cloud for {id}",
  keepLocalLabel: "Keep local only for {id}",
  exportLocalLabel: "Export local for {id}",
  exportTitle: "Export local record",
  exportMessage: "Device-only copy of this workout",
  shareError: "Could not open the share sheet. The conflict is still listed here.",
  noConflicts: "No conflicts. Local and cloud records agree where they overlap.",
  conflictAcknowledged:
    "This unchanged conflict has a saved choice. Both original records remain intact.",
  offline:
    "You appear to be offline. Nothing was uploaded; local workouts stay on this device. Try again when you reconnect.",
  authFailed: "Your session is no longer valid. Sign in again to sync.",
  conflictFailed:
    "The cloud rejected a write because the same id already exists with different content. No cloud record was overwritten.",
  otherFailed:
    "Sync could not finish. Nothing was overwritten; try again when the service is available.",
  unconfigured:
    "Cloud sync is not configured in this build. Set EXPO_PUBLIC_FIT_TRACE_API_URL to the API base URL to enable it.",
  signInRequired: "Sign in to use cloud sync.",
  opening: "Opening the local store…",
  storeUnavailable:
    "The local store could not be opened: {message}",
  back: "Back",
  backLabel: "Go back",
} as const;

type ScreenStatus = "idle" | "syncing" | "done" | "error";

const STATUS_COPY: Record<ScreenStatus, string> = {
  idle: copy.statusIdle,
  syncing: copy.statusSyncing,
  done: copy.statusDone,
  error: copy.statusError,
};

function failedRunMessage(
  result: SyncRunResult | null,
  t: (source: string, params?: Record<string, string | number>) => string,
): string {
  if (result === null) return t(copy.otherFailed);
  if (result.abortReason === "unconfigured") return t(copy.unconfigured);
  switch (result.failure) {
    case "offline":
      return t(copy.offline);
    case "auth":
      return t(copy.authFailed);
    case "conflict":
      return t(copy.conflictFailed);
    default:
      return t(copy.otherFailed);
  }
}

export default function SyncScreen() {
  const router = useRouter();
  const { language, t } = useI18n();
  const { status: authStatus, getAccessToken, user } = useAuth();
  const {
    status: dataStatus,
    repository,
    error: openError,
  } = useWorkoutData();
  const client = useMemo(
    () => new WorkoutSyncClient({ getAccessToken }),
    [getAccessToken],
  );
  const [status, setStatus] = useState<ScreenStatus>("idle");
  const [result, setResult] = useState<SyncRunResult | null>(null);
  const [shareError, setShareError] = useState(false);
  // Acknowledged rows are removed from the result but the records do not agree;
  // this keeps the "no conflicts" claim truthful until the next run resets it.
  const [acknowledged, setAcknowledged] = useState(0);
  const [syncEnabled, setSyncEnabled] = useState<boolean | null>(null);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const syncScope = useMemo(() => {
    const config = client.config;
    return user?.id && config.status === "configured"
      ? { accountId: user.id, endpoint: config.baseUrl }
      : null;
  }, [client.config, user?.id]);

  useEffect(() => {
    let live = true;
    setSyncEnabled(null);
    if (repository === null || syncScope === null) return () => { live = false; };
    void Promise.all([
      repository.isSyncEnabled(syncScope),
      repository.countUnassignedLocalWorkouts(),
      repository.getSyncStatus(syncScope),
    ]).then(([enabled, count, syncStatus]) => {
      if (!live) return;
      setSyncEnabled(enabled);
      setUnassignedCount(count);
      setPendingCount(syncStatus.pendingCount);
      setLastSuccessAt(syncStatus.lastSuccessAt);
    }).catch(() => {
      if (live) setSyncEnabled(false);
    });
    return () => { live = false; };
  }, [repository, syncScope, user?.id]);

  // Every run captures the generation at its start. Account switches and
  // unmounts bump it, so a late result or share-sheet return can never apply to
  // a different identity or a screen that is gone.
  const mountedRef = useRef(true);
  const runGenerationRef = useRef(0);
  // The live identity is read by the runner from the committed render, not from
  // the render that started the run.
  const activeUserIdRef = useRef<string | null>(user?.id ?? null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runGenerationRef.current += 1;
    };
  }, []);

  // A sign-out or account switch invalidates the in-memory result: it belongs
  // to the account that ran the sync, never to whoever is signed in now. A
  // token-only refresh keeps the same account and is caught by the runner's
  // per-write token comparison instead.
  useEffect(() => {
    activeUserIdRef.current = user?.id ?? null;
    runGenerationRef.current += 1;
    setStatus("idle");
    setResult(null);
    setShareError(false);
    setAcknowledged(0);
  }, [authStatus, user?.id]);

  // The runner calls this immediately before each write. After unmount, or once
  // the live identity no longer matches the pinned one, it returns a null
  // identity and the run stops before touching another account.
  const getCurrentAccount = useCallback((): SyncRunAccount => {
    if (!mountedRef.current) return { userId: null, accessToken: null };
    return { userId: activeUserIdRef.current, accessToken: getAccessToken() };
  }, [getAccessToken]);

  const signedIn = authStatus === "signed-in";
  const configured = client.config.status === "configured";
  const busy = status === "syncing";
  const canRun = signedIn && configured && repository !== null && syncEnabled === true && !busy;

  async function enableSync(): Promise<void> {
    if (repository === null || syncScope === null || consentBusy) return;
    const generation = runGenerationRef.current;
    setConsentBusy(true);
    try {
      await repository.enableSync(syncScope, includeExisting);
      if (!mountedRef.current || runGenerationRef.current !== generation) return;
      setSyncEnabled(true);
      setUnassignedCount(await repository.countUnassignedLocalWorkouts());
      const syncStatus = await repository.getSyncStatus(syncScope);
      setPendingCount(syncStatus.pendingCount);
      setLastSuccessAt(syncStatus.lastSuccessAt);
    } catch {
      setSyncEnabled(false);
    } finally {
      setConsentBusy(false);
    }
  }

  async function disableSync(): Promise<void> {
    if (repository === null || syncScope === null || consentBusy) return;
    const generation = runGenerationRef.current;
    setConsentBusy(true);
    try {
      await repository.disableSync(syncScope);
      if (!mountedRef.current || runGenerationRef.current !== generation) return;
      setSyncEnabled(false);
      const syncStatus = await repository.getSyncStatus(syncScope);
      setPendingCount(syncStatus.pendingCount);
      setLastSuccessAt(syncStatus.lastSuccessAt);
      setResult(null);
      setStatus("idle");
    } finally {
      setConsentBusy(false);
    }
  }

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/me");
  };

  async function handleSync(): Promise<void> {
    if (!canRun || repository === null) return;
    const accessToken = getAccessToken();
    const userId = user?.id ?? null;
    if (
      accessToken === null ||
      accessToken.trim() === "" ||
      userId === null ||
      userId.trim() === ""
    ) {
      setResult(abortSyncRun("auth", "unauthenticated"));
      setStatus("error");
      return;
    }

    // Pin the account for the whole run and bind the client to its token, so
    // no request can silently switch to a newer sign-in.
    const account: SyncRunAccount = { userId, accessToken };
    const runClient = client.withAccessToken(accessToken);
    const generation = runGenerationRef.current + 1;
    runGenerationRef.current = generation;
    setStatus("syncing");
    setResult(null);
    setShareError(false);
    setAcknowledged(0);
    try {
      const next = await runWorkoutSync({
        repository,
        client: runClient,
        account,
        getCurrentAccount,
        scope: { accountId: userId, endpoint: client.config.baseUrl },
      });
      if (!mountedRef.current || runGenerationRef.current !== generation) return;
      let visible = next;
      if (next.conflicts.length > 0) {
        const acknowledgements = await repository.listConflictAcknowledgements({
          accountId: userId,
          endpoint: client.config.baseUrl,
        });
        for (const conflict of next.conflicts) {
          const acknowledgement = acknowledgements.find((entry) => entry.workoutId === conflict.id);
          if (
            acknowledgement !== undefined &&
            acknowledgement.localFingerprint === stableStringify(conflict.local) &&
            acknowledgement.remoteFingerprint === stableStringify(conflict.remote)
          ) {
            visible = acknowledgeSyncConflict(visible, conflict.id);
          }
        }
      }
      setAcknowledged(next.conflicts.length - visible.conflicts.length);
      setResult(visible);
      setStatus(visible.status === "done" ? "done" : "error");
      if (visible.status === "done" && visible.conflicts.length === 0) {
        try {
          await repository.recordSuccessfulReconciliation({ accountId: userId, endpoint: client.config.baseUrl });
          if (!mountedRef.current || runGenerationRef.current !== generation) return;
          const syncStatus = await repository.getSyncStatus({ accountId: userId, endpoint: client.config.baseUrl });
          if (!mountedRef.current || runGenerationRef.current !== generation) return;
          setPendingCount(syncStatus.pendingCount);
          setLastSuccessAt(syncStatus.lastSuccessAt);
        } catch {
          // The completed network run remains truthful; status persistence is a separate local write.
        }
      }
    } catch {
      if (!mountedRef.current || runGenerationRef.current !== generation) return;
      // The runner reports expected failures as data; this is a last resort.
      setResult(null);
      setStatus("error");
    }
  }

  async function acknowledge(conflict: SyncConflict, action: SyncConflictAction): Promise<void> {
    if (result === null) return;
    if (repository === null || syncScope === null) return;
    const generation = runGenerationRef.current;
    try {
      await repository.acknowledgeConflict(syncScope, {
        workoutId: conflict.id,
        localFingerprint: stableStringify(conflict.local),
        remoteFingerprint: stableStringify(conflict.remote),
        action,
      });
      await repository.markConflictDeviceOnly(syncScope, conflict.id);
    } catch {
      if (mountedRef.current && runGenerationRef.current === generation) setShareError(true);
      return;
    }
    if (!mountedRef.current || runGenerationRef.current !== generation) return;
    const next = acknowledgeSyncConflict(result, conflict.id);
    if (next === result) return;
    setResult(next);
    setAcknowledged((count) => count + 1);
    try {
      const syncStatus = await repository.getSyncStatus(syncScope);
      setPendingCount(syncStatus.pendingCount);
      if (next.status === "done" && next.conflicts.length === 0) {
        await repository.recordSuccessfulReconciliation(syncScope);
        const updated = await repository.getSyncStatus(syncScope);
        setLastSuccessAt(updated.lastSuccessAt);
      }
    } catch {
      // The saved decision remains valid; status is refreshed on the next visit.
    }
  }

  async function shareConflict(conflict: SyncConflict): Promise<void> {
    const generation = runGenerationRef.current;
    try {
      const shared = await Share.share({
        title: t(copy.exportTitle),
        message: `${t(copy.exportMessage)}\n\n${conflictExportJson(conflict)}`,
      });
      // A dismissed share did not give the user the JSON; keep the row.
      if (shared.action === Share.dismissedAction) return;
      if (!mountedRef.current || runGenerationRef.current !== generation) return;
      setShareError(false);
      await acknowledge(conflict, "export-local");
    } catch {
      if (!mountedRef.current || runGenerationRef.current !== generation) return;
      setShareError(true);
    }
  }

  function handleDecision(conflict: SyncConflict, action: SyncConflictAction): void {
    setShareError(false);
    const decision = decideSyncConflict(action);
    if (decision.uploadsLocal || decision.deletesLocal) return;
    if (decision.sharesLocal) {
      void shareConflict(conflict);
      return;
    }
    void acknowledge(conflict, action);
  }

  const statusTone =
    status === "error" ? "warn" : status === "done" ? "accent" : "muted";

  return (
    <Screen bottomInset testID="screen-sync">
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>

      {!signedIn && authStatus !== "loading" ? (
        <Banner message={t(copy.signInRequired)} testID="sync-sign-in-required" tone="info" />
      ) : null}
      {authStatus === "loading" ? <Body>{t("Restoring your account…")}</Body> : null}
      {!configured ? (
        <Banner message={t(copy.unconfigured)} testID="sync-unconfigured" tone="warn" />
      ) : null}
      {dataStatus === "loading" ? <Body>{t(copy.opening)}</Body> : null}
      {dataStatus === "error" ? (
        <Banner
          message={t(copy.storeUnavailable, {
            message: openError?.message ?? t("Unknown error."),
          })}
          testID="sync-store-error"
          tone="danger"
        />
      ) : null}

      <Card testID="sync-controls">
        <Kicker>{t(copy.statusKicker)}</Kicker>
        <Body
          accessibilityLiveRegion="polite"
          testID="sync-status"
          tone={statusTone}>
          {t(STATUS_COPY[status])}
        </Body>
        <Button
          accessibilityLabel={t(copy.syncNow)}
          disabled={!canRun}
          fullWidth
          label={busy ? t(copy.statusSyncing) : t(copy.syncNow)}
          onPress={() => {
            void handleSync();
          }}
          testID="sync-run"
        />
      </Card>

      {signedIn && configured && repository !== null ? (
        <Card testID="sync-consent">
          <Title>{t("Cloud sync consent")}</Title>
          <Body>{t("Sync is scoped to this account and API endpoint. Pulled workouts are never queued for upload.")}</Body>
          {syncEnabled === true ? (
            <>
              <Body testID="sync-consent-enabled">{t("Cloud sync is enabled for this account on this API endpoint. Uploads run when you start a manual sync.")}</Body>
              <Body testID="sync-pending-count">{t("Pending uploads: {count}", { count: pendingCount })}</Body>
              <Body testID="sync-last-success">{lastSuccessAt === null ? t("No complete sync recorded yet.") : t("Last complete sync: {date}", { date: lastSuccessAt })}</Body>
              <Button label={t("Turn off cloud sync")} onPress={() => { void disableSync(); }} disabled={consentBusy} testID="sync-disable" variant="secondary" />
            </>
          ) : (
            <>
              <Body>{t("{count} existing device records are not yet authorized for upload.", { count: unassignedCount })}</Body>
              <Button
                label={t(includeExisting ? "Existing records: include" : "Existing records: leave on device")}
                onPress={() => setIncludeExisting((current) => !current)}
                testID="sync-existing-choice"
                variant="secondary"
              />
              <Body>{t("This choice applies at opt-in. New local workouts are queued while enabled; records created while disabled stay on this device until you explicitly include existing records.")}</Body>
              <Button label={consentBusy ? t("Saving…") : t("Enable cloud sync")} onPress={() => { void enableSync(); }} disabled={consentBusy || syncEnabled === null} testID="sync-enable" />
            </>
          )}
        </Card>
      ) : null}

      {status === "error" ? (
        <Banner
          message={failedRunMessage(result, t)}
          testID="sync-error"
          tone="danger"
        />
      ) : null}

      {result !== null ? (
        <Card testID="sync-summary">
          <Title>{t(copy.thisRun)}</Title>
          <Body>{t(copy.pushed, { count: result.counts.pushed })}</Body>
          <Body>{t(copy.pulled, { count: result.counts.pulled })}</Body>
          <Body>{t(copy.identical, { count: result.counts.identical })}</Body>
          <Body>{t(copy.conflictsCount, { count: result.counts.conflicts })}</Body>
        </Card>
      ) : null}

      {shareError ? (
        <Banner message={t(copy.shareError)} testID="sync-share-error" tone="warn" />
      ) : null}

      {result !== null && result.conflicts.length > 0 ? (
        <View style={styles.section}>
          <Title>{t(copy.conflictsTitle)}</Title>
          <Body>{t(copy.conflictsLede)}</Body>
          <Body>{t(copy.conflictsNote)}</Body>
          <Body>{t(copy.conflictsImmutable)}</Body>
          {result.conflicts.map((conflict) => {
            const localType = displaySessionType(language, conflict.local.session_type);
            const remoteType = displaySessionType(language, conflict.remote.session_type);
            return (
              <Card key={conflict.id} testID={`sync-conflict-${conflict.id}`}>
                <Title>{conflict.id}</Title>
                <Body tone="default">
                  {t(copy.deviceCopy, { date: conflict.local.date, type: localType })}
                </Body>
                <Body tone="default">
                  {t(copy.cloudCopy, { date: conflict.remote.date, type: remoteType })}
                </Body>
                <Button
                  accessibilityLabel={t(copy.keepCloudLabel, { id: conflict.id })}
                  fullWidth
                  label={t(copy.keepCloud)}
                  onPress={() => handleDecision(conflict, "keep-cloud")}
                  testID={`sync-keep-cloud-${conflict.id}`}
                  variant="secondary"
                />
                <Button
                  accessibilityLabel={t(copy.keepLocalLabel, { id: conflict.id })}
                  fullWidth
                  label={t(copy.keepLocal)}
                  onPress={() => handleDecision(conflict, "keep-local")}
                  testID={`sync-keep-local-${conflict.id}`}
                  variant="secondary"
                />
                <Button
                  accessibilityLabel={t(copy.exportLocalLabel, { id: conflict.id })}
                  fullWidth
                  label={t(copy.exportLocal)}
                  onPress={() => handleDecision(conflict, "export-local")}
                  testID={`sync-export-local-${conflict.id}`}
                  variant="secondary"
                />
              </Card>
            );
          })}
        </View>
      ) : null}

      {result !== null && result.status === "done" && result.conflicts.length === 0 ? (
        <Body>
          {t(acknowledged > 0 ? copy.conflictAcknowledged : copy.noConflicts)}
        </Body>
      ) : null}

      <Button
        accessibilityLabel={t(copy.backLabel)}
        label={t(copy.back)}
        onPress={goBack}
        testID="sync-back"
        variant="secondary"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACING[2] },
});
