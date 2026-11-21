/**
 * Deterministic, bounded text renderings for tool results.
 *
 * The model only receives a tool's `content.text`, never the structured
 * `details`, so the text has to carry the evidence (record ids, trend numbers,
 * flag codes, recommendation evidence) in a compact, bounded form. These
 * formatters are browser-safe (no Node/pi/typebox imports), never mutate their
 * inputs, and are pure functions of the structured payload.
 */
import type {
  AnalysisResult,
  ExerciseTrend,
  PlanDraft,
  Recommendation,
  WorkoutRecord,
} from "./types.ts";

/** Record lines kept in history text before truncating. */
const MAX_RECORD_LINES = 10;
/** Trends kept in analysis text. */
const MAX_TRENDS = 10;
/** Flags kept in analysis text. */
const MAX_FLAGS = 10;
/** Source record ids kept in analysis/plan text. */
const MAX_SOURCE_RECORDS = 20;
/** Recommendations kept in plan text. */
const MAX_RECOMMENDATIONS = 10;
/** Safety notes kept in plan text. */
const MAX_SAFETY_NOTES = 10;
/** Exercises listed per record before `+N more`. */
const MAX_EXERCISES_PER_RECORD = 10;
/** Maximum characters for an id/name/note fragment. */
const MAX_FRAGMENT = 80;
/** Maximum characters for a compact evidence JSON blob. */
const MAX_EVIDENCE = 200;
/** Maximum characters for the professional-care prompt. */
const MAX_PROMPT = 400;

/** Paging metadata already returned by the store query. */
export interface HistoryPageInfo {
  total: number;
  offset: number;
  limit: number | null;
}

function truncate(value: string, max: number = MAX_FRAGMENT): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `bench_press (3 sets), squat (1 set)` with bounded exercise count/length. */
function describeExercises(record: WorkoutRecord): string {
  const shown = record.exercises.slice(0, MAX_EXERCISES_PER_RECORD);
  const parts = shown.map((exercise) => {
    const name = truncate(exercise.name);
    return `${name} (${plural(exercise.sets.length, "set")})`;
  });
  const remaining = record.exercises.length - shown.length;
  if (remaining > 0) parts.push(`+${remaining} more`);
  return parts.join(", ");
}

/**
 * A uniform-set summary is only cheap when every set in the record shares the
 * same reps, weight, and (if all declared) RPE. Anything mixed is omitted
 * rather than printed as a misleading range.
 */
function describeUniformSets(record: WorkoutRecord): string | null {
  const sets = record.exercises.flatMap((exercise) => exercise.sets);
  if (sets.length === 0) return null;

  const reps = sets[0].reps;
  if (!sets.every((set) => set.reps === reps)) return null;

  const weight = sets[0].weight;
  if (!sets.every((set) => set.weight === weight)) return null;

  const base = weight === undefined ? plural(reps, "rep") : `${weight} kg x ${reps}`;
  const rpe = sets[0].rpe;
  const uniformRpe = rpe !== undefined && sets.every((set) => set.rpe === rpe);
  return uniformRpe ? `${base} @RPE ${rpe}` : base;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function describeTrend(trend: ExerciseTrend): string {
  return `${trend.exercise}: ${trend.first} -> ${trend.last} kg (${signed(trend.delta)}, ${signed(trend.delta_pct)}%), ${trend.direction}, ${plural(trend.sessions_compared, "session")}`;
}

function describeSourceRecords(ids: readonly string[]): string {
  if (ids.length === 0) return "Source records: none.";
  const shown = ids.slice(0, MAX_SOURCE_RECORDS).map((id) => truncate(id));
  const remaining = ids.length - shown.length;
  return `Source records: ${shown.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}.`;
}

function compactEvidence(evidence: Record<string, unknown>): string {
  let json: string;
  try {
    const serialized = JSON.stringify(evidence);
    json = serialized === undefined ? "{}" : serialized;
  } catch {
    json = "{}";
  }
  return truncate(json, MAX_EVIDENCE);
}

function describeRecommendation(recommendation: Recommendation): string {
  return `${recommendation.action}: ${truncate(recommendation.detail)} Reason: ${truncate(recommendation.reason)} Evidence: ${compactEvidence(recommendation.evidence)}`;
}

/**
 * Render history records plus paging guidance.
 *
 * The first line is the stable summary prefix every existing test matches:
 * `Returned N of TOTAL matching record(s).`
 */
export function formatHistoryText(
  records: readonly WorkoutRecord[],
  page: HistoryPageInfo,
): string {
  const lines: string[] = [`Returned ${records.length} of ${page.total} matching record(s).`];

  const shown = records.slice(0, MAX_RECORD_LINES);
  for (const record of shown) {
    const parts = [describeExercises(record), describeUniformSets(record)].filter(
      (part): part is string => part !== null && part !== "",
    );
    const suffix = parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
    lines.push(`- ${truncate(record.id)} | ${record.date} | ${record.session_type}${suffix}`);
  }

  if (records.length === 0) {
    lines.push("No matching records. Import workouts or widen the date/exercise filter.");
  }

  const pagingHint = page.limit === null ? "" : ` and limit ${page.limit}`;
  const hiddenReturned = records.length - shown.length;
  if (hiddenReturned > 0) {
    lines.push(
      `... ${hiddenReturned} more returned record(s) not shown; call again with offset ${page.offset + shown.length}${pagingHint}.`,
    );
  } else if (page.total > page.offset + records.length) {
    const remaining = page.total - (page.offset + records.length);
    lines.push(
      `... ${remaining} more matching record(s) exist; call again with offset ${page.offset + records.length}${pagingHint}.`,
    );
  }

  return lines.join("\n");
}

/**
 * Render analysis metrics, trends, flags, and source records.
 *
 * The first line is the stable summary prefix: `Analyzed N session(s): volume
 * V kg, avg RPE R, F flag(s).`
 */
export function formatAnalysisText(analysis: AnalysisResult): string {
  const { metrics, period, trends, flags, source_records } = analysis;
  const lines: string[] = [
    `Analyzed ${metrics.sessions} session(s): volume ${metrics.volume_kg} kg, avg RPE ${metrics.avg_rpe ?? "n/a"}, ${flags.length} flag(s).`,
    `Period: ${period.from ?? "n/a"} -> ${period.to ?? "n/a"}; sets ${metrics.total_sets}, reps ${metrics.total_reps}, avg rest ${metrics.avg_rest_days} day(s), max gap ${metrics.max_gap_days} day(s).`,
  ];

  if (trends.length === 0) {
    lines.push("Trends: none.");
  } else {
    lines.push("Trends (est. 1RM, first -> last):");
    for (const trend of trends.slice(0, MAX_TRENDS)) lines.push(`- ${describeTrend(trend)}`);
    if (trends.length > MAX_TRENDS) {
      lines.push(`- ... ${trends.length - MAX_TRENDS} more trend(s) not shown.`);
    }
  }

  if (flags.length === 0) {
    lines.push("Flags: none.");
  } else {
    lines.push("Flags:");
    for (const flag of flags.slice(0, MAX_FLAGS)) {
      lines.push(`- ${flag.code} (${flag.severity}): ${truncate(flag.message, MAX_EVIDENCE)}`);
    }
    if (flags.length > MAX_FLAGS) {
      lines.push(`- ... ${flags.length - MAX_FLAGS} more flag(s) not shown.`);
    }
  }

  lines.push(describeSourceRecords(source_records));
  return lines.join("\n");
}

/**
 * Render a draft plan with recommendations and their evidence.
 *
 * The first line is the stable draft-status prefix: `Generated a draft plan
 * with N recommendation(s). This is a draft and requires user confirmation.`
 */
export function formatPlanText(draft: PlanDraft): string {
  const goal = draft.goal === null ? "" : `; goal: ${truncate(draft.goal)}`;
  const lines: string[] = [
    `Generated a draft plan with ${draft.recommendations.length} recommendation(s). This is a draft and requires user confirmation.`,
    `Based on ${draft.based_on.sessions} session(s) from ${draft.based_on.period.from ?? "n/a"} to ${draft.based_on.period.to ?? "n/a"}${goal}.`,
    describeSourceRecords(draft.based_on.source_records),
  ];

  const recommendations = draft.recommendations.slice(0, MAX_RECOMMENDATIONS);
  if (recommendations.length === 0) {
    lines.push("Recommendations: none.");
  } else {
    lines.push("Recommendations:");
    for (const recommendation of recommendations) {
      lines.push(`- ${describeRecommendation(recommendation)}`);
    }
    if (draft.recommendations.length > recommendations.length) {
      lines.push(
        `- ... ${draft.recommendations.length - recommendations.length} more recommendation(s) not shown.`,
      );
    }
  }

  if (draft.safety_notes.length > 0) {
    lines.push("Safety notes:");
    for (const note of draft.safety_notes.slice(0, MAX_SAFETY_NOTES)) {
      lines.push(`- ${truncate(note, MAX_EVIDENCE)}`);
    }
    if (draft.safety_notes.length > MAX_SAFETY_NOTES) {
      lines.push(`- ... ${draft.safety_notes.length - MAX_SAFETY_NOTES} more note(s) not shown.`);
    }
  }

  if (draft.professional_care_prompt !== null) {
    lines.push(`Professional care: ${truncate(draft.professional_care_prompt, MAX_PROMPT)}`);
  }

  return lines.join("\n");
}
