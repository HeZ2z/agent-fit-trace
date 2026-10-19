import Constants from "expo-constants";
import {
  API_ENDPOINTS,
  API_ERROR_CODES,
  ApiError,
  HTTP_STATUS,
  MalformedResponseError,
  NetworkError,
  deriveWorkoutId,
  parseCreateWorkoutResult,
} from "@pi-fit-trace/api-contracts";
import { ValidationError, stableStringify, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { SYNC_API_URL_ENV, resolveSyncConfig } from "./syncConfig.ts";
import type { SyncConfig } from "./syncConfig.ts";

export { SYNC_API_URL_ENV, resolveSyncConfig };
export type { SyncConfig, SyncConfigProblem, SyncConfigStatus } from "./syncConfig.ts";

/**
 * Minimal HTTP client for the optional mobile workout sync.
 *
 * Shape follows the documented cloud API and the app's `HttpFitTraceClient`:
 * `GET /workouts` returns the owner's list and `POST /workouts` is idempotent
 * by record id (`201` created, `200` identical duplicate, `409` same id with
 * different content). Records stay canonical English and are never rewritten
 * here — sync only reads the cloud and appends one local record at a time.
 *
 * `fetch` and the access-token provider are injectable. Credentials are
 * resolved per request, placed only in the `Authorization` header, and never
 * logged, stored in this module, or included in an error message.
 */

/** Default maximum accepted response body; protects the device from a huge list. */
export const SYNC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface SyncRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface SyncResponseLike {
  status: number;
  text(): string | Promise<string>;
  headers?: { get(name: string): string | null };
}

export type SyncFetch = (
  input: string,
  init?: SyncRequestInit,
) => SyncResponseLike | Promise<SyncResponseLike>;

export type SyncAccessTokenProvider = () => string | null | Promise<string | null>;

/** A remote record that failed validation; the rest of the list still loads. */
export interface MalformedRemoteWorkout {
  /** Zero-based position in the server's list. */
  index: number;
  /** Redacted validation reason; never the record body. */
  reason: string;
}

export type CreateRemoteWorkoutOutcome = "created" | "duplicate";

export interface WorkoutSyncClientOptions {
  /** Resolved config; defaults to reading the Expo env/extra at construction. */
  config?: SyncConfig;
  fetchImpl?: SyncFetch;
  getAccessToken?: SyncAccessTokenProvider;
  /** Optional UI flag for each dropped malformed remote record. */
  onMalformedRecord?: (notice: MalformedRemoteWorkout) => void;
  /** Response byte cap; defaults to {@link SYNC_MAX_RESPONSE_BYTES}. */
  maxResponseBytes?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function extraString(
  extra: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = extra?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Ignore blank entries so a lower-priority source can still apply. */
function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Read the API base from `process.env` (Expo inlines the statically accessed
 * `EXPO_PUBLIC_*` value) and fall back to `expo-constants` `extra`.
 *
 * The Expo-specific read lives here rather than in `syncConfig.ts` so the pure
 * resolver stays loadable by the root `node:test` suite. A missing/blank value
 * is `unconfigured`; a non-http(s) value is `invalid`.
 */
export function readSyncConfig(): SyncConfig {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | null | undefined;
  return resolveSyncConfig(
    firstNonBlank(
      process.env.EXPO_PUBLIC_FIT_TRACE_API_URL,
      extraString(extra, SYNC_API_URL_ENV),
      extraString(extra, "fitTraceApiUrl"),
    ),
  );
}

/** Unwrap the `{ data }` envelope; anything else cannot be trusted. */
function readData(parsed: unknown): unknown {
  if (!isObject(parsed) || !("data" in parsed)) {
    throw new MalformedResponseError("data", "is missing");
  }
  return parsed.data;
}

function defaultErrorCode(status: number): string {
  switch (status) {
    case HTTP_STATUS.badRequest:
      return API_ERROR_CODES.VALIDATION_ERROR;
    case 422:
      return API_ERROR_CODES.VALIDATION_ERROR;
    case HTTP_STATUS.unauthorized:
      return API_ERROR_CODES.UNAUTHENTICATED;
    case HTTP_STATUS.forbidden:
      return API_ERROR_CODES.FORBIDDEN;
    case HTTP_STATUS.notFound:
      return API_ERROR_CODES.NOT_FOUND;
    case HTTP_STATUS.conflict:
      return API_ERROR_CODES.CONFLICT;
    default:
      return API_ERROR_CODES.API_ERROR;
  }
}

/**
 * Turn a non-2xx response into an `ApiError`.
 *
 * Even an unreadable error envelope keeps the status mapping, so a 401 or 409
 * still classifies correctly for UI messaging. The raw body is never included.
 */
function toApiError(parsed: unknown, status: number): ApiError {
  const body = isObject(parsed) ? parsed.error : undefined;
  if (isObject(body) && typeof body.code === "string" && typeof body.message === "string") {
    return new ApiError({
      code: body.code,
      message: body.message,
      ...(body.details === undefined ? {} : { details: body.details }),
      status,
    });
  }
  return new ApiError({
    code: defaultErrorCode(status),
    message: `Server responded with status ${status}.`,
    status,
  });
}

/** Declared byte length from `Content-Length`, when present and usable. */
function declaredByteLength(response: SyncResponseLike): number | null {
  const headers = response.headers;
  if (headers === undefined || typeof headers.get !== "function") return null;
  const raw = headers.get("content-length");
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * UTF-8 byte length, used for the post-read cap (a multi-byte response may
 * declare no content length, or a compressed one). Falls back to the safe
 * upper bound for a string's UTF-8 encoding when `TextEncoder` is absent.
 */
function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length * 3;
}

function hasUsableId(record: WorkoutRecord): boolean {
  return typeof record.id === "string" && record.id.trim() !== "";
}

/**
 * Normalize the outgoing record exactly like the app clients: preserve a
 * caller-supplied id (so retries stay idempotent), derive one from content only
 * when absent, then validate through the shared core. An invalid local record
 * fails locally instead of being sent.
 */
function prepareOutgoingRecord(record: WorkoutRecord): WorkoutRecord {
  const withId = hasUsableId(record) ? record : { ...record, id: deriveWorkoutId(record) };
  try {
    return validateWorkoutRecord(withId).record;
  } catch (error) {
    const issues = error instanceof ValidationError ? error.issues : [];
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: "Cannot sync an invalid workout record.",
      details: { issues },
      status: HTTP_STATUS.badRequest,
    });
  }
}

export class WorkoutSyncClient {
  /** Resolved configuration, exposed so the UI can call `canSync`. */
  readonly config: SyncConfig;

  private readonly fetchImpl: SyncFetch;
  private readonly getAccessToken: SyncAccessTokenProvider | undefined;
  private readonly onMalformedRecord: ((notice: MalformedRemoteWorkout) => void) | undefined;
  private readonly maxResponseBytes: number;

  constructor(options: WorkoutSyncClientOptions = {}) {
    this.config = options.config ?? readSyncConfig();
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.getAccessToken = options.getAccessToken;
    this.onMalformedRecord = options.onMalformedRecord;

    const maxResponseBytes = options.maxResponseBytes ?? SYNC_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
      throw new RangeError("maxResponseBytes must be a positive integer.");
    }
    this.maxResponseBytes = maxResponseBytes;
  }

  /** The configured absolute API base, or a typed configuration error. */
  private requireBaseUrl(): string {
    switch (this.config.status) {
      case "configured":
        return this.config.baseUrl;
      case "unconfigured":
        throw new ApiError({
          code: API_ERROR_CODES.API_ERROR,
          message: `Cloud sync is not configured. Set ${SYNC_API_URL_ENV} to the API base URL.`,
        });
      case "invalid":
        throw new ApiError({
          code: API_ERROR_CODES.API_ERROR,
          message: `Cloud sync configuration is invalid: ${this.config.reason}.`,
        });
    }
  }

  /**
   * Resolve the bearer token for one request. A missing/blank token fails
   * closed as `UNAUTHENTICATED` before any network call; a provider failure is
   * treated the same way rather than leaking the provider's cause.
   */
  private async requireAccessToken(): Promise<string> {
    let token: unknown = null;
    if (this.getAccessToken !== undefined) {
      try {
        token = await this.getAccessToken();
      } catch {
        token = null;
      }
    }
    if (typeof token !== "string" || token.trim() === "") {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Sign in to sync workouts.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    return token;
  }

  /**
   * One bounded HTTP request. Exactly one attempt is made: writes are never
   * retried, so an ambiguous submit cannot double-apply.
   */
  private async request(
    path: string,
    init?: SyncRequestInit,
  ): Promise<{ status: number; data: unknown }> {
    const baseUrl = this.requireBaseUrl();
    const accessToken = await this.requireAccessToken();
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      authorization: `Bearer ${accessToken}`,
    };

    let response: SyncResponseLike;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new NetworkError(undefined, { cause: error });
    }

    const declared = declaredByteLength(response);
    if (declared !== null && declared > this.maxResponseBytes) {
      throw new MalformedResponseError(
        "(root)",
        `exceeds the ${this.maxResponseBytes}-byte response limit`,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new NetworkError("Network response body could not be read.", { cause: error });
    }
    if (utf8ByteLength(text) > this.maxResponseBytes) {
      throw new MalformedResponseError(
        "(root)",
        `exceeds the ${this.maxResponseBytes}-byte response limit`,
      );
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
    return { status: response.status, data: readData(parsed) };
  }

  /**
   * List the signed-in owner's cloud workouts.
   *
   * The response must be an array. Each entry is validated with the shared
   * core; malformed entries are dropped and reported through
   * `onMalformedRecord` instead of failing (or hiding) the whole list.
   */
  async listRemoteWorkouts(): Promise<WorkoutRecord[]> {
    const { data } = await this.request(API_ENDPOINTS.workouts);
    if (!Array.isArray(data)) {
      throw new MalformedResponseError("(root)", "must be an array");
    }

    const records: WorkoutRecord[] = [];
    data.forEach((entry, index) => {
      try {
        records.push(validateWorkoutRecord(entry).record);
      } catch (error) {
        if (this.onMalformedRecord === undefined) return;
        this.onMalformedRecord({
          index,
          reason: error instanceof Error ? error.message : "Workout record failed validation.",
        });
      }
    });
    return records;
  }

  /**
   * Create one cloud workout.
   *
   * Returns `"duplicate"` when the server reports that an identical record
   * already exists (idempotent no-op); a same-id/different-content record is
   * rejected by the server as `409 CONFLICT` and surfaces as a typed
   * `ApiError`. The returned record is checked against the submitted canonical
   * record so a misleading response cannot be treated as success.
   */
  async createRemoteWorkout(record: WorkoutRecord): Promise<CreateRemoteWorkoutOutcome> {
    const prepared = prepareOutgoingRecord(record);
    const { data } = await this.request(API_ENDPOINTS.workouts, {
      method: "POST",
      body: JSON.stringify({ record: prepared }),
    });
    const result = parseCreateWorkoutResult(data);
    if (result.record.id !== prepared.id) {
      throw new MalformedResponseError("record.id", "does not match the submitted record");
    }
    if (stableStringify(result.record) !== stableStringify(prepared)) {
      throw new MalformedResponseError(
        "record",
        "does not match the submitted canonical record",
      );
    }
    return result.duplicate ? "duplicate" : "created";
  }
}
