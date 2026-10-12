import assert from "node:assert/strict";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { analyzeProgress, validateWorkoutRecord } from "@pi-fit-trace/core";
import { parseAnalysisResult } from "@pi-fit-trace/api-contracts";
import fitTraceExtension from "../.pi/extensions/fit-trace/index.ts";
import { JsonFileStorage, WorkoutStore } from "../.pi/extensions/fit-trace/store.ts";
import {
  CoachedPiProcess,
  COACHED_SYSTEM_PROMPT,
  buildCoachedArgv,
  buildCoachedEnv,
  mapPiEventToPayloads,
  wrapCoachedPrompt,
  type PiChildProcess,
} from "../server/coaching/piProcessAdapter.ts";
import {
  createRpcByteFramer,
  createRpcFrameSplitter,
  RpcFrameError,
} from "../server/coaching/rpcFraming.ts";
import {
  COACHED_ALLOWLIST,
  classifyCoachedToolEnd,
  classifyCoachedToolStart,
  classifyExtensionUiRequest,
  isCoachedToolAllowed,
  toSafeToolError,
} from "../server/coaching/coachedToolPolicy.ts";
import { cleanupSnapshotDir, writeSnapshotDir } from "../server/coaching/snapshotFile.ts";
import type { CoachingEventPayload, CoachingTerminalStatus } from "@pi-fit-trace/api-contracts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFixture } from "./helpers.ts";

// --- framing unit tests (LF-only, CRLF, split chunks, U+2028/U+2029) ---

test("framing splits only on LF and preserves U+2028/U+2029", () => {
  const splitter = createRpcFrameSplitter();
  const line = JSON.stringify({ text: "a b c" });
  const frames = splitter.push(`${line}\n`);
  assert.deepEqual(frames, [line]);
  assert.equal(JSON.parse(frames[0]).text, "a b c");
});

test("framing tolerates CRLF and split chunks", () => {
  const splitter = createRpcFrameSplitter();
  const a = splitter.push('{"a":1}\r');
  assert.deepEqual(a, []);
  const b = splitter.push('\n{"b"');
  assert.deepEqual(b, ['{"a":1}']);
  const c = splitter.push(':2}\n');
  assert.deepEqual(c, ['{"b":2}']);
  assert.equal(splitter.buffered(), "");
});

test("framing rejects an oversize frame without a delimiter", () => {
  const splitter = createRpcFrameSplitter({ maxBytes: 16 });
  assert.throws(() => splitter.push("x".repeat(17)), RpcFrameError);
});

test("framer cap is per frame: coalesced small frames succeed, one oversized line fails", () => {
  const splitter = createRpcFrameSplitter({ maxBytes: 16 });
  assert.deepEqual(splitter.push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  assert.throws(() => splitter.push(`${"y".repeat(17)}\n`), RpcFrameError);
});

test("byte framer reassembles UTF-8 split across chunks", () => {
  const framer = createRpcByteFramer();
  const bytes = Buffer.from(JSON.stringify({ text: "😀 ✓" }), "utf8");
  const results: string[] = [];
  // Feed byte-by-byte to force multibyte splits mid-character.
  for (const byte of bytes) {
    for (const frame of framer.push(Uint8Array.of(byte))) results.push(frame);
  }
  assert.equal(results.length, 0);
  for (const frame of framer.push("\n")) results.push(frame);
  assert.equal(results.length, 1);
  assert.equal(JSON.parse(results[0]).text, "😀 ✓");
});

// --- tool policy: real frames ---

test("coached allowlist is exactly the two read-only tools", () => {
  assert.deepEqual([...COACHED_ALLOWLIST], ["get_training_history", "analyze_progress"]);
  assert.ok(isCoachedToolAllowed("analyze_progress"));
  assert.ok(!isCoachedToolAllowed("generate_next_plan"));
  assert.ok(!isCoachedToolAllowed("import_workout"));
  assert.ok(!isCoachedToolAllowed("read"));
  assert.ok(!isCoachedToolAllowed("bash"));
});

test("unknown tools are refused at start: no tool_start is ever emitted", () => {
  const pending = new Map();
  for (const tool of ["generate_next_plan", "import_workout", "read", "write", "bash", "mystery"]) {
    const gate = classifyCoachedToolStart({ toolName: tool, toolCallId: "c1" });
    assert.equal(gate.allowed, false);
    const out = mapPiEventToPayloads(
      { type: "tool_execution_start", toolName: tool, toolCallId: "c1" },
      pending,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "run_error");
    assert.ok(!out.some((payload) => payload.type === "tool_start"));
  }
  assert.equal(pending.size, 0);
});

test("invented tool/callId/ok fields are ignored; real toolName/toolCallId/isError rule", () => {
  const pending = new Map();
  const out = mapPiEventToPayloads(
    // All invented fields; no toolName/toolCallId/isError/result.
    { type: "tool_execution_end", tool: "analyze_progress", callId: "c1", ok: true, success: true },
    pending,
  );
  // Unknown tool (no toolName) is refused, never completed.
  assert.ok(out.some((payload) => payload.type === "run_error"));
  assert.ok(!out.some((payload) => payload.type === "analysis_result"));
});

test("analyze details flow through parseAnalysisResult; missing/malformed details fail", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const good = classifyCoachedToolEnd({
    toolName: "analyze_progress",
    toolCallId: "c1",
    isError: false,
    result: { content: [{ type: "text", text: "done" }], details: analysis },
  });
  assert.equal(good.kind, "analysis_result");

  const missing = classifyCoachedToolEnd({
    toolName: "analyze_progress",
    toolCallId: "c2",
    isError: false,
    result: { content: [{ type: "text", text: "done" }] },
  });
  assert.equal(missing.kind, "tool_end");
  assert.equal((missing as { ok: boolean }).ok, false);

  const malformed = classifyCoachedToolEnd({
    toolName: "analyze_progress",
    toolCallId: "c3",
    isError: false,
    result: { content: [], details: { metrics: {} } },
  });
  assert.equal(malformed.kind, "tool_end");
  assert.equal((malformed as { ok: boolean }).ok, false);

  const errored = classifyCoachedToolEnd({
    toolName: "analyze_progress",
    toolCallId: "c4",
    isError: true,
    result: null,
    errorText: "boom",
  });
  assert.equal(errored.kind, "tool_end");
  assert.equal((errored as { ok: boolean }).ok, false);
});

test("toSafeToolError is a fixed safe fallback: never echoes raw text", () => {
  assert.equal(toSafeToolError("a".repeat(500), "fallback"), "fallback");
  assert.equal(toSafeToolError("line1\nline2\rline3", "fallback"), "fallback");
  assert.equal(toSafeToolError("", "fallback"), "fallback");
  assert.equal(toSafeToolError(undefined, "fallback"), "fallback");
  assert.equal(toSafeToolError(new Error("boom"), "fallback"), "fallback");
  assert.equal(toSafeToolError("api_key=DUMMY_SECRET", "failed"), "failed");
  assert.ok(!toSafeToolError("api_key=DUMMY_SECRET", "failed").includes("DUMMY_SECRET"));
});

test("malformed analyze details yield a fixed refusal, never echoed payload", () => {
  const secret = "sk-abc123def456ghi789";
  const malformed = classifyCoachedToolEnd({
    toolName: "analyze_progress",
    toolCallId: "c3",
    isError: false,
    result: { content: [], details: { metrics: {}, stolen: secret } },
  });
  assert.equal(malformed.kind, "tool_end");
  assert.equal((malformed as { ok: boolean }).ok, false);
  const error = (malformed as { error?: string }).error ?? "";
  assert.equal(
    error,
    "analyze_progress returned malformed details: refusing to treat it as a result",
  );
  assert.ok(!error.includes(secret));
});

test("extension UI dialogs are denied, fire-and-forget ignored", () => {
  for (const method of ["select", "confirm", "input", "editor", "weird"]) {
    assert.equal(classifyExtensionUiRequest(method).action, "deny");
  }
  assert.equal(classifyExtensionUiRequest("notify").action, "ignore");
  assert.equal(classifyExtensionUiRequest("setStatus").action, "ignore");
});

// --- command shape / env / path isolation ---

test("argv replaces the coding prompt, isolates resources, and pins the session dir", () => {
  const argv = buildCoachedArgv({ extensionPath: "/tmp/ext.ts", sessionDir: "/tmp/sess" });
  assert.ok(Array.isArray(argv));
  assert.deepEqual(argv.slice(0, 2), ["--mode", "rpc"]);
  const toolsIndex = argv.indexOf("--tools");
  assert.ok(toolsIndex >= 0);
  assert.equal(argv[toolsIndex + 1], "get_training_history,analyze_progress");
  assert.ok(argv.includes("--no-extensions"));
  assert.ok(argv.includes("-e"));
  assert.equal(argv[argv.indexOf("-e") + 1], "/tmp/ext.ts");
  assert.ok(argv.includes("--no-skills"));
  // Replacement prompt (the default coding-assistant prompt must not survive).
  assert.ok(!argv.includes("--append-system-prompt"));
  assert.ok(argv.includes("--system-prompt"));
  assert.equal(argv[argv.indexOf("--system-prompt") + 1], COACHED_SYSTEM_PROMPT);
  assert.ok(COACHED_SYSTEM_PROMPT.includes("get_training_history before analyze_progress"));
  // Resource isolation: no repo context files, prompt templates, or themes.
  assert.ok(argv.includes("--no-context-files"));
  assert.ok(argv.includes("--no-prompt-templates"));
  assert.ok(argv.includes("--no-themes"));
  assert.ok(argv.includes("--session-dir"));
  assert.ok(!argv.includes("--session"));
  const resumed = buildCoachedArgv({
    extensionPath: "/tmp/ext.ts",
    sessionDir: "/tmp/sess",
    resumeSessionFile: "/tmp/sess/prev.jsonl",
  });
  assert.equal(resumed[resumed.indexOf("--session") + 1], "/tmp/sess/prev.jsonl");
});

test("child env keeps only CLI model selection + provider creds, drops session PI_*", () => {
  const env = buildCoachedEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/u",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      ANTHROPIC_API_KEY: "provider-key",
      PI_MODEL: "openrouter/free",
      PI_PROVIDER: "openrouter",
      PI_BASE_URL: "https://openrouter.ai/api/v1",
      PI_SESSION_ID: "parent-session",
      PI_SESSION_FILE: "/tmp/parent.jsonl",
      PI_CODING_AGENT: "true",
      PI_FOO: "should-not-leak",
      PI_FIT_TRACE_STORE: "/user/default.json",
      RANDOM_UNRELATED: "x",
    } as NodeJS.ProcessEnv,
    "/tmp/run/snapshot.json",
  );
  assert.equal(env.PI_FIT_TRACE_STORE, "/tmp/run/snapshot.json");
  assert.equal(env.PI_FIT_TRACE_COACHED, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.ANTHROPIC_API_KEY, "provider-key");
  // Intended user CLI model/auth config is retained.
  assert.equal(env.PI_MODEL, "openrouter/free");
  assert.equal(env.PI_PROVIDER, "openrouter");
  assert.equal(env.PI_BASE_URL, "https://openrouter.ai/api/v1");
  // Session/extension/host PI_* state must not leak into the child.
  assert.ok(!("PI_SESSION_ID" in env));
  assert.ok(!("PI_SESSION_FILE" in env));
  assert.ok(!("PI_CODING_AGENT" in env));
  assert.ok(!("PI_FOO" in env));
  assert.ok(!("SUPABASE_URL" in env));
  assert.ok(!("SUPABASE_ANON_KEY" in env));
  assert.ok(!("SUPABASE_SERVICE_ROLE_KEY" in env));
  assert.ok(!("RANDOM_UNRELATED" in env));
});

test("slash/bang prompts are wrapped so they cannot invoke commands", () => {
  const wrapped = wrapCoachedPrompt("/mycommand do things");
  assert.ok(!wrapped.startsWith("/"));
  assert.ok(wrapped.includes("/mycommand do things"));
  assert.ok(wrapCoachedPrompt("!ls -la").includes("!ls -la"));
  assert.equal(wrapCoachedPrompt("analyze my bench trend"), "analyze my bench trend");
});

// --- reconciliation helpers ---

test("agent_end alone never yields a terminal payload", () => {
  const pending = new Map();
  assert.deepEqual(mapPiEventToPayloads({ type: "agent_end", willRetry: true }, pending), []);
  assert.deepEqual(
    mapPiEventToPayloads({ type: "agent_end", willRetry: false, messages: [] }, pending),
    [],
  );
});

test("agent_settled carries only type: no stopReason is read from it", () => {
  const pending = new Map();
  assert.deepEqual(mapPiEventToPayloads({ type: "agent_settled" }, pending), []);
  assert.deepEqual(
    mapPiEventToPayloads({ type: "agent_settled", stopReason: "error" }, pending),
    [],
  );
});

test("message_end/turn_end error/aborted stopReasons become run errors", () => {
  const pending = new Map();
  const aborted = mapPiEventToPayloads(
    { type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
    pending,
  );
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].type, "run_error");
  const errored = mapPiEventToPayloads(
    {
      type: "turn_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" },
      toolResults: [],
    },
    pending,
  );
  assert.equal(errored[0].type, "run_error");
  const toolError = mapPiEventToPayloads(
    {
      type: "turn_end",
      message: { role: "assistant", stopReason: "toolUse" },
      toolResults: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true }],
    },
    pending,
  );
  assert.equal(toolError[0].type, "run_error");
});

// --- real stdio process integration (real ChildProcess over pipes) ---

interface Collected {
  events: CoachingEventPayload[];
  done: { status: CoachingTerminalStatus; reason?: string; info?: unknown } | null;
}

function collect(): {
  events: CoachingEventPayload[];
  done: Collected["done"];
  onEvent(payload: CoachingEventPayload): void;
  onDone(status: CoachingTerminalStatus, reason?: string, info?: unknown): void;
} {
  const state: Collected = { events: [], done: null };
  return {
    get events(): CoachingEventPayload[] {
      return state.events;
    },
    get done(): Collected["done"] {
      return state.done;
    },
    onEvent(payload: CoachingEventPayload) {
      state.events.push(payload);
    },
    onDone(status: CoachingTerminalStatus, reason?: string, info?: unknown) {
      state.done = { status, reason, info };
    },
  };
}

interface Captured {
  binary?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  child?: ChildProcess;
}

/** Spawn a REAL OS process (real pipes/close semantics) running a fake pi script. */
function spawnReal(
  script: string,
  dir: string,
  captured: Captured,
  extraEnv?: NodeJS.ProcessEnv,
): (binary: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => PiChildProcess {
  return (binary, argv, opts) => {
    captured.binary = binary;
    captured.argv = argv;
    captured.env = opts.env;
    const child = nodeSpawn(process.execPath, ["-e", script], {
      cwd: opts.cwd,
      env: { ...opts.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    captured.child = child;
    return child as unknown as PiChildProcess;
  };
}

function waitForDone(c: { done: unknown }, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for done")), timeoutMs);
    const check = (): void => {
      if (c.done) {
        clearTimeout(timer);
        resolve();
      } else setTimeout(check, 25);
    };
    check();
  });
}

const FAKE_PRELUDE = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i = buf.indexOf("\\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\\n");
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function handle(req) {
  if (req.type === "get_state") {
    send({ type: "response", command: "get_state", id: req.id, success: true,
      data: { sessionFile: SESS_FILE } });
    return;
  }
  if (req.type !== "prompt") return;
  send({ type: "response", command: "prompt", id: req.id, success: true });
  onPrompt(req);
}
`;

function fakeScript(sessFile: string, onPrompt: string): string {
  return `const SESS_FILE = ${JSON.stringify(sessFile)};\n${FAKE_PRELUDE}\nfunction onPrompt(req) {\n${onPrompt}\n}\n`;
}

test("process integration: real tool result.details flow settles completed; snapshot unlinked", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const snapshotFile = join(dir, "snapshot.json");
  await writeFile(snapshotFile, "{}");
  const sessFile = join(dir, "sessions", "run.jsonl");
  const captured: Captured = {};
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile,
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile,
        `
        send({ type: "agent_end", willRetry: true, messages: [] });
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi there" } });
        send({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" });
        send({ type: "tool_execution_end", toolName: "analyze_progress", toolCallId: "c1",
          result: { content: [{ type: "text", text: "ok" }], details: JSON.parse(process.env.FAKE_DETAILS) },
          isError: false });
        send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        send({ type: "agent_settled" });
        `,
      ),
      dir,
      captured,
      { FAKE_DETAILS: JSON.stringify(analysis) },
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  assert.ok(c.events.some((e) => e.type === "analysis_result"));
  const result = c.events.find((e) => e.type === "analysis_result");
  assert.ok(result?.type === "analysis_result");
  parseAnalysisResult(result.result);
  const delta = c.events.find((e) => e.type === "text_delta");
  assert.ok(delta?.type === "text_delta" && delta.delta.includes(" "));
  // Real command shape/env/path isolation through the adapter.
  assert.equal(captured.binary, "pi");
  assert.ok(captured.argv?.includes("--mode") && captured.argv?.includes("rpc"));
  assert.equal(captured.env?.PI_FIT_TRACE_STORE, snapshotFile);
  assert.equal(captured.env?.PI_FIT_TRACE_COACHED, "1");
  assert.ok(!("SUPABASE_URL" in (captured.env ?? {})));
  // Snapshot file cleaned up after the child exited; run dir itself remains for the owner.
  await assert.rejects(readFile(snapshotFile, "utf8"));
  assert.equal((c.done?.info as { sessionFile?: string } | undefined)?.sessionFile, sessFile);
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("process integration: agent_end alone never completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const captured: Captured = {};
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(sessFile(dir), `send({ type: "agent_end", willRetry: false, messages: [] });`),
      dir,
      captured,
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.done, null);
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

function sessFile(dir: string): string {
  return join(dir, "sessions", "run.jsonl");
}

test("process integration: prompt rejection fails fast", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      `${FAKE_PRELUDE}\nfunction onPrompt(req) {
        send({ type: "response", command: "prompt", id: req.id, success: false, error: "busy" });
      }\nconst SESS_FILE = ${JSON.stringify(sessFile(dir))};`,
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.equal(c.done?.reason, "prompt rejected");
  assert.ok(!JSON.stringify(c.events).includes("busy"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("secret literals never surface in assistant/auto-retry/prompt/process errors", async () => {
  // Pure mapping: assistant errorMessage with a credential literal.
  const assistantOut = mapPiEventToPayloads(
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "api_key=DUMMY_SECRET" } },
    new Map(),
  );
  assert.ok(assistantOut.length === 1 && assistantOut[0].type === "run_error");
  assert.ok(!JSON.stringify(assistantOut).includes("DUMMY_SECRET"));
  // Pure mapping: auto_retry finalError with a credential literal.
  const retryOut = mapPiEventToPayloads(
    { type: "auto_retry_end", success: false, finalError: "token DUMMY_SECRET" },
    new Map(),
  );
  assert.ok(retryOut.length === 1 && retryOut[0].type === "run_error");
  assert.equal((retryOut[0] as { message?: string }).message, "auto-retry exhausted");
  assert.ok(!JSON.stringify(retryOut).includes("DUMMY_SECRET"));
  // Prompt rejection carrying a secret: run fails with a fixed reason.
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      `${FAKE_PRELUDE}\nfunction onPrompt(req) {
        send({ type: "response", command: "prompt", id: req.id, success: false, error: "api_key=DUMMY_SECRET" });
      }\nconst SESS_FILE = ${JSON.stringify(sessFile(dir))};`,
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.equal(c.done?.reason, "prompt rejected");
  assert.ok(!JSON.stringify(c.events).includes("DUMMY_SECRET"));
  assert.ok(!(c.done?.reason ?? "").includes("DUMMY_SECRET"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("process error text never surfaces raw provider text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const faulty = makeKillRefusingChild();
  const erroringChild: PiChildProcess = {
    ...faulty.child,
    kill: (): boolean => false,
    on: ((event: string, listener: (...args: never[]) => void): unknown => {
      if (event === "error") {
        (listener as (e: unknown) => void)(new Error("connect api_key=DUMMY_SECRET"));
      }
      return {};
    }) as PiChildProcess["on"],
  };
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 60000,
    spawn: () => erroringChild,
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(!JSON.stringify(c.events).includes("DUMMY_SECRET"));
  assert.ok(!(c.done?.reason ?? "").includes("DUMMY_SECRET"));
  await assert.rejects(proc.close(), /did not exit/);
  await rm(dir, { recursive: true, force: true });
});

test("process integration: aborted/error stopReasons fail the run at settle", async () => {
  for (const stopReason of ["aborted", "error"]) {
    const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
    const c = collect();
    const proc = new CoachedPiProcess({
      sessionId: "s1",
      runId: "r1",
      prompt: "x",
      snapshotFile: join(dir, "snapshot.json"),
      snapshotDir: dir,
      sessionDir: join(dir, "sessions"),
      extensionPath: "/tmp/ext.ts",
      cwd: dir,
      runTimeoutMs: 8000,
      spawn: spawnReal(
        fakeScript(
          sessFile(dir),
          `send({ type: "message_end", message: { role: "assistant", stopReason: ${JSON.stringify(stopReason)} } });
           send({ type: "agent_settled" });`,
        ),
        dir,
        {},
      ),
      onEvent: (p) => c.onEvent(p),
      onDone: (s, r) => c.onDone(s, r),
    });
    proc.start();
    await waitForDone(c);
    assert.equal(c.done?.status, "failed", `stopReason ${stopReason} must fail`);
    await proc.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("process integration: pending tools at settle fail the run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile(dir),
        `send({ type: "tool_execution_start", toolName: "get_training_history", toolCallId: "c1" });
         send({ type: "agent_settled" });`,
      ),
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.done?.reason?.includes("pending"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("process integration: disallowed tools refused with no tool_start, run fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile(dir),
        `send({ type: "tool_execution_start", toolName: "generate_next_plan", toolCallId: "c9" });
         send({ type: "tool_execution_end", toolName: "generate_next_plan", toolCallId: "c9",
           result: { content: [], details: {} }, isError: false });
         send({ type: "agent_settled" });`,
      ),
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(!c.events.some((e) => e.type === "tool_start"));
  assert.ok(c.events.some((e) => e.type === "run_error"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("process integration: invalid JSON frame fails the run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(sessFile(dir), `process.stdout.write("this is not json{{{\\n");`),
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.events.some((e) => e.type === "run_error" && e.message.includes("invalid JSON")));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("process integration: confirm dialogs are denied, unblocked, and fail the run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const cmdsLog = join(dir, "cmds.log");
  await writeFile(cmdsLog, "");
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      `
let buf = ""; // confirm-denial probe
const fs = require("fs");
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i = buf.indexOf("\\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\\n");
    if (!line.trim()) continue;
    fs.appendFileSync(${JSON.stringify(cmdsLog)}, line + "\\n");
    const req = JSON.parse(line);
    if (req.type === "get_state") {
      process.stdout.write(JSON.stringify({ type: "response", command: "get_state", id: req.id,
        success: true, data: { sessionFile: "sess" } }) + "\\n");
    } else if (req.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "u1", method: "confirm",
        title: "Approve?", message: "rm -rf" }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      }, 100);
    }
  }
});
      `,
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.events.some((e) => e.type === "run_error" && e.code === "EXTENSION_UI_REFUSED"));
  const log = await readFile(cmdsLog, "utf8");
  const denial = log.split("\n").find((line) => line.includes("extension_ui_response"));
  assert.ok(denial !== undefined, `expected denial response in ${JSON.stringify(log)}`);
  assert.ok(denial.includes('"cancelled":true'));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("cancel completes only after process exit (no early done, no orphans)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const cmdsLog = join(dir, "cmds.log");
  await writeFile(cmdsLog, "");
  const captured: Captured = {};
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    graceMs: 300,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      `
let buf = "";
const fs = require("fs");
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i = buf.indexOf("\\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\\n");
    if (!line.trim()) continue;
    fs.appendFileSync(${JSON.stringify(cmdsLog)}, line + "\\n");
  }
});
process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true }) + "\\n");
setInterval(() => {}, 1000);
      `,
      dir,
      captured,
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await new Promise((r) => setTimeout(r, 200));
  proc.cancel("user asked");
  await new Promise((r) => setTimeout(r, 100));
  const earlyDone: Collected["done"] = c.done;
  assert.ok(earlyDone === null, "cancel must not complete before process exit");
  await waitForDone(c);
  assert.equal(c.done?.status, "cancelled");
  const log = await readFile(cmdsLog, "utf8");
  assert.ok(log.includes("clear_queue"), `expected clear_queue in ${JSON.stringify(log)}`);
  assert.ok(log.includes("abort"), `expected abort in ${JSON.stringify(log)}`);
  assert.ok(captured.child?.exitCode !== null || captured.child?.killed === true);
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("hanging process hits the run timeout and is reaped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const captured: Captured = {};
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 250,
    spawn: spawnReal(`setInterval(() => {}, 1000);`, dir, captured),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.done?.reason?.includes("timed out"));
  assert.ok(captured.child?.exitCode !== null || captured.child?.killed === true);
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("resume passes native --session and captures the session file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const prev = join(dir, "sessions", "prev.jsonl");
  const next = join(dir, "sessions", "next.jsonl");
  const captured: Captured = {};
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "continue analysis",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    resumeSessionFile: prev,
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        next,
        `send({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" });
         send({ type: "tool_execution_end", toolName: "analyze_progress", toolCallId: "c1",
           result: { content: [{ type: "text", text: "ok" }], details: JSON.parse(process.env.FAKE_DETAILS) },
           isError: false });
         send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
         send({ type: "agent_settled" });`,
      ),
      dir,
      captured,
      { FAKE_DETAILS: JSON.stringify(analysis) },
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  assert.ok(captured.argv?.includes("--session"));
  assert.equal(captured.argv?.[captured.argv.indexOf("--session") + 1], prev);
  assert.equal((c.done?.info as { sessionFile?: string } | undefined)?.sessionFile, next);
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

// --- snapshot isolation: validated store file, 0600, no secrets ---

test("snapshots are validated store files with 0600 mode, isolated per run", async () => {
  const raw = await loadFixture("valid-strength.json");
  const a = await writeSnapshotDir([raw]);
  const b = await writeSnapshotDir([raw]);
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.snapshotFile, b.snapshotFile);
  for (const snap of [a, b]) {
    const parsed = JSON.parse(await readFile(snap.snapshotFile, "utf8"));
    assert.ok(typeof parsed.schema_version === "number");
    assert.ok(Array.isArray(parsed.records));
    assert.equal(parsed.records.length, 1);
    const store = new WorkoutStore(new JsonFileStorage(snap.snapshotFile));
    assert.equal((await store.all()).length, 1);
    const mode = (await stat(snap.snapshotFile)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  await cleanupSnapshotDir(a.dir);
  await cleanupSnapshotDir(b.dir);
  await assert.rejects(readFile(a.snapshotFile, "utf8"));
});

test("snapshots drop unknown keys by construction and reject invalid records", async () => {
  const raw = await loadFixture<Record<string, unknown>>("valid-strength.json");
  const snap = await writeSnapshotDir([
    { ...raw, api_key: "sekret", nested: { service_role_key: "sekret" } },
  ]);
  try {
    const text = await readFile(snap.snapshotFile, "utf8");
    assert.ok(!text.includes("api_key"));
    assert.ok(!text.includes("service_role_key"));
    assert.ok(!text.includes("sekret"));
    const parsed = JSON.parse(text) as { records: Array<Record<string, unknown>> };
    assert.equal(parsed.records.length, 1);
    assert.ok(!("api_key" in parsed.records[0]));
    assert.ok(!("nested" in parsed.records[0]));
    const store = new WorkoutStore(new JsonFileStorage(snap.snapshotFile));
    assert.equal((await store.all()).length, 1);
  } finally {
    await cleanupSnapshotDir(snap.dir);
  }
  await assert.rejects(writeSnapshotDir([{ id: "bad" }]));
  await assert.rejects(writeSnapshotDir([{ ...raw, date: "not-a-date" }]));
});

// --- extension seam: standalone=4 tools, coached=2 tools, real execution ---

type AnyTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

function registerAll(): Map<string, AnyTool> {
  const tools = new Map<string, AnyTool>();
  const pi = { registerTool: (def: AnyTool) => void tools.set(def.name, def) } as unknown as ExtensionAPI;
  fitTraceExtension(pi);
  return tools;
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("standalone extension registers all four tools", () => {
  const tools = registerAll();
  assert.deepEqual(
    [...tools.keys()].sort(),
    ["analyze_progress", "generate_next_plan", "get_training_history", "import_workout"],
  );
});

test("coached mode registers only the two read-only tools and executes over the snapshot", async () => {
  const raw = await loadFixture("valid-strength.json");
  const snap = await writeSnapshotDir([raw]);
  try {
    await withEnv(
      { PI_FIT_TRACE_COACHED: "1", PI_FIT_TRACE_STORE: snap.snapshotFile },
      async () => {
        const tools = registerAll();
        assert.deepEqual([...tools.keys()].sort(), ["analyze_progress", "get_training_history"]);
        const analyze = tools.get("analyze_progress");
        assert.ok(analyze !== undefined);
        const out = await analyze.execute("c1", {}, undefined, undefined, { cwd: snap.dir });
        parseAnalysisResult(out.details);
      },
    );
  } finally {
    await cleanupSnapshotDir(snap.dir);
  }
});

test("coached mode never falls back to the default store", async () => {
  await withEnv({ PI_FIT_TRACE_COACHED: "1", PI_FIT_TRACE_STORE: undefined }, async () => {
    const tools = registerAll();
    const history = tools.get("get_training_history");
    assert.ok(history !== undefined);
    await assert.rejects(
      history.execute("c1", {}, undefined, undefined, { cwd: tmpdir() }),
      /COACHED_STORE_MISSING/,
    );
  });
});

// --- updated contracts: lifecycle races, correlation, isolation ---

test("stderr is drained and discarded: secrets on stderr never surface", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const sessFile = join(dir, "sessions", "run.jsonl");
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile,
        `
        process.stderr.write("leak api_key=sk-abc123def456ghi789 token hunter2\\n");
        send({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" });
        send({ type: "tool_execution_end", toolName: "analyze_progress", toolCallId: "c1",
          result: { content: [{ type: "text", text: "ok" }], details: JSON.parse(process.env.FAKE_DETAILS) },
          isError: false });
        send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        send({ type: "agent_settled" });
        `,
      ),
      dir,
      {},
      { FAKE_DETAILS: JSON.stringify(analysis) },
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  assert.ok(!JSON.stringify(c.events).includes("sk-abc123def456ghi789"));
  assert.ok(!JSON.stringify(c.events).includes("hunter2"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("no get_state at startup; one correlated get_state after settle", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const sessFile = join(dir, "sessions", "run.jsonl");
  const cmdsLog = join(dir, "cmds.log");
  await writeFile(cmdsLog, "");
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      `
const fs = require("fs");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i = buf.indexOf("\\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\\n");
    if (!line.trim()) continue;
    fs.appendFileSync(${JSON.stringify(cmdsLog)}, line + "\\n");
    const req = JSON.parse(line);
    if (req.type === "get_state") {
      process.stdout.write(JSON.stringify({ type: "response", command: "get_state", id: req.id,
        success: true, data: { sessionFile: ${JSON.stringify(sessFile)} } }) + "\\n");
      return;
    }
    if (req.type !== "prompt") return;
    process.stdout.write(JSON.stringify({ type: "response", command: "prompt", id: req.id, success: true }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName: "analyze_progress", toolCallId: "c1",
      result: { content: [{ type: "text", text: "ok" }], details: JSON.parse(process.env.FAKE_DETAILS) },
      isError: false }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
      `,
      dir,
      {},
      { FAKE_DETAILS: JSON.stringify(analysis) },
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  const lines = (await readFile(cmdsLog, "utf8"))
    .split("\n")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  assert.ok(lines.length >= 2);
  assert.equal(lines[0].type, "prompt");
  assert.ok(!lines.slice(0, 1).some((entry) => entry.type === "get_state"));
  const states = lines.filter((entry) => entry.type === "get_state");
  assert.equal(states.length, 1);
  assert.equal(states[0].id, "req-state-settle");
  assert.equal((c.done?.info as { sessionFile?: string } | undefined)?.sessionFile, sessFile);
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("cancel during grace beats a racing settle: cancelled wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    graceMs: 500,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i = buf.indexOf("\\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === "abort") {
      // Settle races in during the abort grace period; cancel must still win.
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true }) + "\\n");
setInterval(() => {}, 1000);
      `,
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await new Promise((r) => setTimeout(r, 200));
  proc.cancel("user asked");
  await waitForDone(c);
  assert.equal(c.done?.status, "cancelled");
  assert.equal(c.done?.reason, "user asked");
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("transient assistant error recovers via retry and settles completed", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile(dir),
        `
        send({ type: "agent_end", willRetry: true,
          messages: [{ role: "assistant", stopReason: "error", errorMessage: "overloaded" }] });
        send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        send({ type: "auto_retry_end", success: true });
        send({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" });
        send({ type: "tool_execution_end", toolName: "analyze_progress", toolCallId: "c1",
          result: { content: [{ type: "text", text: "ok" }], details: JSON.parse(process.env.FAKE_DETAILS) },
          isError: false });
        send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        send({ type: "agent_settled" });
        `,
      ),
      dir,
      {},
      { FAKE_DETAILS: JSON.stringify(analysis) },
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  assert.ok(c.events.some((e) => e.type === "run_error" && e.code === "AGENT_STOPPED"));
  assert.ok(c.events.some((e) => e.type === "analysis_result"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("tool refusal stays fatal even when a later valid analysis arrives", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile(dir),
        `send({ type: "tool_execution_start", toolName: "bash", toolCallId: "evil" });
         send({ type: "tool_execution_end", toolName: "bash", toolCallId: "evil",
           result: { content: [], details: {} }, isError: false });
         send({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" });
         send({ type: "tool_execution_end", toolName: "analyze_progress", toolCallId: "c1",
           result: { content: [{ type: "text", text: "ok" }], details: JSON.parse(process.env.FAKE_DETAILS) },
           isError: false });
         send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
         send({ type: "agent_settled" });`,
      ),
      dir,
      {},
      { FAKE_DETAILS: JSON.stringify(analysis) },
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.events.some((e) => e.type === "run_error" && e.code === "TOOL_REFUSED"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("settle without a validated analysis fails with NO_ANALYSIS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile(dir),
        `send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
         send({ type: "agent_settled" });`,
      ),
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.done?.reason?.includes("without a validated analysis"));
  assert.ok(c.events.some((e) => e.type === "run_error" && e.code === "NO_ANALYSIS"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("sessionFile outside the session dir is dropped, run still completes", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        join(tmpdir(), "evil-outside.jsonl"),
        `send({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" });
         send({ type: "tool_execution_end", toolName: "analyze_progress", toolCallId: "c1",
           result: { content: [{ type: "text", text: "ok" }], details: JSON.parse(process.env.FAKE_DETAILS) },
           isError: false });
         send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
         send({ type: "agent_settled" });`,
      ),
      dir,
      {},
      { FAKE_DETAILS: JSON.stringify(analysis) },
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  assert.equal((c.done?.info as { sessionFile?: string } | undefined)?.sessionFile, undefined);
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("secret literals never appear in emitted payloads for bad frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    spawn: spawnReal(
      fakeScript(
        sessFile(dir),
        `process.stdout.write("{\\"steal\\":\\"sk-abc123def456ghi789\\"\\n");`,
      ),
      dir,
      {},
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r) => c.onDone(s, r),
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.ok(!JSON.stringify(c.events).includes("sk-abc123def456ghi789"));
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("close() is a Promise: awaits exit, cleans the snapshot, never calls onDone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const snapshotFile = join(dir, "snapshot.json");
  await writeFile(snapshotFile, "{}");
  const c = collect();
  let doneCalls = 0;
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile,
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 30000,
    spawn: spawnReal(`setInterval(() => {}, 1000);`, dir, {}),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => {
      doneCalls += 1;
      c.onDone(s, r, info);
    },
  });
  proc.start();
  await new Promise((r) => setTimeout(r, 200));
  await proc.close();
  assert.equal(doneCalls, 0);
  assert.ok(c.done === null);
  await assert.rejects(readFile(snapshotFile, "utf8"));
  await proc.close();
  // Closing must win over the racing close event: onDone stays silent.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(doneCalls, 0);
  assert.ok(c.done === null);
  const mode = await stat(dir).then((s) => s.isDirectory());
  assert.equal(mode, true);
  await rm(dir, { recursive: true, force: true });
});

// --- review-2c gap 1: actual startup argv + env + startup behavior ---

test("startup argv/env on the real spawn path: replacement prompt, isolation, exact tools, sanitized env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const cmdsLog = join(dir, "cmds.log");
  await writeFile(cmdsLog, "");
  const captured: Captured = {};
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze my trend",
    snapshotFile: join(dir, "snapshot.json"),
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 8000,
    env: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      PI_MODEL: "openrouter/free",
      PI_PROVIDER: "openrouter",
      PI_SESSION_ID: "parent-session",
      PI_CODING_AGENT: "true",
      PI_SNEAKY: "nope",
      ANTHROPIC_API_KEY: "provider-key",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      RANDOM_UNRELATED: "x",
    } as NodeJS.ProcessEnv,
    spawn: spawnReal(
      `
const fs = require("fs");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i = buf.indexOf("\\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\\n");
    if (!line.trim()) continue;
    fs.appendFileSync(${JSON.stringify(cmdsLog)}, line + "\\n");
    const req = JSON.parse(line);
    if (req.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", command: "prompt", id: req.id, success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    } else if (req.type === "get_state") {
      process.stdout.write(JSON.stringify({ type: "response", command: "get_state", id: req.id,
        success: true, data: { sessionFile: ${JSON.stringify(sessFile(dir))} } }) + "\\n");
    }
  }
});
      `,
      dir,
      captured,
    ),
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  await waitForDone(c);
  // Actual argv: replacement system prompt + isolation flags + exact tools.
  assert.ok(captured.argv?.includes("--system-prompt"));
  assert.equal(captured.argv?.[captured.argv.indexOf("--system-prompt") + 1], COACHED_SYSTEM_PROMPT);
  assert.ok(!captured.argv?.includes("--append-system-prompt"));
  assert.ok(captured.argv?.includes("--no-context-files"));
  assert.ok(captured.argv?.includes("--no-prompt-templates"));
  assert.ok(captured.argv?.includes("--no-themes"));
  assert.ok(captured.argv?.includes("--no-skills"));
  assert.equal(
    captured.argv?.[captured.argv.indexOf("--tools") + 1],
    "get_training_history,analyze_progress",
  );
  // Actual env: CLI model config kept, session PI_* and secrets dropped.
  assert.equal(captured.env?.PI_MODEL, "openrouter/free");
  assert.equal(captured.env?.PI_PROVIDER, "openrouter");
  assert.equal(captured.env?.ANTHROPIC_API_KEY, "provider-key");
  assert.ok(!("PI_SESSION_ID" in (captured.env ?? {})));
  assert.ok(!("PI_CODING_AGENT" in (captured.env ?? {})));
  assert.ok(!("PI_SNEAKY" in (captured.env ?? {})));
  assert.ok(!("SUPABASE_SERVICE_ROLE_KEY" in (captured.env ?? {})));
  assert.ok(!("RANDOM_UNRELATED" in (captured.env ?? {})));
  // Startup behavior: only the prompt travels first; analysis instructions
  // are on the command line (active tools = the --tools allowlist, enforced
  // startup-side by the extension's coached tool probe).
  const lines = (await readFile(cmdsLog, "utf8"))
    .split("\n")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  assert.ok(lines.length >= 1);
  assert.equal(lines[0].type, "prompt");
  assert.equal(lines[0].message, "analyze my trend");
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

// --- review-2c gap 2: exit confirmation + shared disposal ---

/** Injected child that refuses to die: kill() is a no-op, `close` never fires. */
function makeKillRefusingChild(): {
  child: PiChildProcess;
  writes: string[];
  emitStdout: (text: string) => void;
} {
  const writes: string[] = [];
  const stdoutData: Array<(chunk: unknown) => void> = [];
  const noop = (): void => {};
  const child: PiChildProcess = {
    stdin: {
      write: (chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
      end: noop,
      on: noop as (...args: never[]) => unknown,
      removeListener: noop as (...args: never[]) => unknown,
    },
    stdout: {
      on: (event: string, listener: (...args: never[]) => void): unknown => {
        if (event === "data") stdoutData.push(listener as (chunk: unknown) => void);
        return {};
      },
      removeListener: (event: string, listener: (...args: never[]) => void): unknown => {
        if (event === "data") {
          const index = stdoutData.indexOf(listener as (chunk: unknown) => void);
          if (index >= 0) stdoutData.splice(index, 1);
        }
        return {};
      },
    },
    stderr: {
      on: noop as (...args: never[]) => unknown,
      removeListener: noop as (...args: never[]) => unknown,
    },
    once: noop as (...args: never[]) => unknown,
    on: noop as (...args: never[]) => unknown,
    removeListener: noop as (...args: never[]) => unknown,
    kill: (): boolean => false,
  };
  return {
    child,
    writes,
    emitStdout: (text: string): void => {
      const chunk = Buffer.from(text, "utf8");
      for (const fn of [...stdoutData]) fn(chunk);
    },
  };
}

/** Manually-fired timers so exit-confirmation timeouts are deterministic. */
function manualClock(): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  fireAll: () => Promise<void>;
} {
  const pending = new Map<unknown, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void): unknown => {
      const handle = next++;
      pending.set(handle, fn);
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle);
    },
    fireAll: async (): Promise<void> => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

async function driveSettledRun(
  emitStdout: (text: string) => void,
  analysis: unknown,
  sessionDir: string,
): Promise<void> {
  const frame = (o: unknown): void => emitStdout(`${JSON.stringify(o)}\n`);
  frame({ type: "tool_execution_start", toolName: "get_training_history", toolCallId: "h1" });
  frame({
    type: "tool_execution_end",
    toolName: "get_training_history",
    toolCallId: "h1",
    result: { content: [{ type: "text", text: "1 record" }], details: { records: [], total: 0 } },
    isError: false,
  });
  frame({ type: "tool_execution_start", toolName: "analyze_progress", toolCallId: "c1" });
  frame({
    type: "tool_execution_end",
    toolName: "analyze_progress",
    toolCallId: "c1",
    result: { content: [{ type: "text", text: "ok" }], details: analysis },
    isError: false,
  });
  frame({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  frame({ type: "agent_settled" });
  // Answer the post-settle correlated get_state with an in-dir session file.
  frame({
    type: "response",
    command: "get_state",
    id: "req-state-settle",
    success: true,
    data: { sessionFile: join(sessionDir, "run.jsonl") },
  });
}

test("kill-refusing child: success never reported while alive, snapshot retained", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const snapshotFile = join(dir, "snapshot.json");
  await writeFile(snapshotFile, "{}");
  const sessionDir = join(dir, "sessions");
  const { child, emitStdout } = makeKillRefusingChild();
  const clock = manualClock();
  const c = collect();
  let doneCalls = 0;
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile,
    snapshotDir: dir,
    sessionDir,
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 60000,
    spawn: () => child,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => {
      doneCalls += 1;
      c.onDone(s, r, info);
    },
  });
  proc.start();
  await driveSettledRun(emitStdout, analysis, sessionDir);
  // Run the disposal wait past its bound: exit stays unconfirmed.
  await clock.fireAll();
  await clock.fireAll();
  await clock.fireAll();
  assert.equal(doneCalls, 1);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.done?.reason?.includes("exit unconfirmed"));
  assert.equal((c.done?.info as { processExitConfirmed?: boolean } | undefined)?.processExitConfirmed, false);
  assert.ok(
    !c.events.some((e) => e.type === "terminal" && (e as { status?: string }).status === "completed"),
    "completed must never be reported while the child is alive",
  );
  // Active data is retained for the live child.
  assert.equal(await readFile(snapshotFile, "utf8"), "{}");
  await rm(dir, { recursive: true, force: true });
});

test("close() on a live kill-refusing child rejects without deleting active data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const snapshotFile = join(dir, "snapshot.json");
  await writeFile(snapshotFile, "{}");
  const { child } = makeKillRefusingChild();
  const clock = manualClock();
  const c = collect();
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile,
    snapshotDir: dir,
    sessionDir: join(dir, "sessions"),
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 60000,
    spawn: () => child,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => c.onDone(s, r, info),
  });
  proc.start();
  const closing = proc.close();
  // Attach the rejection expectation before firing timers so the rejection
  // is never unhandled (node:test attributes late-handled rejections).
  const rejected = assert.rejects(closing, /did not exit/);
  await clock.fireAll();
  await clock.fireAll();
  await rejected;
  assert.equal(c.done, null);
  assert.equal(await readFile(snapshotFile, "utf8"), "{}");
  await rm(dir, { recursive: true, force: true });
});

test("close() while finish() is in progress awaits the same disposal, no duplicates", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const snapshotFile = join(dir, "snapshot.json");
  await writeFile(snapshotFile, "{}");
  const sessionDir = join(dir, "sessions");
  const { child, emitStdout } = makeKillRefusingChild();
  const clock = manualClock();
  const c = collect();
  let doneCalls = 0;
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile,
    snapshotDir: dir,
    sessionDir,
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 60000,
    spawn: () => child,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => {
      doneCalls += 1;
      c.onDone(s, r, info);
    },
  });
  proc.start();
  await driveSettledRun(emitStdout, analysis, sessionDir);
  // finish() is now awaiting exit confirmation; close() must join the shared
  // disposal and reject when exit stays unconfirmed (failed cleanup visible).
  const closing = proc.close();
  const rejected = assert.rejects(closing, /did not exit/);
  await clock.fireAll();
  await clock.fireAll();
  await clock.fireAll();
  await rejected;
  assert.equal(doneCalls, 1);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.done?.reason?.includes("exit unconfirmed"));
  assert.equal((c.done?.info as { processExitConfirmed?: boolean } | undefined)?.processExitConfirmed, false);
  assert.equal(await readFile(snapshotFile, "utf8"), "{}");
  await rm(dir, { recursive: true, force: true });
});

test("failed finish then close(): close rejects, no false success, snapshot retained", async () => {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const analysis = analyzeProgress([record], {});
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const snapshotFile = join(dir, "snapshot.json");
  await writeFile(snapshotFile, "{}");
  const sessionDir = join(dir, "sessions");
  const { child, emitStdout } = makeKillRefusingChild();
  const clock = manualClock();
  const c = collect();
  let doneCalls = 0;
  const proc = new CoachedPiProcess({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze",
    snapshotFile,
    snapshotDir: dir,
    sessionDir,
    extensionPath: "/tmp/ext.ts",
    cwd: dir,
    runTimeoutMs: 60000,
    spawn: () => child,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (p) => c.onEvent(p),
    onDone: (s, r, info) => {
      doneCalls += 1;
      c.onDone(s, r, info);
    },
  });
  proc.start();
  await driveSettledRun(emitStdout, analysis, sessionDir);
  await clock.fireAll();
  await clock.fireAll();
  await clock.fireAll();
  // finish() settled first: failed with exit unconfirmed, never completed.
  assert.equal(doneCalls, 1);
  assert.equal(c.done?.status, "failed");
  assert.ok(c.done?.reason?.includes("exit unconfirmed"));
  assert.equal((c.done?.info as { processExitConfirmed?: boolean } | undefined)?.processExitConfirmed, false);
  assert.ok(
    !c.events.some((e) => e.type === "terminal" && (e as { status?: string }).status === "completed"),
    "completed must never be reported while the child is alive",
  );
  // A later close() on the still-live child must reject (shared disposal is
  // false) and must not delete active data or emit a second terminal.
  await assert.rejects(proc.close(), /did not exit/);
  assert.equal(doneCalls, 1);
  assert.equal(await readFile(snapshotFile, "utf8"), "{}");
  await rm(dir, { recursive: true, force: true });
});
