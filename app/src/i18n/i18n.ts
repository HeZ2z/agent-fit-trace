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
 * The matching pre-paint bootstrap lives in `app/index.html`; keep the storage
 * key and accepted values in sync with this module.
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

function languageStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored display language, or English when absent/unreadable/unknown. */
export function getStoredLanguage(): AppLanguage {
  try {
    const value = languageStorage()?.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(value) ? value : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/**
 * A language that could not be persisted still applies for this page load,
 * exactly like the appearance preference: the switcher must not snap back
 * after a rejected write.
 */
let memoryFallback: AppLanguage | null = null;

/** The effective display language for this page load. */
export function getLanguage(): AppLanguage {
  return memoryFallback ?? getStoredLanguage();
}

/** Set `<html lang>` and the `data-lang` hook the stylesheet reads. */
export function applyLanguage(language: AppLanguage): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.documentElement.setAttribute("data-lang", language);
}

const listeners = new Set<() => void>();

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Persist and apply a language. A write failure (quota, privacy mode) keeps
 * the in-page choice; only durability across reloads is lost.
 */
export function setLanguage(language: AppLanguage): void {
  const storage = languageStorage();
  if (storage === null) {
    memoryFallback = language;
  } else {
    try {
      storage.setItem(LANGUAGE_STORAGE_KEY, language);
      memoryFallback = null;
    } catch {
      memoryFallback = language;
    }
  }
  applyLanguage(language);
  for (const listener of listeners) listener();
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
