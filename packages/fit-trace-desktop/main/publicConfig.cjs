"use strict";

// This file is public by design. Never accept or serialize arbitrary inputs.
function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid desktop public configuration.");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "channel,schemaVersion,supabasePublishableKey,supabaseUrl" || value.schemaVersion !== 1 || !["release", "guest-only"].includes(value.channel)) throw new Error("Invalid desktop public configuration schema or channel.");
  const { channel, supabaseUrl, supabasePublishableKey } = value;
  if (channel === "guest-only") {
    if (supabaseUrl !== "" || supabasePublishableKey !== "") throw new Error("Guest-only configuration must not contain auth settings.");
    return value;
  }
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
  } catch { throw new Error("Invalid desktop public project URL."); }
  if (typeof supabasePublishableKey !== "string" || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey)) throw new Error("Invalid desktop publishable key.");
  return value;
}
function childEnvironment(config, env) {
  validateConfig(config);
  const hasUrl = Object.hasOwn(env, "SUPABASE_URL");
  const hasKey = Object.hasOwn(env, "SUPABASE_PUBLISHABLE_KEY");
  if (hasUrl !== hasKey) throw new Error("Desktop auth override requires both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  const selected = hasUrl ? validateConfig({ schemaVersion: 1, channel: "release", supabaseUrl: env.SUPABASE_URL, supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY }) : config;
  const result = { ...env };
  delete result.SUPABASE_URL;
  delete result.SUPABASE_PUBLISHABLE_KEY;
  delete result.SUPABASE_ANON_KEY;
  if (selected.channel === "release") {
    result.SUPABASE_URL = selected.supabaseUrl;
    result.SUPABASE_PUBLISHABLE_KEY = selected.supabasePublishableKey;
  }
  return result;
}
module.exports = { validateConfig, childEnvironment };
