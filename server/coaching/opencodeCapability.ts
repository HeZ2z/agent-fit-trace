/**
 * Installed-version capability probe for the OpenCode v2 coached adapter.
 *
 * The adapter's safety claim is: a generated wildcard-deny permission set plus
 * a single generated project plugin leaves exactly the two coached domain
 * tools reachable. That claim cannot be inferred from documentation or a
 * version string alone. This module therefore:
 *
 * 1. verifies the installed CLI version and that `run --standalone
 *    --format json` are accepted flags (a non-model invocation), and
 * 2. accepts positive isolation evidence from a bounded operator/fixture
 *    verifier (registered agent, exact plugin tool inventory, effective
 *    permission rules, no enabled built-in agents).
 *
 * Without (2) the result is `supported: false` with an explicit
 * `plugin-isolation-unproven` gap. The launcher never advertises the backend
 * in that state.
 */
import { spawn } from "node:child_process";

import { COACHED_TOOL_NAMES } from "@pi-fit-trace/api-contracts";
import {
  OPENCODE_COACH_AGENT,
  OPENCODE_RUN_ARGS,
  isSafeOpenCodeSessionId,
} from "./opencodeServerAdapter.ts";

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/**
 * Positive evidence for one installed OpenCode version. Every field is
 * observed, not assumed. `permissionRules` must be the EFFECTIVE ruleset for
 * the coached agent, in evaluation order.
 */
export interface OpenCodeIsolationEvidence {
  version: string;
  runFlags: string[];
  model: string;
  /** Agent ids currently registered by `opencode`. */
  agentIds: string[];
  /** Effective default agent id after generated config. */
  defaultAgent: string;
  /** Custom tool names registered by the generated plugin. */
  pluginTools: string[];
  /** Built-in tool names still reachable for the coached agent. */
  builtinTools: string[];
  /** Effective permission rules, in evaluation order. */
  permissionRules: OpenCodePermissionRule[];
}

export interface OpenCodeRunSupport {
  supported: boolean;
  /** Only true when the exact wildcard-deny/plugin-only surface was proven. */
  isolationVerified?: boolean;
  version?: string;
  model?: string;
  gap?: string;
  unavailable?: boolean;
}

const MODEL_PATTERN = /^[^/\s#]+\/[^/\s#]+(?:#[^\s#]+)?$/;

function isModernVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major !== 2) return false;
  if (minor > 0) return true;
  return patch >= 30;
}

function hasFlag(flags: readonly string[], flag: string): boolean {
  return flags.some((entry) => entry === flag || entry.startsWith(`${flag}=`));
}

function exactToolSet(tools: readonly string[]): boolean {
  const expected = [...COACHED_TOOL_NAMES].sort();
  const actual = [...new Set(tools)].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

/**
 * Pure, fixture-friendly evidence check. Returns the FIRST concrete gap so
 * the launcher can report a truthful unavailable reason.
 */
export function inspectOpenCodeIsolation(evidence: OpenCodeIsolationEvidence): OpenCodeRunSupport {
  const version = evidence.version.trim().replace(/^opencode\s+/i, "").replace(/^v/i, "");
  if (!isModernVersion(version)) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: `installed OpenCode version ${JSON.stringify(version)} is not a supported v2.0.30+ CLI`,
    };
  }
  if (!MODEL_PATTERN.test(evidence.model)) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: "no provider/model is configured for coached OpenCode runs (expected provider/model)",
    };
  }
  if (!hasFlag(evidence.runFlags, "--standalone") || !hasFlag(evidence.runFlags, "--format")) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: "installed OpenCode `run` does not accept --standalone and --format",
    };
  }
  if (evidence.defaultAgent !== OPENCODE_COACH_AGENT) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: `effective default agent is ${JSON.stringify(evidence.defaultAgent)}, not ${OPENCODE_COACH_AGENT}`,
    };
  }
  if (!evidence.agentIds.includes(OPENCODE_COACH_AGENT)) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: `generated agent ${OPENCODE_COACH_AGENT} is not registered`,
    };
  }
  if (!exactToolSet(evidence.pluginTools)) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: "generated plugin does not expose exactly the two coached domain tools",
    };
  }
  if (evidence.builtinTools.length > 0) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: `built-in OpenCode tools remain reachable: ${evidence.builtinTools.slice(0, 8).join(", ")}`,
    };
  }
  // Only the coached agent may be enabled: another agent can append its own
  // permissive rules after the global wildcard deny.
  const extraAgents = evidence.agentIds.filter((id) => id !== OPENCODE_COACH_AGENT);
  if (extraAgents.length > 0) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: `other OpenCode agents remain enabled: ${extraAgents.slice(0, 8).join(", ")}`,
    };
  }
  const rules = evidence.permissionRules;
  if (rules.length < 3) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: "effective permission rules are missing the wildcard deny or exact allows",
    };
  }
  const first = rules[0];
  if (first?.action !== "*" || first.resource !== "*" || first.effect !== "deny") {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: "the first effective permission rule is not a wildcard deny",
    };
  }
  for (const rule of rules.slice(1)) {
    if (rule.effect === "ask") {
      return {
        supported: false,
        isolationVerified: false,
        version,
        gap: "an effective permission rule still asks interactively; coached runs cannot approve requests",
      };
    }
    if (rule.effect === "allow") {
      const domain = (COACHED_TOOL_NAMES as readonly string[]).includes(rule.action);
      if (!domain || rule.resource !== "*") {
        return {
          supported: false,
          isolationVerified: false,
          version,
          gap: `permission allow is broader than the coached tools: ${rule.action} ${rule.resource}`,
        };
      }
    }
  }
  return {
    supported: true,
    isolationVerified: true,
    version,
    model: evidence.model,
  };
}

interface ProbeOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Test/operator seam that returns positive evidence for the installed
   * version. The launcher does not synthesize evidence.
   */
  verifyIsolation?: (context: { binary: string; version: string; model: string }) => Promise<OpenCodeIsolationEvidence | null>;
}

function runBounded(binary: string, argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, argv, { stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs });
    } catch {
      reject(new Error("spawn-failed"));
      return;
    }
    let stdout = "";
    let settled = false;
    const done = (error?: Error, code = -1): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve({ code, stdout });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8");
    });
    child.on("error", () => done(new Error("spawn-failed")));
    child.on("close", (code) => done(undefined, code ?? -1));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort.
      }
      done(new Error("probe-timeout"));
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Probe the installed CLI only; never calls a model. */
export async function probeOpenCodeRun(options: ProbeOptions = {}): Promise<OpenCodeRunSupport> {
  const binary = options.binary ?? "opencode";
  const model = options.model ?? process.env.FIT_TRACE_OPENCODE_MODEL ?? "";
  const timeoutMs = options.timeoutMs ?? 10000;
  let version: string;
  try {
    const result = await runBounded(binary, ["--version"], timeoutMs);
    if (result.code !== 0) throw new Error("version-failed");
    version = result.stdout.trim().replace(/^opencode\s+/i, "").replace(/^v/i, "");
  } catch {
    return {
      supported: false,
      unavailable: true,
      gap: "OpenCode CLI is not installed or could not report its version",
    };
  }
  let runFlags: string[];
  try {
    const result = await runBounded(binary, [...OPENCODE_RUN_ARGS.slice(0, 1), "--help"], timeoutMs);
    if (result.code !== 0) throw new Error("help-failed");
    runFlags = result.stdout
      .split(/\s+/)
      .map((entry) => entry.replace(/[.,;:]+$/, ""))
      .filter((entry) => entry.startsWith("--"));
  } catch {
    return {
      supported: false,
      version,
      gap: "installed OpenCode CLI could not enumerate `run` flags",
    };
  }
  if (options.verifyIsolation === undefined) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      ...(model !== "" ? { model } : {}),
      gap:
        "plugin-isolation-unproven: this server has no positive evidence that OpenCode excludes built-in tools and other agents for the generated wildcard-deny config",
    };
  }
  let evidence: OpenCodeIsolationEvidence | null;
  try {
    evidence = await options.verifyIsolation({ binary, version, model });
  } catch {
    evidence = null;
  }
  if (evidence === null) {
    return {
      supported: false,
      isolationVerified: false,
      version,
      gap: "plugin-isolation-unproven: isolation verification did not produce positive evidence",
    };
  }
  const inspection = inspectOpenCodeIsolation({ ...evidence, runFlags, version, model });
  return inspection;
}

/** Exported for tests: a resume handle is a session id, never a path. */
export { isSafeOpenCodeSessionId };
