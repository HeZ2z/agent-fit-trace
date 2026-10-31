import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  EXTREME_RPE,
  SESSION_TYPES,
  stableStringify,
} from "@agent-fit-trace/core";
import type {
  SessionType,
  ValidationIssue,
  ValidationWarning,
  WorkoutRecord,
} from "@agent-fit-trace/core";
import {
  SessionDraftCorruptionError,
  buildWorkoutRecord,
  createSessionDraft,
  createSessionRuntime,
  elapsedMs,
  reduceSessionState,
  rehydrateSessionDraft,
  restRemainingMs,
  sessionPhase,
  toSaveInput,
  todayLocalDate,
  validateSessionDraft,
} from "@agent-fit-trace/workout-session";
import type {
  SessionAction,
  SessionDraft,
  SessionState,
} from "@agent-fit-trace/workout-session";
import { ExerciseNameCombobox } from "../components/ExerciseNameCombobox.tsx";
import { useSessionDraft } from "../state/SessionDraftContext.tsx";
import type { SessionDraftContextValue } from "../state/SessionDraftContext.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useI18n } from "../i18n/useI18n.ts";
import {
  displayIssue,
  displaySessionType,
  displayValidationMessage,
  displayWarning,
} from "../i18n/domain.ts";
import {
  REST_ENDED_VIBRATION,
  SET_CHECKED_VIBRATION_MS,
  playRestCue,
  vibrate,
} from "../workout/liveFeedback.ts";

/**
 * Presentation-only safety hint. The shared build already parses the draft, but
 * the threshold check stays local so the badge can react to partially typed RPE
 * input without touching the record model.
 */
function isExtremeRpe(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= EXTREME_RPE;
}

/**
 * Format a live duration as `MM:SS`, adding an `H:` segment after an hour.
 *
 * Elapsed and rest times are derived from injected epoch milliseconds, so this
 * stays a pure presentation helper and never reads a clock itself.
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Rest steps the UI's -15s/+15s buttons move the shared timer by. */
const REST_ADJUST_MS = 15_000;

/** Ticker cadence for the elapsed display and rest settlement. */
const LIVE_TICK_MS = 250;

/**
 * A record captured for the warning confirmation, plus the clock used to build
 * it. The built (pre-validation-normalization) record is stored so staleness can
 * compare like with like against a fresh build of the current draft.
 */
interface PendingSave {
  record: WorkoutRecord;
  nowMs: number;
}

/** Which restore banner the editor owes the user after loading the draft. */
type RestoreNotice = "restored" | "auto-paused" | null;

/**
 * Draft-storage problems the editor renders non-blockingly.
 *
 * `corrupt` is fail-closed: an unreadable payload is never overwritten, so
 * autosave stays off until the user explicitly discards it. `read-error` and
 * `save-error` are best-effort storage failures; the session remains editable.
 */
type DraftProblem =
  | { kind: "corrupt" }
  | { kind: "read-error"; message: string }
  | { kind: "save-error"; message: string };

interface DraftBootstrap {
  state: SessionState;
  notice: RestoreNotice;
  problem: DraftProblem | null;
  /** False for corruption and read failures, so a failed load is never rewritten. */
  autosave: boolean;
  /**
   * The payload the editor last observed in storage, before any in-memory
   * rehydration. Saving may clear only this baseline, never whatever another
   * tab happened to write in the meantime.
   */
  persistedBaseline: SessionDraft | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A brand-new untimed draft; also the state a discard resets to. */
function blankSessionState(): SessionState {
  return { draft: createSessionDraft(todayLocalDate()), runtime: createSessionRuntime() };
}

/**
 * Load the one stored draft before the editor's first render.
 *
 * Restoring an active timing runs the shared rehydrate policy: the session is
 * auto-paused at its last confirmed activity so time while the page was closed
 * is never counted, and the user is told to resume. Runtime rest is always
 * empty after a restore (a stale countdown must never be resurrected).
 */
function bootstrapDraft(drafts: SessionDraftContextValue): DraftBootstrap {
  try {
    const stored = drafts.load();
    if (stored === null) {
      return {
        state: blankSessionState(),
        notice: null,
        problem: null,
        autosave: true,
        persistedBaseline: null,
      };
    }
    const timing = stored.timing;
    const wasActive =
      timing !== null && timing.endedAtMs === null && timing.pausedAtMs === null;
    return {
      state: {
        draft: rehydrateSessionDraft(stored, Date.now()),
        runtime: createSessionRuntime(),
      },
      notice: wasActive ? "auto-paused" : "restored",
      problem: null,
      autosave: true,
      persistedBaseline: stored,
    };
  } catch (error) {
    const blank = {
      state: blankSessionState(),
      notice: null,
      autosave: false,
      persistedBaseline: null,
    };
    if (error instanceof SessionDraftCorruptionError) {
      return { ...blank, problem: { kind: "corrupt" } };
    }
    return { ...blank, problem: { kind: "read-error", message: messageOf(error) } };
  }
}

export function WorkoutEditorScreen() {
  const navigate = useNavigate();
  const drafts = useSessionDraft();
  const { saveWorkout, saveStatus } = useWorkouts();
  const { language, t } = useI18n();
  const saving = saveStatus === "saving";

  // One shared draft + runtime reducer owns every field, exercise, set and pain
  // edit. The stored draft is loaded synchronously before the first render, and
  // `useState` (over the same shared pure reducer) is used instead of
  // `useReducer` so a discard can replace the whole state with a blank draft.
  const [bootstrap] = useState(() => bootstrapDraft(drafts));
  const [state, setState] = useState<SessionState>(bootstrap.state);
  const dispatch = useCallback((action: SessionAction): void => {
    setState((current) => reduceSessionState(current, action));
  }, []);
  const { draft, runtime } = state;

  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);

  const [restoredNotice, setRestoredNotice] = useState<RestoreNotice>(bootstrap.notice);
  const [draftProblem, setDraftProblem] = useState<DraftProblem | null>(bootstrap.problem);
  const [autosaveEnabled, setAutosaveEnabled] = useState(bootstrap.autosave);
  // A restored draft, an unreadable payload, or any autosaved edit means there
  // is something the explicit discard action can clear. Read/write failures also
  // expose discard so the user can recover fresh storage without a hidden retry.
  const [hasDraft, setHasDraft] = useState(
    bootstrap.notice !== null || bootstrap.problem !== null,
  );
  const [discardConfirming, setDiscardConfirming] = useState(false);
  const [discardedNotice, setDiscardedNotice] = useState(false);
  // Autosave writes only drafts that differ from the last known-persisted (or
  // intentionally unpersisted) baseline. Because the check is value-identity
  // based, mounting, StrictMode's double effect run, and the post-discard reset
  // never rewrite storage. A failed write disables further attempts.
  const autosaveBaselineRef = useRef(bootstrap.state.draft);
  const persistedBaselineRef = useRef<SessionDraft | null>(bootstrap.persistedBaseline);
  const autosaveFailedRef = useRef(false);

  // Autosave every persisted-draft change (fields, timing, per-exercise rest).
  // Rest countdown ticks are runtime-only and therefore never saved.
  useEffect(() => {
    if (!autosaveEnabled) return;
    if (autosaveFailedRef.current) return;
    if (draft === autosaveBaselineRef.current) return;
    try {
      drafts.save(draft);
      autosaveBaselineRef.current = draft;
      persistedBaselineRef.current = draft;
      setHasDraft(true);
      setDiscardedNotice(false);
    } catch (error) {
      autosaveFailedRef.current = true;
      setHasDraft(true);
      setDraftProblem({ kind: "save-error", message: messageOf(error) });
    }
  }, [draft, drafts, autosaveEnabled]);

  // Live clock. The model never reads a clock: this component injects the
  // current time into every timing/rest action and keeps one render-local `now`
  // so elapsed time and the rest countdown re-render on the ticker.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const phase = sessionPhase(state, nowMs);
  const timed = draft.timing !== null;
  const paused = phase === "paused";
  const finished = phase === "finished";
  // Only a running (started, not paused/finished) session needs a ticker.
  const timerRunning = timed && !paused && !finished;
  const elapsed = elapsedMs(draft, nowMs);
  const rest = runtime.rest;
  const restRemaining = rest === null ? null : restRemainingMs(rest, nowMs);

  // The cue plays on the null -> number transition, so a settled rest is
  // announced exactly once. Starting a new rest clears the cue back to null,
  // which resets the ref and arms the next announcement.
  const cuedRestEndRef = useRef<number | null>(null);
  useEffect(() => {
    if (runtime.restEndedAtMs === null) {
      cuedRestEndRef.current = null;
      return;
    }
    if (cuedRestEndRef.current === runtime.restEndedAtMs) return;
    cuedRestEndRef.current = runtime.restEndedAtMs;
    playRestCue();
    vibrate(REST_ENDED_VIBRATION);
  }, [runtime.restEndedAtMs]);

  // 250ms ticker while the session is running: updates the elapsed display and
  // settles an elapsed rest (which emits the rest-ended cue). It is cleared as
  // soon as the session pauses or finishes.
  useEffect(() => {
    if (!timerRunning) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      dispatch({ type: "tick", nowMs: now });
    }, LIVE_TICK_MS);
    return () => window.clearInterval(interval);
  }, [timerRunning, dispatch]);

  // Returning to the tab after the interval was throttled/suspended: catch the
  // clock up immediately and settle a rest that elapsed in the background, so
  // the cue fires once without waiting for the next tick.
  useEffect(() => {
    if (typeof document === "undefined") return;
    function handleVisibilityChange(): void {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      setNowMs(now);
      dispatch({ type: "tick", nowMs: now });
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [dispatch]);

  /** Dispatch a timing transition with a fresh injected clock. */
  function dispatchTimed(
    action:
      | { type: "startSession" }
      | { type: "pauseSession" }
      | { type: "resumeSession" }
      | { type: "finishSession" },
  ): void {
    const now = Date.now();
    setNowMs(now);
    dispatch({ ...action, nowMs: now });
  }

  function handleToggleSetDone(exerciseKey: number, setKey: number, done: boolean): void {
    const now = Date.now();
    setNowMs(now);
    if (!done) vibrate(SET_CHECKED_VIBRATION_MS);
    dispatch({ type: "toggleSetDone", exerciseKey, setKey, nowMs: now });
  }

  function handleAdjustRest(deltaMs: number): void {
    setNowMs(Date.now());
    dispatch({ type: "adjustRest", deltaMs });
  }

  function handleSkipRest(): void {
    setNowMs(Date.now());
    dispatch({ type: "skipRest" });
  }

  /**
   * Whole seconds of rest between sets; empty means zero (no rest), matching
   * the shared draft's numeric field. A transiently unparsable value never
   * reaches the reducer as `NaN`.
   */
  function handleRestSecondsChange(exerciseKey: number, raw: string): void {
    const restSeconds = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(restSeconds)) return;
    dispatch({ type: "setExerciseRestSeconds", exerciseKey, restSeconds });
  }

  /**
   * Two-step inline discard (no `window.confirm`).
   *
   * A failed clear leaves the unreadable payload untouched and keeps autosave
   * blocked, so the editor never fabricates a replacement draft over data it
   * could not read. A successful clear resets the form to a blank draft; the
   * reset is baseline-skipped, so it is not written back.
   */
  function handleDiscardDraft(): void {
    if (!discardConfirming) {
      setDiscardConfirming(true);
      return;
    }
    try {
      drafts.clear();
    } catch (error) {
      setDiscardConfirming(false);
      setDraftProblem({ kind: "save-error", message: messageOf(error) });
      return;
    }
    // The reset itself is not a persisted edit: baseline it so the next actual
    // change is the first autosave after an explicit discard.
    const blank = blankSessionState();
    autosaveBaselineRef.current = blank.draft;
    persistedBaselineRef.current = null;
    autosaveFailedRef.current = false;
    setState(blank);
    setAutosaveEnabled(true);
    setRestoredNotice(null);
    setDraftProblem(null);
    setHasDraft(false);
    setDiscardConfirming(false);
    setDiscardedNotice(true);
  }

  // The captured record is only valid while the form still builds the same
  // content. Deriving staleness (rather than clearing it in every change
  // handler) means no field edit can be forgotten, so a stale value can never
  // be saved.
  const pendingIsStale =
    pendingSave !== null &&
    stableStringify(buildWorkoutRecord(draft, pendingSave.nowMs)) !==
      stableStringify(pendingSave.record);

  async function persist(record: WorkoutRecord): Promise<void> {
    // The baseline is the payload this editor last observed in or wrote to
    // storage, not whatever happens to be there when Save is clicked. Two tabs
    // share the owner key; a save built from this editor's draft must never
    // delete a newer draft another tab wrote in the meantime.
    const persistedAtSave = persistedBaselineRef.current;
    // Save failures (unavailable, quota, conflict) must surface to the user
    // rather than escaping as an unhandled error. Input is retained and no
    // navigation happens until the save resolves.
    try {
      const saved = await saveWorkout(toSaveInput(record));
      // The record is already stored; a failed draft clear must neither undo the
      // save nor block navigation. Clear only when storage still holds the
      // baseline this editor is responsible for.
      try {
        if (persistedAtSave !== null) {
          const currentDraft = drafts.load();
          if (
            currentDraft !== null &&
            stableStringify(currentDraft) === stableStringify(persistedAtSave)
          ) {
            drafts.clear();
            persistedBaselineRef.current = null;
          }
        }
      } catch {
        // Ignore: the saved workout is the durable outcome.
      }
      navigate(`/workout/${saved.id}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setIssues([]);
    setWarnings([]);
    setSaveError(null);
    setPendingSave(null);

    const nowMs = Date.now();
    // Build before validation: the client derives the content id from the
    // submitted content, and historical records were hashed with the untrimmed
    // name. Persisting this pre-normalization build keeps re-entry idempotent;
    // validation still trims/normalizes the record the client stores.
    const candidate = buildWorkoutRecord(draft, nowMs);
    // The shared bridge runs core validation and separates hard issues from
    // accepted-input warnings.
    const validated = validateSessionDraft(draft, nowMs);

    if (!validated.ok) {
      setIssues(validated.issues);
      return; // Do not persist an invalid record.
    }

    // Accepted-but-suspicious input (e.g. implausibly low sleep) must be seen
    // before the record is saved, so require an explicit confirmation rather
    // than navigating away immediately.
    if (validated.warnings.length > 0) {
      setWarnings(validated.warnings);
      setPendingSave({ record: candidate, nowMs });
      return;
    }

    await persist(candidate);
  }

  async function handleConfirmSave(): Promise<void> {
    if (saving) return;
    // The form changed after the warning was shown: drop the stale record and
    // require a fresh submission and validation.
    if (pendingSave === null || pendingIsStale) {
      setPendingSave(null);
      setWarnings([]);
      return;
    }
    const pending = pendingSave;
    setPendingSave(null);
    await persist(pending.record);
  }

  return (
    <section data-screen="log">
      <h1>{t("Log Workout")}</h1>

      {restoredNotice !== null && (
        <p role="status" className="session-draft-notice" data-testid="draft-notice">
          {restoredNotice === "auto-paused"
            ? t("Session restored and auto-paused. Resume to continue.")
            : t("Unfinished session restored.")}
        </p>
      )}

      {discardedNotice && (
        <p role="status" className="session-draft-notice" data-testid="draft-discarded">
          {t("Session draft discarded.")}
        </p>
      )}

      {draftProblem?.kind === "corrupt" && (
        <div role="alert" className="validation-summary" data-testid="draft-corrupt">
          <p>
            {t(
              "Could not restore the saved session draft. Discard it to start a new session.",
            )}
          </p>
        </div>
      )}

      {draftProblem?.kind === "read-error" && (
        <p role="status" className="session-draft-notice" data-testid="draft-read-error">
          {draftProblem.message}
        </p>
      )}

      {draftProblem?.kind === "save-error" && (
        <p role="alert" className="validation-summary" data-testid="draft-save-error">
          {t("Draft autosave failed: {message}", { message: draftProblem.message })}
        </p>
      )}

      {hasDraft && (
        <div className="session-draft-actions" data-testid="draft-actions">
          {discardConfirming ? (
            <>
              <p role="status">{t("Discard the unfinished session draft?")}</p>
              <button type="button" onClick={handleDiscardDraft}>
                {t("Discard draft")}
              </button>
              <button type="button" onClick={() => setDiscardConfirming(false)}>
                {t("Cancel")}
              </button>
            </>
          ) : (
            <button type="button" onClick={handleDiscardDraft}>
              {t("Discard draft")}
            </button>
          )}
        </div>
      )}

      <section
        className="session-timer"
        aria-label={t("Session timer")}
        data-testid="session-timer"
      >
        {!timed && (
          <button type="button" onClick={() => dispatchTimed({ type: "startSession" })}>
            {t("Start session")}
          </button>
        )}

        {timed && (
          <>
            {/* The elapsed value refreshes every 250ms; announcing that would
                flood a screen reader, so the timer region stays quiet. */}
            <p className="session-timer-elapsed" aria-live="off" data-testid="session-elapsed">
              {t("Elapsed")}: <time>{formatElapsed(elapsed ?? 0)}</time>
            </p>
            {paused && <p data-testid="session-phase">{t("Paused")}</p>}
            {finished && <p data-testid="session-phase">{t("Finished")}</p>}
            <button
              type="button"
              disabled={finished}
              onClick={() =>
                dispatchTimed({ type: paused ? "resumeSession" : "pauseSession" })
              }
            >
              {paused ? t("Resume session") : t("Pause session")}
            </button>
            <button
              type="button"
              disabled={finished}
              onClick={() => dispatchTimed({ type: "finishSession" })}
            >
              {t("Finish session")}
            </button>
          </>
        )}

        {rest !== null && restRemaining !== null && (
          <div
            className="rest-bar"
            role="group"
            aria-label={t("Rest timer")}
            data-testid="rest-bar"
          >
            <p aria-live="off" data-testid="rest-remaining">
              {t("Rest")}: <time>{formatElapsed(restRemaining)}</time>
            </p>
            <button
              type="button"
              aria-label={t("Subtract 15 seconds")}
              onClick={() => handleAdjustRest(-REST_ADJUST_MS)}
            >
              −15s
            </button>
            <button
              type="button"
              aria-label={t("Add 15 seconds")}
              onClick={() => handleAdjustRest(REST_ADJUST_MS)}
            >
              +15s
            </button>
            <button type="button" onClick={handleSkipRest}>
              {t("Skip rest")}
            </button>
          </div>
        )}

        {/* The settled-rest status mirrors the cue: it appears when the model
            records the rest-ended transition and disappears when a new rest
            starts (startRest clears the cue). Finishing hides it too. */}
        {rest === null && runtime.restEndedAtMs !== null && !finished && (
          <p role="status" className="rest-complete" data-testid="rest-complete">
            {t("Rest complete")}
          </p>
        )}
      </section>

      {saveError !== null && (
        <div role="alert" className="validation-summary" data-testid="save-error">
          <p>
            {t("Could not save this workout: {message}", {
              message: displayValidationMessage(language, saveError),
            })}
          </p>
        </div>
      )}

      {issues.length > 0 && (
        <div role="alert" className="validation-summary" data-testid="validation-summary">
          <p>
            {issues.length === 1
              ? t("{count} validation issue — please fix before saving.", { count: issues.length })
              : t("{count} validation issues — please fix before saving.", { count: issues.length })}
          </p>
          <ul>
            {issues.map((issue, index) => (
              <li
                key={`${issue.code}-${index}`}
                data-issue-code={issue.code}
                data-issue-path={issue.path ?? ""}
              >
                {issue.path ? `${issue.path}: ` : ""}
                {displayIssue(language, issue)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && !pendingIsStale && (
        <ul role="status" aria-label={t("Warnings")} className="validation-warnings">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`} data-warning-code={warning.code}>
              {displayWarning(language, warning)}
            </li>
          ))}
        </ul>
      )}

      {pendingIsStale && (
        <p role="status" className="validation-warnings" data-testid="warning-invalidated">
          {t("Form changed since the warning was shown. Submit again to re-validate.")}
        </p>
      )}

      {pendingSave !== null && !pendingIsStale && (
        <div className="validation-warnings" data-testid="warning-confirmation">
          <p>{t("This workout was accepted with warnings. Save it anyway?")}</p>
          <button type="button" onClick={handleConfirmSave} disabled={saving}>
            {t("Save anyway")}
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset>
          <legend>{t("Exercises")}</legend>

          {draft.exercises.map((exercise, exerciseIndex) => (
            <fieldset key={exercise.key} className="exercise-editor">
              <legend>{t("Exercise {index}", { index: exerciseIndex + 1 })}</legend>

              <ExerciseNameCombobox
                id={`exercise-${exercise.key}-name`}
                label={t("Exercise {index} name", { index: exerciseIndex + 1 })}
                value={exercise.name}
                onChange={(name) =>
                  dispatch({ type: "setExerciseName", exerciseKey: exercise.key, name })
                }
              />

              {/* Rest is session configuration, not workout content: it is
                  only offered once the clock is running. */}
              {timed && (
                <div className="field">
                  <label htmlFor={`exercise-${exercise.key}-rest`}>
                    {t("Rest (seconds)")} · {t("Exercise {index}", { index: exerciseIndex + 1 })}
                  </label>
                  <input
                    id={`exercise-${exercise.key}-rest`}
                    type="number"
                    min="0"
                    step="1"
                    value={exercise.restSeconds}
                    disabled={finished}
                    onChange={(event) =>
                      handleRestSecondsChange(exercise.key, event.target.value)
                    }
                  />
                </div>
              )}

              {exercise.sets.map((set, setIndex) => {
                const base = `exercise-${exercise.key}-set-${set.key}`;
                const extreme = isExtremeRpe(set.rpe);
                return (
                  <fieldset
                    key={set.key}
                    className="set-editor"
                    data-safety={extreme ? "extreme-rpe" : undefined}
                  >
                    <legend>
                      {t("Set {set}", { set: setIndex + 1 })}
                    </legend>

                    {/* Check-off only exists for a timed session: on an untimed
                        draft the `done` marker is meaningless at save time. */}
                    {timed && (
                      <div className="field field-checkbox">
                        <input
                          id={`${base}-done`}
                          type="checkbox"
                          checked={set.done}
                          disabled={finished}
                          // Scoped to the exercise so several cards cannot all
                          // be announced as "Set 1 complete".
                          aria-label={`${t("Exercise {index}", {
                            index: exerciseIndex + 1,
                          })}: ${t("Set {set} complete", { set: setIndex + 1 })}`}
                          onChange={() =>
                            handleToggleSetDone(exercise.key, set.key, set.done)
                          }
                        />
                        <label htmlFor={`${base}-done`}>
                          {t("Set {set} complete", { set: setIndex + 1 })}
                        </label>
                      </div>
                    )}

                    <div className="field">
                      <label htmlFor={`${base}-weight`}>
                        {t("Weight (kg)")}
                      </label>
                      <input
                        id={`${base}-weight`}
                        aria-label={t("Exercise {exercise} set {set} weight (kg)", {
                          exercise: exerciseIndex + 1,
                          set: setIndex + 1,
                        })}
                        type="number"
                        step="any"
                        value={set.weight}
                        onChange={(event) =>
                          dispatch({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "weight",
                            value: event.target.value,
                          })
                        }
                      />
                    </div>

                    <div className="field">
                      <label htmlFor={`${base}-reps`}>
                        {t("Reps")}
                      </label>
                      <input
                        id={`${base}-reps`}
                        aria-label={t("Exercise {exercise} set {set} reps", {
                          exercise: exerciseIndex + 1,
                          set: setIndex + 1,
                        })}
                        type="number"
                        step="1"
                        value={set.reps}
                        onChange={(event) =>
                          dispatch({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "reps",
                            value: event.target.value,
                          })
                        }
                      />
                    </div>

                    <div className="field">
                      <label htmlFor={`${base}-rpe`}>
                        {t("RPE")}
                      </label>
                      <input
                        id={`${base}-rpe`}
                        aria-label={t("Exercise {exercise} set {set} RPE", {
                          exercise: exerciseIndex + 1,
                          set: setIndex + 1,
                        })}
                        type="number"
                        min="1"
                        max="10"
                        step="0.5"
                        value={set.rpe}
                        onChange={(event) =>
                          dispatch({
                            type: "setSetField",
                            exerciseKey: exercise.key,
                            setKey: set.key,
                            field: "rpe",
                            value: event.target.value,
                          })
                        }
                      />
                    </div>

                    {extreme && <span className="safety-badge">{t("Extreme effort")}</span>}

                    <button
                      type="button"
                      // The shared reducer keeps at least one set per exercise,
                      // so the last remaining one cannot be removed.
                      disabled={exercise.sets.length <= 1}
                      onClick={() =>
                        dispatch({
                          type: "removeSet",
                          exerciseKey: exercise.key,
                          setKey: set.key,
                        })
                      }
                    >
                      {t("Remove set")}
                    </button>
                  </fieldset>
                );
              })}

              <button
                type="button"
                onClick={() => dispatch({ type: "addSet", exerciseKey: exercise.key })}
              >
                {t("Add set")}
              </button>
              <button
                type="button"
                // The shared reducer keeps at least one exercise, so the last
                // remaining one cannot be removed.
                disabled={draft.exercises.length <= 1}
                onClick={() => dispatch({ type: "removeExercise", exerciseKey: exercise.key })}
              >
                {t("Remove exercise")}
              </button>
            </fieldset>
          ))}

          <button type="button" onClick={() => dispatch({ type: "addExercise" })}>
            {t("Add exercise")}
          </button>
        </fieldset>

        <fieldset>
          <legend>{t("Session")}</legend>

          <div className="field">
            <label htmlFor="workout-date">{t("Date")}</label>
            <input
              id="workout-date"
              type="date"
              value={draft.date}
              onChange={(event) => dispatch({ type: "setDate", date: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="workout-session-type">{t("Session type")}</label>
            <select
              id="workout-session-type"
              value={draft.sessionType}
              onChange={(event) =>
                dispatch({
                  type: "setSessionType",
                  sessionType: event.target.value as SessionType,
                })
              }
            >
              {SESSION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {displaySessionType(language, type)}
                </option>
              ))}
            </select>
          </div>

          {/* A timed session derives its duration from the shared timing, so the
              manual field only exists for after-the-fact entries. */}
          {!timed && (
            <div className="field">
              <label htmlFor="workout-duration-minutes">{t("Duration (minutes)")}</label>
              <input
                id="workout-duration-minutes"
                type="number"
                min="1"
                step="1"
                value={draft.durationMinutes}
                onChange={(event) =>
                  dispatch({ type: "setDurationMinutes", value: event.target.value })
                }
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="workout-sleep-hours">{t("Sleep (hours)")}</label>
            <input
              id="workout-sleep-hours"
              type="number"
              min="0"
              max="24"
              step="0.5"
              value={draft.sleepHours}
              onChange={(event) => dispatch({ type: "setSleepHours", value: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="workout-notes">{t("Notes")}</label>
            <textarea
              id="workout-notes"
              value={draft.notes}
              onChange={(event) => dispatch({ type: "setNotes", value: event.target.value })}
            />
          </div>
        </fieldset>

        <fieldset>
          <legend>{t("Pain")}</legend>

          {draft.pain.map((entry, index) => (
            <div key={entry.key} className="pain-editor" data-safety="pain">
              <div className="field">
                <label htmlFor={`pain-${entry.key}-area`}>
                  {t("Pain {index} area", { index: index + 1 })}
                </label>
                <input
                  id={`pain-${entry.key}-area`}
                  type="text"
                  value={entry.area}
                  onChange={(event) =>
                    dispatch({
                      type: "setPainField",
                      painKey: entry.key,
                      field: "area",
                      value: event.target.value,
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor={`pain-${entry.key}-level`}>
                  {t("Pain {index} level", { index: index + 1 })}
                </label>
                <input
                  id={`pain-${entry.key}-level`}
                  type="number"
                  min="0"
                  max="10"
                  step="1"
                  value={entry.level}
                  onChange={(event) =>
                    dispatch({
                      type: "setPainField",
                      painKey: entry.key,
                      field: "level",
                      value: event.target.value,
                    })
                  }
                />
              </div>

              <span className="safety-badge">{t("Pain reported")}</span>

              <button
                type="button"
                onClick={() => dispatch({ type: "removePain", painKey: entry.key })}
              >
                {t("Remove pain")}
              </button>
            </div>
          ))}

          <button type="button" onClick={() => dispatch({ type: "addPain" })}>
            {t("Add pain")}
          </button>
        </fieldset>

        <button type="submit" disabled={saving}>
          {t("Save workout")}
        </button>
      </form>
    </section>
  );
}
