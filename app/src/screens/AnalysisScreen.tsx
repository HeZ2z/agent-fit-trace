import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link } from "react-router-dom";
import type { AnalysisResult } from "@pi-fit-trace/core";
import { readTextFile } from "../api/fileTransport.ts";
import { parseAnalysisResponse } from "../api/responseParsers.ts";
import { AnalysisView } from "../components/AnalysisView.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";

export function AnalysisScreen() {
  const { client, records, status: historyStatus, loadError, reload } = useWorkouts();
  const [imported, setImported] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localAnalysis, setLocalAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"loading" | "error" | "ready">("loading");
  const [analysisError, setAnalysisError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const generationRef = useRef(0);

  useEffect(() => {
    if (historyStatus !== "ready") return;
    const generation = ++generationRef.current;
    let cancelled = false;
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

  // Single source of truth for rendering: local analysis unless an import
  // succeeded. A failed import never changes this.
  const analysis = imported ?? localAnalysis;
  const source = imported === null ? "local" : "imported";
  const showEmpty =
    historyStatus === "ready" && records.length === 0 && imported === null;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;

    try {
      const text = await readTextFile(file);
      const parsed = parseAnalysisResponse(text);
      setImported(parsed);
      setError(null);
    } catch (caught) {
      // Keep the previously displayed analysis; only surface the error.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      input.value = "";
    }
  }

  function showLocal(): void {
    setImported(null);
    setError(null);
  }

  return (
    <section>
      <h1>Progress Analysis</h1>

      <p data-testid="analysis-source">{`Analysis source: ${source}`}</p>

      <div className="field">
        <label htmlFor="analysis-import">Import analysis.json</label>
        <input
          id="analysis-import"
          type="file"
          accept="application/json"
          onChange={handleFileChange}
        />
      </div>

      {imported !== null && (
        <button type="button" onClick={showLocal}>
          Show local analysis
        </button>
      )}

      {error !== null && (
        <div role="alert" data-testid="analysis-error" className="validation-summary">
          {error}
        </div>
      )}

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : historyStatus === "loading" || (historyStatus === "ready" && analysisStatus === "loading") ? (
        <p role="status">Loading analysis…</p>
      ) : analysisStatus === "error" && imported === null ? (
        <div role="alert" data-testid="analysis-error" className="validation-summary">
          <p>Could not load analysis: {analysisError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : showEmpty || analysis === null ? (
        <div className="empty-state">
          <p>No workout history to analyse yet.</p>
          <Link to="/workout/new">Log your first workout</Link>
        </div>
      ) : (
        <AnalysisView analysis={analysis} />
      )}
    </section>
  );
}
