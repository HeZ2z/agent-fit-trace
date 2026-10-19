import { displayTrend } from "@pi-fit-trace/i18n/domain";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import {
  buildAnalysisSummary,
  buildFlagViews,
  formatNumber,
  formatVolumeKg,
  type AnalysisSummary,
} from "@/data/analysisModel";
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
  Kicker,
  Screen,
  Title,
  type TextTone,
} from "@/ui";

const copy = {
  kicker: "ANALYSIS",
  title: "Evidence analysis",
  lede: "Turn logged sessions into trends, stalls, and the evidence behind the next step.",
  loading: "Loading analysis…",
  loadError: "Could not load workout history: {message}",
  unknownError: "Unknown error.",
  retry: "Retry",
  emptyTitle: "No evidence to analyse",
  emptyMessage:
    "Your local history is empty. Log a session first, then come back to turn it into evidence.",
  summaryKicker: "Analysis summary",
  sessions: "Sessions: {count}",
  volume: "Volume: {volume} kg",
  activeWeeks: "Active weeks: {count}",
  timeSpan: "Time span: {days} days",
  currentTrend: "Current trend",
  noTrend: "No exercise trends yet.",
  flags: "Flags",
  noFlags: "No safety flags.",
  computed: "Computed from {count} record(s).",
};

interface LoadedAnalysis {
  status: "ready";
  repository: WorkoutRepository;
  summary: AnalysisSummary;
}

interface FailedAnalysis {
  status: "error";
  repository: WorkoutRepository;
  error: Error;
}

type AnalysisLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | LoadedAnalysis
  | FailedAnalysis;

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const message = typeof cause === "string" && cause.trim() !== "" ? cause : "Unknown error.";
  return new Error(message);
}

function severityTone(severity: string): TextTone {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warn";
  // Informational and future severities stay neutral rather than reading as an alarm.
  return "default";
}

/** Deterministic evidence block: metrics, the strongest trend, then flags. */
function AnalysisReport({ summary }: { summary: AnalysisSummary }) {
  const { language, t } = useI18n();
  const flagViews = buildFlagViews(language, summary.flags);

  return (
    <>
      <Card testID="analysis-summary">
        <Kicker>{t(copy.summaryKicker)}</Kicker>
        <View style={styles.metrics}>
          <Body style={styles.metric} tone="default">
            {t(copy.sessions, { count: formatNumber(summary.metrics.sessions) })}
          </Body>
          <Body style={styles.metric} tone="default">
            {t(copy.volume, { volume: formatVolumeKg(summary.metrics.volume_kg) })}
          </Body>
          <Body style={styles.metric} tone="default">
            {t(copy.activeWeeks, { count: formatNumber(summary.span.activeWeeks) })}
          </Body>
          <Body style={styles.metric} tone="default">
            {t(copy.timeSpan, { days: formatNumber(summary.span.days) })}
          </Body>
        </View>
        <View style={styles.trend}>
          <Title>{t(copy.currentTrend)}</Title>
          <Body tone="default">
            {summary.trend === null
              ? t(copy.noTrend)
              : displayTrend(language, summary.trend)}
          </Body>
        </View>
        <Body>{t(copy.computed, { count: formatNumber(summary.sourceCount) })}</Body>
      </Card>

      <View style={styles.flags}>
        <Title>{t(copy.flags)}</Title>
        {flagViews.length === 0 ? (
          <Body>{t(copy.noFlags)}</Body>
        ) : (
          flagViews.map((flag) => (
            <Card key={flag.code} testID={`analysis-flag-${flag.code}`}>
              <Kicker tone={severityTone(flag.severity)}>{flag.severityLabel}</Kicker>
              <Body tone="default">{flag.message}</Body>
            </Card>
          ))
        )}
      </View>
    </>
  );
}

export default function AnalysisScreen() {
  const { t } = useI18n();
  const {
    status: dataStatus,
    repository,
    error: openError,
    reload,
  } = useWorkoutData();
  const [loadState, setLoadState] = useState<AnalysisLoadState>({ status: "idle" });
  const requestRef = useRef(0);
  // The repository currently being read. A second focus while the same read is
  // in flight is ignored; a new repository (after `reload`) starts a new read.
  const loadingRepositoryRef = useRef<WorkoutRepository | null>(null);

  const loadAnalysis = useCallback(async () => {
    if (repository === null) return;
    if (loadingRepositoryRef.current === repository) return;

    const request = requestRef.current + 1;
    requestRef.current = request;
    loadingRepositoryRef.current = repository;
    setLoadState({ status: "loading" });

    try {
      const workouts = await repository.listWorkouts();
      if (request !== requestRef.current) return;
      setLoadState({
        status: "ready",
        repository,
        summary: buildAnalysisSummary(workouts),
      });
    } catch (cause) {
      if (request !== requestRef.current) return;
      setLoadState({ status: "error", repository, error: toError(cause) });
    } finally {
      if (request === requestRef.current) loadingRepositoryRef.current = null;
    }
  }, [repository]);

  // Recomputing on focus is what makes a session saved from Log visible here.
  useFocusEffect(
    useCallback(() => {
      void loadAnalysis();
    }, [loadAnalysis]),
  );

  const handleRetry = useCallback(() => {
    if (dataStatus === "error") {
      reload();
      return;
    }
    void loadAnalysis();
  }, [dataStatus, loadAnalysis, reload]);

  const loadingContent = (
    <Body accessibilityLiveRegion="polite" testID="analysis-loading">
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
          testID="analysis-error"
          tone="danger"
        />
        <Button label={t(copy.retry)} onPress={handleRetry} testID="analysis-retry" />
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
          testID="analysis-error"
          tone="danger"
        />
        <Button label={t(copy.retry)} onPress={handleRetry} testID="analysis-retry" />
      </>
    );
  } else if (
    dataStatus === "ready" &&
    loadState.status === "ready" &&
    loadState.repository === repository
  ) {
    content = loadState.summary.isEmpty ? (
      <EmptyState
        message={t(copy.emptyMessage)}
        testID="empty-analysis"
        title={t(copy.emptyTitle)}
      />
    ) : (
      <AnalysisReport summary={loadState.summary} />
    );
  }

  return (
    <Screen testID="screen-analysis">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      {content}
    </Screen>
  );
}

const styles = StyleSheet.create({
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: SPACING[4],
    rowGap: SPACING[2],
  },
  metric: { flexBasis: "42%", flexGrow: 1 },
  trend: { gap: SPACING[1] },
  flags: { gap: SPACING[2] },
});
