/**
 * Chinese display layer — screens-analysis-plan.
 *
 * Keys are the exact English source strings; values are Simplified Chinese.
 * An entry that is missing falls back to English, so this table is safe to
 * extend in slices.
 */
export const messages: Record<string, string> = {
  /* ── Shared screen chrome ────────────────────────────────────── */
  "Manage imports and exports": "管理导入和导出",
  "Could not load workout history: {message}": "无法加载训练历史：{message}",
  "Unknown error.": "未知错误。",
  Retry: "重试",
  "Log your first workout": "记录你的第一次训练",
  "n/a": "暂无",

  /* ── Progress analysis ───────────────────────────────────────── */
  "Progress Analysis": "进度分析",
  "Deterministic metrics, exercise trends and safety flags computed from the same records every time. No model call is involved.":
    "每次都会基于同一批记录计算确定性的指标、动作趋势和安全标记。不涉及任何模型调用。",
  "Loading analysis…": "正在加载分析…",
  "Could not load analysis: {message}": "无法加载分析：{message}",
  "No workout history to analyse yet.": "还没有可分析的训练历史。",
  "Period: {from} – {to}": "周期：{from} – {to}",
  Metrics: "指标",
  "Sessions: {count}": "训练课：{count}",
  "Sets: {count}": "组数：{count}",
  "Reps: {count}": "次数：{count}",
  "Volume: {volume} kg": "容量：{volume} kg",
  "Average RPE: {rpe}": "平均 RPE：{rpe}",
  "Average rest: {days} days": "平均休息：{days} 天",
  "Max gap: {days} days": "最大间隔：{days} 天",
  Trends: "趋势",
  "No exercise trends yet.": "暂无动作趋势。",
  Flags: "安全标记",
  "No safety flags.": "暂无安全标记。",
  "Computed from {count} record(s).": "基于 {count} 条记录计算。",

  /* ── Training plan ───────────────────────────────────────────── */
  "Training Plan": "训练计划",
  "A rule-based next-session draft. Every recommendation cites the evidence that produced it, and nothing is adopted without explicit confirmation.":
    "根据规则生成的下一节训练课草稿。每条建议都会引用产生它的证据，未经明确确认不会采用任何内容。",
  "Goal: {goal}": "目标：{goal}",
  "Based on: {from} – {to}, {sessions} session(s), {records} source record(s)":
    "基于：{from} – {to}，{sessions} 节训练课，{records} 条来源记录",
  Recommendations: "建议",
  "No recommendations.": "暂无建议。",
  "Reason: {reason}": "原因：{reason}",
  "Safety notes": "安全提示",
  "No additional safety notes.": "暂无其他安全提示。",
  "Loading plan…": "正在加载计划…",
  "Could not load plan: {message}": "无法加载计划：{message}",
  "No workout history to draft a plan from yet.": "暂无训练历史可用于生成计划草稿。",
  "Plan status: confirmed only in this view (not saved or adopted)":
    "计划状态：仅在此视图中确认（未保存或采用）",
  "Plan status: draft (generated current plan, not saved or adopted)":
    "计划状态：草稿（当前生成的计划，未保存或采用）",
  "Discard this-view confirmation": "放弃此视图的确认",
  "Confirm plan for this view only": "仅为此视图确认计划",

  /* ── Plan snapshots and adoption ─────────────────────────────── */
  "Saved plan adoption": "已保存计划的采用",
  "Loading saved adoption…": "正在加载已保存的采用状态…",
  "Could not load the saved plan adoption: {error}. No adoption is claimed while this fails.":
    "无法加载已保存的计划采用状态：{error}。加载失败期间不会声称已采用任何计划。",
  "Retry adoption": "重新加载采用状态",
  "Currently adopted plan snapshot: none.": "当前采用的计划快照：无。",
  "Currently adopted plan snapshot: {id} (confirmed {at}).":
    "当前采用的计划快照：{id}（确认于 {at}）。",
  "No plan adopted.": "尚未采用计划。",
  "A saved plan is adopted.": "已采用一个已保存的计划。",
  "Adoption status: {status}.": "采用状态：{status}。",
  "This saved plan is adopted.": "已采用此已保存计划。",
  "This saved plan is not adopted.": "尚未采用此已保存计划。",
  "Revoke adoption": "撤销采用",
  "Adopt this plan": "采用此计划",
  "This plan is adopted.": "此计划已采用。",
  "This plan is a draft.": "此计划为草稿。",
  "Revoke saved adoption (metadata only)": "撤销已保存的采用（仅元数据）",
  "Selected saved snapshot {id}: the saved adoption is {status}. Viewing this snapshot never changes it.":
    "已选保存的快照 {id}：已保存的采用状态为 {status}。查看此快照不会改变它。",
  "Selected saved snapshot {id} is the currently adopted plan.":
    "已选保存的快照 {id} 是当前采用的计划。",
  "Selected saved snapshot {id} is not adopted. Viewing a snapshot never adopts it; a new import does not inherit the previous adoption.":
    "已选保存的快照 {id} 未被采用。查看快照永远不会采用它；新的导入也不会继承之前的采用。",
  "Confirm adopting this exact saved snapshot": "确认采用这个精确的已保存快照",
  "Use Revoke above to clear the saved adoption; viewing any source never changes it.":
    "使用上方的“撤销”清除已保存的采用；查看任何来源都不会改变它。",
  "Adoption binds this exact artifact id and content digest. It never changes the snapshot’s draft flags and never writes workout records.":
    "采用会绑定这个确切的制品 ID 和内容摘要。它永远不会改变快照的草稿标记，也永远不会写入训练记录。",
  "Could not adopt this plan snapshot: {error}": "无法采用此计划快照：{error}",
  "Could not revoke the adopted plan: {error}": "无法撤销已采用的计划：{error}",
  "Snapshot status: draft flags is_draft={isDraft}, requires_confirmation={requiresConfirmation}. {note}":
    "快照状态：草稿标记 is_draft={isDraft}，requires_confirmation={requiresConfirmation}。{note}",
  "The saved adoption is separate and does not change these flags.":
    "已保存的采用是独立的，不会改变这些标记。",
  "Viewing this snapshot does not adopt it.": "查看此快照不会采用它。",
  "Professional care": "专业医疗照护",
};
