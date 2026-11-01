import { spawn } from "node:child_process";
import type { CoachingRuntimeId } from "@agent-fit-trace/api-contracts";
import {
  isCoachingRuntimeId,
  resolveCoachingBackendSelection,
} from "@agent-fit-trace/api-contracts";

/**
 * Launcher configuration: every value is operator-configured (flags or
 * environment). The browser never supplies the upstream URL, port, or dist
 * path — the proxy target is fixed at startup.
 */

export const BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 5198;
export const DEFAULT_UPSTREAM_ENV = "FIT_TRACE_API_BASE_URL";

export interface LauncherFlags {
  port?: number;
  noOpen?: boolean;
  upstream?: string;
  dist?: string;
  runtime?: string;
  /** `daemon` only: data directory. `start` never reads it. */
  data?: string;
  /**
   * `daemon` only: absolute path to the pi extension coached runs load.
   *
   * Packaged builds must set this — the default is derived from
   * `import.meta.url` and is only correct in a source checkout. When set, the
   * path also decides `local-pi` availability, so a missing extension is
   * reported instead of advertised.
   */
  extension?: string;
}

export interface ResolvedLauncherConfig {
  upstreamBaseUrl: string;
  port: number;
  distDir: string;
  noOpen: boolean;
  /** Configured local runtime (default pi). */
  runtimeId: CoachingRuntimeId;
}

/** Absolute http(s) URL without query, credentials, or fragment. */
export function normalizeUpstreamBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new Error("fixed upstream base URL is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "fixed upstream base URL must be an absolute http(s) URL " +
        "(for example https://<your-app>.vercel.app/api/v1)",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("fixed upstream base URL must be http(s)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("fixed upstream base URL must not embed credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("fixed upstream base URL must not include a query or fragment");
  }
  return trimmed;
}

export function resolveLauncherConfig(
  env: Record<string, string | undefined>,
  flags: LauncherFlags,
  repoRoot: string,
): ResolvedLauncherConfig {
  const upstreamRaw = flags.upstream ?? env[DEFAULT_UPSTREAM_ENV] ?? "";
  const upstreamBaseUrl = normalizeUpstreamBaseUrl(upstreamRaw);
  const portRaw = flags.port ?? Number(env.FIT_TRACE_COACH_PORT ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error(`invalid launcher port: ${String(flags.port ?? env.FIT_TRACE_COACH_PORT)}`);
  }
  // An empty-string dist (e.g. an unexpanded template placeholder) must not
  // resolve to the process cwd — treat it as unset and use the repo default.
  const distRaw = flags.dist ?? env.FIT_TRACE_APP_DIST;
  const distDir = distRaw === undefined || distRaw.trim() === "" ? `${repoRoot}/app/dist` : distRaw;
  const runtimeRaw = flags.runtime ?? env.FIT_TRACE_RUNTIME ?? "pi";
  if (!isCoachingRuntimeId(runtimeRaw)) {
    throw new Error(`invalid coaching runtime: ${runtimeRaw} (expected pi, codex, opencode, or hosted-sdk)`);
  }
  const selection = resolveCoachingBackendSelection({ runtimeId: runtimeRaw });
  if (selection.executionLocation !== "local") {
    throw new Error(`the local launcher cannot configure the ${runtimeRaw} cloud runtime`);
  }
  return {
    upstreamBaseUrl,
    port: portRaw,
    distDir,
    noOpen: flags.noOpen ?? false,
    runtimeId: runtimeRaw,
  };
}

/** Open only exact loopback URLs in a browser (argv array, no shell). */
export function isSafeOpenUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return true;
}

/** Fail fast on an unsupported runtime; the repo requires Node >= 24. */
export function checkNodeRuntime(version = process.versions.node): void {
  const major = Number(version.split(".")[0] ?? "0");
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new Error(`fit-trace launcher requires Node >= 24 (current: ${version})`);
  }
}

export interface PiPresence {
  available: boolean;
  version: string | null;
}

/**
 * Report pi CLI presence without invoking any model: `pi --version` only,
 * argv array (no shell), bounded timeout. Missing pi never blocks the
 * launcher — workout tracking works; coaching runs report unconfigured.
 * The `--version` output is a presence signal only, never an auth claim.
 * Stdout/stderr are bounded (4 KiB each); the kill timer is cleared on
 * settle and the child is killed when the bound is exceeded.
 */
const MAX_PI_PROBE_BYTES = 4 * 1024;

export function checkPiCli(timeoutMs = 5000): Promise<PiPresence> {
  return new Promise((resolve) => {
    let settled = false;
    let stdoutBytes = 0;
    let stdoutCapped = false;
    let output = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (value: PiPresence): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      if (stdoutCapped) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PI_PROBE_BYTES) {
        stdoutCapped = true;
        return;
      }
      output += chunk.toString("utf8");
    };
    try {
      const child = spawn("pi", ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
      child.stdout?.on("data", onData);
      // Drain stderr boundedly so a verbose pi cannot hold the pipe open.
      child.stderr?.on("data", () => undefined);
      child.on("error", () => done({ available: false, version: null }));
      child.on("close", (code) => {
        if (stdoutCapped) {
          done({ available: false, version: null });
          return;
        }
        if (code === 0) done({ available: true, version: output.trim().slice(0, 120) || null });
        else done({ available: false, version: null });
      });
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort; the close handler settles the result.
        }
        done({ available: false, version: null });
      }, timeoutMs);
      killTimer.unref?.();
    } catch {
      done({ available: false, version: null });
    }
  });
}
