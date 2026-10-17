import { useCallback, useState } from "react";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { downloadJson } from "./fileTransport.ts";
import { planWorkoutExport } from "./workoutExport.ts";

export interface WorkoutExportResult {
  /** Number of files downloaded (more than one when the history was split). */
  files: number;
  /** Records included across all files. */
  records: number;
}

export interface WorkoutExport {
  /** Serialize the records and download them as one or more `workout*.json` files. */
  exportWorkouts: () => void;
  /** Message from the last failed export attempt, or `null`. */
  error: string | null;
  /** Summary of the last successful export, or `null`. */
  result: WorkoutExportResult | null;
}

/**
 * Return an action that exports the given records as restorable v1 backup
 * files, plus the outcome of the most recent attempt.
 *
 * Large histories are split so every downloaded file satisfies the same
 * count/byte bounds the restore page enforces. Both serialization (an invalid
 * record or an unexportable single record) and the download itself (browser
 * download APIs unavailable) can fail, so failures are caught here and exposed
 * to the caller rather than escaping silently. A partial multi-file download
 * is reported as such instead of being presented as a complete backup.
 */
export function useWorkoutExport(records: readonly WorkoutRecord[]): WorkoutExport {
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkoutExportResult | null>(null);

  const exportWorkouts = useCallback(() => {
    setError(null);
    setResult(null);
    let files = 0;
    try {
      const parts = planWorkoutExport(records);
      for (const part of parts) {
        downloadJson(part.filename, part.text);
        files += 1;
      }
      setResult({ files: parts.length, records: records.length });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        files === 0
          ? message
          : `${message} ${files} of the planned backup files were downloaded before the failure; re-export to get a complete set.`,
      );
    }
  }, [records]);

  return { exportWorkouts, error, result };
}
