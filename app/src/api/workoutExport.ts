import { CURRENT_SCHEMA_VERSION, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_RECORDS,
  ImportValidationError,
  parseWorkoutImportFile,
} from "@pi-fit-trace/api-contracts";
import type { WorkoutExportFile } from "./contracts.ts";

/**
 * Serialize records into the `workout.json` exchange format.
 *
 * Deterministic and idempotent by construction: no timestamps, clock, or
 * randomness are involved, and record key order/order-of-array are preserved.
 * Every record is re-validated first, so an invalid record throws and nothing
 * is produced (we never export something the Extension would reject).
 */
export function serializeWorkoutExport(records: readonly WorkoutRecord[]): string {
  const validated = records.map((record) => validateWorkoutRecord(record).record);

  const file: WorkoutExportFile = {
    schema_version: CURRENT_SCHEMA_VERSION,
    records: validated,
  };

  return `${JSON.stringify(file, null, 2)}\n`;
}

export interface WorkoutExportFilePart {
  filename: string;
  text: string;
  recordCount: number;
}

export interface WorkoutExportExclusion {
  /** The stored record id, or `(unknown)` when even the id is unusable. */
  id: string;
  /** Why this record cannot be represented in a restorable backup file. */
  reason: string;
}

export interface WorkoutExportPlan {
  files: WorkoutExportFilePart[];
  /**
   * Stored records deliberately left out of every file because they cannot be
   * represented in a file the restore page accepts. The export never drops
   * these silently: callers must report them to the user.
   */
  excluded: WorkoutExportExclusion[];
}

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

interface ExportCandidate {
  record: WorkoutRecord;
  /** Original position, used to report exclusions in history order. */
  index: number;
}

interface PlannedExclusion extends WorkoutExportExclusion {
  index: number;
}

interface PartitionPlan {
  parts: ExportCandidate[][];
  excluded: PlannedExclusion[];
}

function safeRecordId(record: WorkoutRecord): string {
  return typeof record.id === "string" && record.id.trim() !== "" ? record.id : "(unknown)";
}

function errorDetail(error: unknown): string {
  if (error instanceof ImportValidationError) {
    return error.message.replace(/^Invalid import: /, "").replace(/\.$/, "");
  }
  if (error instanceof Error && error.message !== "") {
    return error.message.replace(/\.$/, "");
  }
  return String(error);
}

function restoreContractReason(error: unknown): string {
  return `cannot be represented in a restorable file: ${errorDetail(error)}`;
}

/**
 * Validate each record before partitioning.
 *
 * A record the core workout validator rejects cannot be serialized at all.
 * Isolating it here lets the rest of history back up while still reporting the
 * exceptional id instead of aborting the whole export.
 */
function validateCandidates(records: readonly WorkoutRecord[]): {
  candidates: ExportCandidate[];
  excluded: PlannedExclusion[];
} {
  const candidates: ExportCandidate[] = [];
  const excluded: PlannedExclusion[] = [];
  records.forEach((record, index) => {
    try {
      const validated = validateWorkoutRecord(record).record;
      candidates.push({ record: validated, index });
    } catch (error) {
      excluded.push({
        index,
        id: safeRecordId(record),
        reason: `does not satisfy the workout validator: ${errorDetail(error)}`,
      });
    }
  });
  return { candidates, excluded };
}

/**
 * Split records so every part is a file the restore page accepts again.
 *
 * The restore contract rejects a file over 1 MiB, more than 1000 records, or a
 * single record whose normalized request exceeds the workout restore bound.
 * That request bound equals the file bound, so a large but valid stored workout
 * (including one above the tighter snapshot request cap) is still restorable.
 * Sizing by count only would still let one oversized or over-bound record make
 * the backup unrestorable, so each candidate part is run through the same
 * parser restore uses.
 *
 * When a single record cannot satisfy that parser, it is reported as an
 * exclusion and every other record still exports. The export never aborts just
 * because one legacy record cannot satisfy the current cloud restore contract.
 */
function partitionRestorable(candidates: readonly ExportCandidate[]): PartitionPlan {
  if (candidates.length === 0) return { parts: [], excluded: [] };
  const records = candidates.map((candidate) => candidate.record);
  const text = serializeWorkoutExport(records);
  const fileBytes = byteLengthUtf8(text);
  const withinFileLimits =
    candidates.length <= IMPORT_MAX_FILE_RECORDS && fileBytes <= IMPORT_MAX_FILE_BYTES;
  if (withinFileLimits) {
    try {
      parseWorkoutImportFile(text);
      return { parts: [candidates.slice()], excluded: [] };
    } catch (error) {
      if (candidates.length === 1) {
        const [candidate] = candidates as [ExportCandidate];
        return {
          parts: [],
          excluded: [
            {
              index: candidate.index,
              id: safeRecordId(candidate.record),
              reason: restoreContractReason(error),
            },
          ],
        };
      }
      // Splitting can isolate the offending record; only a single record that
      // itself violates the restore contract is unexportable.
    }
  }
  if (candidates.length === 1) {
    const [candidate] = candidates as [ExportCandidate];
    return {
      parts: [],
      excluded: [
        {
          index: candidate.index,
          id: safeRecordId(candidate.record),
          reason: `its backup file would be ${fileBytes} bytes, above the ${IMPORT_MAX_FILE_BYTES} byte restore limit`,
        },
      ],
    };
  }
  const middle = Math.ceil(candidates.length / 2);
  const left = partitionRestorable(candidates.slice(0, middle));
  const right = partitionRestorable(candidates.slice(middle));
  return {
    parts: [...left.parts, ...right.parts],
    excluded: [...left.excluded, ...right.excluded],
  };
}

function partFilenames(count: number): string[] {
  if (count === 0) return [];
  if (count === 1) return ["workout.json"];
  const width = Math.max(2, String(count).length);
  const total = String(count).padStart(width, "0");
  return Array.from({ length: count }, (_, index) => {
    const part = String(index + 1).padStart(width, "0");
    return `workout-${part}-of-${total}.json`;
  });
}

/**
 * Plan the downloadable backup files for the current history.
 *
 * Each returned file is guaranteed to pass the same parser that restore uses,
 * so every included record can be restored one file at a time. A record that
 * cannot be represented in such a file (for example an id above the btree-safe
 * bound, or a single record larger than the restore file limit) is returned in
 * `excluded` with its id and reason. The remaining history still exports.
 */
export function planWorkoutExport(records: readonly WorkoutRecord[]): WorkoutExportPlan {
  const validated = validateCandidates(records);
  const partition = partitionRestorable(validated.candidates);
  const excluded = [...validated.excluded, ...partition.excluded]
    .sort((left, right) => left.index - right.index)
    .map(({ id, reason }) => ({ id, reason }));
  const filenames = partFilenames(partition.parts.length);
  const files = partition.parts.map((part, index) => ({
    filename: filenames[index] as string,
    text: serializeWorkoutExport(part.map((candidate) => candidate.record)),
    recordCount: part.length,
  }));
  return { files, excluded };
}
