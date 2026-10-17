import { stableStringify } from "@pi-fit-trace/core";
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
  applyImportedArtifactKeyset,
  artifactContentDigest,
  decodeArtifactCursor,
  deriveWorkoutId,
  encodeArtifactCursor,
  importedArtifactId,
  isImportedArtifactKind,
  MalformedResponseError,
  NetworkError,
  normalizeListImportedArtifactsQuery,
  parseAnalysisResult,
  parseArtifactSelection,
  parseCreateWorkoutResult,
  parseImportArtifactInput,
  parseImportedArtifact,
  parseImportedArtifactPage,
  parsePlanAdoption,
  parsePlanDraft,
  parseSaveImportedArtifactResult,
  parseWorkoutList,
} from "@pi-fit-trace/api-contracts";
import type {
  ArtifactSelection,
  CreateWorkoutResult,
  FitTraceClient,
  ImportArtifactInput,
  ImportedArtifact,
  ImportedArtifactKind,
  ImportedArtifactPage,
  ListImportedArtifactsQuery,
  NormalizedListImportedArtifactsQuery,
  PlanAdoption,
  PlanAdoptionInput,
  SaveImportedArtifactResult,
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

/**
 * Bind a parsed metadata page to the query that produced it.
 *
 * A page that is longer than the requested limit, out of newest-first order,
 * outside the requested kind/cursor window, or continued from anywhere but its
 * last item would let the UI display or fetch the wrong snapshots. Those are
 * boundary violations, so they surface as a malformed response instead of
 * being trusted.
 */
function assertPageMatchesQuery(
  page: ImportedArtifactPage,
  query: NormalizedListImportedArtifactsQuery,
): ImportedArtifactPage {
  if (page.items.length > query.limit) {
    throw new MalformedResponseError("items", "exceeds the requested limit");
  }
  const canonicalPage = applyImportedArtifactKeyset(page.items, {
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    limit: page.items.length === 0 ? 1 : page.items.length,
    cursor: query.cursor,
  });
  if (stableStringify(canonicalPage) !== stableStringify(page.items)) {
    throw new MalformedResponseError(
      "items",
      "is not newest-first within the requested kind and cursor window",
    );
  }
  if (page.next_cursor === null) return page;
  const last = page.items[page.items.length - 1];
  if (last === undefined) {
    throw new MalformedResponseError("next_cursor", "cannot continue an empty page");
  }
  const cursor = decodeArtifactCursor(page.next_cursor, query.kind, (field, reason) => {
    throw new MalformedResponseError(field, reason);
  });
  if (cursor.kind !== last.kind || cursor.created_at !== last.created_at || cursor.id !== last.id) {
    throw new MalformedResponseError("next_cursor", "does not continue from the last returned item");
  }
  return page;
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
    unwrap: (data: unknown) => T | Promise<T>,
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
    return await unwrap(readData(parsed));
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

  async saveImportedArtifact<K extends ImportedArtifactKind>(
    input: ImportArtifactInput<K>,
  ): Promise<SaveImportedArtifactResult<K>> {
    // Validate and normalize the untrusted input before it goes on the wire so
    // every backend enforces the same bounds. Unknown-field warnings from the
    // raw input are preserved and merged with the server's warnings.
    const { input: normalized, warnings } = parseImportArtifactInput(input);
    const normalizedInput = normalized as ImportArtifactInput<K>;
    const digest = await artifactContentDigest(normalizedInput.payload);
    const expectedId = importedArtifactId(normalizedInput.kind, digest);

    const result = await this.request(
      API_ENDPOINTS.imports,
      {
        method: "POST",
        body: JSON.stringify({
          kind: normalizedInput.kind,
          payload_schema_version: normalizedInput.payload_schema_version,
          payload: normalizedInput.payload,
          source_filename: normalizedInput.source_filename ?? null,
        }),
      },
      parseSaveImportedArtifactResult,
    );
    if (result.artifact.kind !== normalizedInput.kind) {
      throw new MalformedResponseError("kind", "does not match the requested artifact kind");
    }
    // The response must be the snapshot that was submitted. A malformed reply
    // may arrive after the server committed, so it is deliberately surfaced as
    // MalformedResponseError (an ambiguous outcome), not as a failed write.
    if (result.artifact.id !== expectedId || result.artifact.content_digest !== digest) {
      throw new MalformedResponseError("id", "does not match the submitted artifact identity");
    }
    if (stableStringify(result.artifact.payload) !== stableStringify(normalizedInput.payload)) {
      throw new MalformedResponseError("payload", "does not match the submitted canonical payload");
    }
    return {
      ...result,
      warnings: [...warnings, ...result.warnings],
    } as SaveImportedArtifactResult<K>;
  }

  async listImportedArtifacts(
    query: ListImportedArtifactsQuery = {},
  ): Promise<ImportedArtifactPage> {
    const normalized = normalizeListImportedArtifactsQuery(query);
    const params = new URLSearchParams();
    if (normalized.kind !== undefined) params.set("kind", normalized.kind);
    if (normalized.limit !== undefined) params.set("limit", String(normalized.limit));
    if (normalized.cursor !== null) {
      params.set("cursor", encodeArtifactCursor(normalized.cursor));
    }
    const queryString = params.toString();
    const page = await this.request(
      `${API_ENDPOINTS.imports}${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      parseImportedArtifactPage,
    );
    return assertPageMatchesQuery(page, normalized);
  }

  async getImportedArtifact(id: string): Promise<ImportedArtifact> {
    if (typeof id !== "string" || id === "" || id.length > 256) {
      throw new ApiError({
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: "Invalid imported artifact id.",
        status: 400,
      });
    }
    const artifact = await this.request(
      `${API_ENDPOINTS.imports}/${encodeURIComponent(id)}`,
      undefined,
      parseImportedArtifact,
    );
    if (artifact.id !== id) {
      throw new MalformedResponseError("id", "does not match the requested artifact id");
    }
    return artifact;
  }

  async getArtifactSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
    if (!isImportedArtifactKind(kind)) {
      throw new ApiError({
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: "Invalid artifact kind.",
        status: 400,
      });
    }
    return this.request(
      `${API_ENDPOINTS.importSelections}/${kind}`,
      undefined,
      parseArtifactSelection,
    );
  }

  async setArtifactSelection(
    kind: ImportedArtifactKind,
    artifactId: string | null,
  ): Promise<ArtifactSelection> {
    if (!isImportedArtifactKind(kind)) {
      throw new ApiError({
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: "Invalid artifact kind.",
        status: 400,
      });
    }
    const selection = await this.request(
      `${API_ENDPOINTS.importSelections}/${kind}`,
      { method: "PUT", body: JSON.stringify({ artifact_id: artifactId }) },
      parseArtifactSelection,
    );
    if (selection.artifact_id !== artifactId) {
      throw new MalformedResponseError(
        "artifact_id",
        "does not match the requested artifact selection",
      );
    }
    return selection;
  }

  async getPlanAdoption(): Promise<PlanAdoption | null> {
    return this.request(API_ENDPOINTS.planAdoption, undefined, parsePlanAdoption);
  }

  async setPlanAdoption(input: PlanAdoptionInput | null): Promise<PlanAdoption | null> {
    const adoption = await this.request(
      API_ENDPOINTS.planAdoption,
      { method: "PUT", body: JSON.stringify(input) },
      parsePlanAdoption,
    );
    if (input === null) {
      if (adoption !== null) {
        throw new MalformedResponseError("(root)", "must be null after revoking the adoption");
      }
      return null;
    }
    if (adoption === null) {
      throw new MalformedResponseError("(root)", "must not be null when an adoption was requested");
    }
    if (adoption.artifact_id !== input.artifact_id) {
      throw new MalformedResponseError("artifact_id", "does not match the requested adoption");
    }
    if (adoption.confirmed_digest !== input.confirmed_digest) {
      throw new MalformedResponseError("confirmed_digest", "does not match the requested adoption");
    }
    return adoption;
  }
}
