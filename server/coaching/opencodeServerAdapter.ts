/**
 * Bounded OpenCode v2 adapter for coached (analysis-only) runs.
 *
 * Target: the installed `opencode` v2.0.30 CLI. The adapter launches one
 * private CLI run (`opencode run --standalone --format json`) inside a
 * controlled working directory with a generated config and project-local
 * plugin. It never uses the user's config/data roots, plugins, MCP servers,
 * skills, hooks, or built-in file/shell/network tools.
 *
 * Isolation model:
 * - generated config denies every action/resource first and allows exactly
 *   the two coached domain tools (`get_training_history`, `analyze_progress`);
 * - the generated local plugin registers only those two tools;
 * - each tool call goes to an in-process loopback bridge (ephemeral bearer
 *   token), which answers from the immutable snapshot via
 *   {@link loadSnapshotDomainExecutor}. The child never receives the snapshot
 *   path.
 *
 * OpenCode's permission model is only trusted after a positive capability
 * probe. `isolationVerified` is therefore an explicit construction gate: the
 * production launcher sets it only from {@link probeOpenCodeRun}. Until that
 * probe can prove the complete built-in inventory is excluded, the backend
 * stays unavailable with an explicit gap instead of being advertised.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

import { COACHED_TOOL_NAMES } from "@pi-fit-trace/api-contracts";
import type { CoachingEventPayload, CoachingTerminalStatus } from "@pi-fit-trace/api-contracts";
import {
  DomainToolError,
  loadSnapshotDomainExecutor,
} from "./readOnlyDomainExecutor.ts";
import type { SnapshotDomainExecutor } from "./readOnlyDomainExecutor.ts";

export const OPENCODE_RUN_ARGS = ["run", "--standalone", "--format", "json", "--auto"] as const;
export const OPENCODE_COACH_AGENT = "fit-trace-coach";
export const OPENCODE_PLUGIN_DIR = join(".opencode", "plugins", "fit-trace");
export const MAX_OPENCODE_PROMPT_BYTES = 64 * 1024;
export const MAX_OPENCODE_STDOUT_BYTES = 1024 * 1024;
export const MAX_OPENCODE_EVENTS = 1000;
export const MAX_OPENCODE_LINE_BYTES = 256 * 1024;
const MAX_BRIDGE_BODY_BYTES = 64 * 1024;

const SAFE_SESSION_HANDLE = /^ses_[A-Za-z0-9]{6,120}$/;

export function isSafeOpenCodeSessionId(value: unknown): value is string {
  return typeof value === "string" && SAFE_SESSION_HANDLE.test(value);
}

export interface OpenCodeChildProcess {
  stdout: {
    on(event: string, listener: (...args: never[]) => void): unknown;
    removeListener?(event: string, listener: (...args: never[]) => void): unknown;
  };
  stderr?: {
    on(event: string, listener: (...args: never[]) => void): unknown;
    removeListener?(event: string, listener: (...args: never[]) => void): unknown;
  } | null;
  once(event: string, listener: (...args: never[]) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener?(event: string, listener: (...args: never[]) => void): unknown;
  kill(signal?: string | number): boolean;
  readonly killed?: boolean;
}

export interface OpenCodeBridgeInfo {
  url: string;
  token: string;
}

export type OpenCodeSpawnFn = (
  binary: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; bridge: OpenCodeBridgeInfo },
) => OpenCodeChildProcess;

export function defaultOpenCodeSpawn(
  binary: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): OpenCodeChildProcess {
  return nodeSpawn(binary, argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as OpenCodeChildProcess;
}

/** Provider credentials are copied explicitly; everything else is filtered. */
const ENV_PASSTHROUGH_EXACT = new Set([
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TZ",
]);

const ENV_PASSTHROUGH_PREFIXES = [
  "OPENAI_",
  "AZURE_OPENAI_",
  "ANTHROPIC_",
  "GOOGLE_",
  "GEMINI_",
  "OLLAMA_",
  "OPENROUTER_",
  "OPENCODE_",
];

/** Never inherited: product/service credentials and the snapshot path. */
const ENV_BLOCKED = /SUPABASE|SERVICE_ROLE|SERVICE_KEY|FIT_TRACE_|PI_FIT_TRACE_|OPENCODE_SERVER_PASSWORD/i;

export interface OpenCodeIsolatedPaths {
  runRoot: string;
  home: string;
  config: string;
  cache: string;
  workdir: string;
  /** Persistent per-product-session data/state for same-account resume. */
  data: string;
  state: string;
  configFile: string;
  pluginFile: string;
}

/** Build the isolated directory layout. No user file is read or written. */
export function buildOpenCodeIsolatedPaths(sessionDir: string, runId: string): OpenCodeIsolatedPaths {
  const runRoot = join(sessionDir, "opencode-runs", runId);
  const workdir = join(runRoot, "project");
  return {
    runRoot,
    home: join(runRoot, "home"),
    config: join(runRoot, "config"),
    cache: join(runRoot, "cache"),
    workdir,
    // Data/state stay under the session so a later run in the same product
    // session can resume the OpenCode session without crossing accounts.
    data: join(sessionDir, "opencode-data"),
    state: join(sessionDir, "opencode-state"),
    configFile: join(workdir, "opencode.json"),
    pluginFile: join(workdir, OPENCODE_PLUGIN_DIR, "index.ts"),
  };
}

export interface OpenCodeConfigOptions {
  model: string;
  /** Optional system instruction. The prompt itself is still plain input. */
  system?: string;
}

/**
 * Generated v2 config. The first permission rule is the wildcard deny; the
 * only later allows are the two coached tools. Built-in agents are not
 * re-enabled and MCP/skills/plugins are empty.
 */
export function buildOpenCodeConfig(options: OpenCodeConfigOptions): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model: options.model,
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: COACHED_TOOL_NAMES[0], resource: "*", effect: "allow" },
      { action: COACHED_TOOL_NAMES[1], resource: "*", effect: "allow" },
    ],
    agents: {
      [OPENCODE_COACH_AGENT]: {
        description: "Read-only Fit Trace training analyst",
        mode: "primary",
        ...(options.system !== undefined ? { system: options.system } : {}),
        permissions: [],
      },
    },
    default_agent: OPENCODE_COACH_AGENT,
    plugins: [],
    mcp: { servers: {} },
    instructions: [],
    skills: [],
  };
}

/** Argv array (never a shell string) for one bounded coached run. */
export function buildCoachedOpenCodeArgv(options: {
  prompt: string;
  resumeSessionId?: string;
}): string[] {
  const argv: string[] = [...OPENCODE_RUN_ARGS];
  if (options.resumeSessionId !== undefined) {
    argv.push("--session", options.resumeSessionId);
  }
  // `--` terminates flag parsing so a prompt beginning with `-` is input.
  argv.push("--", options.prompt);
  return argv;
}

/**
 * Generated local plugin. It is intentionally fixed and tiny: no filesystem,
 * shell, network, environment, or dynamic tool discovery. The bearer token and
 * loopback URL are the only injected values.
 */
export function buildOpenCodePluginSource(bridge: OpenCodeBridgeInfo): string {
  const token = JSON.stringify(bridge.token);
  const url = JSON.stringify(bridge.url);
  return `// Generated by agent-fit-trace. Ephemeral; deleted with this run.
const BRIDGE_URL = ${url};
const BRIDGE_TOKEN = ${token};

async function callBridge(tool: string, input: unknown): Promise<string> {
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + BRIDGE_TOKEN,
    },
    body: JSON.stringify({ tool, arguments: input }),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "invalid bridge response" }));
  if (!response.ok || payload.ok !== true) {
    throw new Error(typeof payload.error === "string" ? payload.error : "domain tool failed");
  }
  return typeof payload.content === "string" ? payload.content : "";
}

export default {
  id: "fit-trace-tools",
  async setup(ctx: any) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: ${JSON.stringify(COACHED_TOOL_NAMES[0])},
        description: "Query stored training records by date range and exercise. Read-only.",
        input: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            exercise: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            offset: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        execute: async (input: unknown) => ({
          content: await callBridge(${JSON.stringify(COACHED_TOOL_NAMES[0])}, input ?? {}),
        }),
      });
      editor.add({
        name: ${JSON.stringify(COACHED_TOOL_NAMES[1])},
        description: "Deterministically compute progress metrics and safety flags. Read-only.",
        input: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            exercises: { type: "array", items: { type: "string" }, maxItems: 20 },
          },
          additionalProperties: false,
        },
        execute: async (input: unknown) => ({
          content: await callBridge(${JSON.stringify(COACHED_TOOL_NAMES[1])}, input ?? {}),
        }),
      });
    });
  },
};
`;
}

export interface OpenCodeRunDoneInfo {
  nativeSessionHandle?: string;
  processExitConfirmed?: boolean;
}

export interface CoachedOpenCodeCallbacks {
  onEvent(payload: CoachingEventPayload): void;
  onDone(status: CoachingTerminalStatus, reason?: string, info?: OpenCodeRunDoneInfo): void;
}

export interface CoachedOpenCodeOptions extends CoachedOpenCodeCallbacks {
  sessionId: string;
  runId: string;
  prompt: string;
  /** Immutable per-run snapshot, read only by the in-process executor. */
  snapshotFile: string;
  /** Persistent per-product-session directory (data/state + run roots). */
  sessionDir: string;
  cwd: string;
  /** `provider/model` for the generated config (operator configured). */
  model: string;
  opencodeBinary?: string;
  resumeNativeSessionHandle?: string;
  /**
   * Positive proof from the installed-version probe that the generated
   * wildcard-deny permission set and plugin-only tool surface are effective.
   * Without it the adapter fails closed before spawning.
   */
  isolationVerified?: boolean;
  env?: NodeJS.ProcessEnv;
  spawn?: OpenCodeSpawnFn;
  loadExecutor?: (snapshotFile: string) => Promise<SnapshotDomainExecutor>;
  runTimeoutMs?: number;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bigintEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * In-process loopback bridge. It owns the snapshot executor; the child only
 * sends bounded JSON tool arguments and never sees a path or credential.
 */
export class OpenCodeDomainBridge {
  private server: Server | null = null;
  private executor: Promise<SnapshotDomainExecutor> | null = null;
  private readonly token = randomBytes(32).toString("hex");
  private closed = false;
  private callCounter = 0;

  private readonly options: {
    snapshotFile: string;
    onToolStart(tool: string, callId: string): void;
    onToolEnd(tool: string, callId: string, ok: boolean, error?: string): void;
    onAnalysis(result: import("@pi-fit-trace/core").AnalysisResult): void;
    loadExecutor?: (snapshotFile: string) => Promise<SnapshotDomainExecutor>;
  };

  constructor(options: {
    snapshotFile: string;
    onToolStart(tool: string, callId: string): void;
    onToolEnd(tool: string, callId: string, ok: boolean, error?: string): void;
    onAnalysis(result: import("@pi-fit-trace/core").AnalysisResult): void;
    loadExecutor?: (snapshotFile: string) => Promise<SnapshotDomainExecutor>;
  }) {
    this.options = options;
  }

  get info(): OpenCodeBridgeInfo {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("bridge is not listening");
    }
    return { url: `http://127.0.0.1:${address.port}/tool`, token: this.token };
  }

  async start(): Promise<OpenCodeBridgeInfo> {
    if (this.server !== null) return this.info;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    this.server = server;
    return this.info;
  }

  async close(): Promise<void> {
    this.closed = true;
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Do not let a stuck keep-alive hold shutdown forever.
      setImmediate(() => {
        try {
          server.closeAllConnections?.();
        } catch {
          // Best-effort.
        }
      });
    });
  }

  private getExecutor(): Promise<SnapshotDomainExecutor> {
    if (this.executor === null) {
      const loader = this.options.loadExecutor ?? loadSnapshotDomainExecutor;
      this.executor = loader(this.options.snapshotFile);
    }
    return this.executor;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const respond = (status: number, payload: Record<string, unknown>): void => {
      const body = JSON.stringify(payload);
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    };
    try {
      if (this.closed) return respond(503, { ok: false, error: "bridge closed" });
      if (request.method !== "POST" || request.url !== "/tool") {
        return respond(404, { ok: false, error: "not found" });
      }
      const auth = request.headers.authorization;
      const expected = `Bearer ${this.token}`;
      if (typeof auth !== "string" || !bigintEqual(expected, auth)) {
        return respond(401, { ok: false, error: "unauthorized" });
      }
      const declared = Number(request.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > MAX_BRIDGE_BODY_BYTES) {
        return respond(413, { ok: false, error: "body too large" });
      }
      const raw = await this.readBody(request);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return respond(400, { ok: false, error: "invalid JSON" });
      }
      const body = asRecord(parsed);
      const tool = body?.tool;
      const args = body?.arguments ?? {};
      if (typeof tool !== "string" || !(COACHED_TOOL_NAMES as readonly string[]).includes(tool)) {
        return respond(400, { ok: false, error: "tool is not allowlisted for coached runs" });
      }
      this.callCounter += 1;
      const callId = `bridge-${this.callCounter}`;
      this.options.onToolStart(tool, callId);
      try {
        const executor = await this.getExecutor();
        if (tool === COACHED_TOOL_NAMES[0]) {
          const page = executor.getTrainingHistory(args);
          this.options.onToolEnd(tool, callId, true);
          return respond(200, { ok: true, content: JSON.stringify(page) });
        }
        const result = executor.analyze(args);
        this.options.onToolEnd(tool, callId, true);
        this.options.onAnalysis(result);
        return respond(200, { ok: true, content: JSON.stringify(result) });
      } catch (error) {
        const message = error instanceof DomainToolError ? error.message : `${tool} failed`;
        this.options.onToolEnd(tool, callId, false, message);
        return respond(400, { ok: false, error: message });
      }
    } catch {
      respond(500, { ok: false, error: "bridge failure" });
    }
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      request.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BRIDGE_BODY_BYTES) {
          settled = true;
          try {
            request.pause();
          } catch {
            // Best-effort.
          }
          reject(new Error("body too large"));
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      request.on("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}

type Phase = "idle" | "starting" | "running" | "settled";

/**
 * One coached OpenCode run. Completion requires a clean CLI exit AND a
 * validated `analyze_progress` result from the bridge; an unknown tool event
 * fails the run closed.
 */
export class CoachedOpenCodeRun {
  private readonly opts: CoachedOpenCodeOptions;
  private child: OpenCodeChildProcess | null = null;
  private bridge: OpenCodeDomainBridge | null = null;
  private phase: Phase = "idle";
  private started = false;
  private settled = false;
  private closed = false;
  private exited = false;
  private failed = false;
  private failMessage = "opencode run failed";
  private cancelRequested = false;
  private cancelReason = "cancel requested";
  private hasAnalysis = false;
  private sessionHandle: string | null = null;
  private stdoutBuffer = "";
  private stdoutBytes = 0;
  private eventCount = 0;
  private timers: unknown[] = [];
  private listeners: Array<{ target: "stdout" | "stderr" | "child"; event: string; fn: (...args: never[]) => void }> = [];
  private exitWaiters: Array<{ resolve: (exited: boolean) => void; timer: unknown }> = [];
  private finishPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private disposalPromise: Promise<boolean> | null = null;

  constructor(opts: CoachedOpenCodeOptions) {
    this.opts = opts;
  }

  get argv(): { binary: string; argv: string[] } {
    return {
      binary: this.opts.opencodeBinary ?? "opencode",
      argv: buildCoachedOpenCodeArgv({
        prompt: this.opts.prompt,
        ...(this.opts.resumeNativeSessionHandle !== undefined
          ? { resumeSessionId: this.opts.resumeNativeSessionHandle }
          : {}),
      }),
    };
  }

  start(): void {
    if (this.started || this.settled || this.closed) return;
    this.started = true;
    void this.startAsync();
  }

  private async startAsync(): Promise<void> {
    if (this.opts.isolationVerified !== true) {
      await this.finish("failed", "plugin-isolation-unproven");
      return;
    }
    if (Buffer.byteLength(this.opts.prompt, "utf8") > MAX_OPENCODE_PROMPT_BYTES) {
      await this.finish("failed", "prompt exceeds the coached run limit");
      return;
    }
    if (
      this.opts.resumeNativeSessionHandle !== undefined &&
      !isSafeOpenCodeSessionId(this.opts.resumeNativeSessionHandle)
    ) {
      await this.finish("failed", "invalid native OpenCode session handle");
      return;
    }
    this.phase = "starting";
    let bridgeInfo: OpenCodeBridgeInfo;
    let workdir: string;
    try {
      const paths = buildOpenCodeIsolatedPaths(this.opts.sessionDir, this.opts.runId);
      workdir = paths.workdir;
      mkdirSync(paths.workdir, { recursive: true });
      mkdirSync(join(paths.workdir, OPENCODE_PLUGIN_DIR), { recursive: true });
      mkdirSync(paths.home, { recursive: true });
      mkdirSync(paths.config, { recursive: true });
      mkdirSync(paths.cache, { recursive: true });
      mkdirSync(paths.data, { recursive: true });
      mkdirSync(paths.state, { recursive: true });
      writeFileSync(
        paths.configFile,
        `${JSON.stringify(buildOpenCodeConfig({ model: this.opts.model }), null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(paths.configFile, 0o600);
      this.bridge = new OpenCodeDomainBridge({
        snapshotFile: this.opts.snapshotFile,
        onToolStart: (tool, callId) => this.emit({ type: "tool_start", tool, callId }),
        onToolEnd: (tool, callId, ok, error) => {
          if (ok) {
            this.emit({ type: "tool_end", tool, callId, ok: true });
          } else {
            this.emit({
              type: "tool_end",
              tool,
              callId,
              ok: false,
              error: error ?? "domain tool failed",
            });
          }
        },
        onAnalysis: (result) => {
          this.hasAnalysis = true;
          this.emit({ type: "analysis_result", result });
        },
        ...(this.opts.loadExecutor !== undefined ? { loadExecutor: this.opts.loadExecutor } : {}),
      });
      bridgeInfo = await this.bridge.start();
      writeFileSync(paths.pluginFile, buildOpenCodePluginSource(bridgeInfo), {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(paths.pluginFile, 0o600);
    } catch {
      await this.finish("failed", "cannot prepare isolated OpenCode run");
      return;
    }
    if (this.settled || this.closed) {
      await this.bridge?.close();
      return;
    }

    const env = this.buildEnv();
    let child: OpenCodeChildProcess;
    try {
      child = (this.opts.spawn ?? defaultOpenCodeSpawn)(this.argv.binary, this.argv.argv, {
        cwd: workdir,
        env,
        bridge: bridgeInfo,
      });
    } catch {
      await this.finish("failed", "opencode run spawn failed");
      return;
    }
    this.child = child;
    this.addListener("stdout", "data", (chunk: unknown) => this.onStdoutChunk(chunk));
    // stderr is deliberately drained but never surfaced: it may contain
    // provider diagnostics and is not part of the bounded event contract.
    this.addListener("stderr", "data", () => undefined);
    this.addListener("child", "error", () => {
      if (this.cancelRequested) return;
      this.fail("opencode run process error");
    });
    this.addListener("child", "close", (code: unknown) => {
      this.exited = true;
      this.drainExitWaiters();
      if (this.closed || this.settled) return;
      if (this.cancelRequested) {
        void this.finish("cancelled", this.cancelReason);
        return;
      }
      if (this.failed) {
        void this.finish("failed", this.failMessage);
        return;
      }
      if (typeof code === "number" && code !== 0) {
        void this.finish("failed", `opencode run exited with code ${code}`);
        return;
      }
      if (!this.hasAnalysis) {
        this.emit({
          type: "run_error",
          code: "NO_ANALYSIS",
          message: "opencode run completed without a validated analysis result",
        });
        void this.finish("failed", "opencode run completed without a validated analysis result");
        return;
      }
      void this.finish("completed");
    });

    this.phase = "running";
    this.armTimer(() => {
      this.emit({ type: "run_error", code: "TIMEOUT", message: "coached run timed out" });
      this.failed = true;
      this.failMessage = "coached run timed out";
      this.killChild("SIGKILL");
      void this.finish("failed", "coached run timed out");
    }, this.opts.runTimeoutMs ?? 120000);
  }

  cancel(reason?: string): void {
    if (this.settled) return;
    if (reason !== undefined) this.cancelReason = reason;
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    this.emit({ type: "run_error", code: "CANCELLED", message: this.cancelReason });
    if (this.child === null || this.closed) {
      void this.finish("cancelled", this.cancelReason);
      return;
    }
    void (async () => {
      const grace = this.opts.graceMs ?? 2000;
      // `run --standalone` has no stable client interrupt surface; terminate
      // the private process and confirm exit before reporting cancellation.
      this.killChild("SIGTERM");
      if (!(await this.waitForExit(grace))) this.killChild("SIGKILL");
      await this.waitForExit(2000);
      await this.finish("cancelled", this.cancelReason);
    })();
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    if (this.finishPromise !== null) {
      this.closePromise = (async (): Promise<void> => {
        await this.finishPromise;
        const exited = await this.ensureDisposed();
        if (!exited) throw new Error("close: opencode run did not exit");
      })();
      return this.closePromise;
    }
    this.killChild("SIGKILL");
    this.closePromise = (async (): Promise<void> => {
      const exited = await this.ensureDisposed();
      if (!exited) throw new Error("close: opencode run did not exit");
    })();
    return this.closePromise;
  }

  /** Sanitized child env rooted in temp dirs; no user OpenCode config. */
  private buildEnv(): NodeJS.ProcessEnv {
    const base = this.opts.env ?? process.env;
    const paths = buildOpenCodeIsolatedPaths(this.opts.sessionDir, this.opts.runId);
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined) continue;
      if (ENV_BLOCKED.test(key)) continue;
      if (ENV_PASSTHROUGH_EXACT.has(key) || ENV_PASSTHROUGH_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        env[key] = value;
      }
    }
    env.HOME = paths.home;
    env.XDG_CONFIG_HOME = paths.config;
    env.XDG_DATA_HOME = paths.data;
    env.XDG_CACHE_HOME = paths.cache;
    env.XDG_STATE_HOME = paths.state;
    env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
    env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
    env.OPENCODE_DISABLE_FILEWATCHER = "1";
    env.OPENCODE_SERVER_PASSWORD = randomBytes(24).toString("hex");
    return env;
  }

  private addListener(
    target: "stdout" | "stderr" | "child",
    event: string,
    fn: (...args: never[]) => void,
  ): void {
    const source = target === "child" ? this.child : target === "stdout" ? this.child?.stdout : this.child?.stderr;
    try {
      (source as { on(event: string, fn: (...args: never[]) => void): unknown } | null | undefined)?.on(event, fn);
    } catch {
      // A dead stdio pipe is reported through the process close path.
    }
    this.listeners.push({ target, event, fn });
  }

  private detachListeners(): void {
    for (const { target, event, fn } of this.listeners) {
      try {
        if (target === "child") this.child?.removeListener?.(event, fn);
        else if (target === "stdout") this.child?.stdout.removeListener?.(event, fn);
        else this.child?.stderr?.removeListener?.(event, fn);
      } catch {
        // Best-effort.
      }
    }
    this.listeners.length = 0;
  }

  private armTimer(fn: () => void, ms: number): void {
    if (this.opts.setTimer) {
      this.timers.push(this.opts.setTimer(fn, ms));
      return;
    }
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const handle of this.timers) {
      try {
        if (this.opts.clearTimer) this.opts.clearTimer(handle);
        else clearTimeout(handle as NodeJS.Timeout);
      } catch {
        // Best-effort.
      }
    }
    this.timers.length = 0;
  }

  private killChild(signal: string = "SIGKILL"): void {
    try {
      this.child?.kill(signal as NodeJS.Signals);
    } catch {
      // Already dead.
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited || this.child === null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter: { resolve: (exited: boolean) => void; timer: unknown } = { resolve, timer: undefined };
      const onTimeout = (): void => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) this.exitWaiters.splice(index, 1);
        resolve(false);
      };
      waiter.timer = this.opts.setTimer !== undefined
        ? this.opts.setTimer(onTimeout, timeoutMs)
        : setTimeout(onTimeout, timeoutMs);
      this.exitWaiters.push(waiter);
    });
  }

  private drainExitWaiters(): void {
    for (const waiter of this.exitWaiters.splice(0, this.exitWaiters.length)) {
      try {
        if (this.opts.clearTimer) this.opts.clearTimer(waiter.timer);
        else clearTimeout(waiter.timer as NodeJS.Timeout);
      } catch {
        // Best-effort.
      }
      waiter.resolve(true);
    }
  }

  private ensureDisposed(): Promise<boolean> {
    if (this.disposalPromise !== null) return this.disposalPromise;
    this.disposalPromise = (async (): Promise<boolean> => {
      const exited = await this.waitForExit(2000);
      if (!exited) return false;
      this.detachListeners();
      await this.bridge?.close();
      this.bridge = null;
      return true;
    })();
    return this.disposalPromise;
  }

  private onStdoutChunk(chunk: unknown): void {
    if (this.settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this.stdoutBytes += buffer.byteLength;
    if (this.stdoutBytes > MAX_OPENCODE_STDOUT_BYTES) {
      this.fail("opencode output exceeds the coached run limit");
      return;
    }
    this.stdoutBuffer += buffer.toString("utf8");
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.onStdoutLine(line);
      if (this.settled) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (this.stdoutBuffer.length > MAX_OPENCODE_LINE_BYTES) {
      this.fail("opencode emitted an oversized line");
    }
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      // `--format json` should be JSONL, but provider noise is ignored rather
      // than surfaced; never treat it as validated analysis.
      return;
    }
    this.onOutputRecord(parsed);
  }

  private onOutputRecord(record: unknown): void {
    const obj = asRecord(record);
    if (obj === null) return;
    this.eventCount += 1;
    if (this.eventCount > MAX_OPENCODE_EVENTS) {
      this.fail("opencode emitted too many events");
      return;
    }
    const sessionId = this.extractSessionId(obj);
    if (sessionId !== null) this.sessionHandle = sessionId;
    const type = typeof obj.type === "string" ? obj.type : typeof obj.event === "string" ? obj.event : "";
    const lowered = type.toLowerCase();
    if (lowered.includes("permission") && (lowered.includes("asked") || lowered.includes("request"))) {
      this.fail("opencode requested interactive permission; coached runs never approve it");
      return;
    }
    if (lowered.includes("error") || lowered.includes("failed")) {
      this.fail("opencode reported a failed execution");
      return;
    }
    const tool = this.extractToolName(obj);
    if (tool !== null && !(COACHED_TOOL_NAMES as readonly string[]).includes(tool)) {
      this.emit({
        type: "run_error",
        code: "TOOL_REFUSED",
        message: `tool ${JSON.stringify(tool).slice(0, 80)} is not allowlisted for coached runs`,
      });
      this.fail("a non-allowlisted tool was requested during this run");
      return;
    }
    const text = this.extractText(obj);
    if (text !== null && text !== "") this.emit({ type: "text_delta", delta: text });
  }

  private extractSessionId(obj: Record<string, unknown>): string | null {
    const candidates = [
      obj.sessionID,
      obj.sessionId,
      asRecord(obj.session)?.id,
      asRecord(obj.data)?.sessionID,
      asRecord(obj.data)?.sessionId,
    ];
    for (const candidate of candidates) {
      if (isSafeOpenCodeSessionId(candidate)) return candidate;
    }
    return null;
  }

  private extractToolName(obj: Record<string, unknown>): string | null {
    const direct = obj.tool ?? obj.toolName ?? obj.name;
    if (typeof direct === "string" && direct !== "") return direct;
    const data = asRecord(obj.data);
    const nested = data?.tool ?? data?.toolName ?? data?.name;
    return typeof nested === "string" && nested !== "" ? nested : null;
  }

  private extractText(obj: Record<string, unknown>): string | null {
    for (const key of ["delta", "text"] as const) {
      const value = obj[key];
      if (typeof value === "string") return value;
    }
    const data = asRecord(obj.data);
    if (data !== null) {
      for (const key of ["delta", "text"] as const) {
        const value = data[key];
        if (typeof value === "string") return value;
      }
    }
    const part = asRecord(obj.part) ?? (data !== null ? asRecord(data.part) : null);
    if (part !== null && typeof part.text === "string") return part.text;
    return null;
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.failed = true;
    this.failMessage = message;
    this.emit({ type: "run_error", code: "RUN_FAILED", message });
    this.killChild("SIGKILL");
    // The close handler (or the exit waiter in finish) settles the run.
  }

  private emit(payload: CoachingEventPayload): void {
    if (this.settled) return;
    this.opts.onEvent(payload);
  }

  private async finish(status: CoachingTerminalStatus, reason?: string): Promise<void> {
    if (this.finishPromise !== null) return this.finishPromise;
    if (this.settled) return;
    if (this.cancelRequested) {
      status = "cancelled";
      reason = this.cancelReason;
    }
    this.settled = true;
    this.phase = "settled";
    this.clearTimers();
    this.killChild("SIGKILL");
    this.finishPromise = (async (): Promise<void> => {
      const exited = await this.ensureDisposed();
      if (!exited) {
        if (status === "completed") {
          status = "failed";
          reason = "process exit unconfirmed; completion withheld";
        } else {
          reason = reason !== undefined
            ? `${reason} (process exit unconfirmed)`
            : "process exit unconfirmed";
        }
      }
      const info: OpenCodeRunDoneInfo = { processExitConfirmed: exited };
      if (this.sessionHandle !== null) info.nativeSessionHandle = this.sessionHandle;
      this.opts.onEvent({ type: "terminal", status, ...(reason !== undefined ? { reason } : {}) });
      this.opts.onDone(status, reason, info);
    })();
    return this.finishPromise;
  }
}

/** Compatibility alias matching the Codex/pi adapter naming. */
export { CoachedOpenCodeRun as CoachedOpenCodeServer };
