"use strict";

/**
 * `build:public-config` — validate the public desktop auth environment and stage
 * `staging/desktop-public-config.json`.
 *
 * The build is deliberately FAIL-CLOSED: an unset `FIT_TRACE_DESKTOP_CHANNEL`
 * is an error, never an implicit guest-only build. The pre-checks below exist
 * only to turn `validateConfig`'s (intentionally terse) schema errors into an
 * actionable command; `validateConfig` stays the single schema authority.
 */

const fs = require("node:fs");
const path = require("node:path");
const { validateConfig } = require("../main/publicConfig.cjs");

const SCRIPT = "build:public-config";
const LOCAL_ONLY_HINT =
  "For a local-only build run: FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm desktop:build";

/** @param {string} message */
function fail(message) {
  throw new Error(`[${SCRIPT}] ${message}`);
}

/**
 * Resolve and validate the public config from a build environment.
 * Never prints or serializes the configured values.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
function publicConfigFromEnv(env) {
  const rawChannel = env.FIT_TRACE_DESKTOP_CHANNEL;
  const channel = typeof rawChannel === "string" ? rawChannel : "";
  if (channel !== "release" && channel !== "guest-only") {
    const shown = rawChannel === undefined || rawChannel === "" ? "unset" : JSON.stringify(rawChannel);
    fail(
      `FIT_TRACE_DESKTOP_CHANNEL must be "release" or "guest-only" (got ${shown}). ${LOCAL_ONLY_HINT}. ` +
        "Release-channel builds also require FIT_TRACE_DESKTOP_SUPABASE_URL and " +
        "FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY (see docs/release.md).",
    );
  }

  const supabaseUrl = env.FIT_TRACE_DESKTOP_SUPABASE_URL ?? "";
  const supabasePublishableKey = env.FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY ?? "";

  if (channel === "guest-only") {
    if (supabaseUrl !== "" || supabasePublishableKey !== "") {
      fail(
        "FIT_TRACE_DESKTOP_CHANNEL=guest-only must leave FIT_TRACE_DESKTOP_SUPABASE_URL and " +
          "FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY unset; unset both, or build with " +
          "FIT_TRACE_DESKTOP_CHANNEL=release and both public values (see docs/release.md).",
      );
    }
  } else {
    const missing = [];
    if (supabaseUrl === "") missing.push("FIT_TRACE_DESKTOP_SUPABASE_URL");
    if (supabasePublishableKey === "") missing.push("FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY");
    if (missing.length > 0) {
      fail(
        `FIT_TRACE_DESKTOP_CHANNEL=release requires ${missing.join(" and ")}. Set the public project ` +
          `URL and sb_publishable_ key (never a service-role key; see docs/release.md), or use the ` +
          `local-only build: ${LOCAL_ONLY_HINT}.`,
      );
    }
  }

  try {
    return validateConfig({ schemaVersion: 1, channel, supabaseUrl, supabasePublishableKey });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (channel === "release") {
      // Do not echo the values: they may be mistyped secrets.
      fail(
        `Invalid release auth environment (values are not printed): ${detail} ` +
          "FIT_TRACE_DESKTOP_SUPABASE_URL must be an https project URL and " +
          "FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY a public sb_publishable_ key; see docs/release.md. " +
          `For a local-only build run: FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm desktop:build`,
      );
    }
    fail(detail);
  }
}

/**
 * Remove any prior output (so a failed build cannot reuse it), validate, then
 * write the staged JSON.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} output
 */
function writePublicConfig(env, output) {
  fs.rmSync(output, { force: true });
  const config = publicConfigFromEnv(env);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

if (require.main === module) {
  const output = path.join(__dirname, "..", "staging", "desktop-public-config.json");
  try {
    const config = writePublicConfig(process.env, output);
    console.log(`[${SCRIPT}] wrote ${path.relative(process.cwd(), output)} (channel=${config.channel})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { publicConfigFromEnv, writePublicConfig };
