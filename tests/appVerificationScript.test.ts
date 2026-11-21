import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ANALYSIS_METRICS,
  COMBOBOX_SELECTOR,
  FIRST_EXERCISE_SELECTOR,
  MANIFEST_SCHEMA,
  SCENARIO_ID,
  assertionId,
  buildManifest,
  computeArtifactDigest,
  defaultEvidenceDir,
  discoverChrome,
  evaluateCleanup,
  evidenceEntry,
  exerciseFieldSelector,
  exerciseOptionSelector,
  exitCodeForOutcome,
  historyRowDate,
  isGuestPublicConfig,
  metricSelector,
  parseInteger,
  parseListeningLine,
  parseMetricNumber,
  recordIdFromHref,
  recordIdFromPathname,
  sha256Hex,
  slugify,
  summarizeGitStatus,
  utcTimestamp,
} from "../scripts/verification/helpers.ts";
import type { ManifestInput, Provenance } from "../scripts/verification/helpers.ts";
import { CdpClient } from "../scripts/verification/cdp.ts";

test("exitCodeForOutcome maps the documented contract", () => {
  assert.equal(exitCodeForOutcome("passed"), 0);
  assert.equal(exitCodeForOutcome("failed"), 1);
  assert.equal(exitCodeForOutcome("build-missing"), 2);
  assert.equal(exitCodeForOutcome("chrome-missing"), 3);
});

test("utcTimestamp is filesystem safe and defaultEvidenceDir is under .fit-trace", () => {
  const now = new Date("2026-11-21T10:14:05.123Z");
  assert.equal(utcTimestamp(now), "2026-11-21T10-14-05-123Z");
  assert.equal(
    defaultEvidenceDir("/repo", now),
    path.join("/repo", ".fit-trace", "verification", "2026-11-21T10-14-05-123Z"),
  );
});

test("parseMetricNumber strips thousands separators and units", () => {
  assert.equal(parseMetricNumber("Volume: 1,237.5 kg"), 1237.5);
  assert.equal(parseMetricNumber("Sessions: 3"), 3);
  assert.equal(parseMetricNumber("Average RPE: 7.5"), 7.5);
  assert.equal(parseMetricNumber("Average RPE: n/a"), null);
  assert.equal(parseMetricNumber("Volume: 1\u00a0237.5 kg"), 1237.5);
});

test("parseInteger reads a source-record count", () => {
  assert.equal(parseInteger("Computed from 3 record(s)."), 3);
  assert.equal(parseInteger("Computed from 1,024 records."), 1024);
  assert.equal(parseInteger("no count here"), null);
});

test("parseListeningLine finds the canonical daemon announcement in mixed output", () => {
  const stdout = [
    "default coaching backend: pi",
    "fit-trace daemon listening at http://127.0.0.1:51234",
    "data directory: /tmp/fit-trace",
    "fit-trace daemon listening at http://127.0.0.1:9", // later noise must not win
  ].join("\n");
  assert.equal(parseListeningLine(stdout), "http://127.0.0.1:51234");
  assert.equal(parseListeningLine("no announcement"), null);
});

test("isGuestPublicConfig accepts only the daemon's zero-config guest shape", () => {
  assert.equal(
    isGuestPublicConfig({ data: { daemon: true, auth_configured: false } }),
    true,
  );
  assert.equal(
    isGuestPublicConfig({
      data: { daemon: true, auth_configured: false, supabaseUrl: "https://x" },
    }),
    false,
  );
  assert.equal(isGuestPublicConfig({ data: { daemon: true, auth_configured: true } }), false);
  assert.equal(isGuestPublicConfig({ data: null }), false);
  assert.equal(isGuestPublicConfig(null), false);
});

test("discoverChrome prefers FIT_TRACE_CHROME over every platform candidate", () => {
  const found = discoverChrome({
    env: { FIT_TRACE_CHROME: "/custom/chrome" },
    platform: "darwin",
    exists: (candidate) => candidate === "/custom/chrome" || candidate.startsWith("/Applications/"),
    which: () => "/path/google-chrome",
  });
  assert.equal(found, "/custom/chrome");
});

test("discoverChrome falls back from a missing explicit path to the macOS bundle", () => {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const found = discoverChrome({
    env: { FIT_TRACE_CHROME: "/missing/chrome" },
    platform: "darwin",
    exists: (candidate) => candidate === mac,
    which: () => null,
  });
  assert.equal(found, mac);
});

test("discoverChrome checks PATH commands in order outside macOS", () => {
  const found = discoverChrome({
    env: {},
    platform: "linux",
    exists: () => false,
    which: (command) => (command === "chromium" ? "/usr/bin/chromium" : null),
  });
  assert.equal(found, "/usr/bin/chromium");
});

test("discoverChrome checks common Windows install paths last", () => {
  const found = discoverChrome({
    env: { ProgramFiles: "C:\\Program Files" },
    platform: "win32",
    exists: (candidate) => candidate === "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    which: () => null,
  });
  assert.equal(found, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
});

test("discoverChrome returns null when nothing exists", () => {
  assert.equal(
    discoverChrome({ env: {}, platform: "linux", exists: () => false, which: () => null }),
    null,
  );
});

test("summarizeGitStatus counts porcelain entries and flags a dirty tree", () => {
  assert.deepEqual(summarizeGitStatus(""), { dirty: false, dirtyFileCount: 0 });
  assert.deepEqual(summarizeGitStatus("\n\r\n"), { dirty: false, dirtyFileCount: 0 });
  assert.deepEqual(summarizeGitStatus(" M a.ts\n?? b.ts\n"), {
    dirty: true,
    dirtyFileCount: 2,
  });
  // A rename is one `old -> new` line, so it counts once.
  assert.deepEqual(summarizeGitStatus("R  old.ts -> new.ts\n"), {
    dirty: true,
    dirtyFileCount: 1,
  });
});

test("computeArtifactDigest is path-sorted, path-sensitive, and byte-sensitive", () => {
  const index = new TextEncoder().encode("<!doctype html>");
  const bundle = new TextEncoder().encode("console.log(1);");
  const forward = computeArtifactDigest([
    { path: "assets/index-abc.js", bytes: bundle },
    { path: "index.html", bytes: index },
  ]);
  const reversed = computeArtifactDigest([
    { path: "index.html", bytes: index },
    { path: "assets/index-abc.js", bytes: bundle },
  ]);
  assert.equal(forward, reversed);
  assert.match(forward, /^[0-9a-f]{64}$/);

  // Same bytes, different path -> different digest.
  const renamed = computeArtifactDigest([
    { path: "assets/index-def.js", bytes: bundle },
    { path: "index.html", bytes: index },
  ]);
  assert.notEqual(forward, renamed);

  // Same paths, one changed byte -> different digest.
  const mutated = computeArtifactDigest([
    { path: "assets/index-abc.js", bytes: new TextEncoder().encode("console.log(2);") },
    { path: "index.html", bytes: index },
  ]);
  assert.notEqual(forward, mutated);

  assert.throws(
    () =>
      computeArtifactDigest([
        { path: "a.js", bytes: index },
        { path: "a.js", bytes: bundle },
      ]),
    /duplicate artifact path: a\.js/,
  );
});

test("sha256Hex and evidenceEntry hash the exact bytes written", () => {
  const bytes = Buffer.from("daemon output\n", "utf8");
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256Hex(bytes), expected);
  assert.deepEqual(evidenceEntry("daemon.log", bytes), {
    path: "daemon.log",
    bytes: bytes.byteLength,
    sha256: expected,
  });
});

test("slugify and assertionId produce stable kebab-case ids", () => {
  assert.equal(slugify("GET / status"), "get-status");
  assert.equal(slugify("UI/API volume agree"), "ui-api-volume-agree");
  assert.equal(slugify("  trailing — dashes  "), "trailing-dashes");
  assert.equal(assertionId("http-shell", "GET / status"), "http-shell.get-status");
  assert.equal(
    assertionId("cleanup", "chrome exit confirmed"),
    "cleanup.chrome-exit-confirmed",
  );
});

test("semantic selectors target the first exercise and metrics by key", () => {
  assert.equal(FIRST_EXERCISE_SELECTOR, '[data-screen="log"] .exercise-editor');
  assert.equal(
    exerciseFieldSelector("weight"),
    '[data-screen="log"] .exercise-editor input[id$="-weight"]',
  );
  assert.equal(
    exerciseFieldSelector("reps"),
    '[data-screen="log"] .exercise-editor input[id$="-reps"]',
  );
  assert.equal(
    metricSelector("avg_rpe"),
    '[data-screen="analysis"] ul.analysis-metrics li[data-metric="avg_rpe"]',
  );
  assert.deepEqual([...ANALYSIS_METRICS], [
    "sessions",
    "sets",
    "reps",
    "volume",
    "avg_rpe",
    "avg_rest",
    "max_gap",
  ]);
  assert.equal(COMBOBOX_SELECTOR, '[data-screen="log"] input[role="combobox"]');
  assert.equal(
    exerciseOptionSelector("Barbell Bench Press - Medium Grip"),
    'li[role="option"][data-exercise-name="Barbell Bench Press - Medium Grip"]',
  );
});

test("record identity parses the saved route, history hrefs, and row dates", () => {
  assert.equal(recordIdFromPathname("/workout/abc123"), "abc123");
  assert.equal(recordIdFromPathname("/workout/a%2Fb"), "a/b");
  assert.equal(recordIdFromPathname("/workout/new"), null);
  assert.equal(recordIdFromPathname("/workout/a/b"), null);
  assert.equal(recordIdFromPathname("/analysis"), null);
  assert.equal(recordIdFromPathname("/workout/"), null);
  assert.equal(recordIdFromHref("/workout/abc123?x=1#top"), "abc123");
  assert.equal(recordIdFromHref("http://127.0.0.1:5199/workout/abc123"), "abc123");
  assert.equal(recordIdFromHref("/analysis"), null);
  assert.equal(historyRowDate("2026-11-21 — Strength"), "2026-11-21");
  assert.equal(historyRowDate("no date"), null);
});

test("evaluateCleanup fails only on unconfirmed exits or an undeleted workspace", () => {
  const clean = {
    chrome: { stopped: true, exitConfirmed: true },
    daemon: { stopped: true, exitConfirmed: true },
    tempRoot: { kept: false, deleted: true },
  };
  assert.deepEqual(evaluateCleanup(clean), { failed: false, reasons: [] });

  const unconfirmed = evaluateCleanup({
    ...clean,
    daemon: { stopped: false, exitConfirmed: false },
  });
  assert.equal(unconfirmed.failed, true);
  assert.match(unconfirmed.reasons.join("; "), /daemon process exit was not confirmed/);

  const undeleted = evaluateCleanup({
    ...clean,
    tempRoot: { kept: false, deleted: false },
  });
  assert.equal(undeleted.failed, true);
  assert.match(undeleted.reasons.join("; "), /temporary workspace was not deleted/);

  // --keep-data is an intentional keep, not a cleanup failure.
  assert.deepEqual(
    evaluateCleanup({ ...clean, tempRoot: { kept: true, deleted: false } }),
    { failed: false, reasons: [] },
  );
});

test("buildManifest stamps schema 2, the scenario, and the provenance block", () => {
  const provenance: Provenance = {
    testedSha: "f9c64e3aeac8120b160ee5b08bb7505b48b48e4b",
    branch: "main",
    dirty: true,
    dirtyFileCount: 2,
    artifactSha256: "a".repeat(64),
    nodeVersion: "v24.22.3",
    chromeVersion: "Chrome/157.0.0.0",
    platform: "darwin",
    arch: "arm64",
  };
  const input: ManifestInput = {
    startedAt: "2026-11-21T10:00:00.000Z",
    finishedAt: "2026-11-21T10:00:02.000Z",
    provenance,
    baseUrl: "http://127.0.0.1:1234",
    evidenceDir: "/repo/.fit-trace/verification/run",
    dataDir: "/tmp/run/data",
    outcome: "passed",
    steps: [
      {
        id: "daemon-start",
        name: "daemon",
        status: "passed",
        startedAt: "2026-11-21T10:00:00.100Z",
        durationMs: 12,
      },
    ],
    assertions: [
      {
        id: "daemon-start.daemon-health-check",
        step: "daemon-start",
        name: "daemon health check",
        expected: true,
        actual: true,
        passed: true,
        required: true,
      },
    ],
    evidence: [
      { path: "daemon.log", bytes: 4, sha256: "b".repeat(64) },
    ],
    cleanup: {
      chrome: { stopped: true, exitConfirmed: true },
      daemon: { stopped: true, exitConfirmed: true },
      tempRoot: { kept: false, deleted: true },
    },
    error: null,
  };

  const manifest = buildManifest(input);
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.scenarioId, SCENARIO_ID);
  assert.equal(manifest.scenarioId, "guest-app-log-analyze");
  assert.deepEqual(manifest.provenance, provenance);
  assert.equal(manifest.assertions[0].required, true);
  assert.equal(manifest.assertions[0].step, manifest.steps[0].id);
  assert.deepEqual(manifest.steps, input.steps);
  assert.deepEqual(manifest.assertions, input.assertions);
  assert.deepEqual(manifest.evidence, input.evidence);

  // All ids are unique and every assertion id starts with its step id.
  const ids = new Set(manifest.assertions.map((assertion) => assertion.id));
  assert.equal(ids.size, manifest.assertions.length);
  assert.ok(
    manifest.assertions.every((assertion) => assertion.id.startsWith(`${assertion.step}.`)),
  );

  // Mutating the source after the build must not change the manifest.
  input.steps[0].name = "changed";
  input.provenance.branch = "other";
  input.evidence.push({ path: "late.png", bytes: 1, sha256: "c".repeat(64) });
  assert.equal(manifest.steps[0].name, "daemon");
  assert.equal(manifest.provenance.branch, "main");
  assert.equal(manifest.evidence.length, 1);

  // The document must round-trip through JSON as written to disk.
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
});

test("CdpClient.send times out per command, names the method, and stays usable", async () => {
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readyState = 1;
    sent: { id: number; method: string }[] = [];
    closed = false;
    send(data: string): void {
      this.sent.push(JSON.parse(data) as { id: number; method: string });
    }
    close(): void {
      this.closed = true;
      this.readyState = 3;
    }
    deliver(message: unknown): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  const socket = new FakeSocket();
  const client = new CdpClient(socket as never, 5_000);

  await assert.rejects(
    client.send("Runtime.evaluate", { expression: "1" }, undefined, { timeoutMs: 20 }),
    /CDP command Runtime\.evaluate timed out after 20ms/,
  );

  // The timed-out id was removed, so a later command still resolves.
  const pending = client.send<{ ok: boolean }>("Page.enable");
  const sent = socket.sent[socket.sent.length - 1];
  assert.equal(sent.method, "Page.enable");
  socket.deliver({ id: sent.id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  client.close();
});
