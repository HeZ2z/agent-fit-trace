import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EXERCISE_ALIASES_ZH,
  EXERCISE_DISPLAY_NAMES_ZH,
  ZH_MESSAGES,
  displayExerciseName,
} from "../packages/fit-trace-i18n/src/index.ts";
import {
  displayRecommendation,
  displayTrend,
} from "../packages/fit-trace-i18n/src/domain.ts";
import type {
  ExerciseTrend,
  Recommendation,
} from "@pi-fit-trace/core";

/**
 * Integrity coverage for the render-time Chinese exercise-name layer.
 *
 * The runtime tables are generated from the frozen catalog JSON, so this test
 * reads the same data files with `node:fs` and asserts that the committed
 * TypeScript is an exact, order-stable projection of them. The i18n package
 * source itself stays browser-safe; only this root test touches the filesystem.
 */

interface ZhNameEntry {
  name: string;
  aliases: string[];
}

interface ZhNamesFile {
  schema: string;
  version: number;
  names: Record<string, ZhNameEntry>;
}

interface CatalogFile {
  schema: string;
  version: number;
  entries: { name: string }[];
}

const catalog = JSON.parse(
  readFileSync(new URL("../data/exercise-catalog/catalog.v1.json", import.meta.url), "utf8"),
) as CatalogFile;

const zhSource = JSON.parse(
  readFileSync(new URL("../data/exercise-catalog/zh-names.v1.json", import.meta.url), "utf8"),
) as ZhNamesFile;

const CANONICAL_NAMES: readonly string[] = catalog.entries.map((entry) => entry.name);
const CANONICAL_NAME_SET: ReadonlySet<string> = new Set(CANONICAL_NAMES);
const SOURCE_ENTRIES: readonly (readonly [string, ZhNameEntry])[] = Object.entries(zhSource.names);

/** Rebuild the expected runtime tables from the source JSON, in catalog order. */
function expectedTables(): {
  displayNames: Record<string, string>;
  aliases: Record<string, string[]>;
} {
  const displayNames: Record<string, string> = {};
  const aliases: Record<string, string[]> = {};
  for (const [canonicalName, entry] of SOURCE_ENTRIES) {
    displayNames[canonicalName] = entry.name;
    if (entry.aliases.length > 0) aliases[canonicalName] = [...entry.aliases];
  }
  return { displayNames, aliases };
}

const EXPECTED = expectedTables();

test("catalog and Chinese source cover the same 194 canonical names", () => {
  assert.equal(catalog.schema, "fit-trace-exercise-catalog");
  assert.equal(catalog.version, 1);
  assert.equal(zhSource.schema, "fit-trace-exercise-zh-names");
  assert.equal(zhSource.version, 1);

  assert.equal(CANONICAL_NAMES.length, 194);
  assert.equal(SOURCE_ENTRIES.length, 194);
  assert.equal(CANONICAL_NAME_SET.size, 194);
  // Same names, and the same order: the generated table is stable per release.
  assert.deepEqual(Object.keys(zhSource.names), [...CANONICAL_NAMES]);
});

test("the runtime Chinese table is an exact, order-stable projection of the source", () => {
  assert.equal(Object.keys(EXERCISE_DISPLAY_NAMES_ZH).length, 194);
  assert.deepEqual(EXERCISE_DISPLAY_NAMES_ZH, EXPECTED.displayNames);
  assert.deepEqual(Object.keys(EXERCISE_DISPLAY_NAMES_ZH), [...CANONICAL_NAMES]);
});

test("every catalog exercise has a non-empty Chinese display name", () => {
  for (const canonicalName of CANONICAL_NAMES) {
    const displayName = EXERCISE_DISPLAY_NAMES_ZH[canonicalName];
    assert.equal(typeof displayName, "string", canonicalName);
    assert.notEqual(displayName.trim(), "", canonicalName);
    assert.notEqual(displayName, canonicalName, `untranslated display name: ${canonicalName}`);
    assert.match(displayName, /[\u3400-\u9fff]/, `display name has no Chinese: ${canonicalName}`);
  }
});

test("displayExerciseName returns the Chinese name for every catalog exercise", () => {
  for (const canonicalName of CANONICAL_NAMES) {
    assert.equal(
      displayExerciseName("zh", canonicalName),
      EXPECTED.displayNames[canonicalName],
      canonicalName,
    );
  }
});

test("displayExerciseName keeps canonical names for English, unknown and custom names", () => {
  for (const canonicalName of CANONICAL_NAMES) {
    assert.equal(displayExerciseName("en", canonicalName), canonicalName);
  }

  // Custom, unknown and deliberately non-canonical spellings pass through.
  const passthrough = [
    "My Custom Lift",
    "custom_exercise_42",
    "我的自定义动作",
    "barbell squat",
    " Barbell Squat",
    "Barbell Squat ",
  ];
  for (const value of passthrough) {
    assert.equal(CANONICAL_NAME_SET.has(value), false, `${value} must not be a catalog name`);
    assert.equal(displayExerciseName("zh", value), value);
    assert.equal(displayExerciseName("en", value), value);
  }

  // Inherited object keys must never leak in as translations.
  for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
    assert.equal(displayExerciseName("zh", value), value);
  }
});

test("Chinese aliases are a strict subset of the canonical names and match the source", () => {
  const aliasKeys = Object.keys(EXERCISE_ALIASES_ZH);
  const sourceAliasKeys = SOURCE_ENTRIES.filter(([, entry]) => entry.aliases.length > 0).map(
    ([canonicalName]) => canonicalName,
  );

  assert.deepEqual(aliasKeys, sourceAliasKeys);
  assert.deepEqual(EXERCISE_ALIASES_ZH, EXPECTED.aliases);
  assert.ok(aliasKeys.length > 0);
  assert.ok(aliasKeys.length < CANONICAL_NAMES.length);
  for (const canonicalName of aliasKeys) {
    assert.ok(CANONICAL_NAME_SET.has(canonicalName), `unknown canonical name: ${canonicalName}`);
    const aliases = EXERCISE_ALIASES_ZH[canonicalName];
    assert.ok(aliases.length > 0, canonicalName);
    assert.equal(new Set(aliases).size, aliases.length, `duplicate alias: ${canonicalName}`);
    for (const alias of aliases) {
      assert.equal(typeof alias, "string", canonicalName);
      assert.notEqual(alias.trim(), "", `${canonicalName}: empty alias`);
    }
  }
});

test("the exercise-name layer is deterministic and not merged into the UI dictionary", () => {
  const rebuilt = expectedTables();
  assert.equal(
    JSON.stringify(EXERCISE_DISPLAY_NAMES_ZH),
    JSON.stringify(rebuilt.displayNames),
    "display table must be an order-stable projection of the frozen JSON",
  );
  assert.equal(
    JSON.stringify(EXERCISE_ALIASES_ZH),
    JSON.stringify(rebuilt.aliases),
    "alias table must be an order-stable projection of the frozen JSON",
  );

  for (const canonicalName of CANONICAL_NAMES) {
    // Rebuilt from the source JSON above, so repeated render calls agree.
    assert.equal(displayExerciseName("zh", canonicalName), rebuilt.displayNames[canonicalName]);
    // Exercise names are catalog data, not interface copy: translate() falls
    // back to English for them and displayExerciseName is the display path.
    assert.equal(
      Object.prototype.hasOwnProperty.call(ZH_MESSAGES, canonicalName),
      false,
      `exercise name leaked into ZH_MESSAGES: ${canonicalName}`,
    );
  }
});

test("rebuilt Chinese trend and recommendation copy uses the exercise display helper", () => {
  const canonicalName = "Barbell Bench Press - Medium Grip";
  const displayName = EXPECTED.displayNames[canonicalName];

  const trend: ExerciseTrend = {
    exercise: canonicalName,
    metric: "est_1rm_kg",
    sessions_compared: 3,
    first: 80,
    last: 90,
    delta: 10,
    delta_pct: 12.5,
    direction: "up",
  };
  assert.equal(
    displayTrend("zh", trend),
    `${displayName}：80 → 90（+10 kg，12.5%，上升）`,
  );
  // A stored alias resolves to the catalog entry; a custom name stays as typed.
  assert.equal(
    displayTrend("zh", { ...trend, exercise: "Bench press" }),
    `${displayName}：80 → 90（+10 kg，12.5%，上升）`,
  );
  assert.equal(
    displayTrend("zh", { ...trend, exercise: "My Custom Lift" }),
    "My Custom Lift：80 → 90（+10 kg，12.5%，上升）",
  );

  // The local plan generator's progressive-overload copy embeds the name; the
  // Chinese rebuild must show the catalog display name, not the English name.
  const progressiveOverload: Recommendation = {
    action: "progressive_overload",
    detail: `Add a small increase (~2.5% load or one rep per set) to ${canonicalName}.`,
    reason: `Estimated 1RM for ${canonicalName} rose 7.5% across 3 sessions at an average RPE of 6.77.`,
    evidence: { exercise: canonicalName, delta_pct: 7.5, avg_rpe: 6.77 },
  };
  assert.deepEqual(displayRecommendation("zh", progressiveOverload), {
    action: "渐进超负荷",
    detail: `对 ${displayName} 小幅加重（约 2.5% 负荷或每组多 1 次）。`,
    reason: `据估计，${displayName} 的 1RM 上升 7.5%，平均 RPE 为 6.77。`,
  });

  const customName = "My Custom Lift";
  const custom: Recommendation = {
    ...progressiveOverload,
    detail: `Add a small increase (~2.5% load or one rep per set) to ${customName}.`,
    reason: `Estimated 1RM for ${customName} rose 7.5% across 3 sessions at an average RPE of 6.77.`,
    evidence: { exercise: customName, delta_pct: 7.5, avg_rpe: 6.77 },
  };
  assert.deepEqual(displayRecommendation("zh", custom), {
    action: "渐进超负荷",
    detail: `对 ${customName} 小幅加重（约 2.5% 负荷或每组多 1 次）。`,
    reason: `据估计，${customName} 的 1RM 上升 7.5%，平均 RPE 为 6.77。`,
  });
});
