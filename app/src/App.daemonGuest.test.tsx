import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import type { HandlerInit } from "@agent-fit-trace/api-contracts/testing";
import { createMemoryHandler } from "@agent-fit-trace/api-contracts/testing";
import App from "./App.tsx";
import { LOCAL_GUEST_BEARER } from "./api/authSurface.ts";
import { LocalFitTraceClient } from "./api/localFitTraceClient.ts";
import { MemoryStorageAdapter } from "./storage/adapter.ts";

/**
 * Guest-local daemon wiring (issue #39), driven through the real app with a
 * mocked `fetch`:
 *
 * 1. `GET /api/v1/public-config` advertising `{ daemon: true,
 *    auth_configured: false }` boots the app straight into the daemon's
 *    stable local guest identity — no Supabase call of any kind, no sign-in
 *    gate — and every `/api/v1` request carries the daemon's fixed local
 *    guest bearer.
 * 2. Workouts are created and read through `/api/v1` with contract-shaped
 *    responses (bridged to a real in-memory contract handler, same pattern as
 *    `App.modes.test.tsx`).
 * 3. The cloud-coach entry renders an explicit unavailable state for the
 *    local guest (and never probes cloud capabilities for a guest).
 * 4. A daemon with a configured Supabase project keeps the login gate and a
 *    working "Continue as guest" path; the guest session then talks to
 *    `/api/v1` with its own Supabase bearer, not the daemon guest bearer.
 */

interface DaemonFetchState {
  /** Every fetched URL, in order (asserts zero auth-server traffic). */
  seenUrls: string[];
  /** Authorization values seen on /api/v1 data requests, in order. */
  bearersSeen: string[];
  /** Public-config fetch count. */
  publicConfigFetches: number;
}

/**
 * Mock the guest-local daemon: `public-config` without Supabase fields, and
 * `/api/v1` behind the fixed local guest bearer only. Anything else throws —
 * so a stray Supabase/auth call fails the test loudly instead of passing.
 */
function installDaemonFetch(state: DaemonFetchState): void {
  const backing = new LocalFitTraceClient(new MemoryStorageAdapter());
  const handler = createMemoryHandler(backing);
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      state.seenUrls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const authorization = headers.authorization ?? headers.Authorization ?? null;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;

      if (url.endsWith("/api/v1/public-config")) {
        state.publicConfigFetches += 1;
        // Guest-local daemon: the Supabase fields are legitimately absent.
        return new Response(
          JSON.stringify({ data: { daemon: true, auth_configured: false } }),
          { status: 200 },
        );
      }

      if (url.startsWith("/api/v1/")) {
        // The daemon verifier rejects anything but the fixed local guest
        // bearer (server/auth/localVerifier.ts semantics).
        if (token !== LOCAL_GUEST_BEARER) {
          return new Response(
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } }),
            { status: 401 },
          );
        }
        state.bearersSeen.push(LOCAL_GUEST_BEARER);
        const parsed = new URL(url, "http://fit-trace.invalid");
        const route = parsed.pathname.replace(/^\/api\/v1(?=\/|$)/, "");
        const response = await handler(`${route}${parsed.search}`, init as HandlerInit);
        return { status: response.status, text: () => Promise.resolve(response.body) };
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch,
  );
}

const AUTH_BASE = "http://auth.invalid";

interface ConfiguredState {
  seenUrls: string[];
  bearersSeen: string[];
  guestSignupCalls: number;
}

/**
 * Mock a daemon with a configured Supabase project (`auth_configured: true`):
 * the login gate applies and the deployment advertises guest entry, so
 * "Continue as guest" performs the ordinary Supabase anonymous sign-in.
 */
function installConfiguredDaemonFetch(state: ConfiguredState): void {
  const tokens = new Map<string, { id: string; email?: string; isAnonymous?: boolean }>([
    ["access-guest-1", { id: "guest-1", isAnonymous: true }],
  ]);
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      state.seenUrls.push(url);
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
              guestSignInEnabled: true,
              daemon: true,
              auth_configured: true,
            },
          }),
          { status: 200 },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/signup`) {
        state.guestSignupCalls += 1;
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

      if (url === `${AUTH_BASE}/auth/v1/user`) {
        const principal = token === null ? undefined : tokens.get(token);
        if (principal === undefined) {
          return new Response(JSON.stringify({ msg: "bad token" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            id: principal.id,
            ...(principal.email === undefined ? {} : { email: principal.email }),
            is_anonymous: principal.isAnonymous,
          }),
          { status: 200 },
        );
      }

      if (url.startsWith("/api/v1/")) {
        if (token === null) {
          return new Response(
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } }),
            { status: 401 },
          );
        }
        state.bearersSeen.push(token);
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

/** Fill the single default exercise/set on the editor and submit. */
async function fillAndSave(user: UserEvent): Promise<void> {
  await user.type(screen.getByLabelText(/exercise 1 name/i), "Squat");
  await user.type(screen.getByLabelText(/exercise 1 set 1 weight/i), "100");
  await user.type(screen.getByLabelText(/exercise 1 set 1 reps/i), "5");
  await user.type(screen.getByLabelText(/exercise 1 set 1 RPE/i), "8");
  await user.click(screen.getByRole("button", { name: /save workout/i }));
}

describe("app guest-local daemon mode", () => {
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

  it("boots into the local guest identity without any Supabase call or sign-in gate", async () => {
    const state: DaemonFetchState = { seenUrls: [], bearersSeen: [], publicConfigFetches: 0 };
    installDaemonFetch(state);
    window.history.pushState({}, "", "/");
    render(<App />);

    // No sign-in gate and no auth error screen: history loads straight away
    // through the guest bearer.
    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.publicConfigFetches).toBe(1);

    // Zero identity-provider traffic: every fetch went to the same-origin
    // daemon plane (public-config + /api/v1), never to a Supabase auth host.
    expect(state.seenUrls.length).toBeGreaterThan(0);
    expect(state.seenUrls.every((url) => url.includes("/api/v1"))).toBe(true);

    // Every data request carried the daemon's fixed local guest bearer.
    expect(state.bearersSeen.length).toBeGreaterThan(0);
    expect(new Set(state.bearersSeen)).toEqual(new Set([LOCAL_GUEST_BEARER]));

    // The Me page reflects the truthful local-guest state: no sign-out, no
    // upgrade, no account switch — the daemon guest store is machine-local.
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: /account details/i }));
    expect(await screen.findByRole("heading", { name: /^me$/i })).toBeInTheDocument();
    expect(screen.getByText(/local guest on this machine's daemon/i)).toBeInTheDocument();
    expect(screen.queryByText(/another device can recover it only/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sign out guest/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in to an existing account/i })).toBeNull();
  });

  it("creates and reads a workout through /api/v1 with contract-shaped responses", async () => {
    const state: DaemonFetchState = { seenUrls: [], bearersSeen: [], publicConfigFetches: 0 };
    installDaemonFetch(state);
    window.history.pushState({}, "", "/");
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText(/no workouts yet/i);
    await user.click(screen.getByRole("link", { name: /log your first workout/i }));
    await fillAndSave(user);

    // The write went through /api/v1 with the guest bearer and the summary
    // reflects the record the (bridged, contract-parsed) backend returned.
    expect(await screen.findByRole("heading", { level: 1, name: /workout summary/i })).toBeInTheDocument();
    expect(screen.getByText(/100 kg × 5 reps · RPE 8/)).toBeInTheDocument();
    const readsAfterSave = state.bearersSeen.length;
    expect(readsAfterSave).toBeGreaterThan(0);

    // A later read round-trips the stored record through the same plane.
    await user.click(screen.getByRole("link", { name: /^history$/i }));
    expect(
      await screen.findByRole("link", { name: /strength workout on/i }),
    ).toBeInTheDocument();
    expect(state.bearersSeen.length).toBeGreaterThan(readsAfterSave);
    expect(new Set(state.bearersSeen)).toEqual(new Set([LOCAL_GUEST_BEARER]));
  });

  it("renders an explicit cloud-unavailable state for the local guest coach entry", async () => {
    const state: DaemonFetchState = { seenUrls: [], bearersSeen: [], publicConfigFetches: 0 };
    installDaemonFetch(state);
    window.history.pushState({}, "", "/coach");
    render(<App />);

    // The guest-only coach note: cloud coaching requires a formal account,
    // and the local coach needs the launcher-gated pi CLI.
    expect(await screen.findByRole("heading", { name: /^coach$/i })).toBeInTheDocument();
    expect(screen.getByTestId("coach-guest-local")).toHaveTextContent(
      /cloud coaching requires a formal account/i,
    );
    // Guests get no backend selector at all — the cloud option is never
    // advertised, and no cloud capability probe is even attempted.
    expect(screen.getByTestId("coach-no-backends")).toHaveTextContent(
      /no coach backend is available/i,
    );
    expect(screen.queryByTestId("coach-backend-select")).toBeNull();
    expect(state.seenUrls.some((url) => url.includes("/coaching/"))).toBe(false);
  });

  it("keeps the login gate on a configured daemon with a working guest path", async () => {
    const state: ConfiguredState = {
      seenUrls: [],
      bearersSeen: [],
      guestSignupCalls: 0,
    };
    installConfiguredDaemonFetch(state);
    window.history.pushState({}, "", "/");
    const user = userEvent.setup();
    render(<App />);

    // The strict login gate still applies when the daemon has Supabase.
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();

    // The advertised "Continue as guest" path is enabled and performs the
    // ordinary Supabase anonymous sign-in (exactly once).
    const guestButton = screen.getByRole("button", { name: /continue as guest/i });
    expect(guestButton).toBeEnabled();
    await user.click(guestButton);
    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();
    expect(state.guestSignupCalls).toBe(1);

    // The signed-in Supabase guest — not the daemon guest bearer — now backs
    // the data plane: the active principal switched with the identity.
    expect(state.bearersSeen.length).toBeGreaterThan(0);
    expect(new Set(state.bearersSeen)).toEqual(new Set(["access-guest-1"]));
  });

  it("gates the login and reset-password screens with an unconfigured notice in guest-local mode", async () => {
    const state: DaemonFetchState = { seenUrls: [], bearersSeen: [], publicConfigFetches: 0 };
    installDaemonFetch(state);

    // /login shows the unconfigured state: no submittable form, no reset
    // link, no guest entry button — nothing that could reach an auth host.
    window.history.pushState({}, "", "/login");
    const { unmount } = render(<App />);
    const loginRegion = await screen.findByRole("region", { name: /sign in/i });
    expect(
      within(loginRegion).getByText(/sign-in is not configured on this deployment/i),
    ).toBeInTheDocument();
    expect(within(loginRegion).queryByRole("button")).toBeNull();
    expect(within(loginRegion).queryByLabelText(/email/i)).toBeNull();
    expect(within(loginRegion).queryByLabelText(/password/i)).toBeNull();
    unmount();

    // /reset-password likewise: a reset here would target an auth host that
    // does not exist on this daemon, so only the notice renders.
    window.history.pushState({}, "", "/reset-password");
    render(<App />);
    const resetRegion = await screen.findByRole("region", {
      name: /choose a new password/i,
    });
    expect(
      within(resetRegion).getByText(/password reset is not configured on this deployment/i),
    ).toBeInTheDocument();
    expect(within(resetRegion).queryByRole("button")).toBeNull();
    expect(within(resetRegion).queryByLabelText(/new password/i)).toBeNull();
    unmount();
  });

  it("keeps the login and reset-password forms on a daemon with auth configured", async () => {
    const state: ConfiguredState = { seenUrls: [], bearersSeen: [], guestSignupCalls: 0 };
    installConfiguredDaemonFetch(state);

    // daemon-optional: the ordinary reset form (unchanged behavior).
    window.history.pushState({}, "", "/reset-password");
    const { unmount } = render(<App />);
    const resetRegion = await screen.findByRole("region", {
      name: /choose a new password/i,
    });
    expect(
      within(resetRegion).getByRole("button", { name: /update password/i }),
    ).toBeEnabled();
    unmount();

    // daemon-optional: the ordinary sign-in gate with the guest entry path.
    window.history.pushState({}, "", "/login");
    render(<App />);
    const loginRegion = await screen.findByRole("region", { name: /sign in/i });
    expect(
      within(loginRegion).getByRole("button", { name: /continue as guest/i }),
    ).toBeInTheDocument();
  });
});
