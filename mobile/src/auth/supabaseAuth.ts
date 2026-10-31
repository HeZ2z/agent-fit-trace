import {
  AuthError,
  mapTokenErrorStatus,
  parseVerifiedUser,
  providerErrorCode,
  sessionFromTokenResponse,
  type SupabaseAuthConfig,
  type SupabaseAuthUser,
  type SupabaseSession,
} from "./authModel";

/**
 * Minimal Supabase Auth REST client over the platform `fetch`.
 *
 * Mirrors the web client's request shapes exactly (no SDK, no new dependency):
 * `POST /auth/v1/token?grant_type=password`, the same endpoint with
 * `grant_type=refresh_token`, `GET /auth/v1/user`, and `POST /auth/v1/logout`,
 * all authenticated with the publishable key (`apikey`). Tokens are only ever
 * sent as `Authorization: Bearer` headers and are never logged, included in
 * error messages, or passed to the UI.
 *
 * Accounts are invite-only, so there is intentionally no sign-up request.
 */

export type AuthFetch = typeof fetch;

const AUTH_REQUEST_TIMEOUT_MS = 15_000;

function authHeaders(
  config: SupabaseAuthConfig,
  accessToken?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: config.publishableKey,
    "Content-Type": "application/json",
  };
  if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function send(
  fetchImpl: AuthFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    // Network failure is transient: callers keep any existing session.
    throw new AuthError("network");
  } finally {
    clearTimeout(timeout);
  }
}

/** Email + password sign-in (`grant_type=password`). No public sign-up path. */
export async function signInWithPassword(
  config: SupabaseAuthConfig,
  email: string,
  password: string,
  fetchImpl: AuthFetch = fetch,
): Promise<SupabaseSession> {
  const response = await send(
    fetchImpl,
    `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ email, password }),
    },
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new AuthError(mapTokenErrorStatus(response.status, providerErrorCode(body)), {
      status: response.status,
    });
  }
  const session = sessionFromTokenResponse(body);
  if (session === null) throw new AuthError("unknown", { status: response.status });
  return session;
}

/** Refresh an access token with the stored refresh token. */
export async function refreshSession(
  config: SupabaseAuthConfig,
  refreshToken: string,
  fetchImpl: AuthFetch = fetch,
): Promise<SupabaseSession> {
  const response = await send(
    fetchImpl,
    `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  const body = await readJson(response);
  if (!response.ok) {
    if (response.status === 429) {
      throw new AuthError("rate-limited", { status: response.status });
    }
    if (response.status >= 500) {
      throw new AuthError("service-unavailable", { status: response.status });
    }
    throw new AuthError("session-expired", { status: response.status });
  }
  const session = sessionFromTokenResponse(body);
  if (session === null) throw new AuthError("session-expired", { status: response.status });
  return session;
}

/**
 * Validate the current access token and return the verified Auth user.
 * This is the only request that may classify the account (`is_anonymous`).
 */
export async function fetchAuthUser(
  config: SupabaseAuthConfig,
  accessToken: string,
  fetchImpl: AuthFetch = fetch,
): Promise<SupabaseAuthUser> {
  const response = await send(fetchImpl, `${config.supabaseUrl}/auth/v1/user`, {
    headers: authHeaders(config, accessToken),
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new AuthError("rate-limited", { status: response.status });
    }
    if (response.status >= 500) {
      throw new AuthError("service-unavailable", { status: response.status });
    }
    throw new AuthError("session-expired", { status: response.status });
  }
  const body = await readJson(response);
  const user = parseVerifiedUser(body);
  if (user === null) throw new AuthError("session-expired", { status: response.status });
  return user;
}

/**
 * Global sign-out. The provider clears local state first and ignores failures
 * here: a server-side failure only leaves the refresh token alive until expiry.
 */
export async function signOut(
  config: SupabaseAuthConfig,
  accessToken: string,
  fetchImpl: AuthFetch = fetch,
): Promise<void> {
  const response = await send(fetchImpl, `${config.supabaseUrl}/auth/v1/logout`, {
    method: "POST",
    headers: authHeaders(config, accessToken),
  });
  if (
    !response.ok &&
    response.status !== 401 &&
    response.status !== 403 &&
    response.status !== 404
  ) {
    throw new AuthError("unknown", { status: response.status });
  }
}
