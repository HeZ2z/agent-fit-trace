import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { CoachingEventPayload, CoachingTerminalStatus } from "@agent-fit-trace/api-contracts";
import {
  CoachedCodexAppServer,
  buildCoachedCodexArgv,
  buildCoachedCodexEnv,
  COACHED_SYSTEM_PROMPT,
  isSafeCodexThreadId,
  type CodexChildProcess,
} from "../server/coaching/codexAppServerAdapter.ts";
import { inspectCodexAppServerSchema } from "../server/coaching/codexAppServerCapability.ts";
import { loadFixture } from "./helpers.ts";

type Done = { status: CoachingTerminalStatus; reason?: string; info?: unknown };

function collect(): {
  events: CoachingEventPayload[];
  done: Done | null;
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

interface FakeChild extends CodexChildProcess {
  sent: Record<string, unknown>[];
  send(message: unknown): void;
  emit(event: string, ...args: unknown[]): boolean;
  killCalls: string[];
  readonly killedNow: boolean;
}

type MessageHandler = (message: Record<string, unknown>, child: FakeChild) => void;

function fakeChild(onWrite: MessageHandler): FakeChild {
  const child = new EventEmitter() as EventEmitter & FakeChild;
  const stdin = new EventEmitter() as EventEmitter & FakeChild["stdin"];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let buffer = "";
  const sent: Record<string, unknown>[] = [];
  const killCalls: string[] = [];
  let killed = false;
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    sent,
    killCalls,
    get killedNow(): boolean {
      return killed;
    },
  });
  Object.assign(stdin, {
    write(chunk: string | Uint8Array): boolean {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        sent.push(message);
        onWrite(message, child);
      }
      return true;
    },
    end(): void {
      // no-op
    },
  });
  Object.assign(child, {
    send(message: unknown): void {
      stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
    },
    kill(signal?: string | number): boolean {
      killCalls.push(String(signal ?? "SIGTERM"));
      if (killed) return true;
      killed = true;
      // Real processes emit close asynchronously after a kill.
      setImmediate(() => child.emit("close", 0));
      return true;
    },
  });
  return child as FakeChild;
}

const THREAD_ID = "thr_abc123";
const TURN_ID = "turn_456";

function toolCallRequest(id: number, tool: string, callId: string, args: Record<string, unknown>): Record<string, unknown> {
  return { id, method: "item/tool/call", params: { threadId: THREAD_ID, turnId: TURN_ID, callId, namespace: null, tool, arguments: args } };
}

async function snapshotFileForFixture(): Promise<{ dir: string; file: string }> {
  const raw = await loadFixture("valid-strength.json");
  const record = validateWorkoutRecord(raw).record;
  const dir = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  const file = join(dir, "snapshot.json");
  await writeFile(file, `${JSON.stringify({ schema_version: 1, records: [record] }, null, 2)}\n`, "utf8");
  return { dir, file };
}

test("codex schema probe requires dynamicTools and the item/tool/call flow", () => {
  const unsupported = inspectCodexAppServerSchema({
    definitions: { ThreadStartParams: { properties: { cwd: {}, sandbox: {} } } },
  });
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.gap ?? "", /dynamicTools/);

  const missingFlow = inspectCodexAppServerSchema({
    definitions: { ThreadStartParams: { properties: { dynamicTools: {} } } },
  });
  assert.equal(missingFlow.supported, false);
  assert.match(missingFlow.gap ?? "", /DynamicToolCall/);

  // A modern schema WITH dynamicTools is still denied: dynamic tools are
  // additive and do not establish that built-in tools are excluded.
  const modernButUnproven = inspectCodexAppServerSchema({
    definitions: {
      ThreadStartParams: { properties: { dynamicTools: {} } },
      DynamicToolCallParams: { properties: {} },
      DynamicToolCallResponse: { properties: {} },
    },
  });
  assert.equal(modernButUnproven.supported, false);
  assert.equal(modernButUnproven.builtinIsolationVerified, false);
  assert.match(modernButUnproven.gap ?? "", /builtin-isolation-unproven/);
});

test("codex adapter refuses to start without verified builtin isolation", async () => {
  const c = collect();
  const proc = new CoachedCodexAppServer({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: "/nonexistent/snapshot.json",
    sessionDir: join(tmpdir(), "codex-gate"),
    cwd: join(tmpdir(), "codex-gate"),
    spawn: () => {
      throw new Error("must not spawn");
    },
    onEvent: c.onEvent,
    onDone: c.onDone,
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /builtin-isolation-unproven/);
});

test("codex argv disables built-in tools and never composes a shell command", () => {
  const argv = buildCoachedCodexArgv();
  assert.deepEqual(argv.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  for (const override of [
    "features.shell_tool=false",
    "features.unified_exec=false",
    "tools.web_search=false",
    "tools.view_image=false",
  ]) {
    const index = argv.indexOf(override);
    assert.ok(index > 0);
    assert.equal(argv[index - 1], "-c");
  }
  assert.ok(!argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!argv.some((entry) => entry.includes(COACHED_SYSTEM_PROMPT)));
});

test("codex env drops service credentials and the snapshot path", () => {
  const env = buildCoachedCodexEnv({
    PATH: "/bin",
    HOME: "/home/user",
    OPENAI_API_KEY: "ok",
    SUPABASE_URL: "https://secret",
    SUPABASE_SERVICE_ROLE_KEY: "secret",
    FIT_TRACE_OPENROUTER_API_KEY: "secret",
    PI_FIT_TRACE_STORE: "/tmp/snapshot.json",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.OPENAI_API_KEY, "ok");
  assert.equal("SUPABASE_URL" in env, false);
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in env, false);
  assert.equal("FIT_TRACE_OPENROUTER_API_KEY" in env, false);
  assert.equal("PI_FIT_TRACE_STORE" in env, false);
});

test("codex native handles are bounded ids, never paths", () => {
  assert.ok(isSafeCodexThreadId(THREAD_ID));
  assert.ok(!isSafeCodexThreadId("../escape"));
  assert.ok(!isSafeCodexThreadId("/tmp/thread"));
  assert.ok(!isSafeCodexThreadId(""));
});

test("codex adapter: initialize, thread, domain tool calls, completion, confirmed exit", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  let stage: "init" | "thread" | "turn" | "history" | "analysis" | "done" = "init";
  const child = fakeChild((message, self) => {
    if (message.method === "initialize") {
      assert.equal((message.params as { capabilities: { experimentalApi: boolean } }).capabilities.experimentalApi, true);
      self.send({ id: message.id, result: { userAgent: "codex-test", platformFamily: "unix", platformOs: "macos" } });
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "thread/start") {
      stage = "thread";
      const params = message.params as Record<string, unknown>;
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandbox, "read-only");
      assert.deepEqual(
        (params.dynamicTools as Array<{ name: string }>).map((entry) => entry.name),
        ["get_training_history", "analyze_progress"],
      );
      self.send({ id: message.id, result: { thread: { id: THREAD_ID } } });
      return;
    }
    if (message.method === "turn/start") {
      stage = "turn";
      const params = message.params as Record<string, unknown>;
      assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.deepEqual(params.input, [{ type: "text", text: "analyze my progress" }]);
      self.send({ id: message.id, result: { turn: { id: TURN_ID, status: "inProgress" } } });
      self.send({
        method: "item/agentMessage/delta",
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "item-1", delta: "Looking at your history." },
      });
      self.send(toolCallRequest(100, "get_training_history", "call-1", { limit: 10 }));
      return;
    }
    if (message.id === 100 && !("method" in message)) {
      stage = "history";
      assert.equal((message.result as { success: boolean }).success, true);
      self.send(toolCallRequest(101, "analyze_progress", "call-2", {}));
      return;
    }
    if (message.id === 101 && !("method" in message)) {
      stage = "analysis";
      assert.equal((message.result as { success: boolean }).success, true);
      self.send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } } });
      stage = "done";
    }
  });
  const proc = new CoachedCodexAppServer({
    sessionId: "s1",
    runId: "r1",
    prompt: "analyze my progress",
    snapshotFile: file,
    sessionDir: join(dir, "work"),
    cwd: join(dir, "work"),
    builtinIsolationVerified: true,
    runTimeoutMs: 5000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_URL: "secret" },
    spawn: (binary, argv, opts) => {
      assert.equal(binary, "codex");
      assert.equal(opts.cwd, join(dir, "work"));
      assert.equal(opts.env.SUPABASE_URL, undefined);
      assert.deepEqual(argv.slice(0, 2), ["app-server", "--listen"]);
      return child;
    },
    onEvent: c.onEvent,
    onDone: c.onDone,
  });
  proc.start();
  await waitForDone(c);
  assert.equal(stage, "done");
  assert.equal(c.done?.status, "completed");
  assert.equal((c.done?.info as { nativeSessionHandle?: string }).nativeSessionHandle, THREAD_ID);
  assert.equal((c.done?.info as { processExitConfirmed?: boolean }).processExitConfirmed, true);
  assert.ok(c.events.some((event) => event.type === "text_delta"));
  const start = c.events.find((event) => event.type === "tool_start");
  assert.deepEqual(start, { type: "tool_start", tool: "get_training_history", callId: "call-1" });
  const analysis = c.events.find((event) => event.type === "analysis_result");
  assert.ok(analysis?.type === "analysis_result");
  const raw = await loadFixture("valid-strength.json");
  const expected = analyzeProgress([validateWorkoutRecord(raw).record], {});
  assert.deepEqual(analysis.result, expected);
  const terminal = c.events.at(-1);
  assert.equal(terminal?.type, "terminal");
  assert.equal(terminal.status, "completed");
  await proc.close();
  await rm(dir, { recursive: true, force: true });
});

test("codex adapter: unknown tool is refused and completion is withheld", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild((message, self) => {
    if (message.method === "initialize") {
      self.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/start") {
      self.send({ id: message.id, result: { thread: { id: THREAD_ID } } });
      return;
    }
    if (message.method === "turn/start") {
      self.send({ id: message.id, result: { turn: { id: TURN_ID } } });
      self.send(toolCallRequest(100, "bash", "call-1", { command: "cat /etc/passwd" }));
      return;
    }
    if (message.id === 100 && !("method" in message)) {
      assert.equal((message.result as { success: boolean }).success, false);
    }
  });
  const proc = new CoachedCodexAppServer({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: file,
    sessionDir: join(dir, "work"),
    cwd: join(dir, "work"),
    builtinIsolationVerified: true,
    runTimeoutMs: 5000,
    spawn: () => child,
    onEvent: c.onEvent,
    onDone: c.onDone,
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /non-allowlisted tool/);
  assert.ok(c.events.some((event) => event.type === "run_error" && event.code === "TOOL_REFUSED"));
  assert.ok(!c.events.some((event) => event.type === "tool_start"));
  await rm(dir, { recursive: true, force: true });
});

test("codex adapter: process exit before turn/completed is a failure", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild((message, self) => {
    if (message.method === "initialize") {
      self.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/start") {
      self.send({ id: message.id, result: { thread: { id: THREAD_ID } } });
      self.emit("close", 1);
    }
  });
  const proc = new CoachedCodexAppServer({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: file,
    sessionDir: join(dir, "work"),
    cwd: join(dir, "work"),
    builtinIsolationVerified: true,
    runTimeoutMs: 5000,
    spawn: () => child,
    onEvent: c.onEvent,
    onDone: c.onDone,
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /exited before turn\/completed/);
  await rm(dir, { recursive: true, force: true });
});

test("codex adapter: cancel interrupts, kills after grace, and reports cancelled only on exit", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild((message, self) => {
    if (message.method === "initialize") {
      self.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/start") {
      self.send({ id: message.id, result: { thread: { id: THREAD_ID } } });
      return;
    }
    if (message.method === "turn/start") {
      self.send({ id: message.id, result: { turn: { id: TURN_ID } } });
      setTimeout(() => proc.cancel("user cancel"), 10);
      return;
    }
    if (message.method === "turn/interrupt") {
      self.send({
        method: "turn/completed",
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "interrupted" } },
      });
    }
  });
  const proc = new CoachedCodexAppServer({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: file,
    sessionDir: join(dir, "work"),
    cwd: join(dir, "work"),
    builtinIsolationVerified: true,
    runTimeoutMs: 5000,
    graceMs: 20,
    spawn: () => child,
    onEvent: c.onEvent,
    onDone: c.onDone,
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "cancelled");
  assert.ok(child.sent.some((message) => message.method === "turn/interrupt"));
  assert.ok(child.killCalls.includes("SIGKILL"));
  assert.equal((c.done?.info as { processExitConfirmed?: boolean }).processExitConfirmed, true);
  await rm(dir, { recursive: true, force: true });
});

test("codex adapter: same-backend native handle resumes the same thread", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild((message, self) => {
    if (message.method === "initialize") {
      self.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/resume") {
      assert.equal((message.params as { threadId: string }).threadId, THREAD_ID);
      self.send({ id: message.id, result: { thread: { id: THREAD_ID } } });
      return;
    }
    if (message.method === "thread/start") {
      assert.fail("a resume run must not start a fresh thread");
    }
    if (message.method === "turn/start") {
      self.send({ id: message.id, result: { turn: { id: TURN_ID } } });
      self.send(toolCallRequest(100, "analyze_progress", "call-1", {}));
      return;
    }
    if (message.id === 100 && !("method" in message)) {
      self.send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } } });
    }
  });
  const proc = new CoachedCodexAppServer({
    sessionId: "s1",
    runId: "r2",
    prompt: "again",
    snapshotFile: file,
    sessionDir: join(dir, "work"),
    cwd: join(dir, "work"),
    resumeNativeSessionHandle: THREAD_ID,
    builtinIsolationVerified: true,
    runTimeoutMs: 5000,
    spawn: () => child,
    onEvent: c.onEvent,
    onDone: c.onDone,
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "completed");
  assert.equal((c.done?.info as { nativeSessionHandle?: string }).nativeSessionHandle, THREAD_ID);
  await rm(dir, { recursive: true, force: true });
});

test("codex adapter: approval requests are declined and fail the run closed", async () => {
  const { dir, file } = await snapshotFileForFixture();
  const c = collect();
  const child = fakeChild((message, self) => {
    if (message.method === "initialize") {
      self.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/start") {
      self.send({ id: message.id, result: { thread: { id: THREAD_ID } } });
      return;
    }
    if (message.method === "turn/start") {
      self.send({ id: message.id, result: { turn: { id: TURN_ID } } });
      self.send({
        id: 100,
        method: "item/commandExecution/requestApproval",
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "item-1" },
      });
      return;
    }
    if (message.id === 100 && !("method" in message)) {
      assert.deepEqual(message.result, { decision: "decline" });
    }
  });
  const proc = new CoachedCodexAppServer({
    sessionId: "s1",
    runId: "r1",
    prompt: "x",
    snapshotFile: file,
    sessionDir: join(dir, "work"),
    cwd: join(dir, "work"),
    builtinIsolationVerified: true,
    runTimeoutMs: 5000,
    spawn: () => child,
    onEvent: c.onEvent,
    onDone: c.onDone,
  });
  proc.start();
  await waitForDone(c);
  assert.equal(c.done?.status, "failed");
  assert.match(c.done?.reason ?? "", /never approve/);
  await rm(dir, { recursive: true, force: true });
});
