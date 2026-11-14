/**
 * Contract for the daemon-local cloud destination setting (#87).
 *
 * A custom destination is a device-local daemon setting, not a hosted-service
 * capability. These shapes are shared by the daemon routes and the app's
 * settings/run-resume code; the hosted cloud routes are unchanged.
 */
import { MalformedResponseError } from "./errors.ts";

export const CLOUD_DESTINATION_SOURCES = ["official", "user", "unset", "invalid"] as const;
export type CloudDestinationSource = (typeof CLOUD_DESTINATION_SOURCES)[number];

export const CLOUD_DESTINATION_CONSENT_STATES = ["confirmed", "required", "not-applicable"] as const;
export type CloudDestinationConsent = (typeof CLOUD_DESTINATION_CONSENT_STATES)[number];

export interface CloudDestinationError {
  code: string;
  message: string;
}

/**
 * The current, effective cloud destination for one verified principal.
 *
 * `destination` is the canonical API base (`https://host/api/v1`), `host` is
 * what a confirmation names. Both are null when no destination is configured.
 * `officialDestination` is the build/operator default even when a user
 * destination overrides it, so the settings page can offer a reset.
 */
export interface CloudDestinationStatus {
  source: CloudDestinationSource;
  destination: string | null;
  host: string | null;
  officialDestination: string | null;
  /** This daemon's account-service issuer (Supabase project URL), or null. */
  issuer: string | null;
  /**
   * Stable opaque id of the effective destination + account service. Cloud
   * run-scoped requests echo it so the daemon can refuse to redirect an
   * established run to a destination that changed underneath it.
   */
  binding: string | null;
  consent: CloudDestinationConsent;
  error?: CloudDestinationError;
}

/**
 * The result of validating a candidate destination before it is saved.
 *
 * A failed check is a normal `ok: false` result with an actionable error, not
 * a transport failure: the settings page renders it in place.
 */
export interface CloudDestinationCheck {
  ok: boolean;
  destination?: string;
  host?: string;
  /** True when the candidate is the build/operator default. */
  official?: boolean;
  /** True when the destination's account service matches this daemon's. */
  issuerCompatible?: boolean;
  error?: CloudDestinationError;
}

function fail(field: string, reason: string): never {
  throw new MalformedResponseError(field, reason);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(field, "must be a non-blank string");
  return value;
}

function assertNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return assertString(value, field);
}

function parseError(value: unknown): CloudDestinationError {
  if (!isObject(value)) fail("error", "must be an object");
  return {
    code: assertString(value.code, "error.code"),
    message: assertString(value.message, "error.message"),
  };
}

function isSource(value: unknown): value is CloudDestinationSource {
  return typeof value === "string" && (CLOUD_DESTINATION_SOURCES as readonly string[]).includes(value);
}

function isConsent(value: unknown): value is CloudDestinationConsent {
  return typeof value === "string" && (CLOUD_DESTINATION_CONSENT_STATES as readonly string[]).includes(value);
}

/** Guard the daemon's `GET /api/v1/coaching/cloud/destination` payload. */
export function parseCloudDestinationStatus(value: unknown): CloudDestinationStatus {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (!isSource(value.source)) fail("source", `must be one of ${CLOUD_DESTINATION_SOURCES.join(", ")}`);
  if (!isConsent(value.consent)) {
    fail("consent", `must be one of ${CLOUD_DESTINATION_CONSENT_STATES.join(", ")}`);
  }
  const status: CloudDestinationStatus = {
    source: value.source,
    destination: assertNullableString(value.destination, "destination"),
    host: assertNullableString(value.host, "host"),
    officialDestination: assertNullableString(value.officialDestination, "officialDestination"),
    issuer: assertNullableString(value.issuer, "issuer"),
    binding: assertNullableString(value.binding, "binding"),
    consent: value.consent,
  };
  if (value.error !== undefined) status.error = parseError(value.error);
  if (status.source === "official" || status.source === "user") {
    if (status.destination === null || status.host === null || status.binding === null) {
      fail("binding", "must be present when a destination is in use");
    }
  }
  if (status.source !== "official" && status.source !== "user" && status.binding !== null) {
    fail("binding", "must be null when no destination is in use");
  }
  if (status.source === "invalid" && status.error === undefined) {
    fail("error", "must explain an invalid stored destination");
  }
  if (status.source === "user" && status.consent === "not-applicable") {
    fail("consent", "must be required or confirmed for a user destination");
  }
  if (status.source !== "user" && status.consent !== "not-applicable") {
    fail("consent", "must be not-applicable when no user destination is in use");
  }
  return status;
}

/** Guard the daemon's destination validation/preview payload. */
export function parseCloudDestinationCheck(value: unknown): CloudDestinationCheck {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (typeof value.ok !== "boolean") fail("ok", "must be a boolean");
  if (!value.ok) {
    if (value.error === undefined) fail("error", "must explain a failed check");
    return { ok: false, error: parseError(value.error) };
  }
  if (value.destination === undefined || value.host === undefined) {
    fail("destination", "must be present for a successful check");
  }
  if (value.official !== undefined && typeof value.official !== "boolean") {
    fail("official", "must be a boolean");
  }
  if (value.issuerCompatible !== undefined && typeof value.issuerCompatible !== "boolean") {
    fail("issuerCompatible", "must be a boolean");
  }
  return {
    ok: true,
    destination: assertString(value.destination, "destination"),
    host: assertString(value.host, "host"),
    official: value.official === true,
    issuerCompatible: value.issuerCompatible === true,
  };
}
