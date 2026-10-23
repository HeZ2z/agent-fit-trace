import { useReducer, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { EXTREME_RPE, SESSION_TYPES, stableStringify } from "@agent-fit-trace/core";
import type {
  SessionType,
  ValidationIssue,
  ValidationWarning,
  WorkoutRecord,
} from "@agent-fit-trace/core";
import {
  buildWorkoutRecord,
  createSessionDraft,
  createSessionRuntime,
  reduceSessionState,
  toSaveInput,
  todayLocalDate,
  validateSessionDraft,
} from "@agent-fit-trace/workout-session";
import { ExerciseNameCombobox } from "../components/ExerciseNameCombobox.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useI18n } from "../i18n/useI18n.ts";
import {
  displayIssue,
  displaySessionType,
  displayValidationMessage,
  displayWarning,
} from "../i18n/domain.ts";

/**
 * Presentation-only safety hint. The shared build already parses the draft, but
 * the threshold check stays local so the badge can react to partially typed RPE
 * input without touching the record model.
 */
function isExtremeRpe(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= EXTREME_RPE;
}

/**
 * A record captured for the warning confirmation, plus the clock used to build
 * it. The built (pre-validation-normalization) record is stored so staleness can
 * compare like with like against a fresh build of the current draft.
 */
interface PendingSave {
  record: WorkoutRecord;
  nowMs: number;
}

export function WorkoutEditorScreen() {
  const navigate = useNavigate();
  const { saveWorkout, saveStatus } = useWorkouts();
  const { language, t } = useI18n();
  const saving = saveStatus === "saving";

  // One shared draft + runtime reducer owns every field, exercise, set and pain
  // edit; keys are allocated by the reducer instead of a component counter.
  const [state, dispatch] = useReducer(reduceSessionState, {
    draft: createSessionDraft(todayLocalDate()),
    runtime: createSessionRuntime(),
  });
  const { draft } = state;

  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);

  // The captured record is only valid while the form still builds the same
  // content. Deriving staleness (rather than clearing it in every change
  // handler) means no field edit can be forgotten, so a stale value can never
  // be saved.
  const pendingIsStale =
    pendingSave !== null &&
    stableStringify(buildWorkoutRecord(draft, pendingSave.nowMs)) !==
      stableStringify(pendingSave.record);

  async function persist(record: WorkoutRecord): Promise<void> {
    // Save failures (unavailable, quota, conflict) must surface to the user
    // rather than escaping as an unhandled error. Input is retained and no
    // navigation happens until the save resolves.
    try {
      const saved = await saveWorkout(toSaveInput(record));
      navigate(`/workout/${saved.id}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setIssues([]);
    setWarnings([]);
    setSaveError(null);
    setPendingSave(null);

    const nowMs = Date.now();
    // Build before validation: the client derives the content id from the
    // submitted content, and historical records were hashed with the untrimmed
    // name. Persisting this pre-normalization build keeps re-entry idempotent;
    // validation still trims/normalizes the record the client stores.
    const candidate = buildWorkoutRecord(draft, nowMs);
    // The shared bridge runs core validation and separates hard issues from
    // accepted-input warnings.
    const validated = validateSessionDraft(draft, nowMs);

    if (!validated.ok) {
      setIssues(validated.issues);
      return; // Do not persist an invalid record.
    }

    // Accepted-but-suspicious input (e.g. implausibly low sleep) must be seen
    // before the record is saved, so require an explicit confirmation rather
    // than navigating away immediately.
    if (validated.warnings.length > 0) {
      setWarnings(validated.warnings);
      setPendingSave({ record: candidate, nowMs });
      return;
    }

    await persist(candidate);
  }

  async function handleConfirmSave(): Promise<void> {
    if (saving) return;
    // The form changed after the warning was shown: drop the stale record and
    // require a fresh submission and validation.
    if (pendingSave === null || pendingIsStale) {
      setPendingSave(null);
      setWarnings([]);
      return;
    }
    const pending = pendingSave;
    setPendingSave(null);
    await persist(pending.record);
  }

  return (
    <section data-screen="log">
      <h1>{t("Log Workout")}</h1>
      <p className="screen-lede">
        {t(
          "Record one session. Validation runs before anything is stored, and no existing record is ever overwritten.",
        )}
      </p>

      {saveError !== null && (
        <div role="alert" className="validation-summary" data-testid="save-error">
          <p>
            {t("Could not save this workout: {message}", {
              message: displayValidationMessage(language, saveError),
            })}
          </p>
        </div>
      )}

      {issues.length > 0 && (
        <div role="alert" className="validation-summary" data-testid="validation-summary">
          <p>
            {issues.length === 1
              ? t("{count} validation issue — please fix before saving.", { count: issues.length })
              : t("{count} validation issues — please fix before saving.", { count: issues.length })}
          </p>
          <ul>
            {issues.map((issue, index) => (
              <li
                key={`${issue.code}-${index}`}
                data-issue-code={issue.code}
                data-issue-path={issue.path ?? ""}
              >
                {issue.path ? `${issue.path}: ` : ""}
                {displayIssue(language, issue)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && !pendingIsStale && (
        <ul role="status" aria-label={t("Warnings")} className="validation-warnings">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`} data-warning-code={warning.code}>
              {displayWarning(language, warning)}
            </li>
          ))}
        </ul>
      )}

      {pendingIsStale && (
        <p role="status" className="validation-warnings" data-testid="warning-invalidated">
          {t("Form changed since the warning was shown. Submit again to re-validate.")}
        </p>
      )}

      {pendingSave !== null && !pendingIsStale && (
        <div className="validation-warnings" data-testid="warning-confirmation">
          <p>{t("This workout was accepted with warnings. Save it anyway?")}</p>
          <button type="button" onClick={handleConfirmSave} disabled={saving}>
            {t("Save anyway")}
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset>
          <legend>{t("Exercises")}</legend>

          {draft.exercises.map((exercise, exerciseIndex) => (
            <fieldset key={exercise.key} className="exercise-editor">
              <legend>{t("Exercise {index}", { index: exerciseIndex + 1 })}</legend>

              <ExerciseNameCombobox
                id={`exercise-${exercise.key}-name`}
                label={t("Exercise {index} name", { index: exerciseIndex + 1 })}
                value={exercise.name}
                onChange={(name) =>
                  dispatch({ type: "setExerciseName", exerciseKey: exercise.key, name })
                }
              />

              {exercise.sets.map((set, setIndex) => {
                const base = `exercise-${exercise.key}-set-${set.key}`;
                const extreme = isExtremeRpe(set.rpe);
                return (
                  <fieldset
                    key={set.key}
                    className="set-editor"
                    data-safety={extreme ? "extreme-rpe" : undefined}
                  >
                    <legend>
                      {t("Exercise {exercise} set {set}", {
                        exercise: exerciseIndex + 1,
                        set: setIndex + 1,
                      })}
                    </legend>

                    <div className="field">
                      <label htmlFor={`${base}-weight`}>
                        {t("Exercise {exercise} set {set} weight (kg)", {
                          exercise: exerciseIndex + 1,
                          set: setIndex + 1,
                        })}
                      </label>
                      <input
                        id={`${base}-weight`}
                        type="number"
                        step="any"
                        value={set.weight}
                        onChange={(event) =>
                          dispatch({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "weight",
                            value: event.target.value,
                          })
                        }
                      />
                    </div>

                    <div className="field">
                      <label htmlFor={`${base}-reps`}>
                        {t("Exercise {exercise} set {set} reps", {
                          exercise: exerciseIndex + 1,
                          set: setIndex + 1,
                        })}
                      </label>
                      <input
                        id={`${base}-reps`}
                        type="number"
                        step="1"
                        value={set.reps}
                        onChange={(event) =>
                          dispatch({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "reps",
                            value: event.target.value,
                          })
                        }
                      />
                    </div>

                    <div className="field">
                      <label htmlFor={`${base}-rpe`}>
                        {t("Exercise {exercise} set {set} RPE", {
                          exercise: exerciseIndex + 1,
                          set: setIndex + 1,
                        })}
                      </label>
                      <input
                        id={`${base}-rpe`}
                        type="number"
                        min="1"
                        max="10"
                        step="0.5"
                        value={set.rpe}
                        onChange={(event) =>
                          dispatch({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "rpe",
                            value: event.target.value,
                          })
                        }
                      />
                    </div>

                    {extreme && <span className="safety-badge">{t("Extreme effort")}</span>}

                    <button
                      type="button"
                      // The shared reducer keeps at least one set per exercise,
                      // so the last remaining one cannot be removed.
                      disabled={exercise.sets.length <= 1}
                      onClick={() =>
                        dispatch({
                          type: "removeSet",
                          exerciseKey: exercise.key,
                          setKey: set.key,
                        })
                      }
                    >
                      {t("Remove set")}
                    </button>
                  </fieldset>
                );
              })}

              <button
                type="button"
                onClick={() => dispatch({ type: "addSet", exerciseKey: exercise.key })}
              >
                {t("Add set")}
              </button>
              <button
                type="button"
                // The shared reducer keeps at least one exercise, so the last
                // remaining one cannot be removed.
                disabled={draft.exercises.length <= 1}
                onClick={() => dispatch({ type: "removeExercise", exerciseKey: exercise.key })}
              >
                {t("Remove exercise")}
              </button>
            </fieldset>
          ))}

          <button type="button" onClick={() => dispatch({ type: "addExercise" })}>
            {t("Add exercise")}
          </button>
        </fieldset>

        <fieldset>
          <legend>{t("Session")}</legend>

          <div className="field">
            <label htmlFor="workout-date">{t("Date")}</label>
            <input
              id="workout-date"
              type="date"
              value={draft.date}
              onChange={(event) => dispatch({ type: "setDate", date: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="workout-session-type">{t("Session type")}</label>
            <select
              id="workout-session-type"
              value={draft.sessionType}
              onChange={(event) =>
                dispatch({
                  type: "setSessionType",
                  sessionType: event.target.value as SessionType,
                })
              }
            >
              {SESSION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {displaySessionType(language, type)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="workout-duration-minutes">{t("Duration (minutes)")}</label>
            <input
              id="workout-duration-minutes"
              type="number"
              min="1"
              step="1"
              value={draft.durationMinutes}
              onChange={(event) =>
                dispatch({ type: "setDurationMinutes", value: event.target.value })
              }
            />
          </div>

          <div className="field">
            <label htmlFor="workout-sleep-hours">{t("Sleep (hours)")}</label>
            <input
              id="workout-sleep-hours"
              type="number"
              min="0"
              max="24"
              step="0.5"
              value={draft.sleepHours}
              onChange={(event) => dispatch({ type: "setSleepHours", value: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="workout-notes">{t("Notes")}</label>
            <textarea
              id="workout-notes"
              value={draft.notes}
              onChange={(event) => dispatch({ type: "setNotes", value: event.target.value })}
            />
          </div>
        </fieldset>

        <fieldset>
          <legend>{t("Pain")}</legend>

          {draft.pain.map((entry, index) => (
            <div key={entry.key} className="pain-editor" data-safety="pain">
              <div className="field">
                <label htmlFor={`pain-${entry.key}-area`}>
                  {t("Pain {index} area", { index: index + 1 })}
                </label>
                <input
                  id={`pain-${entry.key}-area`}
                  type="text"
                  value={entry.area}
                  onChange={(event) =>
                    dispatch({
                      type: "setPainField",
                      painKey: entry.key,
                      field: "area",
                      value: event.target.value,
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor={`pain-${entry.key}-level`}>
                  {t("Pain {index} level", { index: index + 1 })}
                </label>
                <input
                  id={`pain-${entry.key}-level`}
                  type="number"
                  min="0"
                  max="10"
                  step="1"
                  value={entry.level}
                  onChange={(event) =>
                    dispatch({
                      type: "setPainField",
                      painKey: entry.key,
                      field: "level",
                      value: event.target.value,
                    })
                  }
                />
              </div>

              <span className="safety-badge">{t("Pain reported")}</span>

              <button
                type="button"
                onClick={() => dispatch({ type: "removePain", painKey: entry.key })}
              >
                {t("Remove pain")}
              </button>
            </div>
          ))}

          <button type="button" onClick={() => dispatch({ type: "addPain" })}>
            {t("Add pain")}
          </button>
        </fieldset>

        <button type="submit" disabled={saving}>
          {t("Save workout")}
        </button>
      </form>
    </section>
  );
}
