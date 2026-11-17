/**
 * App-side exercise display, search and taxonomy seam over the shared catalog.
 *
 * Stored and transported workout/analysis/plan payloads keep the canonical
 * English exercise name. This module is the single app seam that re-exports the
 * shared catalog helpers from `@agent-fit-trace/i18n`:
 *
 * - `displayStoredExerciseName` resolves a recorded (possibly alias or custom)
 *   name to a catalog entry and renders it in the selected language, while the
 *   stored spelling stays canonical English;
 * - `searchExerciseSuggestions` is the editor autocomplete's shared ranking, so
 *   the web and React Native apps cannot drift apart;
 * - `searchExerciseLibrary` is the uncapped bilingual library search and
 *   `display*` helpers label the catalog's controlled vocabulary.
 *
 * Render/search only: nothing here writes a record, and an unknown or custom
 * name is always passed through unchanged instead of being guessed at. The
 * helpers live in the i18n package (not here) so both apps share exactly one
 * implementation.
 */

export {
  MAX_EXERCISE_SUGGESTIONS,
  displayDifficulty,
  displayEquipmentCategory,
  displayExerciseName,
  displayForce,
  displayMechanics,
  displayMovementPattern,
  displayMuscle,
  displayStoredExerciseName,
  searchExerciseLibrary,
  searchExerciseSuggestions,
} from "@agent-fit-trace/i18n";
export type { ExerciseSuggestion } from "@agent-fit-trace/i18n";
