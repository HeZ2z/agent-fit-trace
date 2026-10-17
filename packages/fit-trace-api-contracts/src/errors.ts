import type { ApiErrorBody } from "./types.ts";

/**
 * Error contract for the API boundary.
 *
 * Codes are stable strings so the transport can map them to HTTP statuses and
 * the app can branch on them; see {@link API_ERROR_CODES}. `MalformedResponseError`
 * is intentionally identical in shape and message to the app's current guard so
 * the app can re-export it instead of keeping a duplicate.
 */

export const API_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  CONFLICT: "CONFLICT",
  CORRUPT_STORE: "CORRUPT_STORE",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  NETWORK_ERROR: "NETWORK_ERROR",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  API_ERROR: "API_ERROR",
} as const;

/** A structured API failure carrying the server's code and optional status. */
export class ApiError extends Error {
  code: string;
  details?: unknown;
  status?: number;

  constructor(body: ApiErrorBody & { status?: number }) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    if (body.details !== undefined) this.details = body.details;
    if (body.status !== undefined) this.status = body.status;
  }
}

/**
 * Raised when the fetch transport itself fails (offline, DNS, connection reset).
 * Writes are never retried or silently fallen back on this error — the caller
 * decides whether to surface or re-issue, so an ambiguous submit cannot double
 * apply.
 */
export class NetworkError extends Error {
  constructor(message = "Network request failed.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/**
 * Raised when a response cannot be trusted.
 *
 * The message always names the offending field so callers can surface a
 * readable error instead of crashing on a shape mismatch.
 */
export class MalformedResponseError extends Error {
  code = "MALFORMED_RESPONSE";
  field: string;

  constructor(field: string, reason: string) {
    super(`Malformed response: \`${field}\` ${reason}.`);
    this.name = "MalformedResponseError";
    this.field = field;
  }
}
