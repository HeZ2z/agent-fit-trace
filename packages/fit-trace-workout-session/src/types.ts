/**
 * Draft model for the unified workout session shared by the web and mobile
 * editors, plus the transient runtime state that never leaves memory.
 *
 * A single {@link SessionDraft} represents both an after-the-fact log and a
 * live session: `timing === null` means the session was never started, so the
 * user is filling it in afterwards. Every mutation goes through the pure
 * reducer in `reducer.ts`; this module never reads a clock and never allocates
 * keys from ambient state.
 *
 * `SessionDraft` is the persistence boundary. {@link SessionRuntime} (rest
 * timers and the rest-ended cue) is ephemeral and must never be serialized:
 * reloading or restoring a draft always starts with an empty runtime.
 */

import type { SessionType } from "@agent-fit-trace/core";

/** The only draft payload version this package understands. */
export const SESSION_DRAFT_VERSION = 1;

/** Rest between sets used when an exercise is added, in seconds. */
export const DEFAULT_REST_SECONDS = 90;

/** One editable set. Numeric fields stay strings so partial input is never lost. */
export interface DraftSet {
  key: number;
  reps: string;
  weight: string;
  rpe: string;
  /**
   * Checked-off marker for a live session. Only meaningful when the draft has
   * `timing !== null`; the reducer ignores toggles on an untimed draft.
   */
  done: boolean;
}

/** One editable exercise. `key` is unique across the whole draft. */
export interface DraftExercise {
  key: number;
  name: string;
  /** Rest after checking a set, in seconds. `0` disables the rest timer. */
  restSeconds: number;
  sets: DraftSet[];
}

/** One editable pain report. `key` is unique across the whole draft. */
export interface DraftPain {
  key: number;
  area: string;
  level: string;
}

/**
 * Persisted timing for a started session.
 *
 * All values are epoch milliseconds supplied by the UI; the model never reads a
 * clock. `endedAtMs` freezes the duration on finish, and `lastActiveAtMs` is
 * the point a restored session is auto-paused at so time while the app was
 * closed is never counted.
 */
export interface SessionTiming {
  startedAtMs: number;
  endedAtMs: number | null;
  pausedAtMs: number | null;
  pausedTotalMs: number;
  lastActiveAtMs: number;
}

/** The persisted session draft. This is the only state written to storage. */
export interface SessionDraft {
  version: typeof SESSION_DRAFT_VERSION;
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  sessionType: SessionType;
  /** Manually entered duration; only meaningful when `timing === null`. */
  durationMinutes: string;
  sleepHours: string;
  notes: string;
  exercises: DraftExercise[];
  pain: DraftPain[];
  /** `null` means the session was never started (after-the-fact entry). */
  timing: SessionTiming | null;
}

/**
 * A running (or paused) rest countdown.
 *
 * `endsAtMs` is authoritative while running; pausing freezes the leftover time
 * in `remainingMs` and resuming rebuilds `endsAtMs` from it. The timer belongs
 * to {@link SessionRuntime}, so it is never persisted.
 */
export interface RestTimer {
  /** Exercise whose set started this rest. */
  exerciseKey: number;
  /** Set that started this rest. */
  setKey: number;
  /** Full rest length, so the UI can render a progress bar. */
  durationMs: number;
  endsAtMs: number;
  /** Leftover time frozen while the session is paused; `null` while running. */
  remainingMs: number | null;
}

/** Rest-related transient state. Never serialized. */
export interface SessionRuntime {
  rest: RestTimer | null;
  /**
   * Set once when a rest countdown elapses, so the UI can play the
   * rest-ended cue on the `null` -> number transition instead of every tick.
   */
  restEndedAtMs: number | null;
}

/**
 * Derived view of a session. `resting` is not persisted: it is an active
 * session with a live {@link RestTimer}.
 */
export type SessionPhase = "editing" | "active" | "paused" | "finished" | "resting";

/** Everything a session editor needs: the persisted draft plus transient runtime. */
export interface SessionState {
  draft: SessionDraft;
  runtime: SessionRuntime;
}
