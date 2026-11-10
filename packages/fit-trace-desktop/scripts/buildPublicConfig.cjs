"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { validateConfig } = require("../main/publicConfig.cjs");
const output = path.join(__dirname, "..", "staging", "desktop-public-config.json");
// Remove any prior build before validating so a failed build cannot reuse it.
fs.rmSync(output, { force: true });
const channel = process.env.FIT_TRACE_DESKTOP_CHANNEL;
const config = validateConfig({
  schemaVersion: 1,
  channel,
  supabaseUrl: process.env.FIT_TRACE_DESKTOP_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY ?? "",
});
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
