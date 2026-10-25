import type { HistoryFilter, WorkoutRecord } from "@agent-fit-trace/core";
import type { QueryResult } from "@agent-fit-trace/store";

/**
 * Minimal store surface the MCP tools and resources call. Both backends in
 * `@agent-fit-trace/store` satisfy it structurally — the JSON `WorkoutStore`
 * and the SQLite `SqliteWorkoutStore` (same Promise-based `all`/`import`/
 * `query` and error contract) — so the server factory accepts either without
 * caring which backend is live.
 */
export interface FitTraceStore {
  all(): Promise<WorkoutRecord[]>;
  import(record: WorkoutRecord): Promise<{ duplicate: boolean; total: number }>;
  query(filter?: HistoryFilter): Promise<QueryResult>;
}
