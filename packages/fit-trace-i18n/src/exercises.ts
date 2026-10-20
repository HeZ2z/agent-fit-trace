/**
 * Chinese display names for catalog-backed exercises.
 *
 * Stored and transported workout records keep the canonical English exercise
 * name. When the catalog resolves a recorded name to a catalog entry, the UI
 * asks this helper for the display name in the selected language; unknown and
 * user-authored custom names pass through unchanged. Chinese names are catalog
 * data keyed by canonical name (`./zh/exercises.ts`), not interface message
 * keys, so they are never merged into `ZH_MESSAGES`.
 *
 * Render-time only: no storage, DOM, Node built-ins, clock or randomness. The
 * helper is a pure function of the language, the canonical name and the
 * bundled catalog data.
 */

import type { AppLanguage } from "./index.ts";
import { EXERCISE_ALIASES_ZH, EXERCISE_DISPLAY_NAMES_ZH } from "./zh/exercises.ts";

export { EXERCISE_ALIASES_ZH, EXERCISE_DISPLAY_NAMES_ZH };

/**
 * Display name for a catalog-backed exercise.
 *
 * `canonicalName` must be the canonical English catalog name, exactly as it is
 * stored. Chinese returns the mapped display name; English, a missing entry,
 * an unknown name and a user-authored custom name all return `canonicalName`
 * unchanged.
 */
export function displayExerciseName(language: AppLanguage, canonicalName: string): string {
  if (language !== "zh") return canonicalName;
  if (!Object.prototype.hasOwnProperty.call(EXERCISE_DISPLAY_NAMES_ZH, canonicalName)) {
    return canonicalName;
  }
  return EXERCISE_DISPLAY_NAMES_ZH[canonicalName];
}
