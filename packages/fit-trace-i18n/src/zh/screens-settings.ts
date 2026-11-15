/**
 * Chinese display layer — coaching backend settings, cloud destination and
 * workout-sync settings.
 *
 * Keys are the exact English source strings; values are Simplified Chinese.
 * An entry that is missing falls back to English, so this table is safe to
 * extend in slices. Server- and daemon-provided error text stays as produced;
 * only interface copy is listed here.
 */
export const messages: Record<string, string> = {
  /* ── cloud destination (CloudDestinationSettings) ───────────── */
  "The cloud server could not be used.": "无法使用该云服务器。",
  "Cloud server updated. New runs will use {host}.": "云服务器已更新。新的运行将使用 {host}。",
  "Server confirmed for this account.": "已为此账号确认服务器。",
  "Reset to the official cloud server.": "已重置为官方云服务器。",
  "The custom cloud server setting was removed.": "自定义云服务器设置已移除。",
  "Cloud server": "云服务器",
  "Select which hosted Fit Trace server the cloud coach talks to. This does not change where workout sync uploads; a server only sees records hosted there.":
    "选择云端教练连接的托管 Fit Trace 服务器。这不会改变训练同步的上传位置；服务器只能看到托管在它上面的记录。",
  "Checking the cloud server setting…": "正在检查云服务器设置…",
  "Official cloud server in use: {host}.": "正在使用官方云服务器：{host}。",
  "Custom cloud server in use: {host}.": "正在使用自定义云服务器：{host}。",
  "This account has not confirmed {host}. Cloud prompts and synced workout records will be sent there after you confirm.":
    "此账号尚未确认 {host}。确认后，云端提示与已同步的训练记录将发送到该服务器。",
  "Confirm {host}": "确认 {host}",
  "This server is confirmed for this account.": "此服务器已为此账号确认。",
  "No cloud server is configured. Enter the API base of a hosted Fit Trace deployment to use cloud coaching.":
    "未配置云服务器。请输入托管 Fit Trace 部署的 API 基础地址以使用云端教练。",
  "The stored cloud server setting is invalid.": "已存储的云服务器设置无效。",
  "Reset to the official cloud server": "重置为官方云服务器",
  "Reset the stored cloud server setting": "重置已存储的云服务器设置",
  "Use a different server": "使用其他服务器",
  "Reset to the official server": "重置为官方服务器",
  "Remove the custom server": "移除自定义服务器",
  "Server API base": "服务器 API 基础地址",
  "HTTPS only, ending in /api/v1. The server must use the same account service as this app.":
    "仅支持 HTTPS，且以 /api/v1 结尾。服务器必须使用与本应用相同的账号服务。",
  "Check server": "检查服务器",
  "Cloud prompts and workout records synced to your account will be sent to {host}. This is a separate consent from workout sync.":
    "云端提示与已同步到账号的训练记录将发送到 {host}。这与训练同步是两个独立的授权。",
  "This is the official server from this build.": "这是此构建中的官方服务器。",
  "This server uses the same account service as this app.": "此服务器使用与本应用相同的账号服务。",
  "Confirm and use this server": "确认并使用此服务器",

  /* ── workout sync (WorkoutSyncSettings) ─────────────────────── */
  "Workout sync": "训练同步",
  "Sign in to sync this account's workouts.": "登录后即可同步此账号的训练。",
  "Sync could not be confirmed.": "无法确认同步。",
  "Sync is manual. It shares this account's workout history with the selected service. Guest workouts stay on this device unless you explicitly import them.":
    "同步为手动操作。它会将此账号的训练历史共享给所选服务。除非你明确导入，访客训练会保留在本机。",
  "MCP and pi do not automatically follow your desktop account. By default they continue using the guest store; already running processes keep the store they opened. Explicit store or principal settings select a separate store.":
    "MCP 与 pi 不会自动跟随你的桌面账号。默认情况下它们继续使用访客存储；已在运行的进程会保留其打开时的存储。显式指定存储或主体设置会选择独立的存储。",
  "Connect sync": "连接同步",
  "Destination": "目标位置",
  "Preview guest import": "预览访客导入",
  "To copy": "待复制",
  "already present": "已存在",
  "conflicts kept unchanged": "冲突保持未变",
  "Import keeps the guest originals and allows this account's workouts to be uploaded to the destination below when you manually sync.":
    "导入会保留访客原始记录，并允许你在手动同步时将此账号的训练上传到下方目标位置。",
  "Guest import finished. Copied {copied}; conflicts {conflicts}.":
    "访客导入完成。已复制 {copied} 条；冲突 {conflicts} 条。",
  "Import guest workouts and allow sync": "导入访客训练并允许同步",
  "Sync is enabled for this account and destination.": "此账号与目标位置的同步已启用。",
  "Sync is not enabled.": "同步未启用。",
  "Pending workouts": "待处理训练",
  "Sync finished. Pulled {pulled}, uploaded {pushed}, conflicts {conflicts}.":
    "同步完成。拉取 {pulled} 条，上传 {pushed} 条，冲突 {conflicts} 条。",
  "Sync did not finish. An upload may already have reached the service; retry to reconcile.":
    "同步未完成。上传可能已经到达服务端；请重试以核对。",
  "Stop syncing": "停止同步",
  "Allow sync for this account": "允许此账号同步",
};
