import { Link, useParams } from "react-router-dom";
import {
  EXTREME_RPE,
  detectFlags,
  summarizeMetrics,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import { useWorkouts } from "../state/useWorkouts.ts";

export function WorkoutSummaryScreen() {
  const { id } = useParams<{ id: string }>();
  const { records, status, loadError, reload } = useWorkouts();

  const record = status === "ready" ? records.find((entry) => entry.id === id) : undefined;
  const notFound = status === "ready" && record === undefined;

  // The heading stays mounted across loading → ready so a settled query never
  // holds a detached node; only its text changes for the not-found state.
  function renderBody() {
    if (status === "loading") {
      return <p role="status">Loading workout…</p>;
    }

    if (status === "error") {
      return (
        <div role="alert" className="validation-summary" data-testid="summary-error">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      );
    }

    if (record === undefined) {
      return (
        <>
          <p>No stored workout matches this id.</p>
          <Link to="/">Back to history</Link>
        </>
      );
    }

    const metrics = summarizeMetrics([record]);
    const warnings = validateWorkoutRecord(record).warnings;
    // INSUFFICIENT_HISTORY describes the size of the analyzed history window,
    // not a single workout, so it is excluded from this per-workout review
    // surface.
    const flags = detectFlags([record]).filter((flag) => flag.code !== "INSUFFICIENT_HISTORY");

    return (
      <>
        <dl className="summary-details">
          <dt>Date</dt>
          <dd>{record.date}</dd>
          <dt>Session type</dt>
          <dd>{record.session_type}</dd>
          {record.duration_minutes !== undefined && (
            <>
              <dt>Duration</dt>
              <dd>{record.duration_minutes} minutes</dd>
            </>
          )}
          {record.sleep_hours !== undefined && (
            <>
              <dt>Sleep</dt>
              <dd>{record.sleep_hours} hours</dd>
            </>
          )}
          {record.notes !== undefined && (
            <>
              <dt>Notes</dt>
              <dd>{record.notes}</dd>
            </>
          )}
        </dl>

        <section>
          <h2>Exercises</h2>
          {record.exercises.map((exercise, exerciseIndex) => (
            <div key={`${exercise.name}-${exerciseIndex}`} className="summary-exercise">
              <h3>{exercise.name}</h3>
              <ul>
                {exercise.sets.map((set, setIndex) => {
                  const extreme = set.rpe !== undefined && set.rpe >= EXTREME_RPE;
                  const weight = set.weight !== undefined ? `${set.weight} kg` : "weight n/a";
                  const rpe = set.rpe !== undefined ? `RPE ${set.rpe}` : "RPE n/a";
                  return (
                    <li
                      key={`${exercise.name}-${setIndex}`}
                      data-safety={extreme ? "extreme-rpe" : undefined}
                    >
                      {`${weight} × ${set.reps} reps · ${rpe}`}
                      {extreme && <span className="safety-badge">Extreme effort</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>

        {record.pain !== undefined && record.pain.length > 0 && (
          <section>
            <h2>Pain</h2>
            <ul>
              {record.pain.map((entry, index) => (
                <li key={`${entry.area ?? "pain"}-${index}`} data-safety="pain">
                  {`${entry.area ?? "unspecified area"}${
                    entry.level !== undefined ? ` — level ${entry.level}` : ""
                  }`}
                  <span className="safety-badge">Pain reported</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2>Metrics</h2>
          <ul className="metrics-list">
            <li>{`Sets: ${metrics.total_sets}`}</li>
            <li>{`Volume: ${metrics.volume_kg} kg`}</li>
            <li>{`Average RPE: ${metrics.avg_rpe === null ? "n/a" : metrics.avg_rpe}`}</li>
          </ul>
        </section>

        {flags.length > 0 && (
          <section>
            <h2>Safety flags</h2>
            <ul className="flag-list">
              {flags.map((flag) => (
                <li key={flag.code} data-flag-code={flag.code} data-flag-severity={flag.severity}>
                  {flag.message}
                </li>
              ))}
            </ul>
          </section>
        )}

        {warnings.length > 0 && (
          <ul role="status" aria-label="Warnings" className="validation-warnings">
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} data-warning-code={warning.code}>
                {warning.message}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section data-screen="summary">
      <div className="screen-head">
        <div className="screen-head-main">
          <h1>{notFound ? "Workout not found" : "Workout Summary"}</h1>
          {!notFound && (
            <p className="screen-lede">
              One stored session: sets, computed metrics and any safety flags that apply to it.
            </p>
          )}
        </div>
      </div>
      {renderBody()}
    </section>
  );
}
