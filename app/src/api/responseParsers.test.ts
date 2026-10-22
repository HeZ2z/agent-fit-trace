import { describe, expect, it } from "vitest";
import type { AnalysisResult, PlanDraft } from "@agent-fit-trace/core";
import { MalformedResponseError } from "./contracts.ts";
import { parseAnalysisResponse, parsePlanResponse } from "./responseParsers.ts";

const validAnalysis: AnalysisResult = {
  period: { from: "2026-01-01", to: "2026-01-31" },
  metrics: {
    sessions: 2,
    total_sets: 4,
    total_reps: 20,
    volume_kg: 1000,
    avg_rpe: 8,
    avg_rest_days: 2,
    max_gap_days: 2,
  },
  trends: [
    {
      exercise: "Squat",
      metric: "est_1rm_kg",
      sessions_compared: 2,
      first: 100,
      last: 110,
      delta: 10,
      delta_pct: 10,
      direction: "up",
    },
  ],
  flags: [{ code: "PAIN_REPORTED", severity: "critical", message: "Pain reported.", evidence: {} }],
  source_records: ["wkt_a", "wkt_b"],
};

const validPlan: PlanDraft = {
  is_draft: true,
  requires_confirmation: true,
  goal: "Get stronger",
  based_on: { period: { from: null, to: null }, sessions: 2, source_records: ["wkt_a"] },
  recommendations: [
    { action: "Progress load", detail: "Add 2.5 kg.", reason: "Volume is stable.", evidence: {} },
  ],
  safety_notes: ["Stop if pain increases."],
  professional_care_prompt: null,
};

function expectMalformed(run: () => unknown, field: string): void {
  try {
    run();
    throw new Error("expected a MalformedResponseError");
  } catch (error) {
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect((error as MalformedResponseError).field).toBe(field);
    expect((error as MalformedResponseError).message).toContain(field);
  }
}

describe("parseAnalysisResponse", () => {
  it("round-trips a valid AnalysisResult", () => {
    expect(parseAnalysisResponse(JSON.stringify(validAnalysis))).toEqual(validAnalysis);
  });

  it("rejects invalid JSON", () => {
    expectMalformed(() => parseAnalysisResponse("{not json"), "(root)");
  });

  it("rejects a non-object payload", () => {
    expectMalformed(() => parseAnalysisResponse("42"), "(root)");
  });

  it("rejects a missing metrics object, naming the field", () => {
    const withoutMetrics: Record<string, unknown> = { ...validAnalysis };
    delete withoutMetrics.metrics;
    expectMalformed(() => parseAnalysisResponse(JSON.stringify(withoutMetrics)), "metrics");
  });

  it("rejects a wrong-typed metrics field, naming the field", () => {
    const payload = { ...validAnalysis, metrics: { ...validAnalysis.metrics, sessions: "two" } };
    expectMalformed(() => parseAnalysisResponse(JSON.stringify(payload)), "metrics.sessions");
  });

  it("rejects a non-array source_records, naming the field", () => {
    const payload = { ...validAnalysis, source_records: "wkt_a" };
    expectMalformed(() => parseAnalysisResponse(JSON.stringify(payload)), "source_records");
  });

  it("rejects an unsupported trend metric, naming the field", () => {
    const payload = {
      ...validAnalysis,
      trends: [{ ...validAnalysis.trends[0], metric: "volume" }],
    };
    expectMalformed(() => parseAnalysisResponse(JSON.stringify(payload)), "trends[0].metric");
  });
});

describe("parsePlanResponse", () => {
  it("round-trips a valid PlanDraft", () => {
    expect(parsePlanResponse(JSON.stringify(validPlan))).toEqual(validPlan);
  });

  it("rejects is_draft: false, naming the field", () => {
    const payload = { ...validPlan, is_draft: false };
    expectMalformed(() => parsePlanResponse(JSON.stringify(payload)), "is_draft");
  });

  it("rejects recommendations that are not an array, naming the field", () => {
    const payload = { ...validPlan, recommendations: {} };
    expectMalformed(() => parsePlanResponse(JSON.stringify(payload)), "recommendations");
  });

  it("rejects a recommendation missing a required field, naming the field", () => {
    const payload = {
      ...validPlan,
      recommendations: [{ detail: "d", reason: "r", evidence: {} }],
    };
    expectMalformed(() => parsePlanResponse(JSON.stringify(payload)), "recommendations[0].action");
  });

  it("rejects invalid JSON", () => {
    expectMalformed(() => parsePlanResponse("nope"), "(root)");
  });
});
