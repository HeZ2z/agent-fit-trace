/**
 * Daemon plumbing for the acceptance harness.
 *
 * The desktop shell already owns the exact daemon startup contract (argv,
 * listen-line validation, health check, SIGTERM → SIGKILL). Rather than
 * reimplementing it, load the CJS module through `createRequire` and reuse
 * those functions. The harness starts its own daemon with `--port 0`, a fresh
 * temp data directory, and a built `app/dist`.
 */

import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

export interface SpawnDaemonOptions {
  nodePath: string;
  cliPath: string;
  dataDir?: string;
  distDir?: string;
  extensionPath?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  urlTimeoutMs?: number;
}

export interface SpawnedDaemon {
  child: ChildProcess;
  url: Promise<string>;
}

interface DaemonChildModule {
  spawnDaemon(options: SpawnDaemonOptions): SpawnedDaemon;
  stopDaemonChild(child: ChildProcess | null): Promise<void>;
  healthCheck(url: string): Promise<boolean>;
  parseDaemonUrl(text: string): string | null;
  STALE_JOURNAL_LOCK_EXIT_CODE: number;
}

const daemonChild = require(
  "../../packages/fit-trace-desktop/main/daemonChild.cjs",
) as DaemonChildModule;

/** Spawn the daemon with the desktop shell's validated listening contract. */
export function spawnVerificationDaemon(options: SpawnDaemonOptions): SpawnedDaemon {
  return daemonChild.spawnDaemon(options);
}

/** Stop a process this harness started (SIGTERM, then SIGKILL after a grace). */
export function stopOwnedProcess(child: ChildProcess | null): Promise<void> {
  return daemonChild.stopDaemonChild(child);
}

/** Outcome of a stop request that also confirms the OS reaped the process. */
export interface ConfirmedStop {
  /** The stop request was issued (true when no process was ever started). */
  stopped: boolean;
  /** `exitCode`/`signalCode` was observed before the deadline. */
  exitConfirmed: boolean;
  detail?: string;
}

/**
 * Stop an owned child and confirm it actually exited.
 *
 * The shared `stopDaemonChild` resolves on the kill-phase `error` event without
 * confirming death (production code intentionally stays lenient). Verification
 * needs the stronger contract: after the shared stop resolves, poll the child
 * handle until `exitCode`/`signalCode` is set or `graceMs` expires. An
 * unconfirmed exit is reported, never thrown — the manifest must still be
 * written.
 */
export async function stopConfirmed(
  child: ChildProcess | null,
  options: { graceMs: number; pollMs?: number },
): Promise<ConfirmedStop> {
  if (child === null) {
    return { stopped: true, exitConfirmed: true, detail: "process was never started" };
  }
  const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) return { stopped: true, exitConfirmed: true };

  let stopped = true;
  let detail: string | undefined;
  try {
    await withDeadline(stopOwnedProcess(child), options.graceMs + 5_000, "stopOwnedProcess");
  } catch (error) {
    stopped = false;
    detail = error instanceof Error ? error.message : String(error);
  }

  const pollMs = options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : 50;
  const deadline = Date.now() + options.graceMs;
  while (Date.now() < deadline) {
    if (hasExited()) return { stopped, exitConfirmed: true, ...(detail ? { detail } : {}) };
    await delay(pollMs);
  }
  return {
    stopped,
    exitConfirmed: hasExited(),
    detail: detail ?? `process ${String(child.pid ?? "?")} did not exit within ${options.graceMs}ms`,
  };
}

/** Resolve `promise` or reject with a labelled error after `ms`. */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** GET /api/v1/public-config health probe (never throws). */
export function daemonHealthCheck(url: string): Promise<boolean> {
  return daemonChild.healthCheck(url);
}

/** Parse the last loopback URL the daemon logged (diagnostic fallback). */
export function parseDaemonUrl(text: string): string | null {
  return daemonChild.parseDaemonUrl(text);
}

/** Daemon exit code for a stale coaching-journal lock. */
export const STALE_JOURNAL_LOCK_EXIT_CODE = daemonChild.STALE_JOURNAL_LOCK_EXIT_CODE;
