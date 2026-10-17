import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  RECOVERY_TOKEN_KEY,
  clearRecoveryToken,
  isPasswordSetupType,
  isSessionExpired,
  isTransientAuthError,
  fetchAuthUser,
  loadRecoveryToken,
  loadStoredSession,
  parseAuthCallbackHash,
  refreshSession,
  requestPasswordReset,
  resetRecoveryTokenMemoryForTests,
  saveRecoveryToken,
  serializeSession,
  signInAnonymously,
  signInWithPassword,
  signOut,
  updatePassword,
} from "./supabaseAuth.ts";
import type { SupabaseSession } from "./supabaseAuth.ts";

const config = { supabaseUrl: "http://127.0.0.1:54321", publishableKey: "pub-key" };

function jsonFetch(status: number, body: unknown) {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function session(): SupabaseSession {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600_000,
    user: { id: "user-1", email: "u@example.com" },
  };
}

describe("supabaseAuth", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
  });
  it("signs in and resolves the session user", async () => {
    const next = await signInWithPassword(
      config,
      "u@example.com",
      "password",
      jsonFetch(200, {
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        user: { id: "user-1", email: "u@example.com" },
      }),
    );
    expect(next.user.id).toBe("user-1");
    expect(next.accessToken).toBe("a");
  });

  it("redacts sign-in failures (no password or token in the error)", async () => {
    const error = await signInWithPassword(
      config,
      "u@example.com",
      "s3cret",
      jsonFetch(400, { msg: "Invalid login credentials" }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as Error).message).toContain("Invalid login credentials");
    expect((error as Error).message).not.toContain("s3cret");
  });

  it("refreshes the session and detects expiry", async () => {
    const next = await refreshSession(
      config,
      "refresh",
      jsonFetch(200, {
        access_token: "a2",
        refresh_token: "r2",
        expires_in: 3600,
        user: { id: "user-1" },
      }),
    );
    expect(next.accessToken).toBe("a2");
    expect(isSessionExpired({ ...next, expiresAt: Date.now() - 1000 })).toBe(true);
    expect(isSessionExpired(next)).toBe(false);
    const expired = await refreshSession(config, "stale", jsonFetch(401, { msg: "expired" })).catch(
      (caught: unknown) => caught,
    );
    expect(expired).toBeInstanceOf(AuthError);
    expect((expired as AuthError).code).toBe("SESSION_EXPIRED");
  });

  it("maps transient refresh/user failures to AUTH_UNAVAILABLE (never SESSION_EXPIRED)", async () => {
    for (const failing of [
      (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      jsonFetch(503, { message: "overloaded" }),
      jsonFetch(429, { message: "limited" }),
    ]) {
      const refreshError = await refreshSession(config, "refresh", failing).catch(
        (caught: unknown) => caught,
      );
      expect(refreshError).toBeInstanceOf(AuthError);
      expect((refreshError as AuthError).code).toBe("AUTH_UNAVAILABLE");
      expect(isTransientAuthError(refreshError)).toBe(true);

      const userError = await fetchAuthUser(config, "stale", failing).catch(
        (caught: unknown) => caught,
      );
      expect(userError).toBeInstanceOf(AuthError);
      expect((userError as AuthError).code).toBe("AUTH_UNAVAILABLE");
    }
    // Real expiry still signs out.
    const expired = await refreshSession(config, "stale", jsonFetch(400, { msg: "expired" })).catch(
      (caught: unknown) => caught,
    );
    expect(expired).toBeInstanceOf(AuthError);
    expect((expired as AuthError).code).toBe("SESSION_EXPIRED");
    expect(isTransientAuthError(expired)).toBe(false);
  });
  it("signs out without throwing on already-expired tokens", async () => {
    await expect(signOut(config, "stale", jsonFetch(401, {}))).resolves.toBeUndefined();
    await expect(signOut(config, "token", jsonFetch(200, {}))).resolves.toBeUndefined();
  });

  it("requests password resets via query redirect_to and updates passwords via recovery tokens", async () => {
    const seen: { url: string; body: string } = { url: "", body: "" };
    const recoverFetch = (async (url: unknown, init?: RequestInit) => {
      seen.url = String(url);
      seen.body = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await requestPasswordReset(config, "u@example.com", "http://x/auth/callback", recoverFetch);
    expect(seen.url).toContain("/auth/v1/recover");
    expect(seen.url).toContain("redirect_to=");
    expect(seen.body).toContain("u@example.com");
    expect(seen.body).not.toContain("redirect_to");

    const updateFetch = (async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(String((init?.headers as Record<string, string>).Authorization)).toContain("recovery");
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await updatePassword(config, "recovery", "new-password-1", updateFetch);
  });

  it("parses callback hashes for invite and recovery links", () => {
    expect(parseAuthCallbackHash("")).toBeNull();
    const recovery = parseAuthCallbackHash("#access_token=abc&refresh_token=def&type=recovery");
    expect(recovery?.type).toBe("recovery");
    expect(recovery?.accessToken).toBe("abc");
    const invite = parseAuthCallbackHash("#access_token=abc&refresh_token=def&type=invite");
    expect(isPasswordSetupType(invite?.type ?? null)).toBe(true);
    expect(isPasswordSetupType(recovery?.type ?? null)).toBe(true);
    expect(isPasswordSetupType("sms")).toBe(false);
    expect(isPasswordSetupType(null)).toBe(false);
  });

  it("round-trips stored sessions and discards malformed values", () => {
    expect(loadStoredSession(null)).toBeNull();
    expect(loadStoredSession("not-json")).toBeNull();
    expect(loadStoredSession(JSON.stringify({ accessToken: "a" }))).toBeNull();
    const restored = loadStoredSession(serializeSession(session()));
    expect(restored?.user.id).toBe("user-1");
  });

  it("trusts is_anonymous only from the verified /auth/v1/user response", async () => {
    const guest = await fetchAuthUser(
      config,
      "access",
      jsonFetch(200, { id: "guest-1", is_anonymous: true }),
    );
    expect(guest).toEqual({ id: "guest-1", isAnonymous: true });

    const account = await fetchAuthUser(
      config,
      "access",
      jsonFetch(200, { id: "user-1", email: "u@example.com", is_anonymous: false }),
    );
    expect(account).toEqual({ id: "user-1", email: "u@example.com", isAnonymous: false });

    // Missing or malformed provider classification stays unclassified
    // (fail closed); it is never inferred from the absent email.
    const missing = await fetchAuthUser(config, "access", jsonFetch(200, { id: "user-2" }));
    expect(missing).toEqual({ id: "user-2" });
    expect(missing.isAnonymous).toBeUndefined();

    const malformed = await fetchAuthUser(
      config,
      "access",
      jsonFetch(200, { id: "user-3", is_anonymous: "false" }),
    );
    expect(malformed).toEqual({ id: "user-3" });
    expect(malformed.isAnonymous).toBeUndefined();
  });

  it("does not classify a password-grant session from its token response", async () => {
    const next = await signInWithPassword(
      config,
      "u@example.com",
      "password",
      jsonFetch(200, {
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        user: { id: "user-1", email: "u@example.com", is_anonymous: true },
      }),
    );
    expect(next.user).toEqual({ id: "user-1", email: "u@example.com" });
    expect(next.user.isAnonymous).toBeUndefined();
  });

  it("creates a guest session and classifies it only from /auth/v1/user", async () => {
    const calls: {
      path: string;
      method: string | undefined;
      body: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        path: new URL(String(url)).pathname,
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization: headers?.Authorization,
      });
      if (String(url).endsWith("/auth/v1/signup")) {
        return new Response(
          JSON.stringify({
            access_token: "guest-access",
            refresh_token: "guest-refresh",
            expires_in: 3600,
            // Token responses are not authoritative: this forged `false` must
            // be replaced by the verified `/user` classification.
            user: { id: "guest-1", is_anonymous: false },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "guest-1", is_anonymous: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const guest = await signInAnonymously(config, fetchImpl);
    expect(calls.map((call) => call.path)).toEqual(["/auth/v1/signup", "/auth/v1/user"]);
    expect(calls[0]).toMatchObject({ method: "POST", body: '{"data":{}}', authorization: undefined });
    expect(calls[1]?.authorization).toBe("Bearer guest-access");
    expect(guest.accessToken).toBe("guest-access");
    expect(guest.refreshToken).toBe("guest-refresh");
    expect(guest.user).toEqual({ id: "guest-1", isAnonymous: true });
  });

  it("supports the official CAPTCHA token body and exposes the unverified candidate", async () => {
    let signupBody: string | undefined;
    const candidates: SupabaseSession[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/auth/v1/signup")) {
        signupBody = typeof init?.body === "string" ? init.body : undefined;
        return new Response(
          JSON.stringify({
            access_token: "guest-candidate-access",
            refresh_token: "guest-candidate-refresh",
            expires_in: 3600,
            user: { id: "guest-candidate" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "overloaded" }), { status: 503 });
    }) as unknown as typeof fetch;

    const failed = await signInAnonymously(config, fetchImpl, {
      captchaToken: "captcha-token",
      onCandidate: (candidate) => candidates.push(candidate),
    }).catch((caught: unknown) => caught);
    expect(failed).toBeInstanceOf(AuthError);
    expect((failed as AuthError).code).toBe("AUTH_UNAVAILABLE");
    expect(JSON.parse(signupBody ?? "{}")).toEqual({
      data: {},
      gotrue_meta_security: { captcha_token: "captcha-token" },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.accessToken).toBe("guest-candidate-access");
    expect(candidates[0]?.refreshToken).toBe("guest-candidate-refresh");
  });

  it("keeps missing guest classification undefined and fails closed on verification errors", async () => {
    let step = 0;
    const fetchImpl = (async () => {
      step += 1;
      if (step === 1) {
        return new Response(
          JSON.stringify({
            access_token: "guest-access",
            refresh_token: "guest-refresh",
            user: { id: "guest-2", is_anonymous: true },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "guest-2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const guest = await signInAnonymously(config, fetchImpl);
    expect(guest.user).toEqual({ id: "guest-2" });
    expect(guest.user.isAnonymous).toBeUndefined();

    let verifyStep = 0;
    const expiredFetch = (async () => {
      verifyStep += 1;
      if (verifyStep === 1) {
        return new Response(
          JSON.stringify({ access_token: "a", refresh_token: "r", user: { id: "guest-3" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ msg: "invalid token" }), { status: 401 });
    }) as unknown as typeof fetch;

    const expired = await signInAnonymously(config, expiredFetch).catch((caught: unknown) => caught);
    expect(expired).toBeInstanceOf(AuthError);
    expect((expired as AuthError).code).toBe("SESSION_EXPIRED");
  });

  it("maps disabled and transient guest sign-in failures", async () => {
    const disabled = await signInAnonymously(
      config,
      jsonFetch(422, { msg: "Anonymous sign-ins are disabled" }),
    ).catch((caught: unknown) => caught);
    expect(disabled).toBeInstanceOf(AuthError);
    expect((disabled as AuthError).code).toBe("GUEST_SIGN_IN_FAILED");
    expect((disabled as AuthError).status).toBe(422);
    expect((disabled as Error).message).toContain("Anonymous sign-ins are disabled");

    for (const failing of [
      (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      jsonFetch(429, { message: "limited" }),
      jsonFetch(503, { message: "overloaded" }),
    ]) {
      const error = await signInAnonymously(config, failing).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("AUTH_UNAVAILABLE");
    }

    const invalid = await signInAnonymously(
      config,
      jsonFetch(200, { user: { id: "guest-4" } }),
    ).catch((caught: unknown) => caught);
    expect(invalid).toBeInstanceOf(AuthError);
    expect((invalid as AuthError).code).toBe("GUEST_SIGN_IN_FAILED");
  });

  it("never persists or restores anonymous classification from cached sessions", () => {
    const serialized = serializeSession({
      ...session(),
      user: { id: "user-1", email: "u@example.com", isAnonymous: false },
    });
    expect(serialized).not.toContain("isAnonymous");
    expect((JSON.parse(serialized) as { user: unknown }).user).toEqual({
      id: "user-1",
      email: "u@example.com",
    });

    // A tampered/legacy cache claiming an account classification is ignored
    // until the Auth server verifies the session.
    const restored = loadStoredSession(
      JSON.stringify({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: Date.now() + 3600_000,
        user: { id: "user-1", isAnonymous: false },
      }),
    );
    expect(restored?.user).toEqual({ id: "user-1" });
    expect(restored?.user.isAnonymous).toBeUndefined();
  });

  it("prefers the newest in-memory token when sessionStorage set fails", () => {
    window.sessionStorage.setItem(RECOVERY_TOKEN_KEY, "old-token");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    saveRecoveryToken("new-token");
    // The stale stored value must never win over the just-saved token.
    expect(loadRecoveryToken()).toBe("new-token");
  });

  it("recovers the in-memory token when sessionStorage get fails", () => {
    saveRecoveryToken("mem-token");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(loadRecoveryToken()).toBe("mem-token");
  });

  it("uses a tombstone so a failed remove cannot resurrect a cleared token", () => {
    saveRecoveryToken("used-token");
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBe("used-token");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    clearRecoveryToken();
    // The raw store still holds the stale value, but this page must not reuse it.
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBe("used-token");
    expect(loadRecoveryToken()).toBeNull();
  });

  it("explicit success clears the in-memory fallback", () => {
    saveRecoveryToken("done-token");
    clearRecoveryToken();
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBeNull();
    // With storage unreadable, a leftover memory copy would resurface here;
    // success must have cleared it.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(loadRecoveryToken()).toBeNull();
  });
});
