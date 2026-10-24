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

  /* ── navigation ──────────────────────────────────────────────── */
  History: "历史",
  "Log Workout": "记录训练",
  Analysis: "分析",
  Plan: "计划",
  Me: "我的",
  Coach: "教练",

  /* ── shell ───────────────────────────────────────────────────── */
  Workspace: "工作区",
  Primary: "主导航",
  "Agent · training log": "智能体 · 训练日志",
  Cloud: "云端",
  Local: "本地",
  "Cloud mode · account data": "云端模式 · 账号数据",
  "Local mode · browser storage": "本地模式 · 浏览器存储",
  "Local mode · daemon data": "本地模式 · 守护进程数据",
  "Records, snapshots and coaching runs belong to the signed-in account.":
    "训练记录、快照与教练运行都归属于登录账号。",
  "Records and snapshots stay on this machine through the local daemon; export them from Me.":
    "训练记录与快照通过本地守护进程保存在本机；可在「我的」中导出。",
  "Records and snapshots stay in this browser; export them from Me.":
    "训练记录与快照保存在此浏览器；可在「我的」中导出。",
  "Account": "账号",
  "Account details": "账号详情",
  "Sign out": "退出登录",
  "Development bypass: no account login. Data uses the fixed dev-loopback-bypass namespace in this browser and is not isolated by identity.":
    "开发绕过：未登录账号。数据使用固定的 dev-loopback-bypass 命名空间存储在此浏览器中，不按身份隔离。",
  "Authentication is temporarily unavailable. You stay signed in.":
    "认证服务暂时不可用。你仍保持登录状态。",
  "Retrying…": "重试中…",
  "Retry": "重试",

  /* ── app gates ──────────────────────────────────────────────── */
  "Sign-in is unavailable": "登录暂不可用",
  Loading: "加载中",
  "Loading…": "加载中…",
  "Login is unavailable": "登录不可用",
  "Login is unavailable: the server did not provide its public configuration.":
    "登录不可用：服务器未提供公共配置。",
  "The server did not provide its public configuration.": "服务器未提供公共配置。",
  "Authentication is not configured.": "认证尚未配置。",
  "Configuration error": "配置错误",

  /* ── guest account ──────────────────────────────────────────── */
  "Guest account": "访客账号",
  "Guest": "访客",
  "Confirm guest sign out": "确认退出访客会话",
  "Signing out removes this browser’s guest session. These guest workouts may be lost and cannot be guaranteed recoverable from another tab.":
    "退出会移除本浏览器的访客会话。这些访客训练可能丢失，且无法保证能从其他标签页恢复。",
  "Sign out and lose guest access": "退出并失去访客访问",
  "Cancel": "取消",
  "Sign out guest": "退出访客会话",
  "· Your workouts are not linked to an account.": "· 你的训练未关联任何账号。",
  "Guest data is tied to this browser. Signing out or clearing site data may lose it; signing in to a different account does not transfer it.":
    "访客数据与此浏览器绑定。退出或清除站点数据可能导致数据丢失；登录其他账号不会迁移这些数据。",
  "Verification link sent to": "验证链接已发送至",
  ". Open it in this tab, or open it elsewhere and check verification here. The upgrade is not complete until the verified user is re-fetched for the same guest.":
    "。请在此标签页打开，或在其他位置打开后回到此处检查验证状态。只有重新获取到同一访客的已验证用户后，升级才算完成。",
  "Checking…": "检查中…",
  "Check verification": "检查验证状态",
  "Resending…": "重新发送中…",
  "Resend verification link": "重新发送验证链接",
  "Email verified for {email}.": "该邮箱已验证：{email}。",
  "Set a password": "设置密码",
  " to finish the account upgrade.": "，以完成账号升级。",
  "Upgrade to an account": "升级为账号",
  "Invited emails only. This keeps the same guest identity and attaches its existing workouts to the verified account — it does not merge a different account.":
    "仅限受邀邮箱。升级会保留同一访客身份，并将现有训练关联到已验证账号 —— 不会合并其他账号。",
  "Invited email": "受邀邮箱",
  "Send verification link": "发送验证链接",
  "Sending link…": "正在发送链接…",
  "Sign in to an existing account": "登录现有账号",
  "This session changed. Reopen the tab that started the upgrade.":
    "此会话已变化。请重新打开发起升级的标签页。",
  "Not verified yet. Open the link from the email, then check again.":
    "尚未验证。请先打开邮件中的链接，然后再次检查。",
  "The email is not confirmed yet. Check again after opening the link.":
    "邮箱尚未确认。打开链接后再检查一次。",
  "Verification link sent again to {email}.": "已再次向 {email} 发送验证链接。",
  "Could not start the account upgrade.": "无法开始账号升级。",
  "Could not resend the verification link.": "无法重新发送验证链接。",
  "Could not check the verification link.": "无法检查验证链接。",
  "· Local guest on this machine's daemon.": "· 本机守护进程上的本地访客。",
  "Your workouts are stored by the local daemon on this machine under this guest identity. No account sign-in is configured for this daemon, so there is nothing to sign out of and no account to upgrade to.":
    "你的训练由本机的守护进程以此访客身份存储。此守护进程未配置账号登录，因此没有可退出的会话，也没有可升级的账号。",

  /* ── auth: sign in ──────────────────────────────────────────── */
  "Sign in": "登录",
  "Sign-in failed.": "登录失败。",
  "Guest sign-in failed.": "访客登录失败。",
  "Accounts are invite-only. If you were invited, sign in with your email and password below; there is no public registration. Workout tracking is available as a guest when the deployment enables guest access.":
    "账号仅限邀请。若你已受邀，请在下方用邮箱和密码登录；本产品不开放注册。部署开启访客访问时，可以访客身份记录训练。",
  "Signing in to an account replaces this browser session. Guest workouts are not merged or transferred.":
    "登录账号会替换此浏览器会话。访客训练不会合并或转移。",
  "Email": "邮箱",
  "Password": "密码",
  "Signing in…": "登录中…",
  "Forgot your password?": "忘记密码？",
  "Guest access": "访客访问",
  "Guest data is tied to this browser and cannot be merged into an account later.":
    "访客数据与此浏览器绑定，之后无法合并进账号。",
  "Guest sign-in requires CAPTCHA on this deployment. This app does not yet include a CAPTCHA widget, so guest entry is disabled rather than sending a request that cannot pass.":
    "此部署的访客登录需要 CAPTCHA。本应用尚未内置 CAPTCHA 组件，因此停用访客入口，而不是发送一个必然失败的请求。",
  "Guest sign-in is unavailable because login configuration failed to load.":
    "登录配置加载失败，访客登录不可用。",
  "Guest sign-in is not enabled on this deployment.": "此部署未开启访客登录。",
  "Sign out before starting a guest session; an account is never replaced by guest data.":
    "请先退出账号再开启访客会话；访客数据不会替换账号。",
  "Sign-in is not configured on this deployment. This daemon runs in local guest mode, so there is no account sign-in.":
    "此部署未配置登录。守护进程以本地访客模式运行，因此没有可用的账号登录。",
  "Continue as guest": "以访客身份继续",

  /* ── auth: password recovery ────────────────────────────────── */
  "Could not send the reset email.": "无法发送重置邮件。",
  "Check your email": "查收邮件",
  "If an account exists for {email}, a password-reset link is on its way. The link expires — use it promptly, then choose a new password.":
    "如果 {email} 对应一个账号，重置链接正在发送中。链接会过期，请尽快使用并设置新密码。",
  "Back to sign in": "返回登录",
  "Reset your password": "重置密码",
  "Enter your account email and we will send you a reset link.":
    "输入账号邮箱，我们会发送重置链接。",
  "Sending…": "发送中…",
  "Send reset link": "发送重置链接",
  "Finish your account setup": "完成账号设置",
  "Choose a new password": "设置新密码",
  "Your email is verified and this guest session now has an account. Set a password to finish. Your existing workout history stays attached to this same user; nothing is merged into another account.":
    "邮箱已验证，此访客会话现在拥有账号。设置密码即可完成。现有训练历史仍归属于同一用户，不会合并到其他账号。",
  "Invited users set their first password here as well as password resets.":
    "受邀用户也在此设置初始密码，重置密码同样在此进行。",
  "Loading configuration…": "加载配置中…",
  "Reload": "重新加载",
  "Request a new link": "重新获取链接",
  "This verified upgrade belongs to the tab that started it. Open this page in that tab; your current session was not changed.":
    "此已验证升级属于发起它的标签页。请在该标签页打开本页；当前会话未被更改。",
  "New password": "新密码",
  "Updating…": "更新中…",
  "Set password": "设置密码",
  "Update password": "更新密码",
  "Still loading configuration. Wait a moment and try again.": "配置仍在加载，请稍后重试。",
  "Open this page in the tab where the email was verified. Your current session was not changed.":
    "请在验证邮箱的那个标签页打开本页。当前会话未被更改。",
  "This reset link is invalid or expired. Request a new one.":
    "此重置链接无效或已过期，请重新获取。",
  "The password was saved, but this session changed before the upgrade could be confirmed. The pending upgrade was kept; reopen this tab to finish.":
    "密码已保存，但会话在确认升级前发生变化。待完成的升级已保留；请重新打开此标签页完成。",
  "Could not update the password.": "无法更新密码。",
  "Password reset is not configured on this deployment. This daemon runs in local guest mode, so there is no account password to reset.":
    "此部署未配置密码重置。守护进程以本地访客模式运行，因此没有可重置的账号密码。",
  "This link is invalid or expired. Request a new one or sign in.":
    "此链接无效或已过期，请重新获取或登录。",
  "This verification link could not be applied. Your current session was not changed.":
    "无法应用此验证链接。当前会话未被更改。",
  "Finishing sign-in…": "正在完成登录…",
  "Verifying your link.": "正在验证链接。",
};
