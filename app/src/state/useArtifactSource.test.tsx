import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnalysisResult, WorkoutRecord } from "@pi-fit-trace/core";
import type {
  ArtifactSelection,
  FitTraceClient,
  ImportedArtifact,
} from "@pi-fit-trace/api-contracts";
import { FakeFitTraceClient, clientFor, deferred } from "../test/asyncClient.ts";
import { useArtifactSource } from "./useArtifactSource.ts";
import type { ArtifactSource } from "./useArtifactSource.ts";

function record(): WorkoutRecord {
  return {
    id: "wkt_a",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
  };
}

const analysisPayload: AnalysisResult = {
  period: { from: "2026-01-01", to: "2026-01-31" },
  metrics: {
    sessions: 1,
    total_sets: 1,
    total_reps: 5,
    volume_kg: 500,
    avg_rpe: 8,
    avg_rest_days: 0,
    max_gap_days: 0,
  },
  trends: [],
  flags: [],
  source_records: ["wkt_a"],
};

async function saveAnalysis(
  client: FitTraceClient,
  sourceFilename: string,
  sessions = 1,
): Promise<ImportedArtifact<"analysis">> {
  const saved = await client.saveImportedArtifact({
    kind: "analysis",
    payload_schema_version: 1,
    payload: {
      ...analysisPayload,
      metrics: {
        ...analysisPayload.metrics,
        sessions,
        total_sets: sessions,
        total_reps: sessions * 5,
        volume_kg: sessions * 500,
      },
    },
    source_filename: sourceFilename,
  });
  return saved.artifact;
}

function Probe({
  client,
  api,
}: {
  client: FitTraceClient;
  api: { current: ArtifactSource<"analysis"> | null };
}) {
  const source = useArtifactSource("analysis", client);
  api.current = source;
  return (
    <div>
      <span data-testid="status">{source.selectionStatus}</span>
      <span data-testid="selection">{source.selection ?? "null"}</span>
      <span data-testid="selected">{source.selected?.id ?? "none"}</span>
      <span data-testid="busy">{String(source.selectionBusy)}</span>
      <span data-testid="error">{source.selectionError ?? ""}</span>
    </div>
  );
}

describe("useArtifactSource selection races", () => {
  it("keeps B after a late A write completes", async () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const a = await saveAnalysis(client, "a.json");
    const b = await saveAnalysis(client, "b.json", 2);
    expect(a.id).not.toBe(b.id);

    const setCalls: ReturnType<typeof deferred<ArtifactSelection>>[] = [];
    const gets = new Map<string, ReturnType<typeof deferred<ImportedArtifact>>>();
    client.setArtifactSelection = () => {
      const call = deferred<ArtifactSelection>();
      setCalls.push(call);
      return call.promise;
    };
    client.getImportedArtifact = (id) => {
      const call = deferred<ImportedArtifact>();
      gets.set(id, call);
      return call.promise;
    };

    const api = { current: null as ArtifactSource<"analysis"> | null };
    render(<Probe client={client} api={api} />);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    act(() => {
      void api.current?.select(a.id);
      void api.current?.select(b.id);
    });
    await waitFor(() => expect(setCalls).toHaveLength(2));
    expect(api.current?.selectionBusy).toBe(true);

    // B is written and loaded first, then the old A write resolves late.
    await act(async () => {
      setCalls[1].resolve({ artifact_id: b.id });
    });
    await waitFor(() => expect(gets.has(b.id)).toBe(true));
    await act(async () => {
      gets.get(b.id)?.resolve(b);
    });
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent(b.id));

    await act(async () => {
      setCalls[0].resolve({ artifact_id: a.id });
    });
    expect(screen.getByTestId("selection")).toHaveTextContent(b.id);
    expect(screen.getByTestId("selected")).toHaveTextContent(b.id);
    expect(screen.getByTestId("busy")).toHaveTextContent("false");
  });

  it("does not let the in-flight initial selection read overwrite an explicit choice", async () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const a = await saveAnalysis(client, "a.json");
    const b = await saveAnalysis(client, "b.json", 2);
    expect(a.id).not.toBe(b.id);

    const initial = deferred<ArtifactSelection>();
    client.getArtifactSelection = () => initial.promise;

    const api = { current: null as ArtifactSource<"analysis"> | null };
    render(<Probe client={client} api={api} />);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("loading"));

    act(() => {
      void api.current?.select(b.id);
    });
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent(b.id));

    await act(async () => {
      initial.resolve({ artifact_id: a.id });
    });
    expect(screen.getByTestId("selection")).toHaveTextContent(b.id);
    expect(screen.getByTestId("selected")).toHaveTextContent(b.id);
  });

  it("re-reads the saved selection when a successful write loses its response", async () => {
    const client = clientFor();
    const a = await saveAnalysis(client, "a.json");
    const b = await saveAnalysis(client, "b.json", 2);
    await client.setArtifactSelection("analysis", a.id);

    // The server commits B, then the response is lost. The old A is no longer
    // authoritative even though the caller saw a rejection.
    const commit = client.setArtifactSelection.bind(client);
    client.setArtifactSelection = async (kind, artifactId) => {
      await commit(kind, artifactId);
      throw new Error("response lost");
    };

    const api = { current: null as ArtifactSource<"analysis"> | null };
    render(<Probe client={client} api={api} />);
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(a.id));
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent(a.id));

    await act(async () => {
      await api.current?.select(b.id);
    });

    // The catch re-reads B instead of keeping A, so Retry and the displayed
    // source both match what a reload would load.
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(b.id));
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent(b.id));
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
    expect(screen.getByTestId("error")).toHaveTextContent(/response lost/i);

    await act(async () => {
      await api.current?.retrySelected();
    });
    expect(screen.getByTestId("selection")).toHaveTextContent(b.id);
    expect(screen.getByTestId("selected")).toHaveTextContent(b.id);
  });

  it("re-reads the authoritative selection when retrying a failed selection read", async () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const a = await saveAnalysis(client, "a.json");
    let selectionCalls = 0;
    client.getArtifactSelection = () => {
      selectionCalls += 1;
      return selectionCalls === 1
        ? Promise.reject(new Error("selection down"))
        : Promise.resolve({ artifact_id: a.id });
    };

    const api = { current: null as ArtifactSource<"analysis"> | null };
    render(<Probe client={client} api={api} />);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    expect(screen.getByTestId("error")).toHaveTextContent(/selection down/i);

    await act(async () => {
      await api.current?.retrySelected();
    });
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent(a.id));
    expect(selectionCalls).toBe(2);
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
  });

  it("rejects a detail whose returned kind does not match the selected kind", async () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const a = await saveAnalysis(client, "a.json");
    await client.setArtifactSelection("analysis", a.id);
    client.getImportedArtifact = async () => ({ ...a, kind: "plan" }) as ImportedArtifact;

    const api = { current: null as ArtifactSource<"analysis"> | null };
    render(<Probe client={client} api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent(/different plan artifact/i),
    );
    expect(screen.getByTestId("selected")).toHaveTextContent("none");
    expect(screen.getByTestId("selection")).toHaveTextContent(a.id);
  });
});
