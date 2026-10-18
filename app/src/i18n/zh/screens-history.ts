/**
 * Chinese display layer — screens-history.
 *
 * Keys are the exact English source strings; values are Simplified Chinese.
 * An entry that is missing falls back to English, so this table is safe to
 * extend in slices.
 */
export const messages: Record<string, string> = {
  /* ── History ─────────────────────────────────────────────────── */
  "Workout History": "训练历史",
  "Append-only training records, newest first. Open a session for its metrics and safety review.":
    "仅追加的训练记录，最新在前。打开一场训练课即可查看其指标与安全审查。",
  "Manage imports and exports": "管理导入和导出",
  "Loading workout history…": "正在加载训练历史…",
  "Could not load workout history: {message}": "无法加载训练历史：{message}",
  "Unknown error.": "未知错误。",
  Retry: "重试",
  "No workouts yet.": "尚无训练记录。",
  "Log your first workout": "记录你的第一次训练",
  "View {type} workout on {date}": "查看 {date} 的 {type} 训练课",
  "{count} set · {volume} kg · avg RPE {rpe}": "{count} 组 · {volume} kg · 平均 RPE {rpe}",
  "{count} sets · {volume} kg · avg RPE {rpe}": "{count} 组 · {volume} kg · 平均 RPE {rpe}",
  "n/a": "暂无",

  /* ── Workout summary ─────────────────────────────────────────── */
  "Loading workout…": "正在加载训练…",
  "No stored workout matches this id.": "没有与此 ID 匹配的训练记录。",
  "Back to history": "返回历史",
  Date: "日期",
  "Session type": "训练类型",
  Duration: "时长",
  "{count} minutes": "{count} 分钟",
  Sleep: "睡眠",
  "{count} hours": "{count} 小时",
  Notes: "备注",
  Exercises: "动作",
  "weight n/a": "重量暂无",
  "RPE n/a": "RPE 暂无",
  "{weight} × {reps} reps · {rpe}": "{weight} × {reps} 次 · {rpe}",
  "Extreme effort": "极度用力",
  Pain: "疼痛",
  "unspecified area": "未指明部位",
  "{area} — level {level}": "{area} — 等级 {level}",
  "Pain reported": "已报告疼痛",
  Metrics: "指标",
  "Sets: {count}": "组数：{count}",
  "Volume: {volume} kg": "容量：{volume} kg",
  "Average RPE: {rpe}": "平均 RPE：{rpe}",
  "Safety flags": "安全标记",
  Warnings: "警告",
  "Workout not found": "未找到训练记录",
  "Workout Summary": "训练摘要",
  "One stored session: sets, computed metrics and any safety flags that apply to it.":
    "一条已存储的训练课：组数、计算得出的指标，以及任何适用于它的安全标记。",

  /* ── Workout editor ──────────────────────────────────────────── */
  "Log Workout": "记录训练",
  "Record one session. Validation runs before anything is stored, and no existing record is ever overwritten.":
    "记录一场训练课。所有内容在存储前都会先校验，且绝不会覆盖已有记录。",
  "Could not save this workout: {message}": "无法保存此训练记录：{message}",
  "{count} validation issue — please fix before saving.": "{count} 个校验问题，请先修正后再保存。",
  "{count} validation issues — please fix before saving.":
    "{count} 个校验问题，请先修正后再保存。",
  "Form changed since the warning was shown. Submit again to re-validate.":
    "警告显示后表单已变更。请重新提交以再次校验。",
  "This workout was accepted with warnings. Save it anyway?":
    "此训练记录已接受，但带有警告。仍要保存吗？",
  "Save anyway": "仍然保存",
  "Exercise {index}": "动作 {index}",
  "Exercise {index} name": "动作 {index} 名称",
  "Exercise {exercise} set {set}": "动作 {exercise} 第 {set} 组",
  "Exercise {exercise} set {set} weight (kg)": "动作 {exercise} 第 {set} 组重量（kg）",
  "Exercise {exercise} set {set} reps": "动作 {exercise} 第 {set} 组次数",
  "Exercise {exercise} set {set} RPE": "动作 {exercise} 第 {set} 组 RPE",
  "Remove set": "删除该组",
  "Add set": "添加一组",
  "Remove exercise": "删除动作",
  "Add exercise": "添加动作",
  Session: "训练课",
  "Duration (minutes)": "时长（分钟）",
  "Sleep (hours)": "睡眠（小时）",
  "Pain {index} area": "疼痛部位 {index}",
  "Pain {index} level": "疼痛等级 {index}",
  "Remove pain": "删除疼痛记录",
  "Add pain": "添加疼痛记录",
  "Save workout": "保存训练",
};
