import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CoachingEventEnvelope } from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import App from "./App.tsx";
import { AUTH_STORAGE_KEY, resetRecoveryTokenMemoryForTests } from "./auth/supabaseAuth.ts";
import { FakeFitTraceClient } from "./test/asyncClient.ts";

const AUTH_BASE = "http://auth.invalid";
const SESSION = "sess-gate";
const RUN = "run-gate";
const RESUME_KEY = "fit-trace.coach.resume.v1";

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

function workout(): WorkoutRecord {
  return {
    schema_version: 1,
    id: "w-a",
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
  };
}

function envelope(seq: number, event: CoachingEventEnvelope["event"]): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId: SESSION, runId: RUN, seq, event };
}

/** A restored-but-unvalidated session: stored in localStorage, verified over the wire. */
function storeSignedInSession(): void {
  window.localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      accessToken: "access-user-a",
      refreshToken: "refresh-user-a",
      expiresAt: Date.now() + 3600_000,
      user: { id: "user-a", email: "a@example.com" },
    }),
  );
}

function storeResume(): void {
  window.sessionStorage.setItem(
    RESUME_KEY,
    JSON.stringify({ version: 1, accountId: "user-a", sessionId: SESSION, runId: RUN }),
  );
}

function coachingRequests(seen: SeenRequest[]): SeenRequest[] {
  return seen.filter((entry) => entry.url.includes("/coaching/"));
}

/**
 * Real App over one fetch router whose public-config and `/auth/v1/user`
 * responses are gated: the stored session stays UNVERIFIED until the test
 * releases each gate, exactly like a slow auth round-trip.
 */
function installGatedRouter(seen: SeenRequest[]): {
  releaseConfig: () => void;
  releaseUser: () => void;
} {
  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  let releaseUser!: () => void;
  const userGate = new Promise<void>((resolve) => {
    releaseUser = resolve;
  });
  const snapshot = {
    snapshotId: "snap-gate",
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
      seen.push({ url, method });

      if (url.endsWith("/api/v1/public-config")) {
        await configGate;
        return jsonData({ supabaseUrl: AUTH_BASE, supabasePublishableKey: "pub" });
      }
      if (url === `${AUTH_BASE}/auth/v1/user`) {
        await userGate;
        return new Response(JSON.stringify({ id: "user-a", email: "a@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${AUTH_BASE}/auth/v1/logout`) return new Response("{}", { status: 200 });
      if (url === "/api/v1/workouts" && method === "GET") return jsonData([workout()]);

      if (url.endsWith("/coaching/bootstrap")) {
        return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
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
            idempotencyKey: "key-gate",
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
  return { releaseConfig, releaseUser };
}

afterEach(() => {
  delete (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetRecoveryTokenMemoryForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Coaching owner auth/coaching gate (batch 3 review item 1)", () => {
  it("keeps a signed-in resume untouched while the session is unverified, then restores it", async () => {
    window.history.pushState({}, "", "/");
    vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
    (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
      coaching: "same-origin",
    };
    storeSignedInSession();
    storeResume();

    const seen: SeenRequest[] = [];
    const { releaseConfig, releaseUser } = installGatedRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    // Public config pending: auth status is `loading` on an unvalidated session.
    await waitFor(() => expect(seen.some((e) => e.url.endsWith("/api/v1/public-config"))).toBe(true));
    expect(coachingRequests(seen)).toHaveLength(0);
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();

    releaseConfig();
    // Session validation in flight: still unverified.
    await waitFor(() => expect(seen.some((e) => e.url === `${AUTH_BASE}/auth/v1/user`)).toBe(true));
    expect(coachingRequests(seen)).toHaveLength(0);
    // The signed-in user's resume is RETAINED during validation (never cleared).
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();

    releaseUser();
    // Verified signed-in: the account-level owner restores the stored run.
    const coachLink = await screen.findByRole("link", { name: /^coach$/i });
    await user.click(coachLink);
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/restored output/);

    // Server restore happened after verification, with no new run POST.
    expect(
      coachingRequests(seen).some((entry) => entry.url.endsWith("/coaching/bootstrap")),
    ).toBe(true);
    expect(seen.some((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toBe(
      false,
    );
    // The resume survives the restore (preserved, not consumed).
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();
  });

  it("plain local mode never touches coaching endpoints even with a stale resume", async () => {
    window.history.pushState({}, "", "/");
    // No VITE_FIT_TRACE_MODE and no runtime coaching override: plain local mode.
    storeSignedInSession();
    storeResume();

    const seen: SeenRequest[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: unknown, init?: RequestInit) => {
        seen.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
        throw new Error("local mode must not fetch");
      }) as unknown as typeof fetch,
    );

    render(<App client={new FakeFitTraceClient({ records: [workout()] })} legacyLoopback />);
    expect(await screen.findAllByText("FIT TRACE")).not.toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(coachingRequests(seen)).toHaveLength(0);
    // Nothing read or cleared the stale resume.
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();
  });
});
