import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisResult, WorkoutRecord } from "@pi-fit-trace/core";
import { analyzeProgress } from "@pi-fit-trace/core";
import type { CoachingEventEnvelope } from "@pi-fit-trace/api-contracts";
import { AuthProvider, useAuth } from "../auth/AuthContext.tsx";
import type { SupabaseSession } from "../auth/supabaseAuth.ts";
import { CoachingClient } from "../api/coachingClient.ts";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient } from "../test/asyncClient.ts";
import App from "../App.tsx";
import { CoachScreen } from "./CoachScreen.tsx";

const SESSION = "sess-1";
const RUN = "run-1";

function record(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "wkt_a",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
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

function envelope(seq: number, event: CoachingEventEnvelope["event"]): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId: SESSION, runId: RUN, seq, event };
}

function sseFrame(entry: CoachingEventEnvelope): string {
  return `data: ${JSON.stringify(entry)}\n\n`;
}

function resolvedSnapshot(recordIds: string[], range: { from?: string; to?: string } = {}) {
  return {
    snapshotId: "snap-1",
    source: "supabase",
    accountId: "user-1",
    recordIds,
    recordCount: recordIds.length,
    ...range,
  };
}

function storedRun(status: string, snapshot: ReturnType<typeof resolvedSnapshot>) {
  return {
    id: RUN,
    sessionId: SESSION,
    status,
    idempotencyKey: "key-1",
    prompt: "How is my squat progressing?",
    snapshot,
    runtimeId: "pi",
  };
}

function jsonData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
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

interface SeenRequest {
  url: string;
  method: string;
  body: unknown;
  /** Request headers, when the harness captured them (account-isolation tests). */
  headers?: Record<string, string>;
}

interface CoachingHarness {
  fetchImpl: typeof fetch;
  seen: SeenRequest[];
  /** True once the fake SSE stream's reader was detached (unmount/close). */
  canceled?: () => boolean;
  /** Push a late frame onto a held-open tail (used to prove it is ignored). */
  push?: (entry: CoachingEventEnvelope) => void;
}

function requestHeaders(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return { ...(raw as Record<string, string>) };
}

/**
 * Production-seam fake: a real `CoachingClient` over a stubbed fetch router
 * (bootstrap → session → snapshot → submit → SSE tail → cancel/logout).
 * No UI-only state machine; the wire shapes are the reviewed contracts.
 */
function coachingHarness(opts: {
  history: WorkoutRecord[];
  events: CoachingEventEnvelope[];
  analysis: AnalysisResult;
}): CoachingHarness {
  const seen: SeenRequest[] = [];
  const snapshot = resolvedSnapshot(opts.history.map((entry) => entry.id));
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string" && init.body !== "") {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    seen.push({ url: target, method, body, headers: requestHeaders(init) });
    if (target.endsWith("/coaching/bootstrap")) {
      return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
    }
    if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
    if (target.endsWith("/coaching/snapshots")) {
      const filter = (body ?? {}) as { from?: string; to?: string };
      return jsonData(resolvedSnapshot(opts.history.map((entry) => entry.id), filter));
    }
    if (target === "/coaching/runs" && method === "POST") {
      return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: false });
    }
    if (target.includes(`/coaching/runs/${RUN}/events`)) {
      return sseResponse(opts.events.map(sseFrame).join(""));
    }
    if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
      return jsonData({ run: storedRun("cancelled", snapshot), lastSeq: opts.events.length - 1 });
    }
    if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
    throw new Error(`unexpected coaching request: ${method} ${target}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** Held-open SSE tail: one frame, then silence until the fake server pushes the terminal on cancel. */
function heldCoachingHarness(
  history: WorkoutRecord[],
  opts: { cancelStatus?: number; cancelMessage?: string } = {},
): CoachingHarness {
  const seen: SeenRequest[] = [];
  const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
  const openTails: ReadableStreamDefaultController<Uint8Array>[] = [];
  let canceled = false;
  const pushFrame = (entry: CoachingEventEnvelope): void => {
    const frame = new TextEncoder().encode(sseFrame(entry));
    for (const tail of openTails) {
      try {
        tail.enqueue(frame);
      } catch {
        // Already closed/detached.
      }
    }
  };
  const pushTerminal = (): void => {
    pushFrame(envelope(1, { type: "terminal", status: "cancelled" }));
    for (const tail of openTails) {
      try {
        tail.close();
      } catch {
        // Detached already.
      }
    }
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push({ url: target, method, body: null, headers: requestHeaders(init) });
    if (target.endsWith("/coaching/bootstrap")) {
      return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
    }
    if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
    if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
    if (target === "/coaching/runs" && method === "POST") {
      return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: false });
    }
    if (target.includes(`/coaching/runs/${RUN}/events`)) {
      const first = new TextEncoder().encode(sseFrame(envelope(0, { type: "text_delta", delta: "partial…" })));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          openTails.push(controller);
          // Stay open: the fake server pushes the cancelled terminal when
          // the cancel endpoint is hit (mirrors the real server tail).
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
      if ((opts.cancelStatus ?? 200) !== 200) {
        return new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: opts.cancelMessage ?? "No such run." } }),
          { status: opts.cancelStatus ?? 404, headers: { "content-type": "application/json" } },
        );
      }
      // Server confirms the cancel, then the terminal arrives on the live tail.
      // Delayed so the honest "Cancelling…" state is observable in tests.
      setTimeout(pushTerminal, 50);
      return jsonData({ run: storedRun("cancelled", snapshot), lastSeq: 1 });
    }
    if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
    throw new Error(`unexpected coaching request: ${method} ${target}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, canceled: () => canceled, push: pushFrame };
}

const dummyAuthFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

function renderCoach(history: WorkoutRecord[], harness: CoachingHarness) {
  const user = userEvent.setup();
  const historyClient = new FakeFitTraceClient({ records: history });
  const coachClient = new CoachingClient({
    fetchImpl: harness.fetchImpl,
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
          <Routes>
            <Route path="/coach" element={<CoachScreen client={coachClient} />} />
            <Route path="/workout/new" element={<div data-testid="editor" />} />
          </Routes>
        </WorkoutStoreProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

afterEach(() => {
  delete (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
  // Item 4 stores only ids, but they must never leak between tests/runs.
  window.sessionStorage.clear();
});

describe("CoachScreen", () => {
  it("streams tool progress plus text and renders the returned analysis", async () => {
    const history = [record()];
    const analysis = analyzeProgress(history);
    const harness = coachingHarness({
      history,
      analysis,
      events: [
        envelope(0, { type: "text_delta", delta: "Squat is " }),
        envelope(1, { type: "text_delta", delta: "trending up. " }),
        envelope(2, { type: "tool_start", tool: "analyze_progress", callId: "c1" }),
        envelope(3, { type: "tool_end", tool: "analyze_progress", callId: "c1", ok: true, summary: "1 record" }),
        envelope(4, { type: "analysis_result", result: analysis }),
        envelope(5, { type: "terminal", status: "completed" }),
      ],
    });
    const { user } = renderCoach(history, harness);

    expect(await screen.findByTestId("coach-history-count")).toHaveTextContent(/1 workout\(s\) in history/);
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    // Source/range/count line comes from the backend-issued snapshot handle.
    expect(await screen.findByTestId("coach-source")).toHaveTextContent(/supabase/i);
    expect(screen.getByTestId("coach-source")).toHaveTextContent(/1 record\(s\)/);
    // Streaming text preserves both deltas; tool progress is listed. A
    // tool_end updates the matching callId row in place (no duplicate start
    // row is left behind).
    expect(await screen.findByTestId("coach-text")).toHaveTextContent("Squat is trending up.");
    expect(await screen.findByText(/finished analyze_progress: 1 record/i)).toBeInTheDocument();
    expect(screen.queryByText(/running analyze_progress/i)).not.toBeInTheDocument();
    // The returned AnalysisResult renders with the existing metrics style.
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Volume: 500 kg/)).toBeInTheDocument();

    // The submit body carries a handle only — no raw records or counts.
    const submit = harness.seen.find((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    expect(submit).toBeDefined();
    const submitSnapshot = (submit?.body as { snapshot?: Record<string, unknown> })?.snapshot ?? {};
    expect(submitSnapshot).toMatchObject({ snapshotId: "snap-1", source: "supabase", accountId: "user-1" });
    expect(submitSnapshot).not.toHaveProperty("recordIds");
    expect(submitSnapshot).not.toHaveProperty("recordCount");
    const snapshotCall = harness.seen.find((entry) => entry.url.endsWith("/coaching/snapshots"));
    expect(snapshotCall?.body).not.toHaveProperty("recordIds");
  });

  it("shows an empty state first and makes no coach call without history", async () => {
    const harness = coachingHarness({ history: [], analysis: analyzeProgress([]), events: [] });
    renderCoach([], harness);

    expect(await screen.findByText(/no workout history to analyse yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /log your first workout/i })).toHaveAttribute("href", "/workout/new");
    expect(screen.queryByLabelText(/analysis question/i)).not.toBeInTheDocument();
    await waitFor(() => expect(harness.seen).toHaveLength(0));
  });

  it("disables submit while running and cancels the active run", async () => {
    const history = [record()];
    const harness = heldCoachingHarness(history);
    const { user } = renderCoach(history, harness);

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);
    // Submit while running is disabled; cancel is offered instead.
    expect(screen.getByRole("button", { name: /coach is working/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Cancelling shows honestly until the server terminal confirms it.
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(await screen.findByTestId("coach-cancelled")).toHaveTextContent(/cancelled/i);
    await waitFor(() =>
      expect(harness.seen.some((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toBe(true),
    );
    // Partial output stays frozen after cancel.
    expect(screen.getByTestId("coach-text")).toHaveTextContent(/partial/i);
  });
});

describe("Coach route gating", () => {
  it("hides the Coach nav without the runtime flag and shows it when enabled", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/");
    const { unmount } = render(<App client={new FakeFitTraceClient({ records: [] })} />);
    expect(screen.getByText("agent-fit-trace")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^coach$/i })).not.toBeInTheDocument();
    unmount();

    (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
      coaching: "same-origin",
    };
    window.history.pushState({}, "", "/");
    render(<App client={new FakeFitTraceClient({ records: [] })} />);
    const coachLink = await screen.findByRole("link", { name: /^coach$/i });
    await user.click(coachLink);
    expect(await screen.findByRole("heading", { level: 1, name: /^coach$/i })).toBeInTheDocument();
  });
});

describe("Coach lifecycle review fixes (items 1/2/5)", () => {
  interface BodySeen {
    url: string;
    method: string;
    body: unknown;
  }

  function parseBody(init?: RequestInit): unknown {
    if (typeof init?.body !== "string" || init.body === "") return null;
    try {
      return JSON.parse(init.body) as unknown;
    } catch {
      return init.body;
    }
  }

  /** Item 1: first tail delivers 0/1 then disconnects; reconnect must resume from 2. */
  function resumeHarness(history: WorkoutRecord[]): CoachingHarness {
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let eventsCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") {
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        eventsCalls += 1;
        if (eventsCalls === 1) {
          // Delivered 0/1, then EOF before terminal = disconnect.
          return sseResponse(
            sseFrame(envelope(0, { type: "text_delta", delta: "A" })) +
              sseFrame(envelope(1, { type: "text_delta", delta: "B" })),
          );
        }
        return sseResponse(
          sseFrame(envelope(2, { type: "text_delta", delta: "C" })) +
            sseFrame(envelope(3, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return jsonData({ run: storedRun("cancelled", snapshot), lastSeq: 3 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it("item 1: reconnect resumes from last consumed + 1 without duplicating text", async () => {
    const history = [record()];
    const harness = resumeHarness(history);
    const { user } = renderCoach(history, harness);

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    // First tail folded exactly once, then the disconnect error + Reconnect.
    expect(await screen.findByTestId("coach-text")).toHaveTextContent("AB");
    expect(await screen.findByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    // Stream disconnects never offer a resubmit (item 5).
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    // Reconnected tail appends only the new frame; the terminal completes.
    await waitFor(() => expect(screen.getByTestId("coach-text")).toHaveTextContent("ABC"));
    const eventCalls = harness.seen.filter((entry) => entry.url.includes("/events"));
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[1]?.url).toContain("fromSeq=2");
    // Late frames from the superseded first subscription never double-append.
    expect(screen.getByTestId("coach-text")).toHaveTextContent("ABC");
  });

  it("item 2: cancel before the snapshot resolves never spawns a run", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let resolveSnapshot!: (value: Response) => void;
    const snapshotGate = new Promise<Response>((resolve) => {
      resolveSnapshot = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return snapshotGate;
      if (target === "/coaching/runs" && method === "POST") {
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: false });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, { fetchImpl, seen });

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByRole("button", { name: /coach is working/i })).toBeInTheDocument();

    // Cancel while the snapshot is still pending: the submit must not spawn.
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    resolveSnapshot(jsonData(snapshot));
    await waitFor(() =>
      expect(seen.some((entry) => entry.url.endsWith("/coaching/snapshots"))).toBe(true),
    );
    expect(await screen.findByTestId("coach-cancelled")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.some((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toBe(false);
    expect(seen.some((entry) => entry.url.endsWith("/cancel"))).toBe(false);
  });

  it("item 2: a failed cancel surfaces the error and stays cancellable until confirmed", async () => {
    const history = [record()];
    const harness = heldCoachingHarness(history, { cancelStatus: 404, cancelMessage: "No such run." });
    const { user } = renderCoach(history, harness);

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    // The 404 is reported honestly — never claimed as cancelled.
    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/no such run/i);
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    // Still cancellable: the inflight flag released on failure for a retry.
    expect(screen.getByRole("button", { name: /cancelling/i })).toBeInTheDocument();
  });

  it("item 5: an ambiguous submit retries with the same key; stream failures never resubmit", async () => {
    const history = [record()];
    const seen: BodySeen[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let runsCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        if (runsCalls === 1) throw new Error("socket hangup");
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        const analysis = { period: { from: "2026-01-05" }, metrics: {}, trends: [], flags: [], source_records: [] };
        return sseResponse(
          sseFrame(envelope(0, { type: "text_delta", delta: "recovered " })) +
            sseFrame(envelope(1, { type: "analysis_result", result: analysis as never })) +
            sseFrame(envelope(2, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, { fetchImpl, seen });

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    // Ambiguous network failure during submit: same-key retry, no reconnect.
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/recovered/i);

    const posts = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    expect(posts).toHaveLength(2);
    const firstKey = (posts[0]?.body as { idempotencyKey?: string })?.idempotencyKey;
    const secondKey = (posts[1]?.body as { idempotencyKey?: string })?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(firstKey).toBe(secondKey);
    // The retry resolved the run: no further retry is offered afterwards.
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();
  });

  it("item 5: duplicate submits collapse synchronously and New analysis is blocked while running", async () => {
    const history = [record()];
    const seen: BodySeen[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let resolveSubmit!: (value: Response) => void;
    const submitGate = new Promise<Response>((resolve) => {
      resolveSubmit = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") return submitGate;
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, { fetchImpl, seen });

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    const ask = screen.getByRole("button", { name: /ask coach/i });
    await user.click(ask);
    // Second tap lands before React re-renders: the synchronous phase guard
    // must collapse it into the in-flight submit (exactly one POST).
    await user.click(screen.getByRole("button", { name: /coach is working/i }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toHaveLength(1);
    // While unresolved there is no New-analysis escape hatch (never abandon).
    expect(screen.queryByRole("button", { name: /new analysis/i })).not.toBeInTheDocument();
    resolveSubmit(jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: false }));
  });
});

describe("Coach account isolation + resume (items 3/4)", () => {
  /** Test-only auth probe: switches the mounted session from A to B in place. */
  function SignInProbe() {
    const { signIn } = useAuth();
    return (
      <button type="button" onClick={() => void signIn("b@example.com", "pw")}>
        switch to b
      </button>
    );
  }

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
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  it("item 3: account switch cleans up with the captured A bearer, never B's, and isolates output", async () => {
    const history = [record()];
    const harness = heldCoachingHarness(history);
    const realFetch = globalThis.fetch;
    // The production default client reads the global fetch at construction.
    globalThis.fetch = harness.fetchImpl;
    const user = userEvent.setup();
    const historyClient = new FakeFitTraceClient({ records: history });
    try {
      render(
        <MemoryRouter initialEntries={["/coach"]}>
          <AuthProvider
            skipBootstrap
            publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
            fetchImpl={switchAuthFetch}
            initialSession={sessionFor("user-1", "a@example.com")}
          >
            <WorkoutStoreProvider client={historyClient}>
              <SignInProbe />
              <Routes>
                <Route path="/coach" element={<CoachScreen />} />
              </Routes>
            </WorkoutStoreProvider>
          </AuthProvider>
        </MemoryRouter>,
      );

      await screen.findByTestId("coach-history-count");
      await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
      await user.click(screen.getByRole("button", { name: /ask coach/i }));
      expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);

      const bootstrap = harness.seen.find((entry) => entry.url.endsWith("/coaching/bootstrap"));
      expect(bootstrap?.headers?.authorization).toBe("Bearer access-user-1");

      await user.click(screen.getByRole("button", { name: /switch to b/i }));

      // Cleanup fires A's server teardown with A's own credentials.
      await waitFor(() =>
        expect(harness.seen.some((entry) => entry.url.endsWith("/coaching/logout"))).toBe(true),
      );
      await waitFor(() =>
        expect(harness.seen.some((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toBe(true),
      );
      const logout = harness.seen.find((entry) => entry.url.endsWith("/coaching/logout"));
      const cancel = harness.seen.find((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`));
      expect(logout?.headers?.authorization).toBe("Bearer access-user-1");
      expect(cancel?.headers?.authorization).toBe("Bearer access-user-1");
      expect(logout?.headers?.authorization).not.toBe("Bearer access-user-2");
      expect(logout?.headers?.["x-fit-trace-capability"]).toBe("cap-1");
      // Output isolation: A's transcript is gone and the form is back for B.
      expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument();
      expect(screen.getByLabelText(/analysis question/i)).toBeInTheDocument();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("item 3/4: unmount detaches the stream and persists only versioned, account-bound ids", async () => {
    const history = [record()];
    const harness = heldCoachingHarness(history);
    const { user, unmount } = renderCoach(history, harness);

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);

    const raw = window.sessionStorage.getItem("fit-trace.coach.resume.v1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      version: 1,
      accountId: "user-1",
      sessionId: SESSION,
      runId: RUN,
    });
    // NEVER tokens or transcripts — ids only.
    expect(raw).not.toContain("access-");
    expect(raw).not.toContain("partial");

    unmount();
    // Unmount detaches the stream; the deliberate persisted resume is the plan.
    await waitFor(() => expect(harness.canceled?.()).toBe(true));
    harness.push?.(envelope(2, { type: "text_delta", delta: "late" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  /** Real client over a fetch stub that supports read + replay and rejects any run POST. */
  function restoreHarness(
    history: WorkoutRecord[],
    opts: { runStatus?: number; sessionStatus?: number } = {},
  ): CoachingHarness {
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    const notFound = (code: string): Response =>
      new Response(JSON.stringify({ error: { code, message: "no longer available" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: null, headers: requestHeaders(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.includes("/coaching/sessions/")) {
        if (opts.sessionStatus !== undefined) return notFound("SESSION_NOT_FOUND");
        return jsonData({ id: SESSION, accountId: "user-1" });
      }
      if (target.includes("/coaching/runs/") && !target.includes("/events") && !target.endsWith("/cancel")) {
        if (opts.runStatus !== undefined) return notFound("RUN_NOT_FOUND");
        return jsonData({
          run: storedRun("completed", snapshot),
          lastSeq: 2,
          firstSeq: 0,
          expiresAt: Date.now() + 600_000,
        });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(
          sseFrame(envelope(0, { type: "text_delta", delta: "restored " })) +
            sseFrame(envelope(1, { type: "analysis_result", result: analyzeProgress(history) })) +
            sseFrame(envelope(2, { type: "terminal", status: "completed" })),
        );
      }
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it("item 4: restore verifies the stored session/run and replays from 0 without a POST", async () => {
    const history = [record()];
    window.sessionStorage.setItem(
      "fit-trace.coach.resume.v1",
      JSON.stringify({ version: 1, accountId: "user-1", sessionId: SESSION, runId: RUN }),
    );
    const harness = restoreHarness(history);
    renderCoach(history, harness);

    // Reconstructed output from read + replay, never a fresh run.
    expect(await screen.findByTestId("coach-text")).toHaveTextContent("restored");
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
    // The refreshed result also restores the snapshot's source/scope, not just
    // the run ids.
    const source = await screen.findByTestId("coach-source");
    expect(source).toHaveTextContent(/Snapshot snap-1/);
    expect(source).toHaveTextContent(/supabase/);
    expect(source).toHaveTextContent(/1 record\(s\)/);
    // The restored snapshot matches current history, so no false stale label.
    expect(screen.queryByTestId("coach-stale")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(harness.seen.some((entry) => entry.url.includes(`/coaching/runs/${RUN}/events`))).toBe(true),
    );
    const events = harness.seen.find((entry) => entry.url.includes(`/coaching/runs/${RUN}/events`));
    expect(events?.url).toContain("fromSeq=0");
    expect(harness.seen.some((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toBe(false);
  });

  it("item 4: a stored resume for another account is ignored and cleared", async () => {
    window.sessionStorage.setItem(
      "fit-trace.coach.resume.v1",
      JSON.stringify({ version: 1, accountId: "user-2", sessionId: SESSION, runId: RUN }),
    );
    const harness = coachingHarness({ history: [record()], analysis: analyzeProgress([]), events: [] });
    renderCoach([record()], harness);

    expect(await screen.findByTestId("coach-history-count")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.seen).toHaveLength(0);
    expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).toBeNull();
  });

  it("item 4: a stale (404) stored run resets cleanly to the form without a POST", async () => {
    window.sessionStorage.setItem(
      "fit-trace.coach.resume.v1",
      JSON.stringify({ version: 1, accountId: "user-1", sessionId: SESSION, runId: RUN }),
    );
    const harness = restoreHarness([record()], { runStatus: 404 });
    renderCoach([record()], harness);

    expect(await screen.findByTestId("coach-history-count")).toBeInTheDocument();
    expect(await screen.findByLabelText(/analysis question/i)).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem("fit-trace.coach.resume.v1")).toBeNull());
    expect(harness.seen.some((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toBe(false);
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
  });

  it("item 4: unavailable sessionStorage is handled gracefully", async () => {
    const originalGetItem = Storage.prototype.getItem;
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (this === window.sessionStorage) throw new Error("storage blocked");
        return originalGetItem.call(this, key);
      });
    try {
      const harness = coachingHarness({ history: [record()], analysis: analyzeProgress([]), events: [] });
      renderCoach([record()], harness);
      expect(await screen.findByTestId("coach-history-count")).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.seen).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Coach final observable gaps (items 2/3/4)", () => {
  function bodyOf(init?: RequestInit): unknown {
    if (typeof init?.body !== "string" || init.body === "") return null;
    try {
      return JSON.parse(init.body) as unknown;
    } catch {
      return init.body;
    }
  }

  function storedRunFor(snapshot: ReturnType<typeof resolvedSnapshot>) {
    return {
      id: RUN,
      sessionId: SESSION,
      status: "running",
      idempotencyKey: "key-1",
      prompt: "How is my squat progressing?",
      snapshot,
      runtimeId: "pi",
    };
  }

  it("item 3: a lost submit ack after cancel stays unconfirmed and resolves with the same key", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let runsCalls = 0;
    let rejectFirstSubmit: (error: unknown) => void = () => {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: bodyOf(init), headers: requestHeaders(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        if (runsCalls === 1) {
          // Held open: the caller cancels while this POST is unresolved.
          return await new Promise<Response>((_resolve, reject) => {
            rejectFirstSubmit = reject;
          });
        }        return jsonData({ run: storedRunFor(snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        // The run is already cancelled by the time the tail is opened.
        return sseResponse(sseFrame(envelope(0, { type: "terminal", status: "cancelled" })));
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return jsonData({ run: storedRunFor(snapshot), lastSeq: 0 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const { user } = renderCoach(history, { fetchImpl, seen });
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    await waitFor(() =>
      expect(
        seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST"),
      ).toHaveLength(1),
    );

    // Cancel while the POST is unresolved: no cancelled claim yet.
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();

    // The POST then loses its ack: the server may have accepted it.
    rejectFirstSubmit(new Error("socket hangup"));

    const unconfirmed = await screen.findByTestId("coach-cancel-unconfirmed");
    expect(unconfirmed).toHaveTextContent(/unconfirmed/i);
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    // No fresh analysis escape hatch while ambiguous.
    expect(screen.queryByRole("button", { name: /new analysis/i })).not.toBeInTheDocument();

    // Resolve with the SAME key, then the run is cancelled server-side.
    await user.click(screen.getByRole("button", { name: /resolve cancellation/i }));
    expect(await screen.findByTestId("coach-cancelled")).toBeInTheDocument();

    const posts = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    expect(posts).toHaveLength(2);
    const keys = posts.map((entry) => (entry.body as { idempotencyKey?: string })?.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    expect(seen.filter((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toHaveLength(1);
  });

  it("item 4: an empty selected-range snapshot shows record-first and never submits a run", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: bodyOf(init), headers: requestHeaders(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) {
        const filter = (bodyOf(init) ?? {}) as { from?: string; to?: string };
        return jsonData(resolvedSnapshot([], filter));
      }
      if (target === "/coaching/runs" && method === "POST") {
        throw new Error("submit must not be called for an empty range");
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const { user } = renderCoach(history, { fetchImpl, seen });
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.type(screen.getByLabelText(/from \(optional\)/i), "2026-09-01");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    expect(await screen.findByTestId("coach-range-empty")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.some((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toBe(false);
  });

  it("item 4: a filtered-range snapshot is not falsely labelled stale; a genuine change is", async () => {
    const history = [
      record({ id: "wkt_a", date: "2026-01-05" }),
      record({ id: "wkt_b", date: "2026-03-05" }),
    ];

    function harnessFor(snapshotIds: string[]): CoachingHarness {
      const seen: SeenRequest[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const target = String(url);
        const method = (init?.method ?? "GET").toUpperCase();
        seen.push({ url: target, method, body: bodyOf(init), headers: requestHeaders(init) });
        if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
        if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
        if (target.endsWith("/coaching/snapshots")) {
          const filter = (bodyOf(init) ?? {}) as { from?: string; to?: string };
          return jsonData({ ...resolvedSnapshot(snapshotIds, filter) });
        }
        if (target === "/coaching/runs" && method === "POST") {
          return jsonData({ run: storedRunFor(resolvedSnapshot(snapshotIds)), lastSeq: -1, replayed: false });
        }
        if (target.includes(`/coaching/runs/${RUN}/events`)) {
          return sseResponse(sseFrame(envelope(0, { type: "terminal", status: "completed" })));
        }
        if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
        throw new Error(`unexpected coaching request: ${method} ${target}`);
      }) as unknown as typeof fetch;
      return { fetchImpl, seen };
    }

    // The snapshot covers only the selected range, which still matches history.
    const matching = harnessFor(["wkt_b"]);
    const first = renderCoach(history, matching);
    await screen.findByTestId("coach-history-count");
    await first.user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await first.user.type(screen.getByLabelText(/from \(optional\)/i), "2026-03-01");
    await first.user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-source")).toHaveTextContent(/1 record\(s\)/);
    expect(screen.queryByTestId("coach-stale")).not.toBeInTheDocument();
    first.unmount();

    // A snapshot whose id set no longer matches the (unfiltered) history is stale.
    const changed = harnessFor(["wkt_a"]);
    const second = renderCoach(history, changed);
    await screen.findByTestId("coach-history-count");
    await second.user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await second.user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-stale")).toHaveTextContent(/snapshot snap-1/i);
    expect(screen.getByTestId("coach-stale")).toHaveTextContent(/1 records then/);
  });

  it("item 4: piAvailable false warns, disables asking, and keeps workout history", async () => {
    const history = [record()];
    (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
      coaching: "same-origin",
      piAvailable: false,
    };
    const harness = coachingHarness({ history, analysis: analyzeProgress(history), events: [] });
    renderCoach(history, harness);

    expect(await screen.findByTestId("coach-history-count")).toBeInTheDocument();
    expect(screen.getByTestId("coach-pi-unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText(/analysis question/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.seen).toHaveLength(0);
  });

  it("item 1: StrictMode double-mount is safe (one submit path, one run)", async () => {
    const history = [record()];
    const harness = coachingHarness({
      history,
      analysis: analyzeProgress(history),
      events: [
        envelope(0, { type: "text_delta", delta: "ok" }),
        envelope(1, { type: "terminal", status: "completed" }),
      ],
    });
    const historyClient = new FakeFitTraceClient({ records: history });
    const coachClient = new CoachingClient({
      fetchImpl: harness.fetchImpl,
      getAccessToken: () => "access-user-1",
    });
    const user = userEvent.setup();
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/coach"]}>
          <AuthProvider
            skipBootstrap
            publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
            fetchImpl={dummyAuthFetch}
            initialSession={sessionFor("user-1", "a@example.com")}
          >
            <WorkoutStoreProvider client={historyClient}>
              <Routes>
                <Route path="/coach" element={<CoachScreen client={coachClient} />} />
              </Routes>
            </WorkoutStoreProvider>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent("ok");
    // The simulated unmount/remount must not double-dispatch the run POST.
    const posts = harness.seen.filter(
      (entry) => entry.url === "/coaching/runs" && entry.method === "POST",
    );
    expect(posts).toHaveLength(1);
  });
});
