import {
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  sortRecords,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type {
  AnalysisFilter,
  PlanConstraints,
  PlanDraft,
  AnalysisResult,
  ValidationWarning,
  WorkoutRecord,
} from "@pi-fit-trace/core";
import { API_ERROR_CODES, ApiError } from "@pi-fit-trace/api-contracts";
import type { CreateWorkoutResult, FitTraceClient } from "@pi-fit-trace/api-contracts";
import { ValidationError } from "@pi-fit-trace/core";

/** Map a thrown core error onto the API error contract; unknown errors pass through. */
function toApiError(error: unknown): unknown {
  if (error instanceof ValidationError) {
    return new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: error.message,
      details: { issues: error.issues },
    });
  }
  return error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validationError(field: string, reason: string): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.VALIDATION_ERROR,
    message: `Invalid plan constraints: \`${field}\` ${reason}.`,
  });
}

function parsePlanConstraints(input: unknown): PlanConstraints | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: "Plan constraints must be a JSON object.",
    });
  }
  if ("goal" in input && input.goal !== undefined && typeof input.goal !== "string") {
    throw validationError("goal", "must be a string");
  }
  if ("days_available" in input && input.days_available !== undefined) {
    const days = input.days_available;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 7) {
      throw validationError("days_available", "must be an integer from 1 to 7");
    }
  }
  for (const field of ["equipment", "constraints"] as const) {
    if (field in input && input[field] !== undefined) {
      const value = input[field];
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        throw validationError(field, "must be an array of strings");
      }
    }
  }
  return input as PlanConstraints;
}

/**
 * Server-side, in-memory, append-only `FitTraceClient`. Records are keyed by
 * id and never overwritten: an identical re-import is a no-op duplicate and
 * the same id with different content is a conflict.
 *
 * The server requires the caller to supply the id and NEVER derives one:
 * malformed bodies and missing/blank ids are rejected as `VALIDATION_ERROR`.
 * Plan-constraint field validation is part of the server's independent
 * request validation and runs before any plan is generated.
 *
 * All imports are serialized through a promise queue so the
 * check-then-store sequence is atomic. The body is currently synchronous, so
 * JS single-threading already makes it atomic; the queue is an explicit
 * guarantee that survives if the body ever becomes async (e.g. a future
 * durable store with awaits between check and write).
 */
export function createInMemoryWorkoutStore(): FitTraceClient {
  const records = new Map<string, WorkoutRecord>();
  let queue: Promise<void> = Promise.resolve();

  function sortedRecords(): WorkoutRecord[] {
    return sortRecords([...records.values()]);
  }

  return {
    listWorkouts(): Promise<WorkoutRecord[]> {
      return Promise.resolve(sortedRecords());
    },

    createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
      const task = async (): Promise<CreateWorkoutResult> => {
        // Validate the raw record directly: a missing/blank id or a
        // non-object body fails in core validation and maps to
        // VALIDATION_ERROR below.
        let normalized: WorkoutRecord;
        let warnings: ValidationWarning[];
        try {
          const validated = validateWorkoutRecord(record);
          normalized = validated.record;
          warnings = validated.warnings;
        } catch (error) {
          throw toApiError(error);
        }
        const existing = records.get(normalized.id) ?? null;
        if (existing !== null) {
          if (stableStringify(existing) === stableStringify(normalized)) {
            return { record: existing, duplicate: true, warnings };
          }
          throw new ApiError({
            code: API_ERROR_CODES.CONFLICT,
            message: `A workout with id "${normalized.id}" already exists with different content.`,
            details: { id: normalized.id },
          });
        }
        records.set(normalized.id, normalized);
        return { record: normalized, duplicate: false, warnings };
      };
      const result = queue.then(task);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    analyze(filter?: AnalysisFilter): Promise<AnalysisResult> {
      try {
        return Promise.resolve(analyzeProgress(sortedRecords(), filter));
      } catch (error) {
        return Promise.reject(toApiError(error));
      }
    },

    createPlanDraft(input?: PlanConstraints): Promise<PlanDraft> {
      let constraints: PlanConstraints | undefined;
      try {
        constraints = parsePlanConstraints(input);
      } catch (error) {
        return Promise.reject(error);
      }
      try {
        return Promise.resolve(generateNextPlan(sortedRecords(), constraints));
      } catch (error) {
        return Promise.reject(toApiError(error));
      }
    },
  };
}
