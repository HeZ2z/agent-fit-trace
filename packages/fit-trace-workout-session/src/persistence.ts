/**
 * Persistence boundary for the session draft.
 *
 * Only the draft is encoded; {@link SessionRuntime} (rest countdown and the
 * rest-ended cue) is transient and never serialized. Payloads are canonical
 * JSON (`stableStringify`), so equal drafts encode byte-for-byte identically.
 *
 * Decoding is strict about STRUCTURE and permissive about EDITABILITY: it
 * verifies versions, types, arrays, unique keys and timing consistency, but it
 * deliberately does NOT run core record validation. A draft can be mid-edit
 * with an empty date, a blank exercise name or unparsable numeric strings, and
 * restoring it must not discard the user's in-progress work; the core validator
 * runs later, on save.
 *
 * Versioning fails closed: there is no migration path. A payload from another
 * version (older or newer) throws {@link SessionDraftCorruptionError} with code
 * `CORRUPT_DRAFT` and the UI must offer an explicit discard, never a silent fix.
 */

import { SESSION_TYPES, stableStringify } from "@agent-fit-trace/core";
import type { SessionType } from "@agent-fit-trace/core";
import { SESSION_DRAFT_VERSION } from "./types.ts";
import type { DraftExercise, DraftPain, DraftSet, SessionDraft, SessionTiming } from "./types.ts";

/** Stable error code for unreadable or unsupported draft payloads. */
export const CORRUPT_SESSION_DRAFT = "CORRUPT_DRAFT";

/** Thrown when a persisted draft payload cannot be trusted. */
export class SessionDraftCorruptionError extends Error {
  readonly code = CORRUPT_SESSION_DRAFT;
  readonly details: Record<string, unknown>;

  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(`Corrupt session draft: ${reason}`);
    this.name = "SessionDraftCorruptionError";
    this.details = details;
  }
}

const DRAFT_KEYS = [
  "version",
  "date",
  "sessionType",
  "durationMinutes",
  "sleepHours",
  "notes",
  "exercises",
  "pain",
  "timing",
] as const;

const EXERCISE_KEYS = ["key", "name", "restSeconds", "sets"] as const;
const SET_KEYS = ["key", "reps", "weight", "rpe", "done", "prefilled"] as const;
const PAIN_KEYS = ["key", "area", "level"] as const;
const TIMING_KEYS = [
  "startedAtMs",
  "endedAtMs",
  "pausedAtMs",
  "pausedTotalMs",
  "lastActiveAtMs",
] as const;

function corrupt(reason: string): SessionDraftCorruptionError {
  return new SessionDraftCorruptionError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw corrupt(`${path} must be an object`);
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw corrupt(`${path} must be an array`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw corrupt(`${path} must be a string`);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw corrupt(`${path} must be a boolean`);
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw corrupt(`${path} must be a finite number`);
  }
  return value;
}

function requireNullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return requireFiniteNumber(value, path);
}

function requireInteger(value: unknown, path: string): number {
  const parsed = requireFiniteNumber(value, path);
  if (!Number.isInteger(parsed)) throw corrupt(`${path} must be an integer`);
  return parsed;
}

function requireKey(value: unknown, path: string): number {
  const key = requireInteger(value, path);
  if (key <= 0) throw corrupt(`${path} must be a positive integer`);
  return key;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  const parsed = requireInteger(value, path);
  if (parsed < 0) throw corrupt(`${path} must not be negative`);
  return parsed;
}

function requireSessionType(value: unknown): SessionType {
  if (typeof value !== "string" || !SESSION_TYPES.includes(value as SessionType)) {
    throw corrupt(`payload.sessionType must be one of: ${SESSION_TYPES.join(", ")}`);
  }
  return value as SessionType;
}

/** Reject unknown fields and missing required fields at one structural level. */
function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw corrupt(`unknown field \`${path}.${key}\``);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw corrupt(`missing field \`${path}.${key}\``);
    }
  }
}

function decodeSet(value: unknown, path: string): DraftSet {
  const raw = requireObject(value, path);
  assertExactKeys(raw, SET_KEYS, path);
  return {
    key: requireKey(raw.key, `${path}.key`),
    reps: requireString(raw.reps, `${path}.reps`),
    weight: requireString(raw.weight, `${path}.weight`),
    rpe: requireString(raw.rpe, `${path}.rpe`),
    done: requireBoolean(raw.done, `${path}.done`),
    prefilled: requireBoolean(raw.prefilled, `${path}.prefilled`),
  };
}

function decodeExercise(value: unknown, index: number): DraftExercise {
  const path = `payload.exercises[${index}]`;
  const raw = requireObject(value, path);
  assertExactKeys(raw, EXERCISE_KEYS, path);

  const sets = requireArray(raw.sets, `${path}.sets`).map((entry, setIndex) =>
    decodeSet(entry, `${path}.sets[${setIndex}]`),
  );

  return {
    key: requireKey(raw.key, `${path}.key`),
    name: requireString(raw.name, `${path}.name`),
    restSeconds: requireNonNegativeInteger(raw.restSeconds, `${path}.restSeconds`),
    sets,
  };
}

function decodePain(value: unknown, index: number): DraftPain {
  const path = `payload.pain[${index}]`;
  const raw = requireObject(value, path);
  assertExactKeys(raw, PAIN_KEYS, path);

  return {
    key: requireKey(raw.key, `${path}.key`),
    area: requireString(raw.area, `${path}.area`),
    level: requireString(raw.level, `${path}.level`),
  };
}

function decodeTiming(value: unknown): SessionTiming | null {
  if (value === null) return null;

  const path = "payload.timing";
  const raw = requireObject(value, path);
  assertExactKeys(raw, TIMING_KEYS, path);

  const startedAtMs = requireFiniteNumber(raw.startedAtMs, `${path}.startedAtMs`);
  const endedAtMs = requireNullableNumber(raw.endedAtMs, `${path}.endedAtMs`);
  const pausedAtMs = requireNullableNumber(raw.pausedAtMs, `${path}.pausedAtMs`);
  const pausedTotalMs = requireFiniteNumber(raw.pausedTotalMs, `${path}.pausedTotalMs`);
  const lastActiveAtMs = requireFiniteNumber(raw.lastActiveAtMs, `${path}.lastActiveAtMs`);

  // A timing is editing (null), active, paused or finished — never paused and
  // finished at once. The reducer clears pausedAtMs when finishing.
  if (endedAtMs !== null && pausedAtMs !== null) {
    throw corrupt("timing cannot be both paused and finished");
  }
  if (pausedTotalMs < 0) throw corrupt("payload.timing.pausedTotalMs must not be negative");

  return { startedAtMs, endedAtMs, pausedAtMs, pausedTotalMs, lastActiveAtMs };
}

/** Keys are allocated globally, so any duplicate across the draft is corruption. */
function assertUniqueKeys(draft: SessionDraft): void {
  const seen = new Set<number>();
  const claim = (key: number, path: string): void => {
    if (seen.has(key)) throw corrupt(`duplicate key ${key} at ${path}`);
    seen.add(key);
  };

  draft.exercises.forEach((exercise, exerciseIndex) => {
    claim(exercise.key, `payload.exercises[${exerciseIndex}].key`);
    exercise.sets.forEach((set, setIndex) =>
      claim(set.key, `payload.exercises[${exerciseIndex}].sets[${setIndex}].key`),
    );
  });
  draft.pain.forEach((entry, index) => claim(entry.key, `payload.pain[${index}].key`));
}

/**
 * Canonical JSON for storage. Draft only: the runtime (rest timer) is never
 * passed in, and the draft type has no rest field, so none can be serialized.
 */
export function encodeSessionDraft(draft: SessionDraft): string {
  return stableStringify(draft);
}

/**
 * Parse and structurally validate a persisted draft.
 *
 * Throws {@link SessionDraftCorruptionError} (`CORRUPT_DRAFT`) for malformed
 * JSON, an unsupported version, wrong types, duplicate keys, inconsistent
 * timing or unknown fields. It does not validate workout content: invalid
 * mid-edit drafts are restored so the user does not lose them.
 */
export function decodeSessionDraft(payload: string): SessionDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw corrupt(`payload is not valid JSON (${reason})`);
  }

  const root = requireObject(parsed, "payload");

  if (root.version !== SESSION_DRAFT_VERSION) {
    throw corrupt(
      `unsupported version ${String(root.version)}; expected ${SESSION_DRAFT_VERSION}`,
    );
  }
  assertExactKeys(root, DRAFT_KEYS, "payload");

  const exercises = requireArray(root.exercises, "payload.exercises").map((value, index) =>
    decodeExercise(value, index),
  );
  const pain = requireArray(root.pain, "payload.pain").map((value, index) =>
    decodePain(value, index),
  );

  const draft: SessionDraft = {
    version: SESSION_DRAFT_VERSION,
    date: requireString(root.date, "payload.date"),
    sessionType: requireSessionType(root.sessionType),
    durationMinutes: requireString(root.durationMinutes, "payload.durationMinutes"),
    sleepHours: requireString(root.sleepHours, "payload.sleepHours"),
    notes: requireString(root.notes, "payload.notes"),
    exercises,
    pain,
    timing: decodeTiming(root.timing),
  };

  assertUniqueKeys(draft);
  return draft;
}
