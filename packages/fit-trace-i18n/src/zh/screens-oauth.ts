/**
 * Chinese display layer — remote-app OAuth consent.
 *
 * Keys are the exact English source strings; values are Simplified Chinese.
 * An entry that is missing falls back to English, so this table is safe to
 * extend in slices. Client names, client URIs and scopes are server-provided
 * data and are never listed here.
 */
export const messages: Record<string, string> = {
  "This deployment has no account sign-in, so remote app authorization is unavailable.":
    "此部署没有账号登录，因此无法进行远程应用授权。",
  "Sign in to review this authorization request. The request stays open on this page.":
    "登录后即可查看此授权请求。该请求会在此页面保持打开。",
  "Could not load this authorization request.": "无法加载此授权请求。",
  "Could not record your decision. Try again.": "无法记录你的决定。请重试。",
  "Authorize an app": "授权应用",
  "This consent link is missing a valid authorization request. Return to the app that asked for access and start again.":
    "此授权链接缺少有效的授权请求。请返回请求访问的应用并重新开始。",
  "Loading the authorization request…": "正在加载授权请求…",
  "{client} wants to connect to your Agent Fit Trace training data.":
    "{client} 希望连接你的 Agent Fit Trace 训练数据。",
  "App": "应用",
  "App website": "应用网站",
  "Requested access": "请求的权限",
  "No scopes were requested.": "未请求任何权限范围。",
  "After you decide, you will be sent to": "做出决定后，你将被送到",
  "Approving lets this app read and write your own training records: your workout history, analysis results, and draft training plans. It cannot see another user's data.":
    "批准后，此应用可以读写你自己的训练记录：训练历史、分析结果与训练计划草稿。它无法查看其他用户的数据。",
  "Sending you back to the app…": "正在将你送回应用…",
  "Approving…": "正在批准…",
  "Approve access": "批准访问",
  "Denying…": "正在拒绝…",
  "Deny": "拒绝",
};
