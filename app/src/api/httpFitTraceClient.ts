import type {
  AnalysisFilter,
  AnalysisResult,
  PlanConstraints,
  PlanDraft,
  WorkoutRecord,
} from "@pi-fit-trace/core";
import {
  API_ENDPOINTS,
  API_ERROR_CODES,
  ApiError,
  deriveWorkoutId,
  MalformedResponseError,
  NetworkError,
  parseAnalysisResult,
  parseCreateWorkoutResult,
  parsePlanDraft,
  parseWorkoutList,
} from "@pi-fit-trace/api-contracts";
import type {
  CreateWorkoutResult,
  FitTraceClient,
} from "@pi-fit-trace/api-contracts";

/**
 * `FitTraceClient` over an HTTP transport. The fetch dependency is typed
 * minimally (string input, `{ method, body }` init, `{ status, text() }`
 * response) so tests can inject the in-memory route handler without a global
 * `fetch` polyfill, while the browser's real `fetch` satisfies it unchanged.
 *
 * Hard rule: writes are never retried and never fall back to local storage —
 * an ambiguous submit must surface as a rejection the user can reason about.
 */

export interface HttpRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface HttpResponseLike {
  status: number;
  text(): string | Promise<string>;
}

export type HttpFetch = (
  input: string,
  init?: HttpRequestInit,
) => HttpResponseLike | Promise<HttpResponseLike>;

export type AccessTokenProvider = () => string | null | Promise<string | null>;

export interface HttpFitTraceClientOptions {
  baseUrl?: string;
  fetchImpl?: HttpFetch;
  /**
   * Injectable credential provider: called per request (and awaited when it
   * returns a promise) to attach `Authorization: Bearer <token>`. A `null`
   * resolution sends the request without credentials so the server answers
   * 401 `UNAUTHENTICATED`. The token is only placed on the wire — never in a
   * workout payload, URL, or log.
   */
  getAccessToken?: AccessTokenProvider;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Unwrap the `{ data }` envelope; anything else cannot be trusted. */
function readData(parsed: unknown): unknown {
  if (!isObject(parsed) || !("data" in parsed)) {
    throw new MalformedResponseError("data", "is missing");
  }
  return parsed.data;
}

/** Turn a non-2xx response into an `ApiError`; an unreadable envelope becomes `API_ERROR`. */
function toApiError(parsed: unknown, status: number): ApiError {
  const body = isObject(parsed) ? parsed.error : undefined;
  if (isObject(body) && typeof body.code === "string" && typeof body.message === "string") {
    return new ApiError({
      code: body.code,
      message: body.message,
      details: body.details,
      status,
    });
  }
  return new ApiError({
    code: API_ERROR_CODES.API_ERROR,
    message: `Server responded with status ${status} and a malformed error body.`,
    status,
  });
}

function queryString(filter: AnalysisFilter | undefined): string {
  if (filter === undefined) return "";
  const params = new URLSearchParams();
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  // The documented query form is a single comma-separated `exercises` value.
  if (filter.exercises !== undefined && filter.exercises.length > 0) {
    params.set("exercises", filter.exercises.join(","));
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

function hasUsableId(record: WorkoutRecord): boolean {
  return typeof record.id === "string" && record.id.trim() !== "";
}

export class HttpFitTraceClient implements FitTraceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: HttpFetch;
  private readonly getAccessToken?: AccessTokenProvider;

  constructor({
    baseUrl = "/api/v1",
    fetchImpl = (input, init) => globalThis.fetch(input, init),
    getAccessToken,
  }: HttpFitTraceClientOptions = {}) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
  }

  private async request<T>(
    path: string,
    init: HttpRequestInit | undefined,
    unwrap: (data: unknown) => T,
  ): Promise<T> {
    let response: HttpResponseLike;
    // Resolve credentials per request so a refreshed session applies to the
    // next call without recreating the client. Exactly one HTTP attempt is
    // made here — 401s (including expired sessions) are surfaced, never
    // silently retried, so an ambiguous write cannot double-apply.
    const accessToken = this.getAccessToken === undefined ? null : await this.getAccessToken();
    const headers: Record<string, string> = {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...(accessToken === null || accessToken === "" ? {} : { authorization: `Bearer ${accessToken}` }),
    };
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new NetworkError(undefined, { cause: error });
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new NetworkError("Network response body could not be read.", { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (isOkStatus(response.status)) {
        throw new MalformedResponseError("(root)", "is not valid JSON");
      }
      throw toApiError(undefined, response.status);
    }
    if (!isOkStatus(response.status)) {
      throw toApiError(parsed, response.status);
    }
    return unwrap(readData(parsed));
  }

  async listWorkouts(): Promise<WorkoutRecord[]> {
    return this.request(API_ENDPOINTS.workouts, undefined, parseWorkoutList);
  }

  async createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
    // Same id rule as the local client: derive before dispatch so a retried
    // submit sends an identical body and lands on the same id server-side.
    const withId = hasUsableId(record) ? record : { ...record, id: deriveWorkoutId(record) };
    return this.request(
      API_ENDPOINTS.workouts,
      { method: "POST", body: JSON.stringify({ record: withId }) },
      parseCreateWorkoutResult,
    );
  }

  async analyze(filter?: AnalysisFilter): Promise<AnalysisResult> {
    return this.request(
      `${API_ENDPOINTS.analysis}${queryString(filter)}`,
      undefined,
      parseAnalysisResult,
    );
  }

  async createPlanDraft(input?: PlanConstraints): Promise<PlanDraft> {
    return this.request(
      API_ENDPOINTS.planDrafts,
      { method: "POST", body: input === undefined ? undefined : JSON.stringify(input) },
      parsePlanDraft,
    );
  }
}
