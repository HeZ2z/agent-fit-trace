import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIFFICULTIES,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_ITEMS,
  FORCES,
  MECHANICS,
  MOVEMENT_PATTERNS,
  MUSCLE_IDS,
} from "@agent-fit-trace/core";
import {
  MAX_EXERCISE_SUGGESTIONS,
  displayDifficulty,
  displayEquipmentCategory,
  displayEquipmentItem,
  displayForce,
  displayMechanics,
  displayMovementPattern,
  displayMuscle,
  humanizeExerciseMetadataId,
  searchCatalogExercises,
  searchExerciseSuggestions,
} from "../packages/fit-trace-i18n/src/index.ts";
import type { MovementPattern } from "@agent-fit-trace/core";
import type { AppLanguage } from "../packages/fit-trace-i18n/src/index.ts";

/**
 * Coverage for the user-facing exercise library's shared search and metadata
 * labels. The library page and the editor autocomplete must consume one search
 * implementation; these tests pin cross-language matching, determinism and the
 * controlled-vocabulary labels.
 */

const LANGUAGES: readonly AppLanguage[] = ["en", "zh"];

test("library search matches canonical English names and aliases", () => {
  const names = searchCatalogExercises("bench press", 500).map((entry) => entry.name);
  assert.ok(names.includes("Barbell Bench Press - Medium Grip"), JSON.stringify(names.slice(0, 5)));
});

test("library search matches Chinese display names and aliases", () => {
  const names = searchCatalogExercises("卧推", 500).map((entry) => entry.name);
  assert.ok(names.length > 0);
  assert.ok(names.includes("Barbell Bench Press - Medium Grip"), JSON.stringify(names.slice(0, 5)));
  assert.ok(names.includes("Dumbbell Bench Press"), JSON.stringify(names.slice(0, 8)));

  const squatNames = searchCatalogExercises("深蹲", 500).map((entry) => entry.name);
  assert.ok(squatNames.includes("Barbell Squat"), JSON.stringify(squatNames.slice(0, 8)));
  assert.ok(squatNames.includes("Bodyweight Squat"));
});

test("library search is deterministic and de-duplicated", () => {
  const first = searchCatalogExercises("press", 500);
  const second = searchCatalogExercises("press", 500);
  assert.deepEqual(
    first.map((entry) => entry.id),
    second.map((entry) => entry.id),
  );
  assert.equal(new Set(first.map((entry) => entry.id)).size, first.length);
  assert.equal(searchCatalogExercises("   ", 500).length, 0);
  assert.ok(searchCatalogExercises("press", 5).length <= 5);
});

test("the editor autocomplete keeps the shared ranking and its own cap", () => {
  const library = searchCatalogExercises("press", 500);
  const suggestions = searchExerciseSuggestions("press", "en", 500);
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.canonicalName),
    library.map((entry) => entry.name),
  );

  const capped = searchExerciseSuggestions("press", "en");
  assert.ok(capped.length <= MAX_EXERCISE_SUGGESTIONS);
  assert.deepEqual(
    capped.map((suggestion) => suggestion.canonicalName),
    library.slice(0, MAX_EXERCISE_SUGGESTIONS).map((entry) => entry.name),
  );
});

test("every controlled-vocabulary id has a non-empty label in both languages", () => {
  const check = <T extends string>(
    values: readonly T[],
    display: (language: AppLanguage, id: T) => string,
  ): void => {
    for (const value of values) {
      for (const language of LANGUAGES) {
        const label = display(language, value);
        assert.ok(label.trim().length > 0, `${language}:${value}`);
      }
    }
  };
  check(MOVEMENT_PATTERNS, displayMovementPattern);
  check(MUSCLE_IDS, displayMuscle);
  check(EQUIPMENT_CATEGORIES, displayEquipmentCategory);
  check(EQUIPMENT_ITEMS, displayEquipmentItem);
  check(DIFFICULTIES, displayDifficulty);
  check(MECHANICS, displayMechanics);
  check(FORCES, displayForce);
});

test("labels translate the frozen vocabulary and fall back for unknown ids", () => {
  assert.equal(displayMovementPattern("zh", "squat"), "深蹲");
  assert.equal(displayMovementPattern("en", "squat"), "Squat");
  assert.equal(displayMuscle("zh", "quadriceps"), "股四头肌");
  assert.equal(displayEquipmentCategory("zh", "barbell"), "杠铃");
  assert.equal(displayEquipmentItem("zh", "pull_up_bar"), "单杠");
  assert.equal(displayDifficulty("zh", "beginner"), "新手");
  assert.equal(displayMechanics("zh", "compound"), "复合动作");
  assert.equal(displayForce("zh", "push"), "推");

  assert.equal(humanizeExerciseMetadataId("future_pattern"), "Future Pattern");
  assert.equal(
    displayMovementPattern("en", "future_pattern" as MovementPattern),
    "Future Pattern",
  );
});
