/**
 * Browser-safe vocabulary and shapes for the v1 exercise catalog.
 *
 * The catalog is a suggestion layer: v1 assists logging (exercise-name
 * autocomplete) and analysis normalization. Recent-exercise, equipment/muscle
 * candidate, and deterministic plan-suggestion helpers are future work. The
 * catalog never gates data entry, rewrites stored records, or makes the Agent
 * an authority on exercise facts.
 *
 * These types mirror `data/exercise-catalog/catalog.v1.json`. The committed
 * `catalog.generated.ts` is machine-generated from that file and is checked
 * against these types by `pnpm typecheck`; `scripts/build-exercise-catalog.mjs`
 * validates the source JSON against the same controlled vocabularies.
 */

/** Movement patterns covered by v1; every strength entry names exactly one. */
export const MOVEMENT_PATTERNS = [
  "squat",
  "hinge",
  "lunge",
  "horizontal_push",
  "vertical_push",
  "horizontal_pull",
  "vertical_pull",
  "core",
  "biceps",
  "triceps",
  "shoulders",
  "legs",
  "cardio",
  "mobility",
] as const;

export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

/** Resistance equipment category, independent of extra items such as a bench. */
export const EQUIPMENT_CATEGORIES = [
  "barbell",
  "ez_bar",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "bodyweight",
  "band",
  "cardio_machine",
  "other",
] as const;

export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

/** Additional equipment pieces beyond the resistance category. */
export const EQUIPMENT_ITEMS = [
  "ab_wheel",
  "bar",
  "bench",
  "bike",
  "box",
  "calf_machine",
  "dip_bars",
  "elliptical",
  "ghd_bench",
  "hack_squat_machine",
  "jump_rope",
  "leg_curl_machine",
  "leg_extension_machine",
  "leg_press_machine",
  "parallel_bars",
  "pull_up_bar",
  "reverse_hyper_machine",
  "rope",
  "rower",
  "smith_machine",
  "stair_climber",
  "stationary_bike",
  "suspension_trainer",
  "trap_bar",
  "treadmill",
  "v_bar",
] as const;

export type EquipmentItem = (typeof EQUIPMENT_ITEMS)[number];

/**
 * Coarse muscle ids inherited from free-exercise-db, plus the documented v1
 * taxonomy labels. This is a starting taxonomy, not a training-science review.
 */
export const MUSCLE_IDS = [
  "abdominals",
  "abductors",
  "adductors",
  "biceps",
  "calves",
  "chest",
  "forearms",
  "glutes",
  "hamstrings",
  "hip flexors",
  "lats",
  "lower back",
  "middle back",
  "neck",
  "obliques",
  "quadriceps",
  "shoulders",
  "traps",
  "triceps",
] as const;

export type MuscleId = (typeof MUSCLE_IDS)[number];

export const DIFFICULTIES = ["beginner", "intermediate", "expert"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

export const MECHANICS = ["compound", "isolation"] as const;

export type Mechanics = (typeof MECHANICS)[number];

export const FORCES = ["push", "pull", "static"] as const;

export type Force = (typeof FORCES)[number];

/** Seed-content review state; `template` is still a draft, `rewrite` is known-misleading. */
export const CONTENT_STATUSES = ["template", "rewrite"] as const;

export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** `seed` keeps the source name; `renamed` records an accepted canonical rename. */
export const NAME_STATUSES = ["seed", "renamed"] as const;

export type NameStatus = (typeof NAME_STATUSES)[number];

/** Provenance for one pinned upstream data source. */
export interface ExerciseCatalogSource {
  id: string;
  repo: string;
  commit: string;
  license: string;
}

/** Per-entry references into the two Unlicense upstream snapshots. */
export interface ExerciseCatalogEntrySource {
  free_exercise_db: string;
  guide_page: string;
}

/** Resistance category plus any extra equipment an entry needs. */
export interface ExerciseEquipment {
  category: EquipmentCategory;
  items: readonly EquipmentItem[];
}

/** One canonical catalog entry, keyed by an append-only ASCII snake_case id. */
export interface ExerciseCatalogEntry {
  id: string;
  /**
   * Canonical English catalog name. Selecting a suggestion writes this
   * spelling into a workout record; free-text names are stored as authored.
   */
  name: string;
  /** Additional English lookup names; append-only, case/space-insensitive. */
  aliases: readonly string[];
  pattern: MovementPattern;
  primary_muscles: readonly MuscleId[];
  secondary_muscles: readonly MuscleId[];
  equipment: ExerciseEquipment;
  difficulty: Difficulty;
  /** `null` where the source does not classify the lift. */
  mechanics: Mechanics | null;
  /** `null` where the source does not classify the lift. */
  force: Force | null;
  content_status: ContentStatus;
  name_status: NameStatus;
  /**
   * Related variant entry ids (ADR 0003 keeps `chest_dip` and `triceps_dip`
   * separate and links them here). Symmetric for the dip pair; absent when an
   * entry has no variants, and never present as an empty array.
   */
  variant_of?: readonly string[];
  source: ExerciseCatalogEntrySource;
}

/** The versioned, offline catalog document bundled with the shared core. */
export interface ExerciseCatalog {
  schema: "fit-trace-exercise-catalog";
  version: number;
  /** Source snapshot date (YYYY-MM-DD), fixed data — not a generation clock. */
  generated: string;
  sources: readonly ExerciseCatalogSource[];
  entries: readonly ExerciseCatalogEntry[];
}
