/**
 * Chinese display layer — workout session live UI.
 *
 * Keys are the exact English source strings used by the web editor and the
 * React Native Log screen for the shared session capabilities: the timing bar,
 * per-set completion, per-exercise rest, the rest countdown, the plate
 * calculator, and draft restore/autosave banners. Values are Simplified
 * Chinese; an entry that is missing falls back to English, so this table is
 * safe to extend in slices.
 *
 * Sources already translated by another slice (Date, Session type, Notes,
 * Exercises, Save workout, …) are deliberately not repeated here: the merged
 * table stays single-owner.
 */
export const messages: Record<string, string> = {
  /* ── Timing bar ──────────────────────────────────────────────── */
  "Session timer": "训练计时",
  "Start session": "开始训练",
  "Pause session": "暂停训练",
  "Resume session": "继续训练",
  "Finish session": "完成训练",
  Elapsed: "已用时间",
  Paused: "已暂停",
  Finished: "已完成",

  /* ── Per-set completion ──────────────────────────────────────── */
  "Set {set} complete": "第 {set} 组完成",

  /* ── Per-exercise rest configuration ─────────────────────────── */
  "Rest (seconds)": "休息（秒）",

  /* ── Rest countdown ──────────────────────────────────────────── */
  Rest: "休息",
  Resting: "休息中",
  "Rest timer": "休息计时",
  "Rest ends in {seconds} seconds": "休息剩余 {seconds} 秒",
  "Skip rest": "跳过休息",
  "Add 15 seconds": "增加 15 秒",
  "Subtract 15 seconds": "减少 15 秒",
  "Rest complete": "休息结束",

  /* ── Plate calculator ────────────────────────────────────────── */
  "Open plate calculator": "打开杠铃片计算器",
  "Plate calculator": "杠铃片计算器",
  "Target weight (kg)": "目标重量（kg）",
  "Bar weight (kg)": "杠铃重量（kg）",
  "Plates per side": "每侧杠铃片",
  "Loaded weight": "已加载重量",
  Remainder: "余量",
  Close: "关闭",
  "Enter a valid target weight.": "请输入有效的目标重量。",
  "Target weight must be at least the bar weight.": "目标重量不能小于杠铃重量。",

  /* ── Draft restore / autosave / discard banners ──────────────── */
  "Unfinished session restored.": "已恢复未完成的训练。",
  "Session restored and auto-paused. Resume to continue.":
    "训练已恢复并自动暂停。继续即可恢复计时。",
  "Discard draft": "丢弃草稿",
  "Discard the unfinished session draft?": "要丢弃未完成的训练草稿吗？",
  "Could not restore the saved session draft. Discard it to start a new session.":
    "无法恢复已保存的训练草稿。丢弃后可开始新的训练。",
  "Draft autosave failed: {message}": "草稿自动保存失败：{message}",
  "Session draft discarded.": "已丢弃训练草稿。",
};
