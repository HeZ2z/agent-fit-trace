import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredTheme,
  isThemeName,
  setTheme,
  subscribeTheme,
} from "./theme.ts";

describe("theme preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to Pixel when nothing is stored", () => {
    expect(DEFAULT_THEME).toBe("pixel");
    expect(getStoredTheme()).toBe("pixel");
  });

  it("accepts only the two known skin names", () => {
    expect(isThemeName("pixel")).toBe(true);
    expect(isThemeName("glass")).toBe(true);
    expect(isThemeName("clean")).toBe(false);
    expect(isThemeName(null)).toBe(false);
    expect(isThemeName(undefined)).toBe(false);
  });

  it("ignores an unknown stored value instead of guessing a skin", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(getStoredTheme()).toBe("pixel");
  });

  it("reads a stored Glass preference", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "glass");
    expect(getStoredTheme()).toBe("glass");
  });

  it("persists, applies and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);

    setTheme("glass");

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("glass");
    expect(document.documentElement.getAttribute("data-theme")).toBe("glass");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setTheme("pixel");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("applies a theme without persisting it", () => {
    applyTheme("glass");
    expect(document.documentElement.getAttribute("data-theme")).toBe("glass");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("keeps the in-page choice when storage rejects the write", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      setTheme("glass");
    } finally {
      setItem.mockRestore();
    }
    expect(document.documentElement.getAttribute("data-theme")).toBe("glass");
    expect(getStoredTheme()).toBe("pixel");
  });

  it("falls back to Pixel when storage cannot be read", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      expect(getStoredTheme()).toBe("pixel");
    } finally {
      getItem.mockRestore();
    }
  });
});
