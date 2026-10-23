/**
 * Pure reducer for the unified session editor.
 *
 * Owns two kinds of state:
 * - draft edits (add/remove/edit exercises, sets, pain, session fields), which
 *   are the persisted content;
 * - the timing + transient rest machine, wired together so a pause freezes a
 *   running rest and a resume rebuilds it without losing time.
 *
 * Every transition returns new objects and leaves its input state untouched, so
 * React can rely on reference equality to skip re-renders. All clock values are
 * injected through actions; nothing here reads a clock.
 */

import type { SessionAction } from "./actions.ts";
import { allocateKey, createDraftExercise, createDraftPain, createDraftSet } from "./draft.ts";
import {
  adjustRest as adjustRestTimer,
  clearRest,
  createSessionRuntime,
  freezeRest,
  restTargets,
  resumeRest,
  settleRest,
  startRest,
} from "./runtime.ts";
import { finishTiming, pauseTiming, resumeTiming, startTiming } from "./timing.ts";
import type {
  DraftExercise,
  DraftPain,
  DraftSet,
  SessionDraft,
  SessionState,
} from "./types.ts";

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
 * Unknown exercise/set/pain keys and out-of-phase timing actions are ignored
 * rather than throwing: the UI can dispatch a stale action after a delete, and
 * a no-op is safer than a crash in a reducer.
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
      // A rest belonging to the removed exercise is stale; clear it silently.
      const runtime = restTargets(state.runtime, action.exerciseKey)
        ? clearRest(state.runtime)
        : state.runtime;
      return { draft: { ...draft, exercises }, runtime };
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
    case "removeSet": {
      const nextDraft = updateExercise(draft, action.exerciseKey, (exercise) => {
        // Like exercises, an exercise always keeps one set; remove the whole
        // exercise instead of leaving an empty card behind.
        if (exercise.sets.length <= 1) return exercise;
        const sets = exercise.sets.filter((set) => set.key !== action.setKey);
        return sets.length === exercise.sets.length ? exercise : { ...exercise, sets };
      });
      if (nextDraft === draft) return state;
      // A rest belonging to the removed set is stale; clear it silently.
      const runtime = restTargets(state.runtime, action.exerciseKey, action.setKey)
        ? clearRest(state.runtime)
        : state.runtime;
      return { draft: nextDraft, runtime };
    }
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
      const timing = draft.timing;
      // `done` only means something for a started, unfinished session.
      if (timing === null || timing.endedAtMs !== null) return state;

      const exercise = draft.exercises.find((entry) => entry.key === action.exerciseKey);
      if (exercise === undefined) return state;
      const setIndex = exercise.sets.findIndex((set) => set.key === action.setKey);
      if (setIndex === -1) return state;
      const set = exercise.sets[setIndex];

      if (set.done) {
        // Unchecking clears only the rest this set started, without a cue.
        const nextDraft = updateSet(draft, action.exerciseKey, action.setKey, (current) => ({
          ...current,
          done: false,
        }));
        const runtime = restTargets(state.runtime, action.exerciseKey, action.setKey)
          ? clearRest(state.runtime)
          : state.runtime;
        return { draft: nextDraft, runtime };
      }

      let nextDraft: SessionDraft = {
        ...updateSet(draft, action.exerciseKey, action.setKey, (current) => ({
          ...current,
          done: true,
        })),
        timing: { ...timing, lastActiveAtMs: action.nowMs },
      };

      // Checking the last set of an exercise pre-fills the next one so a live
      // session keeps logging without an explicit add.
      if (setIndex === exercise.sets.length - 1) {
        const nextSet: DraftSet = {
          key: allocateKey(nextDraft),
          reps: set.reps,
          weight: set.weight,
          rpe: "",
          done: false,
        };
        nextDraft = updateExercise(nextDraft, action.exerciseKey, (current) => ({
          ...current,
          sets: [...current.sets, nextSet],
        }));
      }

      // Rest starts from the checked set's exercise, replacing any running rest.
      // A paused session keeps its frozen rest untouched.
      const runtime =
        timing.pausedAtMs === null && exercise.restSeconds > 0
          ? startRest(state.runtime, {
              exerciseKey: action.exerciseKey,
              setKey: action.setKey,
              restSeconds: exercise.restSeconds,
              nowMs: action.nowMs,
            })
          : state.runtime;
      return { draft: nextDraft, runtime };
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

    // Persisted timing. Starting is only possible from the untimed (editing)
    // phase; pause/resume/finish no-op when the timing is in the wrong phase.
    case "startSession": {
      if (draft.timing !== null) return state;
      return {
        draft: { ...draft, timing: startTiming(action.nowMs) },
        runtime: createSessionRuntime(),
      };
    }
    case "pauseSession": {
      const timing = draft.timing;
      if (timing === null) return state;
      const nextTiming = pauseTiming(timing, action.nowMs);
      if (nextTiming === null) return state;
      return {
        draft: { ...draft, timing: nextTiming },
        runtime: freezeRest(state.runtime, action.nowMs),
      };
    }
    case "resumeSession": {
      const timing = draft.timing;
      if (timing === null) return state;
      const nextTiming = resumeTiming(timing, action.nowMs);
      if (nextTiming === null) return state;
      return {
        draft: { ...draft, timing: nextTiming },
        runtime: resumeRest(state.runtime, action.nowMs),
      };
    }
    case "finishSession": {
      const timing = draft.timing;
      if (timing === null) return state;
      const nextTiming = finishTiming(timing, action.nowMs);
      if (nextTiming === null) return state;
      // Finishing drops a running rest without playing the rest-ended cue.
      return { draft: { ...draft, timing: nextTiming }, runtime: clearRest(state.runtime) };
    }

    // Transient rest.
    case "skipRest": {
      const runtime = clearRest(state.runtime);
      return runtime === state.runtime ? state : { ...state, runtime };
    }
    case "adjustRest": {
      const runtime = adjustRestTimer(state.runtime, action.deltaMs);
      return runtime === state.runtime ? state : { ...state, runtime };
    }
    case "tick": {
      const runtime = settleRest(state.runtime, action.nowMs);
      return runtime === state.runtime ? state : { ...state, runtime };
    }

    default:
      return assertNever(action);
  }
}
