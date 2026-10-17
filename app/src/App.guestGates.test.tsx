import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.tsx";

const AUTH_BASE = "http://auth.invalid";

interface State {
  guestEnabled: boolean;
  guestSignupCalls: number;
  tokens: Map<string, { id: string; email?: string; isAnonymous?: boolean }>;
}

function makeState(guestEnabled: boolean): State {
  return { guestEnabled, guestSignupCalls: 0, tokens: new Map() };
}

function installFetch(state: State): void {
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const authorization = headers.authorization ?? headers.Authorization ?? null;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;

      if (url.endsWith("/api/v1/public-config")) {
        return new Response(
          JSON.stringify({
            data: {
              supabaseUrl: AUTH_BASE,
              supabasePublishableKey: "pub",
              ...(state.guestEnabled ? { guestSignInEnabled: true } : {}),
            },
          }),
          { status: 200 },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/signup`) {
        state.guestSignupCalls += 1;
        state.tokens.set("access-guest-1", { id: "guest-1", isAnonymous: true });
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

      if (url === `${AUTH_BASE}/auth/v1/token?grant_type=password`) {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        if (body.email !== "b@example.com" || body.password !== "pw-b-1234") {
          return new Response(JSON.stringify({ msg: "Invalid login credentials" }), { status: 400 });
        }
        state.tokens.set("access-user-b", { id: "user-b", email: "b@example.com", isAnonymous: false });
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

      if (url === `${AUTH_BASE}/auth/v1/user`) {
        const principal = token === null ? undefined : state.tokens.get(token);
        if (principal === undefined) {
          return new Response(JSON.stringify({ msg: "bad token" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            id: principal.id,
            ...(principal.email === undefined ? {} : { email: principal.email }),
            ...(principal.isAnonymous === undefined
              ? {}
              : { is_anonymous: principal.isAnonymous }),
          }),
          { status: 200 },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/logout`) return new Response("{}", { status: 200 });

      if (url.startsWith("/api/v1/")) {
        const principal = token === null ? undefined : state.tokens.get(token);
        if (principal === undefined) {
          return new Response(
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } }),
            { status: 401 },
          );
        }
        if (url === "/api/v1/workouts") {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
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

describe("guest and deep-link gates (HTTP mode)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns a guest to the safe deep link and requires explicit guest sign-out", async () => {
    const state = makeState(true);
    installFetch(state);
    window.history.pushState({}, "", "/analysis?from=2026-09-01");
    const user = userEvent.setup();
    render(<App />);

    const guestButton = await screen.findByRole("button", { name: /continue as guest/i });
    await waitFor(() => expect(guestButton).toBeEnabled());
    await user.click(guestButton);

    expect(await screen.findByRole("heading", { name: /analysis/i })).toBeInTheDocument();
    expect(state.guestSignupCalls).toBe(1);

    // Guest sign-out is a two-step, explicit destructive action.
    await user.click(await screen.findByRole("button", { name: /sign out guest/i }));
    expect(screen.getByText(/may be lost and cannot be guaranteed recoverable/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /sign out and lose guest access/i }));
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    // The explicit sign-out does not leave the previous deep link armed.
    expect(window.sessionStorage.getItem("pi-fit-trace:auth:return-target:v1")).toBeNull();
  });

  it("warns before replacing a guest and returns the account to the guest's page", async () => {
    const state = makeState(true);
    installFetch(state);
    window.history.pushState({}, "", "/plan");
    const user = userEvent.setup();
    render(<App />);

    const guestButton = await screen.findByRole("button", { name: /continue as guest/i });
    await waitFor(() => expect(guestButton).toBeEnabled());
    await user.click(guestButton);
    expect(await screen.findByRole("heading", { name: /plan/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /sign in to an account/i }));
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/not merged or transferred/i);

    await user.type(screen.getByLabelText("Email"), "b@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-b-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByRole("heading", { name: /plan/i })).toBeInTheDocument();
    expect(state.guestSignupCalls).toBe(1);
  });

  it("returns an account to the safe deep link", async () => {
    const state = makeState(true);
    installFetch(state);
    window.history.pushState({}, "", "/plan");
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText("Email"), "b@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-b-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByRole("heading", { name: /plan/i })).toBeInTheDocument();
  });

  it("keeps guest entry disabled when the deployment capability is off", async () => {
    const state = makeState(false);
    installFetch(state);
    window.history.pushState({}, "", "/analysis");
    render(<App />);

    const guestButton = await screen.findByRole("button", { name: /continue as guest/i });
    await waitFor(() => expect(guestButton).toBeDisabled());
    expect(screen.getByText(/guest sign-in is not enabled/i)).toBeInTheDocument();
    expect(state.guestSignupCalls).toBe(0);
  });
});
