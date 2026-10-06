import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  CURRENT_SCHEMA_VERSION,
  EXTREME_RPE,
  SESSION_TYPES,
  ValidationError,
  stableStringify,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type { ValidationIssue, ValidationWarning } from "@pi-fit-trace/core";
import { useWorkouts } from "../state/useWorkouts.ts";

interface SetDraft {
  key: number;
  weight: string;
  reps: string;
  rpe: string;
}

interface ExerciseDraft {
  key: number;
  name: string;
  sets: SetDraft[];
}

interface PainDraft {
  key: number;
  area: string;
  level: string;
}

/** UI-only default so the date field opens on today; the core has no clock. */
function todayLocalDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Parse a numeric field, treating blank input as absent. */
function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return Number(trimmed);
}

function isExtremeRpe(raw: string): boolean {
  const value = parseOptionalNumber(raw);
  return value !== undefined && Number.isFinite(value) && value >= EXTREME_RPE;
}

export function WorkoutEditorScreen() {
  const navigate = useNavigate();
  const { saveWorkout, saveStatus } = useWorkouts();
  const saving = saveStatus === "saving";
  const nextKey = useRef(1);

  const makeSet = (): SetDraft => ({ key: nextKey.current++, weight: "", reps: "", rpe: "" });
  const makeExercise = (): ExerciseDraft => ({
    key: nextKey.current++,
    name: "",
    sets: [makeSet()],
  });
  const makePain = (): PainDraft => ({ key: nextKey.current++, area: "", level: "" });

  const [date, setDate] = useState(todayLocalDate);
  const [sessionType, setSessionType] = useState<string>(SESSION_TYPES[0]);
  const [durationMinutes, setDurationMinutes] = useState("");
  const [sleepHours, setSleepHours] = useState("");
  const [notes, setNotes] = useState("");
  const [exercises, setExercises] = useState<ExerciseDraft[]>(() => [makeExercise()]);
  const [pain, setPain] = useState<PainDraft[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<Record<string, unknown> | null>(null);

  // The captured draft is only valid while the form still matches it. Deriving
  // staleness (rather than clearing it in every change handler) means no field
  // edit can be forgotten, so a stale value can never be saved.
  const pendingIsStale =
    pendingSave !== null && stableStringify(buildDraft()) !== stableStringify(pendingSave);

  function addExercise(): void {
    const exercise = makeExercise();
    setExercises((prev) => [...prev, exercise]);
  }

  function removeExercise(key: number): void {
    setExercises((prev) => prev.filter((exercise) => exercise.key !== key));
  }

  function updateExerciseName(key: number, name: string): void {
    setExercises((prev) =>
      prev.map((exercise) => (exercise.key === key ? { ...exercise, name } : exercise)),
    );
  }

  function addSet(exerciseKey: number): void {
    const set = makeSet();
    setExercises((prev) =>
      prev.map((exercise) =>
        exercise.key === exerciseKey ? { ...exercise, sets: [...exercise.sets, set] } : exercise,
      ),
    );
  }

  function removeSet(exerciseKey: number, setKey: number): void {
    setExercises((prev) =>
      prev.map((exercise) =>
        exercise.key === exerciseKey
          ? { ...exercise, sets: exercise.sets.filter((set) => set.key !== setKey) }
          : exercise,
      ),
    );
  }

  function updateSet(
    exerciseKey: number,
    setKey: number,
    field: "weight" | "reps" | "rpe",
    value: string,
  ): void {
    setExercises((prev) =>
      prev.map((exercise) =>
        exercise.key === exerciseKey
          ? {
              ...exercise,
              sets: exercise.sets.map((set) =>
                set.key === setKey ? { ...set, [field]: value } : set,
              ),
            }
          : exercise,
      ),
    );
  }

  function addPain(): void {
    const entry = makePain();
    setPain((prev) => [...prev, entry]);
  }

  function removePain(key: number): void {
    setPain((prev) => prev.filter((entry) => entry.key !== key));
  }

  function updatePain(key: number, field: "area" | "level", value: string): void {
    setPain((prev) => prev.map((entry) => (entry.key === key ? { ...entry, [field]: value } : entry)));
  }

  function buildDraft(): Record<string, unknown> {
    const draft: Record<string, unknown> = {
      // Placeholder id: validation requires a non-empty id, but the id is
      // owned by the client — it is stripped before saving so the client
      // derives the real id from content (idempotent retries).
      id: "pending",
      schema_version: CURRENT_SCHEMA_VERSION,
      date,
      session_type: sessionType,
      exercises: exercises.map((exercise) => ({
        name: exercise.name,
        sets: exercise.sets.map((set) => {
          const built: Record<string, unknown> = {};
          const weight = parseOptionalNumber(set.weight);
          if (weight !== undefined) built.weight = weight;
          const reps = parseOptionalNumber(set.reps);
          if (reps !== undefined) built.reps = reps;
          const rpe = parseOptionalNumber(set.rpe);
          if (rpe !== undefined) built.rpe = rpe;
          return built;
        }),
      })),
    };

    if (durationMinutes.trim() !== "") draft.duration_minutes = Number(durationMinutes);
    if (sleepHours.trim() !== "") draft.sleep_hours = Number(sleepHours);
    if (notes.trim() !== "") draft.notes = notes;

    if (pain.length > 0) {
      draft.pain = pain.map((entry) => {
        const report: Record<string, unknown> = {};
        if (entry.area.trim() !== "") report.area = entry.area;
        const level = parseOptionalNumber(entry.level);
        if (level !== undefined) report.level = level;
        return report;
      });
    }

    return draft;
  }

  /** Drop the validation placeholder so the client derives the real id. */
  function buildSaveInputFrom(draft: Record<string, unknown>): Record<string, unknown> {
    if (draft.id === "pending") {
      const { id: _placeholder, ...rest } = draft;
      return rest;
    }
    return draft;
  }

  async function persist(draft: Record<string, unknown>): Promise<void> {
    // Save failures (unavailable, quota, conflict) must surface to the user
    // rather than escaping as an unhandled error. Input is retained and no
    // navigation happens until the save resolves.
    try {
      const saved = await saveWorkout(buildSaveInputFrom(draft));
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

    const draft = buildDraft();

    let validated;
    try {
      validated = validateWorkoutRecord(draft);
    } catch (error) {
      if (error instanceof ValidationError) {
        setIssues(error.issues);
        return; // Do not persist an invalid record.
      }
      throw error;
    }

    // Accepted-but-suspicious input (e.g. implausibly low sleep) must be seen
    // before the record is saved, so require an explicit confirmation rather
    // than navigating away immediately.
    if (validated.warnings.length > 0) {
      setWarnings(validated.warnings);
      setPendingSave(draft);
      return;
    }

    await persist(draft);
  }

  async function handleConfirmSave(): Promise<void> {
    if (saving) return;
    // The form changed after the warning was shown: drop the stale draft and
    // require a fresh submission and validation.
    if (pendingSave === null || pendingIsStale) {
      setPendingSave(null);
      setWarnings([]);
      return;
    }
    const draft = pendingSave;
    setPendingSave(null);
    await persist(draft);
  }

  return (
    <section>
      <h1>Log Workout</h1>

      {saveError !== null && (
        <div role="alert" className="validation-summary" data-testid="save-error">
          <p>Could not save this workout: {saveError}</p>
        </div>
      )}

      {issues.length > 0 && (
        <div role="alert" className="validation-summary" data-testid="validation-summary">
          <p>
            {issues.length} validation {issues.length === 1 ? "issue" : "issues"} — please fix before
            saving.
          </p>
          <ul>
            {issues.map((issue, index) => (
              <li
                key={`${issue.code}-${index}`}
                data-issue-code={issue.code}
                data-issue-path={issue.path ?? ""}
              >
                {issue.path ? `${issue.path}: ` : ""}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && !pendingIsStale && (
        <ul role="status" aria-label="Warnings" className="validation-warnings">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`} data-warning-code={warning.code}>
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      {pendingIsStale && (
        <p role="status" className="validation-warnings" data-testid="warning-invalidated">
          Form changed since the warning was shown. Submit again to re-validate.
        </p>
      )}

      {pendingSave !== null && !pendingIsStale && (
        <div className="validation-warnings" data-testid="warning-confirmation">
          <p>This workout was accepted with warnings. Save it anyway?</p>
          <button type="button" onClick={handleConfirmSave} disabled={saving}>
            Save anyway
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset>
          <legend>Session</legend>

          <div className="field">
            <label htmlFor="workout-date">Date</label>
            <input
              id="workout-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="workout-session-type">Session type</label>
            <select
              id="workout-session-type"
              value={sessionType}
              onChange={(event) => setSessionType(event.target.value)}
            >
              {SESSION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="workout-duration-minutes">Duration (minutes)</label>
            <input
              id="workout-duration-minutes"
              type="number"
              min="1"
              step="1"
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="workout-sleep-hours">Sleep (hours)</label>
            <input
              id="workout-sleep-hours"
              type="number"
              min="0"
              max="24"
              step="0.5"
              value={sleepHours}
              onChange={(event) => setSleepHours(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="workout-notes">Notes</label>
            <textarea
              id="workout-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </fieldset>

        <fieldset>
          <legend>Exercises</legend>

          {exercises.map((exercise, exerciseIndex) => (
            <fieldset key={exercise.key} className="exercise-editor">
              <legend>Exercise {exerciseIndex + 1}</legend>

              <div className="field">
                <label htmlFor={`exercise-${exercise.key}-name`}>
                  Exercise {exerciseIndex + 1} name
                </label>
                <input
                  id={`exercise-${exercise.key}-name`}
                  type="text"
                  value={exercise.name}
                  onChange={(event) => updateExerciseName(exercise.key, event.target.value)}
                />
              </div>

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
                      Exercise {exerciseIndex + 1} set {setIndex + 1}
                    </legend>

                    <div className="field">
                      <label htmlFor={`${base}-weight`}>
                        Exercise {exerciseIndex + 1} set {setIndex + 1} weight (kg)
                      </label>
                      <input
                        id={`${base}-weight`}
                        type="number"
                        step="any"
                        value={set.weight}
                        onChange={(event) =>
                          updateSet(exercise.key, set.key, "weight", event.target.value)
                        }
                      />
                    </div>

                    <div className="field">
                      <label htmlFor={`${base}-reps`}>
                        Exercise {exerciseIndex + 1} set {setIndex + 1} reps
                      </label>
                      <input
                        id={`${base}-reps`}
                        type="number"
                        step="1"
                        value={set.reps}
                        onChange={(event) => updateSet(exercise.key, set.key, "reps", event.target.value)}
                      />
                    </div>

                    <div className="field">
                      <label htmlFor={`${base}-rpe`}>
                        Exercise {exerciseIndex + 1} set {setIndex + 1} RPE
                      </label>
                      <input
                        id={`${base}-rpe`}
                        type="number"
                        min="1"
                        max="10"
                        step="0.5"
                        value={set.rpe}
                        onChange={(event) => updateSet(exercise.key, set.key, "rpe", event.target.value)}
                      />
                    </div>

                    {extreme && <span className="safety-badge">Extreme effort</span>}

                    <button type="button" onClick={() => removeSet(exercise.key, set.key)}>
                      Remove set
                    </button>
                  </fieldset>
                );
              })}

              <button type="button" onClick={() => addSet(exercise.key)}>
                Add set
              </button>
              <button type="button" onClick={() => removeExercise(exercise.key)}>
                Remove exercise
              </button>
            </fieldset>
          ))}

          <button type="button" onClick={addExercise}>
            Add exercise
          </button>
        </fieldset>

        <fieldset>
          <legend>Pain</legend>

          {pain.map((entry, index) => (
            <div key={entry.key} className="pain-editor" data-safety="pain">
              <div className="field">
                <label htmlFor={`pain-${entry.key}-area`}>Pain {index + 1} area</label>
                <input
                  id={`pain-${entry.key}-area`}
                  type="text"
                  value={entry.area}
                  onChange={(event) => updatePain(entry.key, "area", event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor={`pain-${entry.key}-level`}>Pain {index + 1} level</label>
                <input
                  id={`pain-${entry.key}-level`}
                  type="number"
                  min="0"
                  max="10"
                  step="1"
                  value={entry.level}
                  onChange={(event) => updatePain(entry.key, "level", event.target.value)}
                />
              </div>

              <span className="safety-badge">Pain reported</span>

              <button type="button" onClick={() => removePain(entry.key)}>
                Remove pain
              </button>
            </div>
          ))}

          <button type="button" onClick={addPain}>
            Add pain
          </button>
        </fieldset>

        <button type="submit" disabled={saving}>Save workout</button>
      </form>
    </section>
  );
}
