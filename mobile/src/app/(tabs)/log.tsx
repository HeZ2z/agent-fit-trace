import { SESSION_TYPES } from "@pi-fit-trace/core";
import type { ValidationIssue, ValidationWarning, WorkoutRecord } from "@pi-fit-trace/core";
import { displaySessionType, displayValidationMessage } from "@pi-fit-trace/i18n/domain";
import { useCallback, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";

import {
  createExerciseDraft,
  createLogDraft,
  createSetDraft,
  toSaveInput,
  todayLocalDate,
  validateLogDraft,
  type LogFormDraft,
} from "@/data/logModel";
import { useWorkoutData } from "@/data/provider";
import { useI18n } from "@/i18n";
import { SPACING } from "@/theme";
import {
  Banner,
  Body,
  Button,
  Card,
  Chip,
  Display,
  Field,
  Kicker,
  Screen,
  Title,
} from "@/ui";

/**
 * Log screen: a compact, scrollable session editor.
 *
 * Save policy: the draft is validated by the shared core before any write and
 * persisted through the local SQLite repository only after validation passes.
 * Accepted-but-suspicious input (warnings, e.g. 0 reps) needs an explicit
 * "Save anyway" confirmation, mirroring the web editor. On success the form is
 * cleared and a success banner stays here — this screen does not navigate to
 * History; History refreshes on focus when the user switches tabs. Any edit
 * clears stale validation, warning, error and success feedback.
 */
const copy = {
  kicker: "LOG",
  title: "Log a session",
  lede: "Capture sets, reps, load, and how the session felt while it is still fresh.",
  date: "Date",
  dateHint: "Date format: YYYY-MM-DD",
  sessionType: "Session type",
  exercises: "Exercises",
  exercise: "Exercise {index}",
  exerciseName: "Exercise {index} name",
  set: "Set {set}",
  reps: "Reps",
  weight: "Weight (kg)",
  weightHint: "Optional",
  rpe: "RPE",
  rpeHint: "1–10, optional",
  addSet: "Add set",
  removeSet: "Remove set",
  addExercise: "Add exercise",
  removeExercise: "Remove exercise",
  notes: "Notes (optional)",
  pain: "Pain (optional)",
  painArea: "Pain area",
  painLevel: "Pain level (0–10)",
  save: "Save workout",
  saving: "Saving…",
  saveAnyway: "Save anyway",
  warnings: "Warnings",
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
} as const;

type SaveSuccess = "created" | "duplicate";

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "";
}

export default function LogScreen() {
  const { language, t } = useI18n();
  const { status: dataStatus, repository, error: openError, reload } = useWorkoutData();

  const [form, setForm] = useState<LogFormDraft>(() => createLogDraft(todayLocalDate()));
  const formRef = useRef<LogFormDraft>(form);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [pending, setPending] = useState<WorkoutRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SaveSuccess | null>(null);

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

  /**
   * Any edit invalidates the captured warning confirmation and every piece of
   * feedback, so a save can never use a record the form no longer represents.
   */
  const updateForm = useCallback(
    (updater: (current: LogFormDraft) => LogFormDraft) => {
      setForm((current) => {
        const next = updater(current);
        formRef.current = next;
        return next;
      });
      setIssues([]);
      setWarnings([]);
      setPending(null);
      setSaveError(null);
      setSuccess(null);
    },
    [],
  );

  const persist = useCallback(
    async (record: WorkoutRecord): Promise<void> => {
      if (repository === null) {
        setSaveError(t(copy.storeNotReady));
        return;
      }

      setSaving(true);
      setSaveError(null);
      const submittedForm = formRef.current;
      try {
        const result = await repository.saveWorkout(toSaveInput(record));
        setSuccess(result.created ? "created" : "duplicate");
        // Only clear the form if it still matches what was submitted; edits made
        // during the save must not be erased.
        if (formRef.current === submittedForm) {
          const cleared = createLogDraft(todayLocalDate());
          formRef.current = cleared;
          setForm(cleared);
        }
        setIssues([]);
        setWarnings([]);
        setPending(null);
      } catch (cause) {
        setSaveError(translateError(cause));
      } finally {
        setSaving(false);
      }
    },
    [repository, t, translateError],
  );

  const handleSubmit = useCallback(() => {
    if (saving || repository === null) return;

    setIssues([]);
    setWarnings([]);
    setPending(null);
    setSaveError(null);
    setSuccess(null);

    const result = validateLogDraft(form);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    if (result.warnings.length > 0) {
      setWarnings(result.warnings);
      setPending(result.record);
      return;
    }
    void persist(result.record);
  }, [form, persist, repository, saving]);

  const handleConfirmSave = useCallback(() => {
    if (saving || pending === null) return;
    void persist(pending);
  }, [pending, persist, saving]);

  const handleRetrySave = useCallback(() => {
    if (saving) return;
    if (pending !== null) {
      void persist(pending);
      return;
    }
    handleSubmit();
  }, [handleSubmit, pending, persist, saving]);

  function updateExerciseName(index: number, name: string): void {
    updateForm((current) => ({
      ...current,
      exercises: current.exercises.map((exercise, exerciseIndex) =>
        exerciseIndex === index ? { ...exercise, name } : exercise,
      ),
    }));
  }

  function updateSetField(
    exerciseIndex: number,
    setIndex: number,
    field: "reps" | "weight" | "rpe",
    value: string,
  ): void {
    updateForm((current) => ({
      ...current,
      exercises: current.exercises.map((exercise, currentExercise) =>
        currentExercise === exerciseIndex
          ? {
              ...exercise,
              sets: exercise.sets.map((set, currentSet) =>
                currentSet === setIndex ? { ...set, [field]: value } : set,
              ),
            }
          : exercise,
      ),
    }));
  }

  function addSet(exerciseIndex: number): void {
    updateForm((current) => ({
      ...current,
      exercises: current.exercises.map((exercise, currentExercise) =>
        currentExercise === exerciseIndex
          ? { ...exercise, sets: [...exercise.sets, createSetDraft()] }
          : exercise,
      ),
    }));
  }

  function removeSet(exerciseIndex: number, setIndex: number): void {
    updateForm((current) => ({
      ...current,
      exercises: current.exercises.map((exercise, currentExercise) =>
        currentExercise === exerciseIndex && exercise.sets.length > 1
          ? {
              ...exercise,
              sets: exercise.sets.filter((_, currentSet) => currentSet !== setIndex),
            }
          : exercise,
      ),
    }));
  }

  function addExercise(): void {
    updateForm((current) => ({
      ...current,
      exercises: [...current.exercises, createExerciseDraft()],
    }));
  }

  function removeExercise(exerciseIndex: number): void {
    updateForm((current) =>
      current.exercises.length <= 1
        ? current
        : {
            ...current,
            exercises: current.exercises.filter(
              (_, currentExercise) => currentExercise !== exerciseIndex,
            ),
          },
    );
  }

  // Duplicate validation-message text is collapsed so a blank set count does
  // not repeat the same sentence once per field.
  const issueLines = [
    ...new Set(issues.map((issue) => displayValidationMessage(language, issue.message))),
  ];
  const warningLines = [
    ...new Set(warnings.map((warning) => displayValidationMessage(language, warning.message))),
  ];

  const canSave = repository !== null && !saving && pending === null;
  const storeLoading = dataStatus === "loading";
  const storeFailed = dataStatus === "error";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.flex}>
      <Screen contentContainerStyle={styles.content} testID="screen-log">
        <Kicker>{t(copy.kicker)}</Kicker>
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

        <Field
          autoCapitalize="none"
          autoCorrect={false}
          hint={t(copy.dateHint)}
          label={t(copy.date)}
          onChangeText={(value) => updateForm((current) => ({ ...current, date: value }))}
          testID="log-date"
          value={form.date}
        />

        <View style={styles.section}>
          <Kicker tone="default">{t(copy.sessionType)}</Kicker>
          <View style={styles.chips}>
            {SESSION_TYPES.map((type) => (
              <Chip
                key={type}
                label={displaySessionType(language, type)}
                onPress={() => updateForm((current) => ({ ...current, sessionType: type }))}
                selected={form.sessionType === type}
                testID={`log-session-${type}`}
              />
            ))}
          </View>
        </View>

        <Title>{t(copy.exercises)}</Title>

        {form.exercises.map((exercise, exerciseIndex) => {
          const exerciseLabel = t(copy.exercise, { index: exerciseIndex + 1 });

          return (
            <Card key={exerciseIndex} testID={`log-exercise-${exerciseIndex}`}>
              <View style={styles.exerciseHead}>
                <Title>{exerciseLabel}</Title>
                {form.exercises.length > 1 ? (
                  <Button
                    accessibilityLabel={`${exerciseLabel}: ${t(copy.removeExercise)}`}
                    label={t(copy.removeExercise)}
                    onPress={() => removeExercise(exerciseIndex)}
                    testID={`log-remove-exercise-${exerciseIndex}`}
                    variant="secondary"
                  />
                ) : null}
              </View>

              <Field
                label={t(copy.exerciseName, { index: exerciseIndex + 1 })}
                onChangeText={(value) => updateExerciseName(exerciseIndex, value)}
                testID={`log-exercise-${exerciseIndex}-name`}
                value={exercise.name}
              />

              {exercise.sets.map((set, setIndex) => {
                const setLabel = t(copy.set, { set: setIndex + 1 });

                return (
                  <View
                    key={setIndex}
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
                          onPress={() => removeSet(exerciseIndex, setIndex)}
                          testID={`log-remove-set-${exerciseIndex}-${setIndex}`}
                          variant="secondary"
                        />
                      ) : null}
                    </View>

                    <View style={styles.setFields}>
                      <Field
                        accessibilityLabel={`${setLabel} ${t(copy.reps)}`}
                        containerStyle={styles.setField}
                        keyboardType="number-pad"
                        label={t(copy.reps)}
                        onChangeText={(value) =>
                          updateSetField(exerciseIndex, setIndex, "reps", value)
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
                          updateSetField(exerciseIndex, setIndex, "weight", value)
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
                          updateSetField(exerciseIndex, setIndex, "rpe", value)
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
                onPress={() => addSet(exerciseIndex)}
                testID={`log-add-set-${exerciseIndex}`}
                variant="secondary"
              />
            </Card>
          );
        })}

        <Button
          label={t(copy.addExercise)}
          onPress={addExercise}
          testID="log-add-exercise"
          variant="secondary"
        />

        <Field
          inputStyle={styles.notesInput}
          label={t(copy.notes)}
          multiline
          numberOfLines={3}
          onChangeText={(value) => updateForm((current) => ({ ...current, notes: value }))}
          testID="log-notes"
          value={form.notes}
        />

        <View style={styles.section}>
          <Kicker tone="default">{t(copy.pain)}</Kicker>
          <View style={styles.row}>
            <Field
              containerStyle={styles.halfField}
              label={t(copy.painArea)}
              onChangeText={(value) =>
                updateForm((current) => ({ ...current, painArea: value }))
              }
              testID="log-pain-area"
              value={form.painArea}
            />
            <Field
              containerStyle={styles.halfField}
              keyboardType="number-pad"
              label={t(copy.painLevel)}
              onChangeText={(value) =>
                updateForm((current) => ({ ...current, painLevel: value }))
              }
              testID="log-pain-level"
              value={form.painLevel}
            />
          </View>
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

        {warningLines.length > 0 ? (
          <>
            <Banner
              message={warningLines.join("\n")}
              testID="log-warnings"
              title={t(copy.warnings)}
              tone="warn"
            />
            <Button
              disabled={saving || repository === null}
              label={saving ? t(copy.saving) : t(copy.saveAnyway)}
              onPress={handleConfirmSave}
              testID="log-save-anyway"
            />
          </>
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
  exerciseHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING[2],
  },
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
  row: { flexDirection: "row", alignItems: "flex-start", gap: SPACING[2] },
  halfField: { flex: 1 },
  notesInput: { minHeight: 88, paddingTop: SPACING[2], textAlignVertical: "top" },
});
