/**
 * Render-time labels for the exercise catalog's controlled vocabulary.
 *
 * The catalog stores stable ids (`horizontal_push`, `lower back`, `ez_bar`);
 * the library shows human labels in the selected interface language. English
 * labels are title-cased here rather than stored in the catalog so the JSON
 * stays a machine vocabulary, and Chinese labels live in `./zh/taxonomy.ts`.
 *
 * Display only: these helpers never rewrite a stored value, and exercise
 * records contain no taxonomy ids.
 */

import type {
  Difficulty,
  EquipmentCategory,
  Force,
  Mechanics,
  MovementPattern,
  MuscleId,
} from "@agent-fit-trace/core";
import type { AppLanguage } from "./index.ts";
import {
  ZH_DIFFICULTIES,
  ZH_EQUIPMENT_CATEGORIES,
  ZH_FORCES,
  ZH_MECHANICS,
  ZH_MOVEMENT_PATTERNS,
  ZH_MUSCLES,
} from "./zh/taxonomy.ts";

const EN_MOVEMENT_PATTERNS: Record<MovementPattern, string> = {
  squat: "Squat",
  hinge: "Hinge",
  lunge: "Lunge",
  horizontal_push: "Horizontal push",
  vertical_push: "Vertical push",
  horizontal_pull: "Horizontal pull",
  vertical_pull: "Vertical pull",
  core: "Core",
  biceps: "Biceps",
  triceps: "Triceps",
  shoulders: "Shoulders",
  legs: "Legs",
  cardio: "Cardio",
  mobility: "Mobility",
};

const EN_MUSCLES: Record<MuscleId, string> = {
  abdominals: "Abdominals",
  abductors: "Abductors",
  adductors: "Adductors",
  biceps: "Biceps",
  calves: "Calves",
  chest: "Chest",
  forearms: "Forearms",
  glutes: "Glutes",
  hamstrings: "Hamstrings",
  "hip flexors": "Hip flexors",
  lats: "Lats",
  "lower back": "Lower back",
  "middle back": "Middle back",
  neck: "Neck",
  obliques: "Obliques",
  quadriceps: "Quadriceps",
  shoulders: "Shoulders",
  traps: "Traps",
  triceps: "Triceps",
};

const EN_EQUIPMENT_CATEGORIES: Record<EquipmentCategory, string> = {
  barbell: "Barbell",
  ez_bar: "EZ bar",
  dumbbell: "Dumbbell",
  kettlebell: "Kettlebell",
  machine: "Machine",
  cable: "Cable",
  bodyweight: "Bodyweight",
  band: "Band",
  cardio_machine: "Cardio machine",
  other: "Other",
};

const EN_DIFFICULTIES: Record<Difficulty, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  expert: "Expert",
};

const EN_MECHANICS: Record<Mechanics, string> = {
  compound: "Compound",
  isolation: "Isolation",
};

const EN_FORCES: Record<Force, string> = {
  push: "Push",
  pull: "Pull",
  static: "Static",
};

/** Human label for a movement pattern. */
export function displayMovementPattern(
  language: AppLanguage,
  value: MovementPattern,
): string {
  return language === "zh"
    ? ZH_MOVEMENT_PATTERNS[value]
    : EN_MOVEMENT_PATTERNS[value];
}

/** Human label for a muscle id. */
export function displayMuscle(language: AppLanguage, value: MuscleId): string {
  return language === "zh" ? ZH_MUSCLES[value] : EN_MUSCLES[value];
}

/** Human label for a resistance-equipment category. */
export function displayEquipmentCategory(
  language: AppLanguage,
  value: EquipmentCategory,
): string {
  return language === "zh"
    ? ZH_EQUIPMENT_CATEGORIES[value]
    : EN_EQUIPMENT_CATEGORIES[value];
}

/** Human label for a catalog difficulty. */
export function displayDifficulty(language: AppLanguage, value: Difficulty): string {
  return language === "zh" ? ZH_DIFFICULTIES[value] : EN_DIFFICULTIES[value];
}

/** Human label for a catalog mechanics value. */
export function displayMechanics(language: AppLanguage, value: Mechanics): string {
  return language === "zh" ? ZH_MECHANICS[value] : EN_MECHANICS[value];
}

/** Human label for a catalog force value. */
export function displayForce(language: AppLanguage, value: Force): string {
  return language === "zh" ? ZH_FORCES[value] : EN_FORCES[value];
}
