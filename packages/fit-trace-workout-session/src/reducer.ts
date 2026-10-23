/**
 * Pure reducer for the unified session editor.
 *
 * Stage 2 of issue #24 owns the draft-edit transitions only: adding, editing
 * and removing exercises, sets and pain reports, plus the session-level fields.
 * Persisted timing and the transient rest machine arrive in stage 3; their
 * action variants are already declared so the exhaustive switch below fails
 * type-checking the moment a variant is added without handling.
 *
 * Every transition returns new objects and leaves its input state untouched, so
 * React can rely on reference equality to skip re-renders.
 */

import type { SessionAction } from "./actions.ts";
import { allocateKey, createDraftExercise, createDraftPain, createDraftSet } from "./draft.ts";
import type { DraftExercise, DraftPain, DraftSet, SessionDraft, SessionState } from "./types.ts";

/** Fail compilation (and throw at runtime) when a new action variant is unhandled. */
function assertNever(action: never): never {
  throw new Error(`Unhandled session action: ${JSON.stringify(action)}`);
}

/** Apply a draft change, reusing the state object when the draft is unchanged. */
function withDraft(state: SessionState, draft: SessionDraft): SessionState {
  return draft === state.draft ? state : { ...state, draft };
}

/**
 * Replace one exercise by key.
 *
 * Returns the draft untouched (same reference) when the key is unknown or the
 * callback returns the exercise unchanged, so bulk no-ops do not re-render.
 */
function updateExercise(
  draft: SessionDraft,
  exerciseKey: number,
  update: (exercise: DraftExercise) => DraftExercise,
): SessionDraft {
  const index = draft.exercises.findIndex((exercise) => exercise.key === exerciseKey);
  if (index === -1) return draft;
  const exercise = draft.exercises[index];
  const next = update(exercise);
  if (next === exercise) return draft;
  const exercises = draft.exercises.slice();
  exercises[index] = next;
  return { ...draft, exercises };
}

/** Replace one set of one exercise by key, with the same no-op semantics. */
function updateSet(
  draft: SessionDraft,
  exerciseKey: number,
  setKey: number,
  update: (set: DraftSet) => DraftSet,
): SessionDraft {
  return updateExercise(draft, exerciseKey, (exercise) => {
    const index = exercise.sets.findIndex((set) => set.key === setKey);
    if (index === -1) return exercise;
    const set = exercise.sets[index];
    const next = update(set);
    if (next === set) return exercise;
    const sets = exercise.sets.slice();
    sets[index] = next;
    return { ...exercise, sets };
  });
}

/**
 * Reduce one editor action.
 *
 * Unknown exercise/set/pain keys are ignored rather than throwing: the UI can
 * dispatch a stale action after a delete, and a no-op is safer than a crash in
 * a reducer.
 */
export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  const { draft } = state;

  switch (action.type) {
    // Session-level fields.
    case "setDate":
      if (draft.date === action.date) return state;
      return withDraft(state, { ...draft, date: action.date });
    case "setSessionType":
      if (draft.sessionType === action.sessionType) return state;
      return withDraft(state, { ...draft, sessionType: action.sessionType });
    case "setDurationMinutes":
      if (draft.durationMinutes === action.value) return state;
      return withDraft(state, { ...draft, durationMinutes: action.value });
    case "setSleepHours":
      if (draft.sleepHours === action.value) return state;
      return withDraft(state, { ...draft, sleepHours: action.value });
    case "setNotes":
      if (draft.notes === action.value) return state;
      return withDraft(state, { ...draft, notes: action.value });

    // Exercises.
    case "addExercise": {
      // The creator claims `key` for the exercise and `key + 1` for its first set.
      const exercise = createDraftExercise(allocateKey(draft));
      return withDraft(state, { ...draft, exercises: [...draft.exercises, exercise] });
    }
    case "removeExercise": {
      // A session always keeps one exercise so the editor never loses its form.
      if (draft.exercises.length <= 1) return state;
      const exercises = draft.exercises.filter(
        (exercise) => exercise.key !== action.exerciseKey,
      );
      if (exercises.length === draft.exercises.length) return state;
      return withDraft(state, { ...draft, exercises });
    }
    case "setExerciseName":
      return withDraft(
        state,
        updateExercise(draft, action.exerciseKey, (exercise) =>
          exercise.name === action.name ? exercise : { ...exercise, name: action.name },
        ),
      );
    case "setExerciseRestSeconds": {
      if (!Number.isFinite(action.restSeconds) || action.restSeconds < 0) return state;
      // Whole seconds keep the countdown and the persisted draft canonical.
      const restSeconds = Math.round(action.restSeconds);
      return withDraft(
        state,
        updateExercise(draft, action.exerciseKey, (exercise) =>
          exercise.restSeconds === restSeconds ? exercise : { ...exercise, restSeconds },
        ),
      );
    }

    // Sets.
    case "addSet": {
      const set = createDraftSet(allocateKey(draft));
      return withDraft(
        state,
        updateExercise(draft, action.exerciseKey, (exercise) => ({
          ...exercise,
          sets: [...exercise.sets, set],
        })),
      );
    }
    case "removeSet":
      return withDraft(
        state,
        updateExercise(draft, action.exerciseKey, (exercise) => {
          // Like exercises, an exercise always keeps one set; remove the whole
          // exercise instead of leaving an empty card behind.
          if (exercise.sets.length <= 1) return exercise;
          const sets = exercise.sets.filter((set) => set.key !== action.setKey);
          return sets.length === exercise.sets.length ? exercise : { ...exercise, sets };
        }),
      );
    case "setSetField":
      return withDraft(
        state,
        updateSet(draft, action.exerciseKey, action.setKey, (set) =>
          set[action.field] === action.value
            ? set
            : { ...set, [action.field]: action.value },
        ),
      );
    case "toggleSetDone": {
      // `done` only means something for a started session (plan §4.2 invariant).
      if (draft.timing === null) return state;
      // Stage 3 starts the per-exercise rest countdown from this transition;
      // `nowMs` is already part of the action for that.
      return withDraft(
        state,
        updateSet(draft, action.exerciseKey, action.setKey, (set) => ({
          ...set,
          done: !set.done,
        })),
      );
    }

    // Pain reports.
    case "addPain": {
      const pain = createDraftPain(allocateKey(draft));
      return withDraft(state, { ...draft, pain: [...draft.pain, pain] });
    }
    case "removePain": {
      const pain = draft.pain.filter((entry) => entry.key !== action.painKey);
      if (pain.length === draft.pain.length) return state;
      return withDraft(state, { ...draft, pain });
    }
    case "setPainField": {
      const index = draft.pain.findIndex((entry) => entry.key === action.painKey);
      if (index === -1) return state;
      const entry = draft.pain[index];
      if (entry[action.field] === action.value) return state;
      const pain: DraftPain[] = draft.pain.slice();
      pain[index] = { ...entry, [action.field]: action.value };
      return withDraft(state, { ...draft, pain });
    }

    // Persisted timing and transient rest: stage 3.
    case "startSession":
    case "pauseSession":
    case "resumeSession":
    case "finishSession":
    case "skipRest":
    case "adjustRest":
    case "tick":
      return state;

    default:
      return assertNever(action);
  }
}
