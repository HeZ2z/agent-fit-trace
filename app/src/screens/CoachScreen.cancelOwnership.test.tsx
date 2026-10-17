import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachingEventEnvelope } from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { AuthProvider, useAuth } from "../auth/AuthContext.tsx";
import type { SupabaseSession } from "../auth/supabaseAuth.ts";
import { CoachingClient } from "../api/coachingClient.ts";
import { CoachingProvider } from "../coaching/CoachingProvider.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient } from "../test/asyncClient.ts";
import { CoachScreen } from "./CoachScreen.tsx";

const SESSION = "sess-own";
const RUN = "run-own";
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

function envelope(seq: number, event: CoachingEventEnvelope["event"]): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId: SESSION, runId: RUN, seq, event };
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

function snapshot() {
  return {
    snapshotId: "snap-own",
    source: "supabase",
    accountId: "user-1",
    recordIds: ["wkt_a"],
    recordCount: 1,
  };
}

function storedRun(status: string) {
  return {
    id: RUN,
    sessionId: SESSION,
    status,
    idempotencyKey: "key-own",
    prompt: "How is my squat progressing?",
    snapshot: snapshot(),
    runtimeId: "pi",
  };
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
  if (String(url).includes("/auth/v1/user")) {
    return new Response(
      JSON.stringify({ id: "user-2", email: "b@example.com", is_anonymous: false }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("{}", { status: 200 });
}) as unknown as typeof fetch;

const dummyAuthFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

function renderCoachWithClient(history: WorkoutRecord[], client: CoachingClient, opts: { withSwitchProbe?: boolean } = {}) {
  const user = userEvent.setup();
  const historyClient = new FakeFitTraceClient({ records: history });
  const view = render(
    <MemoryRouter initialEntries={["/coach"]}>
      <AuthProvider
        skipBootstrap
        publicConfig={{ supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" }}
        fetchImpl={opts.withSwitchProbe ? switchAuthFetch : dummyAuthFetch}
        initialSession={sessionFor("user-1", "a@example.com")}
      >
        <WorkoutStoreProvider client={historyClient}>
          <CoachingProvider client={client}>
            <Routes>
              <Route
                path="/coach"
                element={
                  <>
                    {opts.withSwitchProbe ? <SignInProbe /> : null}
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
  return { user, ...view };
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Batch A: restore double-cancel ownership (scoped review item 3)", () => {
  it("Cancel twice while restore is unresolved stays cancelling until the verified run is cancelled", async () => {
    const seen: Seen[] = [];
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      void parseBody(init);
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.includes("/coaching/sessions/")) {
        await sessionGate;
        return jsonData({ id: SESSION });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        return sseResponse(sseFrame(envelope(0, { type: "terminal", status: "cancelled" })));
      }
      if (target.includes("/coaching/runs/") && !target.includes("/events") && !target.endsWith("/cancel")) {
        await runGate;
        return jsonData({ run: storedRun("running"), lastSeq: -1, firstSeq: 0, expiresAt: Date.now() + 600_000 });
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return jsonData({ run: storedRun("cancelled"), lastSeq: 0 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    window.sessionStorage.setItem(
      RESUME_KEY,
      JSON.stringify({ version: 1, accountId: "user-1", sessionId: SESSION, runId: RUN }),
    );
    const client = new CoachingClient({ fetchImpl, getAccessToken: () => "access-user-1" });
    const { user } = renderCoachWithClient([record()], client);

    await waitFor(() => expect(seen.some((e) => e.url.includes("/coaching/sessions/"))).toBe(true));
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    // The cancelling button stays enabled so the second tap really dispatches
    // the handler (and hits the idempotent guard), instead of a disabled
    // no-op that would prove nothing.
    expect(screen.getByRole("button", { name: /cancelling/i })).toBeEnabled();

    // Second tap while the restore is still unresolved: must stay pending, never a local cancelled.
    await user.click(screen.getByRole("button", { name: /cancelling/i }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toHaveLength(0);

    // Session gate alone must not verify ownership: still pending, no cancel.
    releaseSession();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toHaveLength(0);

    // Read gate resolves ownership: the verified run is cancelled, and the
    // server terminal (not a local claim) produces the cancelled state.
    releaseRun();
    expect(await screen.findByTestId("coach-cancelled")).toHaveTextContent(/cancelled/i);
    await waitFor(() =>
      expect(seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toHaveLength(1),
    );
  });
});

describe("Batch A: stale cancel ownership after account change (scoped review item 2)", () => {
  function heldRunHarness(seen: Seen[], cancelGate: { release: (r: Response) => void; fail: (e: unknown) => void }) {
    let cancelCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        return jsonData({ run: storedRun("running"), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        const first = new TextEncoder().encode(sseFrame(envelope(0, { type: "text_delta", delta: "partial…" })));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        cancelCalls += 1;
        // First call is the user's cancel: hold it. Account-switch cleanup reuses
        // the same endpoint; let later calls through immediately.
        if (cancelCalls === 1) {
          return await new Promise<Response>((resolve, reject) => {
            cancelGate.release = resolve;
            cancelGate.fail = reject;
          });
        }
        return jsonData({ run: storedRun("cancelled"), lastSeq: 1 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;
    return fetchImpl;
  }

  it("late cancel rejection after an account switch never touches the new account", async () => {
    const seen: Seen[] = [];
    const gate: { release: (r: Response) => void; fail: (e: unknown) => void } = {
      release: () => {},
      fail: () => {},
    };
    const client = new CoachingClient({ fetchImpl: heldRunHarness(seen, gate), getAccessToken: () => "access-user-1" });
    const { user } = renderCoachWithClient([record()], client, { withSwitchProbe: true });

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /switch to b/i }));
    // B starts clean: no A transcript, no A error, fresh form.
    await waitFor(() => expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/analysis question/i)).toBeInTheDocument();

    gate.fail(new Error("socket hangup"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The stale A rejection must not surface on B, claim anything, or reattach A's run.
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument();
    expect(seen.filter((e) => e.url.includes(`/coaching/runs/${RUN}/events`))).toHaveLength(1);
  });

  it("late cancel success after an account switch never attaches the old run to the new account", async () => {
    const seen: Seen[] = [];
    const gate: { release: (r: Response) => void; fail: (e: unknown) => void } = {
      release: () => {},
      fail: () => {},
    };
    const client = new CoachingClient({ fetchImpl: heldRunHarness(seen, gate), getAccessToken: () => "access-user-1" });
    const { user } = renderCoachWithClient([record()], client, { withSwitchProbe: true });

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /switch to b/i }));
    await waitFor(() => expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument());

    gate.release(jsonData({ run: storedRun("cancelled"), lastSeq: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No stale success may fold A's run into B or claim a cancellation for B.
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
    expect(seen.filter((e) => e.url.includes(`/coaching/runs/${RUN}/events`))).toHaveLength(1);
  });

  it("gated cancel bootstrap after an account switch never dispatches the stale cancel", async () => {
    const seen: Seen[] = [];
    let bootstrapCalls = 0;
    let releaseBootstrap!: (v: Response) => void;
    const bootstrapGate = new Promise<Response>((resolve) => {
      releaseBootstrap = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      if (target.endsWith("/coaching/bootstrap")) {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
        return await bootstrapGate;
      }
      if (target.endsWith("/coaching/sessions")) return jsonData({ id: SESSION });
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        return jsonData({ run: storedRun("running"), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN}/events`)) {
        const first = new TextEncoder().encode(sseFrame(envelope(0, { type: "text_delta", delta: "partial…" })));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (target.endsWith(`/coaching/runs/${RUN}/cancel`)) {
        return jsonData({ run: storedRun("cancelled"), lastSeq: 1 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const client = new CoachingClient({ fetchImpl, getAccessToken: () => "access-user-1" });
    const { user } = renderCoachWithClient([record()], client, { withSwitchProbe: true });

    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);

    // Expire the capability so this cancel must re-bootstrap (gated).
    client.discardCredentials();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(bootstrapCalls).toBe(2));

    await user.click(screen.getByRole("button", { name: /switch to b/i }));
    await waitFor(() => expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument());
    const cancelsBefore = seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN}/cancel`)).length;

    releaseBootstrap(jsonData({ capability: "cap-2", expiresInMs: 600_000 }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The stale bootstrap must not dispatch A's cancel under the new identity.
    expect(seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN}/cancel`))).toHaveLength(cancelsBefore);
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-cancelled")).not.toBeInTheDocument();
  });

  it("stale A success while B holds an active pending cancel never clears B inflight", async () => {
    const RUN_A = "run-a";
    const RUN_B = "run-b";
    const SESS_A = "sess-a";
    const SESS_B = "sess-b";
    const seen: Seen[] = [];
    let postCalls = 0;
    let sessCalls = 0;
    let aCancelCalls = 0;
    let bCancelCalls = 0;
    let releaseACancel!: (v: Response) => void;
    const aCancelGate = new Promise<Response>((resolve) => {
      releaseACancel = resolve;
    });
    let releaseBCancel!: (v: Response) => void;
    const bCancelGate = new Promise<Response>((resolve) => {
      releaseBCancel = resolve;
    });
    const runRecord = (id: string, sessionId: string, status: string, accountId: string) => ({
      id,
      sessionId,
      status,
      idempotencyKey: `key-${id}`,
      prompt: "How is my squat progressing?",
      snapshot: { ...snapshot(), accountId },
      runtimeId: "pi",
    });
    const frameFor = (sessionId: string, runId: string, seq: number) =>
      sseFrame({ protocolVersion: 1, sessionId, runId, seq, event: { type: "text_delta", delta: "partial…" } });
    const openStream = (sessionId: string, runId: string) => {
      const first = new TextEncoder().encode(frameFor(sessionId, runId, 0));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({ url: target, method });
      if (target.endsWith("/coaching/bootstrap")) return jsonData({ capability: "cap-1", expiresInMs: 600_000 });
      if (target.endsWith("/coaching/sessions") && method === "POST") {
        sessCalls += 1;
        return jsonData({ id: sessCalls === 1 ? SESS_A : SESS_B });
      }
      if (target.endsWith("/coaching/snapshots")) return jsonData(snapshot());
      if (target === "/coaching/runs" && method === "POST") {
        postCalls += 1;
        if (postCalls === 1) return jsonData({ run: runRecord(RUN_A, SESS_A, "running", "user-1"), lastSeq: -1, replayed: false });
        return jsonData({ run: runRecord(RUN_B, SESS_B, "running", "user-2"), lastSeq: -1, replayed: false });
      }
      if (target.includes(`/coaching/runs/${RUN_A}/events`)) return openStream(SESS_A, RUN_A);
      if (target.includes(`/coaching/runs/${RUN_B}/events`)) return openStream(SESS_B, RUN_B);
      if (target.endsWith(`/coaching/runs/${RUN_A}/cancel`)) {
        aCancelCalls += 1;
        // First call is A's user cancel: hold it. Account-switch cleanup for
        // the same run lets later calls through immediately.
        if (aCancelCalls === 1) return await aCancelGate;
        return jsonData({ run: runRecord(RUN_A, SESS_A, "cancelled", "user-1"), lastSeq: 1 });
      }
      if (target.endsWith(`/coaching/runs/${RUN_B}/cancel`)) {
        bCancelCalls += 1;
        // First call is B's user cancel: hold it so B is genuinely pending
        // when A settles. A duplicate second POST (the bug) resolves at once
        // so the count itself is the observable.
        if (bCancelCalls === 1) return await bCancelGate;
        return jsonData({ run: runRecord(RUN_B, SESS_B, "cancelled", "user-2"), lastSeq: 1 });
      }
      if (target.endsWith("/coaching/logout")) return jsonData({ loggedOut: true });
      throw new Error(`unexpected coaching request: ${method} ${target}`);
    }) as unknown as typeof fetch;

    const client = new CoachingClient({ fetchImpl, getAccessToken: () => "access-user-1" });
    const { user } = renderCoachWithClient([record()], client, { withSwitchProbe: true });

    // A: submit, stream, then hold the user cancel.
    await screen.findByTestId("coach-history-count");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN_A}/cancel`)).length).toBeGreaterThanOrEqual(1),
    );

    // Switch to B: A stays pending server-side, B starts clean.
    await user.click(screen.getByRole("button", { name: /switch to b/i }));
    await waitFor(() => expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument());

    // B: fresh submit on the new identity, then hold B's own cancel so B is
    // genuinely pending (inflight) before A settles.
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent(/partial/i);
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN_B}/cancel`))).toHaveLength(1),
    );
    expect(screen.getByRole("button", { name: /cancelling/i })).toBeEnabled();

    // Stale A succeeds late: it must not touch B (no error, no reattach, and
    // crucially no inflight reset).
    releaseACancel(jsonData({ run: runRecord(RUN_A, SESS_A, "cancelled", "user-1"), lastSeq: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();
    expect(seen.filter((e) => e.url.includes(`/coaching/runs/${RUN_A}/events`))).toHaveLength(1);

    // Another B tap while B is still pending must stay a deduped no-op: still
    // exactly one B cancel POST (proves A did not clear B inflight).
    await user.click(screen.getByRole("button", { name: /cancelling/i }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.filter((e) => e.url.endsWith(`/coaching/runs/${RUN_B}/cancel`))).toHaveLength(1);
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    expect(screen.queryByTestId("coach-error")).not.toBeInTheDocument();

    releaseBCancel(jsonData({ run: runRecord(RUN_B, SESS_B, "cancelled", "user-2"), lastSeq: 1 }));
  });
});
