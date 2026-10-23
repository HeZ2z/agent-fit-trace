/**
 * Persisted session timing: start/pause/resume/finish transitions, derived
 * elapsed time and phase, and the restore policy.
 *
 * All values are epoch milliseconds supplied by the caller. Nothing here reads
 * a clock, so the same injected `now` always produces the same result and the
 * tests are deterministic. Rest (transient) lives in `runtime.ts`, not here.
 */

import type { SessionDraft, SessionPhase, SessionState, SessionTiming } from "./types.ts";

/** A fresh active timing; called when the user starts a session. */
export function startTiming(nowMs: number): SessionTiming {
  return {
    startedAtMs: nowMs,
    endedAtMs: null,
    pausedAtMs: null,
    pausedTotalMs: 0,
    lastActiveAtMs: nowMs,
  };
}

/**
 * Pause a running timing.
 *
 * Returns `null` when the timing is finished or already paused; the reducer
 * treats that as a no-op. `lastActiveAtMs` records the last confirmed activity
 * for the restore policy.
 */
export function pauseTiming(timing: SessionTiming, nowMs: number): SessionTiming | null {
  if (timing.endedAtMs !== null || timing.pausedAtMs !== null) return null;
  return { ...timing, pausedAtMs: nowMs, lastActiveAtMs: nowMs };
}

/**
 * Resume a paused timing, folding the pause into `pausedTotalMs`.
 *
 * The paused interval is clamped at zero so a backwards system clock can never
 * subtract time from the session.
 */
export function resumeTiming(timing: SessionTiming, nowMs: number): SessionTiming | null {
  if (timing.endedAtMs !== null || timing.pausedAtMs === null) return null;
  const pausedMs = Math.max(0, nowMs - timing.pausedAtMs);
  return {
    ...timing,
    pausedAtMs: null,
    pausedTotalMs: timing.pausedTotalMs + pausedMs,
    lastActiveAtMs: nowMs,
  };
}

/**
 * Finish a timed session, freezing its duration at `nowMs`.
 *
 * Finishing while paused folds the current pause into `pausedTotalMs` first, so
 * time spent paused is never counted as training time. Returns `null` when the
 * session is already finished.
 */
export function finishTiming(timing: SessionTiming, nowMs: number): SessionTiming | null {
  if (timing.endedAtMs !== null) return null;
  const pausedTotalMs =
    timing.pausedAtMs === null
      ? timing.pausedTotalMs
      : timing.pausedTotalMs + Math.max(0, nowMs - timing.pausedAtMs);
  return {
    ...timing,
    endedAtMs: nowMs,
    pausedAtMs: null,
    pausedTotalMs,
    lastActiveAtMs: nowMs,
  };
}

/**
 * Active training time in milliseconds, or `null` for an untimed draft.
 *
 * Time after a pause or finish is excluded because the cutoff is
 * `endedAtMs ?? pausedAtMs ?? nowMs`. The result is clamped at zero so clock
 * changes can never make a session negative.
 */
export function elapsedMs(draft: SessionDraft, nowMs: number): number | null {
  const timing = draft.timing;
  if (timing === null) return null;
  const cutoffMs = timing.endedAtMs ?? timing.pausedAtMs ?? nowMs;
  return Math.max(0, cutoffMs - timing.startedAtMs - timing.pausedTotalMs);
}

/**
 * Derive the editor phase from the persisted timing and the transient runtime.
 *
 * `resting` is never persisted: it is an active timing with a rest that has not
 * elapsed yet. An expired rest that no `tick` has settled yet reads as `active`;
 * the countdown tick settles it and emits the cue.
 */
export function sessionPhase(state: SessionState, nowMs: number): SessionPhase {
  const timing = state.draft.timing;
  if (timing === null) return "editing";
  if (timing.endedAtMs !== null) return "finished";
  if (timing.pausedAtMs !== null) return "paused";

  const rest = state.runtime.rest;
  if (rest !== null && rest.remainingMs === null && nowMs < rest.endsAtMs) return "resting";
  return "active";
}

/**
 * Apply the restore policy to a persisted draft.
 *
 * A timing that was still active when the draft was saved is paused at
 * `max(startedAtMs, lastActiveAtMs)`, so time while the app was closed or the
 * page was refreshed is never counted as training time. The caller starts from
 * an empty runtime: a stale rest countdown is intentionally not restored and no
 * rest-ended cue is emitted.
 *
 * `nowMs` clamps the pause point so a backwards system clock cannot pause in
 * the future. Already paused or finished timings, and untimed drafts, are
 * returned unchanged (same reference).
 */
export function rehydrateSessionDraft(draft: SessionDraft, nowMs: number): SessionDraft {
  const timing = draft.timing;
  if (timing === null || timing.endedAtMs !== null || timing.pausedAtMs !== null) return draft;

  const pausedAtMs = Math.max(timing.startedAtMs, Math.min(timing.lastActiveAtMs, nowMs));
  return { ...draft, timing: { ...timing, pausedAtMs } };
}
