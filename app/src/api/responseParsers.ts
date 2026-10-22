import type {
  AnalysisFlag,
  AnalysisMetrics,
  AnalysisResult,
  ExerciseTrend,
  PlanDraft,
  Recommendation,
  Severity,
} from "@agent-fit-trace/core";
import { MalformedResponseError } from "./contracts.ts";

/** Parsed response payloads run through these guards before use. */

function fail(field: string, reason: string): never {
  throw new MalformedResponseError(field, reason);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) fail(field, "must be an object");
  return value;
}

function assertArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field, "must be an array");
  return value;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field, "must be a string");
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(field, "must be a finite number");
  }
  return value;
}

function assertStringOrNull(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") fail(field, "must be a string or null");
  return value;
}

function assertNumberOrNull(value: unknown, field: string): number | null {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    fail(field, "must be a finite number or null");
  }
  return value;
}

function assertStringArray(value: unknown, field: string): string[] {
  return assertArray(value, field).map((entry, index) =>
    assertString(entry, `${field}[${index}]`),
  );
}

function parsePeriod(value: unknown, field: string): { from: string | null; to: string | null } {
  const obj = assertObject(value, field);
  return {
    from: assertStringOrNull(obj.from, `${field}.from`),
    to: assertStringOrNull(obj.to, `${field}.to`),
  };
}

function parseMetrics(value: unknown): AnalysisMetrics {
  const obj = assertObject(value, "metrics");
  return {
    sessions: assertNumber(obj.sessions, "metrics.sessions"),
    total_sets: assertNumber(obj.total_sets, "metrics.total_sets"),
    total_reps: assertNumber(obj.total_reps, "metrics.total_reps"),
    volume_kg: assertNumber(obj.volume_kg, "metrics.volume_kg"),
    avg_rpe: assertNumberOrNull(obj.avg_rpe, "metrics.avg_rpe"),
    avg_rest_days: assertNumber(obj.avg_rest_days, "metrics.avg_rest_days"),
    max_gap_days: assertNumber(obj.max_gap_days, "metrics.max_gap_days"),
  };
}

function parseTrend(value: unknown, field: string): ExerciseTrend {
  const obj = assertObject(value, field);
  const direction = assertString(obj.direction, `${field}.direction`);
  if (direction !== "up" && direction !== "down" && direction !== "flat") {
    fail(`${field}.direction`, "must be one of up, down, flat");
  }
  const metric = assertString(obj.metric, `${field}.metric`);
  if (metric !== "est_1rm_kg") {
    fail(`${field}.metric`, 'must be "est_1rm_kg"');
  }
  return {
    exercise: assertString(obj.exercise, `${field}.exercise`),
    metric,
    sessions_compared: assertNumber(obj.sessions_compared, `${field}.sessions_compared`),
    first: assertNumber(obj.first, `${field}.first`),
    last: assertNumber(obj.last, `${field}.last`),
    delta: assertNumber(obj.delta, `${field}.delta`),
    delta_pct: assertNumber(obj.delta_pct, `${field}.delta_pct`),
    direction,
  };
}

function parseFlag(value: unknown, field: string): AnalysisFlag {
  const obj = assertObject(value, field);
  const severity = assertString(obj.severity, `${field}.severity`);
  if (severity !== "info" && severity !== "warning" && severity !== "critical") {
    fail(`${field}.severity`, "must be one of info, warning, critical");
  }
  return {
    code: assertString(obj.code, `${field}.code`),
    severity: severity as Severity,
    message: assertString(obj.message, `${field}.message`),
    evidence: assertObject(obj.evidence, `${field}.evidence`),
  };
}

function parseRecommendation(value: unknown, field: string): Recommendation {
  const obj = assertObject(value, field);
  return {
    action: assertString(obj.action, `${field}.action`),
    detail: assertString(obj.detail, `${field}.detail`),
    reason: assertString(obj.reason, `${field}.reason`),
    evidence: assertObject(obj.evidence, `${field}.evidence`),
  };
}

function parseRoot(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("(root)", "is not valid JSON");
  }
  return assertObject(parsed, "(root)");
}

/** Parse and strictly validate an `analyze_progress` response. */
export function parseAnalysisResponse(text: string): AnalysisResult {
  const root = parseRoot(text);

  return {
    period: parsePeriod(root.period, "period"),
    metrics: parseMetrics(root.metrics),
    trends: assertArray(root.trends, "trends").map((trend, index) =>
      parseTrend(trend, `trends[${index}]`),
    ),
    flags: assertArray(root.flags, "flags").map((flag, index) => parseFlag(flag, `flags[${index}]`)),
    source_records: assertStringArray(root.source_records, "source_records"),
  };
}

/** Parse and strictly validate a `generate_next_plan` response. */
export function parsePlanResponse(text: string): PlanDraft {
  const root = parseRoot(text);

  if (root.is_draft !== true) fail("is_draft", "must be true");
  if (root.requires_confirmation !== true) fail("requires_confirmation", "must be true");

  const basedOn = assertObject(root.based_on, "based_on");
  const recommendations = assertArray(root.recommendations, "recommendations").map(
    (recommendation, index) => parseRecommendation(recommendation, `recommendations[${index}]`),
  );

  return {
    is_draft: true,
    requires_confirmation: true,
    goal: assertStringOrNull(root.goal, "goal"),
    based_on: {
      period: parsePeriod(basedOn.period, "based_on.period"),
      sessions: assertNumber(basedOn.sessions, "based_on.sessions"),
      source_records: assertStringArray(basedOn.source_records, "based_on.source_records"),
    },
    recommendations,
    safety_notes: assertStringArray(root.safety_notes, "safety_notes"),
    professional_care_prompt: assertStringOrNull(
      root.professional_care_prompt,
      "professional_care_prompt",
    ),
  };
}
