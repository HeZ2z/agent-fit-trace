/**
 * Every state transition a session editor can request.
 *
 * The union is intentionally flat and data-only so it can be dispatched from
 * React's `useReducer` (web) or React Native's (mobile) without React types in
 * this package. Draft edits reference existing keys; add actions carry no key
 * because the reducer allocates one. All clock values are injected by the UI as
 * `nowMs`, so the reducer stays pure and testable.
 */

import type { SessionType } from "@agent-fit-trace/core";

/** Free-text or string-typed set fields a set edit can target. */
export type DraftSetField = "reps" | "weight" | "rpe";

/** String-typed pain fields a pain edit can target. */
export type DraftPainField = "area" | "level";

export type SessionAction =
  // Session-level fields.
  | { type: "setDate"; date: string }
  | { type: "setSessionType"; sessionType: SessionType }
  | { type: "setDurationMinutes"; value: string }
  | { type: "setSleepHours"; value: string }
  | { type: "setNotes"; value: string }
  // Exercises.
  | { type: "addExercise" }
  | { type: "removeExercise"; exerciseKey: number }
  | { type: "setExerciseName"; exerciseKey: number; name: string }
  | { type: "setExerciseRestSeconds"; exerciseKey: number; restSeconds: number }
  // Sets.
  | { type: "addSet"; exerciseKey: number }
  | { type: "removeSet"; exerciseKey: number; setKey: number }
  | {
      type: "setSetField";
      exerciseKey: number;
      setKey: number;
      field: DraftSetField;
      value: string;
    }
  | { type: "toggleSetDone"; exerciseKey: number; setKey: number; nowMs: number }
  // Pain reports.
  | { type: "addPain" }
  | { type: "removePain"; painKey: number }
  | { type: "setPainField"; painKey: number; field: DraftPainField; value: string }
  // Persisted timing.
  | { type: "startSession"; nowMs: number }
  | { type: "pauseSession"; nowMs: number }
  | { type: "resumeSession"; nowMs: number }
  | { type: "finishSession"; nowMs: number }
  // Transient rest.
  | { type: "skipRest" }
  | { type: "adjustRest"; deltaMs: number }
  | { type: "tick"; nowMs: number };
