import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createSleepStore,
  formatSleepHoursText,
  listSleepEntriesDesc,
  parseManualSleepHours,
  parseSleepStore,
  removeSleepEntry,
  resolveAttachableSleep,
  SLEEP_STORAGE_KEY,
  serializeSleepStore,
  upsertSleepEntry,
  type SleepEntry,
  type SleepStorageLike,
} from "../mobile/src/health/sleepStore.ts";

/**
 * Pure coverage for the device-local sleep history behind the Health page and
 * the Log screen's auto-attach. Only the pure rules of
 * `mobile/src/health/sleepStore.ts` run here — the AsyncStorage shell is
 * exercised through the `SleepStorageLike` fake below, so the root `node:test`
 * suite never needs a device.
 */

/** Entry builder with the strict-parse invariants baked in. */
function entry(over: Partial<SleepEntry> & { date: string }): SleepEntry {
  const hours = over.hours ?? 7.5;
  return {
    date: over.date,
    hours,
    hoursText: over.hoursText ?? formatSleepHoursText(hours),
    sessionCount: over.sessionCount ?? 2,
    importedAt: over.importedAt ?? "2026-10-25T08:00:00.000Z",
    source: over.source ?? "health-connect",
  };
}

/** In-memory `SleepStorageLike` fake that records its writes. */
function memoryStorage(initial: Record<string, string> = {}): {
  storage: SleepStorageLike;
  writes: string[];
  dump: (key: string) => string | null;
} {
  const map = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    storage: {
      async getItem(key) {
        return map.get(key) ?? null;
      },
      async setItem(key, value) {
        writes.push(value);
        map.set(key, value);
      },
    },
    writes,
    dump: (key) => map.get(key) ?? null,
  };
}

/* ── native-import guard ─────────────────────────────────────────── */

test("sleepStore.ts stays free of native/platform dependencies", () => {
  // The sleep store's pure rules are loaded by the root node:test suite
  // through type stripping; a native import here would break that. Guard the
  // source text so the dependency cannot creep in unnoticed, mirroring the
  // healthModel.ts guard. Word boundaries are required for the same reason as
  // there: the substring "expo" occurs in every "export" keyword. And
  // "react-native" is a prefix of the one allowed ecosystem import (the
  // AsyncStorage package), so the react-native guard matches module
  // specifiers instead of bare words.
  const source = readFileSync(
    new URL("../mobile/src/health/sleepStore.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!/\breact-native-health-connect\b/.test(source));
  assert.ok(!/\bexpo\b/.test(source));
  assert.ok(!/from "react-native"/.test(source));
  assert.ok(!/require\("react-native"\)/.test(source));
  // The native Health Connect adapter is never imported by the pure store.
  assert.ok(!/from "\.\/healthConnect(\.ts)?"/.test(source));
  // The one ecosystem import is the AsyncStorage shell, exactly once.
  assert.equal(
    (source.match(/from "@react-native-async-storage\/async-storage"/g) ?? []).length,
    1,
  );
});

/* ── pure model ──────────────────────────────────────────────────── */

test("the sleep store keeps its versioned key", () => {
  assert.equal(SLEEP_STORAGE_KEY, "agent-fit-trace.health.sleep.v1");
});

test("formatSleepHoursText renders one decimal", () => {
  assert.equal(formatSleepHoursText(7.5166), "7.5");
  assert.equal(formatSleepHoursText(8), "8.0");
  assert.equal(formatSleepHoursText(0.04), "0.0");
});

test("parseManualSleepHours accepts hours in (0, 24] and canonicalizes them", () => {
  assert.deepEqual(parseManualSleepHours("7"), { ok: true, hours: 7, hoursText: "7.0" });
  assert.deepEqual(parseManualSleepHours("7.5"), { ok: true, hours: 7.5, hoursText: "7.5" });
  assert.deepEqual(parseManualSleepHours(" 6.25 "), {
    ok: true,
    hours: 6.3,
    hoursText: "6.3",
  });
  assert.deepEqual(parseManualSleepHours("24"), { ok: true, hours: 24, hoursText: "24.0" });
});

test("parseManualSleepHours rejects blank, unparsable, out-of-bounds and round-to-zero input", () => {
  assert.equal(parseManualSleepHours("").ok, false);
  assert.equal(parseManualSleepHours("   ").ok, false);
  assert.equal(parseManualSleepHours("abc").ok, false);
  assert.equal(parseManualSleepHours("0").ok, false);
  assert.equal(parseManualSleepHours("-1").ok, false);
  assert.equal(parseManualSleepHours("24.1").ok, false);
  assert.equal(parseManualSleepHours("0.04").ok, false);
  assert.equal(parseManualSleepHours("Infinity").ok, false);
});

test("parseSleepStore treats a missing value as an empty history", () => {
  assert.deepEqual(parseSleepStore(null), []);
  assert.deepEqual(parseSleepStore(undefined), []);
  // An explicit empty history parses to an empty list.
  assert.deepEqual(parseSleepStore("[]"), []);
});

test("parseSleepStore round-trips through serializeSleepStore", () => {
  const stored = [entry({ date: "2026-10-24" }), entry({ date: "2026-10-25", source: "manual", sessionCount: 0 })];
  assert.deepEqual(parseSleepStore(serializeSleepStore(stored)), stored);
});

test("parseSleepStore throws with the entry index on malformed payloads", () => {
  assert.throws(() => parseSleepStore("{ not json"), /not valid JSON/);
  assert.throws(() => parseSleepStore("{}"), /expected an array/);
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), date: "2026-2-5" }])),
    /entry 0.*YYYY-MM-DD/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), hours: 0 }])),
    /entry 0.*hours/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), hours: 25 }])),
    /entry 0.*hours/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), hoursText: "9.9" }])),
    /entry 0.*hoursText/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), sessionCount: -1 }])),
    /entry 0.*sessionCount/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), sessionCount: 1.5 }])),
    /entry 0.*sessionCount/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), importedAt: "yesterday" }])),
    /entry 0.*importedAt/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), source: "samsung" }])),
    /entry 0.*source/,
  );
  assert.throws(() => parseSleepStore(JSON.stringify(["nope"])), /entry 0.*expected an object/);
  // The second entry's index is named, not just the first failure shape.
  assert.throws(
    () =>
      parseSleepStore(
        JSON.stringify([entry({ date: "2026-10-24" }), { ...entry({ date: "2026-10-25" }), source: 42 }]),
      ),
    /entry 1.*source/,
  );
});

test("parseSleepStore names the index of an entry missing a field", () => {
  // Strict, not tolerant: a stored entry missing any one of its fields is a
  // corrupt store — the failure names the entry index and the missing field.
  const withMissingField = (field: string): string =>
    JSON.stringify([
      entry({ date: "2026-10-24" }),
      Object.fromEntries(
        Object.entries(entry({ date: "2026-10-25" })).filter(([key]) => key !== field),
      ),
    ]);
  assert.throws(() => parseSleepStore(withMissingField("date")), /entry 1.*date/);
  assert.throws(() => parseSleepStore(withMissingField("hours")), /entry 1.*hours/);
  assert.throws(() => parseSleepStore(withMissingField("hoursText")), /entry 1.*hoursText/);
  assert.throws(
    () => parseSleepStore(withMissingField("sessionCount")),
    /entry 1.*sessionCount/,
  );
  assert.throws(() => parseSleepStore(withMissingField("importedAt")), /entry 1.*importedAt/);
  assert.throws(() => parseSleepStore(withMissingField("source")), /entry 1.*source/);
});

test("upsertSleepEntry replaces by wake-up date and never duplicates", () => {
  const existing = [entry({ date: "2026-10-24", hours: 6 }), entry({ date: "2026-10-25", hours: 7.5 })];
  const next = upsertSleepEntry(existing, entry({ date: "2026-10-25", hours: 8 }));
  assert.equal(next.length, 2);
  assert.deepEqual(
    next.filter((night) => night.date === "2026-10-25").map((night) => night.hours),
    [8],
  );
  // The input array is never mutated.
  assert.equal(existing[1]!.hours, 7.5);
  const appended = upsertSleepEntry(existing, entry({ date: "2026-10-26", hours: 6.5 }));
  assert.equal(appended.length, 3);
});

test("removeSleepEntry deletes one date and is a no-op for unknown dates", () => {
  const existing = [entry({ date: "2026-10-24" }), entry({ date: "2026-10-25" })];
  assert.deepEqual(
    removeSleepEntry(existing, "2026-10-24").map((night) => night.date),
    ["2026-10-25"],
  );
  assert.deepEqual(removeSleepEntry(existing, "2026-10-01").length, 2);
});

test("manual and Health Connect entries coexist in one history", () => {
  const imported = entry({ date: "2026-10-24", hours: 7.25, sessionCount: 3 });
  const manual = entry({ date: "2026-10-25", hours: 6, sessionCount: 0, source: "manual" });
  const stored = upsertSleepEntry(upsertSleepEntry([], imported), manual);
  assert.equal(stored.length, 2);
  // Both sources survive the strict round-trip unchanged.
  assert.deepEqual(parseSleepStore(serializeSleepStore(stored)), stored);
  // Newest night first, mixed sources, each entry keeping its own.
  assert.deepEqual(
    listSleepEntriesDesc(stored).map((night) => [night.date, night.source]),
    [
      ["2026-10-25", "manual"],
      ["2026-10-24", "health-connect"],
    ],
  );
  // Re-saving a night manually replaces the imported entry for that date —
  // one entry per night, and the replacing entry carries its own source.
  const resaved = upsertSleepEntry(
    stored,
    entry({ date: "2026-10-24", hours: 7, sessionCount: 0, source: "manual" }),
  );
  assert.equal(resaved.length, 2);
  assert.deepEqual(
    resaved
      .filter((night) => night.date === "2026-10-24")
      .map((night) => [night.source, night.sessionCount]),
    [["manual", 0]],
  );
});

test("listSleepEntriesDesc sorts newest night first", () => {
  const sorted = listSleepEntriesDesc([
    entry({ date: "2026-10-24" }),
    entry({ date: "2026-10-26" }),
    entry({ date: "2026-10-25" }),
  ]);
  assert.deepEqual(
    sorted.map((night) => night.date),
    ["2026-10-26", "2026-10-25", "2026-10-24"],
  );
});

test("resolveAttachableSleep returns the recorded night for a valid date", () => {
  const nights = [entry({ date: "2026-10-24", hours: 6 }), entry({ date: "2026-10-25", hours: 7.5 })];
  // A hit returns the stored entry, `hoursText` ready for the draft field.
  const hit = resolveAttachableSleep("2026-10-25", nights);
  assert.equal(hit?.hours, 7.5);
  assert.equal(hit?.hoursText, "7.5");
  // A miss and an empty store attach nothing.
  assert.equal(resolveAttachableSleep("2026-10-01", nights), undefined);
  assert.equal(resolveAttachableSleep("2026-10-25", []), undefined);
  // An invalid draft date attaches nothing instead of matching loosely —
  // both a malformed shape and a regex-valid but impossible calendar date.
  assert.equal(resolveAttachableSleep("2026-2-5", nights), undefined);
  assert.equal(resolveAttachableSleep("2026-13-01", nights), undefined);
  assert.equal(resolveAttachableSleep("2026-02-30", nights), undefined);
  assert.equal(resolveAttachableSleep("", nights), undefined);
});

test("createSleepStore reads empty from missing storage and persists upserts", async () => {
  const fake = memoryStorage();
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  assert.deepEqual(await store.read(), []);
  const stored = await store.upsert(entry({ date: "2026-10-25" }));
  assert.deepEqual(stored.map((night) => night.date), ["2026-10-25"]);
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(JSON.parse(fake.dump(SLEEP_STORAGE_KEY)!), stored);
  // The memory cache answers later reads without another storage round-trip.
  assert.deepEqual(await store.read(), stored);
});

test("createSleepStore upsert replaces an existing night in storage", async () => {
  const fake = memoryStorage({
    [SLEEP_STORAGE_KEY]: serializeSleepStore([entry({ date: "2026-10-25", hours: 7.5 })]),
  });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  await store.upsert(entry({ date: "2026-10-25", hours: 8 }));
  const persisted = JSON.parse(fake.dump(SLEEP_STORAGE_KEY)!) as SleepEntry[];
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.hours, 8);
});

test("createSleepStore.remove persists the deletion", async () => {
  const fake = memoryStorage({
    [SLEEP_STORAGE_KEY]: serializeSleepStore([
      entry({ date: "2026-10-24" }),
      entry({ date: "2026-10-25" }),
    ]),
  });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  const stored = await store.remove("2026-10-24");
  assert.deepEqual(stored.map((night) => night.date), ["2026-10-25"]);
  assert.deepEqual(JSON.parse(fake.dump(SLEEP_STORAGE_KEY)!), stored);
});

test("a failed persistence rolls the memory value back and rethrows", async () => {
  let failWrites = true;
  const failing: SleepStorageLike = {
    async getItem() {
      return null;
    },
    async setItem() {
      if (failWrites) throw new Error("disk full");
    },
  };
  const store = createSleepStore(failing, SLEEP_STORAGE_KEY);
  await assert.rejects(store.upsert(entry({ date: "2026-10-25" })), /disk full/);
  // The rolled-back memory state must not leak the failed entry into a later
  // read once storage works again.
  failWrites = false;
  assert.deepEqual(await store.read(), []);
});

test("a corrupt stored payload reads as empty and is replaced by the next write", async () => {
  const fake = memoryStorage({ [SLEEP_STORAGE_KEY]: "{ not json" });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  assert.deepEqual(await store.read(), []);
  const stored = await store.upsert(entry({ date: "2026-10-25", hours: 6 }));
  assert.deepEqual(JSON.parse(fake.dump(SLEEP_STORAGE_KEY)!), stored);
});

test("an unreadable store reads as empty on the write path instead of losing data twice", async () => {
  const fake = memoryStorage({ [SLEEP_STORAGE_KEY]: "{ not json" });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  const stored = await store.upsert(entry({ date: "2026-10-25" }));
  // The corrupt payload was replaced by a valid one-entry history.
  assert.equal(stored.length, 1);
});
