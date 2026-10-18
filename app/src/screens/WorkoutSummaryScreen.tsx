import { Link, useParams } from "react-router-dom";
import {
  EXTREME_RPE,
  detectFlags,
  summarizeMetrics,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useI18n } from "../i18n/useI18n.ts";
import {
  displayFlagMessage,
  displaySessionType,
  displayWarning,
} from "../i18n/domain.ts";

export function WorkoutSummaryScreen() {
  const { id } = useParams<{ id: string }>();
  const { records, status, loadError, reload } = useWorkouts();
  const { language, t } = useI18n();

  const record = status === "ready" ? records.find((entry) => entry.id === id) : undefined;
  const notFound = status === "ready" && record === undefined;

  // The heading stays mounted across loading → ready so a settled query never
  // holds a detached node; only its text changes for the not-found state.
  function renderBody() {
    if (status === "loading") {
      return <p role="status">{t("Loading workout…")}</p>;
    }

    if (status === "error") {
      return (
        <div role="alert" className="validation-summary" data-testid="summary-error">
          <p>
            {t("Could not load workout history: {message}", {
              message: loadError?.message ?? t("Unknown error."),
            })}
          </p>
          <button type="button" onClick={reload}>
            {t("Retry")}
          </button>
        </div>
      );
    }

    if (record === undefined) {
      return (
        <>
          <p>{t("No stored workout matches this id.")}</p>
          <Link to="/">{t("Back to history")}</Link>
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
          <dt>{t("Date")}</dt>
          <dd>{record.date}</dd>
          <dt>{t("Session type")}</dt>
          <dd>{displaySessionType(language, record.session_type)}</dd>
          {record.duration_minutes !== undefined && (
            <>
              <dt>{t("Duration")}</dt>
              <dd>{t("{count} minutes", { count: record.duration_minutes })}</dd>
            </>
          )}
          {record.sleep_hours !== undefined && (
            <>
              <dt>{t("Sleep")}</dt>
              <dd>{t("{count} hours", { count: record.sleep_hours })}</dd>
            </>
          )}
          {record.notes !== undefined && (
            <>
              <dt>{t("Notes")}</dt>
              <dd>{record.notes}</dd>
            </>
          )}
        </dl>

        <section>
          <h2>{t("Exercises")}</h2>
          {record.exercises.map((exercise, exerciseIndex) => (
            <div key={`${exercise.name}-${exerciseIndex}`} className="summary-exercise">
              <h3>{exercise.name}</h3>
              <ul>
                {exercise.sets.map((set, setIndex) => {
                  const extreme = set.rpe !== undefined && set.rpe >= EXTREME_RPE;
                  const weight = set.weight !== undefined ? `${set.weight} kg` : t("weight n/a");
                  const rpe = set.rpe !== undefined ? `RPE ${set.rpe}` : t("RPE n/a");
                  return (
                    <li
                      key={`${exercise.name}-${setIndex}`}
                      data-safety={extreme ? "extreme-rpe" : undefined}
                    >
                      {t("{weight} × {reps} reps · {rpe}", { weight, reps: set.reps, rpe })}
                      {extreme && <span className="safety-badge">{t("Extreme effort")}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>

        {record.pain !== undefined && record.pain.length > 0 && (
          <section>
            <h2>{t("Pain")}</h2>
            <ul>
              {record.pain.map((entry, index) => (
                <li key={`${entry.area ?? "pain"}-${index}`} data-safety="pain">
                  {entry.level !== undefined
                    ? t("{area} — level {level}", {
                        area: entry.area ?? t("unspecified area"),
                        level: entry.level,
                      })
                    : (entry.area ?? t("unspecified area"))}
                  <span className="safety-badge">{t("Pain reported")}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2>{t("Metrics")}</h2>
          <ul className="metrics-list">
            <li>{t("Sets: {count}", { count: metrics.total_sets })}</li>
            <li>{t("Volume: {volume} kg", { volume: metrics.volume_kg })}</li>
            <li>
              {t("Average RPE: {rpe}", {
                rpe: metrics.avg_rpe === null ? t("n/a") : metrics.avg_rpe,
              })}
            </li>
          </ul>
        </section>

        {flags.length > 0 && (
          <section>
            <h2>{t("Safety flags")}</h2>
            <ul className="flag-list">
              {flags.map((flag) => (
                <li key={flag.code} data-flag-code={flag.code} data-flag-severity={flag.severity}>
                  {displayFlagMessage(language, flag)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {warnings.length > 0 && (
          <ul role="status" aria-label={t("Warnings")} className="validation-warnings">
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} data-warning-code={warning.code}>
                {displayWarning(language, warning)}
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
          <h1>{notFound ? t("Workout not found") : t("Workout Summary")}</h1>
          {!notFound && (
            <p className="screen-lede">
              {t(
                "One stored session: sets, computed metrics and any safety flags that apply to it.",
              )}
            </p>
          )}
        </div>
      </div>
      {renderBody()}
    </section>
  );
}
