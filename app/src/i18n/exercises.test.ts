import { describe, expect, it } from "vitest";
import {
  displayStoredExerciseName as sharedDisplayStoredExerciseName,
  searchExerciseSuggestions as sharedSearchExerciseSuggestions,
} from "@pi-fit-trace/i18n";
import {
  displayStoredExerciseName,
  searchExerciseSuggestions,
} from "./exercises.ts";

describe("app exercise display helper", () => {
  it("re-exports the shared i18n display helper instead of reimplementing it", () => {
    expect(displayStoredExerciseName).toBe(sharedDisplayStoredExerciseName);
  });

  it("shows the catalog Chinese display name for a stored canonical name", () => {
    expect(displayStoredExerciseName("zh", "Barbell Bench Press - Medium Grip")).toBe(
      "杠铃卧推",
    );
    expect(displayStoredExerciseName("zh", "Barbell Squat")).toBe("杠铃深蹲");
  });

  it("resolves stored aliases to their catalog entry before localization", () => {
    expect(displayStoredExerciseName("zh", "Bench press")).toBe("杠铃卧推");
    expect(displayStoredExerciseName("zh", "bench_press")).toBe("杠铃卧推");
    expect(displayStoredExerciseName("zh", "Deadlift")).toBe("杠铃硬拉");
  });

  it("passes unresolved and custom names through unchanged", () => {
    expect(displayStoredExerciseName("zh", "My Custom Lift")).toBe("My Custom Lift");
    expect(displayStoredExerciseName("zh", "我的自定义动作")).toBe("我的自定义动作");
    expect(displayStoredExerciseName("zh", "")).toBe("");
  });

  it("keeps the exact English spelling untouched", () => {
    // English rendering must not normalize a stored alias to its canonical name.
    expect(displayStoredExerciseName("en", "Bench press")).toBe("Bench press");
    expect(displayStoredExerciseName("en", "Barbell Bench Press - Medium Grip")).toBe(
      "Barbell Bench Press - Medium Grip",
    );
  });
});

describe("app exercise autocomplete suggestions", () => {
  const BENCH_PRESS = "Barbell Bench Press - Medium Grip";

  it("re-exports the shared i18n search instead of reimplementing it", () => {
    expect(searchExerciseSuggestions).toBe(sharedSearchExerciseSuggestions);
  });

  it("returns no suggestions for an empty query", () => {
    expect(searchExerciseSuggestions("", "en")).toEqual([]);
    expect(searchExerciseSuggestions("   ", "zh")).toEqual([]);
  });

  it("filters English queries through the catalog search with English labels", () => {
    const suggestions = searchExerciseSuggestions("bench", "en");
    expect(suggestions.length).toBeGreaterThan(0);
    // Every suggestion is a catalog entry whose canonical or alias name matches.
    for (const suggestion of suggestions) {
      expect(suggestion.canonicalName.toLowerCase()).toContain("bench");
      expect(suggestion.displayName).not.toBe("");
      // English UI shows exactly the canonical English name: no Chinese, no `·`.
      expect(suggestion.label).toBe(suggestion.canonicalName);
    }
    const benchPress = suggestions.find(
      (suggestion) => suggestion.canonicalName === BENCH_PRESS,
    );
    expect(benchPress).toBeDefined();
    expect(benchPress?.label).toBe(BENCH_PRESS);
  });

  it("shows only the Chinese display name as the Chinese label", () => {
    const suggestions = searchExerciseSuggestions("卧推", "zh");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toEqual({
      canonicalName: BENCH_PRESS,
      displayName: "杠铃卧推",
      label: "杠铃卧推",
    });
    for (const suggestion of suggestions) {
      // The UI-language label is the display name, never the canonical name.
      expect(suggestion.label).toBe(suggestion.displayName);
      expect(suggestion.label).not.toContain("·");
    }
    // Every option is unique by canonical name, even though the query matches
    // both a display name and an alias for some entries.
    const canonicalNames = suggestions.map((suggestion) => suggestion.canonicalName);
    expect(new Set(canonicalNames).size).toBe(canonicalNames.length);
    expect(suggestions.map((suggestion) => suggestion.displayName)).toContain("哑铃卧推");
  });

  it("follows the UI language for the same catalog entry", () => {
    const english = searchExerciseSuggestions("bench", "en").find(
      (suggestion) => suggestion.canonicalName === BENCH_PRESS,
    );
    const chinese = searchExerciseSuggestions("bench", "zh").find(
      (suggestion) => suggestion.canonicalName === BENCH_PRESS,
    );
    expect(english?.label).toBe(BENCH_PRESS);
    expect(chinese?.label).toBe("杠铃卧推");
    // Only the label changes; selection always writes the canonical English name.
    expect(chinese?.canonicalName).toBe(english?.canonicalName);
  });

  it("matches a Chinese-only alias", () => {
    const suggestions = searchExerciseSuggestions("倒蹬", "zh");
    expect(suggestions[0]?.canonicalName).toBe("Leg Press");
    // The stored canonical English name stays available for selection.
    expect(suggestions[0]?.label).toBe("腿举");
  });

  it("respects the suggestion limit", () => {
    expect(searchExerciseSuggestions("press", "en", 3)).toHaveLength(3);
    expect(searchExerciseSuggestions("卧推", "zh", 2)).toHaveLength(2);
    expect(searchExerciseSuggestions("press", "en", 0)).toEqual([]);
  });
});
