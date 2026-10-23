import { SESSION_TYPES, stableStringify } from "@agent-fit-trace/core";
import type { ValidationIssue, ValidationWarning, WorkoutRecord } from "@agent-fit-trace/core";
import { displaySessionType, displayValidationMessage } from "@agent-fit-trace/i18n/domain";
import {
  buildWorkoutRecord,
  createSessionDraft,
  createSessionRuntime,
  elapsedMs,
  reduceSessionState,
  restRemainingMs,
  sessionPhase,
  toSaveInput,
  todayLocalDate,
  validateSessionDraft,
} from "@agent-fit-trace/workout-session";
import type {
  SessionAction,
  SessionDraft,
  SessionState,
} from "@agent-fit-trace/workout-session";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useWorkoutData } from "@/data/provider";
import { useI18n } from "@/i18n";
import { SPACING } from "@/theme";
import { useSkin } from "@/theme/skin";
import {
  Banner,
  Kicker,
  Body,
  Button,
  Card,
  Chip,
  Display,
  ExerciseNameField,
  Field,
  Screen,
  Title,
} from "@/ui";
import { useRestCue, vibrateRestEnded, vibrateSetChecked } from "@/workout/liveFeedback";

/**
 * Log screen: the unified session editor shared with the web.
 *
 * One `SessionState` (persisted draft + transient rest runtime) is reduced by
 * the shared pure reducer; this screen only injects clocks and renders. The
 * same draft covers after-the-fact entry (`timing === null`, manual duration) and
 * a live session (start/pause/resume/finish, per-set checkboxes, rest countdown).
 *
 * Save policy is unchanged: the draft is built and validated with the shared
 * core bridge before any write, suspicious-but-valid input requires an explicit
 * "Save anyway", and the local SQLite repository derives the content id. Success
 * keeps the banner on this screen; History refreshes on focus when the user
 * switches tabs. A failed save retains the form for retry.
 *
 * Draft persistence, the plate calculator and account-owner wiring are later
 * stages; nothing here writes the draft.
 */
const copy = {
  title: "Log a session",
  lede: "Capture sets, reps, load, and how the session felt while it is still fresh.",
  date: "Date",
  dateHint: "Date format: YYYY-MM-DD",
  sessionType: "Session type",
  exercises: "Exercises",
  exercise: "Exercise {index}",
  exerciseName: "Exercise {index} name",
  restSeconds: "Rest (seconds)",
  set: "Set {set}",
  setComplete: "Set {set} complete",
  reps: "Reps",
  weight: "Weight (kg)",
  weightHint: "Optional",
  rpe: "RPE",
  rpeHint: "1–10, optional",
  addSet: "Add set",
  removeSet: "Remove set",
  addExercise: "Add exercise",
  removeExercise: "Remove exercise",
  duration: "Duration (minutes)",
  sleep: "Sleep (hours)",
  notes: "Notes (optional)",
  pain: "Pain (optional)",
  painArea: "Pain {index} area",
  painLevel: "Pain {index} level",
  addPain: "Add pain",
  removePain: "Remove pain",
  save: "Save workout",
  saving: "Saving…",
  saveAnyway: "Save anyway",
  warnings: "Warnings",
  warningInvalidated: "Form changed since the warning was shown. Submit again to re-validate.",
  successTitle: "Saved",
  successCreated: "Workout saved. It will appear in History.",
  successDuplicate: "This workout was already saved; no duplicate was written.",
  saveError: "Could not save this workout: {message}",
  retry: "Retry",
  unknownError: "Unknown error.",
  openingStore: "Opening the local store…",
  storeError: "The local store could not be opened: {message}",
  storeNotReady: "The local store is not ready yet. Try again in a moment.",
  validationIssue: "{count} validation issue — please fix before saving.",
  validationIssues: "{count} validation issues — please fix before saving.",
  sessionTimer: "Session timer",
  startSession: "Start session",
  pauseSession: "Pause session",
  resumeSession: "Resume session",
  finishSession: "Finish session",
  elapsed: "Elapsed",
  paused: "Paused",
  finished: "Finished",
  rest: "Rest",
  restComplete: "Rest complete",
  skipRest: "Skip rest",
  subtract15: "Subtract 15 seconds",
  add15: "Add 15 seconds",
} as const;

type SaveSuccess = "created" | "duplicate";

/**
 * A record captured for the warning confirmation, plus the clock and draft it
 * was built from. Staleness compares like with like by rebuilding the draft at
 * the same instant.
 */
interface PendingSave {
  record: WorkoutRecord;
  nowMs: number;
  draft: SessionDraft;
}

/** Rest steps the -15s/+15s buttons move the shared timer by. */
const REST_ADJUST_MS = 15_000;

/** Ticker cadence for the elapsed display and rest settlement. */
const LIVE_TICK_MS = 250;

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "";
}

/**
 * Format a live duration as `MM:SS`, adding an `H:` segment after an hour.
 *
 * Elapsed and rest values are derived from injected epoch milliseconds, so this
 * stays a pure presentation helper and never reads a clock itself.
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** A brand-new untimed draft; also the state a successful save resets to. */
function blankSessionState(): SessionState {
  return { draft: createSessionDraft(todayLocalDate()), runtime: createSessionRuntime() };
}

export default function LogScreen() {
  const { language, t } = useI18n();
  const { tokens } = useSkin();
  const { palette } = tokens;
  const { status: dataStatus, repository, error: openError, reload } = useWorkoutData();
  const playRestCue = useRestCue();

  const [state, setState] = useState<SessionState>(blankSessionState);
  const { draft, runtime } = state;

  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SaveSuccess | null>(null);

  const dispatch = useCallback((action: SessionAction): void => {
    setState((current) => reduceSessionState(current, action));
  }, []);

  // Draft edits invalidate any validation, warning or success feedback from a
  // previous submit, so a save can never act on content the form no longer has.
  const clearFeedback = useCallback((): void => {
    setIssues([]);
    setWarnings([]);
    setPendingSave(null);
    setSaveError(null);
    setSuccess(null);
  }, []);

  const edit = useCallback(
    (action: SessionAction): void => {
      clearFeedback();
      dispatch(action);
    },
    [clearFeedback, dispatch],
  );

  // Live clock. The shared model never reads a clock: this screen injects the
  // current time into every timing/rest action, and keeps one render-local
  // `nowMs` so the elapsed display and rest countdown re-render on the ticker.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const phase = sessionPhase(state, nowMs);
  const timed = draft.timing !== null;
  const paused = phase === "paused";
  const finished = phase === "finished";
  // Only a started, not paused/finished session needs a ticker.
  const timerRunning = timed && !paused && !finished;
  const elapsed = elapsedMs(draft, nowMs);
  const rest = runtime.rest;
  const restRemaining = rest === null ? null : restRemainingMs(rest, nowMs);

  // The cue fires on the null -> number transition of `restEndedAtMs`, so a
  // settled rest is announced exactly once. Starting a new rest clears the cue
  // back to null, which re-arms the ref for the next announcement.
  const cuedRestEndRef = useRef<number | null>(null);
  useEffect(() => {
    if (runtime.restEndedAtMs === null) {
      cuedRestEndRef.current = null;
      return;
    }
    if (cuedRestEndRef.current === runtime.restEndedAtMs) return;
    cuedRestEndRef.current = runtime.restEndedAtMs;
    playRestCue();
    vibrateRestEnded();
  }, [runtime.restEndedAtMs, playRestCue]);

  // 250ms ticker while the session runs: updates the elapsed display and settles
  // an elapsed rest (which emits the one-shot cue). Cleared as soon as the
  // session pauses or finishes.
  useEffect(() => {
    if (!timerRunning) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      dispatch({ type: "tick", nowMs: now });
    }, LIVE_TICK_MS);
    return () => clearInterval(interval);
  }, [timerRunning, dispatch]);

  // Returning from the background after the interval was suspended: catch the
  // clock up immediately and settle a rest that elapsed while away, so the cue
  // fires once without waiting for the next tick.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      const now = Date.now();
      setNowMs(now);
      dispatch({ type: "tick", nowMs: now });
    });
    return () => subscription.remove();
  }, [dispatch]);

  const translateError = useCallback(
    (cause: unknown): string => {
      const message = describeError(cause).trim();
      return displayValidationMessage(
        language,
        message === "" ? t(copy.unknownError) : message,
      );
    },
    [language, t],
  );

  // The captured record is only valid while the form still builds the same
  // content at the same instant. Deriving staleness means no edit handler can
  // forget to invalidate a pending confirmation.
  const pendingIsStale =
    pendingSave !== null &&
    stableStringify(buildWorkoutRecord(draft, pendingSave.nowMs)) !==
      stableStringify(pendingSave.record);

  async function persist(record: WorkoutRecord, submittedDraft: SessionDraft): Promise<void> {
    if (repository === null) {
      setSaveError(t(copy.storeNotReady));
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const result = await repository.saveWorkout(toSaveInput(record));
      setSuccess(result.created ? "created" : "duplicate");
      // Reset the editor to an empty shared draft after a successful save, but
      // keep edits the user made while the write was in flight.
      setState((current) =>
        current.draft === submittedDraft ? blankSessionState() : current,
      );
      setIssues([]);
      setWarnings([]);
      setPendingSave(null);
    } catch (cause) {
      setSaveError(translateError(cause));
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(): void {
    if (saving || repository === null) return;

    setIssues([]);
    setWarnings([]);
    setPendingSave(null);
    setSaveError(null);
    setSuccess(null);

    const nowMs = Date.now();
    // Build before validation: the repository derives the content id from the
    // submitted content, matching the web editor's pre-normalization build.
    const candidate = buildWorkoutRecord(draft, nowMs);
    const validated = validateSessionDraft(draft, nowMs);

    if (!validated.ok) {
      setIssues(validated.issues);
      return;
    }

    if (validated.warnings.length > 0) {
      setWarnings(validated.warnings);
      setPendingSave({ record: candidate, nowMs, draft });
      return;
    }

    void persist(candidate, draft);
  }

  function handleConfirmSave(): void {
    if (saving) return;
    if (pendingSave === null || pendingIsStale) {
      setPendingSave(null);
      setWarnings([]);
      return;
    }
    const pending = pendingSave;
    setPendingSave(null);
    void persist(pending.record, pending.draft);
  }

  function handleRetrySave(): void {
    if (saving) return;
    if (pendingSave !== null && !pendingIsStale) {
      const pending = pendingSave;
      setPendingSave(null);
      void persist(pending.record, pending.draft);
      return;
    }
    handleSubmit();
  }

  /** Dispatch a timing transition with a fresh injected clock. */
  function dispatchTimed(
    action:
      | { type: "startSession" }
      | { type: "pauseSession" }
      | { type: "resumeSession" }
      | { type: "finishSession" },
  ): void {
    // Starting/pausing/resuming/finishing changes the persisted draft timing,
    // so a pending warning confirmation must not survive it.
    clearFeedback();
    const now = Date.now();
    setNowMs(now);
    dispatch({ ...action, nowMs: now });
  }

  function handleToggleSetDone(exerciseKey: number, setKey: number, done: boolean): void {
    const now = Date.now();
    setNowMs(now);
    // Checking a set is the completion moment; unchecking is a correction.
    if (!done) vibrateSetChecked();
    edit({ type: "toggleSetDone", exerciseKey, setKey, nowMs: now });
  }

  function handleAdjustRest(deltaMs: number): void {
    setNowMs(Date.now());
    dispatch({ type: "adjustRest", deltaMs });
  }

  function handleSkipRest(): void {
    setNowMs(Date.now());
    dispatch({ type: "skipRest" });
  }

  /**
   * Whole seconds of rest between sets; blank means zero (no rest). A
   * transiently unparsable value never reaches the reducer as `NaN`.
   */
  function handleRestSecondsChange(exerciseKey: number, raw: string): void {
    const restSeconds = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(restSeconds)) return;
    edit({ type: "setExerciseRestSeconds", exerciseKey, restSeconds });
  }

  // Duplicate validation-message text is collapsed so a blank set count does
  // not repeat the same sentence once per field.
  const issueLines = [
    ...new Set(issues.map((issue) => displayValidationMessage(language, issue.message))),
  ];
  const warningLines = [
    ...new Set(warnings.map((warning) => displayValidationMessage(language, warning.message))),
  ];

  // A stale pending confirmation can still be submitted: handleSubmit clears it
  // and revalidates the current draft, so the primary Save button must not lock.
  const canSave =
    repository !== null && !saving && (pendingSave === null || pendingIsStale);
  const storeLoading = dataStatus === "loading";
  const storeFailed = dataStatus === "error";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.flex}>
      <Screen contentContainerStyle={styles.content} testID="screen-log">
        <Display>{t(copy.title)}</Display>
        <Body>{t(copy.lede)}</Body>

        {storeLoading ? (
          <Banner message={t(copy.openingStore)} testID="log-store-loading" />
        ) : null}

        {storeFailed ? (
          <>
            <Banner
              message={t(copy.storeError, {
                message: openError?.message || t(copy.unknownError),
              })}
              testID="log-store-error"
              tone="danger"
            />
            <Button label={t(copy.retry)} onPress={reload} testID="log-store-retry" />
          </>
        ) : null}

        <Card testID="log-timer">
          <Kicker tone="default">{t(copy.sessionTimer)}</Kicker>

          {!timed ? (
            <Button
              label={t(copy.startSession)}
              onPress={() => dispatchTimed({ type: "startSession" })}
              testID="log-start-session"
            />
          ) : (
            <>
              <Body testID="log-elapsed" tone="default">
                {t(copy.elapsed)}: {formatElapsed(elapsed ?? 0)}
              </Body>
              {paused ? <Body testID="log-phase">{t(copy.paused)}</Body> : null}
              {finished ? <Body testID="log-phase">{t(copy.finished)}</Body> : null}
              <View style={styles.row}>
                <Button
                  disabled={finished}
                  label={paused ? t(copy.resumeSession) : t(copy.pauseSession)}
                  onPress={() =>
                    dispatchTimed({ type: paused ? "resumeSession" : "pauseSession" })
                  }
                  testID="log-pause-resume"
                />
                <Button
                  disabled={finished}
                  label={t(copy.finishSession)}
                  onPress={() => dispatchTimed({ type: "finishSession" })}
                  testID="log-finish-session"
                  variant="secondary"
                />
              </View>
            </>
          )}

          {rest !== null && restRemaining !== null ? (
            <View style={styles.restBlock} testID="log-rest-bar">
              <Body testID="log-rest-remaining" tone="default">
                {t(copy.rest)}: {formatElapsed(restRemaining)}
              </Body>
              <View style={styles.row}>
                <Button
                  accessibilityLabel={t(copy.subtract15)}
                  label="−15s"
                  onPress={() => handleAdjustRest(-REST_ADJUST_MS)}
                  testID="log-rest-minus"
                  variant="secondary"
                />
                <Button
                  accessibilityLabel={t(copy.add15)}
                  label="+15s"
                  onPress={() => handleAdjustRest(REST_ADJUST_MS)}
                  testID="log-rest-plus"
                  variant="secondary"
                />
                <Button
                  label={t(copy.skipRest)}
                  onPress={handleSkipRest}
                  testID="log-rest-skip"
                  variant="secondary"
                />
              </View>
            </View>
          ) : null}

          {/* The settled-rest status mirrors the cue: it appears when the model
              records the transition and disappears when a new rest starts or
              the session finishes. */}
          {rest === null && runtime.restEndedAtMs !== null && !finished ? (
            <Banner message={t(copy.restComplete)} testID="log-rest-complete" />
          ) : null}
        </Card>

        <Field
          autoCapitalize="none"
          autoCorrect={false}
          hint={t(copy.dateHint)}
          label={t(copy.date)}
          onChangeText={(value) => edit({ type: "setDate", date: value })}
          testID="log-date"
          value={draft.date}
        />

        <View style={styles.section}>
          <Kicker tone="default">{t(copy.sessionType)}</Kicker>
          <View style={styles.chips}>
            {SESSION_TYPES.map((type) => (
              <Chip
                key={type}
                label={displaySessionType(language, type)}
                onPress={() => edit({ type: "setSessionType", sessionType: type })}
                selected={draft.sessionType === type}
                testID={`log-session-${type}`}
              />
            ))}
          </View>
        </View>

        <Title>{t(copy.exercises)}</Title>

        {draft.exercises.map((exercise, exerciseIndex) => {
          const exerciseLabel = t(copy.exercise, { index: exerciseIndex + 1 });

          return (
            <Card key={exercise.key} testID={`log-exercise-${exerciseIndex}`}>
              <View style={styles.exerciseHead}>
                <Title>{exerciseLabel}</Title>
                {draft.exercises.length > 1 ? (
                  <Button
                    accessibilityLabel={`${exerciseLabel}: ${t(copy.removeExercise)}`}
                    label={t(copy.removeExercise)}
                    onPress={() =>
                      edit({ type: "removeExercise", exerciseKey: exercise.key })
                    }
                    testID={`log-remove-exercise-${exerciseIndex}`}
                    variant="secondary"
                  />
                ) : null}
              </View>

              <ExerciseNameField
                label={t(copy.exerciseName, { index: exerciseIndex + 1 })}
                onChangeText={(value) =>
                  edit({ type: "setExerciseName", exerciseKey: exercise.key, name: value })
                }
                suggestionsLabel={t(copy.exercises)}
                testID={`log-exercise-${exerciseIndex}-name`}
                value={exercise.name}
              />

              {/* Rest is session configuration, not workout content: it is only
                  offered once the clock is running. */}
              {timed ? (
                <Field
                  accessibilityLabel={`${exerciseLabel}: ${t(copy.restSeconds)}`}
                  editable={!finished}
                  keyboardType="number-pad"
                  label={t(copy.restSeconds)}
                  onChangeText={(value) => handleRestSecondsChange(exercise.key, value)}
                  testID={`log-exercise-${exerciseIndex}-rest`}
                  value={String(exercise.restSeconds)}
                />
              ) : null}

              {exercise.sets.map((set, setIndex) => {
                const setLabel = t(copy.set, { set: setIndex + 1 });
                const setCompleteLabel = t(copy.setComplete, { set: setIndex + 1 });

                return (
                  <View
                    key={set.key}
                    style={styles.setBlock}
                    testID={`log-set-${exerciseIndex}-${setIndex}`}>
                    <View style={styles.setHead}>
                      <Body style={styles.setLabel} tone="default">
                        {setLabel}
                      </Body>
                      {exercise.sets.length > 1 ? (
                        <Button
                          accessibilityLabel={`${setLabel}: ${t(copy.removeSet)}`}
                          label={t(copy.removeSet)}
                          onPress={() =>
                            edit({
                              type: "removeSet",
                              exerciseKey: exercise.key,
                              setKey: set.key,
                            })
                          }
                          testID={`log-remove-set-${exerciseIndex}-${setIndex}`}
                          variant="secondary"
                        />
                      ) : null}
                    </View>

                    {/* The check-off only exists for a timed session: on an
                        untimed draft the `done` marker is meaningless at save
                        time, and an inert checkbox would be misleading. */}
                    {timed ? (
                      <Pressable
                        accessibilityLabel={`${exerciseLabel}: ${setCompleteLabel}`}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: set.done, disabled: finished }}
                        disabled={finished}
                        onPress={() =>
                          handleToggleSetDone(exercise.key, set.key, set.done)
                        }
                        style={[styles.checkRow, finished ? styles.disabled : null]}
                        testID={`log-set-${exerciseIndex}-${setIndex}-done`}>
                        <View
                          style={[
                            styles.checkbox,
                            {
                              backgroundColor: set.done ? palette.accent : "transparent",
                              borderColor: set.done ? palette.accent : palette.fg,
                              borderRadius: tokens.radiusControl,
                            },
                          ]}>
                          {set.done ? (
                            <Text style={[styles.checkmark, { color: palette.background }]}>
                              ✓
                            </Text>
                          ) : null}
                        </View>
                        <Body tone="default">{setCompleteLabel}</Body>
                      </Pressable>
                    ) : null}

                    <View style={styles.setFields}>
                      <Field
                        accessibilityLabel={`${setLabel} ${t(copy.reps)}`}
                        containerStyle={styles.setField}
                        keyboardType="number-pad"
                        label={t(copy.reps)}
                        onChangeText={(value) =>
                          edit({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "reps",
                            value,
                          })
                        }
                        testID={`log-set-${exerciseIndex}-${setIndex}-reps`}
                        value={set.reps}
                      />
                      <Field
                        accessibilityLabel={`${setLabel} ${t(copy.weight)}`}
                        containerStyle={styles.setField}
                        hint={t(copy.weightHint)}
                        keyboardType="decimal-pad"
                        label={t(copy.weight)}
                        onChangeText={(value) =>
                          edit({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "weight",
                            value,
                          })
                        }
                        testID={`log-set-${exerciseIndex}-${setIndex}-weight`}
                        value={set.weight}
                      />
                      <Field
                        accessibilityLabel={`${setLabel} ${t(copy.rpe)}`}
                        containerStyle={styles.setField}
                        hint={t(copy.rpeHint)}
                        keyboardType="decimal-pad"
                        label={t(copy.rpe)}
                        onChangeText={(value) =>
                          edit({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "rpe",
                            value,
                          })
                        }
                        testID={`log-set-${exerciseIndex}-${setIndex}-rpe`}
                        value={set.rpe}
                      />
                    </View>
                  </View>
                );
              })}

              <Button
                accessibilityLabel={`${exerciseLabel}: ${t(copy.addSet)}`}
                label={t(copy.addSet)}
                onPress={() => edit({ type: "addSet", exerciseKey: exercise.key })}
                testID={`log-add-set-${exerciseIndex}`}
                variant="secondary"
              />
            </Card>
          );
        })}

        <Button
          label={t(copy.addExercise)}
          onPress={() => edit({ type: "addExercise" })}
          testID="log-add-exercise"
          variant="secondary"
        />

        {/* A timed session derives its duration from the shared timing, so the
            manual field only exists for after-the-fact entries. */}
        {!timed ? (
          <Field
            keyboardType="number-pad"
            label={t(copy.duration)}
            onChangeText={(value) => edit({ type: "setDurationMinutes", value })}
            testID="log-duration-minutes"
            value={draft.durationMinutes}
          />
        ) : null}

        <Field
          keyboardType="decimal-pad"
          label={t(copy.sleep)}
          onChangeText={(value) => edit({ type: "setSleepHours", value })}
          testID="log-sleep-hours"
          value={draft.sleepHours}
        />

        <Field
          inputStyle={styles.notesInput}
          label={t(copy.notes)}
          multiline
          numberOfLines={3}
          onChangeText={(value) => edit({ type: "setNotes", value })}
          testID="log-notes"
          value={draft.notes}
        />

        <View style={styles.section}>
          <Kicker tone="default">{t(copy.pain)}</Kicker>

          {draft.pain.map((entry, index) => (
            <Card key={entry.key} testID={`log-pain-${index}`}>
              <View style={styles.row}>
                <Field
                  containerStyle={styles.halfField}
                  label={t(copy.painArea, { index: index + 1 })}
                  onChangeText={(value) =>
                    edit({
                      type: "setPainField",
                      painKey: entry.key,
                      field: "area",
                      value,
                    })
                  }
                  testID={`log-pain-${index}-area`}
                  value={entry.area}
                />
                <Field
                  containerStyle={styles.halfField}
                  keyboardType="number-pad"
                  label={t(copy.painLevel, { index: index + 1 })}
                  onChangeText={(value) =>
                    edit({
                      type: "setPainField",
                      painKey: entry.key,
                      field: "level",
                      value,
                    })
                  }
                  testID={`log-pain-${index}-level`}
                  value={entry.level}
                />
              </View>
              <Button
                accessibilityLabel={t(copy.removePain)}
                label={t(copy.removePain)}
                onPress={() => edit({ type: "removePain", painKey: entry.key })}
                testID={`log-remove-pain-${index}`}
                variant="secondary"
              />
            </Card>
          ))}

          <Button
            label={t(copy.addPain)}
            onPress={() => edit({ type: "addPain" })}
            testID="log-add-pain"
            variant="secondary"
          />
        </View>

        {issueLines.length > 0 ? (
          <Banner
            message={[
              t(issues.length === 1 ? copy.validationIssue : copy.validationIssues, {
                count: issues.length,
              }),
              ...issueLines,
            ].join("\n")}
            testID="log-validation"
            tone="danger"
          />
        ) : null}

        {pendingIsStale ? (
          <Banner
            message={t(copy.warningInvalidated)}
            testID="log-warning-invalidated"
            tone="warn"
          />
        ) : null}

        {warningLines.length > 0 && !pendingIsStale ? (
          <Banner
            message={warningLines.join("\n")}
            testID="log-warnings"
            title={t(copy.warnings)}
            tone="warn"
          />
        ) : null}

        {pendingSave !== null && !pendingIsStale ? (
          <Button
            disabled={saving || repository === null}
            label={saving ? t(copy.saving) : t(copy.saveAnyway)}
            onPress={handleConfirmSave}
            testID="log-save-anyway"
          />
        ) : null}

        {saveError !== null ? (
          <>
            <Banner
              message={t(copy.saveError, { message: saveError })}
              testID="log-save-error"
              tone="danger"
            />
            <Button
              disabled={saving}
              label={t(copy.retry)}
              onPress={handleRetrySave}
              testID="log-save-retry"
            />
          </>
        ) : null}

        {success !== null ? (
          <Banner
            message={t(success === "created" ? copy.successCreated : copy.successDuplicate)}
            testID="log-success"
            title={t(copy.successTitle)}
          />
        ) : null}

        <Button
          disabled={!canSave}
          fullWidth
          label={saving ? t(copy.saving) : t(copy.save)}
          onPress={handleSubmit}
          testID="log-submit"
        />
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Extra bottom room keeps the last fields tappable above the keyboard.
  content: { paddingBottom: 160 },
  section: { gap: SPACING[2] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] },
  exerciseHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING[2],
  },
  restBlock: { gap: SPACING[2], marginTop: SPACING[1] },
  setBlock: { gap: SPACING[2], marginTop: SPACING[1] },
  setHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING[2],
  },
  setLabel: { fontWeight: "700" },
  setFields: { flexDirection: "row", alignItems: "flex-start", gap: SPACING[2] },
  setField: { flex: 1 },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING[3],
    minHeight: 44,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkmark: { fontSize: 16, fontWeight: "800", lineHeight: 20 },
  disabled: { opacity: 0.45 },
  halfField: { flex: 1 },
  notesInput: { minHeight: 88, paddingTop: SPACING[2], textAlignVertical: "top" },
});
