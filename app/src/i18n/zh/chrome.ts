/**
 * Chinese display layer — interface chrome.
 *
 * Keys are the exact English source strings; values are Simplified Chinese.
 * Missing entries fall back to English. Canonical workout content is never
 * listed here.
 */
export const messages: Record<string, string> = {
  /* ── Me → Language ───────────────────────────────────────────── */
  Language: "语言",
  "Interface language": "界面语言",
  On: "已启用",
  "Choose the interface language. Workout records, saved snapshots and exported JSON keep their original English; only the interface is translated.":
    "选择界面语言。训练记录、已保存快照与导出的 JSON 保留英文原文，仅界面文案被翻译。",
  "Source language. Data and exports stay in English.": "源语言。训练数据与导出保持英文。",
  "Display layer only: interface copy in Chinese; records and exports stay canonical English.":
    "仅显示层：界面文案为中文；记录与导出保留英文原文。",
};
