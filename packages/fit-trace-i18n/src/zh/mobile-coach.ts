/**
 * Chinese display layer — mobile Coach screen.
 *
 * Keys are the exact English source strings used by
 * `mobile/src/app/(tabs)/coach.tsx` and `mobile/src/coach/coachScreenModel.ts`;
 * values are Simplified Chinese. Sources already translated by another slice
 * (`COACH`, `Coach`, the lede, `Sign in`, `Cancel`, `Answer`, the reused status
 * and activity labels, …) are deliberately not repeated here so the merged
 * table stays single-owner. The screen always asks through `t()`, and an
 * unknown CoachError code falls back to the canonical `server` source below —
 * a raw server diagnostic is never translated or displayed.
 */
export const messages: Record<string, string> = {
  /* ── gate and disclosure ─────────────────────────────────────── */
  "Cloud coach is not configured": "云端教练尚未配置",
  "Cloud coaching is not configured in this build. Set EXPO_PUBLIC_FIT_TRACE_API_URL to enable it.":
    "此版本未配置云端教练。请设置 EXPO_PUBLIC_FIT_TRACE_API_URL 以启用。",
  "Sign in to start a hosted cloud coaching conversation. Mobile coaching always runs in the cloud; the local CLI coach stays on desktop.":
    "登录后即可开始托管云端教练对话。移动端教练始终在云端运行；本地 CLI 教练仍只在桌面端使用。",
  "The coach runs in the hosted cloud and reads a read-only snapshot of your account.":
    "教练在托管云端运行，并读取你账号的只读快照。",

  /* ── chat surface ────────────────────────────────────────────── */
  "Your question": "你的问题",
  Send: "发送",
  "New conversation": "新对话",
  "No workouts to analyse yet. Log a workout first, then ask the coach.":
    "暂无可分析的训练记录。请先记录一场训练，再向教练提问。",
  "The coaching stream ended before the run finished. Cancel the run to resolve it.":
    "教练流在运行结束前中断。请取消该运行以确认结果。",
  "The coaching run reported an error. Start a new conversation to try again.":
    "教练运行报告了一个错误。请开始新对话后重试。",

  /* ── prompt validation ───────────────────────────────────────── */
  "Enter a question for the coach.": "请先输入要问教练的问题。",
  "Your question is too long. Shorten it and try again.":
    "你的问题过长。请缩短后重试。",

  /* ── run status and activity ─────────────────────────────────── */
  "Ready for your question.": "可以开始提问了。",
  "Preparing the cloud coach…": "正在准备云端教练…",
  "Coach is responding…": "教练正在回答…",
  "Cancelling the coach run…": "正在取消教练运行…",
  "Coach run completed.": "教练运行已完成。",
  "Coach run failed.": "教练运行失败。",
  "Tool {tool} failed.": "工具 {tool} 失败。",
  "Analysis ready.": "分析已就绪。",
  "The coaching run reported an error.": "教练运行报告了一个错误。",

  /* ── CoachError codes (canonical source copy) ────────────────── */
  "Sign in to use the cloud coach.": "请登录后使用云端教练。",
  "This account cannot use cloud coaching. Sign in with a formal account.":
    "此账号无法使用云端教练。请使用正式账号登录。",
  "Cloud coaching quota is exhausted or not configured. Try again later.":
    "云端教练额度已用尽或尚未配置。请稍后再试。",
  "Cloud coaching is temporarily disabled.": "云端教练已暂时停用。",
  "A coaching run is already active. Wait for it to finish or cancel it.":
    "已有一个教练运行在进行中。请等待其结束或取消它。",
  "This coaching request conflicts with an earlier attempt.":
    "此教练请求与先前的尝试冲突。",
  "The coaching run or session is no longer available.": "该教练运行或会话已不可用。",
  "The coaching event cursor expired. Reload the run from the beginning.":
    "教练事件游标已过期。请从头重新加载该运行。",
  "The coaching request was rejected. Review it and try again.":
    "教练请求被拒绝。请检查后重试。",
  "Too many coaching requests. Wait a moment and try again.":
    "教练请求过于频繁。请稍等片刻后重试。",
  "Cloud coaching is temporarily unavailable. Try again later.":
    "云端教练暂时不可用。请稍后再试。",
  "The cloud coaching service could not be reached. Check your connection and try again.":
    "无法连接云端教练服务。请检查网络连接后重试。",
  "The coaching stream ended before the run finished. Reconnect to resume.":
    "教练流在运行结束前中断。请重新连接以继续。",
  "The coaching service sent an unreadable response.": "教练服务返回了无法读取的响应。",
  "The coaching request was cancelled.": "教练请求已取消。",
  "The cloud coaching service failed. Try again later.": "云端教练服务出错。请稍后再试。",
};
