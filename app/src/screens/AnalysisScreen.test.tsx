import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisResult, WorkoutRecord } from "@pi-fit-trace/core";
import { analyzeProgress } from "@pi-fit-trace/core";
import { readTextFile } from "../api/fileTransport.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { saveRecord } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider, useWorkoutStore } from "../state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";
import { AnalysisScreen } from "./AnalysisScreen.tsx";

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

const importedAnalysis: AnalysisResult = {
  period: { from: "2026-01-01", to: "2026-01-31" },
  metrics: {
    sessions: 7,
    total_sets: 21,
    total_reps: 105,
    volume_kg: 9999,
    avg_rpe: 7.5,
    avg_rest_days: 3,
    max_gap_days: 5,
  },
  trends: [
    {
      exercise: "Bench Press",
      metric: "est_1rm_kg",
      sessions_compared: 3,
      first: 90,
      last: 100,
      delta: 10,
      delta_pct: 11.11,
      direction: "up",
    },
  ],
  flags: [
    {
      code: "EXTREME_RPE",
      severity: "critical",
      message: "Imported flag.",
      evidence: { max_rpe: 10 },
    },
  ],
  source_records: ["wkt_x", "wkt_y"],
};

/** The file body is irrelevant: `readTextFile` is mocked. */
function analysisFile(name = "analysis.json"): File {
  return new File(['{"unused":true}'], name, { type: "application/json" });
}

function renderAnalysis(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/analysis"]}>
      <WorkoutStoreProvider client={client}>
        <Routes>
          <Route path="/analysis" element={<AnalysisScreen />} />
          <Route path="/workout/new" element={<div data-testid="editor" />} />
        </Routes>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

function renderAnalysisOver(adapter: MemoryStorageAdapter) {
  return renderAnalysis(clientFor(adapter));
}

/** Harness exposing the provider reload so tests can force a history refresh. */
function AnalysisWithReload() {
  const { reload } = useWorkoutStore();
  return (
    <>
      <button type="button" onClick={reload}>
        Reload history
      </button>
      <AnalysisScreen />
    </>
  );
}

function renderAnalysisWithReload(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/analysis"]}>
      <WorkoutStoreProvider client={client}>
        <AnalysisWithReload />
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

describe("AnalysisScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading notice while analysis resolves", () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    client.nextAnalyze();
    renderAnalysis(client);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("shows an empty state when there is no history", async () => {
    renderAnalysisOver(new MemoryStorageAdapter());

    expect(await screen.findByText(/no workout history to analyse yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /log your first workout/i })).toHaveAttribute(
      "href",
      "/workout/new",
    );
    expect(screen.queryByText(/^Sessions:/)).not.toBeInTheDocument();
  });

  it("renders metrics, trends, and flags with evidence from local records", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    saveRecord(
      adapter,
      record({
        id: "wkt_b",
        date: "2026-01-07",
        exercises: [{ name: "Squat", sets: [{ weight: 110, reps: 5, rpe: 8 }] }],
      }),
    );

    const { container } = renderAnalysisOver(adapter);

    expect(await screen.findByText(/Sessions: 2/)).toBeInTheDocument();
    expect(screen.getByText(/volume: 1050 kg/i)).toBeInTheDocument();
    expect(container.querySelector('[data-trend-exercise="Squat"]')).not.toBeNull();
    expect(container.querySelector('[data-flag-code="MISSING_RECOVERY_DATA"]')).not.toBeNull();
  });

  it("shows a retryable error when analysis fails and recovers", async () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const first = client.nextAnalyze();
    const user = userEvent.setup();
    renderAnalysis(client);

    await waitFor(() => expect(client.analyzeCalls).toBe(1));
    first.reject(new Error("analyze down"));
    expect(await screen.findByTestId("analysis-error")).toHaveTextContent(/analyze down/i);

    const second = client.nextAnalyze();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    second.resolve(analyzeProgress([record()]));
    await waitFor(() => expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument());
  });

  it("discards a stale response that resolves after a newer one", async () => {
    const recA = record();
    const recB = record({ id: "wkt_b", date: "2026-01-07" });
    const client = new FakeFitTraceClient();
    const listGate = client.nextList();
    const user = userEvent.setup();
    renderAnalysisWithReload(client);

    listGate.resolve([recA]);
    const first = client.nextAnalyze();
    await waitFor(() => expect(client.analyzeCalls).toBe(1));

    // Refresh history with an extra record; the second analysis supersedes.
    const refreshGate = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload history/i }));
    refreshGate.resolve([recA, recB]);
    const second = client.nextAnalyze();
    await waitFor(() => expect(client.analyzeCalls).toBe(2));

    second.resolve(analyzeProgress([recA, recB]));
    await waitFor(() => expect(screen.getByText(/Sessions: 2/)).toBeInTheDocument());
    // The stale first response must not overwrite the newer view.
    first.resolve(analyzeProgress([recA]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText(/Sessions: 2/)).toBeInTheDocument();
    expect(screen.queryByText(/Sessions: 1/)).not.toBeInTheDocument();
  });

  it("keeps the local analysis when an import is malformed", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    readTextFileMock.mockResolvedValue(
      JSON.stringify({ period: { from: null, to: null }, metrics: {} }),
    );

    const { user } = renderAnalysisOver(adapter);
    await screen.findByText(/Sessions: 1/);
    await user.upload(screen.getByLabelText(/import analysis.json/i), analysisFile());

    const alert = await screen.findByTestId("analysis-error");
    expect(alert).toHaveTextContent(/metrics/i);
    // A bad import must not blank the previously displayed analysis.
    expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument();
    expect(screen.getByTestId("analysis-source")).toHaveTextContent(/local/i);
  });

  it("displays an imported analysis and can switch back to local", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    readTextFileMock.mockResolvedValue(JSON.stringify(importedAnalysis));

    const { user } = renderAnalysisOver(adapter);
    await screen.findByText(/Sessions: 1/);
    await user.upload(screen.getByLabelText(/import analysis.json/i), analysisFile());

    await waitFor(() =>
      expect(screen.getByTestId("analysis-source")).toHaveTextContent(/imported/i),
    );
    expect(screen.getByText(/Sessions: 7/)).toBeInTheDocument();
    expect(screen.getByText(/imported flag/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show local analysis/i }));

    expect(screen.getByTestId("analysis-source")).toHaveTextContent(/local/i);
    expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument();
  });

  it("shows a history-load error with retry on initial failure", async () => {
    const expected = analyzeProgress([record()]);
    const client = new FakeFitTraceClient({ records: [record()], analysis: expected });
    const gate = client.nextList();
    const { user } = renderAnalysis(client);

    await waitFor(() => expect(client.listCalls).toBe(1));
    gate.reject(new Error("history down"));

    const alert = await screen.findByTestId("history-error");
    expect(alert).toHaveTextContent(/could not load workout history/i);
    expect(alert).toHaveTextContent(/history down/i);
    expect(screen.queryByText(/no workout history to analyse yet/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));
    await waitFor(() => expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument());
    expect(screen.queryByTestId("history-error")).not.toBeInTheDocument();
  });

  it("replaces stale analysis with a history-load error on reload failure", async () => {
    const expected = analyzeProgress([record()]);
    const client = new FakeFitTraceClient({ records: [record()], analysis: expected });
    const { user } = renderAnalysisWithReload(client);
    await screen.findByText(/Sessions: 1/);

    const refresh = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload history/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));
    refresh.reject(new Error("reload failed"));

    const alert = await screen.findByTestId("history-error");
    expect(alert).toHaveTextContent(/reload failed/i);
    // Stale results must not remain visible alongside the history error.
    expect(screen.queryByText(/Sessions: 1/)).not.toBeInTheDocument();
  });
});
