/**
 * Integrity of the catalog taxonomy's render-time labels.
 *
 * The catalog stores stable ids; the library renders human labels. Every id in
 * every controlled vocabulary must have a non-empty English label without the
 * raw underscore spelling and a Chinese label that actually contains Chinese.
 * A missing value here would surface as a raw id in the library.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIFFICULTIES,
  EQUIPMENT_CATEGORIES,
  FORCES,
  MECHANICS,
  MOVEMENT_PATTERNS,
  MUSCLE_IDS,
} from "@agent-fit-trace/core";
import {
  displayDifficulty,
  displayEquipmentCategory,
  displayForce,
  displayMechanics,
  displayMovementPattern,
  displayMuscle,
} from "../packages/fit-trace-i18n/src/index.ts";

const CJK = /[\u3400-\u9fff]/;

function assertLabels(english: string, chinese: string, value: string): void {
  assert.notEqual(english.trim(), "", `missing English label: ${value}`);
  assert.notEqual(chinese.trim(), "", `missing Chinese label: ${value}`);
  assert.doesNotMatch(english, /_/, `raw id leaked into the English label: ${value}`);
  assert.match(chinese, CJK, `Chinese label has no Chinese text: ${value}`);
}

test("every controlled-vocabulary id has an English and Chinese label", () => {
  for (const value of MOVEMENT_PATTERNS) {
    assertLabels(
      displayMovementPattern("en", value),
      displayMovementPattern("zh", value),
      value,
    );
  }
  for (const value of MUSCLE_IDS) {
    assertLabels(displayMuscle("en", value), displayMuscle("zh", value), value);
  }
  for (const value of EQUIPMENT_CATEGORIES) {
    assertLabels(
      displayEquipmentCategory("en", value),
      displayEquipmentCategory("zh", value),
      value,
    );
  }
  for (const value of DIFFICULTIES) {
    assertLabels(displayDifficulty("en", value), displayDifficulty("zh", value), value);
  }
  for (const value of MECHANICS) {
    assertLabels(displayMechanics("en", value), displayMechanics("zh", value), value);
  }
  for (const value of FORCES) {
    assertLabels(displayForce("en", value), displayForce("zh", value), value);
  }
});

test("representative labels match the catalog mapping document", () => {
  assert.equal(displayMovementPattern("en", "horizontal_push"), "Horizontal push");
  assert.equal(displayMovementPattern("zh", "horizontal_push"), "水平推");
  assert.equal(displayMuscle("en", "lower back"), "Lower back");
  assert.equal(displayMuscle("zh", "lower back"), "下背");
  assert.equal(displayEquipmentCategory("en", "ez_bar"), "EZ bar");
  assert.equal(displayEquipmentCategory("zh", "ez_bar"), "EZ 杆");
  assert.equal(displayDifficulty("en", "beginner"), "Beginner");
  assert.equal(displayDifficulty("zh", "beginner"), "新手");
  assert.equal(displayMechanics("zh", "compound"), "复合");
  assert.equal(displayForce("zh", "push"), "推");
});

test("taxonomy labels are deterministic and do not mutate the catalog vocabulary", () => {
  const first = MOVEMENT_PATTERNS.map((value) => displayMovementPattern("zh", value));
  const second = MOVEMENT_PATTERNS.map((value) => displayMovementPattern("zh", value));
  assert.deepEqual(second, first);
  assert.equal(new Set(first).size, first.length, "duplicate Chinese pattern labels");
});
