/**
 * Minimal Supabase Auth REST client over built-in `fetch`.
 *
 * No SDK dependency: email/password sign-in, sign-out, session refresh,
 * password recovery, and callback/session recovery are plain Auth REST calls
 * (`/auth/v1/...` with the publishable key). Tokens live in memory + a single
 * namespaced `localStorage` entry; they are sent only as `Authorization:
 * Bearer` headers and are never written into workout payloads or logs. The
 * implicit-hash token is consumed from `location.hash` only (never the query
 * string) and moved into tab-scoped `sessionStorage` for the password-setup
 * handoff.
 *
 * Endpoint shapes pinned by `supabaseAuth.test.ts` and the localSupabase stack
 * (`supabase/config.toml` + `supabase/migrations/*`); password recovery posts
 * to `POST /auth/v1/recover?redirect_to=…` (query string, not JSON body).
 */

export interface SupabaseAuthUser {
  id: string;
  email?: string;
}

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires (0 when unknown). */
  expiresAt: number;
  user: SupabaseAuthUser;
}

export interface SupabaseAuthConfig {
  supabaseUrl: string;
  publishableKey: string;
}

export type AuthFetch = typeof fetch;

export const AUTH_STORAGE_KEY = "pi-fit-trace:auth:v1:session";

function authHeaders(config: SupabaseAuthConfig, accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: config.publishableKey,
    "Content-Type": "application/json",
  };
  if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

function toUser(raw: unknown): SupabaseAuthUser | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== "string" || id.trim() === "") return null;
  const email = (raw as { email?: unknown }).email;
  return {
    id,
    ...(typeof email === "string" && email !== "" ? { email } : {}),
  };
}

function sessionFromTokenResponse(body: unknown): SupabaseSession | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  if (typeof refreshToken !== "string" || refreshToken === "") return null;
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 3600;
  const user = toUser(record.user);
  if (user === null) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    user,
  };
}

/** Throw a redacted error (never includes tokens or passwords). */
export class AuthError extends Error {
  code: string;
  status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Transient Auth-service failures (network errors, 429/5xx) are
 * `AUTH_UNAVAILABLE`, never `SESSION_EXPIRED`: callers must preserve the
 * session and offer a retry instead of signing the user out.
 */
export function isTransientAuthError(error: unknown): boolean {
  if (error instanceof AuthError) {
    if (error.code === "AUTH_UNAVAILABLE") return true;
    if (error.status === 429 || (error.status !== undefined && error.status >= 500)) return true;
  }
  return false;
}

function unavailableError(): AuthError {
  return new AuthError("AUTH_UNAVAILABLE", "The sign-in service is unavailable. Try again.", 503);
}

function authErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const message = record.msg ?? record.message ?? record.error_description ?? record.error;
    if (typeof message === "string" && message !== "") return message;
  }
  return fallback;
}

/** Email + password sign-in (`grant_type=password`). No public sign-up path. */
export async function signInWithPassword(
  config: SupabaseAuthConfig,
  email: string,
  password: string,
  fetchImpl: AuthFetch = fetch,
): Promise<SupabaseSession> {
  const response = await fetchImpl(
    `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ email, password }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AuthError(
      "SIGN_IN_FAILED",
      authErrorMessage(body, "Sign-in failed. Check your email and password."),
      response.status,
    );
  }
  const session = sessionFromTokenResponse(body);
  if (session === null) throw new AuthError("SIGN_IN_FAILED", "Sign-in returned an invalid session.");
  return session;
}

/** Global sign-out; failures still clear local state (see AuthProvider). */
export async function signOut(
  config: SupabaseAuthConfig,
  accessToken: string,
  fetchImpl: AuthFetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${config.supabaseUrl}/auth/v1/logout`, {
    method: "POST",
    headers: authHeaders(config, accessToken),
  });
  if (!response.ok && response.status !== 401 && response.status !== 403 && response.status !== 404) {
    throw new AuthError("SIGN_OUT_FAILED", "Sign-out failed.", response.status);
  }
}

/** Refresh an access token with the stored refresh token. */
export async function refreshSession(
  config: SupabaseAuthConfig,
  refreshToken: string,
  fetchImpl: AuthFetch = fetch,
): Promise<SupabaseSession> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
    );
  } catch {
    throw unavailableError();
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) throw unavailableError();
    throw new AuthError("SESSION_EXPIRED", "Your session expired. Please sign in again.", response.status);
  }
  const session = sessionFromTokenResponse(body);
  if (session === null) throw new AuthError("SESSION_EXPIRED", "Session refresh returned an invalid session.");
  return session;
}

/** Validate the current access token and return the Auth user. */
export async function fetchAuthUser(
  config: SupabaseAuthConfig,
  accessToken: string,
  fetchImpl: AuthFetch = fetch,
): Promise<SupabaseAuthUser> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}/auth/v1/user`, {
      headers: authHeaders(config, accessToken),
    });
  } catch {
    throw unavailableError();
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) throw unavailableError();
    throw new AuthError(
      "SESSION_EXPIRED",
      "Your session expired. Please sign in again.",
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const user = toUser(body);
  if (user === null) throw new AuthError("SESSION_EXPIRED", "Session is no longer valid.");
  return user;
}

/**
 * Request a password-recovery email. Always resolves on success; Supabase may
 * respond 200 even for unknown emails (no account enumeration).
 *
 * GoTrue reads `redirect_to` from the QUERY string
 * (`POST /auth/v1/recover?redirect_to=…`), not from the JSON body — a body
 * field is ignored. The redirect target must be allowlisted in
 * `supabase/config.toml` (`additional_redirect_urls`) and in the production
 * dashboard; this app uses `/auth/callback`, which then routes
 * invite/recovery sessions in-app to `/reset-password`.
 */
export async function requestPasswordReset(
  config: SupabaseAuthConfig,
  email: string,
  redirectTo: string,
  fetchImpl: AuthFetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${config.supabaseUrl}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ email }),
    },
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new AuthError(
      "RESET_FAILED",
      authErrorMessage(body, "Could not send the reset email. Try again."),
      response.status,
    );
  }
}

/** Set a new password with a recovery access token (`PUT /auth/v1/user`). */
export async function updatePassword(
  config: SupabaseAuthConfig,
  accessToken: string,
  newPassword: string,
  fetchImpl: AuthFetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${config.supabaseUrl}/auth/v1/user`, {
    method: "PUT",
    headers: authHeaders(config, accessToken),
    body: JSON.stringify({ password: newPassword }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new AuthError(
      "RESET_FAILED",
      authErrorMessage(body, "Could not update the password. Request a new reset link."),
      response.status,
    );
  }
}

export interface CallbackSession {
  accessToken: string;
  refreshToken: string;
  type: string | null;
}

/**
 * Recover a session from an Auth redirect: implicit-hash (`#access_token=…`).
 * This app uses the implicit hash flow only — it never generates PKCE
 * verifiers, so `?code=…` links are not exchanged here and are treated as
 * invalid/expired by the callback screen. Returns `null` when the URL
 * carries no Auth parameters. Never reads tokens from the query string.
 */
export function parseAuthCallbackHash(hash: string): CallbackSession | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access_token");
  if (accessToken === null || accessToken === "") return null;
  return {
    accessToken,
    refreshToken: params.get("refresh_token") ?? "",
    type: params.get("type"),
  };
}

/** Deserialize a stored session; anything malformed is discarded (null). */
export function loadStoredSession(raw: string | null): SupabaseSession | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken === "") return null;
    if (typeof parsed.refreshToken !== "string" || parsed.refreshToken === "") return null;
    const user = parsed.user;
    if (typeof user !== "object" || user === null) return null;
    const id = (user as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      user: {
        id,
        ...(
          typeof (user as { email?: unknown }).email === "string" &&
          (user as { email: string }).email !== ""
            ? { email: (user as { email: string }).email }
            : {}
        ),
      },
    };
  } catch {
    return null;
  }
}

export function serializeSession(session: SupabaseSession): string {
  return JSON.stringify({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    user: session.user,
  });
}

/** True when the access token is missing or past its expiry (with 60s skew). */
export function isSessionExpired(session: SupabaseSession | null, now: number = Date.now()): boolean {
  if (session === null) return true;
  if (session.expiresAt === 0) return false;
  return now >= session.expiresAt - 60_000;
}

/**
 * Short-lived handoff for invite/recovery tokens between `/auth/callback`
 * and `/reset-password`. The callback screen consumes the URL hash, stores
 * the access token here, strips the hash from the address bar
 * (`history.replaceState`), and navigates to `/reset-password`, which reads
 * the token back. `sessionStorage` (tab-scoped) is used instead of
 * `localStorage` so the token never persists beyond the tab, and it is
 * cleared after a successful password update.
 *
 * Storage may be disabled (private mode, blocked cookies): every helper
 * keeps an in-page JS-memory copy as a fallback so a valid link still works
 * for router-internal navigation. The memory copy is written before
 * `sessionStorage` is attempted, so a failed `setItem` never falls back to a
 * stale stored value — the newest token always wins. Clearing sets an
 * in-memory tombstone, so a failed `removeItem` cannot resurrect a stale
 * token on this page. A full page reload drops the memory fallback (only
 * `sessionStorage` survives a reload); this limitation is intentional and the
 * token is never copied to `localStorage`, the URL query, or logs.
 */
export const RECOVERY_TOKEN_KEY = "pi-fit-trace:auth:v1:recovery-token";

// In-page fallback + tombstone. Module-scoped on purpose (single tab page);
// tests must call `resetRecoveryTokenMemoryForTests()` in `afterEach` so no
// token or tombstone leaks between tests.
let memoryRecoveryToken: string | null = null;
let recoveryTokenCleared = false;

function storageGet(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key);
    else globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Tab storage failures must not break the recovery flow.
  }
}

export function saveRecoveryToken(accessToken: string): void {
  memoryRecoveryToken = accessToken;
  recoveryTokenCleared = false;
  storageSet(RECOVERY_TOKEN_KEY, accessToken);
}

export function loadRecoveryToken(): string | null {
  // A cleared tombstone wins over any stale value left behind by a failed
  // `removeItem` — this page must never reuse a consumed token.
  if (recoveryTokenCleared) return null;
  // The newest token wins: a just-saved memory copy takes precedence over a
  // stale stored value left behind by a failed `setItem`.
  if (memoryRecoveryToken !== null) return memoryRecoveryToken;
  const value = storageGet(RECOVERY_TOKEN_KEY);
  return value === "" ? null : value;
}

export function clearRecoveryToken(): void {
  memoryRecoveryToken = null;
  recoveryTokenCleared = true;
  storageSet(RECOVERY_TOKEN_KEY, null);
}

/** Test-only reset for the in-page fallback/tombstone (no storage access). */
export function resetRecoveryTokenMemoryForTests(): void {
  memoryRecoveryToken = null;
  recoveryTokenCleared = false;
}

/** Remove the Auth hash from the address bar after consuming it. */
export function clearAuthHash(): void {
  try {
    const url = new URL(window.location.href);
    if (url.hash !== "") {
      url.hash = "";
      window.history.replaceState(null, "", url.toString());
    }
  } catch {
    // Non-browser contexts (tests) have no location to clean.
  }
}

/** Invite links create the account password through the same reset form. */
export function isPasswordSetupType(type: string | null): boolean {
  return type === "recovery" || type === "invite";
}
