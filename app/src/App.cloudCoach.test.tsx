import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  COACHING_CAPABILITY_VERSION,
  COACHING_PROTOCOL_VERSION,
  type CoachingEventEnvelope,
} from "@pi-fit-trace/api-contracts";
import App from "./App.tsx";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
import { CoachingProvider } from "./coaching/CoachingProvider.tsx";
import { useCoach } from "./coaching/useCoach.ts";
import { CoachScreen } from "./screens/CoachScreen.tsx";
import { WorkoutStoreProvider } from "./state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient } from "./test/asyncClient.ts";

/**
 * Focused coverage for the browser backend selector:
 * - guest: Coach visible, local install instructions, ZERO cloud/local
 *   capability requests;
 * - formal: cloud is advertised only from the server capability response and
 *   stays off until explicitly selected;
 * - restore/replay: origin comes from the resume v2 record, not the selector;
 * - account switch: preference/selection never leaks between accounts.
 */

const AUTH_BASE = "http://auth.invalid";
const CLOUD_SESSION = "sess-cloud";
const CLOUD_RUN = "run-cloud";
const RESUME_V2_KEY = "fit-trace.coach.resume.v2";
const RESUME_V1_KEY = "fit-trace.coach.resume.v1";

interface Principal {
  id: string;
  email?: string;
  isAnonymous: boolean;
  token: string;
  password?: string;
}

const FORMAL_A: Principal = {
  id: "user-a",
  email: "a@example.com",
  isAnonymous: false,
  token: "access-user-a",
  password: "pw-a-1234",
};
const FORMAL_B: Principal = {
  id: "user-b",
  email: "b@example.com",
  isAnonymous: false,
  token: "access-user-b",
  password: "pw-b-1234",
};
const GUEST: Principal = { id: "guest-1", isAnonymous: true, token: "access-guest-1" };

interface SeenRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

interface RouterOptions {
  cloudAvailable?: boolean;
  /** Keep the capability item count deterministic; all fields are required. */
  tokensRemaining?: number;
  /** Hold the cloud event tail open so an active run can be observed/cancelled. */
  holdCloudEvents?: boolean;
  /** First cloud submit loses its ack (ambiguous; same-key retry afterwards). */
  failFirstCloudSubmit?: boolean;
  /** First event replay ends EOF before a terminal; the reconnect succeeds. */
  truncateFirstEvents?: boolean;
  /** First event replay returns an ambiguous auth failure; refs survive. */
  unauthorizedFirstEventRead?: boolean;
  /** Fail the first N cloud capability reads to simulate a transient outage. */
  capabilityFailures?: number;
  /** Launcher mode: serve local discovery with pi missing and OpenCode ready. */
  launcherDiscovery?: boolean;
}

function localBackendDescriptor(
  backendId: "local-pi" | "local-codex" | "local-opencode",
  runtimeId: "pi" | "codex" | "opencode",
  displayName: string,
  available: boolean,
) {
  return {
    backendId,
    runtimeId,
    executionLocation: "local",
    displayName,
    available,
    ...(available
      ? {}
      : {
          unavailableReason: {
            code: "cli-not-installed",
            message: `${displayName} is not installed.`,
          },
        }),
    capabilities: {
      capabilityVersion: COACHING_CAPABILITY_VERSION,
      protocolVersion: COACHING_PROTOCOL_VERSION,
      tools: ["get_training_history", "analyze_progress"],
      productReplay: true,
      nativeContinuation: true,
      cancelConfirmation: "process-exit",
      maxInputBytes: 65_536,
      maxEvents: 1_000,
      maxEventBytes: 4 * 1024 * 1024,
      accountEligibility: "not-required",
      quotaReservation: "not-required",
      dataDestination: "cli-provider",
    },
  };
}

interface CloudTailHarness {
  push: (entry: CoachingEventEnvelope) => void;
  close: () => void;
}

function requestHeaders(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  const entries: Array<[string, string]> =
    raw === undefined
      ? []
      : raw instanceof Headers
        ? [...raw.entries()]
        : Array.isArray(raw)
          ? raw
          : Object.entries(raw as Record<string, string>);
  // Header names are case-insensitive; normalize so `Authorization` from the
  // auth client and `authorization` from the coach client read the same.
  return Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value]));
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string" || init.body === "") return null;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

function jsonData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(entries: CoachingEventEnvelope[]): Response {
  const text = entries.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function envelope(
  seq: number,
  event: CoachingEventEnvelope["event"],
  sessionId = CLOUD_SESSION,
  runId = CLOUD_RUN,
): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId, runId, seq, event };
}

function snapshot(accountId = FORMAL_A.id) {
  return {
    snapshotId: "snap-cloud",
    source: "supabase",
    accountId,
    recordIds: ["w-a"],
    recordCount: 1,
  };
}

function cloudRun(accountId = FORMAL_A.id, status = "running") {
  return {
    id: CLOUD_RUN,
    sessionId: CLOUD_SESSION,
    status,
    idempotencyKey: "key-cloud",
    prompt: "How is my squat progressing?",
    snapshot: snapshot(accountId),
    backendId: "cloud-default",
    runtimeId: "hosted-sdk",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:01.000Z",
    terminationConfirmed: status === "completed",
  };
}

function capabilities(options: RouterOptions) {
  const available = options.cloudAvailable !== false;
  return {
    enabled: available,
    providerConfigured: available,
    providerEnabled: available,
    accountFormal: true,
    quotaConfigured: true,
    budgetConfigured: true,
    concurrentLimit: 2,
    reservedCount: 0,
    tokensRemaining: options.tokensRemaining ?? 10_000,
    tokensReserved: 0,
    perRunTokenBudget: 2_000,
    perStepTokenBudget: 500,
    perRunRequestLimit: 20,
    tools: ["get_training_history", "analyze_progress"],
    maxSteps: 8,
    maxTokens: 10_000,
    timeoutMs: 600_000,
  };
}

function installRouter(seen: SeenRequest[], options: RouterOptions = {}): CloudTailHarness {
  const principals = new Map<string, Principal>([
    [FORMAL_A.token, FORMAL_A],
    [FORMAL_B.token, FORMAL_B],
    [GUEST.token, GUEST],
  ]);
  const tails: ReadableStreamDefaultController<Uint8Array>[] = [];
  let cloudSubmits = 0;
  let cloudEventReads = 0;
  let cloudCapabilityReads = 0;
  const tailHarness: CloudTailHarness = {
    push: (entry) => {
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(entry)}\n\n`);
      for (const tail of tails) {
        try {
          tail.enqueue(bytes);
        } catch {
          // Detached already.
        }
      }
    },
    close: () => {
      for (const tail of tails) {
        try {
          tail.close();
        } catch {
          // Detached already.
        }
      }
    },
  };
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = requestHeaders(init);
      seen.push({ url, method, body: parseBody(init), headers });
      const authorization = headers.authorization ?? null;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;
      const principal = token === null ? undefined : principals.get(token);

      if (url.endsWith("/api/v1/public-config")) {
        return jsonData({
          supabaseUrl: AUTH_BASE,
          supabasePublishableKey: "pub",
          guestSignInEnabled: true,
        });
      }

      if (url === `${AUTH_BASE}/auth/v1/signup`) return guestSignup();

      if (url === `${AUTH_BASE}/auth/v1/token?grant_type=password`) {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        const candidate = [FORMAL_A, FORMAL_B].find(
          (entry) => entry.email === body.email && entry.password === body.password,
        );
        if (candidate === undefined) {
          return new Response(JSON.stringify({ msg: "Invalid login credentials" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: candidate.token,
            refresh_token: `refresh-${candidate.id}`,
            expires_in: 3600,
            user: { id: candidate.id, email: candidate.email },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/user`) {
        if (principal === undefined) {
          return new Response(JSON.stringify({ msg: "bad token" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            id: principal.id,
            ...(principal.email === undefined ? {} : { email: principal.email }),
            is_anonymous: principal.isAnonymous,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === `${AUTH_BASE}/auth/v1/logout`) return new Response("{}", { status: 200 });

      function guestSignup(): Response {
        return new Response(
          JSON.stringify({
            access_token: GUEST.token,
            refresh_token: "refresh-guest-1",
            expires_in: 3600,
            user: { id: GUEST.id },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Launcher mode exposes local coaching on the bare `/coaching/*` base.
      if (options.launcherDiscovery === true && url.startsWith("/coaching/")) {
        if (principal === undefined) {
          return jsonError("UNAUTHENTICATED", "Missing bearer token.", 401);
        }
        if (url === "/coaching/bootstrap" && method === "POST") {
          return jsonData({ capability: "cap-local", expiresInMs: 600_000 });
        }
        if (url === "/coaching/capabilities") {
          return jsonData({
            discoveryVersion: 1,
            protocolVersion: COACHING_PROTOCOL_VERSION,
            tools: ["get_training_history", "analyze_progress"],
            backends: [
              localBackendDescriptor("local-pi", "pi", "pi CLI (local)", false),
              localBackendDescriptor("local-codex", "codex", "Codex CLI (local)", false),
              localBackendDescriptor("local-opencode", "opencode", "OpenCode CLI (local)", true),
            ],
          });
        }
        return jsonError("NOT_FOUND", `No route for ${method} ${url}`, 404);
      }

      if (url.startsWith("/api/v1/")) {
        if (principal === undefined) {
          return jsonError("UNAUTHENTICATED", "Missing bearer token.", 401);
        }
        if (url === "/api/v1/workouts" && method === "GET") {
          return jsonData([
            {
              schema_version: 1,
              id: "w-a",
              date: "2026-09-01",
              session_type: "strength",
              exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
            },
          ]);
        }
        // A plain browser never calls the launcher's local discovery route.
        if (url === "/api/v1/coaching/capabilities") {
          return jsonError("NOT_FOUND", "local discovery is launcher-only", 404);
        }
        if (url === "/api/v1/coaching/cloud/capabilities" && method === "GET") {
          if (principal.isAnonymous) {
            return jsonError("ACCOUNT_NOT_FORMAL", "Guests cannot use cloud coaching.", 403);
          }
          cloudCapabilityReads += 1;
          if (cloudCapabilityReads <= (options.capabilityFailures ?? 0)) {
            // Transient transport failure: the server never answered.
            throw new Error("socket hangup");
          }
          return jsonData(capabilities(options));
        }
        if (url === "/api/v1/coaching/cloud/sessions" && method === "POST") {
          return jsonData({ id: CLOUD_SESSION }, 201);
        }
        if (url === "/api/v1/coaching/cloud/snapshots" && method === "POST") {
          return jsonData(snapshot(principal.id), 201);
        }
        if (url === "/api/v1/coaching/cloud/runs" && method === "POST") {
          cloudSubmits += 1;
          if (options.failFirstCloudSubmit === true && cloudSubmits === 1) {
            throw new Error("socket hangup");
          }
          return jsonData({ run: cloudRun(principal.id), lastSeq: -1, replayed: false });
        }
        if (url.includes(`/api/v1/coaching/cloud/runs/${CLOUD_RUN}/events`)) {
          cloudEventReads += 1;
          if (options.unauthorizedFirstEventRead === true && cloudEventReads === 1) {
            return jsonError("UNAUTHORIZED", "Event stream token expired.", 401);
          }
          if (options.truncateFirstEvents === true) {
            if (cloudEventReads === 1) {
              // Bounded replay ends before the terminal: an honest disconnect,
              // not completion. The cursor is 0, so the reconnect asks seq 1.
              return sseResponse([
                envelope(0, { type: "text_delta", delta: "cloud answer" }),
              ]);
            }
            return sseResponse([
              envelope(1, { type: "terminal", status: "completed" }),
            ]);
          }
          if (options.holdCloudEvents === true) {
            const first = new TextEncoder().encode(
              `data: ${JSON.stringify(
                envelope(0, { type: "text_delta", delta: "partial cloud" }),
              )}\n\n`,
            );
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(first);
                tails.push(controller);
                // Stay open: the test pushes the terminal after cancel.
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }
          return sseResponse([
            envelope(0, { type: "text_delta", delta: "cloud answer" }),
            envelope(1, { type: "terminal", status: "completed" }),
          ]);
        }
        if (url.includes(`/api/v1/coaching/cloud/runs/${CLOUD_RUN}`) && method === "GET") {
          return jsonData({
            run: cloudRun(principal.id, "completed"),
            lastSeq: 1,
            firstSeq: 0,
            expiresAt: Date.now() + 600_000,
          });
        }
        if (url.includes(`/api/v1/coaching/cloud/sessions/${CLOUD_SESSION}`) && method === "GET") {
          return jsonData({ id: CLOUD_SESSION });
        }
        if (url.endsWith(`/api/v1/coaching/cloud/runs/${CLOUD_RUN}/cancel`)) {
          return jsonData({ run: cloudRun(principal.id, "cancelled"), lastSeq: 1 });
        }
        return jsonError("NOT_FOUND", `No route for ${method} ${url}`, 404);
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch,
  );
  return tailHarness;
}

async function signIn(user: ReturnType<typeof userEvent.setup>, principal: Principal): Promise<void> {
  await user.type(await screen.findByLabelText("Email"), principal.email ?? "");
  await user.type(screen.getByLabelText("Password"), principal.password ?? "");
  await user.click(screen.getByRole("button", { name: /^sign in$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
  vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
});

afterEach(() => {
  delete (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("browser coach backend selection", () => {
  it("shows Coach to a guest with local-only instructions and never requests cloud", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    // The Coach route is visible in a plain browser, before any guest sign-in.
    expect(await screen.findByRole("link", { name: /^coach$/i })).toBeInTheDocument();
    const guestButton = await screen.findByRole("button", { name: /continue as guest/i });
    await waitFor(() => expect(guestButton).toBeEnabled());
    await user.click(guestButton);

    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    expect(await screen.findByRole("heading", { level: 1, name: /^coach$/i })).toBeInTheDocument();
    expect(screen.getByTestId("coach-guest-local")).toHaveTextContent(/install pi/i);
    expect(screen.getByTestId("coach-guest-local")).toHaveTextContent(/agent-fit-trace start/);
    expect(screen.getByTestId("coach-guest-local")).toHaveTextContent(/formal account/i);
    expect(screen.getByTestId("coach-no-backends")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeDisabled();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.filter((entry) => entry.url.includes("/coaching/cloud"))).toHaveLength(0);
    expect(seen.filter((entry) => entry.url.endsWith("/coaching/capabilities"))).toHaveLength(0);
    expect(
      seen.filter((entry) => entry.method === "POST" && entry.url.includes("/coaching/")),
    ).toHaveLength(0);
  });

  it("advertises cloud only from server capabilities, defaults off, and submits exactly once to cloud", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));

    // Server capability response is the ONLY availability source; the run is
    // off by default so a credit-spending backend is never implicit.
    const select = await screen.findByTestId("coach-backend-select");
    expect(select).toHaveValue("");
    expect(screen.getByTestId("coach-backend-notice")).toHaveTextContent(/off by default/i);
    expect(screen.getByTestId("coach-backend-notice")).toHaveTextContent(/credits/i);
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeDisabled();

    await user.selectOptions(select, "cloud-default");
    expect(select).toHaveValue("cloud-default");
    expect(screen.getByTestId("coach-cloud-disclosure")).toHaveTextContent(/hosted cloud/i);
    expect(screen.getByTestId("coach-cloud-disclosure")).toHaveTextContent(/credits/i);
    // The account-scoped preference is written for the NEXT session.
    expect(window.localStorage.getItem("fit-trace.coach.backend.v1:user-a")).toBe("cloud-default");

    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    const ask = screen.getByRole("button", { name: /ask coach/i });
    expect(ask).toBeEnabled();
    await user.click(ask);

    expect(await screen.findByTestId("coach-text")).toHaveTextContent("cloud answer");

    const cloudPosts = seen.filter(
      (entry) => entry.url === "/api/v1/coaching/cloud/runs" && entry.method === "POST",
    );
    expect(cloudPosts).toHaveLength(1);
    // No local fallback and no second POST anywhere.
    expect(
      seen.filter((entry) => entry.url === "/api/v1/coaching/runs" && entry.method === "POST"),
    ).toHaveLength(0);
    // Bearer-only auth: cloud routes never carry a local capability header.
    for (const entry of seen.filter((item) => item.url.includes("/coaching/cloud"))) {
      expect(entry.headers.authorization).toBe("Bearer access-user-a");
      expect(entry.headers["x-fit-trace-capability"]).toBeUndefined();
    }
    const submitSnapshot = (cloudPosts[0]?.body as { snapshot?: Record<string, unknown> })
      ?.snapshot;
    expect(submitSnapshot).toMatchObject({ snapshotId: "snap-cloud", accountId: "user-a" });
    expect(submitSnapshot).not.toHaveProperty("recordIds");

    // Resume v2 carries the cloud origin and cursor; no fake v1 pi record.
    const resume = JSON.parse(window.sessionStorage.getItem(RESUME_V2_KEY) ?? "null") as {
      backendId?: string;
      origin?: string;
      lastSeq?: number;
    };
    expect(resume.backendId).toBe("cloud-default");
    expect(resume.origin).toBe("cloud");
    expect(resume.lastSeq).toBe(1);
    expect(window.sessionStorage.getItem(RESUME_V1_KEY)).toBeNull();
  });

  it("recovers cloud availability after a transient discovery failure with a bounded retry", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen, { capabilityFailures: 1 });
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));

    // A brief outage replaces cloud with an unavailable option. It must not be
    // a dead end until reload: an explicit, bounded retry is offered.
    expect(await screen.findByTestId("coach-backend-notice")).toHaveTextContent(
      /could not be verified/i,
    );
    expect(screen.getByTestId("coach-backend-select")).toHaveValue("");
    const retry = screen.getByTestId("coach-retry-backend-discovery");

    await user.click(retry);

    // The retried capability response is authoritative: cloud becomes
    // selectable and both the failure notice and the retry affordance clear.
    await waitFor(() =>
      expect(screen.queryByTestId("coach-retry-backend-discovery")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("coach-backend-notice")).toHaveTextContent(/off by default/i);
    expect(screen.getByRole("option", { name: /^Cloud coach$/ })).not.toBeDisabled();

    await user.selectOptions(screen.getByTestId("coach-backend-select"), "cloud-default");
    expect(screen.getByTestId("coach-cloud-disclosure")).toHaveTextContent(/hosted cloud/i);

    const capabilityReads = seen.filter(
      (entry) => entry.url === "/api/v1/coaching/cloud/capabilities",
    );
    expect(capabilityReads).toHaveLength(2);
  });

  it("replays a stored cloud run from its resume record with no selector and no POST", async () => {
    window.sessionStorage.setItem(
      RESUME_V2_KEY,
      JSON.stringify({
        version: 2,
        accountId: FORMAL_A.id,
        backendId: "cloud-default",
        origin: "cloud",
        sessionId: CLOUD_SESSION,
        runId: CLOUD_RUN,
        lastSeq: 1,
      }),
    );
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));

    expect(await screen.findByTestId("coach-text")).toHaveTextContent("cloud answer");
    // The selector stayed unselected (off by default), yet the run replays on
    // the backend named by the resume record.
    expect(screen.getByTestId("coach-backend-select")).toHaveValue("");
    const replay = seen.find((entry) => entry.url.includes(`/coaching/cloud/runs/${CLOUD_RUN}/events`));
    expect(replay).toBeDefined();
    expect(replay?.url).toContain("fromSeq=0");
    expect(
      seen.filter((entry) => entry.url.includes("/coaching/cloud/runs") && entry.method === "POST"),
    ).toHaveLength(0);
    expect(seen.filter((entry) => entry.url.endsWith("/coaching/bootstrap"))).toHaveLength(0);
  });

  it("does not inherit the previous account's cloud preference or run", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    await user.selectOptions(await screen.findByTestId("coach-backend-select"), "cloud-default");
    expect(window.localStorage.getItem("fit-trace.coach.backend.v1:user-a")).toBe("cloud-default");

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();

    await signIn(user, FORMAL_B);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));

    // B has no stored preference: the selector is unselected, cloud stays off,
    // and A's preference is not consumed.
    expect(await screen.findByTestId("coach-backend-select")).toHaveValue("");
    expect(screen.getByTestId("coach-backend-notice")).toHaveTextContent(/off by default/i);
    expect(window.localStorage.getItem("fit-trace.coach.backend.v1:user-b")).toBeNull();
    expect(window.localStorage.getItem("fit-trace.coach.backend.v1:user-a")).toBe("cloud-default");
    expect(screen.queryByTestId("coach-text")).not.toBeInTheDocument();
  });

  it("locks the selector while the cloud replay is in flight and cancels on its pinned backend", async () => {
    const seen: SeenRequest[] = [];
    const harness = installRouter(seen, { holdCloudEvents: true });
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    const select = await screen.findByTestId("coach-backend-select");
    await user.selectOptions(select, "cloud-default");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    // The cloud transport is a bounded replay: while the event response is
    // open, the run is active even though no text has folded yet.
    await waitFor(() =>
      expect(seen.some((entry) => entry.url.includes("/coaching/cloud/runs/run-cloud/events"))).toBe(
        true,
      ),
    );
    // Active run: the NEXT-run selector is locked, so no mid-run switch can
    // redirect replay/cancel.
    expect(select).toBeDisabled();
    expect(select).toHaveValue("cloud-default");
    expect(screen.getByTestId("coach-active-backend")).toHaveTextContent(/cloud/i);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/cancelling coach run/i)).toBeInTheDocument();
    harness.push(envelope(1, { type: "terminal", status: "cancelled" }));
    harness.close();
    expect(await screen.findByTestId("coach-cancelled")).toBeInTheDocument();

    const cancel = seen.filter((entry) => entry.url.endsWith(`/coaching/cloud/runs/${CLOUD_RUN}/cancel`));
    expect(cancel).toHaveLength(1);
    expect(cancel[0]?.headers.authorization).toBe("Bearer access-user-a");
    expect(seen.filter((entry) => entry.url.includes("/coaching/runs/"))).toHaveLength(0);
  });

  it("keeps an ambiguous submit pinned: the same-key retry stays on cloud and never falls back", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen, { failFirstCloudSubmit: true });
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    const select = await screen.findByTestId("coach-backend-select");
    await user.selectOptions(select, "cloud-default");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    // Unknown POST outcome: Retry resolves the SAME key, and the selector
    // stays locked to the pinned backend for the unresolved request.
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
    expect(select).toBeDisabled();
    expect(select).toHaveValue("cloud-default");

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("coach-text")).toHaveTextContent("cloud answer");

    const posts = seen.filter(
      (entry) => entry.url === "/api/v1/coaching/cloud/runs" && entry.method === "POST",
    );
    expect(posts).toHaveLength(2);
    const keys = posts.map((entry) => (entry.body as { idempotencyKey?: string })?.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    // An unknown prior request is resolved, never moved to a fresh session.
    expect(
      seen.filter(
        (entry) => entry.url === "/api/v1/coaching/cloud/sessions" && entry.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      seen.filter((entry) => entry.url === "/api/v1/coaching/runs" && entry.method === "POST"),
    ).toHaveLength(0);
  });

  it("does not disable an available cloud backend when the pi CLI is missing", async () => {
    (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
      piAvailable: false,
    };
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    expect(await screen.findByTestId("coach-backend-select")).toBeInTheDocument();
    expect(screen.queryByTestId("coach-pi-unavailable")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("coach-backend-select"), "cloud-default");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeEnabled();
    expect(screen.getByTestId("coach-cloud-disclosure")).toHaveTextContent(/hosted cloud/i);
    expect(screen.queryByTestId("coach-pi-unavailable")).not.toBeInTheDocument();
  });

  it("keeps another local runtime selectable and labels its disclosure when pi is missing", async () => {
    (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
      mode: "http",
      coaching: "same-origin",
      piAvailable: false,
    };
    const seen: SeenRequest[] = [];
    installRouter(seen, { launcherDiscovery: true });
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    const select = await screen.findByTestId("coach-backend-select");
    await waitFor(() =>
      expect(seen.some((entry) => entry.url.endsWith("/coaching/bootstrap"))).toBe(true),
    );

    // The unavailable DEFAULT (pi) explains itself; that must not disable the
    // available OpenCode option or replace its disclosure with a pi label.
    await waitFor(() => expect(select).toHaveValue("local-pi"));
    expect(await screen.findByRole("option", { name: /OpenCode CLI \(local\)/i })).toBeInTheDocument();
    expect(screen.getByTestId("coach-pi-unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeDisabled();

    await user.selectOptions(select, "local-opencode");
    expect(screen.queryByTestId("coach-pi-unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("coach-local-disclosure")).toHaveTextContent(/OpenCode CLI \(local\)/);
    expect(screen.getByTestId("coach-local-disclosure")).toHaveTextContent(/cli-provider|model provider/i);
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    expect(screen.getByRole("button", { name: /ask coach/i })).toBeEnabled();

    // Launcher discovery stays local; no cloud capability traffic.
    expect(seen.filter((entry) => entry.url.includes("/coaching/cloud"))).toHaveLength(0);
  });

  it("tails a cloud replay across GET page boundaries without a new run POST", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen, { truncateFirstEvents: true });
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    await user.selectOptions(await screen.findByTestId("coach-backend-select"), "cloud-default");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    // A successful page ending before the terminal is a NORMAL long-poll
    // boundary: the client continues the same run automatically. It must not
    // turn a 15s server page into a user-visible disconnect.
    expect(await screen.findByRole("button", { name: /new analysis/i })).toBeInTheDocument();
    expect(screen.getByTestId("coach-text")).toHaveTextContent("cloud answer");
    expect(screen.queryByRole("button", { name: /^reconnect$/i })).not.toBeInTheDocument();

    await waitFor(() =>
      expect(
        seen.filter((entry) => entry.url.includes(`/coaching/cloud/runs/${CLOUD_RUN}/events`)),
      ).toHaveLength(2),
    );
    const replays = seen.filter((entry) =>
      entry.url.includes(`/coaching/cloud/runs/${CLOUD_RUN}/events`),
    );
    expect(replays[0]?.url).toContain("fromSeq=0");
    expect(replays[1]?.url).toContain("fromSeq=1");
    expect(replays[1]?.headers.authorization).toBe("Bearer access-user-a");
    expect(
      seen.filter((entry) => entry.url === "/api/v1/coaching/cloud/runs" && entry.method === "POST"),
    ).toHaveLength(1);
    expect(
      seen.filter((entry) => entry.url === "/api/v1/coaching/runs" && entry.method === "POST"),
    ).toHaveLength(0);
  });

  it("keeps an ambiguous cloud event 401 resumable on the same run", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen, { unauthorizedFirstEventRead: true });
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));
    await user.selectOptions(await screen.findByTestId("coach-backend-select"), "cloud-default");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));

    // A 401 while tailing is ambiguous: the run may still be live server-side.
    // Keep the run id / backend / cursor refs and offer the same-run reconnect.
    expect(await screen.findByTestId("coach-error")).toHaveTextContent(/UNAUTHORIZED/);
    const reconnect = await screen.findByRole("button", { name: /^reconnect$/i });
    const retained = JSON.parse(window.sessionStorage.getItem(RESUME_V2_KEY) ?? "null") as {
      backendId?: string;
      origin?: string;
      runId?: string;
      lastSeq?: number;
    };
    expect(retained).toEqual(
      expect.objectContaining({
        backendId: "cloud-default",
        origin: "cloud",
        runId: CLOUD_RUN,
        lastSeq: -1,
      }),
    );

    await user.click(reconnect);
    expect(await screen.findByRole("button", { name: /new analysis/i })).toBeInTheDocument();
    const replays = seen.filter((entry) =>
      entry.url.includes(`/coaching/cloud/runs/${CLOUD_RUN}/events`),
    );
    expect(replays).toHaveLength(2);
    expect(replays[1]?.url).toContain("fromSeq=0");
    expect(
      seen.filter((entry) => entry.url === "/api/v1/coaching/cloud/runs" && entry.method === "POST"),
    ).toHaveLength(1);
  });

  it("keeps an unsupported local resume and asks for the original connector instead of cloud", async () => {
    window.sessionStorage.setItem(
      RESUME_V1_KEY,
      JSON.stringify({
        version: 1,
        accountId: FORMAL_A.id,
        sessionId: "sess-local",
        runId: "run-local",
      }),
    );
    const seen: SeenRequest[] = [];
    installRouter(seen);
    const user = userEvent.setup();
    render(<App />);

    await signIn(user, FORMAL_A);
    await user.click(await screen.findByRole("link", { name: /^coach$/i }));

    const blocked = await screen.findByTestId("coach-resume-blocked");
    expect(blocked).toHaveTextContent(/local pi coach/i);
    expect(blocked).toHaveTextContent(/agent-fit-trace start/);
    expect(blocked).toHaveTextContent(/not replayed/i);

    // The record is retained with its original backend; nothing was replayed
    // through cloud or replaced by a new cloud run.
    const retained = JSON.parse(window.sessionStorage.getItem(RESUME_V1_KEY) ?? "null") as {
      backendId?: string;
      runId?: string;
    };
    expect(retained).toEqual(
      expect.objectContaining({ runId: "run-local" }),
    );
    expect(window.sessionStorage.getItem(RESUME_V2_KEY)).toBeNull();
    expect(seen.filter((entry) => entry.url.includes("/coaching/cloud/runs"))).toHaveLength(0);
    expect(seen.filter((entry) => entry.url.endsWith("/coaching/capabilities"))).toHaveLength(0);
    expect(
      seen.filter((entry) => entry.method === "POST" && entry.url.includes("/coaching/")),
    ).toHaveLength(0);
  });

  it("cleans a switched-away cloud run with its original client, never a later local backend", async () => {
    const seen: SeenRequest[] = [];
    installRouter(seen, { holdCloudEvents: true });
    const user = userEvent.setup();

    function SwitchToB() {
      const { signIn } = useAuth();
      return (
        <button type="button" onClick={() => void signIn("b@example.com", "pw-b-1234")}>
          switch to b
        </button>
      );
    }
    function SignOutCurrent() {
      const { signOutSession, status } = useAuth();
      const coach = useCoach();
      return (
        <>
          <span data-testid="auth-status">{status}</span>
          <button
            type="button"
            onClick={() => {
              coach.teardown();
              void signOutSession();
            }}
          >
            sign out current
          </button>
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={["/coach"]}>
        <AuthProvider
          publicConfig={{ supabaseUrl: AUTH_BASE, supabasePublishableKey: "pub" }}
          initialSession={{
            accessToken: FORMAL_A.token,
            refreshToken: "refresh-user-a",
            expiresAt: Date.now() + 3_600_000,
            user: { id: FORMAL_A.id, email: FORMAL_A.email },
          }}
        >
          <WorkoutStoreProvider
            client={new FakeFitTraceClient({
              records: [
                {
                  schema_version: 1,
                  id: "w-a",
                  date: "2026-09-01",
                  session_type: "strength",
                  exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
                },
              ],
            })}
          >
            <SwitchToB />
            <CoachingProvider>
              <SignOutCurrent />
              <Routes>
                <Route path="/coach" element={<CoachScreen />} />
              </Routes>
            </CoachingProvider>
          </WorkoutStoreProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId("coach-backend-select");
    await user.selectOptions(screen.getByTestId("coach-backend-select"), "cloud-default");
    await user.type(screen.getByLabelText(/analysis question/i), "How is my squat progressing?");
    await user.click(screen.getByRole("button", { name: /ask coach/i }));
    await waitFor(() =>
      expect(seen.some((entry) => entry.url.includes(`/coaching/cloud/runs/${CLOUD_RUN}/events`))).toBe(
        true,
      ),
    );

    await user.click(screen.getByRole("button", { name: /switch to b/i }));
    await waitFor(() =>
      expect(
        seen.filter((entry) => entry.url.endsWith(`/coaching/cloud/runs/${CLOUD_RUN}/cancel`)),
      ).toHaveLength(1),
    );
    const cancel = seen.find((entry) =>
      entry.url.endsWith(`/coaching/cloud/runs/${CLOUD_RUN}/cancel`),
    );
    // The old cloud run is cleaned up by A's captured cloud client + bearer.
    expect(cancel?.headers.authorization).toBe("Bearer access-user-a");
    expect(seen.filter((entry) => entry.url.includes("/coaching/runs/"))).toHaveLength(0);
    expect(await screen.findByTestId("coach-backend-select")).toHaveValue("");

    // B never started a run: signing B out must not cancel A's run again or
    // route it through B's/local backend.
    await user.click(screen.getByRole("button", { name: /sign out current/i }));
    await waitFor(() => expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      seen.filter((entry) => entry.url.endsWith(`/coaching/cloud/runs/${CLOUD_RUN}/cancel`)),
    ).toHaveLength(1);
    expect(seen.filter((entry) => entry.url.includes("/coaching/runs/"))).toHaveLength(0);
  });
});
