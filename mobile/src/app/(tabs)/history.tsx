import { summarizeMetrics } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { displaySessionType } from "@pi-fit-trace/i18n/domain";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useWorkoutData } from "@/data/provider";
import type { WorkoutRepository } from "@/data/workoutRepository";
import { useI18n } from "@/i18n";
import { SPACING } from "@/theme";
import {
  Banner,
  Body,
  Button,
  Card,
  Display,
  EmptyState,
  Screen,
  Title,
} from "@/ui";

const copy = {
  kicker: "HISTORY",
  title: "Training history",
  lede: "Every logged session becomes evidence. Review what you lifted, how it felt, and what changed over time.",
  emptyTitle: "No sessions yet",
  emptyMessage:
    "Log your first session and it will appear here.",
  loading: "Loading workout history…",
  loadError: "Could not load workout history: {message}",
  unknownError: "Unknown error.",
  retry: "Retry",
  singleSetSummary: "{sets} set · {reps} reps · {volume} kg",
  multipleSetSummary: "{sets} sets · {reps} reps · {volume} kg",
  rowLabel: "Workout on {date}: {type}. {summary}",
};

interface LoadedWorkouts {
  status: "ready";
  repository: WorkoutRepository;
  workouts: WorkoutRecord[];
}

interface FailedLoad {
  status: "error";
  repository: WorkoutRepository;
  error: Error;
}

type WorkoutLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | LoadedWorkouts
  | FailedLoad;

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const message = typeof cause === "string" && cause.trim() !== "" ? cause : "Unknown error.";
  return new Error(message);
}

function HistoryRow({ record }: { record: WorkoutRecord }) {
  const { language, t } = useI18n();
  const metrics = summarizeMetrics([record]);
  const sessionType = displaySessionType(language, record.session_type);
  const summary = t(
    metrics.total_sets === 1 ? copy.singleSetSummary : copy.multipleSetSummary,
    {
      sets: metrics.total_sets,
      reps: metrics.total_reps,
      volume: metrics.volume_kg,
    },
  );

  return (
    <Card
      accessible
      accessibilityLabel={t(copy.rowLabel, {
        date: record.date,
        type: sessionType,
        summary,
      })}
      testID={`history-row-${record.id}`}>
      <View style={styles.rowHead}>
        <Title style={styles.date}>{record.date}</Title>
        <Body style={styles.sessionType} tone="accent">
          {sessionType}
        </Body>
      </View>
      <Body>{summary}</Body>
    </Card>
  );
}

export default function HistoryScreen() {
  const { t } = useI18n();
  const {
    status: dataStatus,
    repository,
    error: openError,
    reload,
  } = useWorkoutData();
  const [loadState, setLoadState] = useState<WorkoutLoadState>({ status: "idle" });
  const requestRef = useRef(0);
  // The repository currently being read. A second focus while the same read is
  // in flight is ignored; a new repository (after `reload`) starts a new read.
  const loadingRepositoryRef = useRef<WorkoutRepository | null>(null);

  const loadWorkouts = useCallback(async () => {
    if (repository === null) return;
    if (loadingRepositoryRef.current === repository) return;

    const request = requestRef.current + 1;
    requestRef.current = request;
    loadingRepositoryRef.current = repository;
    setLoadState({ status: "loading" });

    try {
      const workouts = await repository.listWorkouts();
      if (request !== requestRef.current) return;
      setLoadState({ status: "ready", repository, workouts });
    } catch (cause) {
      if (request !== requestRef.current) return;
      setLoadState({ status: "error", repository, error: toError(cause) });
    } finally {
      if (request === requestRef.current) loadingRepositoryRef.current = null;
    }
  }, [repository]);

  // Refreshing on focus is what makes a save from the Log tab visible here.
  useFocusEffect(
    useCallback(() => {
      void loadWorkouts();
    }, [loadWorkouts]),
  );

  const handleRetry = useCallback(() => {
    if (dataStatus === "error") {
      reload();
      return;
    }
    void loadWorkouts();
  }, [dataStatus, loadWorkouts, reload]);

  const loadingContent = (
    <Body accessibilityLiveRegion="polite" testID="history-loading">
      {t(copy.loading)}
    </Body>
  );

  let content: ReactNode = loadingContent;

  if (dataStatus === "error") {
    content = (
      <>
        <Banner
          message={t(copy.loadError, {
            message: openError?.message || t(copy.unknownError),
          })}
          testID="history-error"
          tone="danger"
        />
        <Button label={t(copy.retry)} onPress={handleRetry} testID="history-retry" />
      </>
    );
  } else if (
    dataStatus === "ready" &&
    loadState.status === "error" &&
    loadState.repository === repository
  ) {
    content = (
      <>
        <Banner
          message={t(copy.loadError, {
            message: loadState.error.message || t(copy.unknownError),
          })}
          testID="history-error"
          tone="danger"
        />
        <Button label={t(copy.retry)} onPress={handleRetry} testID="history-retry" />
      </>
    );
  } else if (
    dataStatus === "ready" &&
    loadState.status === "ready" &&
    loadState.repository === repository
  ) {
    content =
      loadState.workouts.length === 0 ? (
        <EmptyState
          message={t(copy.emptyMessage)}
          testID="empty-history"
          title={t(copy.emptyTitle)}
        />
      ) : (
        loadState.workouts.map((record) => <HistoryRow key={record.id} record={record} />)
      );
  }

  return (
    <Screen testID="screen-history">
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      {content}
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: SPACING[2],
  },
  date: { flexShrink: 1 },
  sessionType: { fontWeight: "700" },
});
