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
"Log your first session and it will appear here.": "记录第一场训练后，它会出现在这里。",
  "Your workout history will appear here once local logging is connected. This shell only reserves the route.":
    "记录第一场训练后，它会出现在这里。",
  "{sets} set · {reps} reps · {volume} kg": "{sets} 组 · {reps} 次 · {volume} kg",
  "{sets} sets · {reps} reps · {volume} kg": "{sets} 组 · {reps} 次 · {volume} kg",
  "Workout on {date}: {type}. {summary}": "训练日期 {date}：{type}。{summary}",

  /* ── Log ─────────────────────────────────────────────────────── */
  LOG: "记录",
  "Log a session": "记录一场训练",
  "Capture sets, reps, load, and how the session felt while it is still fresh.":
    "趁记忆还新鲜，记录组数、次数、负重以及这堂课的感受。",
  Date: "日期",
  "Tap to choose the date.": "点按选择日期。",
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
  "Your local history is empty. Log a session first, then come back to turn it into evidence.":
    "你的本地历史还是空的。先记录一场训练，再回来把它变成证据。",
  "Analysis summary": "分析摘要",
  "Active weeks: {count}": "活跃周数：{count}",
  "Time span: {days} days": "时间跨度：{days} 天",
  "Current trend": "当前趋势",

  /* ── Plan ────────────────────────────────────────────────────── */
  PLAN: "计划",
  "Draft plans": "计划草稿",
  "A local draft built from your on-device history. Nothing is applied automatically — explicit confirmation is required before a plan takes effect, and plan application arrives in a later update.":
    "根据本机历史生成的本地草稿。任何内容都不会自动生效——计划生效前必须明确确认，计划应用功能将在后续版本提供。",
  "Loading your draft plan…": "正在加载计划草稿…",
  "Could not load your workout history for the plan: {message}":
    "无法加载用于生成计划的训练历史：{message}",
  "No sessions to draft from": "暂无可生成计划的训练课",
  "Log a session first, then come back to see a draft plan built from your local history.":
    "先记录一场训练，再回来查看根据本地历史生成的计划草稿。",
  "Draft only": "仅为草稿",
  "This plan was generated on your device and is not saved or applied. Nothing changes in your workout log until you explicitly confirm a plan; adoption, saved snapshots, and accounts arrive in a later update.":
    "此计划在你的设备上生成，未保存也未应用。在你明确确认计划之前，训练日志不会有任何改变；采用、已保存快照与账号功能将在后续版本提供。",
  "Draft summary": "草稿摘要",
  "Sessions used: {count}": "使用的训练课：{count}",
  "Confidence: low (short history)": "置信度：低（历史较短）",
  "Confidence: standard": "置信度：标准",
  Recommendations: "建议",
  "Applying this plan comes later: accounts, saved snapshots, and adoption are not part of this local draft.":
    "应用此计划将在后续版本提供：账号、已保存快照与采用均不属于这份本地草稿。",

  /* ── Coach ───────────────────────────────────────────────────── */
  COACH: "教练",
  "Ask about training, review the evidence, and shape the next block with a coach.":
    "向教练询问训练问题、回顾证据，并一起规划下一个训练周期。",
  "Cloud coach requires sign-in": "云端教练需要登录",

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
  "Local-only on this device. Sign in to sync and use the cloud coach.":
    "当前仅在本机使用。登录后可同步并使用云端教练。",
  "Restoring your account…": "正在恢复账号…",
  "Account sign-in is not configured in this build. Your workouts stay on this device.":
    "此版本未配置账号登录。训练记录仍保存在本机。",
  "Signed in": "已登录",

  /* ── Account preferences ─────────────────────────────────────── */
  "Saving preferences to your account…": "正在将偏好保存到你的账号…",
  "Preferences are saved to your account.": "偏好已保存到你的账号。",
  "Preferences could not be saved to your account. Your choices still apply on this device.":
    "偏好无法保存到你的账号。你的选择仍会在此设备上生效。",

  /* ── Auth ────────────────────────────────────────────────────── */
  ACCOUNT: "账号",
  "Sign in to your account.": "登录你的账号。",
  "Accounts are invite-only. Sign in with the email and password from your invitation; there is no sign-up in the app.":
    "账号仅限受邀注册。请使用邀请邮件中的邮箱和密码登录；应用内不提供注册。",
  "Sign-in is not configured in this build. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to enable accounts.":
    "此版本未配置登录。请设置 EXPO_PUBLIC_SUPABASE_URL 与 EXPO_PUBLIC_SUPABASE_ANON_KEY 以启用账号。",
  "Enter a valid email address.": "请输入有效的邮箱地址。",
  "Enter your password.": "请输入密码。",
  "Invalid email or password.": "邮箱或密码不正确。",
  "Confirm your email before signing in.": "请先确认你的邮箱再登录。",
  "The sign-in service is unavailable. Check your connection and try again.":
    "登录服务暂不可用。请检查网络连接后重试。",
  "Too many attempts. Wait a moment and try again.": "尝试次数过多。请稍等片刻后重试。",
  "Your session expired. Sign in again.": "会话已过期。请重新登录。",
  "Sign-in failed. Try again.": "登录失败，请重试。",
  Back: "返回",
  "Go back": "返回",

  /* ── Cloud sync ──────────────────────────────────────────────── */
  SYNC: "同步",
  "Cloud sync": "云端同步",
  "Optional and manual. Nothing is uploaded until you start a sync; your device stays the source of truth.":
    "可选且手动。在你开始同步之前不会上传任何内容；你的设备始终是数据的权威来源。",
  "Sync status": "同步状态",
  Idle: "空闲",
  "Syncing…": "正在同步…",
  Done: "完成",
  Error: "错误",
  "Sync now": "立即同步",
  "This run": "本次同步",
  "Pushed: {count}": "已上传：{count}",
  "Pulled: {count}": "已拉取：{count}",
  "Identical: {count}": "相同：{count}",
  Conflicts: "冲突",
  "Same workout id, different content. Nothing is overwritten and nothing is deleted.":
    "相同的训练 id、不同的内容。系统不会覆盖任何一方，也不会删除任何记录。",
  "Acknowledging a conflict removes it from this result only. Nothing is deleted and nothing is uploaded.":
    "确认冲突只会将其从本次结果中移除。不会删除任何内容，也不会自动上传。",
  "Workout records are immutable, so the same conflict appears again on the next manual sync; keeping the cloud copy does not delete your device copy.":
    "训练记录不可变，因此同一冲突会在下次手动同步时再次出现；保留云端副本不会删除你设备上的副本。",
  "Device copy: {date} · {type}": "设备副本：{date} · {type}",
  "Cloud copy: {date} · {type}": "云端副本：{date} · {type}",
  "Keep cloud": "保留云端",
  "Keep local only": "仅保留本地",
  "Export local": "导出本地",
  "Keep cloud for {id}": "保留 {id} 的云端版本",
  "Keep local only for {id}": "仅保留 {id} 的本地版本",
  "Export local for {id}": "导出 {id} 的本地记录",
  "Export local record": "导出本地记录",
  "Device-only copy of this workout": "此训练的设备本地副本",
  "Could not open the share sheet. The conflict is still listed here.":
    "无法打开分享面板。此冲突仍保留在列表中。",
  "No conflicts. Local and cloud records agree where they overlap.":
    "没有冲突。本地与云端重叠的记录内容一致。",
  "Conflict acknowledged for this run only. Nothing was deleted or uploaded; it will appear again on the next manual sync.":
    "此冲突仅在本次同步中确认。未删除或上传任何内容；它会在下次手动同步时再次出现。",
  "You appear to be offline. Nothing was uploaded; local workouts stay on this device. Try again when you reconnect.":
    "似乎已离线。未上传任何内容；本地训练仍保存在此设备上。重新联网后再试。",
  "Your session is no longer valid. Sign in again to sync.":
    "你的会话已失效。请重新登录后再同步。",
  "The cloud rejected a write because the same id already exists with different content. No cloud record was overwritten.":
    "云端拒绝了写入，因为相同的 id 已存在且内容不同。没有覆盖任何云端记录。",
  "Sync could not finish. Nothing was overwritten; try again when the service is available.":
    "同步未能完成。没有覆盖任何内容；请在服务可用时重试。",
  "Cloud sync is not configured in this build. Set EXPO_PUBLIC_FIT_TRACE_API_URL to the API base URL to enable it.":
    "此版本未配置云端同步。请将 EXPO_PUBLIC_FIT_TRACE_API_URL 设置为 API 基础地址以启用。",
  "Sign in to use cloud sync.": "登录后即可使用云端同步。",
  "Cloud sync is optional and manual. The cloud coach is available while signed in. You can sign out at any time.":
    "云端同步为可选的手动功能。登录后可使用云端教练。你可以随时退出登录。",
  "Manual sync available. Nothing uploads until you start it.":
    "可手动同步。在你开始之前不会上传任何内容。",
  "Cloud sync is not configured in this build. Your workouts stay on this device.":
    "此版本未配置云端同步。训练记录仍保存在此设备上。",
  "Open sync": "打开同步",

  /* ── Health Connect (issue #50) ─────────────────────────────── */
  HEALTH: "健康",
  Health: "健康",
  "Health Connect": "Health Connect",
  "HEALTH CONNECT": "Health Connect",
  SLEEP: "睡眠",
  Sleep: "睡眠",
  "Import from Samsung Health": "导入您的三星健康",
  "Import from Apple Health": "导入您的苹果健康",
  "Import from Mi Fitness": "导入您的小米运动健康",
  "Import from your phone brand is not supported yet": "暂不支持导入您的品牌",
  "Reading Health Connect…": "正在读取 Health Connect…",
  "Imported {count} nights of sleep; latest night: {date} {hours} h":
    "已导入 {count} 晚睡眠，最新一晚：{date} {hours} h",
  "Health Connect has no records for the last 7 nights. Check that your data source (such as Samsung Health) has turned on syncing with Health Connect in its own settings.":
    "Health Connect 中没有最近 7 晚的记录。请确认数据源（如三星健康）已在自身设置中开启与 Health Connect 的同步。",
  "Fit Trace has no Health Connect sleep access. Enable Health Connect above and grant the read permissions.":
    "Fit Trace 还没有 Health Connect 的睡眠读取权限。请在上方启用 Health Connect 并授予读取权限。",
  "Only some Health Connect read permissions were granted. Disable and enable Health Connect above to grant the missing ones.":
    "只授予了部分 Health Connect 读取权限。请在上方先关闭再重新开启 Health Connect，以补齐缺失的权限。",
  "Could not import sleep: {message}": "无法导入睡眠：{message}",
  "Optional and read-only. Reads from Health Connect happen only on this device; imported sleep becomes part of the workout record and syncs with it like a manually entered value.":
    "可选且只读。从 Health Connect 的读取只发生在本机；导入的睡眠会成为训练记录的一部分，与你手动输入的值一样随记录同步。",
  "Read-only scopes: sleep sessions and resting heart rate.": "只读范围：睡眠会话与静息心率。",
  "Off. Enable it to import sleep here; saving a workout for that date attaches it automatically.":
    "已关闭。启用后可在此导入睡眠；保存该日期的训练时会自动挂接。",
  "Connected. Saving a workout attaches that night's sleep automatically when it is recorded here.":
    "已连接。保存训练时会自动挂接这里记录的那一晚睡眠。",
  "Sleep access has been revoked. Go to the system Health Connect settings and re-grant the read permission.":
    "睡眠访问已被撤销，请去系统 Health Connect 重新授权。",
  "Health Connect is not installed. Install it from the Google Play Store, then turn on “Sync with Health Connect” in Samsung Health settings.":
    "尚未安装 Health Connect。请先从 Google Play 商店安装，然后在三星健康设置中打开“与 Health Connect 同步”。",
  "Health Connect needs an update from the Google Play Store before sleep import can be used.":
    "需要先从 Google Play 商店更新 Health Connect，才能使用睡眠导入。",
  "Health Connect is only available on Android devices.": "Health Connect 仅在 Android 设备上可用。",
  "Health Connect is not available on this device.": "此设备上没有可用的 Health Connect。",
  "Partially granted. Some Health Connect read permissions are missing; disable and enable again to grant them.":
    "部分授权。缺少部分 Health Connect 读取权限；请先关闭再重新开启以补齐授权。",
  "Enable Health Connect": "启用 Health Connect",
  "Disable Health Connect": "停用 Health Connect",
  "Sleep import stays off. Grant Fit Trace read access to sleep and resting heart rate, and make sure Samsung Health has “Sync with Health Connect” turned on in its settings.":
    "睡眠导入保持关闭。请授予 Fit Trace 对睡眠与静息心率的读取权限，并确认三星健康设置中已打开“与 Health Connect 同步”。",
  "Off on this device. To revoke access entirely, remove Fit Trace from the Health Connect system settings.":
    "已在此设备上关闭。如需彻底撤销访问，请在系统 Health Connect 设置中移除 Fit Trace。",
  "Health Connect error: {message}": "Health Connect 错误：{message}",

  /* ── Health page: sleep import, manual entry, history ───────── */
  "Wake-up date": "醒来日期",
  "The night between the previous evening 20:00 and this date's 12:00.":
    "指前一晚 20:00 到当天 12:00 之间的那一夜。",
  "Import your recent nights, or type the hours yourself.":
    "一键导入最近 7 晚睡眠，或手动输入时长。",
  "Add sleep manually": "手动补录睡眠",
  "No Health Connect? Record the night here; saving a workout for that date attaches it the same way.":
    "没有 Health Connect？也可以在这里记录；保存该日期的训练时会以同样方式自动挂接。",
  "Save sleep entry": "保存睡眠记录",
  "Saved {hours} h of sleep for {date}.": "已保存 {date} 的 {hours} 小时睡眠。",
  "Enter the sleep hours as a number between 0 and 24.": "请输入 0 到 24 之间的睡眠小时数。",
  "Sleep history": "睡眠历史",
  "No sleep recorded yet. Import a night or add one manually.":
    "还没有睡眠记录。可以导入一晚，或手动补录。",
  Manual: "手动",
  "Recorded {when}": "记录于 {when}",
  Delete: "删除",
  "Sleep entry for {date} deleted.": "已删除 {date} 的睡眠记录。",
  "Could not update the sleep history: {message}": "无法更新睡眠历史：{message}",
  "Could not read the sleep history: {message}": "无法读取睡眠历史：{message}",
  "That night's sleep changed while the import was running; the imported value was discarded to keep your newer entry.":
    "导入期间那一晚的睡眠发生了变化；为保留你更新的记录，已丢弃导入的值。",

  /* ── Health page: Apple Health (issue #51) ──────────────────── */
  "Optional and read-only. Reads from Apple Health happen only on this device; imported sleep becomes part of the workout record and syncs with it like a manually entered value.":
    "可选且只读。从 Apple Health 的读取只发生在本机；导入的睡眠会成为训练记录的一部分，与你手动输入的值一样随记录同步。",
  "No Apple Health data? Record the night here; saving a workout for that date attaches it the same way.":
    "没有 Apple Health 数据？也可以在这里记录；保存该日期的训练时会以同样方式自动挂接。",
  "APPLE HEALTH": "Apple 健康",
  "Apple Health": "Apple 健康",
  "Read-only: sleep analysis and resting heart rate. Apple Health never tells an app whether read access was granted, so an empty import may mean limited access or simply no recorded sleep.":
    "只读：睡眠分析与静息心率。Apple 健康不会告诉 App 是否获得了读取权限，因此导入为空可能意味着权限受限，也可能只是没有记录到睡眠。",
  "Enable Apple Health": "启用 Apple 健康",
  "Disable Apple Health": "停用 Apple 健康",
  "Enabled. Import your recent nights below; saving a workout attaches that night's sleep automatically when it is recorded here.":
    "已启用。可在下方导入最近几晚睡眠；保存训练时会自动挂接这里记录的那一晚。",
  "Permissions requested. Apple Health does not reveal whether read access was granted; if an import comes back empty, check Settings › Health › Data Access & Devices › Fit Trace.":
    "已请求权限。Apple 健康不会透露是否授予了读取权限；如果导入结果为空，请检查“设置 › 健康 › 数据访问与设备 › Fit Trace”。",
  "Apple Health is only available on iOS devices.": "Apple 健康仅在 iOS 设备上可用。",
  "Apple Health is not available on this device.": "此设备上没有可用的 Apple 健康。",
  "The permission sheet was shown. Apple Health does not report read grants, so the import will tell you if there is no data to read.":
    "已显示权限请求面板。Apple 健康不会告知读取授权结果，因此若没有可读取的数据，导入会如实提示。",
  "Apple Health has no sleep recorded for the last 7 nights. If you expect data, check Settings › Health › Data Access & Devices › Fit Trace and make sure your watch has synced.":
    "Apple 健康中没有最近 7 晚的睡眠记录。如果你预期有数据，请检查“设置 › 健康 › 数据访问与设备 › Fit Trace”，并确认手表已完成同步。",
  "Off on this device. To revoke access entirely, remove Fit Trace under Settings › Health › Data Access & Devices.":
    "已在此设备上关闭。如需彻底撤销访问，请在“设置 › 健康 › 数据访问与设备”中移除 Fit Trace。",
  "Apple Health error: {message}": "Apple 健康错误：{message}",
  "Resting heart rate last night: {bpm} bpm. Read from Apple Health, not saved to the workout record.":
    "昨晚静息心率：{bpm} bpm。已从 Apple 健康读取，但尚未保存到训练记录。",
  "Resting heart rate is read for the same night window but not saved to the workout record yet.":
    "静息心率会按同一夜间窗口读取，但尚未保存到训练记录。",
  "Reading Apple Health…": "正在读取 Apple 健康…",

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
