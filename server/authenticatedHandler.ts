import type { AnalysisFilter, PlanConstraints, WorkoutRecord } from "@pi-fit-trace/core";
import {
  API_ENDPOINTS,
  API_ERROR_CODES,
  ApiError,
  HTTP_STATUS,
} from "@pi-fit-trace/api-contracts";
import type {
  AuthPrincipal,
  CreateWorkoutResult,
  FitTraceClient,
} from "@pi-fit-trace/api-contracts";
import { extractBearerToken } from "./auth/verifier.ts";
import type { TokenVerifier } from "./auth/verifier.ts";
import type { PrincipalStoreFactory } from "./principalMemoryStore.ts";
import type { ServerPublicConfig } from "./publicConfig.ts";

/**
 * Authenticated route handler shared by the loopback dev server and the
 * Vercel functions.
 *
 * Every workout/analysis/plan route verifies the `Authorization: Bearer`
 * token first and scopes the store to the resolved principal; unauthenticated
 * requests fail closed with 401 `UNAUTHENTICATED` and a `WWW-Authenticate:
 * Bearer` header. Only `GET /public-config` is public, so the app can
 * bootstrap login without credentials. A missing verifier or store factory
 * also fails closed (500 `API_ERROR`, never anonymous access).
 */

export interface AuthenticatedRequestInit {
  method?: string;
  body?: string;
  authorization?: string;
}

export interface AuthenticatedResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface AuthenticatedHandlerOptions {
  verifier: TokenVerifier | null;
  stores: PrincipalStoreFactory | null;
  /** Runtime public config for `GET /public-config`; null omits the key fields. */
  publicConfig?: ServerPublicConfig | null;
  /** Bound request bodies (bytes); oversized bodies reject as VALIDATION_ERROR. */
  maxBodyBytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const WWW_AUTHENTICATE = "Bearer";

const ROUTE_BASE = "http://fit-trace.invalid";

function json(status: number, payload: unknown, extraHeaders?: Record<string, string>): AuthenticatedResponse {
  return {
    status,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  };
}

function ok(data: unknown, status: number = HTTP_STATUS.ok): AuthenticatedResponse {
  return json(status, { data });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): AuthenticatedResponse {
  const body = details === undefined ? { code, message } : { code, message, details };
  const headers: Record<string, string> =
    status === HTTP_STATUS.unauthorized ? { "www-authenticate": WWW_AUTHENTICATE } : {};
  return json(status, { error: body }, headers);
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

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

function parseJsonBody(body: string | undefined, field: string, maxBytes: number): unknown {
  if (body === undefined || body === "") return undefined;
  if (byteLengthUtf8(body) > maxBytes) {
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

async function resolvePrincipal(
  verifier: TokenVerifier | null,
  authorization: string | undefined,
): Promise<AuthPrincipal> {
  // Fail closed: without a verifier, or without/invalid credentials, nobody
  // is anonymous — the request is rejected before touching any store.
  if (verifier === null) {
    throw new ApiError({
      code: API_ERROR_CODES.API_ERROR,
      message: "Authentication is not configured.",
    });
  }
  const token = extractBearerToken(authorization);
  if (token === null) {
    throw new ApiError({
      code: API_ERROR_CODES.UNAUTHENTICATED,
      message: "Missing bearer token.",
      status: HTTP_STATUS.unauthorized,
    });
  }
  try {
    return await verifier.verify(token);
  } catch (error) {
    // Preserve service-availability failures so transient Auth outages
    // surface as 503 instead of forcing a logout.
    if (error instanceof ApiError) {
      if (error.code === API_ERROR_CODES.UNAUTHENTICATED) {
        if (error.status === undefined) error.status = HTTP_STATUS.unauthorized;
        throw error;
      }
      throw error;
    }
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === API_ERROR_CODES.UNAUTHENTICATED) {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Invalid or expired bearer token.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    throw new ApiError({
      code: API_ERROR_CODES.UNAUTHENTICATED,
      message: "Invalid or expired bearer token.",
      status: HTTP_STATUS.unauthorized,
    });
  }
}

export function createAuthenticatedHandler(
  options: AuthenticatedHandlerOptions,
): (input: string, init?: AuthenticatedRequestInit) => Promise<AuthenticatedResponse> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (input, init = {}) => {
    const url = new URL(input, ROUTE_BASE);
    const method = (init.method ?? "GET").toUpperCase();
    const route = url.pathname;

    try {
      if (route === API_ENDPOINTS.publicConfig && method === "GET") {
        const config = options.publicConfig ?? null;
        if (config === null) {
          return errorResponse(
            API_ERROR_CODES.API_ERROR,
            "Public configuration is not available.",
            HTTP_STATUS.serverError,
          );
        }
        return ok({
          supabaseUrl: config.supabaseUrl,
          supabasePublishableKey: config.supabasePublishableKey,
          guestSignInEnabled: config.guestSignInEnabled === true,
        });
      }

      const principal = await resolvePrincipal(options.verifier, init.authorization);
      if (options.stores === null) {
        return errorResponse(
          API_ERROR_CODES.API_ERROR,
          "Workout storage is not configured.",
          HTTP_STATUS.serverError,
        );
      }
      const client: FitTraceClient = options.stores.storeFor(principal);

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

      return errorResponse(
        API_ERROR_CODES.API_ERROR,
        `No route for ${method} ${route}.`,
        HTTP_STATUS.serverError,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err.code, err.message, statusForError(err), err.details);
      }
      return errorResponse(API_ERROR_CODES.API_ERROR, "Internal error.", HTTP_STATUS.serverError);
    }
  };
}
