import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTH_EXPIRY_SKEW_MS,
  AUTH_REFRESH_RETRY_BASE_MS,
  AUTH_REFRESH_RETRY_MAX_MS,
  AuthError,
  authErrorMessage,
  authRefreshRetryDelayMs,
  authRefreshTimerDelayMs,
  isSessionExpired,
  isTransientAuthError,
  MOBILE_AUTH_SESSION_KEY,
  mapTokenErrorStatus,
  nextAuthRefreshRetry,
  parseStoredSession,
  parseVerifiedUser,
  resolveAuthConfig,
  serializeSession,
  sessionFromTokenResponse,
  sessionRefreshDelayMs,
  toAuthError,
  validateSignInInput,
  type SupabaseSession,
} from "../mobile/src/auth/authModel.ts";

/**
 * Pure coverage for the mobile account foundation. No network, SecureStore or
 * React is imported: only the deterministic model helpers are exercised, so
 * the root `node:test` suite never needs a native runtime.
 */

const NOW = 1_700_000_000_000;

function session(overrides: Partial<SupabaseSession> = {}): SupabaseSession {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: NOW + 3_600_000,
    user: { id: "user-1", email: "lifter@example.com" },
    ...overrides,
  };
}

test("mobile session key is versioned, mobile-specific, and SecureStore-safe", () => {
  assert.equal(MOBILE_AUTH_SESSION_KEY, "pi-fit-trace.auth.v1.mobile");
  // expo-secure-store rejects keys outside /^[\w.-]+$/ (colons are invalid).
  assert.match(MOBILE_AUTH_SESSION_KEY, /^[\w.-]+$/);
});

test("resolveAuthConfig returns the trimmed public config or null", () => {
  assert.deepEqual(
    resolveAuthConfig({
      supabaseUrl: " https://project.supabase.co/ ",
      supabaseAnonKey: " anon-key ",
    }),
    { supabaseUrl: "https://project.supabase.co", publishableKey: "anon-key" },
  );
  assert.deepEqual(
    resolveAuthConfig({
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseAnonKey: "local-key",
    }),
    { supabaseUrl: "http://127.0.0.1:54321", publishableKey: "local-key" },
  );

  assert.equal(resolveAuthConfig({ supabaseAnonKey: "anon-key" }), null);
  assert.equal(
    resolveAuthConfig({ supabaseUrl: "https://project.supabase.co", supabaseAnonKey: "  " }),
    null,
  );
  assert.equal(
    resolveAuthConfig({ supabaseUrl: "ftp://project.supabase.co", supabaseAnonKey: "anon-key" }),
    null,
  );
  assert.equal(
    resolveAuthConfig({
      supabaseUrl: "not a url",
      supabaseAnonKey: "anon-key",
    }),
    null,
  );
});

test("validateSignInInput trims the email and rejects missing pieces", () => {
  assert.deepEqual(validateSignInInput(" lifter@example.com ", "secret"), {
    ok: true,
    email: "lifter@example.com",
  });
  assert.deepEqual(validateSignInInput("", "secret"), { ok: false, code: "invalid-email" });
  assert.deepEqual(validateSignInInput("not-an-email", "secret"), {
    ok: false,
    code: "invalid-email",
  });
  assert.deepEqual(validateSignInInput("lifter@example.com", ""), {
    ok: false,
    code: "password-required",
  });
});

test("access-token expiry applies the 60s refresh skew", () => {
  const active = session({ expiresAt: NOW + AUTH_EXPIRY_SKEW_MS + 1 });
  assert.equal(isSessionExpired(active, NOW), false);
  assert.equal(isSessionExpired(session({ expiresAt: NOW + AUTH_EXPIRY_SKEW_MS }), NOW), true);
  assert.equal(isSessionExpired(session({ expiresAt: NOW }), NOW), true);
  // Unknown expiry is not treated as expired; there is simply no timer.
  assert.equal(isSessionExpired(session({ expiresAt: 0 }), NOW), false);
  assert.equal(isSessionExpired(null, NOW), true);

  assert.equal(sessionRefreshDelayMs(active, NOW), 1);
  assert.equal(sessionRefreshDelayMs(session({ expiresAt: NOW }), NOW), 0);
  assert.equal(sessionRefreshDelayMs(session({ expiresAt: 0 }), NOW), null);
  assert.equal(sessionRefreshDelayMs(null, NOW), null);
});

test("temporary refresh failures back off exponentially with a bounded delay", () => {
  assert.equal(authRefreshRetryDelayMs(1), AUTH_REFRESH_RETRY_BASE_MS);
  assert.equal(authRefreshRetryDelayMs(2), AUTH_REFRESH_RETRY_BASE_MS * 2);
  assert.equal(authRefreshRetryDelayMs(3), AUTH_REFRESH_RETRY_BASE_MS * 4);
  assert.equal(authRefreshRetryDelayMs(5), AUTH_REFRESH_RETRY_BASE_MS * 16);
  // The delay stops growing at the cap (attempt 6 would otherwise be 64s).
  assert.equal(authRefreshRetryDelayMs(6), AUTH_REFRESH_RETRY_MAX_MS);
  assert.equal(authRefreshRetryDelayMs(1_000), AUTH_REFRESH_RETRY_MAX_MS);
  assert.equal(authRefreshRetryDelayMs(2, 1_000, 5_000), 2_000);
  assert.equal(authRefreshRetryDelayMs(10, 1_000, 5_000), 5_000);

  // Invalid/small attempts start at the base instead of yielding 0 or NaN.
  assert.equal(authRefreshRetryDelayMs(0), AUTH_REFRESH_RETRY_BASE_MS);
  assert.equal(authRefreshRetryDelayMs(-3), AUTH_REFRESH_RETRY_BASE_MS);
  assert.equal(authRefreshRetryDelayMs(Number.NaN), AUTH_REFRESH_RETRY_BASE_MS);
});

test("refresh retry state advances and resets to the base delay", () => {
  const first = nextAuthRefreshRetry(null);
  assert.deepEqual(first, { attempt: 1, delayMs: AUTH_REFRESH_RETRY_BASE_MS });

  const second = nextAuthRefreshRetry(first);
  assert.deepEqual(second, { attempt: 2, delayMs: AUTH_REFRESH_RETRY_BASE_MS * 2 });

  let retry = first;
  for (let i = 0; i < 20; i += 1) retry = nextAuthRefreshRetry(retry);
  assert.equal(retry.attempt, 21);
  assert.equal(retry.delayMs, AUTH_REFRESH_RETRY_MAX_MS);

  // Success/sign-in/foreground reset the schedule (`null`), so the next
  // transient failure starts at the base delay again rather than at the cap.
  const reset = nextAuthRefreshRetry(null);
  assert.equal(reset.attempt, 1);
  assert.equal(reset.delayMs, AUTH_REFRESH_RETRY_BASE_MS);
});

test("refresh timer keeps a retry scheduled while signed-in or degraded to error", () => {
  const active = session({ expiresAt: NOW + 120_000 });
  const retry = nextAuthRefreshRetry(null);

  // Normal proactive timer: only a signed-in session schedules it.
  assert.equal(authRefreshTimerDelayMs("signed-in", active, null, NOW), 60_000);
  assert.equal(authRefreshTimerDelayMs("loading", active, null, NOW), null);
  assert.equal(authRefreshTimerDelayMs("signed-out", active, null, NOW), null);
  assert.equal(authRefreshTimerDelayMs("unconfigured", active, null, NOW), null);
  assert.equal(authRefreshTimerDelayMs("signed-in", null, retry, NOW), null);
  assert.equal(authRefreshTimerDelayMs("loading", active, retry, NOW), null);
  assert.equal(authRefreshTimerDelayMs("signed-out", active, retry, NOW), null);

  // A transient failure wins over the normal expiry delay while the token is
  // still valid...
  assert.equal(authRefreshTimerDelayMs("signed-in", active, retry, NOW), retry.delayMs);
  // ...and stays scheduled after the expired token demotes status to `error`
  // (the exact case where no proactive timer would otherwise exist).
  assert.equal(
    authRefreshTimerDelayMs("error", session({ expiresAt: NOW - 1 }), retry, NOW),
    retry.delayMs,
  );
  assert.equal(authRefreshTimerDelayMs("error", active, null, NOW), null);
});

test("sessionFromTokenResponse parses grants and never trusts token-side classification", () => {
  const parsed = sessionFromTokenResponse(
    {
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 120,
      user: {
        id: "user-1",
        email: "lifter@example.com",
        is_anonymous: false,
        email_confirmed_at: "2026-01-01T00:00:00Z",
      },
    },
    NOW,
  );
  assert.deepEqual(parsed, {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: NOW + 120_000,
    user: { id: "user-1", email: "lifter@example.com" },
  });

  const defaulted = sessionFromTokenResponse(
    { access_token: "access", refresh_token: "refresh", user: { id: "user-1" } },
    NOW,
  );
  assert.equal(defaulted?.expiresAt, NOW + 3_600_000);
  assert.equal(defaulted?.user.email, undefined);

  assert.equal(sessionFromTokenResponse(null, NOW), null);
  assert.equal(
    sessionFromTokenResponse({ refresh_token: "refresh", user: { id: "user-1" } }, NOW),
    null,
  );
  assert.equal(
    sessionFromTokenResponse({ access_token: "access", refresh_token: "", user: { id: "u" } }, NOW),
    null,
  );
  assert.equal(
    sessionFromTokenResponse({ access_token: "access", refresh_token: "refresh", user: {} }, NOW),
    null,
  );
});

test("parseVerifiedUser only accepts classification from the verified user endpoint", () => {
  assert.deepEqual(
    parseVerifiedUser({
      id: "user-1",
      email: "lifter@example.com",
      is_anonymous: false,
      email_confirmed_at: "2026-01-01T00:00:00Z",
    }),
    {
      id: "user-1",
      email: "lifter@example.com",
      isAnonymous: false,
      emailConfirmedAt: "2026-01-01T00:00:00Z",
    },
  );
  assert.deepEqual(parseVerifiedUser({ id: "user-2" }), { id: "user-2" });
  assert.equal(parseVerifiedUser({ id: "" }), null);
  assert.equal(parseVerifiedUser(null), null);
});

test("mapTokenErrorStatus distinguishes invalid credentials and transient failures", () => {
  assert.equal(mapTokenErrorStatus(400, "invalid_grant"), "invalid-credentials");
  assert.equal(mapTokenErrorStatus(400, "invalid_credentials"), "invalid-credentials");
  assert.equal(mapTokenErrorStatus(401, null), "invalid-credentials");
  assert.equal(mapTokenErrorStatus(400, "email_not_confirmed"), "email-not-confirmed");
  assert.equal(mapTokenErrorStatus(429, null), "rate-limited");
  assert.equal(mapTokenErrorStatus(503, null), "service-unavailable");
  assert.equal(mapTokenErrorStatus(418, null), "unknown");
});

test("auth error messages and transient classification are stable", () => {
  assert.equal(authErrorMessage("invalid-credentials"), "Invalid email or password.");
  assert.equal(
    authErrorMessage("network"),
    "The sign-in service is unavailable. Check your connection and try again.",
  );
  assert.match(authErrorMessage("unconfigured"), /EXPO_PUBLIC_SUPABASE_URL/);
  assert.equal(authErrorMessage("something-new"), "Sign-in failed. Try again.");

  assert.equal(isTransientAuthError(new AuthError("network")), true);
  assert.equal(isTransientAuthError(new AuthError("rate-limited")), true);
  assert.equal(isTransientAuthError(new AuthError("service-unavailable", { status: 503 })), true);
  assert.equal(isTransientAuthError(new AuthError("invalid-credentials", { status: 400 })), false);
  assert.equal(isTransientAuthError(new Error("nope")), false);

  assert.equal(toAuthError(new TypeError("fetch failed")).code, "network");
  const authError = new AuthError("session-expired");
  assert.equal(toAuthError(authError), authError);
  assert.equal(toAuthError("anything").code, "unknown");
});

test("session serialization round-trips but never persists classification", () => {
  const stored = serializeSession(
    session({
      user: {
        id: "user-1",
        email: "lifter@example.com",
        isAnonymous: false,
        emailConfirmedAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  const parsed = parseStoredSession(stored);
  assert.equal(parsed?.user.isAnonymous, undefined);
  assert.equal(parsed?.user.emailConfirmedAt, undefined);
  assert.deepEqual(parsed, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: NOW + 3_600_000,
    user: { id: "user-1", email: "lifter@example.com" },
  });

  assert.equal(parseStoredSession(null), null);
  assert.equal(parseStoredSession(""), null);
  assert.equal(parseStoredSession("not json"), null);
  assert.equal(parseStoredSession(JSON.stringify({ accessToken: "a" })), null);
  assert.equal(
    parseStoredSession(
      JSON.stringify({ accessToken: "a", refreshToken: "r", user: {}, expiresAt: "soon" }),
    ),
    null,
  );
});
