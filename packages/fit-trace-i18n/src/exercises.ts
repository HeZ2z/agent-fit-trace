/**
 * Render-time Chinese display names and autocomplete suggestions for
 * catalog-backed exercises.
 *
 * Stored and transported workout records keep the canonical English exercise
 * name. When the catalog resolves a recorded name to a catalog entry, the UI
 * asks this module for the display name in the selected language; unknown and
 * user-authored custom names pass through unchanged. Chinese names are catalog
 * data keyed by canonical name (`./zh/exercises.ts`), not interface message
 * keys, so they are never merged into `ZH_MESSAGES`.
 *
 * The suggestion helper is the one search implementation shared by the web app
 * and the React Native app: it merges the core catalog's English search with the
 * generated Chinese display/alias tables and returns a de-duplicated list in a
 * deterministic order. Option copy follows the UI language (Chinese display
 * name in Chinese, canonical English name in English); selecting a suggestion
 * always writes the canonical English name.
 *
 * Render-time only: no storage, DOM, Node built-ins, clock or randomness. Both
 * helpers are pure functions of the language, the input text and the bundled
 * catalog data.
 */

import { resolveExerciseName, searchExercises } from "@pi-fit-trace/core";
import type { AppLanguage } from "./index.ts";
import { EXERCISE_ALIASES_ZH, EXERCISE_DISPLAY_NAMES_ZH } from "./zh/exercises.ts";

export { EXERCISE_ALIASES_ZH, EXERCISE_DISPLAY_NAMES_ZH };

/** Default cap for editor autocomplete suggestions. */
export const MAX_EXERCISE_SUGGESTIONS = 8;

/** One autocomplete suggestion backed by a catalog entry. */
export interface ExerciseSuggestion {
  /** Canonical English name; selecting a suggestion writes exactly this. */
  canonicalName: string;
  /** Chinese display name (or the canonical name when no mapping exists). */
  displayName: string;
  /**
   * Option copy for the selected UI language: the Chinese display name in
   * Chinese (`杠铃卧推`), or the canonical English name in English. Selecting a
   * suggestion always writes `canonicalName`, never the label.
   */
  label: string;
}

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

/**
 * Display a stored (or imported) exercise name in the selected language.
 *
 * The stored spelling stays canonical English. In Chinese the name is resolved
 * through the catalog — canonical name or alias — and rendered with
 * `displayExerciseName`; unknown and user-authored custom names pass through
 * unchanged. English returns the stored spelling exactly, without normalizing
 * an alias.
 */
export function displayStoredExerciseName(language: AppLanguage, name: string): string {
  if (language !== "zh") return name;
  const entry = resolveExerciseName(name);
  return displayExerciseName(language, entry === null ? name : entry.name);
}

/** Stable, locale-independent string ordering so search results are deterministic. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function suggestionFor(canonicalName: string, language: AppLanguage): ExerciseSuggestion {
  const displayName = EXERCISE_DISPLAY_NAMES_ZH[canonicalName] ?? canonicalName;
  return {
    canonicalName,
    displayName,
    // Label is UI-language copy only; the stored value lives in `canonicalName`
    // so the two can never be confused.
    label: language === "zh" ? displayName : canonicalName,
  };
}

/** All canonical names with a generated Chinese display name, in catalog order. */
const CHINESE_DISPLAY_NAMES: readonly string[] = Object.keys(EXERCISE_DISPLAY_NAMES_ZH);

/**
 * Rank one catalog entry against a Chinese query using its display name and
 * aliases. Lower is better; `null` means no match.
 */
function chineseMatchRank(normalizedQuery: string, canonicalName: string): number | null {
  const displayName = EXERCISE_DISPLAY_NAMES_ZH[canonicalName];
  if (displayName === undefined) return null;
  const display = displayName.toLowerCase();
  const aliases = (EXERCISE_ALIASES_ZH[canonicalName] ?? []).map((alias) =>
    alias.toLowerCase(),
  );

  // The display name leads; an exact alias is the user's own spelling.
  if (display === normalizedQuery) return 0;
  if (display.startsWith(normalizedQuery)) return 1;
  if (aliases.includes(normalizedQuery)) return 2;
  if (display.includes(normalizedQuery)) return 3;
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) return 4;
  if (aliases.some((alias) => alias.includes(normalizedQuery))) return 5;
  return null;
}

/**
 * Deterministic autocomplete suggestions for the editor's exercise-name field.
 *
 * English text is matched by the catalog's own `searchExercises` ranking;
 * Chinese text is matched against the generated display/alias tables (display
 * name before alias, prefix before substring). Both sources are merged and
 * de-duplicated by canonical name, so a name reachable through an English alias
 * and a Chinese alias appears once.
 *
 * `label` follows the UI language exactly: Chinese shows only the Chinese
 * display name, English shows only the canonical English name. Selection always
 * writes `canonicalName` regardless of language, so the stored value is never
 * the localized label.
 */
export function searchExerciseSuggestions(
  query: string,
  language: AppLanguage,
  limit: number = MAX_EXERCISE_SUGGESTIONS,
): ExerciseSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === "") return [];
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];

  const suggestions: ExerciseSuggestion[] = [];
  const seen = new Set<string>();
  const add = (canonicalName: string): void => {
    if (suggestions.length >= max || seen.has(canonicalName)) return;
    seen.add(canonicalName);
    suggestions.push(suggestionFor(canonicalName, language));
  };

  // Canonical-name and English-alias search first: the catalog owns this ranking.
  for (const entry of searchExercises(normalizedQuery, max)) {
    add(entry.name);
  }

  // Chinese display-name/alias matches, merged after and de-duplicated.
  const chineseMatches: Array<{
    rank: number;
    canonicalName: string;
    displayName: string;
  }> = [];
  for (const canonicalName of CHINESE_DISPLAY_NAMES) {
    const rank = chineseMatchRank(normalizedQuery, canonicalName);
    if (rank === null) continue;
    chineseMatches.push({
      rank,
      canonicalName,
      displayName: EXERCISE_DISPLAY_NAMES_ZH[canonicalName],
    });
  }
  chineseMatches.sort(
    (left, right) =>
      left.rank - right.rank ||
      compareText(left.displayName, right.displayName) ||
      compareText(left.canonicalName, right.canonicalName),
  );
  for (const match of chineseMatches) {
    add(match.canonicalName);
  }

  return suggestions;
}
