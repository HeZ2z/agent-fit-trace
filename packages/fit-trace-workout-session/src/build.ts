/**
 * Bridge from the editable session draft to the core workout record.
 *
 * The draft is deliberately permissive: every numeric field is a string so
 * partially typed input survives. The core is strict. This module maps one to
 * the other without pre-judging validity:
 *
 * - a set is dropped only when reps, weight and rpe are ALL blank; partially
 *   filled sets are passed through so the core reports INVALID_REPS,
 *   INVALID_WEIGHT, INVALID_RPE, etc.;
 * - a timed draft additionally drops auto-prefilled sets that are still
 *   unchecked: they are suggestions for the next set, not performed work.
 *   Editing any field or checking the set clears the flag and includes it;
 * - an exercise with no remaining sets is dropped, and an all-blank draft
 *   produces an empty exercises array so the core reports MISSING_EXERCISES
 *   through the normal validation path.
 *
 * The built record carries {@link DRAFT_PLACEHOLDER_ID}; {@link toSaveInput}
 * strips it so the repository derives the real content id.
 */

import {
  CURRENT_SCHEMA_VERSION,
  ValidationError,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type {
  Exercise,
  PainReport,
  ValidationIssue,
  ValidationWarning,
  WorkoutRecord,
  WorkoutSet,
} from "@agent-fit-trace/core";
import { elapsedMs } from "./timing.ts";
import type { DraftSet, SessionDraft } from "./types.ts";

/** Placeholder id used only while building/validating a draft. */
export const DRAFT_PLACEHOLDER_ID = "draft";

/** Result of validating a draft with the shared core validator. */
export type SessionDraftValidationResult =
  | { ok: true; record: WorkoutRecord; warnings: ValidationWarning[] }
  | { ok: false; issues: ValidationIssue[] };

function isBlank(raw: string): boolean {
  return raw.trim() === "";
}

/** Parse a numeric field, treating blank input as absent (never 0). */
function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return Number(trimmed);
}

/**
 * Parse a required numeric field. Blank input becomes `NaN` on purpose: the
 * core validator rejects it with the same INVALID_REPS issue it uses for
 * non-numeric text, so a missing rep count is never silently turned into 0.
 */
function parseRequiredNumber(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return Number.NaN;
  return Number(trimmed);
}

function isDroppedSet(set: DraftSet): boolean {
  return isBlank(set.reps) && isBlank(set.weight) && isBlank(set.rpe);
}

function buildSets(draft: SessionDraft): Exercise[] {
  const exercises: Exercise[] = [];
  const timed = draft.timing !== null;

  for (const exerciseDraft of draft.exercises) {
    const sets: WorkoutSet[] = [];
    for (const setDraft of exerciseDraft.sets) {
      // Auto-prefilled suggestions are not performed content. Only a timed
      // session creates them, and editing or checking one clears the flag.
      if (timed && setDraft.prefilled && !setDraft.done) continue;
      if (isDroppedSet(setDraft)) continue;

      const built: WorkoutSet = { reps: parseRequiredNumber(setDraft.reps) };
      const weight = parseOptionalNumber(setDraft.weight);
      if (weight !== undefined) built.weight = weight;
      const rpe = parseOptionalNumber(setDraft.rpe);
      if (rpe !== undefined) built.rpe = rpe;
      sets.push(built);
    }

    // An exercise with nothing loggable is not part of the record.
    if (sets.length === 0) continue;
    exercises.push({ name: exerciseDraft.name, sets });
  }

  return exercises;
}

function buildPain(draft: SessionDraft): PainReport[] | undefined {
  const pain: PainReport[] = [];

  for (const entry of draft.pain) {
    const report: PainReport = {};
    const area = entry.area.trim();
    if (area !== "") report.area = area;
    const level = parseOptionalNumber(entry.level);
    if (level !== undefined) report.level = level;
    // A fully blank pain row is UI noise, not a report.
    if (report.area !== undefined || report.level !== undefined) pain.push(report);
  }

  return pain.length > 0 ? pain : undefined;
}

/**
 * Build the core record the validator consumes.
 *
 * Duration for a timed session is derived from the persisted timing and is
 * therefore ignored when the draft has a `timing`: `elapsedMs` already freezes
 * at `endedAtMs` (finished) or `pausedAtMs` (paused), and an active session uses
 * the injected `nowMs`. Timed durations are rounded to whole minutes with a
 * one-minute floor, so a session that just started still records 1 minute.
 *
 * An untimed draft uses the manually entered `durationMinutes` when non-blank
 * and omits the field otherwise. `durationMinutes` is never applied to a timed
 * session.
 */
export function buildWorkoutRecord(draft: SessionDraft, nowMs: number): WorkoutRecord {
  const record: WorkoutRecord = {
    id: DRAFT_PLACEHOLDER_ID,
    schema_version: CURRENT_SCHEMA_VERSION,
    date: draft.date,
    session_type: draft.sessionType,
    exercises: buildSets(draft),
  };

  if (draft.timing !== null) {
    const elapsed = elapsedMs(draft, nowMs);
    if (elapsed !== null) {
      record.duration_minutes = Math.max(1, Math.round(elapsed / 60_000));
    }
  } else {
    const durationMinutes = parseOptionalNumber(draft.durationMinutes);
    if (durationMinutes !== undefined) record.duration_minutes = durationMinutes;
  }

  const sleepHours = parseOptionalNumber(draft.sleepHours);
  if (sleepHours !== undefined) record.sleep_hours = sleepHours;

  const pain = buildPain(draft);
  if (pain !== undefined) record.pain = pain;

  const notes = draft.notes.trim();
  if (notes !== "") record.notes = notes;

  return record;
}

/**
 * Validate a draft against the shared core contract.
 *
 * Only {@link ValidationError} is converted to a result; unexpected errors
 * propagate. Warnings are returned for the UI's explicit confirmation step.
 */
export function validateSessionDraft(
  draft: SessionDraft,
  nowMs: number,
): SessionDraftValidationResult {
  const candidate = buildWorkoutRecord(draft, nowMs);
  try {
    const { record, warnings } = validateWorkoutRecord(candidate);
    return { ok: true, record, warnings };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, issues: error.issues };
    }
    throw error;
  }
}

/**
 * Turn a validated record into the repository input.
 *
 * The empty id makes the repository derive the canonical content id, matching
 * the existing web/mobile editors: identical content targets the same id on
 * every retry (idempotent), while the repository still validates the record
 * before writing.
 */
export function toSaveInput(record: WorkoutRecord): WorkoutRecord {
  return { ...record, id: "" };
}
