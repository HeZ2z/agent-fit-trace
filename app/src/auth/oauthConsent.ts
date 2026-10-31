/**
 * Minimal Supabase OAuth authorization REST client over built-in `fetch`.
 *
 * A remote MCP client authorizes against Supabase's OAuth server; Supabase
 * then redirects the browser to the configured authorization path
 * (`…/oauth/consent?authorization_id=<uuid>`), and this module performs the
 * two calls that path needs. They use the publishable key as `apikey` and the
 * signed-in user's own access token as `Authorization: Bearer`, exactly like
 * `supabaseAuth.ts` — there is no SDK dependency in this repo and none is
 * added here.
 *
 * Contract pinned to Supabase Auth's `internal/api/oauthserver/` (do not
 * guess at shapes):
 * - `GET  {url}/auth/v1/oauth/authorizations/{id}` →
 *   `{ authorization_id, redirect_uri?, client: { id, name?, uri?,
 *   logo_uri? }, user: { id?, email? }, scope? }`. Requires an authenticated
 *   user; a missing/expired request answers 404
 *   `oauth_authorization_not_found`. Ownership is checked server-side, so a
 *   different user never receives another user's row.
 * - `POST {url}/auth/v1/oauth/authorizations/{id}/consent` with
 *   `{"action":"approve"}` or `{"action":"deny"}` → `{ redirect_url }`.
 *   Approve yields `code`+`state`, deny yields `error=access_denied`.
 *
 * SECURITY: the only redirect this client will ever follow is the server's
 * `redirect_url`. Nothing here builds, decorates, or re-serializes one, and a
 * value that is not an absolute `http(s)` URL is refused (`INVALID_RESPONSE`)
 * instead of navigated to. Error messages are fixed strings: a response body,
 * the access token, and the authorization id are never echoed back.
 */

import type { AuthFetch, SupabaseAuthConfig } from "./supabaseAuth.ts";

export type OAuthConsentAction = "approve" | "deny";

/** The client application named in the consent prompt. */
export interface OAuthAuthorizationClient {
  id: string;
  name?: string;
  uri?: string;
  logoUri?: string;
}

/** Parsed `GET …/oauth/authorizations/{id}` payload (unknown fields dropped). */
export interface OAuthAuthorizationRequest {
  authorizationId: string;
  /** Where the user is sent after deciding (the client's own callback). */
  redirectUri?: string;
  client: OAuthAuthorizationClient;
  user: { id?: string; email?: string };
  /** Space-delimited scopes split into individual tokens. */
  scopes: string[];
}

export type OAuthConsentErrorCode =
  | "INVALID_AUTHORIZATION_ID"
  | "AUTHORIZATION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "REQUEST_REJECTED"
  | "AUTHORIZATION_UNAVAILABLE"
  | "INVALID_RESPONSE";

/** Redacted failure with a stable code; the UI maps codes to copy. */
export class OAuthConsentError extends Error {
  code: OAuthConsentErrorCode;
  status?: number;

  constructor(code: OAuthConsentErrorCode, message: string, status?: number) {
    super(message);
    this.name = "OAuthConsentError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * An authorization id is a single opaque URL path segment. Restricting it to
 * URL-safe characters before it is interpolated into the endpoint path keeps
 * a hostile `authorization_id` from reaching any other Auth route.
 */
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidAuthorizationId(value: unknown): value is string {
  return typeof value === "string" && AUTHORIZATION_ID.test(value);
}

/**
 * Validate a server-returned redirect target without rewriting it.
 *
 * Returns the exact string the server sent (never a normalized/rebuilt URL)
 * or `null` when it is not an absolute `http(s)` URL — `javascript:`,
 * `data:`, protocol-relative, and relative targets are all refused.
 */
export function parseSafeRedirectUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // A value carrying credentials in the authority is never a legitimate OAuth
  // client callback.
  if (parsed.username !== "" || parsed.password !== "") return null;
  return value;
}

function oauthHeaders(config: SupabaseAuthConfig, accessToken: string): Record<string, string> {
  return {
    apikey: config.publishableKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function unauthorizedError(): OAuthConsentError {
  return new OAuthConsentError(
    "SESSION_EXPIRED",
    "Your session is no longer valid. Sign in again to continue.",
    401,
  );
}

function unavailableError(): OAuthConsentError {
  return new OAuthConsentError(
    "AUTHORIZATION_UNAVAILABLE",
    "The authorization service is temporarily unavailable. Try again.",
    503,
  );
}

function notFoundError(): OAuthConsentError {
  return new OAuthConsentError(
    "AUTHORIZATION_NOT_FOUND",
    "This authorization request is missing, expired, or was already used.",
    404,
  );
}

function invalidResponseError(): OAuthConsentError {
  return new OAuthConsentError(
    "INVALID_RESPONSE",
    "The authorization service returned an unexpected response.",
  );
}

/**
 * Map a non-2xx status from either endpoint onto one of the codes above.
 *
 * 401 is the expired/missing session. 403 is Auth's origin validation refusing
 * the request (the consent endpoint is validated against the project's Site
 * URL), which is not a session problem and must not tell the user to sign in
 * again. 404/400/410 are the documented not-found/expired/already-used row.
 */
function errorForStatus(status: number): OAuthConsentError {
  if (status === 401) return unauthorizedError();
  if (status === 403) {
    return new OAuthConsentError(
      "REQUEST_REJECTED",
      "This authorization request cannot be completed from this site. Start again from the app that asked for access.",
      403,
    );
  }
  if (status === 404 || status === 400 || status === 410) return notFoundError();
  if (isTransientStatus(status)) return unavailableError();
  return invalidResponseError();
}

function textValue(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function parseAuthorizationDetails(
  raw: unknown,
  authorizationId: string,
): OAuthAuthorizationRequest {
  if (typeof raw !== "object" || raw === null) throw invalidResponseError();
  const record = raw as Record<string, unknown>;
  const clientRaw = record.client;
  if (typeof clientRaw !== "object" || clientRaw === null) throw invalidResponseError();
  const clientRecord = clientRaw as Record<string, unknown>;
  const clientId = textValue(clientRecord.id);
  if (clientId === undefined) throw invalidResponseError();

  const userRaw = record.user;
  const userRecord =
    typeof userRaw === "object" && userRaw !== null ? (userRaw as Record<string, unknown>) : {};
  const scope = textValue(record.scope);

  return {
    authorizationId,
    ...(textValue(record.redirect_uri) === undefined
      ? {}
      : { redirectUri: textValue(record.redirect_uri) }),
    client: {
      id: clientId,
      ...(textValue(clientRecord.name) === undefined ? {} : { name: textValue(clientRecord.name) }),
      ...(textValue(clientRecord.uri) === undefined ? {} : { uri: textValue(clientRecord.uri) }),
      ...(textValue(clientRecord.logo_uri) === undefined
        ? {}
        : { logoUri: textValue(clientRecord.logo_uri) }),
    },
    user: {
      ...(textValue(userRecord.id) === undefined ? {} : { id: textValue(userRecord.id) }),
      ...(textValue(userRecord.email) === undefined
        ? {}
        : { email: textValue(userRecord.email) }),
    },
    scopes: scope === undefined ? [] : scope.split(" ").filter((entry) => entry !== ""),
  };
}

/**
 * Load one pending authorization. The row is ownership-checked by Auth, so a
 * caller only ever sees its own request. Nothing is cached: every mount asks
 * the server again.
 */
export async function fetchOAuthAuthorization(
  config: SupabaseAuthConfig,
  authorizationId: string,
  accessToken: string,
  fetchImpl: AuthFetch = fetch,
): Promise<OAuthAuthorizationRequest> {
  if (!isValidAuthorizationId(authorizationId)) {
    throw new OAuthConsentError(
      "INVALID_AUTHORIZATION_ID",
      "This consent link is missing a valid authorization request.",
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(
      `${config.supabaseUrl}/auth/v1/oauth/authorizations/${authorizationId}`,
      { method: "GET", headers: oauthHeaders(config, accessToken) },
    );
  } catch {
    throw unavailableError();
  }
  if (!response.ok) throw errorForStatus(response.status);
  const body: unknown = await response.json().catch(() => null);
  return parseAuthorizationDetails(body, authorizationId);
}

/**
 * Record the user's decision and return the server's `redirect_url`.
 *
 * The returned URL is validated (`parseSafeRedirectUrl`) but never modified;
 * callers must navigate to exactly this value and to nothing else.
 */
export async function submitOAuthConsent(
  config: SupabaseAuthConfig,
  authorizationId: string,
  accessToken: string,
  action: OAuthConsentAction,
  fetchImpl: AuthFetch = fetch,
): Promise<string> {
  if (!isValidAuthorizationId(authorizationId)) {
    throw new OAuthConsentError(
      "INVALID_AUTHORIZATION_ID",
      "This consent link is missing a valid authorization request.",
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(
      `${config.supabaseUrl}/auth/v1/oauth/authorizations/${authorizationId}/consent`,
      {
        method: "POST",
        headers: oauthHeaders(config, accessToken),
        body: JSON.stringify({ action }),
      },
    );
  } catch {
    throw unavailableError();
  }
  if (!response.ok) throw errorForStatus(response.status);
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) throw invalidResponseError();
  const redirectUrl = parseSafeRedirectUrl((body as Record<string, unknown>).redirect_url);
  if (redirectUrl === null) throw invalidResponseError();
  return redirectUrl;
}
