import type { WorkoutRecord } from "@agent-fit-trace/core";

/** Versioned payload exchanged as a `workout.json` file. */
export interface WorkoutExportFile {
  schema_version: number;
  records: WorkoutRecord[];
}

/**
 * `MalformedResponseError` now lives in the shared contract package; re-export
 * it so the app keeps one class identity across the api and contracts layers.
 */
export { MalformedResponseError } from "@agent-fit-trace/api-contracts";
