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
