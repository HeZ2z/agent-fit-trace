/**
 * The transient rest machine.
 *
 * Rest is UI state: it lives only in {@link SessionRuntime}, is never written to
 * the persisted draft, and starts empty after a reload. The helpers here are
 * pure: each returns a new runtime, or the same reference when nothing changed
 * so the reducer can skip re-renders.
 *
 * Two shapes are possible for a live {@link RestTimer}:
 * - running: `remainingMs === null`, `endsAtMs` is authoritative;
 * - frozen:  `remainingMs` is the leftover time, `endsAtMs` is stale and ignored
 *   until resume rebuilds it. Freezing keeps the original `endsAtMs` so a pause
 *   does not need to reinterpret the timer; `remainingMs` is the only field the
 *   UI may read while frozen.
 */

import type { RestTimer, SessionRuntime } from "./types.ts";

/** Empty runtime: no rest and no pending rest-ended cue. */
export function createSessionRuntime(): SessionRuntime {
  return { rest: null, restEndedAtMs: null };
}

/** Remaining rest time in milliseconds (zero once the countdown has elapsed). */
export function restRemainingMs(rest: RestTimer, nowMs: number): number {
  return rest.remainingMs ?? Math.max(0, rest.endsAtMs - nowMs);
}

/** Whether `rest` belongs to the given exercise (and set, when provided). */
export function restTargets(
  runtime: SessionRuntime,
  exerciseKey: number,
  setKey?: number,
): boolean {
  const rest = runtime.rest;
  if (rest === null || rest.exerciseKey !== exerciseKey) return false;
  return setKey === undefined || rest.setKey === setKey;
}

/**
 * Start (or replace) a rest countdown for one set.
 *
 * Starting a rest always clears a previous rest-ended cue: the UI plays its
 * notification on the `null` -> number transition of `restEndedAtMs`.
 */
export function startRest(
  runtime: SessionRuntime,
  params: { exerciseKey: number; setKey: number; restSeconds: number; nowMs: number },
): SessionRuntime {
  const { exerciseKey, setKey, restSeconds, nowMs } = params;
  if (!Number.isFinite(restSeconds) || restSeconds <= 0) return runtime;

  const durationMs = Math.round(restSeconds * 1000);
  return {
    rest: {
      exerciseKey,
      setKey,
      durationMs,
      endsAtMs: nowMs + durationMs,
      remainingMs: null,
    },
    restEndedAtMs: null,
  };
}

/** Clear a rest countdown without emitting a rest-ended cue. */
export function clearRest(runtime: SessionRuntime): SessionRuntime {
  if (runtime.rest === null) return runtime;
  return { ...runtime, rest: null };
}

/** Freeze a running rest at a pause, preserving the leftover time. */
export function freezeRest(runtime: SessionRuntime, nowMs: number): SessionRuntime {
  const rest = runtime.rest;
  if (rest === null || rest.remainingMs !== null) return runtime;
  return {
    ...runtime,
    rest: { ...rest, remainingMs: Math.max(0, rest.endsAtMs - nowMs) },
  };
}

/** Rebuild a frozen rest's `endsAtMs` from its leftover time on resume. */
export function resumeRest(runtime: SessionRuntime, nowMs: number): SessionRuntime {
  const rest = runtime.rest;
  if (rest === null || rest.remainingMs === null) return runtime;
  return {
    ...runtime,
    rest: { ...rest, endsAtMs: nowMs + rest.remainingMs, remainingMs: null },
  };
}

/**
 * Settle an elapsed running rest.
 *
 * Frozen rests are ignored (a paused session does not advance rest). The
 * rest-ended cue is recorded exactly once, at the first tick at or after
 * `endsAtMs`; later ticks see no rest and return the same runtime.
 */
export function settleRest(runtime: SessionRuntime, nowMs: number): SessionRuntime {
  const rest = runtime.rest;
  if (rest === null || rest.remainingMs !== null) return runtime;
  if (nowMs < rest.endsAtMs) return runtime;
  return { ...runtime, rest: null, restEndedAtMs: nowMs };
}

/**
 * Shift a rest countdown by `deltaMs` (the UI's +/-15s buttons).
 *
 * A running rest shifts `endsAtMs`; a frozen rest shifts its leftover time
 * instead, because `endsAtMs` is rebuilt on resume. A duration that reaches
 * zero or below clears the rest without a cue. `deltaMs` of zero is a no-op.
 */
export function adjustRest(runtime: SessionRuntime, deltaMs: number): SessionRuntime {
  const rest = runtime.rest;
  if (rest === null || deltaMs === 0 || !Number.isFinite(deltaMs)) return runtime;

  const delta = Math.round(deltaMs);
  const durationMs = rest.durationMs + delta;
  if (durationMs <= 0) return { ...runtime, rest: null };

  if (rest.remainingMs === null) {
    return { ...runtime, rest: { ...rest, durationMs, endsAtMs: rest.endsAtMs + delta } };
  }

  const remainingMs = rest.remainingMs + delta;
  if (remainingMs <= 0) return { ...runtime, rest: null };
  return { ...runtime, rest: { ...rest, durationMs, remainingMs } };
}
