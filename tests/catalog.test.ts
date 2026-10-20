import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CATALOG_DATA,
  CATALOG_DIGEST,
  CATALOG_ENTRY_COUNT,
  CATALOG_VERSION,
  DEFAULT_EXERCISE_SEARCH_LIMIT,
  getExerciseById,
  listExercises,
  normalizeExerciseName,
  resolveExerciseName,
  searchExercises,
} from "@pi-fit-trace/core";
import type { ExerciseCatalog } from "@pi-fit-trace/core";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GENERATOR_PATH = join(REPO_ROOT, "scripts", "build-exercise-catalog.mjs");
const SOURCE_PATH = join(
  REPO_ROOT,
  "data",
  "exercise-catalog",
  "catalog.v1.json",
);

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "fit-trace-exercise-catalog-"));

after(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

/** Minimal mutable view of the source document, for malformed-catalog fixtures. */
interface MutableCatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  pattern: string;
  primary_muscles: string[];
  secondary_muscles: string[];
  equipment: { category: string; items: string[] };
  difficulty: string;
  mechanics: string | null;
  force: string | null;
  content_status: string;
  name_status: string;
  variant_of?: string[];
  source: { free_exercise_db: string; guide_page: string };
}

interface MutableCatalog {
  schema: unknown;
  version: unknown;
  generated: string;
  sources: Array<Record<string, unknown>>;
  entries: MutableCatalogEntry[];
}

const SOURCE_CATALOG = JSON.parse(
  readFileSync(SOURCE_PATH, "utf8"),
) as ExerciseCatalog;

/**
 * Canonical JSON over the whole catalog document: recursively sorted object
 * keys, arrays in order, `undefined` dropped. The digest contract the generator
 * and this test share.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runGenerator(args: string[]) {
  return spawnSync(process.execPath, [GENERATOR_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

let tempFileCount = 0;

function writeTempCatalog(
  mutate: (catalog: MutableCatalog) => void,
): string {
  const catalog = JSON.parse(
    readFileSync(SOURCE_PATH, "utf8"),
  ) as MutableCatalog;
  mutate(catalog);
  const path = join(TEMP_ROOT, `catalog-${tempFileCount}.json`);
  tempFileCount += 1;
  writeFileSync(path, JSON.stringify(catalog, null, 2), "utf8");
  return path;
}

function mutableEntry(catalog: MutableCatalog, id: string): MutableCatalogEntry {
  const entry = catalog.entries.find((candidate) => candidate.id === id);
  assert.ok(entry, `temporary catalog is missing entry ${id}`);
  return entry;
}

test("bundles the 194-entry v1 catalog with version and digest metadata", () => {
  assert.equal(CATALOG_VERSION, 1);
  assert.equal(CATALOG_DATA.version, 1);
  assert.equal(CATALOG_DATA.schema, "fit-trace-exercise-catalog");
  assert.equal(CATALOG_DATA.generated, SOURCE_CATALOG.generated);
  assert.equal(CATALOG_ENTRY_COUNT, 194);
  assert.equal(CATALOG_DATA.entries.length, 194);
  assert.equal(SOURCE_CATALOG.entries.length, 194);
  assert.equal(CATALOG_DATA.sources.length, 2);
  assert.match(CATALOG_DIGEST, /^[0-9a-f]{64}$/);
  // The generated module is the committed source JSON, not a re-typed copy.
  assert.deepEqual(CATALOG_DATA, SOURCE_CATALOG);
});

test("generated digest matches the committed source JSON", () => {
  const expected = sha256(canonicalJson(SOURCE_CATALOG));
  assert.equal(CATALOG_DIGEST, expected);
});

test("catalog ids and normalized names/aliases are globally unique", () => {
  const ids = new Set<string>();
  const names = new Map<string, string>();
  let aliasCount = 0;

  for (const entry of CATALOG_DATA.entries) {
    assert.match(entry.id, /^[a-z0-9]+(?:_[a-z0-9]+)*$/);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);

    for (const name of [entry.name, ...entry.aliases]) {
      const key = normalizeExerciseName(name);
      assert.notEqual(key, "", `empty name on ${entry.id}`);
      const existing = names.get(key);
      assert.equal(
        existing,
        undefined,
        `normalized name ${JSON.stringify(key)} from ${entry.id} collides with ${existing}`,
      );
      names.set(key, entry.id);
    }
    aliasCount += entry.aliases.length;
  }

  assert.equal(ids.size, 194);
  assert.equal(names.size, 194 + aliasCount);
});

test("bundled catalog data is deeply frozen", () => {
  const entry = CATALOG_DATA.entries[0];
  assert.ok(Object.isFrozen(CATALOG_DATA));
  assert.ok(Object.isFrozen(CATALOG_DATA.sources));
  assert.ok(Object.isFrozen(CATALOG_DATA.entries));
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry?.aliases));
  assert.ok(Object.isFrozen(entry?.primary_muscles));
  assert.ok(Object.isFrozen(entry?.secondary_muscles));
  assert.ok(Object.isFrozen(entry?.equipment));
  assert.ok(Object.isFrozen(entry?.equipment.items));
  assert.ok(Object.isFrozen(entry?.source));
  assert.ok(Object.isFrozen(getExerciseById("chest_dip")?.variant_of));
});

test("dip variants reference each other symmetrically", () => {
  const chestDip = getExerciseById("chest_dip");
  const tricepsDip = getExerciseById("triceps_dip");
  assert.deepEqual(chestDip?.variant_of, ["triceps_dip"]);
  assert.deepEqual(tricepsDip?.variant_of, ["chest_dip"]);

  // Only the documented dip pair carries the relation; other entries omit it.
  const entriesWithVariants = CATALOG_DATA.entries.filter(
    (entry) => entry.variant_of !== undefined,
  );
  assert.deepEqual(
    entriesWithVariants.map((entry) => entry.id).sort(),
    ["chest_dip", "triceps_dip"],
  );
});

test("committed generated catalog is current with the source JSON", () => {
  const result = runGenerator(["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up to date/);
  assert.match(result.stdout, /194 entries/);
});

test("generator --check reports stale output when catalog content changes", () => {
  const path = writeTempCatalog((catalog) => {
    catalog.entries[0]!.aliases.push("Back Squat V1");
  });
  const result = runGenerator(["--check", "--catalog", path]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated catalog is stale/);
});

test("generator refuses to write from an alternate catalog path", () => {
  const result = runGenerator(["--catalog", SOURCE_PATH]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--catalog may only be used with --check/);
});

const INVALID_CATALOG_CASES: ReadonlyArray<{
  label: string;
  mutate: (catalog: MutableCatalog) => void;
  expected: RegExp;
}> = [
  {
    label: "wrong schema",
    mutate: (catalog) => {
      catalog.schema = "not-a-catalog";
    },
    expected: /catalog\.schema: expected "fit-trace-exercise-catalog"/,
  },
  {
    label: "unsupported version",
    mutate: (catalog) => {
      catalog.version = 2;
    },
    expected: /catalog\.version: expected 1, got 2/,
  },
  {
    label: "wrong entry count",
    mutate: (catalog) => {
      catalog.entries.pop();
    },
    expected: /catalog\.entries: expected 194 entries, got 193/,
  },
  {
    label: "duplicate id",
    mutate: (catalog) => {
      catalog.entries[1]!.id = catalog.entries[0]!.id;
    },
    expected: /duplicate id/,
  },
  {
    label: "colliding normalized alias",
    mutate: (catalog) => {
      catalog.entries[1]!.aliases = ["Barbell_Squat"];
    },
    expected: /after name normalization/,
  },
  {
    label: "unknown movement pattern",
    mutate: (catalog) => {
      catalog.entries[0]!.pattern = "olympic_lift";
    },
    expected: /expected one of squat, hinge/,
  },
  {
    label: "empty primary muscles",
    mutate: (catalog) => {
      catalog.entries[0]!.primary_muscles = [];
    },
    expected: /must list at least one primary muscle/,
  },
  {
    label: "unknown muscle id",
    mutate: (catalog) => {
      catalog.entries[0]!.primary_muscles = ["wings"];
    },
    expected: /unknown muscle id "wings"/,
  },
  {
    label: "unknown equipment item",
    mutate: (catalog) => {
      catalog.entries[0]!.equipment.items = ["mystery_machine"];
    },
    expected: /unknown equipment item "mystery_machine"/,
  },
  {
    label: "missing source reference",
    mutate: (catalog) => {
      const source = catalog.entries[0]!.source as unknown as Record<
        string,
        unknown
      >;
      delete source.guide_page;
    },
    expected: /\.source\.guide_page: expected a string/,
  },
  {
    label: "unknown entry field",
    mutate: (catalog) => {
      (catalog.entries[0] as MutableCatalogEntry & { legacy_name?: string })
        .legacy_name = "Back Squat";
    },
    expected: /\.legacy_name: unknown field/,
  },
  {
    label: "variant_of is not an array",
    mutate: (catalog) => {
      (mutableEntry(catalog, "chest_dip") as unknown as { variant_of: unknown })
        .variant_of = "triceps_dip";
    },
    expected: /\.variant_of: expected an array of catalog ids/,
  },
  {
    label: "empty variant_of",
    mutate: (catalog) => {
      mutableEntry(catalog, "chest_dip").variant_of = [];
    },
    expected: /\.variant_of: must list at least one variant id/,
  },
  {
    label: "non-string variant id",
    mutate: (catalog) => {
      (mutableEntry(catalog, "chest_dip") as unknown as { variant_of: unknown[] })
        .variant_of = ["triceps_dip", 42];
    },
    expected: /expected a non-empty catalog id; got 42/,
  },
  {
    label: "duplicate variant id",
    mutate: (catalog) => {
      mutableEntry(catalog, "chest_dip").variant_of = [
        "triceps_dip",
        "triceps_dip",
      ];
    },
    expected: /duplicate variant id "triceps_dip"/,
  },
  {
    label: "self-referencing variant id",
    mutate: (catalog) => {
      mutableEntry(catalog, "chest_dip").variant_of = ["chest_dip"];
    },
    expected: /must not reference its own entry id "chest_dip"/,
  },
  {
    label: "unknown variant id",
    mutate: (catalog) => {
      mutableEntry(catalog, "chest_dip").variant_of = ["not_a_real_exercise"];
    },
    expected: /unknown variant id "not_a_real_exercise"/,
  },
];

for (const invalidCatalogCase of INVALID_CATALOG_CASES) {
  test(`generator rejects a malformed catalog: ${invalidCatalogCase.label}`, () => {
    const path = writeTempCatalog(invalidCatalogCase.mutate);
    const result = runGenerator(["--check", "--catalog", path]);
    assert.notEqual(
      result.status,
      0,
      `expected a non-zero exit for ${invalidCatalogCase.label}`,
    );
    assert.match(result.stderr, /Invalid exercise catalog/);
    assert.match(result.stderr, invalidCatalogCase.expected);
  });
}

test("normalizeExerciseName produces the canonical lookup spelling", () => {
  assert.equal(normalizeExerciseName("  Bench_Press  "), "bench press");
  assert.equal(normalizeExerciseName("Dips - Chest Version"), "dips chest version");
  assert.equal(normalizeExerciseName("Bench--Press"), "bench press");
  assert.equal(normalizeExerciseName("ＲＤＬ"), "rdl");
  assert.equal(normalizeExerciseName("   "), "");
});

test("resolves canonical names and aliases case/width/separator-insensitively", () => {
  assert.equal(resolveExerciseName("Barbell Squat")?.id, "barbell_squat");
  assert.equal(
    resolveExerciseName("Barbell Bench Press - Medium Grip")?.id,
    "barbell_bench_press",
  );
  assert.equal(resolveExerciseName("bench_press")?.id, "barbell_bench_press");
  assert.equal(resolveExerciseName("Bench Press")?.id, "barbell_bench_press");
  assert.equal(resolveExerciseName("squat")?.id, "barbell_squat");
  assert.equal(resolveExerciseName("deadlift")?.id, "barbell_deadlift");
  assert.equal(resolveExerciseName("RDL")?.id, "romanian_deadlift");
  assert.equal(resolveExerciseName("rdl")?.id, "romanian_deadlift");
  assert.equal(resolveExerciseName("OHP")?.id, "standing_military_press");
  assert.equal(resolveExerciseName("Chin-Up")?.id, "chin_up");
  assert.equal(resolveExerciseName("chin_ups")?.id, "chin_up");
  assert.equal(
    resolveExerciseName("Ｄｉｐｓ - Triceps Version")?.id,
    "triceps_dip",
  );
});

test("unknown and blank exercise names resolve to null", () => {
  assert.equal(resolveExerciseName("zercher carry"), null);
  assert.equal(resolveExerciseName("bench press deluxe"), null);
  assert.equal(resolveExerciseName(""), null);
  assert.equal(resolveExerciseName("   "), null);
  assert.equal(resolveExerciseName("__"), null);
});

test("getExerciseById returns entries by exact id and null for unknown ids", () => {
  const entry = getExerciseById("barbell_squat");
  assert.equal(entry?.name, "Barbell Squat");
  assert.equal(entry?.pattern, "squat");
  assert.equal(entry?.equipment.category, "barbell");
  assert.equal(getExerciseById("unknown_exercise"), null);
  assert.equal(getExerciseById("BARBELL_SQUAT"), null);
  assert.equal(getExerciseById(""), null);
});

test("search ranks canonical prefixes and word prefixes before substrings", () => {
  const rowResults = searchExercises("row");
  // `Rowing, Stationary` starts with the query; `Narrow Stance Leg Press` only
  // contains it inside "narrow".
  assert.equal(rowResults[0]?.id, "stationary_rower");
  assert.equal(rowResults.at(-1)?.id, "narrow_stance_leg_press");

  const upResults = searchExercises("up");
  // `Pullups` / `Pushups` only contain "up"; the entries above them match a word
  // prefix are ordered alphabetically.
  assert.deepEqual(
    upResults.slice(-2).map((entry) => entry.id),
    ["pull_up", "push_up"],
  );
  assert.equal(upResults[0]?.id, "band_assisted_pull_up");
});

test("search matches aliases and breaks ties alphabetically", () => {
  assert.equal(searchExercises("rdl")[0]?.id, "romanian_deadlift");
  assert.equal(searchExercises("ohp")[0]?.id, "standing_military_press");
  assert.deepEqual(
    searchExercises("squat").slice(0, 3).map((entry) => entry.id),
    ["barbell_hack_squat", "barbell_squat", "bodyweight_squat"],
  );
  assert.deepEqual(
    searchExercises("bench", 2).map((entry) => entry.id),
    ["bench_dips", "barbell_bench_press"],
  );
});

test("search normalizes queries, applies a deterministic limit, and is repeatable", () => {
  assert.deepEqual(searchExercises("BENCH__PRESS"), searchExercises("bench press"));
  assert.equal(searchExercises("e").length, DEFAULT_EXERCISE_SEARCH_LIMIT);
  assert.deepEqual(searchExercises("squat"), searchExercises("squat"));
  assert.deepEqual(
    searchExercises("squat", 3).map((entry) => entry.id),
    searchExercises("squat")
      .slice(0, 3)
      .map((entry) => entry.id),
  );
  assert.deepEqual(searchExercises("squat", 0), []);
  assert.deepEqual(searchExercises("no such exercise"), []);
  assert.deepEqual(searchExercises("   "), []);
  assert.deepEqual(searchExercises("__"), []);
});

test("listExercises applies deterministic filters and sorts by name", () => {
  const cardio = listExercises({ pattern: "cardio" });
  assert.equal(cardio.length, 8);
  assert.ok(cardio.every((entry) => entry.pattern === "cardio"));

  const barbell = listExercises({ equipment: "barbell" });
  assert.equal(barbell.length, 39);
  assert.ok(barbell.every((entry) => entry.equipment.category === "barbell"));

  const chest = listExercises({ muscle: "chest" });
  assert.ok(chest.length > 0);
  assert.ok(
    chest.every(
      (entry) =>
        entry.primary_muscles.includes("chest") ||
        entry.secondary_muscles.includes("chest"),
    ),
  );

  assert.equal(listExercises({ difficulty: "expert" }).length, 7);

  const barbellSquats = listExercises({ pattern: "squat", equipment: "barbell" });
  assert.equal(barbellSquats.length, 7);
  assert.ok(
    barbellSquats.every(
      (entry) => entry.pattern === "squat" && entry.equipment.category === "barbell",
    ),
  );

  const names = listExercises().map((entry) => entry.name.toLowerCase());
  assert.equal(names.length, 194);
  assert.deepEqual(names, [...names].sort());
});
