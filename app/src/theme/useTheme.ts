import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_THEME, getStoredTheme, setTheme, subscribeTheme } from "./theme.ts";
import { applyTheme } from "./theme.ts";
import type { ThemeName } from "./theme.ts";

/**
 * The current appearance preference plus a setter.
 *
 * The store is localStorage-backed rather than React state so every consumer
 * (and a fresh mount) observes the same value without a provider. The hook
 * re-applies the preference to the document root on mount, which covers
 * environments that do not run the pre-paint bootstrap (tests, embedded use).
 */
export function useTheme(): { theme: ThemeName; setTheme: (theme: ThemeName) => void } {
  const theme = useSyncExternalStore(subscribeTheme, getStoredTheme, () => DEFAULT_THEME);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return { theme, setTheme };
}
