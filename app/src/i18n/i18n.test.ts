import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  applyLanguage,
  formatMessage,
  getLanguage,
  getStoredLanguage,
  isLanguage,
  setLanguage,
  subscribeLanguage,
  translate,
} from "./i18n.ts";

describe("interface language", () => {
  beforeEach(() => {
    // A successful write clears the in-memory fallback; remove the value after
    // so default-language assertions still see empty storage.
    window.localStorage.clear();
    setLanguage("en");
    window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    document.documentElement.removeAttribute("data-lang");
    document.documentElement.lang = "en";
  });

  it("defaults to English when nothing is stored", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(getStoredLanguage()).toBe("en");
    expect(getLanguage()).toBe("en");
  });

  it("accepts only the supported display languages", () => {
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("zh")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });

  it("ignores an unknown stored language", () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr");
    expect(getStoredLanguage()).toBe("en");
  });

  it("persists, applies and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLanguage(listener);

    setLanguage("zh");

    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.getAttribute("data-lang")).toBe("zh");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setLanguage("en");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.getAttribute("data-lang")).toBe("en");
  });

  it("keeps the in-page choice when storage rejects the write", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      setLanguage("zh");
    } finally {
      setItem.mockRestore();
    }
    expect(document.documentElement.getAttribute("data-lang")).toBe("zh");
    expect(getLanguage()).toBe("zh");
    expect(getStoredLanguage()).toBe("en");
  });

  it("falls back to English when storage cannot be read", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      expect(getStoredLanguage()).toBe("en");
    } finally {
      getItem.mockRestore();
    }
  });

  it("applies a language without persisting it", () => {
    applyLanguage("zh");
    expect(document.documentElement.getAttribute("data-lang")).toBe("zh");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });
});

describe("message formatting", () => {
  it("leaves sources without params untouched", () => {
    expect(formatMessage("Sign out")).toBe("Sign out");
  });

  it("interpolates named placeholders", () => {
    expect(formatMessage("{count} workouts in history.", { count: 9 })).toBe(
      "9 workouts in history.",
    );
    expect(formatMessage("{from} – {to}", { from: "2026-01-01", to: "2026-02-01" })).toBe(
      "2026-01-01 – 2026-02-01",
    );
  });

  it("leaves unknown placeholders visibly untouched", () => {
    expect(formatMessage("Hello {name}", {})).toBe("Hello {name}");
  });

  it("returns the English source for English", () => {
    expect(translate("en", "Sign out")).toBe("Sign out");
  });

  it("falls back to English for an unmapped source", () => {
    expect(translate("zh", "A sentence that has no translation yet.")).toBe(
      "A sentence that has no translation yet.",
    );
  });
});
