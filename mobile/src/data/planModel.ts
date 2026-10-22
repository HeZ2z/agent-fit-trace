import { MIN_HISTORY_SESSIONS, generateNextPlan } from "@agent-fit-trace/core";
import type { Recommendation, WorkoutRecord } from "@agent-fit-trace/core";
import type { AppLanguage } from "@agent-fit-trace/i18n";
import {
  displayCarePrompt,
  displayRecommendation,
  displaySafetyNote,
} from "@agent-fit-trace/i18n/domain";

/**
 * Pure display model for the Plan screen.
 *
 * `generateNextPlan(records, constraints?)` takes the records directly and runs
 * `analyzeProgress` internally; this module passes no constraints and adds no
 * second analysis pass. The draft stays a draft: this module never adopts a
 * plan, writes a snapshot, touches storage or the network, or reads a clock.
 *
 * Recommendation, safety-note and care-prompt copy is rebuilt by the shared
 * `display*` domain helpers. Unknown action codes, unknown safety notes and
 * missing evidence therefore keep the canonical English emitted by the core.
 */

/** Confidence the core's low-history threshold implies for the draft. */
export type PlanConfidence = "low" | "standard";

/** Compact context taken from the draft's `based_on` block. */
export interface PlanSummary {
  sessions: number;
  from: string | null;
  to: string | null;
  confidence: PlanConfidence;
}

/** One recommendation ready to render; `code` is the stable core action. */
export interface PlanRecommendationView {
  code: string;
  /** Localized action label, or the raw code when it is unknown. */
  action: string;
  detail: string;
  reason: string;
}

/** Everything the Plan screen renders, derived in one deterministic pass. */
export interface PlanModel {
  isEmpty: boolean;
  isDraft: true;
  requiresConfirmation: true;
  /** Display-only draft: there is no adoption or application path here. */
  applied: false;
  summary: PlanSummary;
  recommendations: PlanRecommendationView[];
  safetyNotes: string[];
  carePrompt: string | null;
}

function confidenceFor(sessions: number): PlanConfidence {
  return sessions < MIN_HISTORY_SESSIONS ? "low" : "standard";
}

/** Map one core recommendation through the shared display layer. */
export function buildRecommendationView(
  language: AppLanguage,
  recommendation: Recommendation,
): PlanRecommendationView {
  const displayed = displayRecommendation(language, recommendation);
  return {
    code: recommendation.action,
    action: displayed.action,
    detail: displayed.detail,
    reason: displayed.reason,
  };
}

/** Rebuild each safety note; unknown or user-authored notes stay as typed. */
export function localizeSafetyNotes(
  language: AppLanguage,
  notes: readonly string[],
): string[] {
  return notes.map((note) => displaySafetyNote(language, note));
}

/**
 * Build the Plan screen model from stored (already validated) records.
 *
 * The caller's list and records are never mutated: the draft is computed from
 * a shallow copy, and every rendered string is rebuilt at render time.
 */
export function buildPlanModel(
  records: readonly WorkoutRecord[],
  language: AppLanguage,
): PlanModel {
  // Core accepts a mutable array; keep the caller's list untouched.
  const snapshot = [...records];
  const draft = generateNextPlan(snapshot);

  return {
    isEmpty: snapshot.length === 0,
    isDraft: draft.is_draft,
    requiresConfirmation: draft.requires_confirmation,
    // The core returns a draft and never writes; the UI has no apply action.
    applied: false,
    summary: {
      sessions: draft.based_on.sessions,
      from: draft.based_on.period.from,
      to: draft.based_on.period.to,
      confidence: confidenceFor(draft.based_on.sessions),
    },
    recommendations: draft.recommendations.map((recommendation) =>
      buildRecommendationView(language, recommendation),
    ),
    safetyNotes: localizeSafetyNotes(language, draft.safety_notes),
    carePrompt:
      draft.professional_care_prompt === null
        ? null
        : displayCarePrompt(language, draft.professional_care_prompt),
  };
}
