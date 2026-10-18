/**
 * Appearance preference: Pixel or Glass.
 *
 * The choice is a per-browser display preference, deliberately separate from
 * workout data and from the signed-in identity: it never enters a record,
 * snapshot, export or content digest. It is persisted under its own key so a
 * later data reset cannot silently change the skin.
 *
 * The matching pre-paint bootstrap lives in `app/index.html` (so a stored
 * Glass preference paints before the bundle arrives); keep the key and the
 * accepted values in sync with this module.
 */

export type ThemeName = "pixel" | "glass";

export const THEME_STORAGE_KEY = "pi-fit-trace:theme:v1";
export const DEFAULT_THEME: ThemeName = "pixel";
export const THEME_NAMES: readonly ThemeName[] = ["pixel", "glass"];

export function isThemeName(value: unknown): value is ThemeName {
  return value === "pixel" || value === "glass";
}

/** localStorage is optional: privacy modes may throw on access. */
function themeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored preference, or Pixel when absent, unreadable or unrecognised. */
export function getStoredTheme(): ThemeName {
  try {
    const value = themeStorage()?.getItem(THEME_STORAGE_KEY);
    return isThemeName(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * A preference that could not be persisted still applies for the rest of this
 * page load. It wins over storage until a later write succeeds, so the
 * Appearance control cannot snap back to the old skin after a rejected write.
 */
let memoryFallback: ThemeName | null = null;

/** The effective preference for this page load. */
export function getTheme(): ThemeName {
  return memoryFallback ?? getStoredTheme();
}

/** Apply a theme to the document root; the stylesheet keys off `data-theme`. */
export function applyTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

const listeners = new Set<() => void>();

/** Subscribe to preference changes (used by `useTheme`). */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Persist and apply a preference. A write failure (quota, privacy mode) still
 * applies the skin for this page load; only durability across reloads is lost.
 */
export function setTheme(theme: ThemeName): void {
  const storage = themeStorage();
  if (storage === null) {
    memoryFallback = theme;
  } else {
    try {
      storage.setItem(THEME_STORAGE_KEY, theme);
      // Storage is authoritative again; a previous failed write no longer
      // needs to shadow it.
      memoryFallback = null;
    } catch {
      // Keep the in-page choice; a later reload falls back to the default.
      memoryFallback = theme;
    }
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
}
