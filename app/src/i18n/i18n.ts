/**
 * The web app's interface-language store.
 *
 * The pure display layer (dictionary, formatting, translation) lives in
 * `@agent-fit-trace/i18n`. This module keeps only the browser-specific store:
 * localStorage persistence, the in-memory fallback and the
 * `<html lang>`/`data-lang` hooks, then re-exports the unchanged public API.
 *
 * The matching pre-paint bootstrap lives in `app/index.html`; keep the storage
 * key and accepted values in sync with this module.
 */

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  isLanguage,
} from "@agent-fit-trace/i18n";
import type { AppLanguage } from "@agent-fit-trace/i18n";

export {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  formatMessage,
  isLanguage,
  translate,
} from "@agent-fit-trace/i18n";
export type { AppLanguage, MessageParams } from "@agent-fit-trace/i18n";

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
