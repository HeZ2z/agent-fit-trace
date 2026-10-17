import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { analyzeProgress, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { CoachingEventPayload, CoachingTerminalStatus } from "@pi-fit-trace/api-contracts";
import {
  CoachedOpenCodeRun,
  OPENCODE_COACH_AGENT,
  buildCoachedOpenCodeArgv,
  buildOpenCodeConfig,
  buildOpenCodeIsolatedPaths,
  buildOpenCodePluginSource,
  isSafeOpenCodeSessionId,
  type OpenCodeBridgeInfo,
  type OpenCodeChildProcess,
} from "../server/coaching/opencodeServerAdapter.ts";
import {
  inspectOpenCodeIsolation,
  probeOpenCodeRun,
  type OpenCodeIsolationEvidence,
} from "../server/coaching/opencodeCapability.ts";
import { loadFixture } from "./helpers.ts";

type Done = { status: CoachingTerminalStatus; reason?: string; info?: unknown };

function collect(): {
  events: CoachingEventPayload[];
  readonly done: Done | null;
  onEvent(payload: CoachingEventPayload): void;
  onDone(status: CoachingTerminalStatus, reason?: string, info?: unknown): void;
} {
  const events: CoachingEventPayload[] = [];
  let done: Done | null = null;
  return {
    events,
    get done(): Done | null {
      return done;
    },
    onEvent(payload: CoachingEventPayload) {
      events.push(payload);
    },
    onDone(status: CoachingTerminalStatus, reason?: string, info?: unknown) {
      done = { status, ...(reason !== undefined ? { reason } : {}), ...(info !== undefined ? { info } : {}) };
    },
  };
}

function waitForDone(c: { done: unknown }, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for done")), timeoutMs);
    const check = (): void => {
      if (c.done) {
        clearTimeout(timer);
        resolve();
      } else setTimeout(check, 20);
    };
    check();
  });
}

interface FakeChild extends OpenCodeChildProcess {
  emit(event: string, ...args: unknown[]): boolean;
  killCalls: string[];
  send(record: Record<string, unknown>): void;
  stdoutText(text: string): void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as EventEmitter & FakeChild;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killCalls: string[] = [];
  let killed = false;
  Object.assign(child, { stdout, stderr, killCalls });
  Object.assign(child, {
    send(record: Record<string, unknown>): void {
      stdout.emit("data", Buffer.from(`${JSON.stringify(record)}\n`));
    },
    stdoutText(text: string): void {
      stdout.emit("data", Buffer.from(text));
    },
    kill(signal?: string | number): boolean {
      killCalls.push(String(signal ?? "SIGTERM"));
      if (killed) return true;
      killed = true;
      setImmediate(() => child.emit("close", 0));
      return true;
    },
  });
  return child as FakeChild;
}

async function snapshotFileForFixture(): Promise<{ dir: string; file: string }> {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const dir = await mkdtemp(join(tmpdir(), "opencode-adapter-"));
  const file = join(dir, "snapshot.json");
  await writeFile(file, `${JSON.stringify({ schema_version: 1, records: [record] }, null, 2)}\n`, "utf8");
  return { dir, file };
}

const SESSION_ID = "ses_abc123def456";
const RUN_ID = "run-fixed";

function baseOptions(dir: string, file: string, c = collect()) {
  return {
    sessionId: "s1",
    runId: RUN_ID,
    prompt: "analyze my progress",
    snapshotFile: file,
    sessionDir: join(dir, "session"),
    cwd: join(dir, "session"),
    model: "fixture/model",
    isolationVerified: true,
    runTimeoutMs: 5000,
    graceMs: 20,
    onEvent: c.onEvent,
    onDone: c.onDone,
  };
}

test("opencode config denies everything first and allows exactly the domain tools", () => {
  const config = buildOpenCodeConfig({ model: "fixture/model" });
  const rules = config.permissions as Array<{ action: string; resource: string; effect: string }>;
  assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "deny" });
  assert.deepEqual(
    rules.slice(1),
    [
      { action: "get_training_history", resource: "*", effect: "allow" },
      { action: "analyze_progress", resource: "*", effect: "allow" },
    ],
  );
  assert.equal(config.default_agent, OPENCODE_COACH_AGENT);
  assert.deepEqual(config.plugins, []);
  assert.deepEqual(config.mcp, { servers: {} });
  assert.deepEqual(config.skills, []);
  const agents = config.agents as Record<string, { permissions: unknown[] }>;
  assert.deepEqual(agents[OPENCODE_COACH_AGENT]?.permissions, []);
});

test("opencode argv uses the v2 run surface and never a shell string", () => {
  const argv = buildCoachedOpenCodeArgv({ prompt: "analyze" });
  assert.deepEqual(argv.slice(0, 5), ["run", "--standalone", "--format", "json", "--auto"]);
  assert.equal(argv.at(-1), "analyze");
  const resumed = buildCoachedOpenCodeArgv({ prompt: "-leading dash", resumeSessionId: SESSION_ID });
  assert.ok(resumed.includes("--session"));
  assert.equal(resumed[resumed.indexOf("--session") + 1], SESSION_ID);
  assert.equal(resumed.at(-1), "-leading dash");
});

test("opencode native handles are session ids, never paths", () => {
  assert.ok(isSafeOpenCodeSessionId(SESSION_ID));
  assert.ok(!isSafeOpenCodeSessionId("../escape"));
  assert.ok(!isSafeOpenCodeSessionId("/tmp/session"));
  assert.ok(!isSafeOpenCodeSessionId("ses_short"));
});

test("opencode plugin source contains only the loopback bridge and domain tools", () => {
  const bridge: OpenCodeBridgeInfo = { url: "http://127.0.0.1:1234/tool", token: "token-value" };
  const source = buildOpenCodePluginSource(bridge);
  assert.match(source, /get_training_history/);
  assert.match(source, /analyze_progress/);
  assert.match(source, /127\.0\.0\.1:1234/);
  assert.ok(!source.includes("/tmp/snapshot"));
  assert.ok(!source.includes("node:fs"));
  assert.ok(!source.includes("child_process"));
});

test("opencode adapter fails closed without isolation proof", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    isolationVerified: false,
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /plugin-isolation-unproven/);
  await rm(dir, { recursive: true, force: true });
});

test("opencode adapter: bridge-backed domain tools, text, completion, confirmed exit", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  let bridgeSeen: OpenCodeBridgeInfo | null = null;
  let pluginSource = "";
  let configSource = "";
  const child = fakeChild();
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    env: {
      PATH: process.env.PATH,
      HOME: "/real/home-must-not-be-used",
      SUPABASE_URL: "secret",
      SUPABASE_SERVICE_ROLE_KEY: "secret",
      FIT_TRACE_OPENCODE_MODEL: "secret",
      PI_FIT_TRACE_STORE: "/tmp/snapshot.json",
      OPENAI_API_KEY: "provider-ok",
    },
    spawn: (_binary, argv, opts) => {
      bridgeSeen = opts.bridge;
      const paths = buildOpenCodeIsolatedPaths(join(dir, "session"), RUN_ID);
      assert.equal(opts.env.HOME, paths.home);
      assert.equal(opts.env.SUPABASE_URL, undefined);
      assert.equal(opts.env.FIT_TRACE_OPENCODE_MODEL, undefined);
      assert.equal(opts.env.PI_FIT_TRACE_STORE, undefined);
      assert.equal(opts.env.OPENAI_API_KEY, "provider-ok");
      assert.notEqual(opts.env.OPENCODE_SERVER_PASSWORD, undefined);
      configSource = requireRead(paths.configFile);
      pluginSource = requireRead(paths.pluginFile);
      setTimeout(async () => {
        const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
          const response = await fetch(opts.bridge.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${opts.bridge.token}`,
            },
            body: JSON.stringify({ tool, arguments: args }),
          });
          return (await response.json()) as Record<string, unknown>;
        };
        const history = await call("get_training_history", { limit: 10 });
        assert.equal(history.ok, true);
        const analysis = await call("analyze_progress", {});
        assert.equal(analysis.ok, true);
        child.send({ type: "session.text.delta", sessionID: SESSION_ID, delta: "Looking at your history." });
        child.send({ type: "session.execution.succeeded", sessionID: SESSION_ID });
        child.emit("close", 0);
      }, 10);
      return child;
    },
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  assert.equal((c.done?.info as { nativeSessionHandle?: string }).nativeSessionHandle, SESSION_ID);
  assert.equal((c.done?.info as { processExitConfirmed?: boolean }).processExitConfirmed, true);
  assert.ok(c.events.some((event) => event.type === "text_delta"));
  const starts = c.events.filter((event) => event.type === "tool_start");
  assert.deepEqual(
    starts.map((event) => (event.type === "tool_start" ? event.tool : "")),
    ["get_training_history", "analyze_progress"],
  );
  const analysis = c.events.find((event) => event.type === "analysis_result");
  assert.ok(analysis?.type === "analysis_result");
  const raw = await loadFixture("valid-strength.json");
  assert.deepEqual(analysis.result, analyzeProgress([validateWorkoutRecord(raw).record], {}));
  assert.equal(c.events.at(-1)?.type, "terminal");
  assert.ok(bridgeSeen);
  assert.match(configSource, /"effect": "deny"/);
  assert.ok(!pluginSource.includes(file));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("opencode adapter: unknown tool event fails closed and withholds completion", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild();
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    spawn: () => {
      setTimeout(() => {
        child.send({ type: "session.tool.called", sessionID: SESSION_ID, tool: "bash" });
        child.emit("close", 0);
      }, 10);
      return child;
    },
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /non-allowlisted tool/);
  assert.ok(c.events.some((event) => event.type === "run_error" && event.code === "TOOL_REFUSED"));
  assert.ok(!c.events.some((event) => event.type === "analysis_result"));
  await rm(dir, { recursive: true, force: true });
});

test("opencode adapter: an interactive permission request fails closed", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild();
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    spawn: () => {
      setTimeout(() => {
        child.send({
          type: "permission.asked",
          sessionID: SESSION_ID,
          action: "bash",
          resources: ["*"],
        });
      }, 10);
      return child;
    },
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /permission/);
  assert.ok(child.killCalls.length > 0);
  await rm(dir, { recursive: true, force: true });
});

test("opencode adapter: exit without a validated analysis is a failure", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild();
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    spawn: () => {
      setTimeout(() => {
        child.send({ type: "session.text.delta", delta: "done", sessionID: SESSION_ID });
        child.emit("close", 0);
      }, 10);
      return child;
    },
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /without a validated analysis/);
  assert.ok(c.events.some((event) => event.type === "run_error" && event.code === "NO_ANALYSIS"));
  await rm(dir, { recursive: true, force: true });
});

test("opencode adapter: cancel terminates the child and confirms exit before cancellation", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild();
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    spawn: () => {
      setTimeout(() => proc.cancel("user cancel"), 10);
      return child;
    },
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "cancelled");
  assert.ok(child.killCalls.includes("SIGTERM"));
  assert.equal((c.done?.info as { processExitConfirmed?: boolean }).processExitConfirmed, true);
  assert.ok(c.events.some((event) => event.type === "run_error" && event.code === "CANCELLED"));
  await rm(dir, { recursive: true, force: true });
});

test("opencode adapter: same-backend session handle is passed to run --session", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild();
  let argvSeen: string[] = [];
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    resumeNativeSessionHandle: SESSION_ID,
    spawn: (_binary, argv) => {
      argvSeen = argv;
      setTimeout(() => {
        child.send({ type: "session.text.delta", delta: "resumed", sessionID: SESSION_ID });
        // This test only checks the resume argv; no analysis means failure.
        child.emit("close", 0);
      }, 10);
      return child;
    },
  });
  proc.start();
  await waitForDone(c);
  assert.ok(argvSeen.includes("--session"));
  assert.equal(argvSeen[argvSeen.indexOf("--session") + 1], SESSION_ID);
  assert.equal(c.done?.status, "failed");
  await rm(dir, { recursive: true, force: true });
});

const GOOD_EVIDENCE: OpenCodeIsolationEvidence = {
  version: "2.0.30",
  runFlags: ["--standalone", "--format"],
  model: "fixture/model",
  agentIds: [OPENCODE_COACH_AGENT],
  defaultAgent: OPENCODE_COACH_AGENT,
  pluginTools: ["get_training_history", "analyze_progress"],
  builtinTools: [],
  permissionRules: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "get_training_history", resource: "*", effect: "allow" },
    { action: "analyze_progress", resource: "*", effect: "allow" },
  ],
};

test("opencode capability requires version, exact tools, wildcard deny, and no extra agents", () => {
  const supported = inspectOpenCodeIsolation(GOOD_EVIDENCE);
  assert.equal(supported.supported, true);
  assert.equal(supported.isolationVerified, true);
  assert.equal(supported.version, "2.0.30");
  assert.equal(inspectOpenCodeIsolation({ ...GOOD_EVIDENCE, version: "v2.0.30" }).supported, true);

  const oldVersion = inspectOpenCodeIsolation({ ...GOOD_EVIDENCE, version: "1.9.9" });
  assert.equal(oldVersion.supported, false);
  assert.match(oldVersion.gap ?? "", /v2\.0\.30/);

  const broadAllow = inspectOpenCodeIsolation({
    ...GOOD_EVIDENCE,
    permissionRules: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "allow" },
      { action: "get_training_history", resource: "*", effect: "allow" },
      { action: "analyze_progress", resource: "*", effect: "allow" },
    ],
  });
  assert.equal(broadAllow.supported, false);
  assert.match(broadAllow.gap ?? "", /broader/);

  const builtins = inspectOpenCodeIsolation({ ...GOOD_EVIDENCE, builtinTools: ["bash"] });
  assert.equal(builtins.supported, false);
  assert.match(builtins.gap ?? "", /built-in/);

  const extraAgent = inspectOpenCodeIsolation({
    ...GOOD_EVIDENCE,
    agentIds: [OPENCODE_COACH_AGENT, "build"],
  });
  assert.equal(extraAgent.supported, false);
  assert.match(extraAgent.gap ?? "", /other OpenCode agents/);

  const extraTool = inspectOpenCodeIsolation({ ...GOOD_EVIDENCE, pluginTools: ["get_training_history"] });
  assert.equal(extraTool.supported, false);
  assert.match(extraTool.gap ?? "", /exactly the two/);

  const missingModel = inspectOpenCodeIsolation({ ...GOOD_EVIDENCE, model: "" });
  assert.equal(missingModel.supported, false);
  assert.match(missingModel.gap ?? "", /provider\/model/);
});

test("installed OpenCode probe is non-model and fails closed without isolation evidence", async (t) => {
  const result = await probeOpenCodeRun({
    binary: process.env.FIT_TRACE_OPENCODE_BIN ?? "opencode",
    model: "fixture/model",
    timeoutMs: 5000,
  });
  if (result.unavailable === true) {
    t.skip("OpenCode CLI is not installed on this machine");
    return;
  }
  assert.equal(result.supported, false);
  assert.equal(result.isolationVerified, false);
  assert.match(result.gap ?? "", /plugin-isolation-unproven|not a supported/);
});

test("opencode adapter cleanup removes the bridge and does not expose the snapshot", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild();
  let bridgeUrl = "";
  const proc = new CoachedOpenCodeRun({
    ...baseOptions(dir, file, c),
    spawn: (_binary, _argv, opts) => {
      bridgeUrl = opts.bridge.url;
      setTimeout(async () => {
        const response = await fetch(opts.bridge.url, {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
          body: JSON.stringify({ tool: "analyze_progress", arguments: {} }),
        });
        assert.equal(response.status, 401);
        child.emit("close", 0);
      }, 10);
      return child;
    },
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  await proc.close();
  await assert.rejects(fetch(bridgeUrl, { method: "POST", body: "{}" }));
  await rm(dir, { recursive: true, force: true });
});

function requireRead(file: string): string {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}
