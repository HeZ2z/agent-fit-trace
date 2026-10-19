/**
 * The mobile app's interface-language store.
 *
 * The pure display layer (dictionary, formatting, translation) lives in
 * `@pi-fit-trace/i18n`. This module keeps only the React Native-specific
 * store: AsyncStorage persistence, the in-memory fallback and the
 * system-language default read from expo-localization.
 *
 * The web equivalent is `app/src/i18n/i18n.ts`; both share
 * LANGUAGE_STORAGE_KEY, so a future hand-off can reuse the same value without
 * touching stored history. There is deliberately no DOM/localStorage access
 * here.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  isLanguage,
  type AppLanguage,
} from "@pi-fit-trace/i18n";
import { getLocales } from "expo-localization";

export { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, isLanguage };
export type { AppLanguage };

/**
 * Resolve the display language from the device's preferred locales.
 *
 * Chinese locales (`zh`, `zh-Hans`, `zh-CN`, …) select Chinese; every other
 * locale keeps English. expo-localization is native code, so treat a missing
 * module (tests, bare Node) as English instead of crashing.
 */
export function getSystemLanguage(): AppLanguage {
  try {
    const [primary] = getLocales();
    const languageCode = primary?.languageCode?.toLowerCase() ?? "";
    const languageTag = primary?.languageTag?.toLowerCase() ?? "";
    return languageCode === "zh" || languageTag === "zh" || languageTag.startsWith("zh-")
      ? "zh"
      : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/**
 * The in-memory language starts as the system default. A stored explicit
 * choice replaces it once AsyncStorage answers; a first launch never needs to
 * wait for that read before rendering.
 */
let currentLanguage: AppLanguage = getSystemLanguage();
let explicitUserChoice = false;
let hydration: Promise<void> | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The effective display language for this app launch. */
export function getLanguage(): AppLanguage {
  return currentLanguage;
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stored explicit choice, or null when absent/unreadable/unknown. */
async function readStoredLanguage(): Promise<AppLanguage | null> {
  try {
    const stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : null;
  } catch {
    // Fail soft: the system-language default stays in effect.
    return null;
  }
}

/**
 * Persist an explicit choice. Writes are best-effort: a rejected write keeps
 * the in-memory choice for this launch, exactly like the web store.
 */
function persistLanguage(language: AppLanguage): void {
  try {
    void AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language).catch(() => {
      // Durability is lost; the selected language still applies this launch.
    });
  } catch {
    // The native storage module can be unavailable (tests, web fallback, ...).
  }
}

/**
 * Persist and apply an explicit language choice. Only user actions call this;
 * hydrating a stored value never writes anything back.
 */
export function setLanguage(language: AppLanguage): void {
  explicitUserChoice = true;
  currentLanguage = language;
  persistLanguage(language);
  notify();
}

/**
 * Load the stored explicit choice once. The system default is never written,
 * and a tap made while storage was still loading always wins.
 */
export function hydrateLanguage(): Promise<void> {
  hydration ??= (async () => {
    const stored = await readStoredLanguage();
    if (stored !== null && !explicitUserChoice && stored !== currentLanguage) {
      currentLanguage = stored;
      notify();
    }
  })();
  return hydration;
}
