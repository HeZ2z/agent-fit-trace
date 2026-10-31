import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AUTH_EXPIRY_SKEW_MS,
  AUTH_REFRESH_RETRY_BASE_MS,
  AUTH_REFRESH_RETRY_MAX_MS,
  isRefreshCredentialCurrent,
  AuthError,
  authErrorMessage,
  authRefreshRetryDelayMs,
  authRefreshTimerDelayMs,
  isSessionExpired,
  isSessionGenerationCurrent,
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
import {
  AUTH_CONTROL_TABLE_SQL,
  AUTH_REFRESH_LEASE_ACQUIRE_SQL,
  AUTH_REFRESH_LEASE_RELEASE_SQL,
  AUTH_REFRESH_LEASE_TABLE_SQL,
  AUTH_SIGN_IN_ATTEMPT_BEGIN_SQL,
  AUTH_SIGN_IN_ATTEMPT_CURRENT_SQL,
  AUTH_SIGN_IN_ATTEMPT_INVALIDATE_SQL,
  AUTH_SIGN_IN_ATTEMPT_TABLE_SQL,
  shouldDeleteRevokedSession,
  shouldApplySignInResult,
  persistCurrentSignInAttempt,
} from "../mobile/src/auth/authControlModel.ts";

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
  assert.equal(MOBILE_AUTH_SESSION_KEY, "agent-fit-trace.auth.v1.mobile");
  // expo-secure-store rejects keys outside /^[\w.-]+$/ (colons are invalid).
  assert.match(MOBILE_AUTH_SESSION_KEY, /^[\w.-]+$/);
});

test("revoked or stale SecureStore session generations fail closed", () => {
  assert.equal(isSessionGenerationCurrent(5, 5, false), true);
  assert.equal(isSessionGenerationCurrent(4, 5, false), false, "late refresh from an older epoch is rejected");
  assert.equal(isSessionGenerationCurrent(5, 5, true), false, "revocation wins even if key deletion fails");
  assert.equal(isSessionGenerationCurrent(Number.NaN, 5, false), false);
  assert.equal(isRefreshCredentialCurrent(5, 5, false, "refresh-5", "refresh-5"), true);
  assert.equal(isRefreshCredentialCurrent(5, 5, false, "refresh-6", "refresh-5"), false, "late refresh cannot replace a newer token in the same epoch");
  assert.equal(shouldDeleteRevokedSession(5, 5, true), true);
  assert.equal(shouldDeleteRevokedSession(6, 5, true), false, "a delayed delete cannot erase the newer login");
});

test("SQLite refresh lease serializes runtimes and fences a revoked owner's release", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(AUTH_CONTROL_TABLE_SQL);
    database.exec(AUTH_REFRESH_LEASE_TABLE_SQL);
    database.prepare("INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, 1, 0)").run();
    const acquire = database.prepare(AUTH_REFRESH_LEASE_ACQUIRE_SQL);
    const claim = (owner: string, generation: number, at: string, expiry: string) => acquire.run(
      owner, generation, expiry, generation, at,
    );
    assert.equal(claim("provider", 1, "2026-10-31T00:00:00.000Z", "2026-10-31T00:00:25.000Z").changes, 1);
    assert.equal(claim("headless", 1, "2026-10-31T00:00:01.000Z", "2026-10-31T00:00:26.000Z").changes, 0);

    database.prepare("UPDATE auth_control SET generation = 2, revoked = 1 WHERE singleton = 1").run();
    database.prepare("UPDATE auth_control SET generation = 3, revoked = 0 WHERE singleton = 1").run();
    assert.equal(claim("new-login", 3, "2026-10-31T00:00:02.000Z", "2026-10-31T00:00:27.000Z").changes, 1);
    assert.equal(database.prepare(AUTH_REFRESH_LEASE_RELEASE_SQL).run(1, "provider").changes, 0);
    const current = database.prepare("SELECT owner, generation FROM auth_refresh_lease WHERE singleton = 1")
      .get() as { owner: string; generation: number };
    assert.deepEqual({ ...current }, { owner: "new-login", generation: 3 });
  } finally {
    database.close();
  }
});

test("SQLite sign-in intent fences stale saves and sign-out wins a save race", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(AUTH_CONTROL_TABLE_SQL);
    database.exec(AUTH_SIGN_IN_ATTEMPT_TABLE_SQL);
    database.prepare("INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, 1, 1)").run();
    const begin = database.prepare(AUTH_SIGN_IN_ATTEMPT_BEGIN_SQL);
    const currentAttempt = () => (database.prepare(AUTH_SIGN_IN_ATTEMPT_CURRENT_SQL).get() as { attempt: number }).attempt;
    begin.run();
    const firstAttempt = currentAttempt();
    begin.run();
    const secondAttempt = currentAttempt();

    // This mirrors saveNewStoredSession's CAS inside its exclusive SQLite
    // transaction: the earlier token response cannot replace the latest one.
    database.exec("BEGIN IMMEDIATE");
    assert.notEqual(currentAttempt(), firstAttempt);
    database.exec("ROLLBACK");
    assert.equal(shouldApplySignInResult(1, 2, 2), false);

    // A later sign-out invalidates every outstanding intent and revokes the
    // active generation atomically; a late completion cannot apply in React.
    database.exec("BEGIN IMMEDIATE");
    database.prepare(AUTH_SIGN_IN_ATTEMPT_INVALIDATE_SQL).run();
    database.prepare("UPDATE auth_control SET generation = generation + 1, revoked = 1 WHERE singleton = 1").run();
    database.exec("COMMIT");
    assert.notEqual(currentAttempt(), secondAttempt);
    assert.equal(shouldApplySignInResult(2, 3, 3), false);

    // The next deliberate login can still proceed after sign-out completes.
    begin.run();
    const thirdAttempt = currentAttempt();
    database.exec("BEGIN IMMEDIATE");
    assert.equal(currentAttempt(), thirdAttempt);
    database.prepare("UPDATE auth_control SET generation = generation + 1, revoked = 0 WHERE singleton = 1").run();
    database.exec("COMMIT");
    assert.equal(shouldApplySignInResult(3, 3, 4), true);
  } finally {
    database.close();
  }
});

test("late SecureStore completion after sign-out or a newer login is revoked, never applied", async () => {
  let localAttempt = 1;
  let finishSave!: (generation: number | null) => void;
  const pendingSave = new Promise<number | null>((resolve) => { finishSave = resolve; });
  const revoked: number[] = [];
  const stale = persistCurrentSignInAttempt(
    1,
    () => localAttempt,
    () => pendingSave,
    async (generation) => { revoked.push(generation); },
  );

  // Sign-out or a second sign-in increments this ref while SecureStore is
  // still pending. The stale identity must not reach AuthProvider state.
  localAttempt = 2;
  finishSave(7);
  assert.equal(await stale, null);
  assert.deepEqual(revoked, [7]);

  let finishSecondSave!: (generation: number | null) => void;
  const secondSave = new Promise<number | null>((resolve) => { finishSecondSave = resolve; });
  const current = persistCurrentSignInAttempt(
    2,
    () => localAttempt,
    () => secondSave,
    async (generation) => { revoked.push(generation); },
  );
  finishSecondSave(8);
  assert.equal(await current, 8);
  assert.deepEqual(revoked, [7]);
});

test("separate SQLite connections serialize SecureStore save and sign-out writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "fit-trace-auth-lock-"));
  const filename = join(directory, "auth.db");
  const savingRuntime = new DatabaseSync(filename);
  const signOutRuntime = new DatabaseSync(filename);
  try {
    savingRuntime.exec(AUTH_CONTROL_TABLE_SQL);
    savingRuntime.exec(AUTH_SIGN_IN_ATTEMPT_TABLE_SQL);
    savingRuntime.exec("INSERT INTO auth_control (singleton, generation, revoked) VALUES (1, 1, 1)");
    savingRuntime.prepare(AUTH_SIGN_IN_ATTEMPT_BEGIN_SQL).run();
    signOutRuntime.exec("PRAGMA busy_timeout = 10");

    // The save path takes a write lock before awaiting SecureStore. A second
    // runtime cannot advance the durable intent while that secret write is in
    // flight; it must retry the lock acquisition after the transaction ends.
    savingRuntime.exec("BEGIN IMMEDIATE");
    savingRuntime.exec("UPDATE auth_sign_in_attempt SET attempt = attempt WHERE singleton = 1");
    assert.throws(
      () => signOutRuntime.prepare(AUTH_SIGN_IN_ATTEMPT_INVALIDATE_SQL).run(),
      /locked/i,
    );
    savingRuntime.prepare("UPDATE auth_control SET generation = 2, revoked = 0 WHERE singleton = 1").run();
    savingRuntime.exec("COMMIT");

    signOutRuntime.exec("BEGIN IMMEDIATE");
    signOutRuntime.prepare(AUTH_SIGN_IN_ATTEMPT_INVALIDATE_SQL).run();
    signOutRuntime.prepare("UPDATE auth_control SET generation = generation + 1, revoked = 1 WHERE singleton = 1").run();
    signOutRuntime.exec("COMMIT");
    const control = savingRuntime.prepare("SELECT generation, revoked FROM auth_control WHERE singleton = 1")
      .get() as { generation: number; revoked: number };
    assert.deepEqual({ ...control }, { generation: 3, revoked: 1 });
  } finally {
    savingRuntime.close();
    signOutRuntime.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
