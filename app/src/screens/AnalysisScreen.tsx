import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AnalysisResult } from "@agent-fit-trace/core";
import { AnalysisView } from "../components/AnalysisView.tsx";
import {
  ArtifactSnapshotMeta,
  ArtifactSourceSelector,
} from "../components/ArtifactSourceSelector.tsx";
import { useArtifactSource } from "../state/useArtifactSource.ts";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useI18n } from "../i18n/useI18n.ts";

export function AnalysisScreen() {
  const { t } = useI18n();
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
    <section data-screen="analysis">
      <div className="screen-head">
        <div className="screen-head-main">
          <h1>{t("Progress Analysis")}</h1>
          <p className="screen-lede">
            {t(
              "Deterministic metrics, exercise trends and safety flags computed from the same records every time. No model call is involved.",
            )}
          </p>
        </div>
        <p className="screen-actions">
          <Link className="btn-ghost" to="/me">
            {t("Manage imports and exports")}
          </Link>
        </p>
      </div>

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>
            {t("Could not load workout history: {message}", {
              message: loadError?.message ?? t("Unknown error."),
            })}
          </p>
          <button type="button" onClick={reload}>
            {t("Retry")}
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
            <p role="status">{t("Loading analysis…")}</p>
          ) : analysisStatus === "error" ? (
            <div role="alert" data-testid="analysis-error" className="validation-summary">
              <p>
                {t("Could not load analysis: {message}", {
                  message: analysisError?.message ?? t("Unknown error."),
                })}
              </p>
              <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
                {t("Retry")}
              </button>
            </div>
          ) : showEmpty || localAnalysis === null ? (
            <div className="empty-state">
              <p>{t("No workout history to analyse yet.")}</p>
              <Link to="/workout/new">{t("Log your first workout")}</Link>
            </div>
          ) : (
            <AnalysisView analysis={localAnalysis} />
          )}
        </>
      )}
    </section>
  );
}
