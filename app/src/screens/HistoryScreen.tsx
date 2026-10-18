import { Link } from "react-router-dom";
import { summarizeMetrics } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useI18n } from "../i18n/useI18n.ts";
import { displaySessionType } from "../i18n/domain.ts";

function HistoryRow({ record }: { record: WorkoutRecord }) {
  const { language, t } = useI18n();
  const metrics = summarizeMetrics([record]);
  const avgRpe = metrics.avg_rpe === null ? t("n/a") : metrics.avg_rpe;

  return (
    <li className="history-row">
      <Link
        to={`/workout/${record.id}`}
        aria-label={t("View {type} workout on {date}", {
          type: displaySessionType(language, record.session_type),
          date: record.date,
        })}
      >
        {record.date} — {displaySessionType(language, record.session_type)}
      </Link>
      <span className="history-summary">
        {metrics.total_sets === 1
          ? t("{count} set · {volume} kg · avg RPE {rpe}", {
              count: metrics.total_sets,
              volume: metrics.volume_kg,
              rpe: avgRpe,
            })
          : t("{count} sets · {volume} kg · avg RPE {rpe}", {
              count: metrics.total_sets,
              volume: metrics.volume_kg,
              rpe: avgRpe,
            })}
      </span>
    </li>
  );
}

export function HistoryScreen() {
  const { records, status, loadError, reload } = useWorkouts();
  const { t } = useI18n();

  // The client returns records in ascending date order; reverse explicitly so
  // the most recent workout appears first.
  const newestFirst = [...records].reverse();

  return (
    <section data-screen="history">
      <div className="screen-head">
        <div className="screen-head-main">
          <h1>{t("Workout History")}</h1>
          <p className="screen-lede">
            {t(
              "Append-only training records, newest first. Open a session for its metrics and safety review.",
            )}
          </p>
        </div>
        <p className="screen-actions">
          <Link className="btn-ghost" to="/me">
            {t("Manage imports and exports")}
          </Link>
        </p>
      </div>

      {status === "loading" && <p role="status">{t("Loading workout history…")}</p>}

      {status === "error" && (
        <div role="alert" className="validation-summary" data-testid="history-error">
          <p>
            {t("Could not load workout history: {message}", {
              message: loadError?.message ?? t("Unknown error."),
            })}
          </p>
          <button type="button" onClick={reload}>
            {t("Retry")}
          </button>
        </div>
      )}

      {status === "ready" &&
        (records.length === 0 ? (
          <div className="empty-state">
            <p>{t("No workouts yet.")}</p>
            <Link to="/workout/new">{t("Log your first workout")}</Link>
          </div>
        ) : (
          <ul className="history-list">
            {newestFirst.map((record) => (
              <HistoryRow key={record.id} record={record} />
            ))}
          </ul>
        ))}
    </section>
  );
}
