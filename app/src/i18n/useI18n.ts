import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_LANGUAGE,
  applyLanguage,
  getLanguage,
  setLanguage,
  subscribeLanguage,
  translate,
} from "./i18n.ts";
import type { AppLanguage, MessageParams } from "./i18n.ts";

export interface I18n {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  /** Translate one English source string; Chinese falls back to the source. */
  t: (source: string, params?: MessageParams) => string;
}

/**
 * The current interface language plus the bound translator.
 *
 * Backed by the same localStorage store as the pre-paint bootstrap, so any
 * consumer (including a fresh mount) observes the same value without a
 * provider, and the document language/attributes are re-applied on mount.
 */
export function useI18n(): I18n {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, () => DEFAULT_LANGUAGE);
  useEffect(() => {
    applyLanguage(language);
  }, [language]);
  const t = useCallback(
    (source: string, params?: MessageParams) => translate(language, source, params),
    [language],
  );
  return { language, setLanguage, t };
}
