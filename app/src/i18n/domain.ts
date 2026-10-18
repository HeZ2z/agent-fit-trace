/**
 * Chinese rebuild rules for deterministic, code-bearing content.
 *
 * Stored payloads (analysis results, plan drafts, workout records, snapshots
 * and exports) stay canonical English. These helpers rebuild a Chinese display
 * sentence from the stable code plus its evidence at render time, and return
 * the original English string whenever a code or a required value is unknown —
 * translations never invent numbers.
 *
 * Workout content itself is never translated: exercise names, notes, ids and
 * dates pass through unchanged.
 */

import { EXTREME_RPE } from "@pi-fit-trace/core";
import type {
  AnalysisFlag,
  ExerciseTrend,
  Recommendation,
  Severity,
  ValidationWarning,
  ValidationIssue,
} from "@pi-fit-trace/core";
import type { AppLanguage } from "./i18n.ts";
import { domainZh } from "./zh/domain.ts";

type Evidence = Record<string, unknown>;

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function list(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => String(entry));
}

/** Session type values are canonical data; only their display label changes. */
export function displaySessionType(language: AppLanguage, value: string): string {
  if (language !== "zh") return value;
  return domainZh.sessionTypes[value] ?? value;
}

export function displaySeverity(language: AppLanguage, severity: Severity): string {
  if (language !== "zh") return severity;
  return domainZh.severities[severity] ?? severity;
}

export function displayTrend(language: AppLanguage, trend: ExerciseTrend): string {
  const delta = `${trend.delta >= 0 ? "+" : ""}${trend.delta}`;
  if (language !== "zh") {
    return `${trend.exercise}: ${trend.first} → ${trend.last} (${delta} kg, ${trend.delta_pct}%, ${trend.direction})`;
  }
  const direction = domainZh.trendDirections[trend.direction] ?? trend.direction;
  return `${trend.exercise}：${trend.first} → ${trend.last}（${delta} kg，${trend.delta_pct}%，${direction}）`;
}

/** Rebuild a flag message from its code and evidence; fall back to English. */
export function displayFlagMessage(language: AppLanguage, flag: AnalysisFlag): string {
  if (language !== "zh") return flag.message;
  const evidence: Evidence = flag.evidence;
  switch (flag.code) {
    case "PAIN_REPORTED": {
      const records = list(evidence.record_ids);
      return records === null ? flag.message : domainZh.flags.painReported(records.length);
    }
    case "EXTREME_RPE": {
      const maxRpe = numeric(evidence.max_rpe);
      return maxRpe === null ? flag.message : domainZh.flags.extremeRpe(maxRpe);
    }
    case "VOLUME_SPIKE": {
      const change = numeric(evidence.change_pct);
      return change === null ? flag.message : domainZh.flags.volumeSpike(change);
    }
    case "VOLUME_DROP": {
      const change = numeric(evidence.change_pct);
      return change === null ? flag.message : domainZh.flags.volumeDrop(Math.abs(change));
    }
    case "MISSING_RECOVERY_DATA":
      return domainZh.flags.missingRecoveryData;
    case "INSUFFICIENT_HISTORY": {
      const sessions = numeric(evidence.sessions);
      const minimum = numeric(evidence.minimum);
      return sessions === null || minimum === null
        ? flag.message
        : domainZh.flags.insufficientHistory(sessions, minimum);
    }
    default:
      return flag.message;
  }
}

export interface DisplayRecommendation {
  action: string;
  detail: string;
  reason: string;
}

/** Rebuild recommendation copy from the action code and evidence. */
export function displayRecommendation(
  language: AppLanguage,
  recommendation: Recommendation,
): DisplayRecommendation {
  const english: DisplayRecommendation = {
    action: recommendation.action,
    detail: recommendation.detail,
    reason: recommendation.reason,
  };
  if (language !== "zh") return english;
  const evidence: Evidence = recommendation.evidence;
  const actionLabel = (code: string): string => domainZh.actions[code] ?? code;

  switch (recommendation.action) {
    case "import_history":
      return {
        action: actionLabel("import_history"),
        detail: domainZh.recommendationCopy.importHistoryDetail,
        reason: domainZh.recommendationCopy.importHistoryReason,
      };
    case "reduce_or_pause_loading":
      return {
        action: actionLabel("reduce_or_pause_loading"),
        detail: domainZh.recommendationCopy.reduceOrPauseDetail,
        reason: domainZh.recommendationCopy.reduceOrPauseReason,
      };
    case "cap_intensity": {
      const maxRpe = numeric(evidence.max_rpe);
      return {
        action: actionLabel("cap_intensity"),
        detail: domainZh.recommendationCopy.capIntensityDetail(EXTREME_RPE - 2),
        reason:
          maxRpe === null
            ? english.reason
            : domainZh.recommendationCopy.capIntensityReason(maxRpe),
      };
    }
    case "hold_volume": {
      const change = numeric(evidence.change_pct);
      return {
        action: actionLabel("hold_volume"),
        detail: domainZh.recommendationCopy.holdVolumeDetail,
        reason:
          change === null ? english.reason : domainZh.recommendationCopy.holdVolumeReason(change),
      };
    }
    case "rebuild_volume": {
      const change = numeric(evidence.change_pct);
      return {
        action: actionLabel("rebuild_volume"),
        detail: domainZh.recommendationCopy.rebuildVolumeDetail,
        reason:
          change === null
            ? english.reason
            : domainZh.recommendationCopy.rebuildVolumeReason(Math.abs(change)),
      };
    }
    case "progressive_overload": {
      const exercise = text(evidence.exercise);
      const deltaPct = numeric(evidence.delta_pct);
      const avgRpe = numeric(evidence.avg_rpe);
      if (exercise === null || deltaPct === null) return english;
      return {
        action: actionLabel("progressive_overload"),
        detail: domainZh.recommendationCopy.progressiveOverloadDetail(exercise),
        reason: domainZh.recommendationCopy.progressiveOverloadReason(
          exercise,
          deltaPct,
          avgRpe === null ? domainZh.recommendationCopy.notRecorded : String(avgRpe),
        ),
      };
    }
    case "maintain": {
      const considered = numeric(evidence.trends_considered);
      const avgRpe = numeric(evidence.avg_rpe);
      if (considered === null) return english;
      return {
        action: actionLabel("maintain"),
        detail: domainZh.recommendationCopy.maintainDetail,
        reason:
          considered === 0
            ? domainZh.recommendationCopy.maintainNoTrends
            : domainZh.recommendationCopy.maintainReason(
                avgRpe === null ? domainZh.recommendationCopy.notRecorded : String(avgRpe),
              ),
      };
    }
    case "schedule": {
      const days = numeric(evidence.days_available);
      return {
        action: actionLabel("schedule"),
        detail:
          days === null
            ? english.detail
            : domainZh.recommendationCopy.scheduleDetail(days),
        reason: domainZh.recommendationCopy.scheduleReason,
      };
    }
    case "equipment": {
      const equipment = list(evidence.equipment);
      return {
        action: actionLabel("equipment"),
        detail:
          equipment === null
            ? english.detail
            : domainZh.recommendationCopy.equipmentDetail(equipment.join("、")),
        reason: domainZh.recommendationCopy.equipmentReason,
      };
    }
    default:
      return english;
  }
}

/** Rebuild a plan safety note; unknown or user-authored notes stay as typed. */
export function displaySafetyNote(language: AppLanguage, note: string): string {
  if (language !== "zh") return note;
  const fixed = domainZh.safetyNotes[note];
  if (fixed !== undefined) return fixed;

  const lowConfidence = /^Only (\d+) session\(s\) are available; treat this plan as low-confidence\.$/.exec(
    note,
  );
  if (lowConfidence !== null) {
    return domainZh.safetyLowConfidence(Number(lowConfidence[1]));
  }
  const prefix = "User constraint: ";
  if (note.startsWith(prefix)) {
    return domainZh.safetyUserConstraint(note.slice(prefix.length));
  }
  return note;
}

export function displayCarePrompt(language: AppLanguage, prompt: string): string {
  if (language !== "zh") return prompt;
  return domainZh.carePrompts[prompt] ?? prompt;
}

/** Rebuild a validation issue/warning message from its English source. */
export function displayValidationMessage(language: AppLanguage, message: string): string {
  if (language !== "zh") return message;
  const fixed = domainZh.validationMessages[message];
  if (fixed !== undefined) return fixed;

  // Import parse errors wrap the field and reason into one sentence; translate
  // the inner reason and keep the path token intact.
  const imported = /^Invalid import: `(.+)` (.*)\.$/.exec(message);
  if (imported !== null) {
    return `导入无效：\`${imported[1]}\` ${displayValidationMessage(language, imported[2])}。`;
  }
  for (const rule of domainZh.validationPatterns) {
    const match = rule.pattern.exec(message);
    if (match !== null) return rule.zh(match);
  }
  return message;
}

export function displayIssue(language: AppLanguage, issue: ValidationIssue): string {
  return displayValidationMessage(language, issue.message);
}

export function displayWarning(language: AppLanguage, warning: ValidationWarning): string {
  return displayValidationMessage(language, warning.message);
}
