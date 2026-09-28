import {
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  ValidationError,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type {
  AnalysisFilter,
  AnalysisResult,
  PlanConstraints,
  PlanDraft,
  ValidationWarning,
  WorkoutRecord,
} from "@pi-fit-trace/core";
import { API_ERROR_CODES, ApiError, deriveWorkoutId } from "@pi-fit-trace/api-contracts";
import type { CreateWorkoutResult, FitTraceClient } from "@pi-fit-trace/api-contracts";
import { LocalStorageAdapter, StorageUnavailableError } from "../storage/adapter.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import {
  StorageCorruptionError,
  loadRecord,
  loadRecords,
  saveRecord,
} from "../storage/workoutRepository.ts";

/**
 * Maps a thrown storage/core error onto the API error contract. Unknown
 * errors pass through untouched so nothing is silently re-labelled.
 */
function toApiError(error: unknown): unknown {
  if (error instanceof ValidationError) {
    return new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: error.message,
      details: { issues: error.issues },
    });
  }
  if (error instanceof StorageUnavailableError) {
    return new ApiError({ code: API_ERROR_CODES.STORAGE_UNAVAILABLE, message: error.message });
  }
  if (error instanceof StorageCorruptionError) {
    return new ApiError({ code: API_ERROR_CODES.CORRUPT_STORE, message: error.message });
  }
  return error;
}

function hasUsableId(record: WorkoutRecord): boolean {
  return typeof record.id === "string" && record.id.trim() !== "";
}

/**
 * `FitTraceClient` over the browser's own storage, reusing the repository's
 * per-record keys (`pi-fit-trace:workout:v1:<id>`) so records written by the
 * existing store remain readable verbatim.
 *
 * Every method is async, which is what turns synchronous storage throws
 * (blocked `localStorage`) into promise rejections; error translation happens
 * in `toApiError`, never by swallowing.
 */
export class LocalFitTraceClient implements FitTraceClient {
  private readonly adapter: StorageAdapter;

  constructor(adapter: StorageAdapter = new LocalStorageAdapter()) {
    this.adapter = adapter;
  }

  async listWorkouts(): Promise<WorkoutRecord[]> {
    try {
      return loadRecords(this.adapter);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
    try {
      // Derive the id from the raw content *before* validation and dispatch,
      // so a retried submit always targets the same id (idempotent retries).
      const withId = hasUsableId(record) ? record : { ...record, id: deriveWorkoutId(record) };

      let normalized: WorkoutRecord;
      let warnings: ValidationWarning[];
      try {
        const validated = validateWorkoutRecord(withId);
        normalized = validated.record;
        warnings = validated.warnings;
      } catch (error) {
        throw toApiError(error);
      }

      // Idempotency runs on the normalized record: identical content is a
      // no-op duplicate, differing content under the same id is a conflict.
      const existing = loadRecord(this.adapter, normalized.id);
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

      saveRecord(this.adapter, normalized);
      return { record: normalized, duplicate: false, warnings };
    } catch (error) {
      throw toApiError(error);
    }
  }

  async analyze(filter?: AnalysisFilter): Promise<AnalysisResult> {
    try {
      // Core throws ValidationError on invalid or inverted filter dates.
      return analyzeProgress(loadRecords(this.adapter), filter);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async createPlanDraft(input?: PlanConstraints): Promise<PlanDraft> {
    try {
      return generateNextPlan(loadRecords(this.adapter), input);
    } catch (error) {
      throw toApiError(error);
    }
  }
}
