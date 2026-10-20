/**
 * Pure, deterministic lookup and suggestion helpers over the bundled v1
 * exercise catalog.
 *
 * Browser-safe by construction: no Node built-ins, no pi/typebox, and no clock,
 * randomness, or network access. Resolution is a pure function of the catalog
 * version bundled with the build; an unknown or ambiguous name resolves to
 * `null` and the caller keeps the raw user-typed name.
 */
import type {
  Difficulty,
  EquipmentCategory,
  ExerciseCatalogEntry,
  Mechanics,
  MovementPattern,
  MuscleId,
} from "./types.ts";
import { CATALOG_DATA } from "./catalog.generated.ts";

/** Default result cap for {@link searchExercises}. */
export const DEFAULT_EXERCISE_SEARCH_LIMIT = 20;

/**
 * Canonical lookup spelling for an exercise name: trim, Unicode NFKC, lowercase,
 * turn `_`/`-` into spaces, and collapse whitespace. The catalog generator uses
 * the same normalization for its uniqueness checks.
 */
export function normalizeExerciseName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface IndexedEntry {
  entry: ExerciseCatalogEntry;
  nameKey: string;
  aliasKeys: readonly string[];
}

const INDEXED_ENTRIES: readonly IndexedEntry[] = CATALOG_DATA.entries.map((entry) => ({
  entry,
  nameKey: normalizeExerciseName(entry.name),
  aliasKeys: entry.aliases.map(normalizeExerciseName),
}));

const ENTRIES_BY_ID = new Map<string, ExerciseCatalogEntry>();
/**
 * Normalized name/alias -> entry. `null` records an ambiguity: if two entries
 * ever claim the same normalized name, resolution refuses to guess.
 */
const ENTRIES_BY_NAME = new Map<string, ExerciseCatalogEntry | null>();

for (const indexed of INDEXED_ENTRIES) {
  ENTRIES_BY_ID.set(indexed.entry.id, indexed.entry);
  for (const key of [indexed.nameKey, ...indexed.aliasKeys]) {
    if (key === "") {
      continue;
    }
    const existing = ENTRIES_BY_NAME.get(key);
    if (existing === undefined) {
      ENTRIES_BY_NAME.set(key, indexed.entry);
    } else if (existing !== indexed.entry) {
      ENTRIES_BY_NAME.set(key, null);
    }
  }
}

/**
 * Resolve a recorded or typed name to one catalog entry.
 *
 * Accepts the canonical English name or any append-only alias, ignoring case,
 * Unicode width, underscores/hyphens, and surrounding/extra whitespace. Returns
 * `null` when the name is unknown or matches more than one entry; callers must
 * then keep the raw name (the catalog is a suggestion layer, never a gate).
 */
export function resolveExerciseName(name: string): ExerciseCatalogEntry | null {
  const key = normalizeExerciseName(name);
  if (key === "") {
    return null;
  }
  return ENTRIES_BY_NAME.get(key) ?? null;
}

/** Look up one catalog entry by its stable id; unknown ids return `null`. */
export function getExerciseById(id: string): ExerciseCatalogEntry | null {
  return ENTRIES_BY_ID.get(id) ?? null;
}

function hasWordPrefix(value: string, query: string): boolean {
  return value.split(" ").some((word) => word.startsWith(query));
}

/**
 * Match tiers: exact canonical name, canonical prefix, canonical word-prefix,
 * exact alias, alias prefix/word-prefix, canonical substring, alias substring.
 * Lower is a better match.
 */
function searchRank(indexed: IndexedEntry, query: string): number {
  const { nameKey, aliasKeys } = indexed;
  if (nameKey === query) {
    return 0;
  }
  if (nameKey.startsWith(query)) {
    return 1;
  }
  if (hasWordPrefix(nameKey, query)) {
    return 2;
  }
  if (aliasKeys.some((alias) => alias === query)) {
    return 3;
  }
  if (
    aliasKeys.some(
      (alias) => alias.startsWith(query) || hasWordPrefix(alias, query),
    )
  ) {
    return 4;
  }
  if (nameKey.includes(query)) {
    return 5;
  }
  if (aliasKeys.some((alias) => alias.includes(query))) {
    return 6;
  }
  return -1;
}

function compareEntries(
  left: ExerciseCatalogEntry,
  right: ExerciseCatalogEntry,
): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  if (left.id < right.id) {
    return -1;
  }
  return left.id > right.id ? 1 : 0;
}

/**
 * Deterministic autocomplete search over canonical names and aliases.
 *
 * Prefix and word-prefix matches rank before substring matches; ties are broken
 * by canonical name (case-insensitively) and then id. An empty or whitespace-only
 * query returns no results, and `limit` defaults to 20.
 */
export function searchExercises(
  query: string,
  limit: number = DEFAULT_EXERCISE_SEARCH_LIMIT,
): ExerciseCatalogEntry[] {
  const key = normalizeExerciseName(query);
  if (key === "") {
    return [];
  }
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) {
    return [];
  }

  const matches: Array<{ entry: ExerciseCatalogEntry; rank: number }> = [];
  for (const indexed of INDEXED_ENTRIES) {
    const rank = searchRank(indexed, key);
    if (rank >= 0) {
      matches.push({ entry: indexed.entry, rank });
    }
  }
  matches.sort(
    (left, right) => left.rank - right.rank || compareEntries(left.entry, right.entry),
  );
  return matches.slice(0, max).map((match) => match.entry);
}

/** Optional filters for {@link listExercises}; omitted fields match everything. */
export interface ExerciseListFilter {
  pattern?: MovementPattern;
  equipment?: EquipmentCategory;
  /** Matches primary or secondary muscles. */
  muscle?: MuscleId;
  difficulty?: Difficulty;
  mechanics?: Mechanics;
}

/**
 * List catalog entries matching every supplied filter, sorted by canonical name.
 * Returns a new array; the bundled data itself is frozen.
 */
export function listExercises(
  filter: ExerciseListFilter = {},
): ExerciseCatalogEntry[] {
  return CATALOG_DATA.entries
    .filter((entry) => {
      if (filter.pattern !== undefined && entry.pattern !== filter.pattern) {
        return false;
      }
      if (
        filter.equipment !== undefined &&
        entry.equipment.category !== filter.equipment
      ) {
        return false;
      }
      if (
        filter.muscle !== undefined &&
        !entry.primary_muscles.includes(filter.muscle) &&
        !entry.secondary_muscles.includes(filter.muscle)
      ) {
        return false;
      }
      if (filter.difficulty !== undefined && entry.difficulty !== filter.difficulty) {
        return false;
      }
      if (filter.mechanics !== undefined && entry.mechanics !== filter.mechanics) {
        return false;
      }
      return true;
    })
    .sort(compareEntries);
}
