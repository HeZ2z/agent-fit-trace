/**
 * Exercise library page.
 *
 * The shared `ExerciseLibrary` browser is display-only; this screen owns the
 * one write it enables: adding the selected catalog entry to the owner's
 * stored session draft and opening the editor. It never saves a workout — the
 * editor still owns the explicit submit — and it leaves the stored draft
 * untouched when the draft cannot be read or written.
 *
 * A fresh draft already contains one blank exercise row. Filling that row's
 * name avoids an empty placeholder above the selected exercise; a draft with
 * any named or populated exercise gets a new row instead, so nothing the user
 * already entered is replaced.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ExerciseCatalogEntry } from "@agent-fit-trace/core";
import {
  createSessionDraft,
  createSessionRuntime,
  reduceSessionState,
  todayLocalDate,
} from "@agent-fit-trace/workout-session";
import type { SessionDraft } from "@agent-fit-trace/workout-session";
import { ExerciseLibrary } from "../components/ExerciseLibrary.tsx";
import { useI18n } from "../i18n/useI18n.ts";
import { useSessionDraft } from "../state/SessionDraftContext.tsx";

/**
 * True only for the single untouched row `createSessionDraft` starts with.
 *
 * A single unnamed row with logged sets is the user's data, not a placeholder:
 * reusing it would silently attach the selected catalog name to numbers the
 * user may have entered for another movement. Those drafts get a new row.
 */
function isUntouchedPlaceholder(draft: SessionDraft): boolean {
  if (draft.exercises.length !== 1) return false;
  const [exercise] = draft.exercises;
  if (exercise.name !== "" || exercise.sets.length !== 1) return false;
  const [set] = exercise.sets;
  return set.weight === "" && set.reps === "" && set.rpe === "" && !set.done;
}

export function ExerciseLibraryScreen() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const drafts = useSessionDraft();
  const [problem, setProblem] = useState<string | null>(null);

  const addToWorkout = useCallback(
    (entry: ExerciseCatalogEntry): void => {
      setProblem(null);

      let stored;
      try {
        stored = drafts.load();
      } catch {
        // A corrupt or unreadable draft must never be replaced here; the Log
        // screen owns discard/recovery, and overwriting would destroy it.
        setProblem(
          t("Could not read the stored workout draft. Open Log Workout to review it."),
        );
        return;
      }

      const base = stored ?? createSessionDraft(todayLocalDate());
      const state = { draft: base, runtime: createSessionRuntime() };
      const next = isUntouchedPlaceholder(base)
        ? reduceSessionState(state, {
            type: "setExerciseName",
            exerciseKey: base.exercises[0]!.key,
            name: entry.name,
          })
        : reduceSessionState(state, { type: "addExercise", name: entry.name });

      try {
        drafts.save(next.draft);
      } catch {
        setProblem(
          t("Could not add this exercise to the workout draft. Nothing was changed."),
        );
        return;
      }

      // Navigate only after the draft is persisted, so the editor always
      // bootstraps from the added exercise.
      navigate("/workout/new");
    },
    [drafts, navigate, t],
  );

  return (
    <section data-screen="exercises">
      <div className="screen-head">
        <div className="screen-head-main">
          <h1>{t("Exercise Library")}</h1>
          <p className="screen-lede">
            {t("Browse the exercise catalog and add an exercise to the current workout.")}
          </p>
        </div>
      </div>

      {problem !== null && (
        <div className="validation-summary" role="alert">
          <p>{problem}</p>
        </div>
      )}

      <ExerciseLibrary onSelect={addToWorkout} />
    </section>
  );
}
