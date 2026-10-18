import { describe, expect, it } from "vitest";
import { generateNextPlan, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { AnalysisFlag, Recommendation, WorkoutRecord } from "@pi-fit-trace/core";
import {
  displayCarePrompt,
  displayFlagMessage,
  displayRecommendation,
  displaySafetyNote,
  displaySessionType,
  displaySeverity,
  displayTrend,
  displayValidationMessage,
} from "./domain.ts";

function flag(overrides: Partial<AnalysisFlag> = {}): AnalysisFlag {
  return {
    code: "PAIN_REPORTED",
    severity: "critical",
    message: "Pain was reported in 2 session(s).",
    evidence: { record_ids: ["a", "b"] },
    ...overrides,
  };
}

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    action: "hold_volume",
    detail: "Repeat last session's volume rather than adding more; progress only if recovery is good.",
    reason: "Latest volume was 44.9% above the recent average.",
    evidence: {
      latest_volume_kg: 1667.5,
      prior_avg_volume_kg: 1150.83,
      change_pct: 44.9,
    },
    ...overrides,
  };
}

describe("deterministic domain display layer", () => {
  it("leaves English payload strings byte-identical", () => {
    expect(displaySessionType("en", "strength")).toBe("strength");
    expect(displaySeverity("en", "critical")).toBe("critical");

    const trend = {
      exercise: "Back squat",
      metric: "est_1rm_kg" as const,
      sessions_compared: 4,
      first: 116.67,
      last: 125.42,
      delta: 8.75,
      delta_pct: 7.5,
      direction: "up" as const,
    };
    expect(displayTrend("en", trend)).toBe("Back squat: 116.67 → 125.42 (+8.75 kg, 7.5%, up)");

    const painFlag = flag();
    expect(displayFlagMessage("en", painFlag)).toBe(painFlag.message);
    expect(displayRecommendation("en", recommendation())).toEqual({
      action: "hold_volume",
      detail: recommendation().detail,
      reason: recommendation().reason,
    });
    expect(
      displaySafetyNote("en", "At least one set reached RPE 9 or higher."),
    ).toBe("At least one set reached RPE 9 or higher.");
    expect(displayValidationMessage("en", "`id` must be a non-empty string")).toBe(
      "`id` must be a non-empty string",
    );
  });

  it("translates session types and severity labels but keeps unknown values", () => {
    expect(displaySessionType("zh", "strength")).toBe("力量");
    expect(displaySessionType("zh", "cardio")).toBe("有氧");
    expect(displaySessionType("zh", "crossfit")).toBe("crossfit");
    expect(displaySeverity("zh", "critical")).toBe("严重");
    expect(displaySeverity("zh", "info")).toBe("提示");
  });

  it("rebuilds trend sentences from the data values", () => {
    const trend = {
      exercise: "Back squat",
      metric: "est_1rm_kg" as const,
      sessions_compared: 4,
      first: 116.67,
      last: 125.42,
      delta: 8.75,
      delta_pct: 7.5,
      direction: "up" as const,
    };
    expect(displayTrend("zh", trend)).toBe(
      "Back squat：116.67 → 125.42（+8.75 kg，7.5%，上升）",
    );
  });

  it("rebuilds flag messages from code plus evidence", () => {
    expect(displayFlagMessage("zh", flag())).toBe("已记录疼痛：2 次训练中出现疼痛。");

    expect(
      displayFlagMessage(
        "zh",
        flag({
          code: "EXTREME_RPE",
          severity: "critical",
          evidence: { record_ids: ["a"], set_count: 2, max_rpe: 9.5 },
        }),
      ),
    ).toBe("2 组达到 RPE 9 或更高。");

    expect(
      displayFlagMessage(
        "zh",
        flag({ code: "VOLUME_SPIKE", severity: "warning", evidence: { change_pct: 44.9 } }),
      ),
    ).toBe("最近一次训练容量比近期平均值高 44.9%。");

    expect(
      displayFlagMessage(
        "zh",
        flag({ code: "VOLUME_DROP", severity: "warning", evidence: { change_pct: -18.2 } }),
      ),
    ).toBe("最近一次训练容量比近期平均值低 18.2%。");

    expect(
      displayFlagMessage(
        "zh",
        flag({ code: "INSUFFICIENT_HISTORY", severity: "info", evidence: { sessions: 2, minimum: 4 } }),
      ),
    ).toBe("仅有 2 次训练；少于 4 次会降低趋势可信度。");

    expect(
      displayFlagMessage(
        "zh",
        flag({ code: "MISSING_RECOVERY_DATA", severity: "warning", evidence: { sessions: 3 } }),
      ),
    ).toBe("本周期未记录恢复数据（sleep_hours）。");
  });

  it("falls back to the English flag message when evidence is missing", () => {
    const english = flag({ code: "EXTREME_RPE", evidence: { max_rpe: 9.5 } });
    expect(displayFlagMessage("zh", english)).toBe(english.message);

    const unknown = flag({ code: "NEW_FLAG", message: "Something new." });
    expect(displayFlagMessage("zh", unknown)).toBe("Something new.");
  });

  it("rebuilds recommendations from action plus evidence", () => {
    expect(displayRecommendation("zh", recommendation())).toEqual({
      action: "保持容量",
      detail: "重复上一次训练的容量，不要继续加量；恢复良好后再进阶。",
      reason: "最近容量比近期平均值高 44.9%。",
    });

    expect(
      displayRecommendation(
        "zh",
        recommendation({
          action: "progressive_overload",
          detail: "Add a small increase (~2.5% load or one rep per set) to Back squat.",
          reason:
            "Estimated 1RM for Back squat rose 7.5% across 4 sessions at an average RPE of 6.77.",
          evidence: { exercise: "Back squat", delta_pct: 7.5, avg_rpe: 6.77 },
        }),
      ),
    ).toMatchObject({
      action: "渐进超负荷",
      detail: expect.stringContaining("Back squat"),
      reason: expect.stringContaining("7.5%"),
    });

    expect(
      displayRecommendation(
        "zh",
        recommendation({
          action: "cap_intensity",
          detail: "Keep working sets at or below RPE 7 next session.",
          reason: "The recorded maximum RPE was 9.5, indicating maximal effort.",
          evidence: { max_rpe: 9.5 },
        }),
      ),
    ).toMatchObject({
      action: "限制强度",
      reason: expect.stringContaining("9.5"),
    });

    expect(
      displayRecommendation(
        "zh",
        recommendation({
          action: "import_history",
          detail: "Import at least one workout record before generating a plan.",
          reason: "No training history is available, so no evidence-based plan can be produced.",
          evidence: { sessions: 0 },
        }),
      ),
    ).toMatchObject({ action: "导入历史" });
  });

  it("keeps payload copy for unknown actions and untranslated evidence", () => {
    const custom = recommendation({ action: "custom_action", evidence: {} });
    expect(displayRecommendation("zh", custom)).toEqual({
      action: "custom_action",
      detail: custom.detail,
      reason: custom.reason,
    });
  });

  it("preserves imported instructions that reuse a built-in action code", () => {
    const imported = recommendation({
      action: "cap_intensity",
      detail: "Keep RPE at or below 5 next session.",
      reason: "The imported coach asked for a deload.",
      evidence: { max_rpe: 9.5 },
    });
    expect(displayRecommendation("zh", imported)).toEqual({
      action: "cap_intensity",
      detail: "Keep RPE at or below 5 next session.",
      reason: "The imported coach asked for a deload.",
    });
  });

  it("rebuilds every recommendation produced by the local generator", () => {
    const record = (overrides: Record<string, unknown>): WorkoutRecord =>
      validateWorkoutRecord({
        schema_version: 1,
        session_type: "strength",
        exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 7 }] }],
        ...overrides,
      }).record;

    const painExtreme = record({
      id: "pain",
      date: "2026-01-01",
      pain: [{ area: "lower back", level: 3 }],
      exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 1, rpe: 10 }] }],
    });
    const volumeA = record({
      id: "volume-a",
      date: "2026-01-03",
      exercises: [{ name: "Squat", sets: [{ weight: 50, reps: 5, rpe: 6 }] }],
    });
    const volumeB = record({
      id: "volume-b",
      date: "2026-01-05",
      duration_minutes: 40,
      sleep_hours: 8,
      exercises: [{ name: "Squat", sets: [{ weight: 120, reps: 5, rpe: 6 }] }],
    });
    const flatA = record({
      id: "flat-a",
      date: "2026-01-07",
      duration_minutes: 40,
      sleep_hours: 8,
      exercises: [{ name: "Bench press", sets: [{ weight: 80, reps: 5, rpe: 6 }] }],
    });
    const flatB = record({
      id: "flat-b",
      date: "2026-01-09",
      duration_minutes: 40,
      sleep_hours: 8,
      exercises: [{ name: "Bench press", sets: [{ weight: 80, reps: 5, rpe: 6 }] }],
    });

    const plans = [
      generateNextPlan([]),
      generateNextPlan([painExtreme]),
      generateNextPlan([volumeA, volumeB]),
      generateNextPlan([flatA, flatB]),
      generateNextPlan([flatA, flatB], { days_available: 3, equipment: ["barbell"] }),
    ];

    const seen = new Set<string>();
    for (const plan of plans) {
      for (const entry of plan.recommendations) {
        const displayed = displayRecommendation("zh", entry);
        expect(displayed.action, entry.action).not.toBe(entry.action);
        expect(displayed.detail).not.toBe(entry.detail);
        expect(displayed.reason).not.toBe(entry.reason);
        seen.add(entry.action);
      }
    }
    expect([...seen].sort()).toEqual(
      [
        "cap_intensity",
        "equipment",
        "hold_volume",
        "import_history",
        "maintain",
        "reduce_or_pause_loading",
        "schedule",
      ].sort(),
    );
  });

  it("rebuilds safety notes, user constraints and care prompts", () => {
    expect(
      displaySafetyNote("zh", "Pain was reported. Avoid loading the affected area and prioritize recovery."),
    ).toBe("已记录疼痛。避免对受影响部位施加负荷，优先恢复。");
    expect(
      displaySafetyNote("zh", "Only 2 session(s) are available; treat this plan as low-confidence."),
    ).toBe("仅有 2 次训练可用；请将此计划视为低置信度。");
    expect(displaySafetyNote("zh", "User constraint: travel week")).toBe(
      "用户约束：travel week",
    );
    expect(displaySafetyNote("zh", "Untranslated note.")).toBe("Untranslated note.");

    expect(
      displayCarePrompt(
        "zh",
        "If pain persists, worsens, or is sharp, seek evaluation from a qualified medical professional before continuing.",
      ),
    ).toBe("如果疼痛持续、加重或呈锐痛，请在继续训练前寻求专业医疗评估。");
    expect(displayCarePrompt("zh", "Custom care prompt.")).toBe("Custom care prompt.");
  });

  it("rebuilds validation messages by message and by pattern", () => {
    expect(displayValidationMessage("zh", "`date` must be a valid ISO 8601 date (YYYY-MM-DD) or datetime")).toBe(
      "`date` 必须是有效的 ISO 8601 日期（YYYY-MM-DD）或日期时间",
    );
    expect(displayValidationMessage("zh", "Unknown field `extra` will be ignored")).toBe(
      "未知字段 `extra` 将被忽略",
    );
    expect(
      displayValidationMessage("zh", "`schema_version` is missing; assuming 1"),
    ).toBe("`schema_version` 缺失；按 1 处理");
    expect(
      displayValidationMessage("zh", "Invalid import: `(root)` the workout file is empty."),
    ).toBe("导入无效：`(root)` workout 文件为空。");
    expect(displayValidationMessage("zh", "A message from elsewhere.")).toBe(
      "A message from elsewhere.",
    );
  });
});
