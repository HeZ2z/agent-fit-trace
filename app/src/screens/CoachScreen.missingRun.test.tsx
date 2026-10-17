import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { CoachingEventEnvelope } from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { AuthProvider, useAuth } from "../auth/AuthContext.tsx";
import type { SupabaseSession } from "../auth/supabaseAuth.ts";
import { CoachingClient } from "../api/coachingClient.ts";
import { CoachingProvider } from "../coaching/CoachingProvider.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient } from "../test/asyncClient.ts";
import { CoachScreen } from "./CoachScreen.tsx";

const SESSION = "sess-1";
const RUN = "run-1";
const RUN2 = "run-2";
const RESUME_KEY = "fit-trace.coach.resume.v1";

function record(): WorkoutRecord {
  return {
    id: "wkt_a",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
  };
}

function sessionFor(id: string, email: string): SupabaseSession {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3600_000,
    user: { id, email },
  };
}

function envelope(
  sessionId: string,
  runId: string,
  seq: number,
  event: CoachingEventEnvelope["event"],
): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId, runId, seq, event };
}

function sseFrame(entry: CoachingEventEnvelope): string {
  return `data: ${JSON.stringify(entry)}\n\n`;
}

function jsonData(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function apiError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

interface Seen {
  url: string;
  method: string;
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string" || init.body === "") return null;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

function requestHeaders(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return { ...(raw as Record<string, string>) };
}

function snapshot() {
  return {
    snapshotId: "snap-1",
    source: "supabase",
    accountId: "user-1",
    recordIds: ["wkt_a"],
    recordCount: 1,
  };
}

function storedRun(runId: string, sessionId: string, status: string) {
  return {
    id: runId,
    sessionId,
    status,
    idempotencyKey: `key-${runId}`,
    prompt: "How is my squat progressing?",
    snapshot: snapshot(),
    runtimeId: "pi",
  };
}

function runIdOf(target: string): string {
  const marker = "/coaching/runs/";
  const rest = target.slice(target.indexOf(marker) + marker.length);
  return rest.split("/")[0] ?? "";
}

const dummyAuthFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

function renderCoach(history: WorkoutRecord[], fetchImpl: typeof fetch) {
  const user = userEvent.setup();
  const historyClient = new FakeFitTraceClient({ records: history });
  const coachClient = new CoachingClient({
    fetchImpl,
    getAccessToken: () => "access-user-1",
  });
  const view = render(
    <MemoryRouter initialEntries={["/coach"]}>
      <AuthProvider
        skipBootstrap
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={dummyAuthFetch}
        initialSession={sessionFor("user-1", "a@example.com")}
      >
        <WorkoutStoreProvider client={historyClient}>
          <CoachingProvider client={coachClient}>
            <Routes>
              <Route path="/coach" element={<CoachScreen />} />
            </Routes>
          </CoachingProvider>
        </WorkoutStoreProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

function countPosts(seen: Seen[]): number {
  return seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST").length;
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe("definitive missing-run recovery", () => {
  it("reconnect RUN_NOT_FOUND releases the run and a new analysis succeeds without reload or implicit retries", async () => {
    const seen: Seen[] = [];
    let runsCalls = 0;
    let run1EventsCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      void parseBody(init);
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        const runId = runsCalls === 1 ? RUN : RUN2;
        return jsonData({ run: storedRun(runId, SESSION, "running"), lastSeq: -1, replayed: false });
      }
      if (target.includes("/coaching/runs/") && target.includes("/events")) {
        const runId = runIdOf(target);
        if (runId === RUN) {
          run1EventsCalls += 1;
          if (run1EventsCalls === 1) {
            // One frame then EOF before a terminal: a transport disconnect.
            return sseResponse(sseFrame(envelope(SESSION, RUN, 0, { type: "text_delta", delta: "partial " })));
          }
          // The server forgot the run while disconnected: authenticated,
          // structured proof of absence (not a proxy/generic 404).
          return apiError("RUN_NOT_FOUND", "Coaching run not found.", 404);
        }
        return sseResponse(
          sseFrame(envelope(SESSION, RUN2, 0, { type: "text_delta", delta: "second result" })) +
            sseFrame(envelope(SESSION, RUN2, 1, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith("/cancel")) return jsonData({ run: storedRun(RUN, SESSION, "cancelled"), lastSeq: 0 });
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const { user } = renderCoach([record()], fetchImpl);
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/);
    expect(await screen.findByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    // Definitive missing: honest unavailable state (never a fabricated
    // cancelled/completed), resume released, new work offered.
    const error = await screen.findByTestId("coach-error");
    expect(error).toHaveTextContent(/no longer available/i);
    expect(error).toHaveTextContent(/RUN_NOT_FOUND/);
    expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: /new analysis/i })).not.toHaveLength(0);
    expect(window.sessionStorage.getItem(RESUME_KEY)).toBeNull();
    // Stable absence of implicit retries: no new POST without user action.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countPosts(seen)).toBe(1);

    // New analysis without a reload: real UI entry into a fresh run that
    // reuses the live session (no new session allocation).
    await user.click(screen.getAllByRole("button", { name: /new analysis/i })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent("second result");
    expect(countPosts(seen)).toBe(2);
    expect(seen.filter((entry) => entry.url.endsWith("/coaching/sessions") && entry.method === "POST")).toHaveLength(
      1,
    );
  });

  it("cancel RUN_NOT_FOUND releases the run instead of staying cancellable forever", async () => {
    const seen: Seen[] = [];
    let runsCalls = 0;
    let eventsCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        const runId = runsCalls === 1 ? RUN : RUN2;
        return jsonData({ run: storedRun(runId, SESSION, "running"), lastSeq: -1, replayed: false });
      }
      if (target.includes("/coaching/runs/") && target.includes("/events")) {
        eventsCalls += 1;
        const runId = runIdOf(target);
        if (runId === RUN2) {
          return sseResponse(
            sseFrame(envelope(SESSION, RUN2, 0, { type: "text_delta", delta: "fresh result" })) +
              sseFrame(envelope(SESSION, RUN2, 1, { type: "terminal", status: "completed" })),
          );
        }
        const first = new TextEncoder().encode(sseFrame(envelope(SESSION, RUN, 0, { type: "text_delta", delta: "partial…" })));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return apiError("RUN_NOT_FOUND", "Coaching run not found.", 404);
      }
      if (target.endsWith("/cancel")) return jsonData({ run: storedRun(RUN2, SESSION, "cancelled"), lastSeq: 1 });
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const { user } = renderCoach([record()], fetchImpl);
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    // The run is gone server-side: released to an honest unavailable state,
    // never a false cancelled and never stuck cancelling.
    const error = await screen.findByTestId("coach-error");
    expect(error).toHaveTextContent(/no longer available/i);
    expect(error).toHaveTextContent(/RUN_NOT_FOUND/);
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(screen.queryByText(/cancelling coach run/i)).not.toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: /new analysis/i })).not.toHaveLength(0);
    expect(window.sessionStorage.getItem(RESUME_KEY)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countPosts(seen)).toBe(1);

    await user.click(screen.getAllByRole("button", { name: /new analysis/i })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent("fresh result");
    expect(countPosts(seen)).toBe(2);
    expect(eventsCalls).toBe(2);
  });

  it("a stale missing reply after an account switch never clears the new active run", async () => {
    const seen: Seen[] = [];
    let postCalls = 0;
    let runsCalls = 0;
    let runAEventsCalls = 0;
    let releaseMissing!: (v: Response) => void;
    const missingGate = new Promise<Response>((resolve) => {
      releaseMissing = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions") && method === "POST") {
        postCalls += 1;
        return jsonData({ id: postCalls === 1 ? "sess-a" : "sess-b" });
      }
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        if (runsCalls === 1) {
          return jsonData({ run: storedRun("run-a", "sess-a", "running"), lastSeq: -1, replayed: false });
        }
        return jsonData({ run: storedRun("run-b", "sess-b", "running"), lastSeq: -1, replayed: false });
      }
      if (target.includes("/coaching/runs/run-a/events")) {
        runAEventsCalls += 1;
        if (runAEventsCalls === 1) {
          return sseResponse(sseFrame(envelope("sess-a", "run-a", 0, { type: "text_delta", delta: "partial " })));
        }
        // Held: resolves definitively missing only after B's new run below.
        return await missingGate;
      }
      if (target.includes("/coaching/runs/run-b/events")) {
        const first = new TextEncoder().encode(sseFrame(envelope("sess-b", "run-b", 0, { type: "text_delta", delta: "b-partial…" })));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (target.endsWith("/cancel")) {
        const runId = runIdOf(target);
        return jsonData({ run: storedRun(runId, "sess-a", "cancelled"), lastSeq: 0 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    // NOTE: B's submit path is exercised through the same client after the switch.
    const switchAuthFetch = (async (url: string) => {
      if (String(url).includes("grant_type=password")) {
        return new Response(
          JSON.stringify({
            access_token: "access-user-2",
            refresh_token: "refresh-user-2",
            expires_in: 3600,
            user: { id: "user-2", email: "b@example.com" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "user-2", email: "b@example.com", is_anonymous: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    function SignInProbe() {
      const { signIn } = useAuth();
      return (
        <button type="button" onClick={() => void signIn("b@example.com", "pw")}>
          switch to b
        </button>
      );
    }

    const user = userEvent.setup();
    const historyClient = new FakeFitTraceClient({ records: [record()] });
    const client = new CoachingClient({ fetchImpl, getAccessToken: () => "access-user-1" });
    render(
      <MemoryRouter initialEntries={["/coach"]}>
        <AuthProvider
          skipBootstrap
          publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
          fetchImpl={switchAuthFetch}
          initialSession={sessionFor("user-1", "a@example.com")}
        >
          <WorkoutStoreProvider client={historyClient}>
            <CoachingProvider client={client}>
              <Routes>
                <Route
                  path="/coach"
                  element={
                    <>
                      <SignInProbe />
                      <CoachScreen />
                    </>
                  }
                />
              </Routes>
            </CoachingProvider>
          </WorkoutStoreProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/);
    expect(await screen.findByRole("button", { name: /reconnect/i })).toBeInTheDocument();

    // Reconnect dispatches the second run-a events read; hold it server-side.
    await user.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(runAEventsCalls).toBe(2));

    // Switch accounts while A's missing proof is still in flight.
    await user.click(screen.getByRole("button", { name: /switch to b/i }));
    await waitFor(() => expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/analysis question/i)).toBeInTheDocument();

    // B establishes a NEW active run/resume before the stale reply resolves.
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/b-partial/);
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    const resumeBefore = window.sessionStorage.getItem(RESUME_KEY);
    expect(resumeBefore).not.toBeNull();
    expect(resumeBefore as string).toContain("run-b");

    // The stale missing proof for A settles late: it must not touch B's run.
    releaseMissing(apiError("RUN_NOT_FOUND", "Coaching run not found.", 404));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/b-partial/);
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /new analysis/i })).toHaveLength(0);
    const resumeAfter = window.sessionStorage.getItem(RESUME_KEY);
    expect(resumeAfter).not.toBeNull();
    expect(resumeAfter as string).toContain("run-b");
    expect(seen.filter((entry) => entry.url.includes("run-a/events"))).toHaveLength(2);
  });

  it("a late cancel RUN_NOT_FOUND after a completed terminal keeps the completed result", async () => {
    let cancelCalls = 0;
    let releaseCancel!: (v: Response) => void;
    const cancelGate = new Promise<Response>((resolve) => {
      releaseCancel = resolve;
    });
    let emitTerminal!: () => void;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        return jsonData({ run: storedRun(RUN, SESSION, "running"), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        const first = new TextEncoder().encode(sseFrame(envelope(SESSION, RUN, 0, { type: "text_delta", delta: "partial " })));
        const terminal = new TextEncoder().encode(
          sseFrame(envelope(SESSION, RUN, 1, { type: "terminal", status: "completed" })),
        );
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
            // Deterministic gate: the completed terminal is emitted only
            // after the test observes the cancel POST held server-side.
            // No timer, so slow CI cannot reorder terminal before cancel.
            emitTerminal = () => {
              try {
                controller.enqueue(terminal);
                controller.close();
              } catch {
                // Detach is best-effort.
              }
            };
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        cancelCalls += 1;
        return await cancelGate;
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const { user } = renderCoach([record()], fetchImpl);
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/);

    // Cancel is dispatched and held server-side; the terminal is emitted
    // only after the held cancel is observed, so ordering is deterministic.
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(cancelCalls).toBe(1));

    // Completed terminal wins while the cancel is still pending.
    await act(async () => {
      emitTerminal();
    });
    await waitFor(() => expect(screen.queryByText(/cancelling coach run/i)).not.toBeInTheDocument());
    expect(await screen.findAllByRole("button", { name: /new analysis/i })).not.toHaveLength(0);
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/);
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();

    // The late same-generation cancel reply proves nothing new: completed stays.
    releaseCancel(apiError("RUN_NOT_FOUND", "Coaching run not found.", 404));
    // Flush the held cancel reply deterministically (no sleep): give the
    // ignored late reply a chance to reach UI state, then assert stability.
    await act(async () => {
      await cancelGate;
    });
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/);
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: /new analysis/i })).not.toHaveLength(0);
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();
  });

  it("a generic route 404 on reconnect preserves the run (no reset, no POST)", async () => {
    const seen: Seen[] = [];
    let eventsCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        return jsonData({ run: storedRun(RUN, SESSION, "running"), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        eventsCalls += 1;
        if (eventsCalls === 1) {
          return sseResponse(sseFrame(envelope(SESSION, RUN, 0, { type: "text_delta", delta: "partial " })));
        }
        // A proxy/generic unknown-route 404 proves nothing about the run.
        return apiError("NOT_FOUND", "Unknown route.", 404);
      }
      if (target.endsWith("/cancel")) return jsonData({ run: storedRun(RUN, SESSION, "cancelled"), lastSeq: 0 });
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const { user } = renderCoach([record()], fetchImpl);
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/);
    await user.click(await screen.findByRole("button", { name: /reconnect/i }));

    // Ambiguous: still disconnected with the run retained, never released.
    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/NOT_FOUND/);
    expect(await screen.findByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /new analysis/i })).toHaveLength(0);
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(countPosts(seen)).toBe(1);
  });

  it("network and auth failures preserve the run on reconnect and cancel", async () => {
    const seen: Seen[] = [];
    let eventsCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, headers: requestHeaders(init) } as Seen);
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        return jsonData({ run: storedRun(RUN, SESSION, "running"), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        eventsCalls += 1;
        if (eventsCalls === 1) {
          return sseResponse(sseFrame(envelope(SESSION, RUN, 0, { type: "text_delta", delta: "partial " })));
        }
        throw new Error("socket hangup");
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return apiError("UNAUTHENTICATED", "Coach sign-in expired.", 401);
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const { user } = renderCoach([record()], fetchImpl);
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/);

    // Network failure on reconnect: the run is retained, reconnect stays.
    await user.click(await screen.findByRole("button", { name: /reconnect/i }));
    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/connection failed/i);
    expect(await screen.findByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();

    // Auth failure on cancel: never released, stays cancellable for a retry.
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /new analysis/i })).toHaveLength(0);
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(countPosts(seen)).toBe(1);
  });

  it("a generic NOT_FOUND restore failure keeps the resume for an explicit retry (no reset)", async () => {
    const seen: Seen[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.includes("/coaching/sessions/")) {
        // Proxy-style generic 404: proves nothing about the stored run.
        return apiError("NOT_FOUND", "Unknown route.", 404);
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    window.sessionStorage.setItem(
      RESUME_KEY,
      JSON.stringify({ version: 1, accountId: "user-1", sessionId: SESSION, runId: RUN }),
    );
    renderCoach([record()], fetchImpl);

    // Ambiguous restore failure: recoverable, resume retained, retry offered.
    // (The form stays mounted while disconnected; only the terminal/new-run
    // affordances must be absent.)
    expect(await screen.findByTestId("coach-error")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /retry restore/i })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RESUME_KEY)).not.toBeNull();
    expect(seen.some((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toBe(false);
    expect(screen.queryAllByRole("button", { name: /new analysis/i })).toHaveLength(0);
  });
});
