import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EXERCISE_ALIASES_ZH,
  EXERCISE_DISPLAY_NAMES_ZH,
  MAX_EXERCISE_SUGGESTIONS,
  ZH_MESSAGES,
  displayExerciseName,
  displayStoredExerciseName,
  searchExerciseSuggestions,
} from "../packages/fit-trace-i18n/src/index.ts";
import {
  displayRecommendation,
  displayTrend,
} from "../packages/fit-trace-i18n/src/domain.ts";
import { searchExercises } from "@agent-fit-trace/core";
import type {
  ExerciseTrend,
  Recommendation,
} from "@agent-fit-trace/core";

/**
 * Integrity coverage for the render-time Chinese exercise-name layer and the
 * shared autocomplete search.
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

test("displayStoredExerciseName localizes stored names and aliases without touching English", () => {
  const canonicalName = "Barbell Bench Press - Medium Grip";
  const displayName = EXPECTED.displayNames[canonicalName];

  // Every catalog canonical name renders as its Chinese display name in Chinese.
  for (const name of CANONICAL_NAMES) {
    assert.equal(displayStoredExerciseName("zh", name), EXPECTED.displayNames[name], name);
  }
  // A stored alias resolves to the same catalog entry before localization.
  assert.equal(displayStoredExerciseName("zh", "Bench press"), displayName);
  assert.equal(displayStoredExerciseName("zh", "bench_press"), displayName);
  // English returns the exact stored spelling: aliases are not normalized.
  assert.equal(displayStoredExerciseName("en", "Bench press"), "Bench press");
  assert.equal(displayStoredExerciseName("en", canonicalName), canonicalName);
  // Unknown and user-authored custom names pass through unchanged.
  for (const name of ["My Custom Lift", "custom_exercise_42", "我的自定义动作", ""]) {
    assert.equal(displayStoredExerciseName("zh", name), name);
    assert.equal(displayStoredExerciseName("en", name), name);
  }
  // Inherited object keys must never leak in as translations.
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(displayStoredExerciseName("zh", name), name);
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

/* ------------------------------------------------------------------------- */
/* Shared suggestion search (web + mobile)                                   */
/* ------------------------------------------------------------------------- */

const BENCH_PRESS = "Barbell Bench Press - Medium Grip";
const CJK = /[\u3400-\u9fff]/;

function canonicalNames(suggestions: readonly { canonicalName: string }[]): string[] {
  return suggestions.map((suggestion) => suggestion.canonicalName);
}

test("English suggestion labels are the canonical names and contain no Chinese", () => {
  for (const query of ["bench", "press", "squat", "deadlift", "curl"]) {
    const suggestions = searchExerciseSuggestions(query, "en");
    assert.ok(suggestions.length > 0, query);
    for (const suggestion of suggestions) {
      assert.ok(CANONICAL_NAME_SET.has(suggestion.canonicalName), suggestion.canonicalName);
      // The English UI shows exactly the stored spelling, never Chinese copy.
      assert.equal(suggestion.label, suggestion.canonicalName);
      assert.doesNotMatch(suggestion.label, CJK);
      assert.equal(
        suggestion.displayName,
        EXERCISE_DISPLAY_NAMES_ZH[suggestion.canonicalName],
      );
    }
  }
});

test("Chinese suggestion labels are the Chinese display names only", () => {
  const suggestions = searchExerciseSuggestions("卧推", "zh");
  assert.ok(suggestions.length > 0);
  for (const suggestion of suggestions) {
    const displayName = EXERCISE_DISPLAY_NAMES_ZH[suggestion.canonicalName];
    assert.equal(suggestion.displayName, displayName);
    // UI-language copy only: no canonical English suffix in the option label.
    assert.equal(suggestion.label, displayName);
    assert.ok(!suggestion.label.includes(suggestion.canonicalName));
    assert.match(suggestion.label, CJK);
    // The canonical name stays available for selection/storage.
    assert.ok(CANONICAL_NAME_SET.has(suggestion.canonicalName));
  }
  assert.deepEqual(suggestions[0], {
    canonicalName: BENCH_PRESS,
    displayName: "杠铃卧推",
    label: "杠铃卧推",
  });
});

test("a query selects the same catalog entries in both UI languages", () => {
  for (const query of ["bench", "bench press", "卧推", "深蹲", "rdl", "倒蹬", "press"]) {
    const english = searchExerciseSuggestions(query, "en");
    const chinese = searchExerciseSuggestions(query, "zh");
    assert.ok(english.length > 0, query);
    // Matching, ranking, de-duplication and the cap never depend on the label
    // language; only the option copy does, and selection stays canonical.
    assert.deepEqual(canonicalNames(chinese), canonicalNames(english), query);
    for (const suggestion of english) {
      assert.equal(suggestion.label, suggestion.canonicalName);
    }
    for (const suggestion of chinese) {
      assert.equal(
        suggestion.label,
        EXERCISE_DISPLAY_NAMES_ZH[suggestion.canonicalName],
      );
    }
  }
});

test("Chinese display names and alias spellings both match", () => {
  // 卧推 is both an exact alias and a substring of the display name 杠铃卧推.
  assert.equal(searchExerciseSuggestions("卧推", "zh")[0]?.canonicalName, BENCH_PRESS);
  // An alias-only spelling: 倒蹬 is not part of the 腿举 display name.
  assert.ok(!EXERCISE_DISPLAY_NAMES_ZH["Leg Press"].includes("倒蹬"));
  const legPress = searchExerciseSuggestions("倒蹬", "zh");
  assert.equal(legPress[0]?.canonicalName, "Leg Press");
  // The Chinese UI option is the Chinese display name only; the canonical name
  // remains the selection value, it is just not repeated in the label.
  assert.equal(legPress[0]?.label, "腿举");
  // Search is not language-gated: the English UI can find a Chinese spelling but
  // still labels and writes the canonical English name.
  assert.equal(searchExerciseSuggestions("倒蹬", "en")[0]?.canonicalName, "Leg Press");
  assert.equal(searchExerciseSuggestions("倒蹬", "en")[0]?.label, "Leg Press");
});

test("every generated Chinese alias finds its own catalog entry exactly once", () => {
  const limit = CANONICAL_NAMES.length;
  let aliasCount = 0;
  for (const [canonicalName, aliases] of Object.entries(EXERCISE_ALIASES_ZH)) {
    for (const alias of aliases) {
      aliasCount += 1;
      const matches = canonicalNames(searchExerciseSuggestions(alias, "zh", limit));
      assert.equal(
        matches.filter((name) => name === canonicalName).length,
        1,
        `${alias} must find ${canonicalName} exactly once`,
      );
    }
  }
  assert.ok(aliasCount > 0, "the generated alias table must not be empty");
});

test("Chinese matches rank exact display names before prefix, alias, and substring hits", () => {
  // Exact display name, then a display-name prefix, then a substring match.
  assert.deepEqual(
    canonicalNames(searchExerciseSuggestions("腿举", "zh", CANONICAL_NAMES.length)),
    ["Leg Press", "Calf Press On The Leg Press Machine", "Narrow Stance Leg Press"],
  );

  const benchPress = canonicalNames(
    searchExerciseSuggestions("卧推", "zh", CANONICAL_NAMES.length),
  );
  // 卧推 is an exact alias of the first entry but only a substring of the rest.
  assert.equal(benchPress[0], BENCH_PRESS);
  assert.equal(new Set(benchPress).size, benchPress.length);
  assert.equal(benchPress.filter((name) => name === BENCH_PRESS).length, 1);
  // Remaining substring matches are ordered by display name, so 上斜哑铃卧推
  // sorts before 上斜杠铃卧推 regardless of the stored English names.
  const inclineDumbbell = benchPress.indexOf("Incline Dumbbell Press");
  const inclineBarbell = benchPress.indexOf("Barbell Incline Bench Press - Medium Grip");
  assert.ok(inclineDumbbell >= 0 && inclineBarbell >= 0);
  assert.ok(inclineDumbbell < inclineBarbell);
});

test("suggestions de-duplicate an entry matched by both search sources", () => {
  // RDL is a canonical English alias in the core catalog and a generated Chinese
  // alias, so the catalog search and the Chinese alias scan both match it.
  assert.deepEqual(
    searchExercises("rdl", 5).map((entry) => entry.name),
    ["Romanian Deadlift"],
  );
  assert.ok(EXERCISE_ALIASES_ZH["Romanian Deadlift"].includes("RDL"));
  assert.deepEqual(canonicalNames(searchExerciseSuggestions("rdl", "zh")), [
    "Romanian Deadlift",
  ]);
});

test("the default and explicit suggestion limits cap the result list", () => {
  assert.equal(MAX_EXERCISE_SUGGESTIONS, 8);
  const defaultLimited = searchExerciseSuggestions("press", "en");
  assert.equal(defaultLimited.length, MAX_EXERCISE_SUGGESTIONS);
  const uncapped = searchExerciseSuggestions("press", "en", CANONICAL_NAMES.length);
  assert.ok(uncapped.length > MAX_EXERCISE_SUGGESTIONS);
  // The default cap truncates the same deterministic ranking, never reranks it.
  assert.deepEqual(uncapped.slice(0, MAX_EXERCISE_SUGGESTIONS), defaultLimited);

  assert.equal(searchExerciseSuggestions("press", "en", 3).length, 3);
  assert.equal(searchExerciseSuggestions("press", "en", 3.9).length, 3);
  assert.deepEqual(searchExerciseSuggestions("press", "en", 0), []);
  assert.deepEqual(searchExerciseSuggestions("press", "en", -2), []);
});

test("empty and unmatched queries return no suggestions", () => {
  for (const query of ["", " ", "   ", "\t\n", "zzzz-not-an-exercise"]) {
    assert.deepEqual(searchExerciseSuggestions(query, "en"), []);
    assert.deepEqual(searchExerciseSuggestions(query, "zh"), []);
  }
});

test("suggestion search is deterministic across repeated and interleaved calls", () => {
  const cases = [
    ["press", "en"],
    ["卧推", "zh"],
    ["rdl", "zh"],
    ["深蹲", "en"],
  ] as const;
  const serialize = (): string[] =>
    cases.map(([query, language]) =>
      JSON.stringify(searchExerciseSuggestions(query, language)),
    );
  const first = serialize();
  // Unrelated searches in between must not affect ranking or cached state.
  for (const query of ["squat", "腿举", "curl"]) {
    searchExerciseSuggestions(query, "zh");
    searchExerciseSuggestions(query, "en");
  }
  assert.deepEqual(serialize(), first);
  assert.ok(first.every((value) => (JSON.parse(value) as unknown[]).length > 0));
});

test("the shared search module only imports browser-safe modules", () => {
  const source = readFileSync(
    new URL("../packages/fit-trace-i18n/src/exercises.ts", import.meta.url),
    "utf8",
  );
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(
      specifier === "@agent-fit-trace/core" || specifier.startsWith("./"),
      `environment dependency in the shared search: ${specifier}`,
    );
  }
  assert.doesNotMatch(source, /\bMath\.random\b|\bDate\.now\b|\bprocess\.\w/);
});
