import { Link } from "react-router-dom";
import { summarizeMetrics } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { useWorkouts } from "../state/useWorkouts.ts";

function HistoryRow({ record }: { record: WorkoutRecord }) {
  const metrics = summarizeMetrics([record]);
  const avgRpe = metrics.avg_rpe === null ? "n/a" : metrics.avg_rpe;
  const setLabel = metrics.total_sets === 1 ? "set" : "sets";

  return (
    <li className="history-row">
      <Link
        to={`/workout/${record.id}`}
        aria-label={`View ${record.session_type} workout on ${record.date}`}
      >
        {record.date} — {record.session_type}
      </Link>
      <span className="history-summary">
        {`${metrics.total_sets} ${setLabel} · ${metrics.volume_kg} kg · avg RPE ${avgRpe}`}
      </span>
    </li>
  );
}

export function HistoryScreen() {
  const { records, status, loadError, reload } = useWorkouts();

  // The client returns records in ascending date order; reverse explicitly so
  // the most recent workout appears first.
  const newestFirst = [...records].reverse();

  return (
    <section data-screen="history">
      <div className="screen-head">
        <div className="screen-head-main">
          <h1>Workout History</h1>
          <p className="screen-lede">
            Append-only training records, newest first. Open a session for its metrics and
            safety review.
          </p>
        </div>
        <p className="screen-actions">
          <Link className="btn-ghost" to="/me">
            Manage imports and exports
          </Link>
        </p>
      </div>

      {status === "loading" && <p role="status">Loading workout history…</p>}

      {status === "error" && (
        <div role="alert" className="validation-summary" data-testid="history-error">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      {status === "ready" &&
        (records.length === 0 ? (
          <div className="empty-state">
            <p>No workouts yet.</p>
            <Link to="/workout/new">Log your first workout</Link>
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
