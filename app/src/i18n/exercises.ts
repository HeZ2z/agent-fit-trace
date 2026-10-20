/**
 * App-side exercise display and autocomplete seam over the shared catalog.
 *
 * Stored and transported workout/analysis/plan payloads keep the canonical
 * English exercise name. This module is the single app seam that:
 *
 * - resolves a recorded (possibly alias or custom) name to a catalog entry and
 *   renders it in the selected language through `displayExerciseName`;
 * - re-exports the shared catalog suggestion search
 *   (`searchExerciseSuggestions`) the editor's autocomplete consumes. The search
 *   implementation lives in `@pi-fit-trace/i18n` so the web and React Native
 *   apps share one ranking and cannot drift apart.
 *
 * Render/search only: nothing here writes a record, and an unknown or custom
 * name is always passed through unchanged instead of being guessed at.
 */

import { resolveExerciseName } from "@pi-fit-trace/core";
import { displayExerciseName } from "@pi-fit-trace/i18n";
import type { AppLanguage } from "@pi-fit-trace/i18n";

export {
  MAX_EXERCISE_SUGGESTIONS,
  searchExerciseSuggestions,
} from "@pi-fit-trace/i18n";
export type { ExerciseSuggestion } from "@pi-fit-trace/i18n";

/**
 * Render a stored/imported exercise name in the selected language.
 *
 * The catalog-backed Chinese display name is used when the name resolves to a
 * catalog entry (canonical name or alias); custom names and English rendering
 * keep the exact stored spelling.
 */
export function displayStoredExerciseName(language: AppLanguage, name: string): string {
  if (language !== "zh") return name;
  const entry = resolveExerciseName(name);
  return displayExerciseName(language, entry === null ? name : entry.name);
}
