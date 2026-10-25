import AsyncStorageModule from "@react-native-async-storage/async-storage";

import { isIsoDate } from "./healthModel.ts";

/**
 * Device-local sleep history (issue #50 redesign).
 *
 * One versioned AsyncStorage key holds the nights this app recorded — from the
 * Health page's Health Connect import or from a manual entry. The Log screen
 * reads a snapshot of it and, when saving a workout whose draft has no sleep
 * hours, attaches the recorded night through the same draft-edit path a
 * keystroke uses (`resolveAttachableSleep` is the pure attach decision).
 *
 * Like the Health Connect opt-in (`deviceHealth.ts`), the data is a per-device
 * record that must never be mirrored, restored or synced across devices, so it
 * lives in AsyncStorage, not in the account-preferences layer. The storage
 * pattern follows `deviceHealth.ts`: one versioned key over a memory-first
 * store — reads prefer the cached value, and a write applies the memory value
 * first, so a failed persistence rolls back and rethrows instead of leaving
 * the UI showing a state storage never received. A failed read is never turned
 * into an empty history: it propagates with a diagnostic message, and the
 * write path refuses to persist before the existing history was actually read
 * (a transient `getItem` failure plus one save must not delete the history).
 * The pure rules (validation,
 * dedupe, sort, attach decision, manual-hours parsing) sit above the shell so
 * the root `node:test` suite can load them through Node's type stripping.
 */

/** Where one stored night came from. */
export type SleepSource = "health-connect" | "manual";

/** One recorded night, keyed by its wake-up date. */
export interface SleepEntry {
  /**
   * Wake-up date "YYYY-MM-DD" — the D of the night window [D-1 20:00, D 12:00]
   * the sleep was read from.
   */
  date: string;
  /**
   * Sleep hours rounded to one decimal; 0 <= hours <= 24. 0.0 is a legal
   * "fully awake" night (`aggregateSleepHours` can legitimately yield it when
   * a night holds only awake stages), so both the write and the read side
   * accept it — a read that rejected zero hours would hide the entry.
   */
  hours: number;
  /** One-decimal rendering of `hours`, ready for the Log draft's `sleepHours`. */
  hoursText: string;
  /** Health Connect sessions summed into this night (0 for a manual entry). */
  sessionCount: number;
  /** ISO timestamp of the write that stored this entry. */
  importedAt: string;
  source: SleepSource;
}

/** Versioned key so a future migration can coexist with v1. */
export const SLEEP_STORAGE_KEY = "agent-fit-trace.health.sleep.v1";

/** The stored sources, mirrored as a plain list for strict parsing. */
const SLEEP_SOURCES: readonly SleepSource[] = ["health-connect", "manual"];

/** One-decimal hours string, e.g. 7.5166… → "7.5". */
export function formatSleepHoursText(hours: number): string {
  return (Math.round(hours * 10) / 10).toFixed(1);
}

/** Result of parsing one manual sleep-hours input. */
export type ManualSleepHoursParse =
  | { ok: true; hours: number; hoursText: string }
  | { ok: false };

/**
 * Parse a manual sleep-hours input strictly: a finite number in (0, 24] (the
 * core domain limit), rounded to one decimal. Blank, unparsable, out-of-bounds
 * and round-to-zero inputs fail; everything else yields the canonical
 * `hours`/`hoursText` pair.
 */
export function parseManualSleepHours(text: string): ManualSleepHoursParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false };
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return { ok: false };
  const rounded = Math.round(hours * 10) / 10;
  if (rounded <= 0) return { ok: false };
  return { ok: true, hours: rounded, hoursText: formatSleepHoursText(rounded) };
}

/**
 * Validate one parsed entry and fail loudly, naming the entry index — the
 * stored history is re-validated on every read, so a malformed entry is a
 * corrupt store, never silently dropped data.
 */
function parseSleepEntry(candidate: unknown, index: number): SleepEntry {
  const where = `sleep store entry ${index}`;
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error(`Corrupt ${where}: expected an object`);
  }
  const entry = candidate as Record<string, unknown>;
  const date = entry.date;
  if (typeof date !== "string" || !isIsoDate(date)) {
    throw new Error(`Corrupt ${where}: date is not a valid YYYY-MM-DD string`);
  }
  const hours = entry.hours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error(`Corrupt ${where}: hours must be a number in [0, 24]`);
  }
  const hoursText = entry.hoursText;
  if (typeof hoursText !== "string" || hoursText !== formatSleepHoursText(hours)) {
    throw new Error(`Corrupt ${where}: hoursText must be the one-decimal form of hours`);
  }
  const sessionCount = entry.sessionCount;
  if (
    typeof sessionCount !== "number" ||
    !Number.isInteger(sessionCount) ||
    sessionCount < 0
  ) {
    throw new Error(`Corrupt ${where}: sessionCount must be a non-negative integer`);
  }
  const importedAt = entry.importedAt;
  if (typeof importedAt !== "string" || Number.isNaN(Date.parse(importedAt))) {
    throw new Error(`Corrupt ${where}: importedAt must be an ISO timestamp string`);
  }
  const source = entry.source;
  if (source !== "health-connect" && source !== "manual") {
    throw new Error(`Corrupt ${where}: source must be "health-connect" or "manual"`);
  }
  return {
    date,
    hours,
    hoursText,
    sessionCount,
    importedAt,
    source,
  };
}

/**
 * The stored payload: the night history plus a storage-level revision. The
 * revision exists so a caller can take an optimistic lock over the whole
 * history — the Health page's import captures it before its slow Health
 * Connect read and hands it back for a conditional write (see
 * `upsertIfUnchanged`). Unlike a per-night token, it also covers a deletion of
 * the locked night itself: "never existed" and "existed and was deleted since"
 * are distinguishable, so a late import can no longer resurrect a deleted
 * night (issue #50). Every `upsert`/`remove` increments it.
 */
export interface SleepStorePayload {
  revision: number;
  entries: SleepEntry[];
}

/**
 * Strict parse of the stored payload: a missing value is an empty history at
 * revision 0; anything present but malformed throws instead of losing data
 * silently. The one tolerated gap is `revision` itself — a payload without it
 * (a v1 bare array of entries, or an object written before the field existed)
 * reads as revision 0 and upgrades to the wrapped shape on the next write.
 */
export function parseSleepStorePayload(raw: string | null | undefined): SleepStorePayload {
  if (raw === null || raw === undefined) return { revision: 0, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Corrupt sleep store: payload is not valid JSON");
  }
  // A v1 payload was a bare array of entries: upgrade it in place.
  if (Array.isArray(parsed)) {
    return {
      revision: 0,
      entries: parsed.map((candidate, index) => parseSleepEntry(candidate, index)),
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Corrupt sleep store: expected a { revision, entries } payload");
  }
  const payload = parsed as Record<string, unknown>;
  const rawRevision = payload.revision;
  let revision = 0;
  if (rawRevision !== undefined) {
    if (typeof rawRevision !== "number" || !Number.isInteger(rawRevision) || rawRevision < 0) {
      throw new Error("Corrupt sleep store: revision must be a non-negative integer");
    }
    revision = rawRevision;
  }
  if (!Array.isArray(payload.entries)) {
    throw new Error("Corrupt sleep store: entries must be an array of entries");
  }
  return {
    revision,
    entries: payload.entries.map((candidate, index) => parseSleepEntry(candidate, index)),
  };
}

/**
 * Entries-only parse view, kept for callers that just need the history. The
 * revision is dropped; use `parseSleepStorePayload` for the optimistic lock.
 */
export function parseSleepStore(raw: string | null | undefined): SleepEntry[] {
  return parseSleepStorePayload(raw).entries;
}

/** Canonical serialized form of the stored payload. */
export function serializeSleepStorePayload(payload: SleepStorePayload): string {
  return JSON.stringify({ revision: payload.revision, entries: payload.entries });
}

/**
 * Serialized form of a bare history, at revision 0 — a fixture/compat helper
 * for callers that only hold entries and do not need to pin a revision.
 */
export function serializeSleepStore(entries: readonly SleepEntry[]): string {
  return serializeSleepStorePayload({ revision: 0, entries: [...entries] });
}

/**
 * Insert or replace one night, deduped by wake-up date: re-importing (or
 * manually re-saving) a night replaces the earlier entry for the same date,
 * never appends a duplicate.
 */
export function upsertSleepEntry(
  entries: readonly SleepEntry[],
  entry: SleepEntry,
): SleepEntry[] {
  return [...entries.filter((existing) => existing.date !== entry.date), entry];
}

/** Remove the entry for one wake-up date (a no-op when the date is not stored). */
export function removeSleepEntry(
  entries: readonly SleepEntry[],
  date: string,
): SleepEntry[] {
  return entries.filter((existing) => existing.date !== date);
}

/** The history newest night first; ISO dates sort lexicographically. */
export function listSleepEntriesDesc(entries: readonly SleepEntry[]): SleepEntry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * The attach decision behind the Log screen's auto-attach: the recorded night
 * for `date`, or undefined when the date is invalid or no night was recorded.
 * Whether the draft's own sleep field is empty is the caller's decision — the
 * stored value only ever fills an empty field, never overrides a typed one.
 */
export function resolveAttachableSleep(
  date: string,
  entries: readonly SleepEntry[],
): SleepEntry | undefined {
  if (!isIsoDate(date)) return undefined;
  return entries.find((entry) => entry.date === date);
}

/** The storage surface this module uses (same shape as `deviceHealth.ts`). */
export interface SleepStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Message for a storage failure; never empty. */
function storageErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "unknown storage error";
}

/**
 * Memory-first sleep store over one storage key. `read` prefers the cached
 * value and only falls back to storage once. A failed read (storage error or
 * corrupt payload) propagates with a diagnostic message instead of reading as
 * an empty history — the write path reads through the same function, so it
 * refuses to persist before the existing history was actually confirmed, and
 * a transient read failure can never be followed by an overwriting save.
 * `upsert`/`remove` apply the memory value first and only then persist; a
 * failed persistence rolls the memory value back and rethrows, so callers can
 * surface the failure instead of the UI showing a state storage never
 * received. Mutations run single-flight: each completes its read, transform
 * and memory swap before the next mutation starts, so a conditional write
 * such as `upsertIfUnchanged` can never have its check and its write split by
 * an interleaved mutation.
 */
export interface SleepStore {
  read(): Promise<SleepEntry[]>;
  /**
   * The current storage-level revision — the token callers capture for the
   * optimistic lock in `upsertIfUnchanged`. Every mutation bumps it by one.
   */
  readRevision(): Promise<number>;
  upsert(entry: SleepEntry): Promise<SleepEntry[]>;
  remove(date: string): Promise<SleepEntry[]>;
  /**
   * Conditional upsert guarded by a store-level optimistic lock: `expected`
   * is the revision the caller captured before its slow work. The revision is
   * re-checked against the current payload inside the same single-flight step
   * that writes, closing the check-then-write race; a mismatch returns `null`
   * and writes nothing. The lock is deliberately coarse: any mutation since
   * the capture — including one to an unrelated night — voids the write.
   * That is conservative (a slow import can be discarded over an unrelated
   * save, costing one retry), but it is the only token that distinguishes
   * "the night never existed" from "the night was deleted during the work",
   * so a late write can never resurrect a deleted night (issue #50).
   */
  upsertIfUnchanged(entry: SleepEntry, expectedRevision: number): Promise<SleepEntry[] | null>;
}

export function createSleepStore(storage: SleepStorageLike, key: string): SleepStore {
  /** `null` until the first successful storage read populates the cache. */
  let memoryPayload: SleepStorePayload | null = null;

  /**
   * The single-flight chain: every mutation is appended after the previous
   * one settles (rejections included), so at most one mutation is between
   * its read and its memory swap at any time.
   */
  let mutationTail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(task, task);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The current payload, hydrating the cache from storage on first touch.
   * Failures propagate (diagnostic storage error, or the strict parse's
   * corrupt-store error naming the entry) and leave the cache untouched, so a
   * later read retries instead of pinning the failure.
   */
  async function currentPayload(): Promise<SleepStorePayload> {
    if (memoryPayload !== null) return memoryPayload;
    let raw: string | null;
    try {
      raw = await storage.getItem(key);
    } catch (cause) {
      throw new Error(`Could not read the sleep store: ${storageErrorMessage(cause)}`);
    }
    memoryPayload = parseSleepStorePayload(raw);
    return memoryPayload;
  }

  /**
   * Apply one transform memory-first, persisting with rollback on failure.
   * Every mutation bumps the storage-level revision, so captured revisions
   * go stale across any write.
   */
  async function apply(
    transform: (payload: SleepStorePayload) => SleepEntry[],
  ): Promise<SleepEntry[]> {
    const previous = memoryPayload;
    const payload = await currentPayload();
    const next: SleepStorePayload = {
      revision: payload.revision + 1,
      entries: transform(payload),
    };
    memoryPayload = next;
    try {
      await storage.setItem(key, serializeSleepStorePayload(next));
    } catch (cause) {
      memoryPayload = previous;
      throw cause;
    }
    return next.entries;
  }

  return {
    read(): Promise<SleepEntry[]> {
      return currentPayload().then((payload) => payload.entries);
    },
    readRevision(): Promise<number> {
      return currentPayload().then((payload) => payload.revision);
    },
    upsert(entry: SleepEntry): Promise<SleepEntry[]> {
      return exclusive(() => apply((payload) => upsertSleepEntry(payload.entries, entry)));
    },
    remove(date: string): Promise<SleepEntry[]> {
      return exclusive(() => apply((payload) => removeSleepEntry(payload.entries, date)));
    },
    upsertIfUnchanged(
      entry: SleepEntry,
      expectedRevision: number,
    ): Promise<SleepEntry[] | null> {
      return exclusive(async () => {
        const payload = await currentPayload();
        // The store moved on since the caller captured the revision: the late
        // write is discarded, never persisted.
        if (payload.revision !== expectedRevision) return null;
        return apply((current) => upsertSleepEntry(current.entries, entry));
      });
    },
  };
}

/**
 * The AsyncStorage instance, unwrapped once — same Metro/NodeNext interop shim
 * as `deviceHealth.ts`.
 */
const AsyncStorage: SleepStorageLike = (() => {
  const candidate = AsyncStorageModule as unknown as SleepStorageLike & {
    default?: SleepStorageLike;
  };
  return candidate.default ?? candidate;
})();

/** The app-wide sleep store (one memory cache per launch). */
const store = createSleepStore(AsyncStorage, SLEEP_STORAGE_KEY);

/** Read the stored history (memory-first; a failed read rejects — surface it). */
export function readSleepEntries(): Promise<SleepEntry[]> {
  return store.read();
}

/**
 * Read the current storage-level revision (memory-first): the token to capture
 * before slow work and hand back to `saveSleepEntryIfUnchanged`.
 */
export function readSleepStoreRevision(): Promise<number> {
  return store.readRevision();
}

/** Insert or replace one night; resolves with the updated history. */
export function saveSleepEntry(entry: SleepEntry): Promise<SleepEntry[]> {
  return store.upsert(entry);
}

/**
 * Conditional save guarded by the store-level optimistic lock: writes only
 * when the store's current revision still equals `expectedRevision` (the value
 * captured from `readSleepStoreRevision` before the slow work); otherwise
 * resolves `null` with the stored history untouched. The lock is coarse — a
 * mutation to any night voids the write — which is conservative but the only
 * way to never resurrect a night deleted during the work (issue #50).
 */
export function saveSleepEntryIfUnchanged(
  entry: SleepEntry,
  expectedRevision: number,
): Promise<SleepEntry[] | null> {
  return store.upsertIfUnchanged(entry, expectedRevision);
}

/** Delete the entry for one wake-up date; resolves with the updated history. */
export function deleteSleepEntry(date: string): Promise<SleepEntry[]> {
  return store.remove(date);
}
