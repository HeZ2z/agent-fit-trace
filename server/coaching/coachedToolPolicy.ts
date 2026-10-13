/**
 * Read-only tool policy for coached runs (analysis-only seam).
 *
 * Coached runs may expose ONLY `get_training_history` + `analyze_progress`.
 * Everything else — `generate_next_plan`, `import_workout`, built-in
 * `read`/`write`/`bash`/`edit`/`grep`/`find`/`ls`/`powershell`, and any
 * unknown tool — is refused BEFORE any start event is emitted.
 *
 * Frame shapes follow the installed pi docs exactly (rpc.md:1012-1054):
 * `tool_execution_start` / `tool_execution_end` carry `toolName` +
 * `toolCallId`; the end frame carries `result: { content, details }` plus
 * `isError`. `analyze_progress` details are validated through the shared
 * `parseAnalysisResult` guard; missing or malformed details are a tool
 * failure, never a result.
 *
 * Extension-UI dialogs (`select`/`confirm`/`input`/`editor`, rpc.md:1184+)
 * are never auto-approved: the adapter must answer dialog requests with an
 * explicit `extension_ui_response` denial (`cancelled: true`, unblocking the
 * extension) and fail the run.
 */
import { COACHED_TOOL_NAMES, parseAnalysisResult } from "@pi-fit-trace/api-contracts";

export const COACHED_ALLOWLIST = COACHED_TOOL_NAMES;

export type CoachedToolName = (typeof COACHED_ALLOWLIST)[number];

/** Tools that must never run inside a coached run (explicit denylist). */
export const COACHED_DENYLIST = [
  "generate_next_plan",
  "import_workout",
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "powershell",
] as const;

export function isCoachedToolAllowed(tool: string): tool is CoachedToolName {
  return (COACHED_ALLOWLIST as readonly string[]).includes(tool);
}

export interface CoachedToolStart {
  toolName: string;
  toolCallId: string;
}

export type CoachedToolStartDisposition =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Gate a `tool_execution_start` frame. Unknown/non-allowlisted tools are
 * refused here so the adapter never emits a `tool_start` event for them
 * (no start-then-refuse).
 */
export function classifyCoachedToolStart(start: CoachedToolStart): CoachedToolStartDisposition {
  if (!isCoachedToolAllowed(start.toolName)) {
    return {
      allowed: false,
      reason: `tool ${JSON.stringify(start.toolName)} is not allowlisted for coached runs`,
    };
  }
  return { allowed: true };
}

/** Real `tool_execution_end` frame shape (rpc.md:1040-1054). */
export interface CoachedToolEnd {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  /** `result` payload of the end frame; absent/null when the tool errored. */
  result?: { content?: unknown; details?: unknown } | null;
  /** Transport-level error text, if any accompanied the frame. */
  errorText?: string;
}

export type CoachedToolOutcome =
  | { kind: "analysis_result"; result: ReturnType<typeof parseAnalysisResult> }
  | { kind: "tool_end"; ok: boolean; summary?: string; error?: string }
  | { kind: "refused"; reason: string };

/**
 * Fixed safe fallback for arbitrary upstream error text. Raw upstream text
 * (transport errors, provider messages, extension payloads, OS process
 * errors, frames) can carry credentials, tokens, paths, or request bodies,
 * so it is NEVER echoed into events/reasons - not even truncated or
 * single-lined (truncation still leaks the prefix and misleads). Callers
 * pass a fixed fallback code and that fallback is returned verbatim.
 * Structured domain errors (refusals, timeouts, pending-tool lists) keep
 * their own fixed messages at the call site.
 */
export function toSafeToolError(_message: unknown, fallback: string): string {
  return fallback;
}

/**
 * Classify a finished tool call. Non-allowlisted tools are refused (the
 * adapter turns this into a run error; the run can never complete).
 * `analyze_progress` requires `result.details`: missing or malformed
 * details are a tool failure, never success.
 */
export function classifyCoachedToolEnd(end: CoachedToolEnd): CoachedToolOutcome {
  if (!isCoachedToolAllowed(end.toolName)) {
    return {
      kind: "refused",
      reason: `tool ${JSON.stringify(end.toolName)} is not allowlisted for coached runs`,
    };
  }
  if (end.isError) {
    return {
      kind: "tool_end",
      ok: false,
      error: toSafeToolError(end.errorText, `${end.toolName} failed`),
    };
  }
  if (end.toolName === "analyze_progress") {
    if (end.result === undefined || end.result === null || end.result.details === undefined) {
      return {
        kind: "tool_end",
        ok: false,
        error: "analyze_progress returned no details: refusing to treat it as a result",
      };
    }
    try {
      return { kind: "analysis_result", result: parseAnalysisResult(end.result.details) };
    } catch {
      // Never echo the raw details/parse error: payloads may carry
      // credentials, paths, or bodies. Fixed code, bounded message.
      return {
        kind: "tool_end",
        ok: false,
        error: "analyze_progress returned malformed details: refusing to treat it as a result",
      };
    }
  }
  return { kind: "tool_end", ok: true };
}

/** Dialog methods block the extension until the client responds. */
const EXTENSION_UI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Fire-and-forget methods expect no response and are safe to ignore. */
const EXTENSION_UI_NOTIFY_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

export type ExtensionUiDisposition =
  | { action: "deny"; reason: string }
  | { action: "ignore" };

/**
 * Decide how the adapter handles an `extension_ui_request`. Dialog methods
 * are denied: the adapter must send
 * `{type:"extension_ui_response", id, cancelled:true}` to unblock the
 * extension, emit a run error, and fail the run. Anything else is ignored.
 */
export function classifyExtensionUiRequest(method: string): ExtensionUiDisposition {
  if (EXTENSION_UI_DIALOG_METHODS.has(method)) {
    return {
      action: "deny",
      reason: `extension UI dialog ${JSON.stringify(method)} is never approved in coached runs`,
    };
  }
  if (EXTENSION_UI_NOTIFY_METHODS.has(method)) {
    return { action: "ignore" };
  }
  return { action: "deny", reason: `unknown extension UI method ${JSON.stringify(method)} refused` };
}
