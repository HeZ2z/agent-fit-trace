/**
 * Exercise library page (`/exercises`).
 *
 * Browse/search/detail live in the shared ExerciseLibrary component; this
 * screen only supplies the page heading and the logging handoff. The handoff is
 * router state, not storage: the editor owns the draft and appends the request
 * exactly once after it has hydrated the current draft.
 */

import { useNavigate } from "react-router-dom";
import { ExerciseLibrary } from "../components/ExerciseLibrary.tsx";
import type { ExerciseCatalogEntry } from "@agent-fit-trace/core";
import { useI18n } from "../i18n/useI18n.ts";

/** A fresh id distinguishes one user action from an intentional second add. */
function newLibraryAddRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function ExerciseLibraryScreen() {
  const { t } = useI18n();
  const navigate = useNavigate();

  function addToWorkout(entry: ExerciseCatalogEntry): void {
    navigate("/workout/new", {
      state: {
        libraryAdd: {
          id: newLibraryAddRequestId(),
          name: entry.name,
        },
      },
    });
  }

  return (
    <section data-screen="exercise-library" aria-labelledby="exercise-library-heading">
      <header className="screen-heading">
        <h1 id="exercise-library-heading">{t("Exercise Library")}</h1>
        <p>
          {t(
            "Browse the exercise catalog. The library is a reference for logging and analysis, not a training plan or technique guide.",
          )}
        </p>
        <p className="exercise-library-page-note">
          {t(
            "Free-text logging remains available. Choosing a catalog name only pre-fills an editable exercise; it never changes a saved record.",
          )}
        </p>
      </header>
      <ExerciseLibrary onAdd={addToWorkout} />
    </section>
  );
}
