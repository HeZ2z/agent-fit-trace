/**
 * Read-only domain executor for non-pi coached runtimes.
 *
 * A coached CLI adapter must never expose its built-in file/shell/network
 * tools. Instead the adapter answers the two coached tool calls itself using
 * this executor: the run's immutable snapshot file is read ONCE, every record
 * is re-validated with the shared core schema, the whole tree is frozen, and
 * only the deterministic core `filterRecords` / `analyzeProgress` functions
 * run against it. `analyze_progress` details are re-parsed through the shared
 * `parseAnalysisResult` guard before they can become a coaching result.
 *
 * The child process never receives the snapshot path: tool arguments are the
 * only model-controlled input, and they are bounded and validated here.
 */
import { readFile } from "node:fs/promises";
import {
  assertOrderedDateRange,
  assertValidFilterDate,
  filterRecords,
  analyzeProgress,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { parseAnalysisResult } from "@pi-fit-trace/api-contracts";
import type { AnalysisResult } from "@pi-fit-trace/core";

const MAX_HISTORY_LIMIT = 200;
const MAX_STRING_FIELD = 120;
const MAX_EXERCISES = 20;

export class DomainToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainToolError";
  }
}

export interface DomainHistoryPage {
  records: WorkoutRecord[];
  total: number;
  offset: number;
  limit: number | null;
}

export interface SnapshotDomainExecutor {
  readonly recordCount: number;
  getTrainingHistory(args: unknown): DomainHistoryPage;
  analyze(args: unknown): AnalysisResult;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainToolError("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DomainToolError(`${field} must be an ISO date string`);
  if (value.length > MAX_STRING_FIELD) throw new DomainToolError(`${field} is too long`);
  try {
    return assertValidFilterDate(value, field);
  } catch {
    throw new DomainToolError(`${field} must be a valid ISO date`);
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_STRING_FIELD) {
    throw new DomainToolError(`${field} must be a bounded string`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new DomainToolError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertKnownKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new DomainToolError(`unsupported argument ${JSON.stringify(key).slice(0, 80)}`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}

function parseSnapshot(raw: string): WorkoutRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DomainToolError("snapshot is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { records?: unknown }).records)) {
    throw new DomainToolError("snapshot has no records array");
  }
  const records = (parsed as { records: unknown[] }).records;
  const validated: WorkoutRecord[] = [];
  for (let index = 0; index < records.length; index += 1) {
    try {
      validated.push(validateWorkoutRecord(records[index]).record);
    } catch {
      throw new DomainToolError(`snapshot record ${index} is invalid`);
    }
  }
  return deepFreeze(validated);
}

/** Load and validate one immutable snapshot, then serve bounded read-only calls. */
export async function loadSnapshotDomainExecutor(snapshotFile: string): Promise<SnapshotDomainExecutor> {
  const records = parseSnapshot(await readFile(snapshotFile, "utf8"));
  return {
    recordCount: records.length,
    getTrainingHistory(args: unknown): DomainHistoryPage {
      const parsed = asRecord(args);
      assertKnownKeys(parsed, ["from", "to", "exercise", "limit", "offset"]);
      const from = optionalDate(parsed.from, "from");
      const to = optionalDate(parsed.to, "to");
      try {
        assertOrderedDateRange(from, to);
      } catch {
        throw new DomainToolError("from must not be after to");
      }
      const exercise = optionalString(parsed.exercise, "exercise");
      const limit = optionalInteger(parsed.limit, "limit", 1, MAX_HISTORY_LIMIT) ?? null;
      const offset = optionalInteger(parsed.offset, "offset", 0, 100_000) ?? 0;
      const scoped = filterRecords(records, {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(exercise !== undefined ? { exercises: [exercise] } : {}),
      });
      const page = limit === null ? scoped.slice(offset) : scoped.slice(offset, offset + limit);
      return { records: [...page], total: scoped.length, offset, limit };
    },
    analyze(args: unknown): AnalysisResult {
      const parsed = asRecord(args);
      assertKnownKeys(parsed, ["from", "to", "exercises"]);
      const from = optionalDate(parsed.from, "from");
      const to = optionalDate(parsed.to, "to");
      try {
        assertOrderedDateRange(from, to);
      } catch {
        throw new DomainToolError("from must not be after to");
      }
      let exercises: string[] | undefined;
      if (parsed.exercises !== undefined && parsed.exercises !== null) {
        if (!Array.isArray(parsed.exercises) || parsed.exercises.length > MAX_EXERCISES) {
          throw new DomainToolError(`exercises must be an array of at most ${MAX_EXERCISES} names`);
        }
        exercises = parsed.exercises.map((entry) => {
          if (typeof entry !== "string" || entry.length > MAX_STRING_FIELD) {
            throw new DomainToolError("each exercise must be a bounded string");
          }
          return entry;
        });
      }
      const analysis = analyzeProgress(records, {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(exercises !== undefined ? { exercises } : {}),
      });
      // The deterministic core result is re-parsed by the shared contract
      // guard; malformed details can never become a coaching result.
      return parseAnalysisResult(analysis);
    },
  };
}
