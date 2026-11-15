import { syncAuthFixture } from "./syncAuthFixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { validateConfig, childEnvironment } = require("../packages/fit-trace-desktop/main/publicConfig.cjs");
const { applySyncEnvironment, disabledSyncConfig, resolveBuildSyncConfig, validateSyncConfig } = require("../packages/fit-trace-desktop/main/syncConfig.cjs");
const { writeBuildSyncConfig } = require("../packages/fit-trace-desktop/scripts/buildSyncConfig.cjs");
const release = { schemaVersion: 1, channel: "release", supabaseUrl: "https://project.example", supabasePublishableKey: "sb_publishable_example" };
const env = { FIT_TRACE_DESKTOP_CHANNEL: "release", FIT_TRACE_DESKTOP_SUPABASE_URL: release.supabaseUrl,
  FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY: release.supabasePublishableKey,
  FIT_TRACE_DESKTOP_SYNC_PUBLIC_KEYS: JSON.stringify(syncAuthFixture.publicKeys), FIT_TRACE_DESKTOP_SYNC_APPROVED: "1", FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "https://api.example/api/v1" };

test("sync build requires explicit approval and a public release-bound HTTPS destination", () => {
  assert.deepEqual(resolveBuildSyncConfig({}), disabledSyncConfig());
  const enabled = resolveBuildSyncConfig(env);
  assert.equal(enabled.enabled, true);
  assert.deepEqual(validateConfig(release), release); // The original four-field contract remains exact.
  for (const changes of [
    { FIT_TRACE_DESKTOP_SYNC_APPROVED: "", FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: env.FIT_TRACE_DESKTOP_SYNC_API_BASE_URL },
    { FIT_TRACE_DESKTOP_SYNC_APPROVED: "1", FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "" },
    { FIT_TRACE_DESKTOP_SYNC_APPROVED: "yes" },
    { FIT_TRACE_DESKTOP_CHANNEL: "guest-only" },
    { FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY: "sb_secret_private" },
    { FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "http://api.example/api/v1" },
    { FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "https://user:pass@api.example/api/v1" },
    { FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "https://api.example/api/v1?token=secret" },
    { FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "https://api.example/api/v1#fragment" },
    { FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "https://api.example/other" },
    { FIT_TRACE_DESKTOP_SYNC_PUBLIC_KEYS: "[]" },
    { FIT_TRACE_DESKTOP_SYNC_PUBLIC_KEYS: JSON.stringify([{ ...syncAuthFixture.publicKeys[0], d: "private" }]) },
    { FIT_TRACE_DESKTOP_SYNC_PUBLIC_KEYS: JSON.stringify([{ ...syncAuthFixture.publicKeys[0], x: "invalid" }]) },
  ]) assert.throws(() => resolveBuildSyncConfig({ ...env, ...changes }));
  assert.throws(() => validateSyncConfig({ ...enabled, secret: "not allowed" }));
});

test("packaged daemon receives sync settings only with matching release authentication", () => {
  const enabled = resolveBuildSyncConfig(env);
  const inherited = { FIT_TRACE_API_BASE_URL: "https://evil.example/api/v1", FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH: "1", FIT_TRACE_SYNC_PUBLIC_KEYS: "untrusted", FIT_TRACE_CLOUD_API_BASE_URL: "https://evil.example/api/v1" };
  const auth = childEnvironment(release, inherited);
  const selected = applySyncEnvironment(enabled, release, auth);
  assert.equal(selected.FIT_TRACE_API_BASE_URL, env.FIT_TRACE_DESKTOP_SYNC_API_BASE_URL);
  assert.equal(selected.FIT_TRACE_CLOUD_API_BASE_URL, env.FIT_TRACE_DESKTOP_SYNC_API_BASE_URL);
  assert.equal(selected.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH, "1");
  for (const sync of [null, disabledSyncConfig()]) {
    const result = applySyncEnvironment(sync, release, auth);
    assert.equal(result.FIT_TRACE_API_BASE_URL, undefined);
    assert.equal(result.FIT_TRACE_CLOUD_API_BASE_URL, undefined);
    assert.equal(result.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH, undefined);
    assert.equal(result.FIT_TRACE_SYNC_PUBLIC_KEYS, undefined);
  }
  const other = childEnvironment(release, { ...inherited, SUPABASE_URL: "https://other.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_other" });
  const blocked = applySyncEnvironment(enabled, release, other);
  assert.equal(blocked.FIT_TRACE_API_BASE_URL, undefined);
  assert.equal(blocked.FIT_TRACE_CLOUD_API_BASE_URL, undefined);
  assert.equal(blocked.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH, undefined);
  const mismatchedFile = { ...enabled, authUrl: "https://other.example", authPublishableKey: "sb_publishable_other" };
  assert.equal(applySyncEnvironment(mismatchedFile, release, auth).FIT_TRACE_API_BASE_URL, undefined);
  const wrongKey = childEnvironment(release, { SUPABASE_URL: release.supabaseUrl, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_other" });
  assert.equal(applySyncEnvironment(enabled, release, wrongKey).FIT_TRACE_API_BASE_URL, undefined);
  const guest = { schemaVersion: 1, channel: "guest-only", supabaseUrl: "", supabasePublishableKey: "" };
  assert.equal(applySyncEnvironment(enabled, guest, childEnvironment(guest, inherited)).FIT_TRACE_API_BASE_URL, undefined);
});

test("failed or disabled build cannot retain a previously approved staging config", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-trace-sync-config-"));
  const file = join(dir, "desktop-sync-config.json");
  writeFileSync(file, JSON.stringify(resolveBuildSyncConfig(env)));
  assert.throws(() => writeBuildSyncConfig(file, { ...env, FIT_TRACE_DESKTOP_SYNC_API_BASE_URL: "http://invalid/api/v1" }));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), disabledSyncConfig());
  writeBuildSyncConfig(file, {});
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), disabledSyncConfig());
});

test("packaged launch plan passes only approved sync settings to the daemon child", () => {
  const { resolveLaunchPlan } = require("../packages/fit-trace-desktop/main/paths.cjs");
  const plan = resolveLaunchPlan({ packaged: true, resourcesPath: "/tmp/resources", devRepoRoot: "/tmp/repo",
    execPath: "/tmp/electron", env: { FIT_TRACE_API_BASE_URL: "https://untrusted.example/api/v1", FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH: "1" } });
  const auth = childEnvironment(release, plan.env);
  const child = applySyncEnvironment(resolveBuildSyncConfig(env), release, auth);
  assert.equal(child.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(child.FIT_TRACE_API_BASE_URL, "https://api.example/api/v1");
  assert.equal(child.FIT_TRACE_CLOUD_API_BASE_URL, "https://api.example/api/v1");
  assert.equal(child.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH, "1");
  const off = applySyncEnvironment(disabledSyncConfig(), release, auth);
  assert.equal(off.FIT_TRACE_API_BASE_URL, undefined);
  assert.equal(off.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH, undefined);
});

test("invalid packaged sync configuration warns without exposing its contents and keeps training enabled", () => {
  const { configurePackagedSync } = require("../packages/fit-trace-desktop/main/syncConfig.cjs");
  const auth = childEnvironment(release, { FIT_TRACE_API_BASE_URL: "https://untrusted.example/api/v1", FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH: "1" });
  for (const read of [
    () => { throw new Error("secret input path"); },
    () => '{"secret":"sensitive-config-value"}',
    () => "not json: sensitive-config-value",
  ]) {
    const warnings: string[] = [];
    const result = configurePackagedSync(read, release, auth, (message: string) => warnings.push(message));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Sync is disabled; local training remains available/);
    assert.doesNotMatch(warnings[0], /secret|sensitive|untrusted/);
    assert.equal(result.FIT_TRACE_API_BASE_URL, undefined);
    assert.equal(result.FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH, undefined);
    assert.equal(result.SUPABASE_URL, release.supabaseUrl);
  }
});

test("valid disabled config stays quiet; mismatched approved auth warns and remains disabled", () => {
  const { configurePackagedSync } = require("../packages/fit-trace-desktop/main/syncConfig.cjs");
  const warnings: string[] = [];
  const auth = childEnvironment(release, {});
  const disabled = configurePackagedSync(() => JSON.stringify(disabledSyncConfig()), release, auth, (message: string) => warnings.push(message));
  assert.equal(disabled.FIT_TRACE_API_BASE_URL, undefined);
  assert.equal(warnings.length, 0);
  const mismatchedAuth = childEnvironment(release, { SUPABASE_URL: "https://other.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_other" });
  const mismatch = configurePackagedSync(() => JSON.stringify(resolveBuildSyncConfig(env)), release, mismatchedAuth, (message: string) => warnings.push(message));
  assert.equal(mismatch.FIT_TRACE_API_BASE_URL, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Sync is disabled; local training remains available/);
  assert.doesNotMatch(warnings[0], /other\.example|sb_publishable/);
});
