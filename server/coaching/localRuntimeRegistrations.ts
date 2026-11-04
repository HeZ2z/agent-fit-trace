/**
 * Shared construction of the LOCAL coaching backend registrations.
 *
 * Both entry points advertise local coaching backends, but they are NOT the
 * same product surface: `start` keeps its fixed-upstream proxy contract and
 * registers pi plus the ONE alternative the operator selected, while the
 * daemon serves a local SQLite data plane and must report every installed CLI
 * truthfully so a settings page can render it (#68). What they genuinely share
 * is narrower and worth exactly one module: the probe result → registration
 * mapping, the factories behind it, and the reason vocabulary.
 *
 * Two rules this module exists to keep true:
 *
 * 1. **The isolation gates are the product.** Installing a CLI does not make
 *    it usable. Codex needs positive evidence that the installed app-server
 *    can exclude its entire built-in tool inventory; OpenCode needs positive
 *    evidence of the wildcard-deny/plugin-only surface. Neither probe produces
 *    that evidence today, so both stay unavailable with a concrete `gap`.
 *    `resolveLocalCodexRegistration`/`resolveLocalOpenCodeRegistration` are the
 *    ONLY production paths that turn a probe into an availability claim, and
 *    they are deliberately not parameterised by a "force"/"trust" flag: there
 *    is no call site that may bypass the gate.
 *
 * 2. **Absence is a different fact than incapability.** A missing CLI is
 *    `cli-not-installed` (install it); a present CLI whose schema or version
 *    cannot prove isolation is `cli-version-unsupported` (nothing the user can
 *    install fixes it). Flattening the two sends people to fix the wrong thing.
 *
 * Nothing here decides WHICH backends to advertise — callers do, because their
 * policies differ (see above). This module only decides what each one is
 * allowed to claim.
 */
import type { CoachingAvailabilityReason } from "@agent-fit-trace/api-contracts";
import { CoachedCodexAppServer } from "./codexAppServerAdapter.ts";
import {
  probeCodexAppServer,
} from "./codexAppServerCapability.ts";
import type { CodexAppServerSupport } from "./codexAppServerCapability.ts";
import { CoachedOpenCodeRun } from "./opencodeServerAdapter.ts";
import { probeOpenCodeRun } from "./opencodeCapability.ts";
import type { OpenCodeIsolationEvidence, OpenCodeRunSupport } from "./opencodeCapability.ts";
import { CoachedPiProcess } from "./piProcessAdapter.ts";
import type { CoachingRuntimeRegistration, RuntimeFactory } from "./runtimeRegistry.ts";

/** Display names are part of the wire payload; keep one spelling. */
export const LOCAL_PI_DISPLAY_NAME = "pi CLI (local)";
export const LOCAL_CODEX_DISPLAY_NAME = "Codex CLI (local)";
export const LOCAL_OPENCODE_DISPLAY_NAME = "OpenCode CLI (local)";

/**
 * Capability overrides for a backend whose adapter HAS passed its gate.
 * Native continuation is a codex-thread / opencode-session id, and both
 * adapters confirm cancellation by observing process exit.
 */
const GATED_CLI_CAPABILITIES = {
  nativeContinuation: true,
  cancelConfirmation: "process-exit",
} as const;

/** Concrete missing capability when a probe found no `gap` of its own. */
const DEFAULT_CODEX_GAP =
  "the installed Codex app-server cannot guarantee an isolated read-only tool surface";
const DEFAULT_OPENCODE_GAP =
  "the installed OpenCode CLI cannot prove an isolated plugin-only tool surface";

/**
 * One reason code for both gates. `unavailable` means the CLI itself could not
 * be executed (ENOENT, a non-zero `--version`, a missing schema generator);
 * everything else means the CLI ran but could not prove isolation.
 */
function gateReason(
  support: { unavailable?: boolean; gap?: string },
  fallback: string,
): CoachingAvailabilityReason {
  return {
    code: support.unavailable === true ? "cli-not-installed" : "cli-version-unsupported",
    message: support.gap ?? fallback,
  };
}

// --- runtime factories -----------------------------------------------------

/**
 * pi runtime factory: the launch's own immutable snapshot file, per-run
 * snapshot dir, fixed per-session native dir, and resume handle flow straight
 * into the coached pi process — the factory invents no paths.
 */
export function piRuntimeFactory(extensionPath: string, cwd: string): RuntimeFactory {
  return (launch) =>
    new CoachedPiProcess({
      sessionId: launch.sessionId,
      runId: launch.runId,
      prompt: launch.prompt,
      snapshotFile: launch.snapshotFile,
      snapshotDir: launch.snapshotDir,
      sessionDir: launch.sessionDir,
      ...(launch.resumeSessionFile !== undefined ? { resumeSessionFile: launch.resumeSessionFile } : {}),
      extensionPath,
      cwd,
      onEvent: launch.onEvent,
      onDone: launch.onDone,
    });
}

/**
 * Fail-clear runtime factory used when the pi CLI is missing and no test
 * factory was injected: runs report a clear "pi unavailable" failure instead
 * of a generic spawn error.
 */
export function unavailablePiRuntimeFactory(): RuntimeFactory {
  return (launch) => ({
    start(): void {
      setImmediate(() => {
        launch.onEvent({
          type: "run_error",
          code: "PI_UNAVAILABLE",
          message: "pi CLI is not available on PATH — workout tracking works; install pi to run coaching.",
        });
        launch.onDone("failed", "pi CLI is not available on PATH — install pi to run coaching.", {
          processExitConfirmed: true,
        });
      });
    },
    cancel(_reason?: string): void {
      void _reason;
    },
    async close(): Promise<void> {},
  });
}

/**
 * Codex runtime factory: the child gets a controlled empty working directory,
 * the launch's immutable snapshot stays in this process, and a stored native
 * handle is resumed only when the service already matched it to this backend.
 */
export function codexRuntimeFactory(options: { binary?: string }): RuntimeFactory {
  return (launch) =>
    new CoachedCodexAppServer({
      sessionId: launch.sessionId,
      runId: launch.runId,
      prompt: launch.prompt,
      snapshotFile: launch.snapshotFile,
      sessionDir: launch.sessionDir,
      // Controlled per-product-session directory; never the snapshot dir.
      cwd: launch.sessionDir,
      ...(options.binary !== undefined ? { codexBinary: options.binary } : {}),
      ...(launch.resumeNativeSessionHandle !== undefined
        ? { resumeNativeSessionHandle: launch.resumeNativeSessionHandle }
        : {}),
      onEvent: launch.onEvent,
      onDone: launch.onDone,
    });
}

/**
 * OpenCode runtime factory: one private `opencode run --standalone` per run,
 * isolated roots under the launch's session dir, generated wildcard-deny
 * config, and a generated plugin that calls the in-process domain bridge.
 */
export function openCodeRuntimeFactory(options: {
  binary?: string;
  model: string;
}): RuntimeFactory {
  return (launch) =>
    new CoachedOpenCodeRun({
      sessionId: launch.sessionId,
      runId: launch.runId,
      prompt: launch.prompt,
      snapshotFile: launch.snapshotFile,
      sessionDir: launch.sessionDir,
      cwd: launch.sessionDir,
      model: options.model,
      ...(options.binary !== undefined ? { opencodeBinary: options.binary } : {}),
      ...(launch.resumeNativeSessionHandle !== undefined
        ? { resumeNativeSessionHandle: launch.resumeNativeSessionHandle }
        : {}),
      isolationVerified: true,
      onEvent: launch.onEvent,
      onDone: launch.onDone,
    });
}

// --- registrations ---------------------------------------------------------

export interface LocalPiRegistrationInput {
  available: boolean;
  /** Required when unavailable; ignored when available. */
  reason?: CoachingAvailabilityReason;
  /** Version reported by the presence probe, when one ran. */
  version?: string;
  factory: RuntimeFactory;
}

/**
 * The legacy local-pi registration. Unchanged in meaning from issue #7: it is
 * available only when a factory can actually start a run, and an unavailable
 * entry always carries the reason the caller resolved (a missing CLI and a
 * missing extension are different diagnoses).
 */
export function localPiRegistration(input: LocalPiRegistrationInput): CoachingRuntimeRegistration {
  return {
    backendId: "local-pi",
    runtimeId: "pi",
    executionLocation: "local",
    displayName: LOCAL_PI_DISPLAY_NAME,
    available: input.available,
    ...(input.available
      ? {}
      : {
          unavailableReason: input.reason ?? {
            code: "cli-not-installed" as const,
            message: "pi CLI is not available on PATH.",
          },
        }),
    ...(input.version !== undefined ? { version: input.version } : {}),
    factory: input.factory,
  };
}

export interface LocalCodexRegistrationOptions {
  /** `codex` binary name or resolved path (default `codex`). */
  binary?: string;
}

/**
 * Map a Codex app-server probe to a registration.
 *
 * The gate is `supported && builtinIsolationVerified === true`, and it is
 * checked HERE rather than in the probe so a probe that is (or becomes) lax
 * cannot advertise the backend: `dynamicTools` is additive and leaves
 * shell/file/network/MCP/hook/plugin tools reachable, so anything short of
 * positive built-in exclusion means "not selectable".
 */
export function resolveLocalCodexRegistration(
  support: CodexAppServerSupport,
  options: LocalCodexRegistrationOptions = {},
): CoachingRuntimeRegistration {
  if (support.supported && support.builtinIsolationVerified === true) {
    return {
      backendId: "local-codex",
      runtimeId: "codex",
      executionLocation: "local",
      displayName: LOCAL_CODEX_DISPLAY_NAME,
      available: true,
      ...(support.version !== undefined ? { version: support.version } : {}),
      capabilities: { ...GATED_CLI_CAPABILITIES },
      factory: codexRuntimeFactory(options.binary !== undefined ? { binary: options.binary } : {}),
    };
  }
  return {
    backendId: "local-codex",
    runtimeId: "codex",
    executionLocation: "local",
    displayName: LOCAL_CODEX_DISPLAY_NAME,
    available: false,
    unavailableReason: gateReason(support, DEFAULT_CODEX_GAP),
    // Deliberately no `version` here: `start` has always reported version only
    // on an available backend, and this module must not change that payload.
  };
}

export interface LocalOpenCodeRegistrationOptions {
  /** `opencode` binary name or resolved path (default `opencode`). */
  binary?: string;
}

/**
 * Map an OpenCode probe to a registration.
 *
 * The gate is `supported && isolationVerified === true && model !== ""`: a
 * wildcard deny is only trustworthy with positive evidence for the installed
 * version, and `opencode run` cannot start without a provider/model. The model
 * is read from the probe first so a model discovered at probe time is the one
 * the factory runs with — discovery and execution must not disagree.
 */
export function resolveLocalOpenCodeRegistration(
  support: OpenCodeRunSupport,
  options: LocalOpenCodeRegistrationOptions & { model?: string } = {},
): CoachingRuntimeRegistration {
  const model = support.model ?? options.model ?? "";
  if (support.supported && support.isolationVerified === true && model !== "") {
    return {
      backendId: "local-opencode",
      runtimeId: "opencode",
      executionLocation: "local",
      displayName: LOCAL_OPENCODE_DISPLAY_NAME,
      available: true,
      ...(support.version !== undefined ? { version: support.version } : {}),
      capabilities: { ...GATED_CLI_CAPABILITIES },
      factory: openCodeRuntimeFactory({
        ...(options.binary !== undefined ? { binary: options.binary } : {}),
        model,
      }),
    };
  }
  return {
    backendId: "local-opencode",
    runtimeId: "opencode",
    executionLocation: "local",
    displayName: LOCAL_OPENCODE_DISPLAY_NAME,
    available: false,
    unavailableReason: gateReason(support, DEFAULT_OPENCODE_GAP),
    // Same rule as Codex: version is reported for available backends only.
  };
}

// --- probes ----------------------------------------------------------------

export interface LocalCodexProbeOptions {
  binary?: string;
  /** Injected capability (tests / callers that already probed). */
  support?: CodexAppServerSupport;
  /** Test seam: replaces the installed-CLI probe. */
  probe?: (binary: string | undefined) => Promise<CodexAppServerSupport>;
}

/**
 * Probe the installed Codex CLI and map it. Kept here (not at each call site)
 * so `start` and the daemon cannot drift into probing different things.
 */
export async function probeLocalCodex(
  options: LocalCodexProbeOptions = {},
): Promise<CodexAppServerSupport> {
  if (options.support !== undefined) return options.support;
  if (options.probe !== undefined) return options.probe(options.binary);
  return probeCodexAppServer(options.binary !== undefined ? { binary: options.binary } : {});
}

export interface LocalOpenCodeProbeOptions {
  binary?: string;
  model?: string;
  /** Injected capability (tests / callers that already probed). */
  support?: OpenCodeRunSupport;
  /**
   * Positive isolation evidence. Production supplies none, which is exactly
   * why the backend stays unavailable; an operator/test verifier is the only
   * way to reach `isolationVerified: true`.
   */
  verifyIsolation?: (context: {
    binary: string;
    version: string;
    model: string;
  }) => Promise<OpenCodeIsolationEvidence | null>;
  /** Test seam: replaces the installed-CLI probe. */
  probe?: (options: {
    binary?: string;
    model?: string;
    verifyIsolation?: LocalOpenCodeProbeOptions["verifyIsolation"];
  }) => Promise<OpenCodeRunSupport>;
}

export async function probeLocalOpenCode(
  options: LocalOpenCodeProbeOptions = {},
): Promise<OpenCodeRunSupport> {
  if (options.support !== undefined) return options.support;
  if (options.probe !== undefined) {
    return options.probe({
      ...(options.binary !== undefined ? { binary: options.binary } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.verifyIsolation !== undefined ? { verifyIsolation: options.verifyIsolation } : {}),
    });
  }
  return probeOpenCodeRun({
    ...(options.binary !== undefined ? { binary: options.binary } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.verifyIsolation !== undefined ? { verifyIsolation: options.verifyIsolation } : {}),
  });
}
