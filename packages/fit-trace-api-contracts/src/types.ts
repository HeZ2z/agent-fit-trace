import type {
  AnalysisFilter,
  AnalysisResult,
  PlanConstraints,
  PlanDraft,
  ValidationWarning,
  WorkoutRecord,
} from "@pi-fit-trace/core";

/**
 * Transport contract shared by the fit-trace app and any HTTP-shaped backend.
 *
 * This module describes *how* the four domain operations cross a network
 * boundary — the client surface, the JSON envelope, and the endpoint/status
 * mapping. The computations themselves stay in `@pi-fit-trace/core`; nothing
 * here decides values, only shapes.
 */

/** Outcome of an idempotent create: the stored record plus a duplicate signal. */
export interface CreateWorkoutResult {
  record: WorkoutRecord;
  /** True when an identical record with this id was already present (no-op). */
  duplicate: boolean;
  warnings: ValidationWarning[];
}

/**
 * The operations the app can reach over the network, expressed as async calls.
 * Implementations may hit a real HTTP server or an in-memory handler; either
 * way they resolve with unwrapped domain values (the envelope is stripped by
 * the transport, not by callers).
 */
export interface FitTraceClient {
  listWorkouts(): Promise<WorkoutRecord[]>;
  createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult>;
  analyze(filter?: AnalysisFilter): Promise<AnalysisResult>;
  createPlanDraft(input?: PlanConstraints): Promise<PlanDraft>;
}

export interface OkEnvelope<T> {
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  error: ApiErrorBody;
}

export const FIT_TRACE_API_VERSION = "v1";

/** Resource paths for the four endpoints (see status semantics below). */
export const API_ENDPOINTS = {
  workouts: "/workouts",
  analysis: "/analysis",
  planDrafts: "/plans/drafts",
} as const;

/**
 * Status semantics:
 * - `POST /workouts` (body `{ record }`) → 201 on a new record, 200 on an
 *   identical retry (`duplicate`), 400 on invalid input, 409 when the id
 *   already exists with different content.
 * - `GET /workouts` → 200 list.
 * - `GET /analysis` (optional `from`/`to`/`exercises` query) → 200.
 * - `POST /plans/drafts` (optional `PlanConstraints` body) → 200.
 * - Any unexpected failure → 500 with an {@link ErrorEnvelope}.
 */
export const HTTP_STATUS = {
  created: 201,
  ok: 200,
  badRequest: 400,
  conflict: 409,
  serverError: 500,
} as const;
