/**
 * Pure account-auth model for the mobile app.
 *
 * This module holds the environment-free parts of the mobile account slice:
 * configuration resolution, credential validation, token/session parsing,
 * expiry math, secure-store serialization and error mapping. It imports no
 * React, expo or DOM values, so the root `node:test` suite can load it through
 * Node's TypeScript type stripping (see `tests/mobileAuthModel.test.ts`).
 *
 * Guest/local-only remains the default product mode. These helpers only build
 * the sign-in foundation; they never trigger a sync or a cloud-coach call.
 */

/**
 * Versioned SecureStore key, mobile-specific so it can never collide with the
 * web client's localStorage entry. SecureStore keys accept only word
 * characters, `.`, `-` and `_`, so the web-style colons are dots here.
 */
export const MOBILE_AUTH_SESSION_KEY = "pi-fit-trace.auth.v1.mobile";

/** Refresh a session this long before its access token actually expires. */
export const AUTH_EXPIRY_SKEW_MS = 60_000;

/** Supabase's default access-token lifetime when `expires_in` is missing. */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3_600;

/**
 * Public account-auth lifecycle. `unconfigured` is a first-class state (the
 * build has no Supabase public env); it must never crash or block local use.
 */
export type AuthStatus = "loading" | "signed-out" | "signed-in" | "unconfigured" | "error";

export interface SupabaseAuthUser {
  id: string;
  email?: string;
  /**
   * Trusted classification from `GET /auth/v1/user` only. Token responses are
   * never authoritative, so restored sessions do not carry it.
   */
  isAnonymous?: boolean;
  /** Verified email-confirmation timestamp from `GET /auth/v1/user`. */
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

export interface AuthEnvironment {
  supabaseUrl?: string | null | undefined;
  supabaseAnonKey?: string | null | undefined;
}

export type AuthFailureCode =
  | "invalid-email"
  | "password-required"
  | "invalid-credentials"
  | "email-not-confirmed"
  | "network"
  | "rate-limited"
  | "service-unavailable"
  | "session-expired"
  | "unconfigured"
  | "unknown";

/**
 * English source strings for the auth UI. Screens render these through `t()`
 * so the Chinese display layer stays in the shared dictionary.
 */
const AUTH_FAILURE_MESSAGES: Record<AuthFailureCode, string> = {
  "invalid-email": "Enter a valid email address.",
  "password-required": "Enter your password.",
  "invalid-credentials": "Invalid email or password.",
  "email-not-confirmed": "Confirm your email before signing in.",
  network: "The sign-in service is unavailable. Check your connection and try again.",
  "rate-limited": "Too many attempts. Wait a moment and try again.",
  "service-unavailable": "The sign-in service is unavailable. Check your connection and try again.",
  "session-expired": "Your session expired. Sign in again.",
  unconfigured:
    "Sign-in is not configured in this build. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to enable accounts.",
  unknown: "Sign-in failed. Try again.",
};

/** Redacted auth failure: never carries tokens, passwords or raw bodies. */
export class AuthError extends Error {
  readonly code: AuthFailureCode;
  readonly status: number | undefined;

  constructor(code: AuthFailureCode, options: { status?: number; message?: string } = {}) {
    super(options.message ?? authErrorMessage(code));
    this.name = "AuthError";
    this.code = code;
    this.status = options.status;
  }
}

/** Localized-source message for an auth failure code (unknown codes degrade). */
export function authErrorMessage(code: string): string {
  return AUTH_FAILURE_MESSAGES[code as AuthFailureCode] ?? AUTH_FAILURE_MESSAGES.unknown;
}

/**
 * Transient failures (network, 429, 5xx) must not discard a stored session or
 * sign the user out; only a definitive invalid/expired session does that.
 */
export function isTransientAuthError(error: unknown): boolean {
  if (!(error instanceof AuthError)) return false;
  if (
    error.code === "network" ||
    error.code === "rate-limited" ||
    error.code === "service-unavailable"
  ) {
    return true;
  }
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
}

/**
 * Resolve the public Supabase config. Missing/blank/invalid values return
 * `null` (the provider reports `unconfigured`); this function never throws.
 */
export function resolveAuthConfig(env: AuthEnvironment): SupabaseAuthConfig | null {
  const rawUrl = typeof env.supabaseUrl === "string" ? env.supabaseUrl.trim() : "";
  const publishableKey =
    typeof env.supabaseAnonKey === "string" ? env.supabaseAnonKey.trim() : "";
  if (publishableKey === "") return null;

  const supabaseUrl = rawUrl.replace(/\/+$/, "");
  // Accept local Supabase (http://127.0.0.1:54321) and hosted projects.
  if (!/^https?:\/\/[^\s/]+(?::\d+)?$/i.test(supabaseUrl)) return null;
  return { supabaseUrl, publishableKey };
}

/** Auth emails are whitespace-insensitive; the provider owns case folding. */
export function normalizeEmail(email: string): string {
  return email.trim();
}

/** Deliberately loose: Supabase is the authority on address validity. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export type SignInValidation =
  | { ok: true; email: string }
  | { ok: false; code: "invalid-email" | "password-required" };

/** Validate just enough to avoid a guaranteed-failing network request. */
export function validateSignInInput(email: string, password: string): SignInValidation {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return { ok: false, code: "invalid-email" };
  if (password === "") return { ok: false, code: "password-required" };
  return { ok: true, email: normalized };
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
 * client accepts `is_anonymous` / `email_confirmed_at`; token responses and
 * cached sessions are not authoritative.
 */
export function parseVerifiedUser(raw: unknown): SupabaseAuthUser | null {
  const user = toUser(raw);
  if (user === null) return null;
  const record = raw as { is_anonymous?: unknown; email_confirmed_at?: unknown };
  return {
    ...user,
    ...(typeof record.is_anonymous === "boolean" ? { isAnonymous: record.is_anonymous } : {}),
    ...(typeof record.email_confirmed_at === "string" && record.email_confirmed_at !== ""
      ? { emailConfirmedAt: record.email_confirmed_at }
      : {}),
  };
}

/** Epoch ms for an `expires_in` value; unknown/invalid values use the default. */
export function accessTokenExpiresAt(expiresIn: unknown, now: number = Date.now()): number {
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return now + seconds * 1000;
}

/**
 * Parse a Supabase token grant (`password` or `refresh_token`). Returns `null`
 * for anything malformed; the caller maps that to a redacted `AuthError`.
 */
export function sessionFromTokenResponse(
  body: unknown,
  now: number = Date.now(),
): SupabaseSession | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  if (typeof refreshToken !== "string" || refreshToken === "") return null;
  const user = toUser(record.user);
  if (user === null) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: accessTokenExpiresAt(record.expires_in, now),
    user,
  };
}

/** Extract Supabase's error code without keeping the raw provider message. */
export function providerErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  // GoTrue variants use `error_code` (current), `code` (string) or `error`.
  const code = record.error_code ?? record.code ?? record.error;
  return typeof code === "string" && code !== "" ? code.toLowerCase() : null;
}

/**
 * Map a token-endpoint HTTP status/provider code to the UI's failure code.
 * Invalid credentials and unconfirmed email stay distinguishable for copy,
 * but neither leaks whether an account exists beyond the provider's own reply.
 */
export function mapTokenErrorStatus(status: number, code: string | null = null): AuthFailureCode {
  if (status === 429) return "rate-limited";
  if (status >= 500) return "service-unavailable";
  if (code === "email_not_confirmed" || code === "email_not_verified") {
    return "email-not-confirmed";
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 422 ||
    code === "invalid_grant" ||
    code === "invalid_credentials"
  ) {
    return "invalid-credentials";
  }
  return "unknown";
}

/** Map any thrown value to a redacted AuthError (network ⇒ transient). */
export function toAuthError(cause: unknown): AuthError {
  if (cause instanceof AuthError) return cause;
  if (cause instanceof TypeError) return new AuthError("network");
  return new AuthError("unknown");
}

/** True when the access token is missing or within the expiry skew. */
export function isSessionExpired(
  session: SupabaseSession | null,
  now: number = Date.now(),
  skewMs: number = AUTH_EXPIRY_SKEW_MS,
): boolean {
  if (session === null) return true;
  if (session.expiresAt === 0) return false;
  return now >= session.expiresAt - skewMs;
}

/**
 * Delay before the proactive refresh timer should fire. `null` means the
 * expiry is unknown (`expiresAt === 0`), so no timer is scheduled.
 */
export function sessionRefreshDelayMs(
  session: SupabaseSession | null,
  now: number = Date.now(),
  skewMs: number = AUTH_EXPIRY_SKEW_MS,
): number | null {
  if (session === null || session.expiresAt === 0) return null;
  return Math.max(0, session.expiresAt - now - skewMs);
}

/**
 * Serialize a session for SecureStore. Classification fields are deliberately
 * dropped: a cached "account" flag must never authorize anything before the
 * Auth server verifies the session. Tokens are never logged or copied anywhere
 * except this single namespaced SecureStore value.
 */
export function serializeSession(session: SupabaseSession): string {
  return JSON.stringify({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    user: {
      id: session.user.id,
      ...(session.user.email === undefined ? {} : { email: session.user.email }),
    },
  });
}

/** Deserialize a stored session; anything malformed is discarded (`null`). */
export function parseStoredSession(raw: string | null): SupabaseSession | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken === "") return null;
    if (typeof parsed.refreshToken !== "string" || parsed.refreshToken === "") return null;
    const user = parsed.user;
    if (typeof user !== "object" || user === null) return null;
    const id = (user as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") return null;
    const email = (user as { email?: unknown }).email;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      user: {
        id,
        ...(typeof email === "string" && email !== "" ? { email } : {}),
      },
    };
  } catch {
    return null;
  }
}
