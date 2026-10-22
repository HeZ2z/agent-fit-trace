import type { ImportedArtifact } from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { isHttpModeActive } from "../api/runtimeMode.ts";
import type { ArtifactSource } from "../state/useArtifactSource.ts";
import { useI18n } from "../i18n/useI18n.ts";
import { displayValidationMessage } from "../i18n/domain.ts";

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
  const { language, t } = useI18n();
  const { kind } = source;
  const kindLabel = t(kind);
  const label = kind === "analysis" ? t("Analysis") : t("Plan");
  const currentLabel = isHttpModeActive()
    ? t("current computed (not a saved snapshot)")
    : t("current computed (local)");
  const sourceLabel =
    source.selectionStatus === "loading"
      ? t("loading saved selection (unknown)")
      : source.selectionStatus === "error"
        ? t("saved selection unknown (read failure)")
        : source.selection === null
          ? currentLabel
          : t("imported snapshot ({id})", { id: source.selection });

  return (
    <section className="artifact-source" aria-labelledby={`${kind}-source-heading`}>
      <h2 id={`${kind}-source-heading`}>{t("Viewing source")}</h2>
      <p data-testid={`${kind}-source`}>
        {t("{kind} source: {source}", { kind: label, source: sourceLabel })}
      </p>

      <div className="artifact-source-actions">
        <button
          type="button"
          onClick={() => void source.select(null)}
          disabled={
            source.selectionBusy ||
            (source.selectionStatus === "ready" && source.selection === null)
          }
        >
          {t("Show current computed {kind}", { kind: kindLabel })}
        </button>
        <button type="button" onClick={source.refresh} disabled={source.selectionBusy}>
          {t("Refresh saved data")}
        </button>
      </div>

      {source.selectionWarning !== null && (
        <p role="status" className="me-help" data-testid={`${kind}-selection-warning`}>
          {source.selectionWarning}
        </p>
      )}

      {source.selectionError !== null && (
        <div role="alert" className="validation-summary" data-testid={`${kind}-selection-error`}>
          <p>{displayValidationMessage(language, source.selectionError)}</p>
          <button
            type="button"
            onClick={() => void source.retrySelected()}
            disabled={source.selectionBusy}
          >
            {t("Retry loading the saved snapshot")}
          </button>
        </div>
      )}

      {source.listStatus === "loading" && source.selectionLoading ? (
        <p role="status">{t("Loading saved {kind} snapshots…", { kind: kindLabel })}</p>
      ) : null}

      {source.listStatus === "error" && (
        <div role="alert" className="validation-summary" data-testid={`${kind}-snapshot-list-error`}>
          <p>
            {t("Could not load saved {kind} snapshot history: {error}", {
              kind: kindLabel,
              error: displayValidationMessage(language, source.listError ?? ""),
            })}
          </p>
          <button type="button" onClick={source.refresh}>
            {t("Retry")}
          </button>
        </div>
      )}

      {source.listStatus === "ready" && source.listError !== null && (
        <div role="alert" className="validation-summary" data-testid={`${kind}-snapshot-list-error`}>
          <p>
            {t("Could not load more saved {kind} snapshots: {error}. The history already shown is unchanged.", {
              kind: kindLabel,
              error: displayValidationMessage(language, source.listError),
            })}
          </p>
          <button type="button" onClick={source.refresh}>
            {t("Retry")}
          </button>
        </div>
      )}

      {source.listStatus === "ready" && source.items.length === 0 && (
        <p className="me-help">
          {t("No saved {kind} snapshots yet. Save one from the Me page; saving does not change this source.", {
            kind: kindLabel,
          })}
        </p>
      )}

      {source.items.length > 0 && (
        <ul className="artifact-history" data-testid={`${kind}-snapshot-history`}>
          {source.items.map((item) => (
            <li key={item.id} className="artifact-history-row">
              <span>
                <strong>{item.source_filename ?? t("(unnamed file)")}</strong>
                {t(" · imported {date} · {id}", {
                  date: dateLabel(item.created_at),
                  id: item.id,
                })}
              </span>
              <button
                type="button"
                aria-label={t("View saved {kind} snapshot {name}", {
                  kind: kindLabel,
                  name: item.source_filename ?? item.id,
                })}
                onClick={() => void source.select(item.id)}
                disabled={source.selectionBusy}
              >
                {source.selection === item.id
                  ? source.selected !== null
                    ? t("Selected")
                    : t("Selected (could not load)")
                  : t("View snapshot")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {source.nextCursor !== null && (
        <button type="button" onClick={() => void source.loadMore()} disabled={source.loadingMore}>
          {source.loadingMore ? t("Loading more…") : t("Load more snapshots")}
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
  const { t } = useI18n();
  const period = periodOf(artifact);
  const known = new Set(records.map((record) => record.id));
  const missing = artifact.source_record_ids.filter((id) => !known.has(id));
  const present = artifact.source_record_ids.length - missing.length;

  return (
    <div className="artifact-meta" data-testid={`${artifact.kind}-snapshot-meta`}>
      <p>
        <strong>{artifact.source_filename ?? t("(unnamed file)")}</strong>
        {t(" · imported {date} · immutable snapshot {id}", {
          date: dateLabel(artifact.created_at),
          id: artifact.id,
        })}
      </p>
      <p>
        {t("Source period: {from} – {to}", {
          from: period.from ?? t("n/a"),
          to: period.to ?? t("n/a"),
        })}
      </p>
      <p data-testid={`${artifact.kind}-snapshot-linkage`}>
        {t(
          "{present} of {total} source record id(s) exist in current history; {missing} missing.",
          {
            present,
            total: artifact.source_record_ids.length,
            missing: missing.length,
          },
        )}{" "}
        {t(
          "ID presence is not proof that this snapshot matches the current workouts; its payload does not update with history.",
        )}
      </p>
      {missing.length > 0 && (
        <p className="me-help">
          {t("Unverified external linkage — missing record id(s): {ids}", {
            ids: missing.join(", "),
          })}
        </p>
      )}
    </div>
  );
}
