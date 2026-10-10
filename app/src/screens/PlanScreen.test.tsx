import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanDraft, WorkoutRecord } from "@pi-fit-trace/core";
import { generateNextPlan } from "@pi-fit-trace/core";
import { readTextFile } from "../api/fileTransport.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { loadRecords, saveRecord } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider, useWorkoutStore } from "../state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";
import { PlanScreen } from "./PlanScreen.tsx";

vi.mock("../api/fileTransport.ts", () => ({
  downloadJson: vi.fn(),
  readTextFile: vi.fn(),
}));

const readTextFileMock = vi.mocked(readTextFile);

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

const importedPlan: PlanDraft = {
  is_draft: true,
  requires_confirmation: true,
  goal: "Imported goal",
  based_on: {
    period: { from: "2026-02-01", to: "2026-02-28" },
    sessions: 12,
    source_records: ["wkt_x", "wkt_y"],
  },
  recommendations: [
    {
      action: "imported_action",
      detail: "Imported detail.",
      reason: "Imported reason.",
      evidence: { imported_metric: 42 },
    },
  ],
  safety_notes: ["Imported safety note."],
  professional_care_prompt: null,
};

const carePlan: PlanDraft = {
  ...importedPlan,
  professional_care_prompt: "Seek evaluation from a qualified medical professional.",
};

/** The file body is irrelevant: `readTextFile` is mocked. */
function planFile(name = "plan.json"): File {
  return new File(['{"unused":true}'], name, { type: "application/json" });
}

function renderPlan(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/plan"]}>
      <WorkoutStoreProvider client={client}>
        <Routes>
          <Route path="/plan" element={<PlanScreen />} />
          <Route path="/workout/new" element={<div data-testid="editor" />} />
        </Routes>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

function renderPlanOver(adapter: MemoryStorageAdapter) {
  return renderPlan(clientFor(adapter));
}

/** Renders the plan screen alongside a control that saves workout history. */
function PlanWithHistoryControl() {
  const { saveWorkout } = useWorkoutStore();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void saveWorkout(
            record({
              id: "wkt_new",
              date: "2026-03-01",
              exercises: [{ name: "Deadlift", sets: [{ weight: 120, reps: 5, rpe: 8 }] }],
            }),
          )
        }
      >
        Add workout
      </button>
      <PlanScreen />
    </>
  );
}

function renderPlanWithHistoryControl(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/plan"]}>
      <WorkoutStoreProvider client={client}>
        <PlanWithHistoryControl />
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

/** Renders the plan screen alongside a control that reloads workout history. */
function PlanWithReloadControl() {
  const { reload } = useWorkoutStore();
  return (
    <>
      <button type="button" onClick={reload}>
        Reload history
      </button>
      <PlanScreen />
    </>
  );
}

function renderPlanWithReload(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/plan"]}>
      <WorkoutStoreProvider client={client}>
        <PlanWithReloadControl />
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

describe("PlanScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading notice while the draft resolves", () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    client.nextPlan();
    renderPlan(client);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("shows an empty state when there is no history", async () => {
    renderPlanOver(new MemoryStorageAdapter());

    expect(await screen.findByText(/no workout history to draft a plan from yet/i))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: /log your first workout/i })).toHaveAttribute(
      "href",
      "/workout/new",
    );
    expect(screen.queryByTestId("plan-status")).not.toBeInTheDocument();
  });

  it("renders a local draft with reasons and a confirm control", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());

    const { container } = renderPlanOver(adapter);

    expect(await screen.findByTestId("plan-status")).toHaveTextContent(/draft/i);
    expect(screen.getByTestId("plan-source")).toHaveTextContent(/local/i);

    const recommendations = container.querySelectorAll("[data-recommendation-action]");
    expect(recommendations.length).toBeGreaterThan(0);
    // Every recommendation must show its reason.
    for (const item of recommendations) {
      expect(item).toHaveTextContent(/reason:/i);
    }

    expect(screen.getByRole("button", { name: /confirm plan/i })).toBeInTheDocument();
  });

  it("shows a retryable error when the draft fails and recovers", async () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const first = client.nextPlan();
    const user = userEvent.setup();
    renderPlan(client);

    await waitFor(() => expect(client.planCalls).toBe(1));
    first.reject(new Error("plan down"));
    expect(await screen.findByTestId("plan-error")).toHaveTextContent(/plan down/i);

    const second = client.nextPlan();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    second.resolve(generateNextPlan([record()]));
    await waitFor(() =>
      expect(screen.getByTestId("plan-status")).toHaveTextContent(/draft/i),
    );
  });

  it("adopts on confirmation without mutating stored records", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const before = loadRecords(adapter);

    const { user } = renderPlanOver(adapter);
    await screen.findByTestId("plan-status");

    await user.click(screen.getByRole("button", { name: /confirm plan/i }));

    expect(screen.getByTestId("plan-status")).toHaveTextContent(/adopted/i);

    // Confirming is UI-only: storage must be byte-for-byte unchanged.
    expect(loadRecords(adapter)).toEqual(before);
  });

  it("confirming makes no client call", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const counting = clientFor(adapter);
    let calls = 0;
    const counted = Object.create(counting) as typeof counting;
    counted.createPlanDraft = async (...args: Parameters<typeof counting.createPlanDraft>) => {
      calls += 1;
      return counting.createPlanDraft(...args);
    };

    const { user } = renderPlan(counted);
    await screen.findByTestId("plan-status");
    const callsAfterLoad = calls;

    await user.click(screen.getByRole("button", { name: /confirm plan/i }));
    expect(screen.getByTestId("plan-status")).toHaveTextContent(/adopted/i);
    expect(calls).toBe(callsAfterLoad);
  });

  it("resets an adopted plan to draft when the workout history changes", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());

    const { user } = renderPlanWithHistoryControl(clientFor(adapter));
    await screen.findByTestId("plan-status");

    await user.click(screen.getByRole("button", { name: /confirm plan/i }));
    expect(screen.getByTestId("plan-status")).toHaveTextContent(/adopted/i);

    // The new record regenerates the plan; a stale "adopted" must not survive.
    await user.click(screen.getByRole("button", { name: /add workout/i }));

    await waitFor(() => expect(screen.getByTestId("plan-status")).toHaveTextContent(/draft/i));
    expect(screen.getByRole("button", { name: /confirm plan/i })).toBeInTheDocument();
  });

  it("clears the adoption when switching back to the local plan", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    readTextFileMock.mockResolvedValue(JSON.stringify(importedPlan));

    const { user } = renderPlanOver(adapter);
    await screen.findByTestId("plan-status");
    await user.upload(screen.getByLabelText(/import plan.json/i), planFile());
    await waitFor(() => expect(screen.getByTestId("plan-source")).toHaveTextContent(/imported/i));

    await user.click(screen.getByRole("button", { name: /confirm plan/i }));
    expect(screen.getByTestId("plan-status")).toHaveTextContent(/adopted/i);

    await user.click(screen.getByRole("button", { name: /show local plan/i }));
    expect(screen.getByTestId("plan-source")).toHaveTextContent(/local/i);
    expect(screen.getByTestId("plan-status")).toHaveTextContent(/draft/i);
  });

  it("keeps the previous plan when an import is malformed", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    readTextFileMock.mockResolvedValue(
      JSON.stringify({
        is_draft: true,
        requires_confirmation: true,
        based_on: { period: { from: null, to: null }, sessions: 1, source_records: [] },
        recommendations: {},
        safety_notes: [],
        professional_care_prompt: null,
      }),
    );

    const { user, container } = renderPlanOver(adapter);
    await screen.findByTestId("plan-status");
    await user.upload(screen.getByLabelText(/import plan.json/i), planFile());

    const alert = await screen.findByTestId("plan-error");
    expect(alert).toHaveTextContent(/recommendations/i);
    // A bad import must not blank the previously displayed plan.
    expect(container.querySelector("[data-recommendation-action]")).not.toBeNull();
    expect(screen.getByTestId("plan-source")).toHaveTextContent(/local/i);
  });

  it("imports a plan and resets an adopted local draft to draft", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    readTextFileMock.mockResolvedValue(JSON.stringify(importedPlan));

    const { user } = renderPlanOver(adapter);
    await screen.findByTestId("plan-status");
    await user.click(screen.getByRole("button", { name: /confirm plan/i }));
    expect(screen.getByTestId("plan-status")).toHaveTextContent(/adopted/i);

    await user.upload(screen.getByLabelText(/import plan.json/i), planFile());

    await waitFor(() => expect(screen.getByTestId("plan-source")).toHaveTextContent(/imported/i));
    expect(screen.getByTestId("plan-status")).toHaveTextContent(/draft/i);
    expect(screen.getByText(/imported goal/i)).toBeInTheDocument();
    expect(screen.getByText(/imported reason/i)).toBeInTheDocument();
    expect(screen.getByText(/imported safety note/i)).toBeInTheDocument();
  });

  it("renders a professional care prompt when present", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    readTextFileMock.mockResolvedValue(JSON.stringify(carePlan));

    const { user } = renderPlanOver(adapter);
    await screen.findByTestId("plan-status");
    await user.upload(screen.getByLabelText(/import plan.json/i), planFile());

    const prompt = await screen.findByTestId("care-prompt");
    expect(prompt).toHaveTextContent(/qualified medical professional/i);
  });

  it("shows a history-load error with retry on initial failure", async () => {
    const expected = generateNextPlan([record()]);
    const client = new FakeFitTraceClient({ records: [record()], plan: expected });
    const gate = client.nextList();
    const { user } = renderPlan(client);

    await waitFor(() => expect(client.listCalls).toBe(1));
    gate.reject(new Error("history down"));

    const alert = await screen.findByTestId("history-error");
    expect(alert).toHaveTextContent(/could not load workout history/i);
    expect(alert).toHaveTextContent(/history down/i);
    expect(screen.queryByText(/no workout history to draft a plan from yet/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));
    await waitFor(() => expect(screen.getByTestId("plan-status")).toHaveTextContent(/draft/i));
    expect(screen.queryByTestId("history-error")).not.toBeInTheDocument();
  });

  it("replaces a stale plan with a history-load error on reload failure", async () => {
    const expected = generateNextPlan([record()]);
    const client = new FakeFitTraceClient({ records: [record()], plan: expected });
    const { user } = renderPlanWithReload(client);
    await screen.findByTestId("plan-status");

    const refresh = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload history/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));
    refresh.reject(new Error("reload failed"));

    const alert = await screen.findByTestId("history-error");
    expect(alert).toHaveTextContent(/reload failed/i);
    // The stale draft must not remain visible alongside the history error.
    expect(screen.queryByTestId("plan-status")).not.toBeInTheDocument();
  });
});
