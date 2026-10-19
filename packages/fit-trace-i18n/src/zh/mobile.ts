/**
 * Chinese display layer — React Native shell.
 *
 * Keys are the exact English source strings used by `mobile/src`; values are
 * Simplified Chinese. An entry that is missing falls back to English, so this
 * table is safe to extend in slices.
 *
 * Sources already translated by another slice (History, Analysis, Plan, Coach,
 * Me, Sign in, Appearance, Language, the language/export notes, …) are
 * deliberately not repeated here: the merged table stays single-owner.
 */
export const messages: Record<string, string> = {
  /* ── navigation ──────────────────────────────────────────────── */
  Log: "记录",
  "{label} tab": "{label}标签",

  /* ── History ─────────────────────────────────────────────────── */
  HISTORY: "历史",
  "Training history": "训练历史",
  "Every logged session becomes evidence. Review what you lifted, how it felt, and what changed over time.":
    "每一次记录的训练都会成为证据。回顾你举起的重量、训练感受，以及随时间发生的变化。",
  "No sessions yet": "还没有训练课",
  "Your workout history will appear here once local logging is connected. This shell only reserves the route.":
    "本地记录接通后，你的训练历史会显示在这里。此界面目前仅占位该路由。",
  "{sets} set · {reps} reps · {volume} kg": "{sets} 组 · {reps} 次 · {volume} kg",
  "{sets} sets · {reps} reps · {volume} kg": "{sets} 组 · {reps} 次 · {volume} kg",
  "Workout on {date}: {type}. {summary}": "训练日期 {date}：{type}。{summary}",

  /* ── Log ─────────────────────────────────────────────────────── */
  LOG: "记录",
  "Log a session": "记录一场训练",
  "Capture sets, reps, load, and how the session felt while it is still fresh.":
    "趁记忆还新鲜，记录组数、次数、负重以及这堂课的感受。",
  Date: "日期",
  "Date format: YYYY-MM-DD": "日期格式：YYYY-MM-DD",
  Exercises: "动作",
  "Set {set}": "第 {set} 组",
  Reps: "次数",
  "Weight (kg)": "重量（kg）",
  Optional: "可选",
  RPE: "RPE",
  "1–10, optional": "1–10，可选",
  "Notes (optional)": "备注（可选）",
  "Pain (optional)": "疼痛（可选）",
  "Pain area": "疼痛部位",
  "Pain level (0–10)": "疼痛程度（0–10）",
  Saved: "已保存",
  "Workout saved. It will appear in History.": "训练已保存，切换到历史页面即可看到。",
  "This workout was already saved; no duplicate was written.":
    "这场训练之前已经保存过，没有重复写入。",
  "Opening the local store…": "正在打开本地存储…",
  "The local store could not be opened: {message}": "无法打开本地存储：{message}",
  "The local store is not ready yet. Try again in a moment.": "本地存储尚未就绪，请稍后再试。",

  /* ── Analysis ────────────────────────────────────────────────── */
  ANALYSIS: "分析",
  "Evidence analysis": "证据分析",
  "Turn logged sessions into trends, stalls, and the evidence behind the next step.":
    "把已记录的训练转化为趋势、停滞信号，以及支撑下一步决策的证据。",
  "No evidence to analyse": "暂无可分析的证据",
  "Analysis runs on your local history. Log a few sessions first, then come back once the store is connected.":
    "分析基于你的本地历史。请先记录几场训练，待存储接通后再回来查看。",

  /* ── Plan ────────────────────────────────────────────────────── */
  PLAN: "计划",
  "Draft plans": "计划草稿",
  "Plans are drafted from your evidence and need explicit confirmation before they take effect.":
    "计划根据你的证据生成草稿，必须经过明确确认才会生效。",
  "No plan in progress": "暂无进行中的计划",
  "Once there is enough history, a drafted plan will appear here for review. Nothing is applied automatically.":
    "当历史足够充分时，计划草稿会显示在这里供你审阅。任何内容都不会被自动采用。",

  /* ── Coach ───────────────────────────────────────────────────── */
  COACH: "教练",
  "Ask about training, review the evidence, and shape the next block with a coach.":
    "向教练询问训练问题、回顾证据，并一起规划下一个训练周期。",
  "Cloud coach requires sign-in": "云端教练需要登录",
  "Hosted coaching is a signed-in feature. Accounts and networking arrive in a later commit, so this screen makes no network calls.":
    "托管教练是登录后可用的功能。账号与网络连接将在后续版本提供，因此此页面不会发起任何网络请求。",
  "Cloud coach is next": "云端教练即将上线",
  "This screen will start a hosted cloud pi session once accounts and networking land. The local CLI coach stays on desktop; mobile never runs a local agent.":
    "账号与网络接通后，此界面将启动托管的云端 pi 会话。本地 CLI 教练仍只在桌面端运行，移动端不会启动本地代理。",

  /* ── Me ──────────────────────────────────────────────────────── */
  ME: "我的",
  "Your profile, appearance, and language preferences.":
    "你的个人资料、外观与语言偏好。",
  PROFILE: "个人资料",
  "Guest lifter": "访客训练者",
  "Sign in to sync sessions and unlock the cloud coach.":
    "登录以同步训练课并解锁云端教练。",
  "Choose the visual shell for this device.": "选择此设备使用的视觉外壳。",
  "Use Pixel skin": "使用 Pixel 外观",
  "Use Glass skin": "使用 Glass 外观",
  "English language": "英语",
  "Chinese language": "中文",
  "Sign-in and cloud sync are placeholders in this commit.":
    "登录与云端同步在本版本中仍为占位功能。",

  /* ── Auth ────────────────────────────────────────────────────── */
  ACCOUNT: "账号",
  "A secure session will unlock sync and the cloud coach.":
    "安全会话将解锁同步与云端教练。",
  "Auth placeholder": "登录占位",
  "No credentials are collected and no network calls are made in this commit. The secure sign-in flow lands next.":
    "本版本不收集任何凭据，也不发起网络请求。安全登录流程将在下一步实现。",
  Back: "返回",
  "Go back": "返回",

  /*
   * Proper names. The identity values are intentional: language endonyms are
   * shown in their own language (the same as the web switcher), and the skin
   * names stay Latin so the Appearance copy reads consistently.
   */
  English: "English",
  "简体中文": "简体中文",
  Pixel: "Pixel",
  Glass: "Glass",
};
