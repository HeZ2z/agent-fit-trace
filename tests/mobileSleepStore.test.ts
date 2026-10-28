import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createSleepStore,
  formatSleepHoursText,
  listSleepEntriesDesc,
  parseManualSleepHours,
  parseSleepStore,
  parseSleepStorePayload,
  removeSleepEntry,
  resolveAttachableSleep,
  SLEEP_STORAGE_KEY,
  serializeSleepStore,
  serializeSleepStorePayload,
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

test("parseSleepStorePayload tolerates a missing revision as 0 and upgrades it", () => {
  // Legacy v1 payloads were bare arrays: they parse at revision 0 and the
  // next write persists the wrapped { revision, entries } shape.
  const legacy = JSON.stringify([entry({ date: "2026-10-25" })]);
  const upgraded = parseSleepStorePayload(legacy);
  assert.equal(upgraded.revision, 0);
  assert.deepEqual(upgraded.entries, [entry({ date: "2026-10-25" })]);
  // An object payload written before the revision field existed reads the
  // same way instead of being treated as corrupt.
  const unwrapped = parseSleepStorePayload(
    JSON.stringify({ entries: [entry({ date: "2026-10-25" })] }),
  );
  assert.equal(unwrapped.revision, 0);
  assert.deepEqual(unwrapped.entries, [entry({ date: "2026-10-25" })]);
  // A revision that is present survives a serialize/parse round-trip.
  const stored = { revision: 7, entries: [entry({ date: "2026-10-25" })] };
  assert.deepEqual(parseSleepStorePayload(serializeSleepStorePayload(stored)), stored);
  assert.deepEqual(parseSleepStore(serializeSleepStorePayload(stored)), stored.entries);
});

test("parseSleepStorePayload rejects a malformed revision", () => {
  const withRevision = (revision: unknown): string =>
    JSON.stringify({ revision, entries: [entry({ date: "2026-10-25" })] });
  assert.throws(
    () => parseSleepStorePayload(withRevision(-1)),
    /revision must be a non-negative integer/,
  );
  assert.throws(
    () => parseSleepStorePayload(withRevision(1.5)),
    /revision must be a non-negative integer/,
  );
  assert.throws(
    () => parseSleepStorePayload(withRevision("3")),
    /revision must be a non-negative integer/,
  );
});

test("parseSleepStore throws with the entry index on malformed payloads", () => {
  assert.throws(() => parseSleepStore("{ not json"), /not valid JSON/);
  assert.throws(() => parseSleepStore("{}"), /entries must be an array/);
  assert.throws(() => parseSleepStore("42"), /expected a \{ revision, entries \} payload/);
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), date: "2026-2-5" }])),
    /entry 0.*YYYY-MM-DD/,
  );
  assert.throws(
    () => parseSleepStore(JSON.stringify([{ ...entry({ date: "2026-10-25" }), hours: -1 }])),
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

test("parseSleepStore accepts a 0.0 fully-awake night and round-trips it", () => {
  // aggregateSleepHours can legitimately yield 0.0 (a night of only awake
  // stages, or a floor to zero), so [0, 24] is the stored domain on both the
  // write and the read side — a read that rejected zero hours would hide the
  // entry from the history and the Log auto-attach.
  const awake = entry({ date: "2026-10-25", hours: 0, sessionCount: 1 });
  assert.equal(awake.hoursText, "0.0");
  assert.deepEqual(parseSleepStore(serializeSleepStore([awake])), [awake]);
  // The 0.0 night is a first-class attach candidate too.
  assert.equal(resolveAttachableSleep("2026-10-25", [awake])?.hoursText, "0.0");
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
  assert.equal(await store.readRevision(), 0);
  const stored = await store.upsert(entry({ date: "2026-10-25" }));
  assert.deepEqual(stored.map((night) => night.date), ["2026-10-25"]);
  assert.equal(fake.writes.length, 1);
  // Every mutation bumps the storage-level revision: one upsert over an empty
  // store lands at revision 1.
  const persisted = parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!);
  assert.equal(persisted.revision, 1);
  assert.deepEqual(persisted.entries, stored);
  // The memory cache answers later reads without another storage round-trip.
  assert.deepEqual(await store.read(), stored);
  assert.equal(await store.readRevision(), 1);
});

test("createSleepStore upsert replaces an existing night in storage", async () => {
  const fake = memoryStorage({
    [SLEEP_STORAGE_KEY]: serializeSleepStore([entry({ date: "2026-10-25", hours: 7.5 })]),
  });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  await store.upsert(entry({ date: "2026-10-25", hours: 8 }));
  const persisted = parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!);
  assert.equal(persisted.entries.length, 1);
  assert.equal(persisted.entries[0]!.hours, 8);
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
  const persisted = parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!);
  assert.deepEqual(persisted.entries, stored);
  assert.equal(persisted.revision, 1);
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

test("a corrupt stored payload surfaces on read and a write refuses to overwrite it", async () => {
  const fake = memoryStorage({ [SLEEP_STORAGE_KEY]: "{ not json" });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  // The read propagates the corruption instead of reading as empty history.
  await assert.rejects(store.read(), /Corrupt sleep store/);
  // The write path confirms the existing history first, so a failed read can
  // never be followed by an overwriting save (one bad read + one save must
  // not delete the history).
  await assert.rejects(store.upsert(entry({ date: "2026-10-25" })), /Corrupt sleep store/);
  await assert.rejects(store.remove("2026-10-25"), /Corrupt sleep store/);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.dump(SLEEP_STORAGE_KEY), "{ not json");
});

test("a failing storage read propagates a diagnostic error and the write path refuses to write blind", async () => {
  const writes: string[] = [];
  let failReads = true;
  const flaky: SleepStorageLike = {
    async getItem() {
      if (failReads) throw new Error("transient getItem failure");
      return null;
    },
    async setItem(_key, value) {
      writes.push(value);
    },
  };
  const store = createSleepStore(flaky, SLEEP_STORAGE_KEY);
  await assert.rejects(
    store.read(),
    /Could not read the sleep store: transient getItem failure/,
  );
  // The upsert throws (and writes nothing) instead of treating the failed
  // read as an empty history and overwriting the stored payload.
  await assert.rejects(store.upsert(entry({ date: "2026-10-25" })), /transient getItem failure/);
  assert.equal(writes.length, 0);
  // The failure was never cached: once the read succeeds the store behaves
  // normally.
  failReads = false;
  const stored = await store.upsert(entry({ date: "2026-10-25" }));
  assert.deepEqual(stored.map((night) => night.date), ["2026-10-25"]);
  assert.equal(writes.length, 1);
  assert.deepEqual(parseSleepStorePayload(writes[0]!).entries, stored);
});

/* ── store-level optimistic lock (upsertIfUnchanged) ─────────────── */

test("upsertIfUnchanged writes when the captured revision still matches", async () => {
  const baseline = entry({ date: "2026-10-25", hours: 7.5 });
  const fake = memoryStorage({ [SLEEP_STORAGE_KEY]: serializeSleepStore([baseline]) });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  const capturedRevision = await store.readRevision();
  const stored = await store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 8, importedAt: "2026-10-25T09:00:00.000Z" }),
    capturedRevision,
  );
  assert.ok(stored !== null);
  assert.deepEqual(
    stored.filter((night) => night.date === "2026-10-25").map((night) => night.hours),
    [8],
  );
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!).entries, stored);
  // A revision captured fresh, for a night that is absent, goes through the
  // same way — "no entry for this night" is just the current revision.
  const absent = await store.upsertIfUnchanged(
    entry({ date: "2026-10-26", hours: 6.5, importedAt: "2026-10-26T09:00:00.000Z" }),
    await store.readRevision(),
  );
  assert.ok(absent !== null);
  assert.deepEqual(
    absent.filter((night) => night.date === "2026-10-26").map((night) => night.hours),
    [6.5],
  );
  assert.equal(fake.writes.length, 2);
});

test("upsertIfUnchanged returns null and writes nothing when the night changed meanwhile", async () => {
  // Both "changed meanwhile" shapes run against one store, exactly how the
  // Health page's import races a manual action: the caller captures the
  // revision, the night moves on through the same store, then the conditional
  // write runs against the stale revision.
  const baseline = entry({ date: "2026-10-25", hours: 7.5 });
  const fake = memoryStorage({ [SLEEP_STORAGE_KEY]: serializeSleepStore([baseline]) });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  const capturedRevision = await store.readRevision();

  // Re-saved meanwhile: the night's importedAt moved on.
  await store.upsert(
    entry({ date: "2026-10-25", hours: 6, sessionCount: 0, source: "manual", importedAt: "2026-10-25T10:00:00.000Z" }),
  );
  const resaved = await store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 8, importedAt: "2026-10-25T11:00:00.000Z" }),
    capturedRevision,
  );
  assert.equal(resaved, null);
  assert.equal(fake.writes.length, 1); // only the manual re-save persisted
  assert.deepEqual(
    parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!).entries.map(
      (night) => night.importedAt,
    ),
    ["2026-10-25T10:00:00.000Z"],
  );

  // Deleted and rebuilt meanwhile: the revision differs from the captured one
  // even though a night exists again.
  await store.remove("2026-10-25");
  const rebuilt = entry({ date: "2026-10-25", hours: 5.5, importedAt: "2026-10-25T12:00:00.000Z" });
  await store.upsert(rebuilt);
  const staleAfterRebuild = await store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 8, importedAt: "2026-10-25T13:00:00.000Z" }),
    capturedRevision,
  );
  assert.equal(staleAfterRebuild, null);
  assert.deepEqual(
    parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!).entries.filter(
      (night) => night.date === "2026-10-25",
    ),
    [rebuilt],
  );
});

test("upsertIfUnchanged does not resurrect a night deleted during the import", async () => {
  // The failure shape a per-night token could not cover (issue #50): the
  // caller captured the revision while the night existed, the night was
  // deleted during the slow import, and the late write must stay dead instead
  // of resurrecting it. With a token of "the night's importedAt or null" the
  // deletion looked exactly like "never existed"; the storage revision moves
  // on across the delete, so the stale revision is refused.
  const baseline = entry({ date: "2026-10-25", hours: 7.5 });
  const fake = memoryStorage({ [SLEEP_STORAGE_KEY]: serializeSleepStore([baseline]) });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  const capturedRevision = await store.readRevision();
  await store.remove("2026-10-25");
  const stored = await store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 8, importedAt: "2026-10-25T09:00:00.000Z" }),
    capturedRevision,
  );
  assert.equal(stored, null);
  assert.deepEqual(parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!).entries, []);
});

test("upsertIfUnchanged is voided by a change to an unrelated night (conservatively)", async () => {
  // The store-level lock is deliberately coarse: any mutation bumps the
  // revision, so the late import is discarded even though the night it writes
  // never moved. Conservative but safe — a false "superseded" costs one
  // retry, while a finer token could resurrect a deleted night.
  const target = entry({ date: "2026-10-25", hours: 7.5 });
  const fake = memoryStorage({
    [SLEEP_STORAGE_KEY]: serializeSleepStore([target, entry({ date: "2026-10-24", hours: 6 })]),
  });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  const capturedRevision = await store.readRevision();
  await store.upsert(entry({ date: "2026-10-23", hours: 8, importedAt: "2026-10-23T09:00:00.000Z" }));
  const stored = await store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 9, importedAt: "2026-10-25T09:00:00.000Z" }),
    capturedRevision,
  );
  assert.equal(stored, null);
  const persisted = parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!).entries;
  // The target night still holds its original value.
  assert.deepEqual(
    persisted.filter((night) => night.date === "2026-10-25"),
    [target],
  );
});

test("upsertIfUnchanged returns null when an absent night was created meanwhile", async () => {
  const fake = memoryStorage();
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  // The captured revision says "nothing happened to this store yet"; a manual
  // save during the import bumps it, so the late import must not land over it.
  const capturedRevision = await store.readRevision();
  await store.upsert(
    entry({ date: "2026-10-25", hours: 6, sessionCount: 0, source: "manual", importedAt: "2026-10-25T10:00:00.000Z" }),
  );
  const stored = await store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 8, importedAt: "2026-10-25T11:00:00.000Z" }),
    capturedRevision,
  );
  assert.equal(stored, null);
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(
    parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!).entries.map(
      (night) => night.source,
    ),
    ["manual"],
  );
});

test("mutations run single-flight: a conditional write checks at write time, not at call time", async () => {
  let releaseFirst: (() => void) | undefined;
  const writes: string[] = [];
  const gated: SleepStorageLike = {
    async getItem() {
      return null;
    },
    async setItem(_key, value) {
      if (writes.length === 0) {
        // Hold the first mutation's persist open, mimicking a slow write.
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      writes.push(value);
    },
  };
  const store = createSleepStore(gated, SLEEP_STORAGE_KEY);
  const first = store.upsert(entry({ date: "2026-10-25", importedAt: "2026-10-25T09:00:00.000Z" }));
  // The caller captured revision 0 — the empty store — but by the time the
  // queued conditional write runs, the first mutation has created the night
  // and bumped the revision. The check happens inside the same single-flight
  // step as the write, so it sees the newer revision and refuses, instead of
  // writing on the stale "untouched store" observation.
  const second = store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 8, importedAt: "2026-10-25T11:00:00.000Z" }),
    0,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The first mutation's persist is held open and the second is still queued
  // behind it — nothing else has written.
  assert.ok(releaseFirst !== undefined);
  assert.equal(writes.length, 0);
  releaseFirst!();
  await first;
  assert.equal(await second, null);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    parseSleepStorePayload(writes[0]!).entries.map((night) => night.importedAt),
    ["2026-10-25T09:00:00.000Z"],
  );
});

test("a store over a legacy revision-less payload reads revision 0 and upgrades it on write", async () => {
  // The strict parse tolerates the missing revision as 0 (issue #50): the
  // optimistic lock starts from 0, and the first write persists the wrapped
  // { revision, entries } shape.
  const baseline = entry({ date: "2026-10-25", hours: 7.5 });
  const fake = memoryStorage({
    [SLEEP_STORAGE_KEY]: JSON.stringify([baseline]), // bare v1 array
  });
  const store = createSleepStore(fake.storage, SLEEP_STORAGE_KEY);
  assert.equal(await store.readRevision(), 0);
  assert.deepEqual(await store.read(), [baseline]);
  const stored = await store.upsertIfUnchanged(
    entry({ date: "2026-10-25", hours: 8, importedAt: "2026-10-25T09:00:00.000Z" }),
    0,
  );
  assert.ok(stored !== null);
  const persisted = parseSleepStorePayload(fake.dump(SLEEP_STORAGE_KEY)!);
  assert.equal(persisted.revision, 1);
  assert.deepEqual(
    persisted.entries.filter((night) => night.date === "2026-10-25").map((night) => night.hours),
    [8],
  );
});

/* ── Apple Health source (issue #51) ─────────────────────────────── */

test("an apple-health entry round-trips through the strict store", () => {
  const apple = entry({ date: "2026-10-25", hours: 7.4, sessionCount: 5, source: "apple-health" });
  const payload = serializeSleepStorePayload({ revision: 3, entries: [apple] });
  const parsed = parseSleepStorePayload(payload);
  assert.equal(parsed.revision, 3);
  // The new source is a first-class value: it survives validation unchanged.
  assert.equal(parsed.entries[0].source, "apple-health");
  assert.equal(parsed.entries[0].sessionCount, 5);
});

test("a payload written before apple-health existed still parses unchanged", () => {
  // Regression for the additive source: records stored by the Android-only
  // release carry only "health-connect"/"manual", and must keep loading after
  // the union grew. The strict parse is unchanged for those values.
  const legacy = JSON.stringify({
    revision: 2,
    entries: [
      entry({ date: "2026-10-24", source: "health-connect" }),
      entry({ date: "2026-10-25", hours: 6, sessionCount: 0, source: "manual" }),
    ],
  });
  const parsed = parseSleepStorePayload(legacy);
  assert.equal(parsed.revision, 2);
  assert.deepEqual(
    parsed.entries.map((night) => [night.date, night.source]),
    [
      ["2026-10-24", "health-connect"],
      ["2026-10-25", "manual"],
    ],
  );
  // A v1 bare array of legacy entries upgrades in place, sources intact.
  const legacyArray = JSON.stringify([entry({ date: "2026-10-24", source: "health-connect" })]);
  assert.equal(parseSleepStorePayload(legacyArray).entries[0].source, "health-connect");
});

test("an unknown source is still a corrupt store, never coerced", () => {
  // Growing the union is additive, not permissive: a source string this build
  // does not know stays an error naming the entry, so data is never silently
  // relabeled to a known store.
  assert.throws(
    () => parseSleepStore(JSON.stringify([entry({ date: "2026-10-25", source: "google-fit" as never })])),
    /entry 0.*source/,
  );
});

test("all three sources coexist and each keeps its own label", () => {
  const stored = upsertSleepEntry(
    upsertSleepEntry(
      upsertSleepEntry([], entry({ date: "2026-10-23", source: "health-connect" })),
      entry({ date: "2026-10-24", source: "apple-health" }),
    ),
    entry({ date: "2026-10-25", hours: 6, sessionCount: 0, source: "manual" }),
  );
  assert.deepEqual(
    listSleepEntriesDesc(stored).map((night) => [night.date, night.source]),
    [
      ["2026-10-25", "manual"],
      ["2026-10-24", "apple-health"],
      ["2026-10-23", "health-connect"],
    ],
  );
  // The strict round-trip keeps every source distinct.
  assert.deepEqual(parseSleepStore(serializeSleepStore(stored)), stored);
});

test("an imported apple-health night still auto-attaches to its Log date", () => {
  // The Log's auto-attach is source-agnostic: it fills an empty draft field for
  // the recorded night whatever store produced it.
  const stored = [entry({ date: "2026-10-25", source: "apple-health" })];
  assert.equal(resolveAttachableSleep("2026-10-25", stored)?.source, "apple-health");
  assert.equal(resolveAttachableSleep("2026-10-26", stored), undefined);
});
