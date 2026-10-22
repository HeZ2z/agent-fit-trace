import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  translate,
  type AppLanguage,
  type MessageParams,
} from "@agent-fit-trace/i18n";

import {
  getLanguage,
  hydrateLanguage,
  setLanguage,
  subscribeLanguage,
} from "./language";

export interface I18n {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  /** Translate one English source string; Chinese falls back to the source. */
  t: (source: string, params?: MessageParams) => string;
}

const I18nContext = createContext<I18n | null>(null);

/**
 * Owns the language store subscription and the one-time AsyncStorage
 * hydration. The value changes with the language, so every consumer of
 * `useI18n` (screens, tab bar) re-renders together.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);

  useEffect(() => {
    void hydrateLanguage();
  }, []);

  const value = useMemo<I18n>(
    () => ({
      language,
      setLanguage,
      t: (source, params) => translate(language, source, params),
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error("useI18n must be used inside an I18nProvider");
  }
  return value;
}
