import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.tsx";
import type { SupabaseSession } from "./supabaseAuth.ts";

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
    expect(window.localStorage.getItem("pi-fit-trace:auth:v1:session")).toContain("user-1");

    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(window.localStorage.getItem("pi-fit-trace:auth:v1:session")).toBeNull();
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
    expect(window.localStorage.getItem("pi-fit-trace:auth:v1:session")).toContain("user-1");
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
    expect(window.localStorage.getItem("pi-fit-trace:auth:v1:session")).toContain("user-1");
  });
});
