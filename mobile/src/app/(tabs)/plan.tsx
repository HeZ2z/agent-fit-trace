import type { WorkoutRecord } from "@agent-fit-trace/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { buildPlanModel, type PlanModel } from "@/data/planModel";
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
} from "@/ui";

const copy = {
  kicker: "PLAN",
  title: "Draft plans",
  loading: "Loading your draft plan…",
  loadError: "Could not load your workout history for the plan: {message}",
  unknownError: "Unknown error.",
  retry: "Retry",
  emptyTitle: "No sessions to draft from",
  emptyMessage:
    "Log a session first, then come back to see a draft plan built from your local history.",
  draftTitle: "Draft only",
  draftMessage:
    "This plan was generated on your device and is not saved or applied. Nothing changes in your workout log until you explicitly confirm a plan; adoption, saved snapshots, and accounts arrive in a later update.",
  summaryKicker: "Draft summary",
  sessions: "Sessions used: {count}",
  period: "Period: {from} – {to}",
  notAvailable: "n/a",
  confidenceLow: "Confidence: low (short history)",
  confidenceStandard: "Confidence: standard",
  recommendations: "Recommendations",
  noRecommendations: "No recommendations.",
  reason: "Reason: {reason}",
  safetyNotes: "Safety notes",
  noSafetyNotes: "No additional safety notes.",
  careTitle: "Professional care",
};

interface LoadedPlan {
  status: "ready";
  repository: WorkoutRepository;
  workouts: WorkoutRecord[];
}

interface FailedPlan {
  status: "error";
  repository: WorkoutRepository;
  error: Error;
}

type PlanLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | LoadedPlan
  | FailedPlan;

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const message = typeof cause === "string" && cause.trim() !== "" ? cause : "Unknown error.";
  return new Error(message);
}

/** Deterministic draft view: summary, recommendations, then safety copy. */
function PlanReport({ model }: { model: PlanModel }) {
  const { t } = useI18n();

  return (
    <>
      <Banner
        message={t(copy.draftMessage)}
        testID="plan-draft"
        title={t(copy.draftTitle)}
        tone="info"
      />

      {model.carePrompt !== null && (
        <Banner
          message={model.carePrompt}
          testID="plan-care-prompt"
          title={t(copy.careTitle)}
          tone="warn"
        />
      )}

      <Card testID="plan-summary">
        <Kicker>{t(copy.summaryKicker)}</Kicker>
        <View style={styles.metrics}>
          <Body style={styles.metric} tone="default">
            {t(copy.sessions, { count: model.summary.sessions })}
          </Body>
          <Body style={styles.metric} tone="default">
            {t(copy.period, {
              from: model.summary.from ?? t(copy.notAvailable),
              to: model.summary.to ?? t(copy.notAvailable),
            })}
          </Body>
        </View>
        <Body>
          {t(
            model.summary.confidence === "low"
              ? copy.confidenceLow
              : copy.confidenceStandard,
          )}
        </Body>
      </Card>

      <View style={styles.section}>
        <Title>{t(copy.recommendations)}</Title>
        {model.recommendations.length === 0 ? (
          <Body>{t(copy.noRecommendations)}</Body>
        ) : (
          model.recommendations.map((recommendation) => (
            <Card
              key={recommendation.code}
              testID={`plan-recommendation-${recommendation.code}`}>
              <Title>{recommendation.action}</Title>
              <Body tone="default">{recommendation.detail}</Body>
              <Body>{t(copy.reason, { reason: recommendation.reason })}</Body>
            </Card>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Title>{t(copy.safetyNotes)}</Title>
        {model.safetyNotes.length === 0 ? (
          <Body>{t(copy.noSafetyNotes)}</Body>
        ) : (
          model.safetyNotes.map((note, index) => (
            <Body key={`${index}-${note}`} testID="plan-safety-note" tone="warn">
              {note}
            </Body>
          ))
        )}
      </View>

    </>
  );
}

export default function PlanScreen() {
  const { language, t } = useI18n();
  const {
    status: dataStatus,
    repository,
    error: openError,
    reload,
  } = useWorkoutData();
  const [loadState, setLoadState] = useState<PlanLoadState>({ status: "idle" });
  const requestRef = useRef(0);
  // The repository currently being read. A second focus while the same read is
  // in flight is ignored; a new repository (after `reload`) starts a new read.
  const loadingRepositoryRef = useRef<WorkoutRepository | null>(null);

  const loadPlan = useCallback(async () => {
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

  // Re-drafting on focus is what makes a session saved from Log visible here.
  useFocusEffect(
    useCallback(() => {
      void loadPlan();
    }, [loadPlan]),
  );

  // Build the pure model only for the repository whose read finished. Model
  // strings are rebuilt when the interface language changes.
  const model = useMemo<PlanModel | null>(() => {
    if (dataStatus !== "ready" || repository === null) return null;
    if (loadState.status !== "ready" || loadState.repository !== repository) return null;
    return buildPlanModel(loadState.workouts, language);
  }, [dataStatus, language, loadState, repository]);

  const handleRetry = useCallback(() => {
    if (dataStatus === "error") {
      reload();
      return;
    }
    void loadPlan();
  }, [dataStatus, loadPlan, reload]);

  const loadingContent = (
    <Body accessibilityLiveRegion="polite" testID="plan-loading">
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
          testID="plan-error"
          tone="danger"
        />
        <Button label={t(copy.retry)} onPress={handleRetry} testID="plan-retry" />
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
          testID="plan-error"
          tone="danger"
        />
        <Button label={t(copy.retry)} onPress={handleRetry} testID="plan-retry" />
      </>
    );
  } else if (model !== null) {
    content = model.isEmpty ? (
      <EmptyState
        message={t(copy.emptyMessage)}
        testID="empty-plan"
        title={t(copy.emptyTitle)}
      />
    ) : (
      <PlanReport model={model} />
    );
  }

  return (
    <Screen testID="screen-plan">
      <Display>{t(copy.title)}</Display>
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
  section: { gap: SPACING[2] },
});
