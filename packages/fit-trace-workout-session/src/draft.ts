/**
 * Draft construction and deterministic key allocation.
 *
 * The reducer owns key allocation: an add action carries no key, and the
 * reducer asks {@link allocateKey} for the next one. That keeps keys out of the
 * persisted payload and makes the same action sequence produce the same draft
 * on every client. There is no module-level counter and no randomness.
 */

import { SESSION_TYPES } from "@agent-fit-trace/core";
import type { SessionDraft, DraftExercise, DraftPain, DraftSet } from "./types.ts";
import { DEFAULT_REST_SECONDS, SESSION_DRAFT_VERSION } from "./types.ts";

/** A blank set with an explicit key. */
export function createDraftSet(key: number): DraftSet {
  return { key, reps: "", weight: "", rpe: "", done: false };
}

/**
 * A blank exercise with one blank set.
 *
 * The exercise claims `key` and its first set claims `key + 1`, so a caller
 * adding an exercise with `allocateKey(draft)` never collides with existing
 * keys.
 */
export function createDraftExercise(key: number): DraftExercise {
  return {
    key,
    name: "",
    restSeconds: DEFAULT_REST_SECONDS,
    sets: [createDraftSet(key + 1)],
  };
}

/** A blank pain report with an explicit key. */
export function createDraftPain(key: number): DraftPain {
  return { key, area: "", level: "" };
}

/**
 * Empty draft for `date`.
 *
 * Starts untimed (`timing: null`), which is the after-the-fact entry mode. The
 * caller supplies the date, normally from {@link todayLocalDate}.
 */
export function createSessionDraft(date: string): SessionDraft {
  return {
    version: SESSION_DRAFT_VERSION,
    date,
    sessionType: SESSION_TYPES[0],
    durationMinutes: "",
    sleepHours: "",
    notes: "",
    exercises: [createDraftExercise(1)],
    pain: [],
    timing: null,
  };
}

/**
 * Next key for this draft: one past the highest exercise, set, or pain key.
 *
 * Keys are allocated but never stored, so the maximum is derived from the
 * current content. Empty drafts return `1`.
 */
export function allocateKey(draft: SessionDraft): number {
  let maxKey = 0;
  for (const exercise of draft.exercises) {
    if (exercise.key > maxKey) maxKey = exercise.key;
    for (const set of exercise.sets) {
      if (set.key > maxKey) maxKey = set.key;
    }
  }
  for (const pain of draft.pain) {
    if (pain.key > maxKey) maxKey = pain.key;
  }
  return maxKey + 1;
}

/**
 * Format a device-local calendar date as `YYYY-MM-DD`, the format the core
 * validator accepts.
 *
 * The clock is injected so screens keep the single `new Date()` call site and
 * tests stay deterministic; the model otherwise never reads a clock.
 */
export function todayLocalDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
