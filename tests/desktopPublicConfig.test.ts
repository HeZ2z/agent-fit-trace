import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateConfig, childEnvironment } = require("../packages/fit-trace-desktop/main/publicConfig.cjs");
const { parseOrigin, loadOrigin, saveOrigin } = require("../packages/fit-trace-desktop/main/origin.cjs");
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const config = { schemaVersion: 1, channel: "release", supabaseUrl: "https://example.supabase.co", supabasePublishableKey: "sb_publishable_example" };
test("desktop public config accepts only the allowlisted schema and public key", () => {
  assert.deepEqual(validateConfig(config), config);
  for (const invalid of [{...config, schemaVersion: 2}, {...config, other: "x"}, {...config, supabaseUrl: "http://example.com"}, {...config, supabasePublishableKey: "sb_secret_abc"}, {...config, supabasePublishableKey: ""}]) assert.throws(() => validateConfig(invalid));
  assert.doesNotThrow(() => validateConfig({schemaVersion: 1, channel: "guest-only", supabaseUrl: "", supabasePublishableKey: ""}));
});
test("desktop override is atomic and ignores legacy alias", () => {
  const selected = childEnvironment(config, {SUPABASE_ANON_KEY: "legacy"});
  assert.equal(selected.SUPABASE_PUBLISHABLE_KEY, config.supabasePublishableKey);
  assert.equal(selected.SUPABASE_ANON_KEY, undefined);
  assert.throws(() => childEnvironment(config, {SUPABASE_URL: "https://other.example"}));
  assert.throws(() => childEnvironment(config, {SUPABASE_PUBLISHABLE_KEY: "sb_publishable_other"}));
  const override = childEnvironment(config, {SUPABASE_URL: "https://other.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_other", SUPABASE_ANON_KEY: "legacy"});
  assert.equal(override.SUPABASE_URL, "https://other.example");
  assert.equal(override.SUPABASE_PUBLISHABLE_KEY, "sb_publishable_other");
  assert.equal(override.SUPABASE_ANON_KEY, undefined);
});
test("desktop origin persists and rejects non-loopback origins", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-trace-origin-"));
  try { assert.equal(loadOrigin(dir), 0); saveOrigin(dir, "http://127.0.0.1:43210"); assert.equal(loadOrigin(dir), 43210); for (const origin of ["http://localhost:1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:1/path"]) assert.throws(() => parseOrigin(origin)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
