import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { COACHING_CAPABILITY_VERSION, COACHING_PROTOCOL_VERSION, type CoachingEventEnvelope } from "@agent-fit-trace/api-contracts";
import App from "./App.tsx";
import { resetRecoveryTokenMemoryForTests } from "./auth/supabaseAuth.ts";

const AUTH_BASE = "http://auth.invalid";
const SESSION = "sess-app";
const RUN = "run-app";

interface SeenRequest {
  url: string;
  method: string;
  authorization: string | null;
  capability: string | null;
}

function jsonData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return { ...(raw as Record<string, string>) };
}

function workout(id: string, date: string) {
  return {
    schema_version: 1,
    id,
    date,
    session_type: "strength",
    exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
  };
}

function envelope(seq: number, event: CoachingEventEnvelope["event"]): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId: SESSION, runId: RUN, seq, event };
}

/**
 * Real App + real HTTP clients over one fetch router: auth, workout reads, and
 * the local coaching endpoints. Proves the Layout's logout teardown runs the
 * coaching cancel/logout with account A's credentials BEFORE the auth sign-out
 * clears the session — both while the Coach is mounted and after ordinary
 * navigation already unmounted it (the shell retains the account-bound
 * teardown across that unmount).
 */
function installRouter(seen: SeenRequest[]): void {
  const tokens = new Map<string, string>([
    ["access-user-a", "user-a"],
    ["access-user-b", "user-b"],
  ]);
  const accounts = new Map([
    ["a@example.com", { id: "user-a", password: "pw-a-1234", token: "access-user-a", workout: workout("w-a", "2026-09-01") }],
    ["b@example.com", { id: "user-b", password: "pw-b-1234", token: "access-user-b", workout: workout("w-b", "2026-10-02") }],
  ]);
  const snapshot = {
    snapshotId: "snap-app",
    source: "supabase",
    accountId: "user-a",
    recordIds: ["w-a"],
    recordCount: 1,
  };
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = headersOf(init);
      const authorization =
        headers.authorization ?? headers.Authorization ?? null;
      const capability = headers["x-fit-trace-capability"] ?? null;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;
      seen.push({ url, method, authorization, capability });

      if (url.endsWith("/api/v1/public-config")) {
        return jsonData({ supabaseUrl: AUTH_BASE, supabasePublishableKey: "pub" });
      }
      if (url === `${AUTH_BASE}/auth/v1/token?grant_type=password`) {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        const account = accounts.get(body.email);
        if (account === undefined || account.password !== body.password) {
          return new Response(JSON.stringify({ msg: "Invalid login credentials" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: account.token,
            refresh_token: `refresh-${account.id}`,
            expires_in: 3600,
            user: { id: account.id, email: body.email },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${AUTH_BASE}/auth/v1/user`) {
        const principal = token === null ? undefined : tokens.get(token);
        if (principal === undefined) {
          return new Response(JSON.stringify({ msg: "bad token" }), { status: 401 });
        }
        return new Response(JSON.stringify({ id: principal, email: `${principal}@example.com` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${AUTH_BASE}/auth/v1/logout`) {
        return new Response("{}", { status: 200 });
      }
      if (url === "/api/v1/workouts" && method === "GET") {
        const principal = token === null ? undefined : tokens.get(token);
        if (principal === undefined) {
          return new Response(
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const owner = [...accounts.values()].find((entry) => entry.id === principal);
        return jsonData(owner === undefined ? [] : [owner.workout]);
      }

      if (url.endsWith("/coaching/bootstrap")) {
        return jsonData({ capability: "cap-app", expiresInMs: 600_000 });
      }
      if (url.endsWith("/coaching/capabilities")) return jsonData({
        discoveryVersion: 1, protocolVersion: COACHING_PROTOCOL_VERSION,
        tools: ["get_training_history", "analyze_progress"], defaultBackendId: "local-pi",
        backends: [{ backendId: "local-pi", runtimeId: "pi", executionLocation: "local", displayName: "pi CLI (local)", available: true,
          capabilities: { capabilityVersion: COACHING_CAPABILITY_VERSION, protocolVersion: COACHING_PROTOCOL_VERSION, tools: ["get_training_history", "analyze_progress"], productReplay: true, nativeContinuation: true, cancelConfirmation: "process-exit", maxInputBytes: 65536, maxEvents: 1000, maxEventBytes: 4194304, accountEligibility: "not-required", quotaReservation: "not-required", dataDestination: "cli-provider" } }],
      });
      if (url.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (url.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (url === "/coaching/runs" && method === "POST") {
        return jsonData({
          run: {
            id: RUN,
            sessionId: SESSION,
            status: "running",
            idempotencyKey: "key-app",
            prompt: "How is my squat progressing?",
            snapshot,
            runtimeId: "pi",
          },
          lastSeq: -1,
          replayed: false,
        });
      }
      if (url.includes(`/coaching/runs/${RUN}/events`)) {
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify(envelope(0, { type: "text_delta", delta: "partial output" }))}\n\n`,
        );
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            // Stay open: the run remains active for the logout teardown.
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return jsonData({
          run: {
            id: RUN,
            sessionId: SESSION,
            status: "cancelled",
            idempotencyKey: "key-app",
            prompt: "How is my squat progressing?",
            snapshot,
            runtimeId: "pi",
          },
          lastSeq: 0,
        });
      }
      if (url.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });

      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch,
  );
}

describe("App coach logout teardown (item 1)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
    (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
      coaching: "same-origin",
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("logs the coach out with A's credentials before the auth sign-out, and clears A's run", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    // Sign in as A, then open the (runtime-gated) Coach route.
    await waitFor(() => expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();

    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial output/);

    // The active run persisted a versioned, account-bound resume.
    expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).not.toBeNull();

    await user.click(screen.getByRole("link", { name: /^me$/i }));
    await user.click(await screen.findByRole("button", { name: /^sign out$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument());

    const coachLogout = seen.find((entry) => entry.url.endsWith("/coaching/logout"));
    const authLogout = seen.find((entry) => entry.url === `${AUTH_BASE}/auth/v1/logout`);
    expect(coachLogout).toBeDefined();
    expect(authLogout).toBeDefined();
    // A's credentials, and the coach teardown is dispatched BEFORE auth sign-out.
    expect(coachLogout?.authorization).toBe("Bearer access-user-a");
    expect(coachLogout?.capability).toBe("cap-app");
    expect(authLogout?.authorization).toBe("Bearer access-user-a");
    expect(seen.indexOf(coachLogout as SeenRequest)).toBeLessThan(
      seen.indexOf(authLogout as SeenRequest),
    );
    // The active run was cancelled and the resume ids were cleared.
    expect(seen.some((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toBe(true);
    await waitFor(() =>
      expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).toBeNull(),
    );

    // B signing in never sees A's coach transcript (unmounted + resume cleared).
    await user.type(screen.getByLabelText("Email"), "b@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-b-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/2026-10-02/)).toBeInTheDocument();
    expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument();
    expect(screen.queryByText(/partial output/)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).toBeNull();
  });

  it("retains the run's account-bound teardown across an ordinary navigation, so a later sign-out still cancels and clears it", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    // Sign in as A and start a live run on the Coach route.
    await waitFor(() => expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();

    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial output/);
    expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).not.toBeNull();

    // Ordinary navigation unmounts the Coach: the run and its resume are KEPT
    // (never cancelled here), but the shell must retain the teardown.
    await user.click(screen.getByRole("link", { name: /^history$/i }));
    await waitFor(() => expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument());
    expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).not.toBeNull();
    expect(seen.some((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toBe(false);
    expect(seen.some((entry) => entry.url.endsWith("/coaching/logout"))).toBe(false);

    // Signing out AFTER the unmount must still tear the run down with A's
    // retained credentials, before the auth sign-out.
    await user.click(screen.getByRole("link", { name: /^me$/i }));
    await user.click(await screen.findByRole("button", { name: /^sign out$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument());

    const coachLogout = seen.find((entry) => entry.url.endsWith("/coaching/logout"));
    const coachCancel = seen.find((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`));
    const authLogout = seen.find((entry) => entry.url === `${AUTH_BASE}/auth/v1/logout`);
    expect(coachCancel).toBeDefined();
    expect(coachLogout).toBeDefined();
    expect(authLogout).toBeDefined();
    expect(coachCancel?.authorization).toBe("Bearer access-user-a");
    expect(coachCancel?.capability).toBe("cap-app");
    expect(coachLogout?.authorization).toBe("Bearer access-user-a");
    expect(coachLogout?.capability).toBe("cap-app");
    expect(seen.indexOf(coachLogout as SeenRequest)).toBeLessThan(
      seen.indexOf(authLogout as SeenRequest),
    );
    await waitFor(() =>
      expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).toBeNull(),
    );
  });
});
