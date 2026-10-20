/**
 * Interface language: a display layer over canonical English data.
 *
 * English is the source language. Every message is requested by its exact
 * English string; a Chinese entry maps that source to a translation and a
 * missing entry degrades to English instead of showing a raw key. Stored
 * records, snapshots, exports and generated payloads stay canonical English —
 * translation happens only while rendering, so a content digest never depends
 * on who is reading it.
 *
 * This module is the pure, environment-free core: it takes the language
 * explicitly and touches neither storage nor the DOM. The web app keeps the
 * localStorage/<html> store in `app/src/i18n/i18n.ts`; the matching pre-paint
 * bootstrap lives in `app/index.html` and shares LANGUAGE_STORAGE_KEY with it.
 *
 * Catalog-backed exercise names are the one workout-content exception: they are
 * translated at render time by canonical English name through
 * `displayExerciseName`/`displayStoredExerciseName`, while custom names, notes,
 * ids and dates still pass through unchanged. The matching autocomplete search
 * (`searchExerciseSuggestions`) is shared from the same catalog layer so the web
 * and React Native apps do not each grow their own copy; its option labels
 * follow the UI language while a selection always writes the canonical English
 * name, so displayed copy never becomes stored data.
 */

import { ZH_MESSAGES } from "./zh/index.ts";

export type AppLanguage = "en" | "zh";

export const LANGUAGE_STORAGE_KEY = "pi-fit-trace:lang:v1";
export const DEFAULT_LANGUAGE: AppLanguage = "en";
export const LANGUAGES: readonly AppLanguage[] = ["en", "zh"];

export type MessageParams = Record<string, string | number>;

export function isLanguage(value: unknown): value is AppLanguage {
  return value === "en" || value === "zh";
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Replace `{name}` placeholders; unknown placeholders are left untouched. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

/**
 * Translate one source string. English is returned as-is (after interpolation);
 * Chinese falls back to the English source for unmapped entries.
 */
export function translate(
  language: AppLanguage,
  source: string,
  params?: MessageParams,
): string {
  if (language === "en") return formatMessage(source, params);
  const template = ZH_MESSAGES[source] ?? source;
  return formatMessage(template, params);
}

export { ZH_MESSAGES };

export {
  EXERCISE_ALIASES_ZH,
  EXERCISE_DISPLAY_NAMES_ZH,
  MAX_EXERCISE_SUGGESTIONS,
  displayExerciseName,
  displayStoredExerciseName,
  searchExerciseSuggestions,
} from "./exercises.ts";
export type { ExerciseSuggestion } from "./exercises.ts";
