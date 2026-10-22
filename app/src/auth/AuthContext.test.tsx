import { StrictMode, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.tsx";
import { Layout } from "../components/Layout.tsx";
import { AUTH_STORAGE_KEY, serializeSession } from "./supabaseAuth.ts";
import type { SupabaseSession } from "./supabaseAuth.ts";
import {
  GUEST_UPGRADE_STORAGE_KEY,
  loadPendingGuestUpgrade,
  resetPendingGuestUpgradeForTests,
  savePendingGuestUpgrade,
} from "./guestUpgrade.ts";

function sessionFor(id: string, email: string): SupabaseSession {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3600_000,
    user: { id, email },
  };
}

function deferredResponse(body: unknown, status = 200): {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
} {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  void body;
  void status;
  return { promise, resolve };
}

function Probe() {
  const { status, user, getAccessToken, signOutSession, refresh } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.id ?? "none"}</span>
      <span data-testid="token">{getAccessToken() ?? "none"}</span>
      <button type="button" onClick={() => void signOutSession()}>
        sign out
      </button>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
    </div>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("exposes the session token and clears everything on sign-out", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    render(
      <AuthProvider
        skipBootstrap
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
        initialSession={sessionFor("user-1", "a@example.com")}
      >
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("signed-in");
    expect(screen.getByTestId("token").textContent).toBe("access-user-1");
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:session")).toContain("user-1");

    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:session")).toBeNull();
  });

  it("switching accounts changes the credential identity (cache key)", async () => {
    const first = render(
      <MemoryRouter>
        <AuthProvider
          skipBootstrap
          publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
          initialSession={sessionFor("user-1", "a@example.com")}
        >
          <Probe />
        </AuthProvider>,
      </MemoryRouter>,
    );
    expect(first.getByTestId("user").textContent).toBe("user-1");
    first.unmount();

    const second = render(
      <MemoryRouter>
        <AuthProvider
          skipBootstrap
          publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
          initialSession={sessionFor("user-2", "b@example.com")}
        >
          <Probe />
        </AuthProvider>,
      </MemoryRouter>,
    );
    // A new account means a new token identity, so workout caches keyed by
    // user id (see App.tsx) are dropped instead of flashing old data.
    expect(second.getByTestId("token").textContent).toBe("access-user-2");
    expect(second.getByTestId("token").textContent).not.toContain("user-1");
  });

  it("keeps the loading gate until a restored session is validated", async () => {
    let resolveUser!: (value: Response) => void;
    const userCall = new Promise<Response>((res) => {
      resolveUser = res;
    });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("/auth/v1/user")) return userCall;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
        initialSession={sessionFor("user-1", "a@example.com")}
      >
        <Probe />
      </AuthProvider>,
    );
    // Restored session must not flash signed-in before getUser confirms it.
    expect(screen.getByTestId("status").textContent).toBe("loading");
    await act(async () => {
      resolveUser(new Response(JSON.stringify({ id: "user-1", email: "a@example.com" }), { status: 200 }));
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
  });

  it("reconciles the stored user with the verified getUser response", async () => {
    const fetchImpl = (async (url: unknown) =>
      String(url).includes("/auth/v1/user")
        ? new Response(JSON.stringify({ id: "user-1", email: "verified@example.com" }), { status: 200 })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch;
    function EmailProbe() {
      const { user, status } = useAuth();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="email">{user?.email ?? "none"}</span>
        </div>
      );
    }
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
        initialSession={sessionFor("user-1", "stale@example.com")}
      >
        <EmailProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
    expect(screen.getByTestId("email").textContent).toBe("verified@example.com");
  });

  it("does not authorize from a cached anonymous classification before verification", async () => {
    // A stale/tampered cache claims a formal account; the verified endpoint
    // says guest. Nothing may treat the cached `false` as trustworthy.
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: "access-user-1",
        refreshToken: "refresh-user-1",
        expiresAt: Date.now() + 3600_000,
        user: { id: "user-1", isAnonymous: false },
      }),
    );
    let resolveUser!: (value: Response) => void;
    const userCall = new Promise<Response>((res) => {
      resolveUser = res;
    });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("/auth/v1/user")) return userCall;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    function AnonProbe() {
      const { status, user } = useAuth();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="anon">{user?.isAnonymous === undefined ? "none" : String(user.isAnonymous)}</span>
        </div>
      );
    }
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
      >
        <AnonProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("loading");
    expect(screen.getByTestId("anon").textContent).toBe("none");

    await act(async () => {
      resolveUser(
        new Response(JSON.stringify({ id: "user-1", is_anonymous: true }), { status: 200 }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
    expect(screen.getByTestId("anon").textContent).toBe("true");
  });

  it("ignores a pending refresh after logout (generation guard) and shares inflight refreshes", async () => {
    let resolveRefresh!: (value: Response) => void;
    const refreshCall = new Promise<Response>((res) => {
      resolveRefresh = res;
    });
    let refreshCalls = 0;
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("grant_type=refresh_token")) {
        refreshCalls += 1;
        return refreshCall;
      }
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    // Expired session so validation goes through the refresh path.
    const expired: SupabaseSession = { ...sessionFor("user-1", "a@example.com"), expiresAt: Date.now() - 1000 };
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
        initialSession={expired}
      >
        <Probe />
      </AuthProvider>,
    );
    // Two concurrent refresh clicks share one network request.
    fireEvent.click(screen.getByText("refresh"));
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() => expect(refreshCalls).toBe(1));
    // Logout before the refresh resolves: the late success must be ignored.
    fireEvent.click(screen.getByText("sign out"));
    await act(async () => {
      resolveRefresh(
        new Response(
          JSON.stringify({
            access_token: "access-user-1-refreshed",
            refresh_token: "refresh-user-1-new",
            expires_in: 3600,
            user: { id: "user-1" },
          }),
          { status: 200 },
        ),
      );
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(screen.getByTestId("token").textContent).not.toContain("refreshed");
  });

  it("does not let account A's refresh replace account B state", async () => {
    let resolveRefresh!: (value: Response) => void;
    const refreshCall = new Promise<Response>((res) => {
      resolveRefresh = res;
    });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("grant_type=refresh_token")) return refreshCall;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const expiredA: SupabaseSession = { ...sessionFor("user-a", "a@example.com"), expiresAt: Date.now() - 1000 };
    function SwitchProbe() {
      const auth = useAuth();
      return (
        <div>
          <span data-testid="status">{auth.status}</span>
          <span data-testid="user">{auth.user?.id ?? "none"}</span>
          <button type="button" onClick={() => void auth.refresh()}>
            refresh
          </button>
        </div>
      );
    }
    const view = render(
      <AuthProvider
        skipBootstrap
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
        initialSession={expiredA}
      >
        <SwitchProbe />
      </AuthProvider>,
    );
    void deferredResponse(null);
    // Start A's refresh, then simulate an account switch by remounting with B.
    fireEvent.click(screen.getByText("refresh"));
    view.unmount();
    render(
      <AuthProvider
        skipBootstrap
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
        initialSession={sessionFor("user-b", "b@example.com")}
      >
        <SwitchProbe />
      </AuthProvider>,
    );
    await act(async () => {
      resolveRefresh(
        new Response(
          JSON.stringify({
            access_token: "access-user-a-late",
            refresh_token: "refresh-user-a-late",
            expires_in: 3600,
            user: { id: "user-a" },
          }),
          { status: 200 },
        ),
      );
    });
    expect(screen.getByTestId("user").textContent).toBe("user-b");
  });

  it("preserves the session on transient refresh failure with a retryable error", async () => {
    let failTransient = true;
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("grant_type=refresh_token")) {
        if (failTransient) return new Response(JSON.stringify({ message: "overloaded" }), { status: 503 });
        return new Response(
          JSON.stringify({
            access_token: "access-user-1-refreshed",
            refresh_token: "refresh-user-1-new",
            expires_in: 3600,
            user: { id: "user-1", email: "a@example.com" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    function RetryProbe() {
      const { status, getAccessToken, authError, refresh } = useAuth();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="token">{getAccessToken() ?? "none"}</span>
          <span data-testid="auth-error">{authError?.code ?? "none"}</span>
          <button type="button" onClick={() => void refresh()}>
            retry
          </button>
        </div>
      );
    }
    // Expired session so validation goes through the refresh path.
    const expired: SupabaseSession = { ...sessionFor("user-1", "a@example.com"), expiresAt: Date.now() - 1000 };
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={fetchImpl}
        initialSession={expired}
      >
        <RetryProbe />
      </AuthProvider>,
    );
    // Transient outage: the session survives with AUTH_UNAVAILABLE, no sign-out.
    await waitFor(() => expect(screen.getByTestId("auth-error").textContent).toBe("AUTH_UNAVAILABLE"));
    expect(screen.getByTestId("token").textContent).toBe("access-user-1");
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:session")).toContain("user-1");
    // Retry after recovery signs in with the refreshed session.
    failTransient = false;
    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
    expect(screen.getByTestId("token").textContent).toBe("access-user-1-refreshed");
  });

  it("fails closed (signed-out, session preserved) when public config fails with a stored session", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    render(
      <AuthProvider
        skipBootstrap={false}
        skipValidation={false}
        fetchImpl={fetchImpl}
        initialSession={sessionFor("user-1", "a@example.com")}
      >
        <Probe />
      </AuthProvider>,
    );
    // No forever-loading: without a config the session can never validate,
    // so the provider reports signed-out while keeping the stored session.
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:session")).toContain("user-1");
  });
});

const RECOVERY_CONFIG = { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" };

type RefreshStep = "transient-503" | "transient-network" | "ok" | "invalid";

interface CallRecord {
  at: number;
  kind: "getUser" | "refresh" | "signIn" | "other";
}

/** Scripted Auth fetch: getUser verifies, refresh follows the script per attempt. */
function makeRecoveryFetch(script: RefreshStep[], calls: CallRecord[]) {
  let refreshCount = 0;
  return (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/auth/v1/user") && (init?.method ?? "GET") === "GET") {
      calls.push({ at: Date.now(), kind: "getUser" });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const authorization = headers.authorization ?? headers.Authorization ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (token.startsWith("access-user-2")) {
        return new Response(JSON.stringify({ id: "user-2", email: "b@example.com" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "user-1", email: "a@example.com" }), { status: 200 });
    }
    if (target.includes("grant_type=refresh_token")) {
      refreshCount += 1;
      calls.push({ at: Date.now(), kind: "refresh" });
      const step = script[Math.min(refreshCount - 1, script.length - 1)] ?? "transient-503";
      if (step === "ok") {
        return new Response(
          JSON.stringify({
            access_token: `access-user-1-r${refreshCount}`,
            refresh_token: `refresh-user-1-r${refreshCount}`,
            expires_in: 3600,
            user: { id: "user-1", email: "a@example.com" },
          }),
          { status: 200 },
        );
      }
      if (step === "invalid") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      if (step === "transient-network") throw new TypeError("offline");
      return new Response(JSON.stringify({ message: "overloaded" }), { status: 503 });
    }
    if (target.includes("grant_type=password")) {
      calls.push({ at: Date.now(), kind: "signIn" });
      return new Response(
        JSON.stringify({
          access_token: "access-user-2-fresh",
          refresh_token: "refresh-user-2-fresh",
          expires_in: 3600,
          user: { id: "user-2", email: "b@example.com" },
        }),
        { status: 200 },
      );
    }
    calls.push({ at: Date.now(), kind: "other" });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function RetryProbe() {
  const { status, user, getAccessToken, authError, refresh, signOutSession, signIn } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.id ?? "none"}</span>
      <span data-testid="token">{getAccessToken() ?? "none"}</span>
      <span data-testid="auth-error">{authError?.code ?? "none"}</span>
      <button type="button" onClick={() => void refresh()}>
        retry
      </button>
      <button type="button" onClick={() => void signOutSession()}>
        sign out
      </button>
      <button type="button" onClick={() => void signIn("b@example.com", "pw-b-1234")}>
        sign in b
      </button>
    </div>
  );
}

/** Session expiring `inMs` from now so the proactive timer fires deterministically. */
function shortLivedSession(inMs: number): SupabaseSession {
  return { ...sessionFor("user-1", "a@example.com"), expiresAt: Date.now() + inMs };
}

function refreshTimes(calls: CallRecord[], t0: number): number[] {
  return calls.filter((call) => call.kind === "refresh").map((call) => call.at - t0);
}

describe("transient refresh recovery (fake timers)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderRecovering(script: RefreshStep[], expiresInMs = 65_000) {
    const calls: CallRecord[] = [];
    const t0 = Date.now();
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={RECOVERY_CONFIG}
        fetchImpl={makeRecoveryFetch(script, calls)}
        initialSession={shortLivedSession(expiresInMs)}
      >
        <RetryProbe />
      </AuthProvider>,
    );
    return { calls, t0 };
  }

  async function settle(): Promise<void> {
    await act(async () => {});
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
  }

  it("retries a transient timer refresh with backoff and recovers without losing the session", async () => {
    const { calls, t0 } = renderRecovering(["transient-503", "transient-503", "transient-503", "ok"]);
    await settle();
    expect(screen.getByTestId("status").textContent).toBe("signed-in");

    // Proactive refresh (5s out) hits the outage: session kept, retryable error.
    await advance(5_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000]);
    expect(screen.getByTestId("auth-error").textContent).toBe("AUTH_UNAVAILABLE");
    expect(screen.getByTestId("token").textContent).toBe("access-user-1");
    expect(screen.getByTestId("status").textContent).toBe("signed-in");

    // Backoff: +5s, +10s, then success on the +20s attempt.
    await advance(5_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000, 10_000]);
    await advance(10_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000, 10_000, 20_000]);
    await advance(20_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000, 10_000, 20_000, 40_000]);

    // Recovered: new token, error cleared, no further retries scheduled.
    expect(screen.getByTestId("token").textContent).toBe("access-user-1-r4");
    expect(screen.getByTestId("auth-error").textContent).toBe("none");
    expect(screen.getByTestId("status").textContent).toBe("signed-in");
    await advance(180_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000, 10_000, 20_000, 40_000]);
  });

  it("caps the retry interval at 60s under a sustained outage", async () => {
    const { calls, t0 } = renderRecovering(["transient-503"], 61_000);
    await settle();
    await advance(1_000);
    await advance(5_000);
    await advance(10_000);
    await advance(20_000);
    await advance(40_000);
    await advance(60_000);
    await advance(60_000);
    const times = refreshTimes(calls, t0);
    expect(times).toEqual([1_000, 6_000, 16_000, 36_000, 76_000, 136_000, 196_000]);
    expect(screen.getByTestId("token").textContent).toBe("access-user-1");
    expect(screen.getByTestId("status").textContent).toBe("signed-in");
  });

  it("shares one inflight refresh between the timer and a manual retry", async () => {
    let resolveRefresh!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let refreshCalls = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ id: "user-1", email: "a@example.com" }), { status: 200 });
      }
      if (target.includes("grant_type=refresh_token")) {
        refreshCalls += 1;
        return gate;
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={RECOVERY_CONFIG}
        fetchImpl={fetchImpl}
        initialSession={shortLivedSession(65_000)}
      >
        <RetryProbe />
      </AuthProvider>,
    );
    await settle();
    // Timer-triggered refresh is inflight; a manual retry joins it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    fireEvent.click(screen.getByText("retry"));
    await settle();
    expect(refreshCalls).toBe(1);
    await act(async () => {
      resolveRefresh(
        new Response(
          JSON.stringify({
            access_token: "access-user-1-r1",
            refresh_token: "refresh-user-1-r1",
            expires_in: 3600,
            user: { id: "user-1", email: "a@example.com" },
          }),
          { status: 200 },
        ),
      );
    });
    await settle();
    expect(screen.getByTestId("token").textContent).toBe("access-user-1-r1");
    expect(refreshCalls).toBe(1);
  });

  it("stops retrying after logout", async () => {
    const { calls, t0 } = renderRecovering(["transient-503"]);
    await settle();
    await advance(5_000);
    expect(screen.getByTestId("auth-error").textContent).toBe("AUTH_UNAVAILABLE");
    fireEvent.click(screen.getByText("sign out"));
    await settle();
    expect(screen.getByTestId("status").textContent).toBe("signed-out");
    await advance(120_000);
    // Only the initial timer attempt ever ran.
    expect(refreshTimes(calls, t0)).toEqual([5_000]);
  });

  it("stops retrying after unmount", async () => {
    const calls: CallRecord[] = [];
    const view = render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={RECOVERY_CONFIG}
        fetchImpl={makeRecoveryFetch(["transient-503"], calls)}
        initialSession={shortLivedSession(65_000)}
      >
        <RetryProbe />
      </AuthProvider>,
    );
    await settle();
    await advance(5_000);
    expect(calls.filter((call) => call.kind === "refresh")).toHaveLength(1);
    view.unmount();
    await advance(120_000);
    expect(calls.filter((call) => call.kind === "refresh")).toHaveLength(1);
  });

  it("never schedules retries after unmount when the inflight refresh fails late", async () => {
    let resolveRefresh!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let refreshCalls = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ id: "user-1", email: "a@example.com" }), { status: 200 });
      }
      if (target.includes("grant_type=refresh_token")) {
        refreshCalls += 1;
        return gate;
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const view = render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={RECOVERY_CONFIG}
        fetchImpl={fetchImpl}
        initialSession={shortLivedSession(65_000)}
      >
        <RetryProbe />
      </AuthProvider>,
    );
    await settle();
    // Proactive refresh is inflight; unmount before it settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(refreshCalls).toBe(1);
    view.unmount();
    // The late 503 must not schedule a retry loop in the background.
    await act(async () => {
      resolveRefresh(new Response(JSON.stringify({ message: "overloaded" }), { status: 503 }));
    });
    await settle();
    await advance(120_000);
    expect(refreshCalls).toBe(1);
  });

  it("still retries with backoff under StrictMode double effects", async () => {
    const calls: CallRecord[] = [];
    const t0 = Date.now();
    render(
      <StrictMode>
        <AuthProvider
          skipBootstrap
          skipValidation={false}
          publicConfig={RECOVERY_CONFIG}
          fetchImpl={makeRecoveryFetch(["transient-503", "ok"], calls)}
          initialSession={shortLivedSession(65_000)}
        >
          <RetryProbe />
        </AuthProvider>
      </StrictMode>,
    );
    await settle();
    expect(screen.getByTestId("status").textContent).toBe("signed-in");
    // The second mount's retry schedule must survive: transient failure
    // retries once on backoff and then recovers with a cleared error.
    await advance(5_000);
    expect(screen.getByTestId("auth-error").textContent).toBe("AUTH_UNAVAILABLE");
    await advance(5_000);
    expect(screen.getByTestId("token").textContent).toBe("access-user-1-r2");
    expect(screen.getByTestId("auth-error").textContent).toBe("none");
    expect(refreshTimes(calls, t0)).toEqual([5_000, 10_000]);
  });

  it("signs out without retrying when the refresh token is rejected", async () => {
    const { calls, t0 } = renderRecovering(["invalid"]);
    await settle();
    await advance(5_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000]);
    expect(screen.getByTestId("status").textContent).toBe("signed-out");
    expect(screen.getByTestId("token").textContent).toBe("none");
    await advance(120_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000]);
  });

  it("drops the old retry timer on account switch", async () => {
    const { calls, t0 } = renderRecovering(["transient-503"]);
    await settle();
    await advance(5_000);
    expect(refreshTimes(calls, t0)).toEqual([5_000]);
    fireEvent.click(screen.getByText("sign in b"));
    await settle();
    expect(screen.getByTestId("user").textContent).toBe("user-2");
    await advance(120_000);
    // No retry of account A's refresh ever ran after the switch.
    expect(refreshTimes(calls, t0)).toEqual([5_000]);
    expect(screen.getByTestId("user").textContent).toBe("user-2");
  });
});

describe("signed-in outage notice", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("shows a recoverable notice with manual retry while signed in", async () => {
    let fail = true;
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("grant_type=refresh_token")) {
        if (fail) return new Response(JSON.stringify({ message: "down" }), { status: 503 });
        return new Response(
          JSON.stringify({
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
            user: { id: "user-1", email: "a@example.com" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "user-1", email: "a@example.com", is_anonymous: false }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    function BreakProbe() {
      const { refresh, getAccessToken } = useAuth();
      return (
        <div>
          <span data-testid="token">{getAccessToken() ?? "none"}</span>
          <button type="button" onClick={() => void refresh()}>
            break refresh
          </button>
        </div>
      );
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          skipBootstrap
          publicConfig={RECOVERY_CONFIG}
          fetchImpl={fetchImpl}
          initialSession={sessionFor("user-1", "a@example.com")}
        >
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<BreakProbe />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("token").textContent).toBe("access-user-1");
    fireEvent.click(screen.getByText("break refresh"));
    expect(await screen.findByText(/temporarily unavailable/i)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    await waitFor(() => expect(screen.getByTestId("token").textContent).toBe("access-new"));
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
  });
});

function configJson(url = "http://127.0.0.1:54321"): Response {
  return new Response(
    JSON.stringify({ data: { supabaseUrl: url, supabasePublishableKey: "pub" } }),
    { status: 200 },
  );
}

function ConfigProbe() {
  const { status, user, publicConfig, configError, getAccessToken } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.id ?? "none"}</span>
      <span data-testid="token">{getAccessToken() ?? "none"}</span>
      <span data-testid="config">{publicConfig?.supabaseUrl ?? "none"}</span>
      <span data-testid="config-error">{configError?.message ?? "none"}</span>
    </div>
  );
}

function dispatchCrossTabSignOut(): void {
  window.dispatchEvent(
    new StorageEvent("storage", { key: AUTH_STORAGE_KEY, newValue: null }),
  );
}

describe("deferred public config bootstrap", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("completes bootstrap as signed-out when cross-tab sign-out races deferred config", async () => {
    let resolveConfig!: (value: Response) => void;
    let authUserCalls = 0;
    const gate = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return gate;
      if (String(url).includes("/auth/v1/user")) {
        authUserCalls += 1;
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider fetchImpl={fetchImpl} initialSession={null}>
        <ConfigProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("loading");
    // Cross-tab sign-out bumps the session generation while config is pending.
    dispatchCrossTabSignOut();
    await act(async () => {
      resolveConfig(configJson());
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.getByTestId("config").textContent).toBe("http://127.0.0.1:54321");
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(authUserCalls).toBe(0);
  });

  it("surfaces config failure after cross-tab sign-out instead of hanging in loading", async () => {
    let rejectConfig!: (reason: unknown) => void;
    const gate = new Promise<Response>((_resolve, reject) => {
      rejectConfig = reject;
    });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return gate;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider fetchImpl={fetchImpl} initialSession={null}>
        <ConfigProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("loading");
    dispatchCrossTabSignOut();
    await act(async () => {
      rejectConfig(new TypeError("offline"));
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.getByTestId("config-error").textContent).not.toBe("none");
  });

  it("does not resurrect a signed-out account or fetch protected resources when late config resolves", async () => {
    let resolveConfig!: (value: Response) => void;
    let authUserCalls = 0;
    const gate = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return gate;
      if (String(url).includes("/auth/v1/user")) {
        authUserCalls += 1;
        return new Response(JSON.stringify({ id: "user-1", email: "a@example.com" }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider
        fetchImpl={fetchImpl}
        skipValidation={false}
        initialSession={sessionFor("user-1", "a@example.com")}
      >
        <ConfigProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("loading");
    dispatchCrossTabSignOut();
    await act(async () => {
      resolveConfig(configJson());
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(authUserCalls).toBe(0);
  });

  it("ignores a stale config response after the effect is replaced", async () => {
    let resolveFirst!: (value: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchFirst = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return firstGate;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const fetchSecond = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return configJson("http://second.invalid");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const view = render(
      <AuthProvider fetchImpl={fetchFirst} initialSession={null}>
        <ConfigProbe />
      </AuthProvider>,
    );
    view.rerender(
      <AuthProvider fetchImpl={fetchSecond} initialSession={null}>
        <ConfigProbe />
      </AuthProvider>,
    );
    // The replaced (cancelled) request resolves late and must be dropped.
    await act(async () => {
      resolveFirst(configJson("http://stale.invalid"));
    });
    await waitFor(() => expect(screen.getByTestId("config").textContent).toBe("http://second.invalid"));
    expect(screen.getByTestId("status").textContent).toBe("signed-out");
  });

  it("ignores a config response after unmount", async () => {
    let resolveConfig!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return gate;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const view = render(
      <AuthProvider fetchImpl={fetchImpl} initialSession={null}>
        <ConfigProbe />
      </AuthProvider>,
    );
    view.unmount();
    // Must not throw or update state after unmount.
    await act(async () => {
      resolveConfig(configJson());
    });
  });

  it("completes bootstrap under StrictMode double effects", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return configJson();
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <StrictMode>
        <AuthProvider fetchImpl={fetchImpl} initialSession={null}>
          <ConfigProbe />
        </AuthProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.getByTestId("config").textContent).toBe("http://127.0.0.1:54321");
  });
});

function GuestProbe() {
  const {
    status,
    user,
    getAccessToken,
    authError,
    guestSignInEnabled,
    guestSignInCaptchaRequired,
    signInAsGuest,
    signIn,
  } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.id ?? "none"}</span>
      <span data-testid="token">{getAccessToken() ?? "none"}</span>
      <span data-testid="anon">
        {user?.isAnonymous === undefined ? "none" : String(user.isAnonymous)}
      </span>
      <span data-testid="guest-enabled">{String(guestSignInEnabled)}</span>
      <span data-testid="captcha-required">{String(guestSignInCaptchaRequired)}</span>
      <span data-testid="auth-error">{authError?.code ?? "none"}</span>
      <button type="button" onClick={() => void signInAsGuest().catch(() => undefined)}>
        continue as guest
      </button>
      <button type="button" onClick={() => void signIn("b@example.com", "pw-b-1234").catch(() => undefined)}>
        sign in account
      </button>
    </div>
  );
}

describe("guest sign-in", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  const guestConfig = { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub", guestSignInEnabled: true };

  it("shares one request across concurrent clicks and uses the verified classification", async () => {
    let signupCalls = 0;
    let userCalls = 0;
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/signup")) {
        signupCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: "access-guest-1",
            refresh_token: "refresh-guest-1",
            expires_in: 3600,
            user: { id: "guest-1" },
          }),
          { status: 200 },
        );
      }
      if (target.endsWith("/auth/v1/user")) {
        userCalls += 1;
        return new Response(JSON.stringify({ id: "guest-1", is_anonymous: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider
        skipBootstrap
        publicConfig={guestConfig}
        fetchImpl={fetchImpl}
        initialSession={null}
      >
        <GuestProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("continue as guest"));
    fireEvent.click(screen.getByText("continue as guest"));

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
    expect(signupCalls).toBe(1);
    expect(userCalls).toBe(1);
    expect(screen.getByTestId("user").textContent).toBe("guest-1");
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(screen.getByTestId("token").textContent).toBe("access-guest-1");
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toContain("guest-1");
  });

  it("fails closed before any network call when the deployment capability is off", async () => {
    let signupCalls = 0;
    const fetchImpl = (async () => {
      signupCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider
        skipBootstrap
        publicConfig={{ ...guestConfig, guestSignInEnabled: false }}
        fetchImpl={fetchImpl}
        initialSession={null}
      >
        <GuestProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("guest-enabled").textContent).toBe("false");
    fireEvent.click(screen.getByText("continue as guest"));
    await waitFor(() =>
      expect(screen.getByTestId("auth-error").textContent).toBe("GUEST_SIGN_IN_DISABLED"),
    );
    expect(signupCalls).toBe(0);
    expect(screen.getByTestId("status").textContent).toBe("signed-out");
  });

  it("fails closed without a CAPTCHA widget when the deployment requires CAPTCHA", async () => {
    let signupCalls = 0;
    const fetchImpl = (async () => {
      signupCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AuthProvider
        skipBootstrap
        publicConfig={{
          ...guestConfig,
          guestSignInCaptchaRequired: true,
        }}
        fetchImpl={fetchImpl}
        initialSession={null}
      >
        <GuestProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("captcha-required").textContent).toBe("true");
    expect(screen.getByTestId("guest-enabled").textContent).toBe("false");
    fireEvent.click(screen.getByText("continue as guest"));
    await waitFor(() =>
      expect(screen.getByTestId("auth-error").textContent).toBe("GUEST_SIGN_IN_DISABLED"),
    );
    expect(signupCalls).toBe(0);
  });

  it("keeps a valid guest on failed account login and replaces it only after verification", async () => {
    let acceptAccount = false;
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      if (target.includes("grant_type=password")) {
        if (!acceptAccount) {
          return new Response(JSON.stringify({ msg: "Invalid login credentials" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: "access-account-2",
            refresh_token: "refresh-account-2",
            expires_in: 3600,
            user: { id: "user-2", email: "b@example.com" },
          }),
          { status: 200 },
        );
      }
      if (target.endsWith("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "user-2", email: "b@example.com", is_anonymous: false }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const guestSession: SupabaseSession = {
      ...sessionFor("guest-1", ""),
      user: { id: "guest-1", isAnonymous: true },
    };
    render(
      <AuthProvider
        skipBootstrap
        publicConfig={guestConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <GuestProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("signed-in");

    fireEvent.click(screen.getByText("sign in account"));
    await waitFor(() => expect(screen.getByTestId("auth-error").textContent).toBe("SIGN_IN_FAILED"));
    // The failed account attempt must not sign out or clear the guest.
    expect(screen.getByTestId("status").textContent).toBe("signed-in");
    expect(screen.getByTestId("user").textContent).toBe("guest-1");
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(screen.getByTestId("token").textContent).toBe("access-guest-1");

    acceptAccount = true;
    fireEvent.click(screen.getByText("sign in account"));
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("user-2"));
    expect(screen.getByTestId("anon").textContent).toBe("false");
    expect(screen.getByTestId("token").textContent).toBe("access-account-2");
    expect(screen.getByTestId("auth-error").textContent).toBe("none");
  });

  it("retains an unverified guest candidate and retries verification without another POST", async () => {
    let signupCalls = 0;
    let verifyCalls = 0;
    let verifyStatus = 503;
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/signup")) {
        signupCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: "access-guest-candidate",
            refresh_token: "refresh-guest-candidate",
            expires_in: 3600,
            user: { id: "guest-candidate" },
          }),
          { status: 200 },
        );
      }
      if (target.endsWith("/auth/v1/user")) {
        verifyCalls += 1;
        if (verifyStatus >= 500) {
          return new Response(JSON.stringify({ message: "overloaded" }), { status: verifyStatus });
        }
        return new Response(
          JSON.stringify({ id: "guest-candidate", is_anonymous: true }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const view = render(
      <AuthProvider
        skipBootstrap
        publicConfig={guestConfig}
        fetchImpl={fetchImpl}
        initialSession={null}
      >
        <GuestProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("continue as guest"));
    await waitFor(() =>
      expect(screen.getByTestId("auth-error").textContent).toBe("AUTH_UNAVAILABLE"),
    );
    expect(signupCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(screen.getByTestId("status").textContent).toBe("signed-out");
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:guest-candidate")).toContain(
      "access-guest-candidate",
    );

    // Same mount retry: verification only, never a second anonymous user.
    verifyStatus = 200;
    fireEvent.click(screen.getByText("continue as guest"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
    expect(signupCalls).toBe(1);
    expect(verifyCalls).toBe(2);
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:guest-candidate")).toBeNull();

    // A reload restores the verified session, not the candidate.
    view.unmount();
    render(
      <AuthProvider skipBootstrap publicConfig={guestConfig} fetchImpl={fetchImpl}>
        <GuestProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("guest-candidate"));
    expect(signupCalls).toBe(1);
  });

  it("retries a stored candidate after reload without creating another guest", async () => {
    let signupCalls = 0;
    let verifyStatus = 503;
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/signup")) {
        signupCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: "access-guest-reload",
            refresh_token: "refresh-guest-reload",
            expires_in: 3600,
            user: { id: "guest-reload" },
          }),
          { status: 200 },
        );
      }
      if (target.endsWith("/auth/v1/user")) {
        if (verifyStatus >= 500) {
          return new Response(JSON.stringify({ message: "overloaded" }), { status: verifyStatus });
        }
        return new Response(
          JSON.stringify({ id: "guest-reload", is_anonymous: true }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const first = render(
      <AuthProvider
        skipBootstrap
        publicConfig={guestConfig}
        fetchImpl={fetchImpl}
        initialSession={null}
      >
        <GuestProbe />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("continue as guest"));
    await waitFor(() =>
      expect(screen.getByTestId("auth-error").textContent).toBe("AUTH_UNAVAILABLE"),
    );
    expect(signupCalls).toBe(1);
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:guest-candidate")).not.toBeNull();
    first.unmount();

    // Reload: the candidate is restored as an unvalidated session and the
    // normal bootstrap verifies it; no signup endpoint is touched again.
    verifyStatus = 200;
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={guestConfig}
        fetchImpl={fetchImpl}
      >
        <GuestProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
    expect(screen.getByTestId("user").textContent).toBe("guest-reload");
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(signupCalls).toBe(1);
    expect(window.localStorage.getItem("agent-fit-trace:auth:v1:guest-candidate")).toBeNull();
  });

  it("never replaces an existing verified account with a direct guest call", async () => {
    let signupCalls = 0;
    const fetchImpl = (async () => {
      signupCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const account: SupabaseSession = {
      ...sessionFor("user-existing", "existing@example.com"),
      user: { id: "user-existing", email: "existing@example.com", isAnonymous: false },
    };
    render(
      <AuthProvider
        skipBootstrap
        publicConfig={guestConfig}
        fetchImpl={fetchImpl}
        initialSession={account}
      >
        <GuestProbe />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("continue as guest"));
    await waitFor(() => expect(signupCalls).toBe(0));
    expect(screen.getByTestId("user").textContent).toBe("user-existing");
    expect(screen.getByTestId("anon").textContent).toBe("false");
    expect(screen.getByTestId("token").textContent).toBe("access-user-existing");
  });

  it("validates a cross-tab identity replacement instead of trusting its cached classification", async () => {
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/user")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const authorization = headers.authorization ?? headers.Authorization ?? "";
        const tokenName = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (tokenName === "access-guest-a") {
          return new Response(JSON.stringify({ id: "guest-a", is_anonymous: true }), { status: 200 });
        }
        if (tokenName === "access-user-b") {
          return new Response(
            JSON.stringify({ id: "user-b", email: "b@example.com", is_anonymous: false }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ msg: "bad token" }), { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const guestA: SupabaseSession = {
      ...sessionFor("guest-a", ""),
      accessToken: "access-guest-a",
      user: { id: "guest-a", isAnonymous: true },
    };
    render(
      <AuthProvider
        skipBootstrap
        skipValidation={false}
        publicConfig={guestConfig}
        fetchImpl={fetchImpl}
        initialSession={guestA}
      >
        <GuestProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
    expect(screen.getByTestId("anon").textContent).toBe("true");

    const userB: SupabaseSession = {
      accessToken: "access-user-b",
      refreshToken: "refresh-user-b",
      expiresAt: Date.now() + 3600_000,
      // Deliberately cached as an account; only verified data may release the gate.
      user: { id: "user-b", email: "b@example.com", isAnonymous: false },
    };
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_STORAGE_KEY,
          newValue: serializeSession(userB),
        }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("user-b"));
    expect(screen.getByTestId("status").textContent).toBe("signed-in");
    expect(screen.getByTestId("anon").textContent).toBe("false");
    expect(screen.getByTestId("token").textContent).toBe("access-user-b");
  });
});

function UpgradeProbe() {
  const {
    status,
    user,
    getAccessToken,
    authError,
    guestUpgradeEnabled,
    pendingGuestUpgrade,
    beginGuestUpgrade,
    completeGuestUpgrade,
    refreshVerifiedUser,
    finishGuestUpgrade,
    signIn,
    signOutSession,
  } = useAuth();
  const [lastError, setLastError] = useState("none");
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.id ?? "none"}</span>
      <span data-testid="anon">
        {user?.isAnonymous === undefined ? "none" : String(user.isAnonymous)}
      </span>
      <span data-testid="token">{getAccessToken() ?? "none"}</span>
      <span data-testid="upgrade-enabled">{String(guestUpgradeEnabled)}</span>
      <span data-testid="pending-email">{pendingGuestUpgrade?.email ?? "none"}</span>
      <span data-testid="pending-verified">{String(pendingGuestUpgrade?.verified ?? false)}</span>
      <span data-testid="auth-error">{authError?.code ?? "none"}</span>
      <span data-testid="last-error">{lastError}</span>
      <button
        type="button"
        onClick={() =>
          void beginGuestUpgrade(" Invite@Example.com ").catch((caught: unknown) =>
            setLastError(caught instanceof Error && "code" in caught ? String(caught.code) : "error"),
          )
        }
      >
        begin upgrade
      </button>
      <button
        type="button"
        onClick={() =>
          void beginGuestUpgrade(" Invite@Example.com ", { resend: true }).catch((caught: unknown) =>
            setLastError(caught instanceof Error && "code" in caught ? String(caught.code) : "error"),
          )
        }
      >
        resend upgrade
      </button>
      <button
        type="button"
        onClick={() =>
          void beginGuestUpgrade("alternate@example.com").catch((caught: unknown) =>
            setLastError(caught instanceof Error && "code" in caught ? String(caught.code) : "error"),
          )
        }
      >
        begin alternate
      </button>
      <button
        type="button"
        onClick={() =>
          void refreshVerifiedUser().then(
            (verified) => setLastError(verified === null ? "refresh-null" : "refresh-ok"),
            (caught: unknown) =>
              setLastError(caught instanceof Error && "code" in caught ? String(caught.code) : "error"),
          )
        }
      >
        refresh user
      </button>
      <button
        type="button"
        onClick={() =>
          void finishGuestUpgrade("guest-1").then(
            (finished) => setLastError(finished ? "finished" : "finish-false"),
            (caught: unknown) =>
              setLastError(caught instanceof Error && "code" in caught ? String(caught.code) : "error"),
          )
        }
      >
        finish upgrade
      </button>
      <button
        type="button"
        onClick={() =>
          void signIn("b@example.com", "password").catch((caught: unknown) =>
            setLastError(caught instanceof Error && "code" in caught ? String(caught.code) : "error"),
          )
        }
      >
        sign in B
      </button>
      <button
        type="button"
        onClick={() =>
          void completeGuestUpgrade({
            accessToken: "callback-access",
            refreshToken: "callback-refresh",
            type: "email_change",
            expiresAt: Date.now() + 3600_000,
          }).catch((caught: unknown) =>
            setLastError(caught instanceof Error && "code" in caught ? String(caught.code) : "error"),
          )
        }
      >
        complete upgrade
      </button>
      <button type="button" onClick={() => void signOutSession()}>
        sign out
      </button>
    </div>
  );
}

describe("invited guest upgrade", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetPendingGuestUpgradeForTests();
  });

  const upgradeConfig = {
    supabaseUrl: "http://127.0.0.1:54321",
    supabasePublishableKey: "pub",
    guestUpgradeEnabled: true,
  };

  const guestSession: SupabaseSession = {
    accessToken: "access-guest-1",
    refreshToken: "refresh-guest-1",
    expiresAt: Date.now() + 3600_000,
    user: { id: "guest-1", isAnonymous: true },
  };

  it("uses tab storage as the source of truth across provider lifecycles", () => {
    savePendingGuestUpgrade({
      userId: "guest-1",
      email: " Invite@Example.com ",
      verified: false,
      startedAt: 1,
    });
    expect(loadPendingGuestUpgrade()).toEqual({
      userId: "guest-1",
      email: "invite@example.com",
      verified: false,
      startedAt: 1,
    });

    // A fresh provider lifecycle sees the persisted tab value, not stale
    // module memory: a newer storage write wins...
    window.sessionStorage.setItem(
      GUEST_UPGRADE_STORAGE_KEY,
      JSON.stringify({
        userId: "guest-1",
        email: "newer@example.com",
        verified: false,
        startedAt: 2,
      }),
    );
    expect(loadPendingGuestUpgrade()?.email).toBe("newer@example.com");
    // ...and clearing real storage clears the visible state.
    window.sessionStorage.clear();
    expect(loadPendingGuestUpgrade()).toBeNull();
  });

  it("requests the invite once, stays pending, then applies only the verified same UID", async () => {
    let updateCalls = 0;
    let verifiedCalls = 0;
    let updateUrl = "";
    let updateBody: unknown = null;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && init?.method === "PUT") {
        updateCalls += 1;
        updateUrl = target;
        updateBody = JSON.parse(String(init.body)) as unknown;
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/auth/v1/user")) {
        verifiedCalls += 1;
        return new Response(
          JSON.stringify({
            id: "guest-1",
            email: "invite@example.com",
            is_anonymous: false,
            email_confirmed_at: "2026-10-17T00:00:00Z",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    expect(screen.getByTestId("upgrade-enabled").textContent).toBe("true");
    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() => expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com"));
    expect(updateCalls).toBe(1);
    expect(verifiedCalls).toBe(0);
    expect(updateUrl).toContain("redirect_to=");
    expect(updateBody).toEqual({ email: "invite@example.com" });
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");
    // Still a guest: no false success while the email is pending.
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(window.sessionStorage.getItem(GUEST_UPGRADE_STORAGE_KEY)).toContain("invite@example.com");

    // Same pending target is idempotent: no second email request.
    fireEvent.click(screen.getByText("begin upgrade"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateCalls).toBe(1);

    fireEvent.click(screen.getByText("complete upgrade"));
    await waitFor(() => expect(screen.getByTestId("pending-verified").textContent).toBe("true"));
    expect(verifiedCalls).toBe(1);
    expect(screen.getByTestId("user").textContent).toBe("guest-1");
    expect(screen.getByTestId("anon").textContent).toBe("false");
    expect(screen.getByTestId("token").textContent).toBe("callback-access");
  });

  it("keeps a pending upgrade when another tab only refreshes the same guest token", async () => {
    savePendingGuestUpgrade({
      userId: "guest-1",
      email: "invite@example.com",
      verified: false,
      startedAt: 1,
    });
    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com");

    const refreshed: SupabaseSession = {
      ...guestSession,
      accessToken: "access-guest-1-refreshed",
      refreshToken: "refresh-guest-1-refreshed",
    };
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_STORAGE_KEY,
          newValue: serializeSession(refreshed),
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("token").textContent).toBe("access-guest-1-refreshed"),
    );
    // Same UID: the token changed, but the pending verification marker is not
    // an account switch and must survive for the password-setup step.
    expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com");
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");
    expect(window.sessionStorage.getItem(GUEST_UPGRADE_STORAGE_KEY)).toContain(
      "invite@example.com",
    );
  });

  it("promotes the pending upgrade when a restored same-UID session is already verified", async () => {
    savePendingGuestUpgrade({
      userId: "guest-1",
      email: "invite@example.com",
      verified: false,
      startedAt: 1,
    });
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "guest-1",
            email: "invite@example.com",
            is_anonymous: false,
            email_confirmed_at: "2026-10-17T00:00:00Z",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap={false}
        skipValidation={false}
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("anon").textContent).toBe("false"));
    // Verification happened in another tab (or a token refresh applied it):
    // the restored session must promote the marker, not hide the setup path.
    await waitFor(() => expect(screen.getByTestId("pending-verified").textContent).toBe("true"));
    expect(window.sessionStorage.getItem(GUEST_UPGRADE_STORAGE_KEY)).toContain('"verified":true');
  });

  it("rejects a wrong-UID callback without replacing the current guest", async () => {
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && init?.method === "PUT") {
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "other-user",
            email: "invite@example.com",
            is_anonymous: false,
            email_confirmed_at: "2026-10-17T00:00:00Z",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() => expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com"));
    fireEvent.click(screen.getByText("complete upgrade"));
    await waitFor(() =>
      expect(screen.getByTestId("last-error").textContent).toBe("GUEST_UPGRADE_IDENTITY_MISMATCH"),
    );
    expect(screen.getByTestId("user").textContent).toBe("guest-1");
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(screen.getByTestId("token").textContent).toBe("access-guest-1");
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");
  });

  it("does not report success when the same UID is still anonymous", async () => {
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && init?.method === "PUT") {
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "guest-1",
            email: "invite@example.com",
            is_anonymous: true,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() => expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com"));
    fireEvent.click(screen.getByText("complete upgrade"));
    await waitFor(() =>
      expect(screen.getByTestId("last-error").textContent).toBe("GUEST_UPGRADE_NOT_READY"),
    );
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");
  });

  it("fails closed before a request when upgrade readiness is off and clears on sign-out", async () => {
    let updateCalls = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/auth/v1/user") && init?.method === "PUT") updateCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const view = render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={{ ...upgradeConfig, guestUpgradeEnabled: false }}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("upgrade-enabled").textContent).toBe("false");
    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() =>
      expect(screen.getByTestId("auth-error").textContent).toBe("GUEST_UPGRADE_DISABLED"),
    );
    expect(updateCalls).toBe(0);
    view.unmount();

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() => expect(window.sessionStorage.getItem(GUEST_UPGRADE_STORAGE_KEY)).not.toBeNull());
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(window.sessionStorage.getItem(GUEST_UPGRADE_STORAGE_KEY)).toBeNull());
  });

  it("resends only on explicit request; a failed resend keeps the pending marker", async () => {
    let updateCalls = 0;
    let failResend = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/auth/v1/user") && init?.method === "PUT") {
        updateCalls += 1;
        if (failResend) {
          return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
        }
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() =>
      expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com"),
    );
    expect(updateCalls).toBe(1);
    await act(async () => {
      await Promise.resolve();
    });

    // Repeating the normal action remains idempotent.
    fireEvent.click(screen.getByText("begin upgrade"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateCalls).toBe(1);

    // Only the explicit resend sends a second PUT.
    fireEvent.click(screen.getByText("resend upgrade"));
    await waitFor(() => expect(updateCalls).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com");
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");

    // A rate/transient failure is surfaced but does not drop the pending link
    // state or turn the guest into an account.
    failResend = true;
    fireEvent.click(screen.getByText("resend upgrade"));
    await waitFor(() => expect(screen.getByTestId("last-error").textContent).toBe("AUTH_UNAVAILABLE"));
    expect(updateCalls).toBe(3);
    expect(screen.getByTestId("auth-error").textContent).toBe("AUTH_UNAVAILABLE");
    expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com");
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(window.sessionStorage.getItem(GUEST_UPGRADE_STORAGE_KEY)).toContain("invite@example.com");
  });

  it("resumes external verification by promotion, and a wrong-UID refresh preserves G", async () => {
    let externallyVerified = false;
    let fetchedId = "guest-1";
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && init?.method === "PUT") {
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/auth/v1/user")) {
        const id = fetchedId;
        return new Response(
          JSON.stringify({
            id,
            email: "invite@example.com",
            is_anonymous: externallyVerified ? false : true,
            ...(externallyVerified
              ? { email_confirmed_at: "2026-10-17T00:00:00Z" }
              : {}),
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const firstView = render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() => expect(screen.getByTestId("pending-verified").textContent).toBe("false"));
    // The email was verified in another tab: the original tab still has the
    // guest session and pending marker, but no completion has been claimed.
    externallyVerified = true;
    fireEvent.click(screen.getByText("refresh user"));
    await waitFor(() => expect(screen.getByTestId("pending-verified").textContent).toBe("true"));
    expect(screen.getByTestId("user").textContent).toBe("guest-1");
    expect(screen.getByTestId("anon").textContent).toBe("false");
    expect(screen.getByTestId("last-error").textContent).toBe("refresh-ok");
    firstView.unmount();

    // A refresh that returns a different UUID is rejected before apply.
    resetPendingGuestUpgradeForTests();
    window.sessionStorage.clear();
    externallyVerified = false;
    // Reset to a fresh provider shape for the wrong-UID part.
    const secondView = render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() =>
      expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com"),
    );
    fetchedId = "other-user";
    fireEvent.click(screen.getByText("refresh user"));
    await waitFor(() => expect(screen.getByTestId("last-error").textContent).toBe("refresh-null"));
    expect(screen.getByTestId("user").textContent).toBe("guest-1");
    expect(screen.getByTestId("anon").textContent).toBe("true");
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");
    secondView.unmount();
  });

  it("ignores a stale initiation failure after B signs in (no B authError)", async () => {
    let resolvePut!: (response: Response) => void;
    const pendingPut = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && init?.method === "PUT") return pendingPut;
      if (target.includes("/auth/v1/token?grant_type=password")) {
        return new Response(
          JSON.stringify({
            access_token: "access-user-b",
            refresh_token: "refresh-user-b",
            expires_in: 3600,
            user: { id: "user-b", email: "b@example.com" },
          }),
          { status: 200 },
        );
      }
      if (target.endsWith("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "user-b", email: "b@example.com", is_anonymous: false }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={{ ...upgradeConfig, guestSignInEnabled: true }}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("begin upgrade"));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("sign in B"));
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("user-b"));
    resolvePut(new Response("{}", { status: 200 }));
    await waitFor(() =>
      expect(screen.getByTestId("last-error").textContent).toBe("GUEST_UPGRADE_SUPERSEDED"),
    );
    expect(screen.getByTestId("auth-error").textContent).toBe("none");
    expect(screen.getByTestId("user").textContent).toBe("user-b");
    expect(screen.getByTestId("pending-email").textContent).toBe("none");
  });

  it("serializes initiation and rejects a different target while in flight", async () => {
    let resolvePut!: (response: Response) => void;
    const pendingPut = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });
    let markPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    let putCount = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/auth/v1/user") && init?.method === "PUT") {
        putCount += 1;
        markPutStarted();
        return pendingPut;
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("begin upgrade"));
    await act(async () => {
      await putStarted;
    });
    // The identical request shares the in-flight mutation...
    fireEvent.click(screen.getByText("begin upgrade"));
    // ...while a different target is rejected before a second PUT can race the
    // server's email_change value.
    fireEvent.click(screen.getByText("begin alternate"));
    await waitFor(() =>
      expect(screen.getByTestId("last-error").textContent).toBe("GUEST_UPGRADE_IN_FLIGHT"),
    );
    expect(putCount).toBe(1);
    expect(screen.getByTestId("auth-error").textContent).toBe("none");

    resolvePut(new Response("{}", { status: 200 }));
    await waitFor(() =>
      expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com"),
    );
    expect(putCount).toBe(1);
    expect(screen.getByTestId("pending-verified").textContent).toBe("false");
  });

  it("finishes only after a same-UID reverify and keeps pending on mismatch", async () => {
    let fetchedId = "guest-1";
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && init?.method === "PUT") {
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: fetchedId,
            email: "invite@example.com",
            is_anonymous: false,
            email_confirmed_at: "2026-10-17T00:00:00Z",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={upgradeConfig}
        fetchImpl={fetchImpl}
        initialSession={guestSession}
      >
        <UpgradeProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByText("begin upgrade"));
    await waitFor(() =>
      expect(screen.getByTestId("pending-email").textContent).toBe("invite@example.com"),
    );
    fireEvent.click(screen.getByText("complete upgrade"));
    await waitFor(() => expect(screen.getByTestId("pending-verified").textContent).toBe("true"));

    fetchedId = "other-user";
    fireEvent.click(screen.getByText("finish upgrade"));
    await waitFor(() => expect(screen.getByTestId("last-error").textContent).toBe("finish-false"));
    expect(screen.getByTestId("pending-verified").textContent).toBe("true");

    fetchedId = "guest-1";
    fireEvent.click(screen.getByText("finish upgrade"));
    await waitFor(() => expect(screen.getByTestId("last-error").textContent).toBe("finished"));
    expect(screen.getByTestId("pending-email").textContent).toBe("none");
    expect(screen.getByTestId("user").textContent).toBe("guest-1");
    expect(screen.getByTestId("anon").textContent).toBe("false");
  });
});
