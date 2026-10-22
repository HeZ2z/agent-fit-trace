import {
  CURRENT_SCHEMA_VERSION,
  SESSION_TYPES,
  ValidationError,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type {
  PainReport,
  SessionType,
  ValidationIssue,
  ValidationWarning,
  WorkoutRecord,
  WorkoutSet,
} from "@agent-fit-trace/core";

/**
 * Pure form model for the Log screen.
 *
 * This module owns draft construction, numeric parsing and validation; it
 * imports no React, expo, DOM or storage values, so the root `node:test` suite
 * can load it through Node's TypeScript type stripping. The screen owns the
 * editable state, and the repository owns every native call.
 *
 * Records are authored exactly like the web editor: the draft is validated by
 * the shared core first, and the store assigns the final content-derived id.
 */

/**
 * Placeholder id used only while validating a draft. The core requires a
 * non-empty id, so validation needs one; {@link toSaveInput} removes it again
 * before the repository derives the real content id.
 */
export const LOG_DRAFT_ID = "draft";

export interface SetDraft {
  reps: string;
  weight: string;
  rpe: string;
}

export interface ExerciseDraft {
  name: string;
  sets: SetDraft[];
}

/**
 * Editable state for one session. Strings are kept verbatim so a partially
 * typed field is never lost to number coercion.
 *
 * The core schema accepts a `pain` array; the compact mobile form supports one
 * optional report (area and/or level) per session.
 */
export interface LogFormDraft {
  date: string;
  sessionType: SessionType;
  exercises: ExerciseDraft[];
  notes: string;
  painArea: string;
  painLevel: string;
}

export type LogValidationResult =
  | { ok: true; record: WorkoutRecord; warnings: ValidationWarning[] }
  | { ok: false; issues: ValidationIssue[] };

/** Blank set used when the form is created or a set is added. */
export function createSetDraft(): SetDraft {
  return { reps: "", weight: "", rpe: "" };
}

/** Blank exercise with one empty set, so a new card always has a set. */
export function createExerciseDraft(): ExerciseDraft {
  return { name: "", sets: [createSetDraft()] };
}

/** Empty form for `date`: one blank exercise/set and the default session type. */
export function createLogDraft(date: string): LogFormDraft {
  return {
    date,
    sessionType: SESSION_TYPES[0],
    exercises: [createExerciseDraft()],
    notes: "",
    painArea: "",
    painLevel: "",
  };
}

/**
 * Format a device-local calendar date as `YYYY-MM-DD`, the format the core
 * validator accepts. The clock is injected so the default stays one call site
 * in the screen and tests stay deterministic.
 */
export function todayLocalDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Parse an optional numeric field, treating blank input as absent. */
export function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return Number(trimmed);
}

/**
 * Parse a required numeric field. Blank input becomes `NaN` on purpose: the
 * core validator already rejects it with the same `INVALID_REPS` issue it uses
 * for non-numeric text, so the form never turns a missing rep count into `0`.
 */
function parseRequiredNumber(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return Number.NaN;
  return Number(trimmed);
}

function buildPainReport(area: string, level: string): PainReport | undefined {
  const trimmedArea = area.trim();
  const parsedLevel = parseOptionalNumber(level);
  if (trimmedArea === "" && parsedLevel === undefined) return undefined;

  const report: PainReport = {};
  if (trimmedArea !== "") report.area = trimmedArea;
  if (parsedLevel !== undefined) report.level = parsedLevel;
  return report;
}

/**
 * Build the record the core validates.
 *
 * Optional fields are omitted rather than sent as `undefined`, matching the
 * canonical record shape. Exercise names are trimmed by the core during
 * validation; notes are trimmed here because leading/trailing whitespace is
 * never meaningful for free text.
 */
export function buildWorkoutRecord(draft: LogFormDraft, id: string = LOG_DRAFT_ID): WorkoutRecord {
  const exercises = draft.exercises.map((exercise) => ({
    name: exercise.name,
    sets: exercise.sets.map((set): WorkoutSet => {
      const built: WorkoutSet = { reps: parseRequiredNumber(set.reps) };
      const weight = parseOptionalNumber(set.weight);
      if (weight !== undefined) built.weight = weight;
      const rpe = parseOptionalNumber(set.rpe);
      if (rpe !== undefined) built.rpe = rpe;
      return built;
    }),
  }));

  const record: WorkoutRecord = {
    id,
    schema_version: CURRENT_SCHEMA_VERSION,
    date: draft.date,
    session_type: draft.sessionType,
    exercises,
  };

  const notes = draft.notes.trim();
  if (notes !== "") record.notes = notes;

  const pain = buildPainReport(draft.painArea, draft.painLevel);
  if (pain !== undefined) record.pain = [pain];

  return record;
}

/**
 * Turn a validated record into the repository input.
 *
 * The empty id makes `WorkoutRepository.saveWorkout` derive the canonical
 * content id through `prepareWorkoutId`. Identical content therefore targets
 * the same id on every retry (idempotent), while the repository still validates
 * the final record before writing.
 */
export function toSaveInput(record: WorkoutRecord): WorkoutRecord {
  return { ...record, id: "" };
}

/**
 * Validate a draft with the shared core validator.
 *
 * Hard issues (missing exercise name/reps, impossible load, bad date, …) make
 * the result non-ok and must block the save. Accepted-but-suspicious values
 * (for example 0 reps) come back as warnings; the screen asks for explicit
 * confirmation before writing those, mirroring the web editor.
 */
export function validateLogDraft(draft: LogFormDraft): LogValidationResult {
  const candidate = buildWorkoutRecord(draft);
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
