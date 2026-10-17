import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_MAX_FILENAME_LENGTH } from "@pi-fit-trace/api-contracts";
import type { FitTraceClient, PublicApiConfig } from "@pi-fit-trace/api-contracts";
import { analyzeProgress, generateNextPlan, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { readTextFile } from "../api/fileTransport.ts";
import { AuthProvider, useAuth } from "../auth/AuthContext.tsx";
import type { SupabaseSession } from "../auth/supabaseAuth.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { saveRecord } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";
import { FakeFitTraceClient, clientFor, deferred } from "../test/asyncClient.ts";
import { MeScreen } from "./MeScreen.tsx";

vi.mock("../api/fileTransport.ts", () => ({
  downloadJson: vi.fn(),
  readTextFile: vi.fn(),
}));

// The shared guest control calls the account-level coach teardown before auth
// sign-out. The Me test doubles only that one hook; the rest of the module
// stays real for type and provider parity.
const { coachTeardown } = vi.hoisted(() => ({ coachTeardown: vi.fn() }));
vi.mock("../coaching/useCoach.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../coaching/useCoach.ts")>();
  return {
    ...actual,
    useCoach: () => ({ teardown: coachTeardown }) as never,
  };
});

const readTextFileMock = vi.mocked(readTextFile);

function record(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return validateWorkoutRecord({
    id: "wkt_me",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  }).record;
}

const sessionA: SupabaseSession = {
  accessToken: "token-a",
  refreshToken: "refresh-a",
  expiresAt: 0,
  user: { id: "user-a", email: "a@example.com" },
};

const guestSession: SupabaseSession = {
  accessToken: "token-guest",
  refreshToken: "refresh-guest",
  expiresAt: 0,
  user: { id: "guest-me", isAnonymous: true },
};

const guestConfig: PublicApiConfig = {
  supabaseUrl: "http://auth.invalid",
  supabasePublishableKey: "pub",
  guestUpgradeEnabled: true,
};

/** Test-only controls for account transitions and explicit history refreshes. */
function TestControls() {
  const { signOutSession, beginGuestUpgrade, completeGuestUpgrade } = useAuth();
  const { reload } = useWorkouts();
  return (
    <div>
      <button type="button" onClick={() => void signOutSession()}>
        test sign out
      </button>
      <button type="button" onClick={reload}>
        test reload history
      </button>
      <button type="button" onClick={() => void beginGuestUpgrade("invite@example.com")}>
        test begin upgrade
      </button>
      <button
        type="button"
        onClick={() =>
          void completeGuestUpgrade({
            accessToken: "callback-access",
            refreshToken: "callback-refresh",
            type: "email_change",
            expiresAt: 0,
          })
        }
      >
        test complete upgrade
      </button>
    </div>
  );
}

function renderMe(
  source: MemoryStorageAdapter | FitTraceClient = new MemoryStorageAdapter(),
  options: {
    initialSession?: SupabaseSession | null;
    publicConfig?: PublicApiConfig;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const client = source instanceof MemoryStorageAdapter ? clientFor(source) : source;
  return render(
    <MemoryRouter initialEntries={["/me"]}>
      <AuthProvider
        skipBootstrap
        initialSession={options.initialSession ?? null}
        fetchImpl={options.fetchImpl}
        {...(options.publicConfig === undefined ? {} : { publicConfig: options.publicConfig })}
      >
        <WorkoutStoreProvider client={client}>
          <TestControls />
          <Routes>
            <Route path="/me" element={<MeScreen />} />
            <Route path="/analysis" element={<div data-testid="analysis-target" />} />
            <Route path="/plan" element={<div data-testid="plan-target" />} />
            <Route path="/login" element={<div data-testid="login-target" />} />
          </Routes>
        </WorkoutStoreProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function upload(label: string, body: string, name: string): Promise<void> {
  readTextFileMock.mockResolvedValueOnce(body);
  const file = new File([body], name, { type: "application/json" });
  await userEvent.upload(screen.getByLabelText(label), file);
}

describe("MeScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("presents the four operations, account scope and guest honesty", async () => {
    renderMe(new MemoryStorageAdapter());

    expect(screen.getByRole("heading", { name: "Export workouts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Import workouts" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Import progress analysis" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Import a training plan" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/storage scope: local mode/i)).toBeInTheDocument();
    expect(screen.getByText(/this browser on this device/i)).toBeInTheDocument();
    expect(screen.queryByText(/actions arrive with/i)).not.toBeInTheDocument();
  });

  it("previews and sequentially appends workout records with an indexed receipt", async () => {
    const adapter = new MemoryStorageAdapter();
    renderMe(adapter);
    await screen.findByText(/signed in as|local session/i);

    const fileBody = JSON.stringify({
      schema_version: 1,
      records: [record({ id: "wkt_imported" }), record({ id: "wkt_imported" })],
    });
    await upload("Choose workout backup file", fileBody, "workout.json");

    expect(await screen.findByTestId("me-workout-preview")).toHaveTextContent(
      /1 unique record\(s\), 2 file index\(es\)/,
    );
    await userEvent.click(screen.getByRole("button", { name: /confirm append/i }));

    const receipt = await screen.findByTestId("me-workout-receipt");
    expect(receipt).toHaveTextContent(/created 1 · duplicate 1/i);
    expect(receipt).toHaveTextContent(/records\[0\] wkt_imported: created/);
    expect(receipt).toHaveTextContent(/records\[1\] wkt_imported: duplicate/);
    await waitFor(() => expect(screen.queryByText(/Importing…/)).not.toBeInTheDocument());
  });

  it("blocks confirmation when current history conflicts with the file", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(
      adapter,
      record({
        id: "wkt_imported",
        exercises: [{ name: "Squat", sets: [{ weight: 140, reps: 3, rpe: 9 }] }],
      }),
    );
    renderMe(adapter);
    await screen.findByText(/signed in as|local session/i);

    await upload(
      "Choose workout backup file",
      JSON.stringify({ schema_version: 1, records: [record({ id: "wkt_imported" })] }),
      "workout.json",
    );

    expect(await screen.findByText(/block the whole import/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm append/i })).toBeDisabled();
  });

  it("saves an analysis snapshot without selecting or adopting it", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    const analysis = analyzeProgress([record()]);
    renderMe(adapter);
    await screen.findByText(/signed in as|local session/i);

    await upload(
      "Choose analysis file",
      JSON.stringify(analysis),
      "analysis.json",
    );
    await userEvent.click(await screen.findByRole("button", { name: /save analysis snapshot/i }));

    const saved = await screen.findByTestId("me-analysis-saved");
    expect(saved).toHaveTextContent(/snapshot saved/i);
    expect(saved).toHaveTextContent(/file analysis\.json/);
    // Saving is not viewing.
    expect(await client.getArtifactSelection("analysis")).toEqual({ artifact_id: null });

    await userEvent.click(screen.getByRole("button", { name: /view saved analysis snapshot/i }));
    await waitFor(async () =>
      expect(await client.getArtifactSelection("analysis")).not.toEqual({ artifact_id: null }),
    );
  });

  it("saves a plan snapshot as a draft without adopting it", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    const plan = generateNextPlan([record()]);
    renderMe(adapter);
    await screen.findByText(/signed in as|local session/i);

    await upload("Choose plan file", JSON.stringify(plan), "plan.json");
    await userEvent.click(await screen.findByRole("button", { name: /save plan snapshot/i }));

    const saved = await screen.findByTestId("me-plan-saved");
    expect(saved).toHaveTextContent(/snapshot saved/i);
    expect(await client.getPlanAdoption()).toBeNull();
  });

  it("rejects invalid files before any write", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    renderMe(adapter);
    await screen.findByText(/signed in as|local session/i);

    await upload("Choose workout backup file", "{ not json", "workout.json");

    expect(await screen.findByTestId("me-workout-file-error")).toHaveTextContent(
      /not valid JSON/i,
    );
    expect(await client.listWorkouts()).toEqual([]);
    expect(screen.queryByRole("button", { name: /confirm append/i })).not.toBeInTheDocument();
  });

  it("treats an empty workout backup as an explicit no-op", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    renderMe(client);
    await screen.findByText(/local session/i);

    await upload(
      "Choose workout backup file",
      JSON.stringify({ schema_version: 1, records: [] }),
      "empty.json",
    );

    expect(await screen.findByTestId("me-workout-noop")).toHaveTextContent(
      /no workout records/i,
    );
    expect(screen.getByRole("button", { name: /confirm append/i })).toBeDisabled();
    expect(client.createCalls).toBe(0);
    expect(screen.queryByTestId("me-workout-receipt")).not.toBeInTheDocument();
  });

  it("waits for workout history before allowing an import", async () => {
    const client = new FakeFitTraceClient();
    const history = deferred<WorkoutRecord[]>();
    client.listWorkouts = () => history.promise;
    renderMe(client);

    const input = screen.getByLabelText("Choose workout backup file");
    expect(input).toBeDisabled();
    expect(screen.getByText(/loading workout history before import/i)).toBeInTheDocument();

    await act(async () => history.resolve([]));
    await waitFor(() => expect(input).toBeEnabled());
  });

  it("reads the file against history that settled while the read was pending", async () => {
    const client = new FakeFitTraceClient();
    const reload = deferred<WorkoutRecord[]>();
    let calls = 0;
    client.listWorkouts = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve([]) : reload.promise;
    };
    renderMe(client);
    await waitFor(() =>
      expect(screen.getByLabelText("Choose workout backup file")).toBeEnabled(),
    );

    const read = deferred<string>();
    readTextFileMock.mockReturnValueOnce(read.promise);
    const file = new File([""], "workout.json", { type: "application/json" });
    await userEvent.upload(screen.getByLabelText("Choose workout backup file"), file);

    await userEvent.click(screen.getByRole("button", { name: /test reload history/i }));
    await act(async () =>
      reload.resolve([
        record({
          id: "wkt_imported",
          exercises: [{ name: "Squat", sets: [{ weight: 140, reps: 3, rpe: 9 }] }],
        }),
      ]),
    );
    await act(async () =>
      read.resolve(
        JSON.stringify({ schema_version: 1, records: [record({ id: "wkt_imported" })] }),
      ),
    );

    expect(await screen.findByText(/block the whole import/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm append/i })).toBeDisabled();
  });

  it("drops a delayed file read after the owner changes", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    renderMe(client, { initialSession: sessionA });
    await screen.findByText(/signed in as a@example.com/i);

    const read = deferred<string>();
    readTextFileMock.mockReturnValueOnce(read.promise);
    const file = new File([""], "workout.json", { type: "application/json" });
    await userEvent.upload(screen.getByLabelText("Choose workout backup file"), file);

    await userEvent.click(screen.getByRole("button", { name: /test sign out/i }));
    await waitFor(() =>
      expect(screen.getByTestId("me-account-identity")).toHaveTextContent(/local session/i),
    );

    await act(async () =>
      read.resolve(
        JSON.stringify({ schema_version: 1, records: [record({ id: "wkt_imported" })] }),
      ),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("me-workout-preview")).not.toBeInTheDocument(),
    );
    expect(client.createCalls).toBe(0);
  });

  it("invalidates a stale workout preview when the owner changes", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    renderMe(client, { initialSession: sessionA });
    await screen.findByText(/signed in as a@example.com/i);

    await upload(
      "Choose workout backup file",
      JSON.stringify({ schema_version: 1, records: [record({ id: "wkt_imported" })] }),
      "workout.json",
    );
    expect(await screen.findByTestId("me-workout-preview")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /test sign out/i }));
    await waitFor(() =>
      expect(screen.getByTestId("me-account-identity")).toHaveTextContent(/local session/i),
    );

    expect(screen.queryByTestId("me-workout-preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm append/i })).not.toBeInTheDocument();
    expect(client.createCalls).toBe(0);
  });

  it("stops unstarted workout records when unmounted during a run", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    const first = client.nextCreate();
    const view = renderMe(client);
    await screen.findByText(/local session/i);

    await upload(
      "Choose workout backup file",
      JSON.stringify({
        schema_version: 1,
        records: [record({ id: "wkt_one" }), record({ id: "wkt_two" })],
      }),
      "workout.json",
    );
    await userEvent.click(await screen.findByRole("button", { name: /confirm append/i }));

    await waitFor(() => expect(client.createCalls).toBe(1));
    view.unmount();
    await act(async () => {
      first.resolve({ record: record({ id: "wkt_one" }), duplicate: false, warnings: [] });
      await Promise.resolve();
    });

    expect(client.createCalls).toBe(1);
  });

  it("rejects an overlong source filename instead of truncating it", async () => {
    renderMe(new MemoryStorageAdapter());
    await screen.findByText(/local session/i);

    await upload(
      "Choose plan file",
      JSON.stringify(generateNextPlan([record()])),
      "f".repeat(IMPORT_MAX_FILENAME_LENGTH + 1),
    );

    expect(await screen.findByTestId("me-plan-read-error")).toHaveTextContent(
      /source_filename/,
    );
    expect(screen.queryByTestId("me-plan-preview")).not.toBeInTheDocument();
  });

  it("shows the stored filename and draft status on a duplicate plan save", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    renderMe(adapter);
    await screen.findByText(/local session/i);

    const planBody = JSON.stringify(generateNextPlan([record()]));
    await upload("Choose plan file", planBody, "original-plan.json");
    await userEvent.click(await screen.findByRole("button", { name: /save plan snapshot/i }));
    expect(await screen.findByTestId("me-plan-saved")).toBeInTheDocument();

    await upload("Choose plan file", planBody, "renamed-plan.json");
    await userEvent.click(await screen.findByRole("button", { name: /save plan snapshot/i }));

    const saved = await screen.findByTestId("me-plan-saved");
    expect(saved).toHaveTextContent(/already saved \(duplicate\)/i);
    expect(saved).toHaveTextContent(/remains a draft and was not adopted/i);
    expect(saved).toHaveTextContent(/stored file original-plan\.json/i);
    expect(await client.getPlanAdoption()).toBeNull();
  });

  it("rejects a malformed bare analysis file without saving or selecting it", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    renderMe(adapter);
    await screen.findByText(/local session/i);

    await upload(
      "Choose analysis file",
      JSON.stringify({ period: { from: null, to: null }, metrics: {} }),
      "analysis.json",
    );

    const alert = await screen.findByTestId("me-analysis-read-error");
    expect(alert).toHaveTextContent(/metrics/i);
    expect(screen.queryByTestId("me-analysis-preview")).not.toBeInTheDocument();
    expect(await client.listImportedArtifacts({ kind: "analysis" })).toEqual({
      items: [],
      next_cursor: null,
    });
    expect(await client.getArtifactSelection("analysis")).toEqual({ artifact_id: null });
  });

  it("rejects a malformed bare plan file without saving, selecting or adopting it", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    renderMe(adapter);
    await screen.findByText(/local session/i);

    await upload(
      "Choose plan file",
      JSON.stringify({
        is_draft: true,
        requires_confirmation: true,
        based_on: { period: { from: null, to: null }, sessions: 1, source_records: [] },
        recommendations: {},
        safety_notes: [],
        professional_care_prompt: null,
      }),
      "plan.json",
    );

    const alert = await screen.findByTestId("me-plan-read-error");
    expect(alert).toHaveTextContent(/recommendations/i);
    expect(screen.queryByTestId("me-plan-preview")).not.toBeInTheDocument();
    expect(await client.listImportedArtifacts({ kind: "plan" })).toEqual({
      items: [],
      next_cursor: null,
    });
    expect(await client.getArtifactSelection("plan")).toEqual({ artifact_id: null });
    expect(await client.getPlanAdoption()).toBeNull();
  });

  it("offers the full guest upgrade entry and account switch on Me", async () => {
    renderMe(new MemoryStorageAdapter(), {
      initialSession: guestSession,
      publicConfig: guestConfig,
    });
    await screen.findByText(/signed in as guest-me \(guest identity\)/i);

    // The reusable full component is the single owner of these operations.
    await userEvent.click(screen.getByText(/upgrade to an account/i));
    expect(screen.getByText(/upgrade to an account/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invited email/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in to an existing account/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out guest/i })).toBeInTheDocument();
  });

  it("keeps password setup visible for a verified same-UID account on Me", async () => {
    let updateCalls = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/user") && init?.method === "PUT") {
        updateCalls += 1;
        return new Response("{}", { status: 200 });
      }
      if (target.endsWith("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "guest-me",
            email: "invite@example.com",
            is_anonymous: false,
            email_confirmed_at: "2026-10-17T00:00:00Z",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    renderMe(new MemoryStorageAdapter(), {
      initialSession: guestSession,
      publicConfig: guestConfig,
      fetchImpl,
    });
    await screen.findByText(/signed in as guest-me \(guest identity\)/i);

    await userEvent.click(screen.getByRole("button", { name: /test begin upgrade/i }));
    await waitFor(() => expect(updateCalls).toBe(1));
    // Pending verification is not success: no password setup yet.
    expect(screen.queryByRole("link", { name: /set a password/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /test complete upgrade/i }));

    const link = await screen.findByRole("link", { name: /set a password/i });
    expect(link).toHaveAttribute("href", "/reset-password");
    // The verified callback promoted the same UID in place: this is a formal
    // account now, and the notice survives outside the guest-only controls.
    expect(screen.getByTestId("me-account-identity")).toHaveTextContent(
      /signed in as invite@example\.com/i,
    );
    expect(screen.getByTestId("me-account-identity")).not.toHaveTextContent(/guest identity/i);
    expect(
      screen.queryByRole("button", { name: /sign out guest/i }),
    ).not.toBeInTheDocument();
  });

  it("signs the same guest identity out through the shared control after teardown", async () => {
    renderMe(new MemoryStorageAdapter(), { initialSession: guestSession });
    await screen.findByText(/signed in as guest-me \(guest identity\)/i);

    await userEvent.click(screen.getByRole("button", { name: /sign out guest/i }));
    expect(
      screen.getByText(/may be lost and cannot be guaranteed recoverable/i),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /sign out and lose guest access/i }),
    );

    expect(coachTeardown).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("login-target")).toBeInTheDocument();
  });

  it("combines preview and server warnings without dropping either", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    const save = client.saveImportedArtifact.bind(client);
    client.saveImportedArtifact = async (input) => {
      const result = await save(input);
      return {
        ...result,
        warnings: [...result.warnings, { code: "SERVER_WARNING", message: "server warning" }],
      };
    };
    renderMe(client);
    await screen.findByText(/local session/i);

    await upload(
      "Choose analysis file",
      JSON.stringify({ ...analyzeProgress([record()]), extra_field: true }),
      "analysis.json",
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /save analysis snapshot/i }),
    );

    const saved = await screen.findByTestId("me-analysis-saved");
    expect(saved).toHaveTextContent(/Unknown field `extra_field`/);
    expect(saved).toHaveTextContent(/server warning/);
  });
});
