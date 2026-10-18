/**
 * Chinese display layer — deterministic domain copy.
 *
 * Every helper rebuilds Chinese from a stable code plus evidence. Stored
 * payloads stay English; unknown codes, missing values and user-authored notes
 * fall back to the original string in `domain.ts`.
 */

interface FlagMessages {
  painReported: (sessions: number) => string;
  extremeRpe: (setCount: number, maxRpe: number) => string;
  volumeSpike: (changePct: number) => string;
  volumeDrop: (changePct: number) => string;
  missingRecoveryData: string;
  insufficientHistory: (sessions: number, minimum: number) => string;
}

interface RecommendationCopy {
  importHistoryDetail: string;
  importHistoryReason: string;
  reduceOrPauseDetail: string;
  reduceOrPauseReason: string;
  capIntensityDetail: (capRpe: number) => string;
  capIntensityReason: (maxRpe: number) => string;
  holdVolumeDetail: string;
  holdVolumeReason: (changePct: number) => string;
  rebuildVolumeDetail: string;
  rebuildVolumeReason: (changePct: number) => string;
  progressiveOverloadDetail: (exercise: string) => string;
  progressiveOverloadReason: (exercise: string, deltaPct: number, avgRpe: string) => string;
  maintainDetail: string;
  maintainNoTrends: string;
  maintainReason: (avgRpe: string) => string;
  scheduleDetail: (days: number) => string;
  scheduleReason: string;
  equipmentDetail: (equipment: string) => string;
  equipmentReason: string;
  notRecorded: string;
}

interface ValidationRule {
  pattern: RegExp;
  zh: (match: RegExpExecArray) => string;
}

interface DomainZh {
  sessionTypes: Record<string, string>;
  severities: Record<string, string>;
  trendDirections: Record<string, string>;
  flags: FlagMessages;
  actions: Record<string, string>;
  recommendationCopy: RecommendationCopy;
  safetyNotes: Record<string, string>;
  safetyLowConfidence: (sessions: number) => string;
  safetyUserConstraint: (constraint: string) => string;
  carePrompts: Record<string, string>;
  validationMessages: Record<string, string>;
  validationPatterns: ValidationRule[];
}

export const domainZh: DomainZh = {
  sessionTypes: {
    strength: "力量",
    cardio: "有氧",
    mobility: "灵活性",
    other: "其他",
  },
  severities: {
    critical: "严重",
    warning: "警告",
    info: "提示",
  },
  trendDirections: {
    up: "上升",
    down: "下降",
    flat: "持平",
  },
  flags: {
    painReported: (sessions) => `已记录疼痛：${sessions} 次训练中出现疼痛。`,
    extremeRpe: (setCount, maxRpe) => `${setCount} 组达到 RPE ${maxRpe} 或更高。`,
    volumeSpike: (changePct) => `最近一次训练容量比近期平均值高 ${changePct}%。`,
    volumeDrop: (changePct) => `最近一次训练容量比近期平均值低 ${changePct}%。`,
    missingRecoveryData: "本周期未记录恢复数据（sleep_hours）。",
    insufficientHistory: (sessions, minimum) =>
      `仅有 ${sessions} 次训练；少于 ${minimum} 次会降低趋势可信度。`,
  },
  actions: {
    import_history: "导入历史",
    reduce_or_pause_loading: "降低或暂停负荷",
    cap_intensity: "限制强度",
    hold_volume: "保持容量",
    rebuild_volume: "重建容量",
    progressive_overload: "渐进超负荷",
    maintain: "维持",
    schedule: "安排日程",
    equipment: "器材",
  },
  recommendationCopy: {
    importHistoryDetail: "在生成计划前至少导入一条训练记录。",
    importHistoryReason: "没有可用的训练历史，无法生成有证据支撑的计划。",
    reduceOrPauseDetail: "下一次训练不要加重负荷；强度保持不高于最近一次训练，或安排休息。",
    reduceOrPauseReason: "记录到疼痛报告，其优先级高于任何进阶逻辑。",
    capIntensityDetail: (capRpe) => `下一次训练的工作组 RPE 控制在 ${capRpe} 或以下。`,
    capIntensityReason: (maxRpe) => `记录到的最高 RPE 为 ${maxRpe}，属于极限用力。`,
    holdVolumeDetail: "重复上一次训练的容量，不要继续加量；恢复良好后再进阶。",
    holdVolumeReason: (changePct) => `最近容量比近期平均值高 ${changePct}%。`,
    rebuildVolumeDetail: "逐步重建容量（每次约补回缺口的 10-20%），不要一次性跳回。",
    rebuildVolumeReason: (changePct) => `最近容量比近期平均值低 ${changePct}%。`,
    progressiveOverloadDetail: (exercise) =>
      `对 ${exercise} 小幅加重（约 2.5% 负荷或每组多 1 次）。`,
    progressiveOverloadReason: (exercise, deltaPct, avgRpe) =>
      `据估计，${exercise} 的 1RM 上升 ${deltaPct}%，平均 RPE 为 ${avgRpe}。`,
    maintainDetail: "重复近期训练结构，只有在动作可控时才进阶。",
    maintainNoTrends: "没有动作拥有足够的负重历史来建立趋势。",
    maintainReason: (avgRpe) => `没有任何动作呈现上升趋势（平均 RPE ${avgRpe}）。`,
    scheduleDetail: (days) => `把计划安排进 ${days} 个可用训练日。`,
    scheduleReason: "调用方提供了每周可用时间约束。",
    equipmentDetail: (equipment) => `将动作限制为：${equipment}。`,
    equipmentReason: "调用方提供了器材约束。",
    notRecorded: "未记录",
  },
  safetyNotes: {
    "Pain was reported. Avoid loading the affected area and prioritize recovery.":
      "已记录疼痛。避免对受影响部位施加负荷，优先恢复。",
    "At least one set reached RPE 9 or higher.": "至少有一组达到 RPE 9 或更高。",
    "Training volume rose sharply versus the recent average.":
      "训练容量相较近期平均值大幅上升。",
    "No recovery data was recorded; recommendations assume adequate sleep and recovery.":
      "未记录恢复数据；建议假定睡眠与恢复充足。",
  },
  safetyLowConfidence: (sessions) => `仅有 ${sessions} 次训练可用；请将此计划视为低置信度。`,
  safetyUserConstraint: (constraint) => `用户约束：${constraint}`,
  carePrompts: {
    "If pain persists, worsens, or is sharp, seek evaluation from a qualified medical professional before continuing.":
      "如果疼痛持续、加重或呈锐痛，请在继续训练前寻求专业医疗评估。",
  },
  validationMessages: {
    "Expected an object": "应为对象",
    "`id` must be a non-empty string": "`id` 必须是非空字符串",
    "`schema_version` must be a positive integer": "`schema_version` 必须是正整数",
    "`date` must be a valid ISO 8601 date (YYYY-MM-DD) or datetime":
      "`date` 必须是有效的 ISO 8601 日期（YYYY-MM-DD）或日期时间",
    "`session_type` must be one of: strength, cardio, mobility, other":
      "`session_type` 必须是以下之一：strength、cardio、mobility、other",
    "`duration_minutes` must be a positive number": "`duration_minutes` 必须是正数",
    "`sleep_hours` must be between 0 and 24": "`sleep_hours` 必须在 0 到 24 之间",
    "`notes` must be a string": "`notes` 必须是字符串",
    "`exercises` must be a non-empty array": "`exercises` 必须是非空数组",
    "Each exercise must be an object": "每个动作必须是对象",
    "Each exercise needs a non-empty `name`": "每个动作都需要非空 `name`",
    "Each exercise needs a non-empty `sets` array": "每个动作都需要非空 `sets` 数组",
    "Each set must be an object": "每组必须是对象",
    "`reps` must be a non-negative integer": "`reps` 必须是非负整数",
    "Set has 0 reps": "该组次数为 0",
    "`weight` must be a non-negative number in kg": "`weight` 必须是非负数值（kg）",
    "Set has reps but 0 kg weight": "该组有次数但重量为 0 kg",
    "`rpe` must be between 1 and 10": "`rpe` 必须在 1 到 10 之间",
    "`pain` must be an array": "`pain` 必须是数组",
    "Each pain entry must be an object": "每条疼痛记录必须是对象",
    "`pain.area` must be a string": "`pain.area` 必须是字符串",
    "`pain.level` must be between 0 and 10": "`pain.level` 必须在 0 到 10 之间",
    "is not valid JSON": "不是有效的 JSON",
    "must be a JSON object": "必须是 JSON 对象",
    "must be an array": "必须是数组",
    "is missing": "缺失",
    "must be the integer 1": "必须是整数 1",
    "Workout record must be a JSON object.": "训练记录必须是 JSON 对象。",
  },
  validationPatterns: [
    {
      pattern: /^`schema_version` is missing; assuming (\d+)$/,
      zh: (match) => `\`schema_version\` 缺失；按 ${match[1]} 处理`,
    },
    {
      pattern: /^`schema_version` (\d+) is newer than supported (\d+)$/,
      zh: (match) => `\`schema_version\` ${match[1]} 高于当前支持的版本 ${match[2]}`,
    },
    {
      pattern: /^`duration_minutes` exceeds the (\d+)-minute maximum$/,
      zh: (match) => `\`duration_minutes\` 超过 ${match[1]} 分钟上限`,
    },
    {
      pattern: /^`duration_minutes` (\S+) is unusually long$/,
      zh: (match) => `\`duration_minutes\` ${match[1]} 异常偏长`,
    },
    {
      pattern: /^`sleep_hours` (\S+) is outside the plausible range (\S+)-(\S+)$/,
      zh: (match) => `\`sleep_hours\` ${match[1]} 超出合理范围 ${match[2]}-${match[3]}`,
    },
    {
      pattern: /^Only (\d+) session\(s\) are available; treat this plan as low-confidence\.$/,
      zh: (match) => `仅有 ${match[1]} 次训练可用；请将此计划视为低置信度。`,
    },
    {
      pattern: /^Unknown field `(.+)` will be ignored$/,
      zh: (match) => `未知字段 \`${match[1]}\` 将被忽略`,
    },
    {
      pattern: /^version (\d+) is not supported; this app supports version (\d+)$/,
      zh: (match) => `版本 ${match[1]} 不受支持；本应用支持版本 ${match[2]}`,
    },
    {
      pattern: /^must contain at most (\d+) workout records$/,
      zh: (match) => `最多只能包含 ${match[1]} 条训练记录`,
    },
    {
      pattern: /^must be at most (\d+) UTF-8 bytes$/,
      zh: (match) => `最多为 ${match[1]} 个 UTF-8 字节`,
    },
    {
      pattern: /^exceeds the (\d+) byte file limit$/,
      zh: (match) => `超过 ${match[1]} 字节的文件上限`,
    },
    {
      pattern: /^exceeds the (\d+) byte single-record request limit$/,
      zh: (match) => `超过 ${match[1]} 字节的单条记录请求上限`,
    },
    {
      pattern: /^the (\w+) file is empty$/,
      zh: (match) => `${match[1]} 文件为空`,
    },
    {
      pattern: /^is (.*) but this file was selected as (\w+)$/,
      zh: (match) => `内容为 ${match[1]}，但此文件按 ${match[2]} 选择`,
    },
    {
      pattern: /^must be the integer (\d+)$/,
      zh: (match) => `必须是整数 ${match[1]}`,
    },
    {
      pattern: /^A record with id "(.*)" already exists with different content\.$/,
      zh: (match) => `id 为“${match[1]}”的记录已存在且内容不同。`,
    },
  ],
};

/**
 * Source-string entries for t()-driven UI templates in this domain. Kept empty
 * because domain copy is rebuilt by the helpers above; dynamic values make the
 * English sentence unstable as a lookup key.
 */
export const messages: Record<string, string> = {};
