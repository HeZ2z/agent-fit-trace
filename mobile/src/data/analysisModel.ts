import { analyzeProgress, toDateKey, toEpochMs } from "@agent-fit-trace/core";
import type {
  AnalysisFlag,
  AnalysisMetrics,
  ExerciseTrend,
  Severity,
  WorkoutRecord,
} from "@agent-fit-trace/core";
import type { AppLanguage } from "@agent-fit-trace/i18n";
import { displayFlagMessage, displaySeverity } from "@agent-fit-trace/i18n/domain";

/**
 * Pure display model for the Analysis screen.
 *
 * The core owns every computed number, trend and flag; this module only picks
 * the evidence the screen shows and formats it. It imports no React, expo,
 * storage, DOM or current clock, so the root `node:test` suite can load it
 * through Node's TypeScript type stripping.
 *
 * Flag severity and message translation stay in the shared `display*` domain
 * helpers. An unknown flag code therefore keeps the canonical English message
 * emitted by the core instead of inventing a translation here.
 */

const MILLIS_PER_DAY = 86_400_000;

/** Date coverage of the records the analysis was computed from. */
export interface AnalysisSpan {
  first: string | null;
  last: string | null;
  /** Distinct Monday-based week buckets that contain at least one session. */
  activeWeeks: number;
  /** Elapsed calendar days between the first and last session (0 for one date). */
  days: number;
}

/** Everything the Analysis screen renders, derived in one deterministic pass. */
export interface AnalysisSummary {
  isEmpty: boolean;
  metrics: AnalysisMetrics;
  period: { from: string | null; to: string | null };
  span: AnalysisSpan;
  /** Most informative trend (largest absolute change), or null when none exists. */
  trend: ExerciseTrend | null;
  trends: ExerciseTrend[];
  /** Core flags ordered by severity, with core order preserved inside a severity. */
  flags: AnalysisFlag[];
  sourceCount: number;
}

/** A flag ready for display: localized severity plus the shared display message. */
export interface AnalysisFlagView {
  code: string;
  severity: Severity;
  severityLabel: string;
  message: string;
}

function severityRank(severity: string): number {
  switch (severity) {
    case "critical":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
    default:
      // Future core severities stay visible after the known ones; displaySeverity
      // also falls back to the raw code so nothing is silently relabelled.
      return 3;
  }
}

/**
 * Order flags from most to least urgent. The sort is stable, so the core's own
 * detection order still decides between two flags of the same severity.
 */
export function sortFlagsBySeverity(flags: readonly AnalysisFlag[]): AnalysisFlag[] {
  return flags
    .map((flag, index) => ({ flag, index }))
    .sort(
      (a, b) =>
        severityRank(a.flag.severity) - severityRank(b.flag.severity) || a.index - b.index,
    )
    .map((entry) => entry.flag);
}

/** Flag rows with severity and message localized through the shared domain layer. */
export function buildFlagViews(
  language: AppLanguage,
  flags: readonly AnalysisFlag[],
): AnalysisFlagView[] {
  return sortFlagsBySeverity(flags).map((flag) => ({
    code: flag.code,
    severity: flag.severity,
    severityLabel: displaySeverity(language, flag.severity),
    message: displayFlagMessage(language, flag),
  }));
}

/**
 * Pick the trend that carries the most evidence: the largest absolute percent
 * change, then the exercise name for a deterministic tie-break.
 */
export function selectPrimaryTrend(trends: readonly ExerciseTrend[]): ExerciseTrend | null {
  let primary: ExerciseTrend | null = null;
  for (const trend of trends) {
    if (primary === null) {
      primary = trend;
      continue;
    }
    const delta = Math.abs(trend.delta_pct);
    const primaryDelta = Math.abs(primary.delta_pct);
    if (delta > primaryDelta) {
      primary = trend;
    } else if (delta === primaryDelta && trend.exercise < primary.exercise) {
      primary = trend;
    }
  }
  return primary;
}

function sessionDates(records: readonly WorkoutRecord[]): string[] {
  const dates = new Set<string>();
  for (const record of records) {
    const key = toDateKey(record.date);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) dates.add(key);
  }
  return [...dates].sort();
}

/** Monday-based week index; negative days are floored so pre-1970 dates align too. */
function weekStartDay(date: string): number {
  const day = Math.floor(toEpochMs(date) / MILLIS_PER_DAY);
  const offset = (((day + 3) % 7) + 7) % 7;
  return day - offset;
}

/** Active-week count plus the elapsed span of the analysed sessions. */
export function sessionSpan(records: readonly WorkoutRecord[]): AnalysisSpan {
  const dates = sessionDates(records);
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) {
    return { first: null, last: null, activeWeeks: 0, days: 0 };
  }

  const days = Math.max(0, Math.round((toEpochMs(last) - toEpochMs(first)) / MILLIS_PER_DAY));
  const weeks = new Set(dates.map(weekStartDay));
  return { first, last, activeWeeks: weeks.size, days };
}

/** Build the Analysis screen model from stored (already validated) records. */
export function buildAnalysisSummary(records: readonly WorkoutRecord[]): AnalysisSummary {
  // Core accepts a mutable array; keep the caller's list untouched.
  const snapshot = [...records];
  const analysis = analyzeProgress(snapshot);

  return {
    isEmpty: snapshot.length === 0,
    metrics: analysis.metrics,
    period: analysis.period,
    span: sessionSpan(snapshot),
    trend: selectPrimaryTrend(analysis.trends),
    trends: analysis.trends,
    flags: sortFlagsBySeverity(analysis.flags),
    sourceCount: analysis.source_records.length,
  };
}

/**
 * Format a finite metric deterministically for both languages.
 *
 * Grouping and the decimal separator stay Latin so kg values read the same in
 * English and Chinese; trailing zeros are trimmed so `1000` reads `1,000`
 * rather than `1,000.00`.
 */
export function formatNumber(value: number, maximumFractionDigits = 0): string {
  if (!Number.isFinite(value)) return "—";

  const digits = Math.min(6, Math.max(0, Math.trunc(maximumFractionDigits)));
  const rounded = Number(value.toFixed(digits));
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const [integerPart = "0", fractionPart = ""] = Math.abs(normalized)
    .toFixed(digits)
    .split(".");
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = fractionPart.replace(/0+$/, "");

  return `${normalized < 0 ? "-" : ""}${grouped}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Volume is a kg total; show at most the two decimals the core keeps. */
export function formatVolumeKg(value: number): string {
  return formatNumber(value, 2);
}
