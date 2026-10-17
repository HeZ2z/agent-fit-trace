import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import type { CoachingEventEnvelope } from "@pi-fit-trace/api-contracts";
import { AuthProvider } from "../auth/AuthContext.tsx";
import type { SupabaseSession } from "../auth/supabaseAuth.ts";
import { CoachingClient } from "../api/coachingClient.ts";
import { CoachingProvider } from "../coaching/CoachingProvider.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient } from "../test/asyncClient.ts";
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

function apiErrorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface SeenRequest {
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

const dummyAuthFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

function renderCoach(history: WorkoutRecord[], fetchImpl: typeof fetch, seen: SeenRequest[]) {
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
  void seen;
  return { user, coachClient, ...view };
}

afterEach(() => {
  window.sessionStorage.clear();
});

async function askOnce(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId("coach-history-count");
  await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
  await user.click(screen.getByRole("button", { name: /ask coach/i }));
}

describe("unknown submit recovery (4266413456)", () => {
  it("lost ack holds same-key retry; Ask/newAnalysis blocked with no fresh POST", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") throw new Error("socket hangup");
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);

    // Unknown outcome: same-key retry offered, never a reconnect.
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();

    // Ask is disabled and its inputs are inert while unknown.
    const ask = screen.getByRole("button", { name: /ask coach/i });
    expect(ask).toBeDisabled();
    expect(screen.getByLabelText(/analysis question/i)).toBeDisabled();
    // New analysis is hidden while unknown (no escape hatch that erases the key).
    expect(screen.queryByRole("button", { name: /new analysis/i })).not.toBeInTheDocument();

    // A programmatic form submit must not erase the key or POST again.
    fireEvent.submit(ask.closest("form") as HTMLFormElement);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toHaveLength(1);
    // The pending key is preserved: retry is still offered afterwards.
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
  });

  it("retry reuses same session/snapshot/key, recovers the run, and cancel reaches it", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let runsCalls = 0;
    const openTails: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pushTerminal = (): void => {
      const frame = new TextEncoder().encode(sseFrame(envelope(1, { type: "terminal", status: "cancelled" })));
      for (const tail of openTails) {
        try {
          tail.enqueue(frame);
        } catch {
          // Detached.
        }
      }
      for (const tail of openTails) {
        try {
          tail.close();
        } catch {
          // Detached.
        }
      }
    };
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
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        const first = new TextEncoder().encode(sseFrame(envelope(0, { type: "text_delta", delta: "recovered " })));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
            openTails.push(controller);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        setTimeout(pushTerminal, 20);
        return jsonData({ run: storedRun("cancelled", snapshot), lastSeq: 1 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/recovered/i);

    const posts = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    expect(posts).toHaveLength(2);
    const bodies = posts.map((entry) => entry.body as Record<string, unknown>);
    expect(bodies[0]?.idempotencyKey).toBeTruthy();
    expect(bodies[1]?.idempotencyKey).toBe(bodies[0]?.idempotencyKey);
    expect(bodies[1]?.sessionId).toBe(bodies[0]?.sessionId);
    expect(bodies[1]?.snapshot).toMatchObject({ snapshotId: "snap-1", source: "supabase", accountId: "user-1" });

    // The recovered run is cancellable and the cancel reaches the server run.
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByTestId("coach-cancelled")).toBeInTheDocument();
    expect(seen.filter((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toHaveLength(1);
    expect(seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toHaveLength(2);
  });

  it("cancel during retry bootstrap stays honest: same-key POST then real cancel, never local cancelled", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let bootstrapCalls = 0;
    let releaseBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) {
        bootstrapCalls += 1;
        // The retry re-bootstrap is held open so Cancel lands first.
        if (bootstrapCalls === 2) await bootstrapGate;
        return jsonData({ capability: `cap-${String(bootstrapCalls)}`, expiresInMs: 600_000 });
      }
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") {
        const count = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST").length;
        if (count === 1) throw new Error("socket hangup");
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(sseFrame(envelope(0, { type: "terminal", status: "cancelled" })));
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return jsonData({ run: storedRun("cancelled", snapshot), lastSeq: 0 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user, coachClient } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    // Force the retry through a fresh bootstrap so Cancel lands mid-bootstrap.
    coachClient.discardCredentials();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    // Retry is bootstrapping (gated): cancel is offered but must not resolve locally.
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    // Honest: still resolving, never a local cancelled while the original is unknown.
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancel-unconfirmed")).not.toBeInTheDocument();

    releaseBootstrap();
    expect(await screen.findByTestId("coach-cancelled")).toBeInTheDocument();
    const posts = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    expect(posts).toHaveLength(2);
    expect((posts[0]?.body as { idempotencyKey?: string })?.idempotencyKey).toBe(
      (posts[1]?.body as { idempotencyKey?: string })?.idempotencyKey,
    );
    expect(seen.filter((entry) => entry.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toHaveLength(1);
  });

  it("retry bootstrap failure + cancel resolves unconfirmed, never local cancelled", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let bootstrapCalls = 0;
    let releaseBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) {
        bootstrapCalls += 1;
        if (bootstrapCalls === 2) {
          await bootstrapGate;
          throw new Error("socket hangup");
        }
        return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      }
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") throw new Error("socket hangup");
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user, coachClient: retryClient } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    // Force the retry through a fresh bootstrap so Cancel lands mid-bootstrap.
    retryClient.discardCredentials();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    releaseBootstrap();

    // The original accepted request is still unknown: honest unconfirmed, key kept.
    expect(await screen.findByTestId("coach-cancel-unconfirmed")).toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resolve cancellation/i })).toBeInTheDocument();
    expect(seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toHaveLength(1);
  });

  it("definitive VALIDATION_ERROR clears pending: fresh work allowed with a new key", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
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
        if (runsCalls === 1) return apiErrorResponse("VALIDATION_ERROR", "bad prompt", 400);
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(sseFrame(envelope(0, { type: "terminal", status: "completed" })));
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);

    // Definitive rejection: no same-key retry trap, fresh work stays available.
    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/bad prompt/i);
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask coach/i })).not.toBeDisabled();
    expect(screen.getAllByRole("button", { name: /new analysis/i }).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole("button", { name: /new analysis/i })[0]);
    await user.type(screen.getByLabelText(/analysis question/i), "How is my bench progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    await waitFor(() =>
      expect(seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toHaveLength(2),
    );
    const posts = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    const firstKey = (posts[0]?.body as { idempotencyKey?: string })?.idempotencyKey;
    const secondKey = (posts[1]?.body as { idempotencyKey?: string })?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it("definitive RUN_BUSY clears pending: fresh work allowed, never trapped unknown", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") return apiErrorResponse("RUN_BUSY", "run busy", 409);
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);

    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/busy/i);
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /new analysis/i }).length).toBeGreaterThan(0);
  });

  it("malformed successful ack keeps same-key retry (never treated as definitive)", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
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
        if (runsCalls === 1) return jsonData({ bogus: true });
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(
          sseFrame(envelope(0, { type: "text_delta", delta: "recovered " })) +
            sseFrame(envelope(1, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);

    // Untrustworthy success is unknown: same-key retry stays, fresh work blocked.
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /new analysis/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/recovered/i);
    const posts = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    expect(posts).toHaveLength(2);
    expect((posts[0]?.body as { idempotencyKey?: string })?.idempotencyKey).toBe(
      (posts[1]?.body as { idempotencyKey?: string })?.idempotencyKey,
    );
  });

  it("unknown API_ERROR 5xx keeps the same-key retry (never a definitive refusal)", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
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
        // An unknown/proxy 5xx cannot prove no run was accepted.
        if (runsCalls === 1) return apiErrorResponse("API_ERROR", "upstream boom", 500);
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(
          sseFrame(envelope(0, { type: "text_delta", delta: "recovered " })) +
            sseFrame(envelope(1, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);

    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/upstream boom/i);
    // Unknown 5xx keeps the same-key retry; fresh work stays blocked.
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /new analysis/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/recovered/i);
    const posts = seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    expect(posts).toHaveLength(2);
    expect((posts[0]?.body as { idempotencyKey?: string })?.idempotencyKey).toBe(
      (posts[1]?.body as { idempotencyKey?: string })?.idempotencyKey,
    );
  });

  it("a same-key retry rejection keeps the ORIGINAL key; a later identical retry recovers it", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let runsCalls = 0;
    let bootstrapCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) {
        bootstrapCalls += 1;
        return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      }
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        if (runsCalls === 1) throw new Error("socket hangup"); // original lost ack
        // Retry #1: a trusted transient/auth refusal that still cannot prove
        // the ORIGINAL accepted run is absent.
        if (runsCalls === 2) return apiErrorResponse("UNAUTHENTICATED", "Coach sign-in expired.", 401);
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(
          sseFrame(envelope(0, { type: "text_delta", delta: "recovered " })) +
            sseFrame(envelope(1, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);

    // Retry #1 is refused by a transient/auth error.
    await user.click(await screen.findByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/sign-in expired/i);
    // The refused Retry is never auto-repeated: exactly the original POST plus
    // the one explicit retry, and the still-valid capability was reused.
    expect(seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")).toHaveLength(2);
    expect(bootstrapCalls).toBe(1);
    // The ORIGINAL key is preserved; fresh work stays blocked.
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /new analysis/i })).not.toBeInTheDocument();

    // Retry #2 (identical) recovers the original accepted run; the rejected
    // capability was dropped, so this explicit retry renews it exactly once.
    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/recovered/i);
    expect(bootstrapCalls).toBe(2);
    const keys = seen
      .filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")
      .map((entry) => (entry.body as { idempotencyKey?: string })?.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });

  it("repeated same-key Retry reuses one still-valid capability instead of exhausting the server cap", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    // Fetch-seam model of the real server: every bootstrap MINTS a capability
    // that the server keeps for its TTL, bounded to 5 per account. An
    // unconditional re-bootstrap per Retry would mint a 6th capability and be
    // refused with `503 STORAGE_UNAVAILABLE`, stranding the unknown request.
    const liveCapabilities = new Set<string>();
    let bootstrapCalls = 0;
    let runsCalls = 0;
    const runPosts = (): SeenRequest[] =>
      seen.filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST");
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (target.endsWith("/coaching/bootstrap")) {
        bootstrapCalls += 1;
        if (liveCapabilities.size >= 5) {
          return apiErrorResponse("STORAGE_UNAVAILABLE", "capability map full", 503);
        }
        const capability = `cap-${String(bootstrapCalls)}`;
        liveCapabilities.add(capability);
        return jsonData({ capability, expiresInMs: 600_000 });
      }
      const capability = headers["x-fit-trace-capability"];
      if (typeof capability !== "string" || !liveCapabilities.has(capability)) {
        return apiErrorResponse("UNAUTHENTICATED", "capability missing or expired", 401);
      }
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        // The original POST plus six explicit same-key Retries are ambiguous.
        if (runsCalls <= 7) throw new Error("socket hangup");
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(
          sseFrame(envelope(0, { type: "text_delta", delta: "recovered " })) +
            sseFrame(envelope(1, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(bootstrapCalls).toBe(1);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await user.click(await screen.findByRole("button", { name: /^retry$/i }));
      await waitFor(() => expect(runPosts()).toHaveLength(attempt + 2));
      expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    }

    // Six same-key Retries reused the ONE still-valid capability: the server
    // cap was never re-minted, so the 7th attempt can still resolve the key.
    expect(bootstrapCalls).toBe(1);
    expect(liveCapabilities.size).toBe(1);
    expect(runPosts()).toHaveLength(7);

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/recovered/i);
    expect(bootstrapCalls).toBe(1);
    const keys = runPosts().map((entry) => (entry.body as { idempotencyKey?: string })?.idempotencyKey);
    expect(keys).toHaveLength(8);
    expect(new Set(keys)).toEqual(new Set([keys[0]]));
  });

  it("an explicitly expired capability is renewed exactly once by the next Retry", async () => {
    const history = [record()];
    const seen: SeenRequest[] = [];
    const snapshot = resolvedSnapshot(history.map((entry) => entry.id));
    let bootstrapCalls = 0;
    let runsCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method, body: parseBody(init) });
      if (target.endsWith("/coaching/bootstrap")) {
        bootstrapCalls += 1;
        return jsonData({ capability: `cap-${String(bootstrapCalls)}`, expiresInMs: 600_000 });
      }
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot);
      if (target === "/coaching/runs" && method === "POST") {
        runsCalls += 1;
        if (runsCalls === 1) throw new Error("socket hangup");
        return jsonData({ run: storedRun("running", snapshot), lastSeq: -1, replayed: true });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(
          sseFrame(envelope(0, { type: "text_delta", delta: "recovered " })) +
            sseFrame(envelope(1, { type: "terminal", status: "completed" })),
        );
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    const { user, coachClient } = renderCoach(history, fetchImpl, seen);
    await askOnce(user);
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(bootstrapCalls).toBe(1);

    // A genuinely lapsed capability (simulated by discarding it, exactly what
    // expiry means to the client) is the ONLY case that renews on Retry.
    coachClient.discardCredentials();
    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/recovered/i);
    expect(bootstrapCalls).toBe(2);
    const keys = seen
      .filter((entry) => entry.url === "/coaching/runs" && entry.method === "POST")
      .map((entry) => (entry.body as { idempotencyKey?: string })?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});
