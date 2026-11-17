/**
 * Chinese display layer — exercise library.
 *
 * Keys are the exact English source strings; values are Simplified Chinese.
 * Exercise names themselves are catalog data and are translated through
 * `displayExerciseName` / `displayStoredExerciseName`, never through this
 * table. An entry that is missing falls back to English.
 */

export const messages: Record<string, string> = {
  /* ── Navigation and page ─────────────────────────────────────── */
  "Exercise Library": "动作库",
  "Browse the exercise catalog and add an exercise to the current workout.":
    "浏览动作库，把动作加入当前训练。",

  /* ── Search and filters ──────────────────────────────────────── */
  "Search exercises": "搜索动作",
  "Search by name or alias": "按名称或别名搜索",
  "Movement pattern": "动作模式",
  "All patterns": "全部模式",
  Muscle: "肌群",
  "All muscles": "全部肌群",
  Equipment: "器械",
  "All equipment": "全部器械",
  Difficulty: "难度",
  "All difficulties": "全部难度",
  "{count} exercise": "{count} 个动作",
  "{count} exercises": "{count} 个动作",
  "No exercises match these filters.": "没有符合筛选条件的动作。",
  "Clear filters": "清除筛选",

  /* ── Detail ─────────────────────────────────────────────────── */
  "Exercise details": "动作详情",
  "Select an exercise to see its details.": "选择一个动作查看详情。",
  "Back to results": "返回列表",
  "Primary muscles": "主要肌群",
  "Secondary muscles": "协同肌群",
  "Mechanics": "动作性质",
  "Force": "用力方向",
  "Not classified": "未分类",
  "None listed": "未列出",
  "Add to workout": "加入训练",

  /* ── Review and scope notes ─────────────────────────────────── */
  "Catalog data is a reference. Movement descriptions and muscle/equipment mappings are still under review; this page gives no technique or suitability guidance.":
    "动作库数据仅供参考。动作说明、肌群与器械映射仍在审校中；本页不提供技术要领或适用性建议。",
  "Muscle filters match primary and secondary muscles.":
    "肌群筛选同时匹配主要肌群和协同肌群。",
  "Equipment is the resistance category; accessories such as a bench are not listed.":
    "器械指阻力类别，卧推凳等辅助器材不在其中。",
  "Difficulty is the catalog's classification, not a personal suitability rating.":
    "难度是动作库的分类，不代表是否适合个人。",

  /* ── Editor entry and draft errors ──────────────────────────── */
  "Browse library": "打开动作库",
  "Could not read the stored workout draft. Open Log Workout to review it.":
    "无法读取已保存的训练草稿，请到「记录训练」查看。",
  "Could not add this exercise to the workout draft. Nothing was changed.":
    "无法把该动作加入训练草稿，草稿未改动。",
};
