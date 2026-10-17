import { stableStringify, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { ValidationWarning, WorkoutRecord } from "@pi-fit-trace/core";
import {
  IMPORT_MAX_COLLECTION_LENGTH,
  IMPORT_MAX_EXERCISES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_RECORDS,
  IMPORT_MAX_ID_LENGTH,
  IMPORT_MAX_REQUEST_BYTES,
  IMPORT_MAX_SETS_PER_EXERCISE,
  IMPORTED_PAYLOAD_SCHEMA_VERSION,
  ImportValidationError,
  assertImportJsonBounds,
  parseImportArtifactInput,
  type ImportArtifactInput,
  type ImportedArtifactKind,
} from "./imports.ts";

/**
 * File-boundary parsers for the import coordinator.
 *
 * A file is a bounded container: UTF-8 bytes are capped before parsing, arrays
 * and nesting are bounded before validation, and workout records keep their
 * original ids (never derived). The coordinator that previews and submits the
 * parsed result is a later slice; this module never writes.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFileSize(text: string): void {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > IMPORT_MAX_FILE_BYTES) {
    throw new ImportValidationError(
      "(file)",
      `exceeds the ${IMPORT_MAX_FILE_BYTES} byte file limit`,
    );
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  if (text.trim() === "") {
    throw new ImportValidationError("(root)", `the ${label} file is empty`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ImportValidationError("(root)", "is not valid JSON");
  }
  if (!isObject(parsed)) {
    throw new ImportValidationError("(root)", "must be a JSON object");
  }
  return parsed;
}

function validationReason(error: unknown): string {
  if (error instanceof ImportValidationError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ------------------------------------------------------------------------- */
/* Workout backup files                                                      */
/* ------------------------------------------------------------------------- */

export interface WorkoutImportEntry {
  record: WorkoutRecord;
  /** Original zero-based indexes of identical records inside the file. */
  indexes: number[];
}

export interface ParsedWorkoutImportFile {
  entries: WorkoutImportEntry[];
  warnings: ValidationWarning[];
}

const WORKOUT_FILE_KEYS = new Set(["schema_version", "records"]);

/**
 * Parse `{ schema_version, records }` workout backups.
 *
 * Every record is validated before anything is returned. The whole file fails
 * if any record is invalid, an id is missing, or two records share an id with
 * different canonical content; identical repeats are merged and keep their
 * original indexes for the later per-record receipt.
 */
export function parseWorkoutImportFile(text: string): ParsedWorkoutImportFile {
  assertFileSize(text);
  const root = parseJsonObject(text, "workout");
  assertImportJsonBounds(root, "(root)");

  if (root.schema_version !== 1) {
    if (typeof root.schema_version !== "number" || !Number.isInteger(root.schema_version)) {
      throw new ImportValidationError("schema_version", "must be the integer 1");
    }
    throw new ImportValidationError(
      "schema_version",
      `version ${root.schema_version} is not supported; this app supports version 1`,
    );
  }
  if (!Array.isArray(root.records)) {
    throw new ImportValidationError("records", "must be an array");
  }
  if (root.records.length > IMPORT_MAX_FILE_RECORDS) {
    throw new ImportValidationError(
      "records",
      `must contain at most ${IMPORT_MAX_FILE_RECORDS} workout records`,
    );
  }

  const warnings: ValidationWarning[] = [];
  for (const key of Object.keys(root)) {
    if (!WORKOUT_FILE_KEYS.has(key)) {
      warnings.push({
        code: "UNKNOWN_FIELD",
        message: `Unknown field \`${key}\` will be ignored`,
        path: key,
      });
    }
  }

  const entries: WorkoutImportEntry[] = [];
  const byId = new Map<string, WorkoutImportEntry>();

  root.records.forEach((raw, index) => {
    const field = `records[${index}]`;
    assertImportJsonBounds(raw, field);
    let validated: { record: WorkoutRecord; warnings: ValidationWarning[] };
    try {
      validated = validateWorkoutRecord(raw);
    } catch (error) {
      throw new ImportValidationError(field, validationReason(error));
    }
    const record = validated.record;
    if (record.id.length > IMPORT_MAX_ID_LENGTH) {
      throw new ImportValidationError(
        `${field}.id`,
        `must be at most ${IMPORT_MAX_ID_LENGTH} characters`,
      );
    }
    if (record.exercises.length > IMPORT_MAX_EXERCISES) {
      throw new ImportValidationError(
        `${field}.exercises`,
        `must contain at most ${IMPORT_MAX_EXERCISES} exercises`,
      );
    }
    record.exercises.forEach((exercise, exerciseIndex) => {
      if (exercise.sets.length > IMPORT_MAX_SETS_PER_EXERCISE) {
        throw new ImportValidationError(
          `${field}.exercises[${exerciseIndex}].sets`,
          `must contain at most ${IMPORT_MAX_SETS_PER_EXERCISE} sets`,
        );
      }
    });
    // The coordinator submits this record as one `POST /workouts` body, so
    // bound the normalized request (not just the file) to the import limit.
    const requestBytes = new TextEncoder().encode(stableStringify({ record })).length;
    if (requestBytes > IMPORT_MAX_REQUEST_BYTES) {
      throw new ImportValidationError(
        field,
        `exceeds the ${IMPORT_MAX_REQUEST_BYTES} byte single-record request limit`,
      );
    }

    // Warnings belong to the original file index, not to the merged entry.
    // Collect them before duplicate detection so an identical repeat keeps
    // proving that its own index was validated (and warned) too.
    for (const warning of validated.warnings) {
      warnings.push({
        ...warning,
        ...(warning.path === undefined
          ? {}
          : {
              // Core emits a leading dot for top-level record paths (".extra").
              // Prefix with the record location without doubling the separator.
              path: warning.path.startsWith(".")
                ? `${field}${warning.path}`
                : `${field}.${warning.path}`,
            }),
      });
    }

    const existing = byId.get(record.id);
    if (existing !== undefined) {
      if (stableStringify(existing.record) !== stableStringify(record)) {
        throw new ImportValidationError(
          `${field}.id`,
          `duplicates id \`${record.id}\` with different content (first at index ${existing.indexes[0]})`,
        );
      }
      existing.indexes.push(index);
      return;
    }
    // The same content under a different id stays a separate entry: ids are
    // the import identity, and the server never re-derives them.
    const entry: WorkoutImportEntry = { record, indexes: [index] };
    entries.push(entry);
    byId.set(record.id, entry);
  });

  return { entries, warnings };
}

/* ------------------------------------------------------------------------- */
/* Analysis / plan files                                                     */
/* ------------------------------------------------------------------------- */

export interface ParsedArtifactImportFile<K extends ImportedArtifactKind> {
  input: ImportArtifactInput<K>;
  warnings: ValidationWarning[];
}

const ENVELOPE_KEYS = new Set([
  "kind",
  "schema_version",
  "payload_schema_version",
  "payload",
]);

/**
 * Parse a bare `analysis.json` / `plan.json` payload or an explicit v1
 * envelope (`{ kind, schema_version, payload_schema_version, payload }`).
 *
 * Bare files remain supported; unsupported envelope/payload versions are
 * rejected with the version in the message. The file name is not part of the
 * identity and is supplied separately by the coordinator.
 */
export function parseArtifactImportFile<K extends ImportedArtifactKind>(
  text: string,
  kind: K,
): ParsedArtifactImportFile<K> {
  assertFileSize(text);
  const root = parseJsonObject(text, kind);
  assertImportJsonBounds(root, "(root)");

  const looksEnveloped = "payload" in root || "kind" in root;
  const warnings: ValidationWarning[] = [];
  let payload: unknown;
  let payloadSchemaVersion: number = IMPORTED_PAYLOAD_SCHEMA_VERSION;

  if (looksEnveloped) {
    for (const key of Object.keys(root)) {
      if (!ENVELOPE_KEYS.has(key)) {
        warnings.push({
          code: "UNKNOWN_FIELD",
          message: `Unknown field \`${key}\` will be ignored`,
          path: key,
        });
      }
    }
    if (root.kind !== kind) {
      throw new ImportValidationError(
        "kind",
        `is ${JSON.stringify(root.kind)} but this file was selected as ${kind}`,
      );
    }
    if (root.schema_version !== 1) {
      if (typeof root.schema_version !== "number" || !Number.isInteger(root.schema_version)) {
        throw new ImportValidationError("schema_version", "must be the integer 1");
      }
      throw new ImportValidationError(
        "schema_version",
        `version ${root.schema_version} is not supported; this app supports version 1`,
      );
    }
    if (root.payload_schema_version !== IMPORTED_PAYLOAD_SCHEMA_VERSION) {
      if (
        typeof root.payload_schema_version !== "number" ||
        !Number.isInteger(root.payload_schema_version)
      ) {
        throw new ImportValidationError(
          "payload_schema_version",
          `must be the integer ${IMPORTED_PAYLOAD_SCHEMA_VERSION}`,
        );
      }
      throw new ImportValidationError(
        "payload_schema_version",
        `version ${root.payload_schema_version} is not supported; this app supports version ${IMPORTED_PAYLOAD_SCHEMA_VERSION}`,
      );
    }
    payloadSchemaVersion = IMPORTED_PAYLOAD_SCHEMA_VERSION;
    if (!("payload" in root)) {
      throw new ImportValidationError("payload", "is missing");
    }
    payload = root.payload;
  } else {
    payload = root;
  }

  const envelopeWarnings = warnings;
  // Route the normalized candidate through the common request validator so the
  // per-request byte bound, payload bounds, and payload warnings are identical
  // to `POST /imports`. Unknown envelope metadata is intentionally excluded:
  // the request bound applies to what is actually submitted, not to the raw
  // container (the separate 1 MiB file cap still bounds that).
  const parsed = parseImportArtifactInput({
    kind,
    payload_schema_version: payloadSchemaVersion,
    payload,
  });
  return {
    input: parsed.input as ImportArtifactInput<K>,
    warnings: [
      ...envelopeWarnings,
      ...parsed.warnings.map((warning) =>
        looksEnveloped && warning.path !== undefined
          ? { ...warning, path: `payload.${warning.path}` }
          : warning,
      ),
    ],
  };
}

export function parseAnalysisImportFile(text: string): ParsedArtifactImportFile<"analysis"> {
  return parseArtifactImportFile(text, "analysis");
}

export function parsePlanImportFile(text: string): ParsedArtifactImportFile<"plan"> {
  return parseArtifactImportFile(text, "plan");
}

/** Bounds shared with callers that only need to precheck a selected file. */
export const IMPORT_FILE_LIMITS = {
  bytes: IMPORT_MAX_FILE_BYTES,
  records: IMPORT_MAX_FILE_RECORDS,
  collection: IMPORT_MAX_COLLECTION_LENGTH,
} as const;
