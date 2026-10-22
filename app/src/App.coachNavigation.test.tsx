import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CoachingEventEnvelope } from "@agent-fit-trace/api-contracts";
import App from "./App.tsx";
import { resetRecoveryTokenMemoryForTests } from "./auth/supabaseAuth.ts";

const AUTH_BASE = "http://auth.invalid";
const SESSION = "sess-nav";
const RUN = "run-nav";
/** Mirrors the server's per-account active-capability cap. */
const MAX_CAPABILITIES_PER_ACCOUNT = 5;

interface SeenRequest {
  url: string;
  method: string;
}

function jsonData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
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
 * Real App + real clients over one fetch router, with the server's per-account
 * active-capability cap enforced. Every Coach mount used to construct a fresh
 * CoachingClient and bootstrap a new capability, so repeated navigation within
 * the TTL exhausted the cap (5) and the 6th bootstrap was rejected. One
 * account-level owner must bootstrap exactly once across navigations.
 */
function installRouter(seen: SeenRequest[], caps: { issued: number }): void {
  const tokens = new Map<string, string>([["access-user-a", "user-a"]]);
  const account = { id: "user-a", password: "pw-a-1234", token: "access-user-a", workout: workout("w-a", "2026-09-01") };
  const snapshot = {
    snapshotId: "snap-nav",
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
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const authorization = headers.authorization ?? headers.Authorization ?? null;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;
      seen.push({ url, method });

      if (url.endsWith("/api/v1/public-config")) {
        return jsonData({ supabaseUrl: AUTH_BASE, supabasePublishableKey: "pub" });
      }
      if (url === `${AUTH_BASE}/auth/v1/token?grant_type=password`) {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        if (body.password !== account.password) {
          return new Response(JSON.stringify({ msg: "Invalid login credentials" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: account.token,
            refresh_token: "refresh-user-a",
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
        return new Response(JSON.stringify({ id: principal, email: "a@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${AUTH_BASE}/auth/v1/logout`) return new Response("{}", { status: 200 });
      if (url === "/api/v1/workouts" && method === "GET") return jsonData([account.workout]);

      if (url.endsWith("/coaching/bootstrap")) {
        // A fresh capability per bootstrap; valid caps are never evicted.
        if (caps.issued >= MAX_CAPABILITIES_PER_ACCOUNT) {
          return new Response(
            JSON.stringify({
              error: { code: "STORAGE_UNAVAILABLE", message: "Capability capacity reached; retry after expiry." },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
        caps.issued += 1;
        return jsonData({ capability: `cap-${String(caps.issued)}`, expiresInMs: 600_000 });
      }
      if (url.includes(`/coaching/sessions/${SESSION}`)) return jsonData({ id: SESSION });
      if (url.includes(`/coaching/runs/${RUN}/events`)) {
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify(envelope(0, { type: "text_delta", delta: "restored output" }))}\n\n` +
            `data: ${JSON.stringify(envelope(1, { type: "terminal", status: "completed" }))}\n\n`,
        );
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.includes(`/coaching/runs/${RUN}`)) {
        return jsonData({
          run: {
            id: RUN,
            sessionId: SESSION,
            status: "completed",
            idempotencyKey: "key-nav",
            prompt: "restore",
            snapshot,
            runtimeId: "pi",
          },
          lastSeq: 1,
          firstSeq: 0,
          expiresAt: Date.now() + 600_000,
        });
      }
      if (url.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });

      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch,
  );
}

describe("Coach navigation keeps one account-level owner (Greptile caps)", () => {
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
    // A run to restore on each Coach mount (forces bootstrap on every mount).
    window.sessionStorage.setItem(
      "fit-trace.coach.resume.v1",
      JSON.stringify({ version: 1, accountId: "user-a", sessionId: SESSION, runId: RUN }),
    );
  });

  afterEach(() => {
    delete (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("six Coach↔History navigations issue one capability, not one per mount", async () => {
    const seen: SeenRequest[] = [];
    const caps = { issued: 0 };
    installRouter(seen, caps);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/2026-09-01/)).toBeInTheDocument();

    for (let i = 0; i < 6; i += 1) {
      await user.click(screen.getByRole("link", { name: /^coach$/i }));
      expect(await screen.findByTestId("coach-text")).toHaveTextContent(/restored output/);
      await user.click(screen.getByRole("link", { name: /^history$/i }));
      await waitFor(() => expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument());
    }

    // One account-level client/capability survives the navigations.
    expect(caps.issued).toBe(1);
    expect(seen.filter((entry) => entry.url.endsWith("/coaching/bootstrap"))).toHaveLength(1);
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
  });
});
