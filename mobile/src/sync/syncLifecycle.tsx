import * as BackgroundTask from "expo-background-task";
import * as Network from "expo-network";
import * as TaskManager from "expo-task-manager";
import { useEffect, useMemo, useRef } from "react";
import { AppState, Platform } from "react-native";

import { useAuth } from "@/auth";
import { useWorkoutData } from "@/data/provider";
import { runHeadlessWorkoutSync } from "./syncCoordinator";
import { readSyncConfig } from "./syncClient";
import { shouldRunSyncForTrigger, type SyncTrigger } from "./syncTriggerModel";

export const MOBILE_SYNC_BACKGROUND_TASK = "agent-fit-trace-mobile-sync-v1";

// Expo requires this definition at module scope because background launches do
// not mount React components before dispatching the task.
if (Platform.OS !== "web") {
  TaskManager.defineTask(MOBILE_SYNC_BACKGROUND_TASK, async ({ error }) => {
    if (error !== null) return BackgroundTask.BackgroundTaskResult.Failed;
    try {
      const network = await Network.getNetworkStateAsync();
      if (!shouldRunSyncForTrigger("background", {
        authenticated: true,
        configured: readSyncConfig().status === "configured",
        consented: true,
        networkAvailable: network.isConnected !== false && network.isInternetReachable !== false,
      })) {
        return BackgroundTask.BackgroundTaskResult.Failed;
      }
      const completed = await runHeadlessWorkoutSync();
      return completed ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function refreshBackgroundSyncRegistration(enabled: boolean): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(MOBILE_SYNC_BACKGROUND_TASK);
    if (!enabled) {
      if (registered) await BackgroundTask.unregisterTaskAsync(MOBILE_SYNC_BACKGROUND_TASK);
      return;
    }
    if (registered || (await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    // Android's minimum is 15 minutes; the OS can defer it much longer.
    await BackgroundTask.registerTaskAsync(MOBILE_SYNC_BACKGROUND_TASK, { minimumInterval: 15 });
  } catch {
    // Foreground and reconnect triggers still work if OS scheduling is denied.
  }
}

/** Coordinates opt-in-aware foreground, reconnect and OS background triggers. */
export function SyncLifecycle() {
  const { status: authStatus, user } = useAuth();
  const { repository } = useWorkoutData();
  const syncConfig = useMemo(() => readSyncConfig(), []);
  const accountId = user?.id ?? null;
  const runningRef = useRef(false);

  useEffect(() => {
    let live = true;
    if (authStatus === "loading") return () => { live = false; };
    if (authStatus !== "signed-in" || accountId === null || syncConfig.status !== "configured" || repository === null) {
      void refreshBackgroundSyncRegistration(false);
      return () => { live = false; };
    }
    const scope = { accountId, endpoint: syncConfig.baseUrl };
    void repository.isSyncEnabled(scope).then(async (enabled) => {
      if (!live) return;
      await refreshBackgroundSyncRegistration(enabled);
      if (enabled && AppState.currentState === "active") void runAutomaticTrigger("foreground");
    }).catch(() => {
      void refreshBackgroundSyncRegistration(false);
    });
    return () => { live = false; };
  }, [accountId, authStatus, repository, syncConfig]);

  useEffect(() => {
    const appSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && authStatus === "signed-in" && accountId !== null) void runAutomaticTrigger("foreground");
    });
    const networkSubscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected !== false && state.isInternetReachable !== false && authStatus === "signed-in" && accountId !== null) {
        void runAutomaticTrigger("reconnect", true);
      }
    });
    return () => {
      appSubscription.remove();
      networkSubscription.remove();
    };
  }, [accountId, authStatus, repository, syncConfig]);

  async function runAutomaticTrigger(trigger: Extract<SyncTrigger, "foreground" | "reconnect">, networkAvailable?: boolean): Promise<void> {
    if (authStatus !== "signed-in" || accountId === null || repository === null || runningRef.current) return;
    runningRef.current = true;
    try {
      const consented = await repository.isSyncEnabled({ accountId, endpoint: syncConfig.status === "configured" ? syncConfig.baseUrl : "" });
      if (!shouldRunSyncForTrigger(trigger, {
        authenticated: authStatus === "signed-in",
        configured: syncConfig.status === "configured",
        consented,
        appActive: AppState.currentState === "active",
        networkAvailable,
      })) return;
      await runHeadlessWorkoutSync();
    } catch {
      // Status and retryable outbox transitions are persisted by the runner.
    } finally {
      runningRef.current = false;
    }
  }

  return null;
}
