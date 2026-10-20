/**
 * App-side exercise display and autocomplete through the shared catalog.
 *
 * Stored and transported workout/analysis/plan payloads keep the canonical
 * English exercise name. This module is the single app seam that:
 *
 * - resolves a recorded (possibly alias or custom) name to a catalog entry and
 *   renders it in the selected language through `displayExerciseName`;
 * - searches both the English catalog (`searchExercises`) and the generated
 *   Chinese display/alias tables for editor autocomplete, merging and
 *   de-duplicating the results by canonical name.
 *
 * Render/search only: nothing here writes a record, and an unknown or custom
 * name is always passed through unchanged instead of being guessed at.
 */

import { resolveExerciseName, searchExercises } from "@pi-fit-trace/core";
import {
  EXERCISE_ALIASES_ZH,
  EXERCISE_DISPLAY_NAMES_ZH,
  displayExerciseName,
} from "@pi-fit-trace/i18n";
import type { AppLanguage } from "@pi-fit-trace/i18n";

/** Default cap for editor autocomplete suggestions. */
export const MAX_EXERCISE_SUGGESTIONS = 8;

/** One autocomplete suggestion backed by a catalog entry. */
export interface ExerciseSuggestion {
  /** Canonical English name; selecting a suggestion writes exactly this. */
  canonicalName: string;
  /** Chinese display name (or the canonical name when no mapping exists). */
  displayName: string;
  /**
   * Option copy for the selected UI language: the Chinese display name plus the
   * canonical English name in Chinese (`杠铃卧推 · Barbell Bench Press - Medium
   * Grip`), or the canonical English name alone in English.
   */
  label: string;
}

/** Stable, locale-independent string ordering so search results are deterministic. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function suggestionFor(canonicalName: string, language: AppLanguage): ExerciseSuggestion {
  const displayName = EXERCISE_DISPLAY_NAMES_ZH[canonicalName] ?? canonicalName;
  const bilingual = displayName !== canonicalName;
  return {
    canonicalName,
    displayName,
    label:
      language === "zh" && bilingual
        ? `${displayName} · ${canonicalName}`
        : canonicalName,
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

/**
 * Deterministic autocomplete suggestions for the editor's exercise-name field.
 *
 * English text is matched by the catalog's own `searchExercises` ranking;
 * Chinese text is matched against the generated display/alias tables (display
 * name before alias, prefix before substring). Both sources are merged and
 * de-duplicated by canonical name, so a name reachable through an English alias
 * and a Chinese alias appears once.
 *
 * `label` follows the UI language: Chinese shows the display name plus the
 * canonical English name so the user can see what will be stored; English shows
 * the canonical English name alone. Selection always writes `canonicalName`
 * regardless of language.
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
