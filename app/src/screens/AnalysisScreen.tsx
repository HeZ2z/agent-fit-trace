import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AnalysisResult } from "@pi-fit-trace/core";
import { AnalysisView } from "../components/AnalysisView.tsx";
import {
  ArtifactSnapshotMeta,
  ArtifactSourceSelector,
} from "../components/ArtifactSourceSelector.tsx";
import { useArtifactSource } from "../state/useArtifactSource.ts";
import { useWorkouts } from "../state/useWorkouts.ts";

export function AnalysisScreen() {
  const { client, records, status: historyStatus, loadError, reload } = useWorkouts();
  const source = useArtifactSource("analysis", client);
  const [localAnalysis, setLocalAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"loading" | "error" | "ready">("loading");
  const [analysisError, setAnalysisError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const generationRef = useRef(0);

  useEffect(() => {
    if (historyStatus !== "ready") return;
    const generation = ++generationRef.current;
    let cancelled = false;
    setLocalAnalysis(null);
    setAnalysisStatus("loading");
    setAnalysisError(null);
    client
      .analyze()
      .then((result) => {
        if (cancelled || generationRef.current !== generation) return;
        setLocalAnalysis(result);
        setAnalysisStatus("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled || generationRef.current !== generation) return;
        setAnalysisError(caught instanceof Error ? caught : new Error(String(caught)));
        setAnalysisStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, records, reloadToken, historyStatus]);

  // A selected snapshot is rendered from its immutable payload. The computed
  // analysis is only shown when the server selection is explicitly null.
  const snapshot = source.selected;
  const sourceBlocked =
    snapshot === null &&
    (source.selectionStatus !== "ready" ||
      source.selectionBusy ||
      source.selectionError !== null ||
      source.selection !== null);
  const showEmpty =
    historyStatus === "ready" &&
    records.length === 0 &&
    snapshot === null &&
    source.selection === null &&
    source.selectionError === null;

  return (
    <section>
      <h1>Progress Analysis</h1>

      <p>
        <Link to="/me">Manage imports and exports</Link>
      </p>

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <ArtifactSourceSelector source={source} />

          {snapshot !== null ? (
            <>
              <ArtifactSnapshotMeta artifact={snapshot} records={records} />
              <AnalysisView analysis={snapshot.payload} />
            </>
          ) : sourceBlocked ? null : historyStatus === "loading" ||
            (historyStatus === "ready" && analysisStatus === "loading") ? (
            <p role="status">Loading analysis…</p>
          ) : analysisStatus === "error" ? (
            <div role="alert" data-testid="analysis-error" className="validation-summary">
              <p>Could not load analysis: {analysisError?.message ?? "Unknown error."}</p>
              <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : showEmpty || localAnalysis === null ? (
            <div className="empty-state">
              <p>No workout history to analyse yet.</p>
              <Link to="/workout/new">Log your first workout</Link>
            </div>
          ) : (
            <AnalysisView analysis={localAnalysis} />
          )}
        </>
      )}
    </section>
  );
}
