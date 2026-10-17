import type { AnalysisFilter, PlanConstraints, WorkoutRecord } from "@pi-fit-trace/core";
import {
  API_ENDPOINTS,
  HTTP_STATUS,
  ImportValidationError,
  encodeArtifactCursor,
  isImportedArtifactKind,
  parseArtifactSelectionRequest,
  parseListImportedArtifactsParams,
  parsePlanAdoptionRequest,
} from "../index.ts";
import type { CreateWorkoutResult, FitTraceClient } from "../types.ts";
import type { ImportArtifactInput } from "../imports.ts";
import { API_ERROR_CODES, ApiError } from "../errors.ts";

/**
 * In-memory route handler implementing the shared endpoints over a supplied
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
  /** Bound for request bodies, matching the authenticated handler's default. */
  maxBodyBytes?: number;
}

export const DEFAULT_MEMORY_MAX_BODY_BYTES = 64 * 1024;

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
    case API_ERROR_CODES.NOT_FOUND:
      return HTTP_STATUS.notFound;
    case API_ERROR_CODES.CONFLICT:
      return HTTP_STATUS.conflict;
    default:
      return HTTP_STATUS.serverError;
  }
}

function parseJsonBody(
  body: string | undefined,
  field: string,
  maxBytes: number,
): unknown {
  if (body === undefined || body === "") return undefined;
  if (new TextEncoder().encode(body).length > maxBytes) {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: `Request body exceeds the ${maxBytes} byte limit.`,
    });
  }
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

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ImportValidationError("id", "is not valid URL encoding");
  }
}

function kindFromSegment(segment: string) {
  const decoded = decodeSegment(segment);
  if (!isImportedArtifactKind(decoded)) {
    throw new ImportValidationError("kind", 'must be "analysis" or "plan"');
  }
  return decoded;
}

export function createMemoryHandler(
  client: FitTraceClient,
  options: MemoryHandlerOptions = {},
): (input: string, init?: HandlerInit) => Promise<HandlerResponse> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MEMORY_MAX_BODY_BYTES;
  return async (input, init = {}) => {
    const url = new URL(input, ROUTE_BASE);
    const method = (init.method ?? "GET").toUpperCase();
    const route = url.pathname;

    try {
      if (route === API_ENDPOINTS.workouts && method === "GET") {
        return ok(await client.listWorkouts());
      }

      if (route === API_ENDPOINTS.workouts && method === "POST") {
        const parsed = parseJsonBody(init.body, "body", maxBodyBytes);
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
        const constraints = parseJsonBody(init.body, "body", maxBodyBytes) as
          | PlanConstraints
          | undefined;
        return ok(await client.createPlanDraft(constraints));
      }

      if (route === API_ENDPOINTS.imports && method === "GET") {
        const query = parseListImportedArtifactsParams(url.searchParams);
        return ok(
          await client.listImportedArtifacts({
            ...(query.kind === undefined ? {} : { kind: query.kind }),
            limit: query.limit,
            cursor: query.cursor === null ? null : encodeArtifactCursor(query.cursor),
          }),
        );
      }

      if (route === API_ENDPOINTS.imports && method === "POST") {
        const parsed = parseJsonBody(init.body, "body", maxBodyBytes);
        // Normalize once in the store: pre-normalizing here would drop the
        // unknown-field warnings before they reach the caller.
        const result = await client.saveImportedArtifact(parsed as ImportArtifactInput);
        return ok(result, result.duplicate ? HTTP_STATUS.ok : HTTP_STATUS.created);
      }

      if (route.startsWith(`${API_ENDPOINTS.imports}/`)) {
        const id = decodeSegment(route.slice(API_ENDPOINTS.imports.length + 1));
        if (id.includes("/")) {
          throw new ImportValidationError("id", "is not valid");
        }
        if (method === "GET") return ok(await client.getImportedArtifact(id));
      }

      if (route.startsWith(`${API_ENDPOINTS.importSelections}/`)) {
        const kind = kindFromSegment(route.slice(API_ENDPOINTS.importSelections.length + 1));
        if (method === "GET") return ok(await client.getArtifactSelection(kind));
        if (method === "PUT") {
          const body = parseJsonBody(init.body, "body", maxBodyBytes);
          const selection = parseArtifactSelectionRequest(body);
          return ok(await client.setArtifactSelection(kind, selection.artifact_id));
        }
      }

      if (route === API_ENDPOINTS.planAdoption) {
        if (method === "GET") return ok(await client.getPlanAdoption());
        if (method === "PUT") {
          const body = parseJsonBody(init.body, "body", maxBodyBytes);
          return ok(await client.setPlanAdoption(parsePlanAdoptionRequest(body)));
        }
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
