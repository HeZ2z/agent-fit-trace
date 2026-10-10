import type { AnalysisFilter, PlanConstraints, WorkoutRecord } from "@pi-fit-trace/core";
import { API_ENDPOINTS, HTTP_STATUS } from "../types.ts";
import type { CreateWorkoutResult, FitTraceClient } from "../types.ts";
import { API_ERROR_CODES, ApiError } from "../errors.ts";

/**
 * In-memory route handler implementing the four endpoints over a supplied
 * {@link FitTraceClient}. Used by tests now and reusable by the dev server
 * later, so it deliberately avoids `node:` built-ins and types the request and
 * response structurally (`HandlerInit`/`HandlerResponse`) rather than relying on
 * `Request`/`Response` globals — those differ between the root `tsc` (lib
 * ES2023 + @types/node) and jsdom, so a plain object runs identically in both.
 */

export interface HandlerInit {
  method?: string;
  body?: string;
}

export interface HandlerResponse {
  status: number;
  body: string;
}

export interface MemoryHandlerOptions {
  /** Reserved for a future fetch-backed transport; unused by the memory routes. */
  fetchImpl?: unknown;
}

/** Base so relative route paths parse without a real origin. */
const ROUTE_BASE = "http://fit-trace.invalid";

function ok(data: unknown, status: number = HTTP_STATUS.ok): HandlerResponse {
  return { status, body: JSON.stringify({ data }) };
}

function error(code: string, message: string, status: number, details?: unknown): HandlerResponse {
  const body = details === undefined ? { code, message } : { code, message, details };
  return { status, body: JSON.stringify({ error: body }) };
}

function statusForError(err: ApiError): number {
  if (err.status !== undefined) return err.status;
  switch (err.code) {
    case API_ERROR_CODES.VALIDATION_ERROR:
      return HTTP_STATUS.badRequest;
    case API_ERROR_CODES.UNAUTHENTICATED:
      return HTTP_STATUS.unauthorized;
    case API_ERROR_CODES.FORBIDDEN:
      return HTTP_STATUS.forbidden;
    case API_ERROR_CODES.CONFLICT:
      return HTTP_STATUS.conflict;
    default:
      return HTTP_STATUS.serverError;
  }
}

function parseJsonBody(body: string | undefined, field: string): unknown {
  if (body === undefined || body === "") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: `\`${field}\` is not valid JSON.`,
    });
  }
}

function toFilter(params: URLSearchParams): AnalysisFilter {
  const filter: AnalysisFilter = {};
  const from = params.get("from");
  const to = params.get("to");
  const exercises = params.get("exercises");
  if (from !== null) filter.from = from;
  if (to !== null) filter.to = to;
  if (exercises !== null) filter.exercises = exercises.split(",");
  return filter;
}

export function createMemoryHandler(
  client: FitTraceClient,
  _options: MemoryHandlerOptions = {},
): (input: string, init?: HandlerInit) => Promise<HandlerResponse> {
  return async (input, init = {}) => {
    const url = new URL(input, ROUTE_BASE);
    const method = (init.method ?? "GET").toUpperCase();
    const route = url.pathname;

    try {
      if (route === API_ENDPOINTS.workouts && method === "GET") {
        return ok(await client.listWorkouts());
      }

      if (route === API_ENDPOINTS.workouts && method === "POST") {
        const parsed = parseJsonBody(init.body, "body");
        const record =
          parsed !== null && typeof parsed === "object" && "record" in parsed
            ? (parsed as { record: WorkoutRecord }).record
            : undefined;
        if (record === undefined) {
          throw new ApiError({
            code: API_ERROR_CODES.VALIDATION_ERROR,
            message: "Request body must be an object with a `record` field.",
          });
        }
        const result: CreateWorkoutResult = await client.createWorkout(record);
        return ok(result, result.duplicate ? HTTP_STATUS.ok : HTTP_STATUS.created);
      }

      if (route === API_ENDPOINTS.analysis && method === "GET") {
        return ok(await client.analyze(toFilter(url.searchParams)));
      }

      if (route === API_ENDPOINTS.planDrafts && method === "POST") {
        const constraints = parseJsonBody(init.body, "body") as PlanConstraints | undefined;
        return ok(await client.createPlanDraft(constraints));
      }

      return error(API_ERROR_CODES.API_ERROR, `No route for ${method} ${route}.`, HTTP_STATUS.serverError);
    } catch (err) {
      if (err instanceof ApiError) {
        return error(err.code, err.message, statusForError(err), err.details);
      }
      const message = err instanceof Error ? err.message : String(err);
      return error(API_ERROR_CODES.API_ERROR, message, HTTP_STATUS.serverError);
    }
  };
}
