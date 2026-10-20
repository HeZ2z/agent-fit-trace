#!/usr/bin/env node
/**
 * Build the shared-core exercise catalog from the vendored v1 source JSON.
 *
 * The generated TypeScript is committed so the browser-safe core never reads the
 * filesystem or the network at runtime. Output is deterministic: the source JSON
 * is the only input, and no clock, randomness, or network access participates.
 *
 * Usage:
 *   node scripts/build-exercise-catalog.mjs                # validate and write
 *   node scripts/build-exercise-catalog.mjs --check        # validate; fail if committed output is stale
 *   node scripts/build-exercise-catalog.mjs --check --catalog <path>
 *
 * `--catalog` is a validation-only hook for tests and maintenance; it requires
 * `--check` so an alternate file can never overwrite the committed catalog.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_CATALOG_PATH = resolve(
  REPO_ROOT,
  "data/exercise-catalog/catalog.v1.json",
);
const DEFAULT_OUTPUT_PATH = resolve(
  REPO_ROOT,
  "packages/fit-trace-core/src/exercises/catalog.generated.ts",
);

export const EXPECTED_SCHEMA = "fit-trace-exercise-catalog";
export const EXPECTED_VERSION = 1;
export const EXPECTED_ENTRY_COUNT = 194;

// Keep these vocabularies identical to packages/fit-trace-core/src/exercises/types.ts.
// `pnpm typecheck` catches drift in the generated data; the generator rejects it here.
const MOVEMENT_PATTERNS = [
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
];
const EQUIPMENT_CATEGORIES = [
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
];
const EQUIPMENT_ITEMS = [
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
];
const MUSCLE_IDS = [
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
];
const DIFFICULTIES = ["beginner", "intermediate", "expert"];
const MECHANICS = ["compound", "isolation"];
const FORCES = ["push", "pull", "static"];
const CONTENT_STATUSES = ["template", "rewrite"];
const NAME_STATUSES = ["seed", "renamed"];
const LICENSES = ["Unlicense", "MIT"];

const ROOT_KEYS = ["schema", "version", "generated", "sources", "entries"];
const SOURCE_KEYS = ["id", "repo", "commit", "license"];
const ENTRY_KEYS = [
  "id",
  "name",
  "aliases",
  "pattern",
  "primary_muscles",
  "secondary_muscles",
  "equipment",
  "difficulty",
  "mechanics",
  "force",
  "content_status",
  "name_status",
  "variant_of",
  "source",
];
const ENTRY_SOURCE_KEYS = ["free_exercise_db", "guide_page"];
const EQUIPMENT_KEYS = ["category", "items"];

const ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PATTERN = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GUIDE_PAGE_PATTERN = /^exercises\/[^/]+\/[^/]+\.md$/;

const USAGE = `Usage:
  node scripts/build-exercise-catalog.mjs                validate and write the generated TypeScript
  node scripts/build-exercise-catalog.mjs --check        validate; fail if the committed output is stale
  node scripts/build-exercise-catalog.mjs --check --catalog <path>
                                                         validate an alternate source file (tests/maintenance)`;

/** Canonical spelling used for uniqueness checks; must mirror the shared resolver. */
export function normalizeName(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deterministic JSON with recursively sorted keys and dropped `undefined` values. */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 over the canonical form of the whole catalog document. */
export function computeCatalogDigest(catalog) {
  return createHash("sha256").update(stableStringify(catalog), "utf8").digest("hex");
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function checkUnknownKeys(errors, path, value, allowedKeys) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${path}.${key}: unknown field`);
    }
  }
}

function assertString(errors, path, value, { pattern, allowed, nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${path}: expected a string; got ${JSON.stringify(value)}`);
    return;
  }
  if (value.trim() === "") {
    errors.push(`${path}: must not be empty`);
    return;
  }
  if (value !== value.trim()) {
    errors.push(`${path}: must not have leading or trailing whitespace`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${pattern}`);
  }
  if (allowed !== undefined && !allowed.includes(value)) {
    errors.push(
      `${path}: expected one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
}

function normalizeAndRegisterName(errors, registry, path, value) {
  if (typeof value !== "string") {
    errors.push(`${path}: expected a string; got ${JSON.stringify(value)}`);
    return;
  }
  if (value.trim() === "") {
    errors.push(`${path}: must not be empty`);
    return;
  }
  if (value !== value.trim()) {
    errors.push(`${path}: must not have leading or trailing whitespace`);
  }
  const key = normalizeName(value);
  const previous = registry.get(key);
  if (previous !== undefined) {
    errors.push(
      `${path}: ${JSON.stringify(value)} collides with ${previous} after name normalization (${JSON.stringify(key)})`,
    );
    return;
  }
  registry.set(key, path);
}

function validateSources(errors, sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push("catalog.sources: expected a non-empty array");
    return;
  }
  const seenIds = new Map();
  sources.forEach((source, index) => {
    const path = `catalog.sources[${index}]`;
    if (!isPlainObject(source)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    checkUnknownKeys(errors, path, source, SOURCE_KEYS);
    assertString(errors, `${path}.id`, source.id);
    if (typeof source.id === "string") {
      const previous = seenIds.get(source.id);
      if (previous !== undefined) {
        errors.push(`${path}.id: duplicate source id ${JSON.stringify(source.id)} (already used at ${previous})`);
      } else {
        seenIds.set(source.id, path);
      }
    }
    assertString(errors, `${path}.repo`, source.repo, { pattern: REPO_PATTERN });
    assertString(errors, `${path}.commit`, source.commit, { pattern: COMMIT_PATTERN });
    assertString(errors, `${path}.license`, source.license, { allowed: LICENSES });
  });
}

function validateMuscles(errors, path, muscles, { required }) {
  if (!Array.isArray(muscles)) {
    errors.push(`${path}: expected an array`);
    return;
  }
  if (required && muscles.length === 0) {
    errors.push(`${path}: must list at least one primary muscle`);
  }
  const seen = new Set();
  muscles.forEach((muscle, index) => {
    const musclePath = `${path}[${index}]`;
    if (typeof muscle !== "string") {
      errors.push(`${musclePath}: expected a muscle id; got ${JSON.stringify(muscle)}`);
      return;
    }
    if (!MUSCLE_IDS.includes(muscle)) {
      errors.push(`${musclePath}: unknown muscle id ${JSON.stringify(muscle)}`);
    }
    if (seen.has(muscle)) {
      errors.push(`${musclePath}: duplicate muscle id ${JSON.stringify(muscle)}`);
    }
    seen.add(muscle);
  });
}

function validateEquipment(errors, path, equipment) {
  if (!isPlainObject(equipment)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  checkUnknownKeys(errors, path, equipment, EQUIPMENT_KEYS);
  assertString(errors, `${path}.category`, equipment.category, {
    allowed: EQUIPMENT_CATEGORIES,
  });
  const itemsPath = `${path}.items`;
  if (!Array.isArray(equipment.items)) {
    errors.push(`${itemsPath}: expected an array`);
    return;
  }
  const seen = new Set();
  equipment.items.forEach((item, index) => {
    const itemPath = `${itemsPath}[${index}]`;
    if (typeof item !== "string") {
      errors.push(`${itemPath}: expected an equipment item; got ${JSON.stringify(item)}`);
      return;
    }
    if (!EQUIPMENT_ITEMS.includes(item)) {
      errors.push(`${itemPath}: unknown equipment item ${JSON.stringify(item)}`);
    }
    if (seen.has(item)) {
      errors.push(`${itemPath}: duplicate equipment item ${JSON.stringify(item)}`);
    }
    seen.add(item);
  });
}

function validateEntrySource(errors, path, source) {
  if (!isPlainObject(source)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  checkUnknownKeys(errors, path, source, ENTRY_SOURCE_KEYS);
  assertString(errors, `${path}.free_exercise_db`, source.free_exercise_db);
  assertString(errors, `${path}.guide_page`, source.guide_page, {
    pattern: GUIDE_PAGE_PATTERN,
  });
}

/**
 * Optional `variant_of`: related catalog ids (symmetric for the dip pair, e.g.
 * `chest_dip` <-> `triceps_dip`). Absent when unused; never an empty array.
 * Existence is checked after every entry has been visited, so forward
 * references are allowed.
 */
function validateVariantOf(errors, path, entry, pendingReferences) {
  if (!("variant_of" in entry)) {
    return;
  }
  const fieldPath = `${path}.variant_of`;
  if (!Array.isArray(entry.variant_of)) {
    errors.push(`${fieldPath}: expected an array of catalog ids`);
    return;
  }
  if (entry.variant_of.length === 0) {
    errors.push(
      `${fieldPath}: must list at least one variant id; omit the field when unused`,
    );
  }
  const seen = new Set();
  entry.variant_of.forEach((variantId, index) => {
    const variantPath = `${fieldPath}[${index}]`;
    if (typeof variantId !== "string" || variantId.trim() === "") {
      errors.push(
        `${variantPath}: expected a non-empty catalog id; got ${JSON.stringify(variantId)}`,
      );
      return;
    }
    if (variantId === entry.id) {
      errors.push(
        `${variantPath}: must not reference its own entry id ${JSON.stringify(variantId)}`,
      );
    }
    if (seen.has(variantId)) {
      errors.push(`${variantPath}: duplicate variant id ${JSON.stringify(variantId)}`);
    }
    seen.add(variantId);
    pendingReferences.push({ path: variantPath, variantId });
  });
}

function validateEntries(errors, entries) {
  if (!Array.isArray(entries)) {
    errors.push("catalog.entries: expected an array");
    return;
  }
  if (entries.length !== EXPECTED_ENTRY_COUNT) {
    errors.push(
      `catalog.entries: expected ${EXPECTED_ENTRY_COUNT} entries, got ${entries.length}`,
    );
  }

  const ids = new Map();
  const names = new Map();
  const variantReferences = [];

  entries.forEach((entry, index) => {
    const path = `catalog.entries[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    checkUnknownKeys(errors, path, entry, ENTRY_KEYS);

    if (typeof entry.id !== "string") {
      errors.push(`${path}.id: expected a string; got ${JSON.stringify(entry.id)}`);
    } else {
      if (entry.id.trim() === "") {
        errors.push(`${path}.id: must not be empty`);
      }
      if (!ID_PATTERN.test(entry.id)) {
        errors.push(
          `${path}.id: ${JSON.stringify(entry.id)} must be ASCII snake_case (a-z, 0-9, single underscores)`,
        );
      }
      const previous = ids.get(entry.id);
      if (previous !== undefined) {
        errors.push(
          `${path}.id: duplicate id ${JSON.stringify(entry.id)} (already used at ${previous})`,
        );
      } else {
        ids.set(entry.id, path);
      }
    }

    normalizeAndRegisterName(errors, names, `${path}.name`, entry.name);
    if (!Array.isArray(entry.aliases)) {
      errors.push(`${path}.aliases: expected an array`);
    } else {
      entry.aliases.forEach((alias, aliasIndex) => {
        normalizeAndRegisterName(
          errors,
          names,
          `${path}.aliases[${aliasIndex}]`,
          alias,
        );
      });
    }

    assertString(errors, `${path}.pattern`, entry.pattern, {
      allowed: MOVEMENT_PATTERNS,
    });
    validateMuscles(errors, `${path}.primary_muscles`, entry.primary_muscles, {
      required: true,
    });
    validateMuscles(errors, `${path}.secondary_muscles`, entry.secondary_muscles, {
      required: false,
    });
    validateEquipment(errors, `${path}.equipment`, entry.equipment);
    assertString(errors, `${path}.difficulty`, entry.difficulty, {
      allowed: DIFFICULTIES,
    });
    assertString(errors, `${path}.mechanics`, entry.mechanics, {
      allowed: MECHANICS,
      nullable: true,
    });
    assertString(errors, `${path}.force`, entry.force, {
      allowed: FORCES,
      nullable: true,
    });
    assertString(errors, `${path}.content_status`, entry.content_status, {
      allowed: CONTENT_STATUSES,
    });
    assertString(errors, `${path}.name_status`, entry.name_status, {
      allowed: NAME_STATUSES,
    });
    validateEntrySource(errors, `${path}.source`, entry.source);
    validateVariantOf(errors, path, entry, variantReferences);
  });

  // Variant ids may point forward, so existence is checked once all ids are known.
  for (const reference of variantReferences) {
    if (!ids.has(reference.variantId)) {
      errors.push(
        `${reference.path}: unknown variant id ${JSON.stringify(reference.variantId)}; no catalog entry has that id`,
      );
    }
  }
}

/**
 * Validate a parsed catalog document. Throws one aggregated error listing every
 * problem found, so a broken source file is fixed in one pass.
 */
export function validateCatalog(catalog) {
  if (!isPlainObject(catalog)) {
    throw new Error("Invalid exercise catalog:\n  - catalog: expected a JSON object");
  }
  const errors = [];
  checkUnknownKeys(errors, "catalog", catalog, ROOT_KEYS);

  if (catalog.schema !== EXPECTED_SCHEMA) {
    errors.push(
      `catalog.schema: expected ${JSON.stringify(EXPECTED_SCHEMA)}, got ${JSON.stringify(catalog.schema)}`,
    );
  }
  if (catalog.version !== EXPECTED_VERSION) {
    errors.push(
      `catalog.version: expected ${EXPECTED_VERSION}, got ${JSON.stringify(catalog.version)}`,
    );
  }
  assertString(errors, "catalog.generated", catalog.generated, {
    pattern: DATE_PATTERN,
  });
  validateSources(errors, catalog.sources);
  validateEntries(errors, catalog.entries);

  if (errors.length > 0) {
    throw new Error(`Invalid exercise catalog:\n${errors.map((line) => `  - ${line}`).join("\n")}`);
  }
  return catalog;
}

/** Render the deterministic, committed TypeScript module for a validated catalog. */
export function buildGeneratedSource(catalog) {
  const digest = computeCatalogDigest(catalog);
  const json = JSON.stringify(catalog, null, 2);

  return `/**
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Generated by \`scripts/build-exercise-catalog.mjs\` from
 * \`data/exercise-catalog/catalog.v1.json\`. Run the script (and commit its
 * output) whenever the source JSON changes.
 *
 * Deterministic: the source JSON is the only input; no clock, randomness, or
 * network access participates. Version ${catalog.version}, ${catalog.entries.length} entries,
 * sha256 digest ${digest}.
 */
import type { ExerciseCatalog } from "./types.ts";

export const CATALOG_VERSION = ${catalog.version};
export const CATALOG_ENTRY_COUNT = ${catalog.entries.length};
export const CATALOG_DIGEST = ${JSON.stringify(digest)};

/** Frozen v1 catalog data shared by web, mobile, the pi extension, and the server. */
export const CATALOG_DATA: ExerciseCatalog = ${json};

freezeCatalog(CATALOG_DATA);

/** Deep-freeze so no consumer can mutate the bundled catalog at runtime. */
function freezeCatalog(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      freezeCatalog(nested);
    }
    Object.freeze(value);
  }
}
`;
}

function parseArgs(args) {
  const options = { check: false, catalogPath: DEFAULT_CATALOG_PATH, help: false };
  let sawCatalog = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--catalog") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--catalog requires a path argument");
      }
      options.catalogPath = resolve(process.cwd(), value);
      sawCatalog = true;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}; see --help`);
    }
  }
  if (sawCatalog && !options.check) {
    throw new Error("--catalog may only be used with --check (it never writes generated output)");
  }
  return options;
}

function displayPath(absolutePath) {
  return relative(REPO_ROOT, absolutePath) || absolutePath;
}

function readCatalog(catalogPath) {
  let text;
  try {
    text = readFileSync(catalogPath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read catalog source ${displayPath(catalogPath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse ${displayPath(catalogPath)} as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const catalog = readCatalog(options.catalogPath);
  validateCatalog(catalog);
  const digest = computeCatalogDigest(catalog);
  const summary = `${catalog.entries.length} entries, version ${catalog.version}, sha256 ${digest}`;

  if (options.check) {
    let existing;
    try {
      existing = readFileSync(DEFAULT_OUTPUT_PATH, "utf8");
    } catch (error) {
      throw new Error(
        `cannot read generated catalog ${displayPath(DEFAULT_OUTPUT_PATH)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const expected = buildGeneratedSource(catalog);
    if (existing !== expected) {
      throw new Error(
        `generated catalog is stale: ${displayPath(DEFAULT_OUTPUT_PATH)} does not match ${displayPath(options.catalogPath)}; run \`node scripts/build-exercise-catalog.mjs\` and commit the result`,
      );
    }
    console.log(`build-exercise-catalog: up to date (${summary})`);
    return;
  }

  const generated = buildGeneratedSource(catalog);
  mkdirSync(dirname(DEFAULT_OUTPUT_PATH), { recursive: true });
  writeFileSync(DEFAULT_OUTPUT_PATH, generated, "utf8");
  console.log(`build-exercise-catalog: wrote ${displayPath(DEFAULT_OUTPUT_PATH)} (${summary})`);
}

const invokedPath = process.argv[1];
const isMain =
  typeof invokedPath === "string" &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href;

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `build-exercise-catalog: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
