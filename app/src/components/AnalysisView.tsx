import type { AnalysisResult } from "@pi-fit-trace/core";

/**
 * Single shared renderer for a deterministic {@link AnalysisResult}.
 *
 * Extracted verbatim from `AnalysisScreen` so the Coach screen (and any later
 * surface) reuses ONE view instead of a copied ~100-line block. The markup and
 * class names are unchanged, so existing analysis assertions stay valid.
 */
export function formatEvidenceValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function AnalysisView({ analysis }: { analysis: AnalysisResult }) {
  const { metrics } = analysis;

  return (
    <>
      <p className="analysis-period">
        {`Period: ${analysis.period.from ?? "n/a"} – ${analysis.period.to ?? "n/a"}`}
      </p>

      <section>
        <h2>Metrics</h2>
        <ul className="analysis-metrics">
          <li>{`Sessions: ${metrics.sessions}`}</li>
          <li>{`Sets: ${metrics.total_sets}`}</li>
          <li>{`Reps: ${metrics.total_reps}`}</li>
          <li>{`Volume: ${metrics.volume_kg} kg`}</li>
          <li>{`Average RPE: ${metrics.avg_rpe === null ? "n/a" : metrics.avg_rpe}`}</li>
          <li>{`Average rest: ${metrics.avg_rest_days} days`}</li>
          <li>{`Max gap: ${metrics.max_gap_days} days`}</li>
        </ul>
      </section>

      <section>
        <h2>Trends</h2>
        {analysis.trends.length === 0 ? (
          <p>No exercise trends yet.</p>
        ) : (
          <ul className="analysis-trends">
            {analysis.trends.map((trend) => (
              <li key={trend.exercise} data-trend-exercise={trend.exercise}>
                {`${trend.exercise}: ${trend.first} → ${trend.last} (${trend.delta >= 0 ? "+" : ""}${
                  trend.delta
                } kg, ${trend.delta_pct}%, ${trend.direction})`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Flags</h2>
        {analysis.flags.length === 0 ? (
          <p>No safety flags.</p>
        ) : (
          <ul className="analysis-flags">
            {analysis.flags.map((flag) => (
              <li
                key={flag.code}
                data-flag-code={flag.code}
                data-flag-severity={flag.severity}
              >
                {`${flag.code} (${flag.severity}): ${flag.message}`}
                <ul className="flag-evidence">
                  {Object.entries(flag.evidence).map(([key, value]) => (
                    <li key={key}>{`${key}: ${formatEvidenceValue(value)}`}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="analysis-source-count">
        {`Computed from ${analysis.source_records.length} record(s).`}
      </p>
    </>
  );
}
