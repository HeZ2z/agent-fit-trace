import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnalysisResult, WorkoutRecord } from "@agent-fit-trace/core";
import { analyzeProgress } from "@agent-fit-trace/core";
import type {
  ArtifactSelection,
  FitTraceClient,
  ImportedArtifact,
} from "@agent-fit-trace/api-contracts";
import { setLanguage } from "../i18n/i18n.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { saveRecord } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider, useWorkoutStore } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient, clientFor, deferred } from "../test/asyncClient.ts";
import { AnalysisScreen } from "./AnalysisScreen.tsx";

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
  trends: [],
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

async function saveAnalysis(
  client: FitTraceClient,
  payload: AnalysisResult = importedAnalysis,
  filename = "analysis.json",
): Promise<ImportedArtifact<"analysis">> {
  const result = await client.saveImportedArtifact({
    kind: "analysis",
    payload_schema_version: 1,
    payload,
    source_filename: filename,
  });
  return result.artifact;
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
    localStorage.clear();
  });

  it("shows a loading notice while analysis resolves", () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    client.nextAnalyze();
    renderAnalysis(client);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("labels an unresolved saved selection as loading, not as the computed source", async () => {
    const client = new FakeFitTraceClient({
      records: [record()],
      analysis: analyzeProgress([record()]),
    });
    const selection = deferred<ArtifactSelection>();
    client.getArtifactSelection = () => selection.promise;

    renderAnalysis(client);

    const label = await screen.findByTestId("analysis-source");
    expect(label).toHaveTextContent(/loading saved selection/i);
    expect(label).not.toHaveTextContent(/current computed/i);
    expect(
      screen.getByRole("button", { name: /show current computed analysis/i }),
    ).toBeEnabled();

    await act(async () => {
      selection.resolve({ artifact_id: null });
    });
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
    expect(screen.getByTestId("analysis-source")).toHaveTextContent(/current computed/i);
  });

  it("shows an empty state when there is no history", async () => {
    renderAnalysisOver(new MemoryStorageAdapter());

    expect(await screen.findByText(/no workout history to analyse yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /log your first workout/i })).toHaveAttribute(
      "href",
      "/workout/new",
    );
    expect(screen.getByRole("link", { name: /manage imports and exports/i })).toHaveAttribute(
      "href",
      "/me",
    );
  });

  it("renders metrics from local records with no independent file input", async () => {
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
    // The recorded "Squat" alias now groups under its canonical catalog name.
    expect(container.querySelector('[data-trend-exercise="Barbell Squat"]')).not.toBeNull();
    expect(screen.queryByLabelText(/import analysis\.json/i)).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("shows a snapshot saved and selected through the client before mount", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await saveAnalysis(client);
    await client.setArtifactSelection("analysis", artifact.id);

    renderAnalysis(client);

    expect(await screen.findByText(/Sessions: 7/)).toBeInTheDocument();
    expect(screen.getByTestId("analysis-source")).toHaveTextContent(/imported snapshot/i);
    expect(await screen.findByTestId("analysis-snapshot-meta")).toHaveTextContent(
      /analysis\.json.*immutable snapshot/i,
    );
    expect(screen.getByTestId("analysis-snapshot-linkage")).toHaveTextContent(
      /0 of 2 source record id\(s\) exist.*2 missing/i,
    );
    expect(screen.getByText(/not proof/i)).toBeInTheDocument();
    expect(screen.getByText(/Imported flag/)).toBeInTheDocument();

    // Current computed is a separate explicit action, not a silent fallback.
    await userEvent.click(screen.getByRole("button", { name: /show current computed analysis/i }));
    await waitFor(() => expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument());
    expect(await client.getArtifactSelection("analysis")).toEqual({ artifact_id: null });
  });

  it("blocks other source writes while switching to the current computed source", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await saveAnalysis(client);
    await client.setArtifactSelection("analysis", artifact.id);

    const write = deferred<ArtifactSelection>();
    client.setArtifactSelection = () => write.promise;
    const { user } = renderAnalysis(client);
    await screen.findByText(/Sessions: 7/);

    await user.click(screen.getByRole("button", { name: /show current computed analysis/i }));

    expect(screen.getByRole("button", { name: /refresh saved data/i })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: new RegExp(`view saved analysis snapshot`, "i") }),
    ).toBeDisabled();

    await act(async () => {
      write.resolve({ artifact_id: null });
    });
    await waitFor(() => expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument());
    expect(screen.getByTestId("analysis-source")).toHaveTextContent(/current computed/i);
  });

  it("shows computed results after recovering a lost source-switch response", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await saveAnalysis(client);
    await client.setArtifactSelection("analysis", artifact.id);

    // The server commits the computed source (null), then the response is lost.
    const commit = client.setArtifactSelection.bind(client);
    client.setArtifactSelection = async (kind, artifactId) => {
      await commit(kind, artifactId);
      throw new Error("response lost");
    };

    const { user } = renderAnalysis(client);
    await screen.findByText(/Sessions: 7/);
    await user.click(screen.getByRole("button", { name: /show current computed analysis/i }));

    // The authoritative re-read confirms null and loads the computed result,
    // so the page must not remain blank behind a blocking selection error.
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
    expect(screen.getByTestId("analysis-source")).toHaveTextContent(/current computed/i);
    expect(screen.queryByTestId("analysis-selection-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("analysis-selection-warning")).toHaveTextContent(/response lost/i);
  });

  it("restores the saved selection after a hard remount", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await saveAnalysis(client);
    await client.setArtifactSelection("analysis", artifact.id);

    const first = renderAnalysis(client);
    await screen.findByText(/Sessions: 7/);
    first.unmount();

    renderAnalysis(clientFor(adapter));
    expect(await screen.findByText(/Sessions: 7/)).toBeInTheDocument();
    expect(screen.getByTestId("analysis-source")).toHaveTextContent(new RegExp(artifact.id));
  });

  it("paginates snapshot metadata with Load more", async () => {
    const client = new FakeFitTraceClient({
      records: [record()],
      analysis: analyzeProgress([record()]),
    });
    const first = await client.saveImportedArtifact({
      kind: "analysis",
      payload_schema_version: 1,
      payload: importedAnalysis,
      source_filename: "one.json",
    });
    const second = await client.saveImportedArtifact({
      kind: "analysis",
      payload_schema_version: 1,
      payload: { ...importedAnalysis, metrics: { ...importedAnalysis.metrics, sessions: 8 } },
      source_filename: "two.json",
    });
    const list = client.listImportedArtifacts.bind(client);
    client.listImportedArtifacts = async (query) =>
      query?.cursor === "next"
        ? { items: [second.artifact], next_cursor: null }
        : { items: [first.artifact], next_cursor: "next" };

    renderAnalysis(client);
    expect(await screen.findByText(/one\.json/)).toBeInTheDocument();
    expect(screen.queryByText(/two\.json/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /load more snapshots/i }));
    expect(await screen.findByText(/two\.json/)).toBeInTheDocument();
    expect(list).toBeDefined();
  });

  it("shows a next-page failure without dropping already loaded history", async () => {
    const client = new FakeFitTraceClient({
      records: [record()],
      analysis: analyzeProgress([record()]),
    });
    const first = await saveAnalysis(client, importedAnalysis, "one.json");
    client.listImportedArtifacts = async (query) =>
      query?.cursor === "next"
        ? Promise.reject(new Error("page down"))
        : { items: [first], next_cursor: "next" };

    const { user } = renderAnalysis(client);
    expect(await screen.findByText(/one\.json/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /load more snapshots/i }));

    expect(await screen.findByTestId("analysis-snapshot-list-error")).toHaveTextContent(
      /could not load more.*page down/i,
    );
    expect(screen.getByText(/one\.json/)).toBeInTheDocument();
  });

  it("does not label the current computed source local in HTTP mode", async () => {
    (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
      mode: "http",
    };
    try {
      renderAnalysisOver(new MemoryStorageAdapter());
      const label = await screen.findByTestId("analysis-source");
      expect(label).toHaveTextContent(/current computed \(not a saved snapshot\)/i);
      expect(label).not.toHaveTextContent(/local/i);
    } finally {
      delete (globalThis as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
    }
  });

  it("keeps an immutable payload after workout history refreshes", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await saveAnalysis(client);
    await client.setArtifactSelection("analysis", artifact.id);

    const { user } = renderAnalysisWithReload(client);
    await screen.findByText(/Sessions: 7/);
    await user.click(screen.getByRole("button", { name: /reload history/i }));

    // The snapshot is not recomputed from records; its stored metrics stay.
    expect(await screen.findByText(/Sessions: 7/)).toBeInTheDocument();
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

    const refreshGate = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload history/i }));
    refreshGate.resolve([recA, recB]);
    const second = client.nextAnalyze();
    await waitFor(() => expect(client.analyzeCalls).toBe(2));

    second.resolve(analyzeProgress([recA, recB]));
    await waitFor(() => expect(screen.getByText(/Sessions: 2/)).toBeInTheDocument());
    first.resolve(analyzeProgress([recA]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText(/Sessions: 2/)).toBeInTheDocument();
  });

  it("drops an old client's snapshot result after the owner changes", async () => {
    const adapterA = new MemoryStorageAdapter();
    saveRecord(adapterA, record());
    const clientA = clientFor(adapterA);
    const artifact = await saveAnalysis(clientA);
    await clientA.setArtifactSelection("analysis", artifact.id);

    let release!: (value: ImportedArtifact) => void;
    clientA.getImportedArtifact = () => new Promise((resolve) => (release = resolve));

    const view = renderAnalysis(clientA);
    await screen.findByTestId("analysis-snapshot-history");

    const clientB = new FakeFitTraceClient({
      records: [record()],
      analysis: analyzeProgress([record()]),
    });
    view.rerender(
      <MemoryRouter initialEntries={["/analysis"]}>
        <WorkoutStoreProvider client={clientB}>
          <AnalysisScreen />
        </WorkoutStoreProvider>
      </MemoryRouter>,
    );

    release(artifact);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText(/Sessions: 7/)).not.toBeInTheDocument();
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
  });

  it("shows history-load errors separately from saved source errors", async () => {
    const expected = analyzeProgress([record()]);
    const client = new FakeFitTraceClient({ records: [record()], analysis: expected });
    const gate = client.nextList();
    const { user } = renderAnalysis(client);

    await waitFor(() => expect(client.listCalls).toBe(1));
    gate.reject(new Error("history down"));

    const alert = await screen.findByTestId("history-error");
    expect(alert).toHaveTextContent(/history down/i);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument());
  });

  it("replaces a stale analysis with a history-load error on reload failure", async () => {
    const client = new FakeFitTraceClient({
      records: [record()],
      analysis: analyzeProgress([record()]),
    });
    const { user } = renderAnalysisWithReload(client);
    await screen.findByText(/Sessions: 1/);

    const refresh = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload history/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));
    refresh.reject(new Error("reload failed"));

    expect(await screen.findByTestId("history-error")).toHaveTextContent(/reload failed/i);
    expect(screen.queryByText(/Sessions: 1/)).not.toBeInTheDocument();
  });
});

describe("AnalysisScreen exercise name localization", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLanguage("en");
  });

  it("renders catalog trends with Chinese display names and keeps custom names", async () => {
    setLanguage("zh");
    const adapter = new MemoryStorageAdapter();
    saveRecord(
      adapter,
      record({
        date: "2026-01-05",
        exercises: [
          {
            name: "Barbell Bench Press - Medium Grip",
            sets: [{ weight: 80, reps: 5, rpe: 6 }],
          },
          { name: "Sled Push", sets: [{ weight: 40, reps: 5, rpe: 6 }] },
        ],
      }),
    );
    saveRecord(
      adapter,
      record({
        id: "wkt_b",
        date: "2026-01-07",
        exercises: [
          {
            name: "Barbell Bench Press - Medium Grip",
            sets: [{ weight: 85, reps: 5, rpe: 6 }],
          },
          { name: "Sled Push", sets: [{ weight: 45, reps: 5, rpe: 6 }] },
        ],
      }),
    );

    renderAnalysisOver(adapter);

    expect(await screen.findByText(/杠铃卧推/)).toBeInTheDocument();
    // Custom names are not in the catalog and stay exactly as recorded.
    expect(screen.getByText(/Sled Push/)).toBeInTheDocument();
    expect(screen.queryByText(/Barbell Bench Press/)).not.toBeInTheDocument();
  });

  it("resolves stored aliases before localizing a trend", async () => {
    setLanguage("zh");
    const adapter = new MemoryStorageAdapter();
    for (const [date, weight] of [
      ["2026-01-05", 80],
      ["2026-01-07", 85],
    ] as const) {
      saveRecord(
        adapter,
        record({
          id: `wkt_${date}`,
          date,
          exercises: [{ name: "Bench press", sets: [{ weight, reps: 5, rpe: 6 }] }],
        }),
      );
    }

    renderAnalysisOver(adapter);

    expect(await screen.findByText(/杠铃卧推/)).toBeInTheDocument();
  });
});
