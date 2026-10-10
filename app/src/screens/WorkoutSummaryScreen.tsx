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

  if (status === "loading") {
    return (
      <section>
        <h1>Workout Summary</h1>
        <p role="status">Loading workout…</p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section>
        <h1>Workout Summary</h1>
        <div role="alert" className="validation-summary" data-testid="summary-error">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const record = records.find((entry) => entry.id === id);

  if (record === undefined) {
    return (
      <section>
        <h1>Workout not found</h1>
        <p>No stored workout matches this id.</p>
        <Link to="/">Back to history</Link>
      </section>
    );
  }

  const metrics = summarizeMetrics([record]);
  const warnings = validateWorkoutRecord(record).warnings;
  // INSUFFICIENT_HISTORY describes the size of the analyzed history window, not
  // a single workout, so it is excluded from this per-workout review surface.
  const flags = detectFlags([record]).filter((flag) => flag.code !== "INSUFFICIENT_HISTORY");

  return (
    <section>
      <h1>Workout Summary</h1>

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
        <ul>
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
    </section>
  );
}
