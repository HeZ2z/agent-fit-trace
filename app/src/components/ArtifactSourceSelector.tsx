import type { ImportedArtifact } from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { isHttpModeActive } from "../api/runtimeMode.ts";
import type { ArtifactSource } from "../state/useArtifactSource.ts";

function periodOf(artifact: ImportedArtifact): { from: string | null; to: string | null } {
  return "period" in artifact.payload
    ? artifact.payload.period
    : artifact.payload.based_on.period;
}

function dateLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/**
 * Shared source selector and history for imported analysis/plan snapshots.
 *
 * The current computed result is a distinct source (null server selection).
 * Opening a snapshot is an explicit server write; saving was not.
 */
export function ArtifactSourceSelector({ source }: { source: ArtifactSource }) {
  const { kind } = source;
  const label = kind === "analysis" ? "Analysis" : "Plan";
  const currentLabel = isHttpModeActive()
    ? "current computed (not a saved snapshot)"
    : "current computed (local)";
  const sourceLabel =
    source.selectionStatus === "loading"
      ? "loading saved selection (unknown)"
      : source.selectionStatus === "error"
        ? "saved selection unknown (read failure)"
        : source.selection === null
          ? currentLabel
          : `imported snapshot (${source.selection})`;

  return (
    <section className="artifact-source" aria-labelledby={`${kind}-source-heading`}>
      <h2 id={`${kind}-source-heading`}>Viewing source</h2>
      <p data-testid={`${kind}-source`}>{`${label} source: ${sourceLabel}`}</p>

      <div className="artifact-source-actions">
        <button
          type="button"
          onClick={() => void source.select(null)}
          disabled={
            source.selectionBusy ||
            (source.selectionStatus === "ready" && source.selection === null)
          }
        >
          {`Show current computed ${kind}`}
        </button>
        <button type="button" onClick={source.refresh} disabled={source.selectionBusy}>
          Refresh saved data
        </button>
      </div>

      {source.selectionWarning !== null && (
        <p role="status" className="me-help" data-testid={`${kind}-selection-warning`}>
          {source.selectionWarning}
        </p>
      )}

      {source.selectionError !== null && (
        <div role="alert" className="validation-summary" data-testid={`${kind}-selection-error`}>
          <p>{source.selectionError}</p>
          <button
            type="button"
            onClick={() => void source.retrySelected()}
            disabled={source.selectionBusy}
          >
            Retry loading the saved snapshot
          </button>
        </div>
      )}

      {source.listStatus === "loading" && source.selectionLoading ? (
        <p role="status">{`Loading saved ${kind} snapshots…`}</p>
      ) : null}

      {source.listStatus === "error" && (
        <div role="alert" className="validation-summary" data-testid={`${kind}-snapshot-list-error`}>
          <p>Could not load saved {kind} snapshot history: {source.listError}</p>
          <button type="button" onClick={source.refresh}>
            Retry
          </button>
        </div>
      )}

      {source.listStatus === "ready" && source.listError !== null && (
        <div role="alert" className="validation-summary" data-testid={`${kind}-snapshot-list-error`}>
          <p>
            Could not load more saved {kind} snapshots: {source.listError}. The history
            already shown is unchanged.
          </p>
          <button type="button" onClick={source.refresh}>
            Retry
          </button>
        </div>
      )}

      {source.listStatus === "ready" && source.items.length === 0 && (
        <p className="me-help">
          No saved {kind} snapshots yet. Save one from the Me page; saving does not change
          this source.
        </p>
      )}

      {source.items.length > 0 && (
        <ul className="artifact-history" data-testid={`${kind}-snapshot-history`}>
          {source.items.map((item) => (
            <li key={item.id} className="artifact-history-row">
              <span>
                <strong>{item.source_filename ?? "(unnamed file)"}</strong>
                {` · imported ${dateLabel(item.created_at)} · ${item.id}`}
              </span>
              <button
                type="button"
                aria-label={`View saved ${kind} snapshot ${item.source_filename ?? item.id}`}
                onClick={() => void source.select(item.id)}
                disabled={source.selectionBusy}
              >
                {source.selection === item.id
                  ? source.selected !== null
                    ? "Selected"
                    : "Selected (could not load)"
                  : "View snapshot"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {source.nextCursor !== null && (
        <button type="button" onClick={() => void source.loadMore()} disabled={source.loadingMore}>
          {source.loadingMore ? "Loading more…" : "Load more snapshots"}
        </button>
      )}
    </section>
  );
}

/** Provenance shown for a snapshot: file/import time, period, unverified links. */
export function ArtifactSnapshotMeta({
  artifact,
  records,
}: {
  artifact: ImportedArtifact;
  records: readonly WorkoutRecord[];
}) {
  const period = periodOf(artifact);
  const known = new Set(records.map((record) => record.id));
  const missing = artifact.source_record_ids.filter((id) => !known.has(id));
  const present = artifact.source_record_ids.length - missing.length;

  return (
    <div className="artifact-meta" data-testid={`${artifact.kind}-snapshot-meta`}>
      <p>
        <strong>{artifact.source_filename ?? "(unnamed file)"}</strong>
        {` · imported ${dateLabel(artifact.created_at)} · immutable snapshot ${artifact.id}`}
      </p>
      <p>{`Source period: ${period.from ?? "n/a"} – ${period.to ?? "n/a"}`}</p>
      <p data-testid={`${artifact.kind}-snapshot-linkage`}>
        {`${present} of ${artifact.source_record_ids.length} source record id(s) exist in current history; ${missing.length} missing.`}
        {" "}ID presence is not proof that this snapshot matches the current workouts; its payload does not update with history.
      </p>
      {missing.length > 0 && (
        <p className="me-help">
          {`Unverified external linkage — missing record id(s): ${missing.join(", ")}`}
        </p>
      )}
    </div>
  );
}
