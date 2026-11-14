"use strict";

const { validateConfig } = require("./publicConfig.cjs");
const { createPublicKey } = require("node:crypto");

/** Public, versioned release configuration. No credentials or arbitrary fields. */
function validateSyncConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "apiBaseUrl,authPublishableKey,authUrl,enabled,publicKeys,schemaVersion" ||
      value.schemaVersion !== 2 || typeof value.enabled !== "boolean") {
    throw new Error("Invalid desktop sync configuration.");
  }
  if (!value.enabled) {
    if (value.apiBaseUrl !== "" || value.authUrl !== "" || value.authPublishableKey !== "" || !Array.isArray(value.publicKeys) || value.publicKeys.length) {
      throw new Error("Disabled desktop sync must have empty settings.");
    }
    return value;
  }
  validateConfig({ schemaVersion: 1, channel: "release", supabaseUrl: value.authUrl, supabasePublishableKey: value.authPublishableKey });
  if (!Array.isArray(value.publicKeys) || value.publicKeys.length < 1 || value.publicKeys.length > 2 ||
      !value.publicKeys.every(key => key && typeof key === "object" && Object.keys(key).sort().join(",") === "crv,kid,kty,x,y" && key.kty === "EC" && key.crv === "P-256" && typeof key.kid === "string" && key.kid.length > 0 && typeof key.x === "string" && typeof key.y === "string") ||
      new Set(value.publicKeys.map(key => key.kid)).size !== value.publicKeys.length) throw new Error("Invalid desktop sync public keys.");
  try { for (const key of value.publicKeys) createPublicKey({ key, format: "jwk" }); }
  catch { throw new Error("Invalid desktop sync public keys."); }
  try {
    if (typeof value.apiBaseUrl !== "string" || /\s/.test(value.apiBaseUrl)) throw new Error();
    const url = new URL(value.apiBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/v1") throw new Error();
    if (value.apiBaseUrl !== `${url.origin}${url.pathname}`) throw new Error();
  } catch { throw new Error("Invalid desktop sync API base."); }
  return value;
}

function disabledSyncConfig() {
  return { schemaVersion: 2, enabled: false, apiBaseUrl: "", authUrl: "", authPublishableKey: "", publicKeys: [] };
}

/** The sync settings are valid only for the release project that approved them. */
function applySyncEnvironment(syncConfig, releaseConfig, childEnv) {
  const result = { ...childEnv };
  delete result.FIT_TRACE_API_BASE_URL;
  delete result.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH;
  delete result.FIT_TRACE_SYNC_PUBLIC_KEYS;
  // A packaged build must not inherit a renderer/operator environment pointing
  // the cloud proxy at another host. Only the approved sync destination may
  // enable it below.
  delete result.FIT_TRACE_CLOUD_API_BASE_URL;
  if (syncConfig === null) return result;
  const sync = validateSyncConfig(syncConfig);
  const release = validateConfig(releaseConfig);
  if (sync.enabled && release.channel === "release" &&
      sync.authUrl === release.supabaseUrl && sync.authPublishableKey === release.supabasePublishableKey &&
      result.SUPABASE_URL === release.supabaseUrl && result.SUPABASE_PUBLISHABLE_KEY === release.supabasePublishableKey) {
    result.FIT_TRACE_API_BASE_URL = sync.apiBaseUrl;
    // Cloud coaching proxies the caller's bearer to the same approved hosted
    // destination. Sync must be configured for cloud to be meaningful (the
    // hosted coach reads synced account records), so this reuse adds no new
    // trust decision.
    result.FIT_TRACE_CLOUD_API_BASE_URL = sync.apiBaseUrl;
    result.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH = "1";
    result.FIT_TRACE_SYNC_PUBLIC_KEYS = JSON.stringify(sync.publicKeys);
  }
  return result;
}

/** Report a safe, user-visible warning while keeping local training available. */
function configurePackagedSync(readText, releaseConfig, childEnv, warn) {
  let sync;
  try {
    sync = validateSyncConfig(JSON.parse(readText()));
  } catch {
    warn("Workout sync configuration is missing or invalid. Sync is disabled; local training remains available. Reinstall the app or contact support.");
    return applySyncEnvironment(null, releaseConfig, childEnv);
  }
  const result = applySyncEnvironment(sync, releaseConfig, childEnv);
  if (sync.enabled && result.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH !== "1") {
    warn("Workout sync configuration does not match this account service. Sync is disabled; local training remains available. Check your configuration or contact support.");
  }
  return result;
}

/** Approval and the target are an inseparable release-build input pair. */
function resolveBuildSyncConfig(env) {
  const approved = env.FIT_TRACE_DESKTOP_SYNC_APPROVED ?? "";
  const target = env.FIT_TRACE_DESKTOP_SYNC_API_BASE_URL ?? "";
  if (approved === "" || approved === "0") {
    if (target !== "") throw new Error("Desktop sync target requires explicit approval.");
    return disabledSyncConfig();
  }
  if (approved !== "1" || target === "" || env.FIT_TRACE_DESKTOP_CHANNEL !== "release") {
    throw new Error("Desktop sync requires explicit approval, a target and release authentication.");
  }
  let publicKeys;
  try { publicKeys = JSON.parse(env.FIT_TRACE_DESKTOP_SYNC_PUBLIC_KEYS ?? "null"); } catch { throw new Error("Invalid desktop sync public keys."); }
  return validateSyncConfig({
    schemaVersion: 2, enabled: true, apiBaseUrl: target, publicKeys,
    authUrl: env.FIT_TRACE_DESKTOP_SUPABASE_URL ?? "",
    authPublishableKey: env.FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY ?? "",
  });
}

module.exports = { validateSyncConfig, disabledSyncConfig, resolveBuildSyncConfig, applySyncEnvironment, configurePackagedSync };
