import type { AnalysisResult } from "@agent-fit-trace/core";
import { useI18n } from "../i18n/useI18n.ts";
import {
  displayFlagMessage,
  displaySeverity,
  displayTrend,
} from "../i18n/domain.ts";

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
  const { language, t } = useI18n();
  const { metrics } = analysis;

  return (
    <>
      <p className="analysis-period">
        {t("Period: {from} – {to}", {
          from: analysis.period.from ?? t("n/a"),
          to: analysis.period.to ?? t("n/a"),
        })}
      </p>

      <section>
        <h2>{t("Metrics")}</h2>
        <ul className="analysis-metrics">
          <li>{t("Sessions: {count}", { count: metrics.sessions })}</li>
          <li>{t("Sets: {count}", { count: metrics.total_sets })}</li>
          <li>{t("Reps: {count}", { count: metrics.total_reps })}</li>
          <li>{t("Volume: {volume} kg", { volume: metrics.volume_kg })}</li>
          <li>
            {t("Average RPE: {rpe}", {
              rpe: metrics.avg_rpe === null ? t("n/a") : metrics.avg_rpe,
            })}
          </li>
          <li>{t("Average rest: {days} days", { days: metrics.avg_rest_days })}</li>
          <li>{t("Max gap: {days} days", { days: metrics.max_gap_days })}</li>
        </ul>
      </section>

      <section>
        <h2>{t("Trends")}</h2>
        {analysis.trends.length === 0 ? (
          <p>{t("No exercise trends yet.")}</p>
        ) : (
          <ul className="analysis-trends">
            {analysis.trends.map((trend) => (
              <li key={trend.exercise} data-trend-exercise={trend.exercise}>
                {displayTrend(language, trend)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{t("Flags")}</h2>
        {analysis.flags.length === 0 ? (
          <p>{t("No safety flags.")}</p>
        ) : (
          <ul className="analysis-flags">
            {analysis.flags.map((flag) => (
              <li
                key={flag.code}
                data-flag-code={flag.code}
                data-flag-severity={flag.severity}
              >
                {`${flag.code} (${displaySeverity(language, flag.severity)}): ${displayFlagMessage(
                  language,
                  flag,
                )}`}
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
        {t("Computed from {count} record(s).", { count: analysis.source_records.length })}
      </p>
    </>
  );
}
