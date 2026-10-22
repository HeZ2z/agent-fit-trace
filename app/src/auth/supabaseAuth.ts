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
  /**
   * Trusted anonymous classification from `GET /auth/v1/user` only. Token
   * responses, stored sessions, request bodies, and metadata are never
   * authoritative. `undefined` means "not verified yet" or "provider did not
   * classify"; callers must fail closed for account-only capabilities.
   */
  isAnonymous?: boolean;
  /**
   * Verified email-confirmation timestamp, also accepted only from
   * `GET /auth/v1/user`. A guest-upgrade callback must require it before
   * offering password setup; `email` alone can still be a pending change.
   */
  emailConfirmedAt?: string;
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

export const AUTH_STORAGE_KEY = "agent-fit-trace:auth:v1:session";

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

/**
 * Parse the verified `GET /auth/v1/user` response. This is the only place the
 * client accepts `is_anonymous`; token-grant responses are not used for
 * classification, and cached sessions never carry it.
 */
function toVerifiedUser(raw: unknown): SupabaseAuthUser | null {
  const user = toUser(raw);
  if (user === null) return null;
  const record = raw as { is_anonymous?: unknown; email_confirmed_at?: unknown };
  const emailConfirmedAt = record.email_confirmed_at;
  return {
    ...user,
    ...(typeof record.is_anonymous === "boolean"
      ? { isAnonymous: record.is_anonymous }
      : {}),
    ...(typeof emailConfirmedAt === "string" && emailConfirmedAt !== ""
      ? { emailConfirmedAt }
      : {}),
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

/**
 * Create an anonymous guest session.
 *
 * GoTrue routes `POST /auth/v1/signup` to `SignupAnonymously` when the body
 * carries neither `email` nor `phone` (pinned source:
 * `supabase/auth@ce9a8eee0...`, `internal/api/api.go`), and rejects it with 422
 * when anonymous sign-ins are disabled or global signup is disabled.
 *
 * The token response is used for tokens only: guest classification is read
 * from the subsequent verified `GET /auth/v1/user` call, and a missing
 * `is_anonymous` stays `undefined` (fail closed). Callers must not treat this
 * as account eligibility. Public AuthContext hook names planned for the next
 * slice: `signInAsGuest`, `beginGuestUpgrade`, `refreshVerifiedUser`.
 */
/** Optional official anonymous-signup transport fields. */
export interface GuestSignInOptions {
  /**
   * CAPTCHA token obtained by the host page. GoTrue expects it under
   * `gotrue_meta_security.captcha_token`; this client does not solve or verify
   * CAPTCHAs and does not claim that a deployment has them enabled.
   */
  captchaToken?: string;
  /**
   * Receives the unverified token session immediately after the successful
   * signup POST and before `GET /auth/v1/user`. Callers persist this candidate
   * so a transient verification outage can be retried without another guest
   * POST.
   */
  onCandidate?: (session: SupabaseSession) => void;
}

export async function signInAnonymously(
  config: SupabaseAuthConfig,
  fetchImpl: AuthFetch = fetch,
  options: GuestSignInOptions = {},
): Promise<SupabaseSession> {
  // Match the official auth-js anonymous transport: `data` is always present
  // and the CAPTCHA token is optional.
  const requestBody: Record<string, unknown> = { data: {} };
  if (typeof options.captchaToken === "string" && options.captchaToken !== "") {
    requestBody.gotrue_meta_security = { captcha_token: options.captchaToken };
  }
  let response: Response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}/auth/v1/signup`, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(requestBody),
    });
  } catch {
    throw unavailableError();
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // 429/5xx are transient; 4xx (422 disabled, 400 invalid) are terminal.
    if (response.status === 429 || response.status >= 500) throw unavailableError();
    throw new AuthError(
      "GUEST_SIGN_IN_FAILED",
      authErrorMessage(body, "Guest sessions are unavailable. Try again later."),
      response.status,
    );
  }
  const session = sessionFromTokenResponse(body);
  if (session === null) {
    throw new AuthError("GUEST_SIGN_IN_FAILED", "Guest sign-in returned an invalid session.");
  }
  // The guest now exists server-side. Hand the unverified credentials to the
  // caller before verification so a transient `/user` outage cannot orphan
  // them behind a second signup POST.
  options.onCandidate?.(session);
  const verified = await fetchAuthUser(config, session.accessToken, fetchImpl);
  return { ...session, user: verified };
}

/**
 * Start the invited same-UID guest upgrade by requesting an email change on
 * the CURRENT guest session (`PUT /auth/v1/user`).
 *
 * This is only the initiation step: GoTrue sends a confirmation link while the
 * user remains anonymous, and the pending invite is preserved until the
 * verify transaction converts the user (see
 * `supabase/migrations/20261017000100_signup_gate.sql`). Callers must not
 * report an upgraded account until a later callback verifies the same UID,
 * `is_anonymous === false`, and a confirmed target email.
 *
 * `emailRedirectTo` is sent in the official `redirect_to` query parameter for
 * the email template. The request deliberately does not invent a CAPTCHA
 * field: GoTrue v2.197.0's `UserUpdateParams` has no CAPTCHA field for this
 * authenticated endpoint, so claiming CAPTCHA enforcement here would be
 * false. The deployment must enforce its own abuse controls.
 */
export interface GuestUpgradeRequestOptions {
  emailRedirectTo?: string;
}

export async function beginGuestUpgrade(
  config: SupabaseAuthConfig,
  accessToken: string,
  email: string,
  fetchImpl: AuthFetch = fetch,
  options: GuestUpgradeRequestOptions = {},
): Promise<void> {
  const redirect =
    typeof options.emailRedirectTo === "string" && options.emailRedirectTo !== ""
      ? `?redirect_to=${encodeURIComponent(options.emailRedirectTo)}`
      : "";
  let response: Response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}/auth/v1/user${redirect}`, {
      method: "PUT",
      headers: authHeaders(config, accessToken),
      body: JSON.stringify({ email }),
    });
  } catch {
    throw unavailableError();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 429 || response.status >= 500) throw unavailableError();
    throw new AuthError(
      "GUEST_UPGRADE_FAILED",
      authErrorMessage(
        body,
        "That email cannot be used for an account upgrade. Ask an administrator for an invitation.",
      ),
      response.status,
    );
  }
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
  const user = toVerifiedUser(body);
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
  /** Epoch milliseconds when the callback access token expires (0 unknown). */
  expiresAt: number;
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
  const expiresAtRaw = params.get("expires_at");
  const expiresInRaw = params.get("expires_in");
  const parsedExpiresAt = expiresAtRaw === null ? NaN : Number(expiresAtRaw);
  const parsedExpiresIn = expiresInRaw === null ? NaN : Number(expiresInRaw);
  const expiresAt = Number.isFinite(parsedExpiresAt) && parsedExpiresAt > 0
    ? parsedExpiresAt * 1000
    : Number.isFinite(parsedExpiresIn) && parsedExpiresIn > 0
      ? Date.now() + parsedExpiresIn * 1000
      : 0;
  return {
    accessToken,
    refreshToken: params.get("refresh_token") ?? "",
    type: params.get("type"),
    expiresAt,
  };
}

/**
 * Deserialize a stored session; anything malformed is discarded (null).
 *
 * Only the stable id/email are restored. `isAnonymous` is intentionally not
 * read from storage: cached classification must never authorize anything
 * before `GET /auth/v1/user` verifies the session.
 */
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
    // Never persist the trusted classification: it is re-read from the Auth
    // server after restore. A stale "false" in localStorage must not look
    // like a verified account.
    user: {
      id: session.user.id,
      ...(session.user.email === undefined ? {} : { email: session.user.email }),
    },
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
export const RECOVERY_TOKEN_KEY = "agent-fit-trace:auth:v1:recovery-token";

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

/**
 * Auth redirect types that can carry the result of an email confirmation or
 * change. GoTrue/auth-js use `email_change`; `email` is accepted as the
 * generic email-confirmation type. A callback is only applied when the
 * tab-scoped pending upgrade matches the verified same UID.
 */
export function isEmailVerificationType(type: string | null): boolean {
  return type === "email_change" || type === "email";
}
