import { CURRENT_SCHEMA_VERSION, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_RECORDS,
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

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Split records so every part is a file the restore page accepts again.
 *
 * The restore contract rejects a file over 1 MiB, more than 1000 records, or a
 * single record whose normalized request exceeds the workout restore bound.
 * That request bound equals the file bound, so a large but valid stored workout
 * (including one above the tighter snapshot request cap) is still restorable.
 * Sizing by count only would still let one oversized record make the backup
 * unrestorable, so each candidate part is run through the same parser restore
 * uses. If a single record exceeds the file container itself the export fails
 * with an explicit error instead of downloading a file this page would refuse.
 */
function partitionRestorable(
  records: readonly WorkoutRecord[],
): readonly (readonly WorkoutRecord[])[] {
  if (records.length === 0) return [];
  const text = serializeWorkoutExport(records);
  const withinFileLimits =
    records.length <= IMPORT_MAX_FILE_RECORDS &&
    byteLengthUtf8(text) <= IMPORT_MAX_FILE_BYTES;
  if (withinFileLimits) {
    try {
      parseWorkoutImportFile(text);
      return [records];
    } catch {
      // Splitting cannot fix a single record that itself violates the import
      // contract; only recurse while another record could still be separated.
      if (records.length === 1) {
        throw new Error(
          `Cannot export record \`${records[0]?.id ?? "(unknown)"}\`: it does not satisfy the restore contract.`,
        );
      }
    }
  }
  if (records.length === 1) {
    throw new Error(
      `Cannot export record \`${records[0]?.id ?? "(unknown)"}\`: its backup file would exceed the ${IMPORT_MAX_FILE_BYTES} byte restore limit.`,
    );
  }
  const middle = Math.ceil(records.length / 2);
  return [
    ...partitionRestorable(records.slice(0, middle)),
    ...partitionRestorable(records.slice(middle)),
  ];
}

function partFilenames(count: number): string[] {
  if (count <= 1) return ["workout.json"];
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
 * so a successful export can always be restored one file at a time.
 */
export function planWorkoutExport(
  records: readonly WorkoutRecord[],
): WorkoutExportFilePart[] {
  const parts = partitionRestorable(records);
  const filenames = partFilenames(parts.length);
  return parts.map((part, index) => ({
    filename: filenames[index] as string,
    text: serializeWorkoutExport(part),
    recordCount: part.length,
  }));
}
