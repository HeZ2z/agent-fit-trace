import { StrictMode } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import App from "./App.tsx";
import { AUTH_STORAGE_KEY, resetRecoveryTokenMemoryForTests, serializeSession } from "./auth/supabaseAuth.ts";
import type { SupabaseSession } from "./auth/supabaseAuth.ts";

const AUTH_BASE = "http://auth.invalid";

function storedSession(userId: string, email: string, token: string): SupabaseSession {
  return {
    accessToken: token,
    refreshToken: `refresh-${userId}`,
    expiresAt: Date.now() + 3600_000,
    user: { id: userId, email },
  };
}

function workout(id: string, date: string): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    id,
    date,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
  }).record;
}

interface MockState {
  publicConfigOk: boolean;
  /** Deferred gate for GET /auth/v1/user (null = respond immediately). */
  userGate: (() => Promise<unknown>) | null;
  usersByToken: Map<string, { id: string; email: string }>;
  usersByEmail: Map<string, { id: string; password: string }>;
  workoutsByUser: Map<string, WorkoutRecord[]>;
  apiCalls: { url: string; method: string; authorization: string | null }[];
  /** Password updates via PUT /auth/v1/user (recovery handoff). */
  passwordUpdates: { authorization: string | null; body: string }[];
  authUserCalls: number;
  refreshCalls: number;
  /** When true the refresh_token grant fails transiently (503). */
  refreshTransient: boolean;
}

function makeState(): MockState {
  return {
    publicConfigOk: true,
    userGate: null,
    usersByToken: new Map(),
    usersByEmail: new Map([
      ["a@example.com", { id: "user-a", password: "pw-a-1234" }],
      ["b@example.com", { id: "user-b", password: "pw-b-1234" }],
    ]),
    workoutsByUser: new Map([
      ["user-a", [workout("w-a", "2026-09-01")]],
      ["user-b", [workout("w-b", "2026-10-02")]],
    ]),
    apiCalls: [],
    passwordUpdates: [],
    authUserCalls: 0,
    refreshCalls: 0,
    refreshTransient: false,
  };
}

function installFetch(state: MockState): void {
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const authorization =
        headers.authorization ?? headers.Authorization ?? null;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;

      if (url.endsWith("/api/v1/public-config")) {
        if (!state.publicConfigOk) {
          return new Response(JSON.stringify({ error: { code: "API_ERROR", message: "Down." } }), {
            status: 500,
          });
        }
        return new Response(
          JSON.stringify({
            data: { supabaseUrl: AUTH_BASE, supabasePublishableKey: "pub" },
          }),
          { status: 200 },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/token?grant_type=password`) {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        const account = state.usersByEmail.get(body.email);
        if (account === undefined || account.password !== body.password) {
          return new Response(JSON.stringify({ msg: "Invalid login credentials" }), { status: 400 });
        }
        const accessToken = `access-${account.id}-${Date.now()}`;
        state.usersByToken.set(accessToken, { id: account.id, email: body.email });
        return new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: `refresh-${account.id}`,
            expires_in: 3600,
            user: { id: account.id, email: body.email },
          }),
          { status: 200 },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/token?grant_type=refresh_token`) {
        state.refreshCalls += 1;
        if (state.refreshTransient) {
          return new Response(JSON.stringify({ message: "overloaded" }), { status: 503 });
        }
        const accessToken = `access-refreshed-${state.refreshCalls}`;
        state.usersByToken.set(accessToken, { id: "user-a", email: "a@example.com" });
        return new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: "refresh-user-a-new",
            expires_in: 3600,
            user: { id: "user-a", email: "a@example.com" },
          }),
          { status: 200 },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/user`) {
        state.authUserCalls += 1;
        if (state.userGate !== null) await state.userGate();
        if ((init?.method ?? "GET") === "PUT") {
          const handoff = token ?? "";
          state.passwordUpdates.push({
            authorization,
            body: String(init?.body ?? ""),
          });
          if (handoff === "" || handoff === "bad-token") {
            return new Response(JSON.stringify({ msg: "bad token" }), { status: 401 });
          }
          return new Response(JSON.stringify({ id: `user-for-${handoff}` }), { status: 200 });
        }
        const principal = token === null ? undefined : state.usersByToken.get(token);
        if (principal === undefined) {
          return new Response(JSON.stringify({ msg: "bad token" }), { status: 401 });
        }
        return new Response(JSON.stringify(principal), { status: 200 });
      }

      if (url === `${AUTH_BASE}/auth/v1/logout`) {
        return new Response("{}", { status: 200 });
      }

      if (url.startsWith("/api/v1/")) {
        state.apiCalls.push({ url, method: init?.method ?? "GET", authorization });
        const principal = token === null ? undefined : state.usersByToken.get(token);
        if (principal === undefined) {
          return new Response(
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } }),
            { status: 401 },
          );
        }
        if (url === "/api/v1/workouts" && (init?.method ?? "GET") === "GET") {
          return new Response(
            JSON.stringify({ data: state.workoutsByUser.get(principal.id) ?? [] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ error: { code: "API_ERROR", message: "No route." } }),
          { status: 500 },
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch,
  );
}

describe("App auth integration (HTTP mode)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
  });

  afterEach(() => {
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("issues no protected fetch before a restored session is validated", async () => {
    const state = makeState();
    state.usersByToken.set("access-user-a", { id: "user-a", email: "a@example.com" });
    let releaseGate!: () => void;
    state.userGate = () => new Promise<unknown>((resolve) => { releaseGate = resolve as () => void; });
    installFetch(state);
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      serializeSession(storedSession("user-a", "a@example.com", "access-user-a")),
    );

    render(<App />);

    // Validation is stuck at the gate: still loading, and no workout read dispatched.
    await waitFor(() => expect(state.authUserCalls).toBe(1));
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(state.apiCalls).toHaveLength(0);

    releaseGate();
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();
    expect(state.apiCalls).toHaveLength(1);
    expect(state.apiCalls[0]?.authorization).toBe("Bearer access-user-a");
  });

  it("logs in, shows only that account's data, and clears everything on logout", async () => {
    const state = makeState();
    installFetch(state);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    // Only account A's workout is listed, fetched with A's fresh token.
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-10-02/)).not.toBeInTheDocument();
    const token = state.apiCalls[0]?.authorization;
    expect(token).toMatch(/^Bearer access-user-a-/);

    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    // No protected content and no stored token linger after logout.
    expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("switching accounts never flashes the previous account's data", async () => {
    const state = makeState();
    installFetch(state);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "b@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-b-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/2026-10-02/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
  });

  it("fails closed with a login-unavailable gate when public config fails", async () => {
    const state = makeState();
    state.publicConfigOk = false;
    installFetch(state);
    render(<App />);

    expect(await screen.findByRole("heading", { name: /login is unavailable/i })).toBeInTheDocument();
    expect(state.apiCalls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  it("routes a default root invite hash to password setup with a usable handoff", async () => {
    const state = makeState();
    installFetch(state);
    window.history.pushState(
      {},
      "",
      "/#access_token=invite-token&refresh_token=r&type=invite",
    );
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem("agent-fit-trace:auth:v1:recovery-token")).toBe("invite-token");

    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    // The handoff used the invite hash's access token with the new password…
    expect(state.passwordUpdates).toHaveLength(1);
    expect(state.passwordUpdates[0]?.authorization).toBe("Bearer invite-token");
    expect(JSON.parse(state.passwordUpdates[0]?.body ?? "{}")).toEqual({
      password: "new-password-1",
    });
    // …and the callback flow never issued a workout write.
    expect(
      state.apiCalls.filter(
        (call) =>
          call.url.includes("workout") &&
          (call.method === "POST" || call.method === "PUT" || call.method === "PATCH"),
      ),
    ).toHaveLength(0);
  });

  it("routes a root invite hash to password setup under StrictMode without an expired-link error", async () => {
    const state = makeState();
    installFetch(state);
    window.history.pushState(
      {},
      "",
      "/#access_token=strict-invite-token&refresh_token=r&type=invite",
    );
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // The repeated effect must not report the just-consumed link as expired.
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem("agent-fit-trace:auth:v1:recovery-token")).toBe(
      "strict-invite-token",
    );
  });

  it("routes a default root recovery hash to password setup", async () => {
    const state = makeState();
    installFetch(state);
    window.history.pushState(
      {},
      "",
      "/#access_token=rec-token&refresh_token=r&type=recovery",
    );
    render(<App />);

    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem("agent-fit-trace:auth:v1:recovery-token")).toBe("rec-token");
  });

  it("prefers password setup over an existing session on the root hash", async () => {
    const state = makeState();
    state.usersByToken.set("access-user-a", { id: "user-a", email: "a@example.com" });
    installFetch(state);
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      serializeSession(storedSession("user-a", "a@example.com", "access-user-a")),
    );
    window.history.pushState(
      {},
      "",
      "/#access_token=invite-token&refresh_token=r&type=invite",
    );
    render(<App />);

    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
  });

  it("leaves a non-auth root hash on the normal sign-in route", async () => {
    const state = makeState();
    installFetch(state);
    window.history.pushState({}, "", "/#section");
    render(<App />);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(window.location.hash).toBe("#section");
    expect(window.sessionStorage.getItem("agent-fit-trace:auth:v1:recovery-token")).toBeNull();
  });

  it("shows the invalid-link notice at root when the hash carries no token", async () => {
    const state = makeState();
    installFetch(state);
    window.history.pushState({}, "", "/#type=invite");
    render(<App />);

    expect(await screen.findByText(/invalid or expired/i)).toBeInTheDocument();
  });

  it("does not hijack the root invite hash in local mode", async () => {
    vi.stubEnv("VITE_FIT_TRACE_MODE", "local");
    window.history.pushState(
      {},
      "",
      "/#access_token=invite-token&refresh_token=r&type=invite",
    );
    render(<App legacyLoopback />);

    expect(await screen.findByRole("heading", { name: /workout history/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /choose a new password/i })).not.toBeInTheDocument();
  });

  it("recovers from a transient refresh without replaying writes and uses the new token", async () => {
    const state = makeState();
    state.refreshTransient = true;
    state.usersByToken.set("access-user-a", { id: "user-a", email: "a@example.com" });
    installFetch(state);
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      serializeSession({
        ...storedSession("user-a", "a@example.com", "access-user-a"),
        expiresAt: Date.now() - 1000,
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    // Transient outage during validation: retry gate, stored session preserved.
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toContain("user-a");

    state.refreshTransient = false;
    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();

    // Later business requests carry the refreshed token…
    const historyCalls = state.apiCalls.filter((call) => call.url === "/api/v1/workouts");
    expect(historyCalls.length).toBeGreaterThan(0);
    expect(historyCalls[historyCalls.length - 1]?.authorization).toMatch(/^Bearer access-refreshed-/);
    // …and no write was ever dispatched or replayed.
    expect(state.apiCalls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("completes invite -> password -> login -> History in one mount under StrictMode", async () => {
    const state = makeState();
    installFetch(state);
    window.history.pushState(
      {},
      "",
      "/#access_token=invite-token&refresh_token=r&type=invite",
    );
    const user = userEvent.setup();
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(state.passwordUpdates).toHaveLength(1);
    expect(state.passwordUpdates[0]?.authorization).toBe("Bearer invite-token");

    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("heading", { name: /workout history/i })).toBeInTheDocument();
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
    expect(
      state.apiCalls.filter((call) => call.method !== "GET"),
    ).toHaveLength(0);

    // Subsequent router navigation away and back keeps History (no stale callback).
    await user.click(screen.getByRole("link", { name: "Plan" }));
    expect(await screen.findByRole("heading", { name: /training plan/i })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "History" }));
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
  });

  it("completes recovery -> password -> login -> History in one mount", async () => {
    const state = makeState();
    installFetch(state);
    window.history.pushState(
      {},
      "",
      "/#access_token=rec-token&refresh_token=r&type=recovery",
    );
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText("New password"), "new-password-2");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(state.passwordUpdates).toHaveLength(1);
    expect(state.passwordUpdates[0]?.authorization).toBe("Bearer rec-token");

    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("heading", { name: /workout history/i })).toBeInTheDocument();
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
  });

  it("returns an existing session to History via router navigation after an invite link", async () => {
    const state = makeState();
    state.usersByToken.set("access-user-a", { id: "user-a", email: "a@example.com" });
    installFetch(state);
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      serializeSession(storedSession("user-a", "a@example.com", "access-user-a")),
    );
    window.history.pushState(
      {},
      "",
      "/#access_token=invite-token&refresh_token=r&type=invite",
    );
    const user = userEvent.setup();
    render(<App />);

    // Invite takes precedence over the existing session.
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();

    // Router navigation back to "/" (no hash left after consume) returns History.
    await user.click(screen.getByRole("link", { name: "History" }));
    expect(await screen.findByRole("heading", { name: /workout history/i })).toBeInTheDocument();
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
  });
});
