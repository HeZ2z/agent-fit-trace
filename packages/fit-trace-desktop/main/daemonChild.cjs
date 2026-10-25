"use strict";

/**
 * Daemon child-process management for the desktop shell (issue #41).
 *
 * This module intentionally does NOT import electron: it is plain Node so it
 * can be unit-tested with `node:test` without an Electron runtime. The main
 * process (`main.cjs`) is the only electron-aware consumer.
 *
 * Responsibilities:
 *   - spawn `node <cli.ts> daemon --port 0 --data <dir>` and resolve the
 *     daemon's loopback URL from its stdout ("listening at <url>");
 *   - health-check the daemon via GET /api/v1/public-config;
 *   - restart backoff planning (exponential 1s/2s/4s, capped at 4s);
 *   - stop with SIGTERM → 3s grace → SIGKILL (preserving the daemon's own
 *     SIGTERM shutdown semantics, see `docs/local-daemon.md`).
 */

const { spawn } = require("node:child_process");
const http = require("node:http");

/** The daemon prints exactly one of these on startup (`packages/fit-trace-cli/src/cli.ts`). */
const LISTEN_LINE_RE = /listening at (https?:\/\/[^\s]+)/;
/** Fallback: any loopback URL the daemon logged (covers alternate port lines). */
const LOOPBACK_URL_RE = /https?:\/\/127\.0\.0\.1:\d+/;

/** How long to keep reading stdout for the listen line before falling back. */
const URL_TIMEOUT_MS = 15_000;
/** Grace period between SIGTERM and SIGKILL. */
const STOP_GRACE_MS = 3_000;
/** Per-request timeout for health checks. */
const HEALTH_TIMEOUT_MS = 2_000;

/**
 * Extract a daemon URL from accumulated stdout text.
 * Prefers the canonical "listening at <url>" line; falls back to any loopback
 * URL in the output (e.g. a "falls forward" port line). Returns null if none.
 *
 * @param {string} text accumulated stdout
 * @returns {string | null}
 */
function parseDaemonUrl(text) {
  const listen = LISTEN_LINE_RE.exec(text);
  if (listen) {
    return listen[1];
  }
  const fallback = LOOPBACK_URL_RE.exec(text);
  return fallback ? fallback[0] : null;
}

/**
 * Restart delay for the Nth restart attempt (1-based): exponential 1s/2s/4s,
 * then stays at 4s forever. Pure function so the planner is unit-testable.
 *
 * @param {number} attempt 1-based restart attempt number
 * @returns {number} delay in milliseconds
 */
function nextRestartDelay(attempt) {
  return Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 4000);
}

/**
 * GET `<url>/api/v1/public-config` and resolve true iff the daemon answers
 * within the timeout with a 2xx status. Never throws.
 *
 * @param {string} url daemon base URL (no trailing slash)
 * @returns {Promise<boolean>}
 */
function healthCheck(url) {
  return new Promise((resolve) => {
    const base = url.replace(/\/+$/, "");
    const request = http.get(`${base}/api/v1/public-config`, { timeout: HEALTH_TIMEOUT_MS }, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

/**
 * Spawn the daemon and resolve its loopback URL once stdout announces it.
 *
 * @param {object} options
 * @param {string} options.nodePath absolute path to a real node binary
 *   (NOT process.execPath, which is the Electron binary inside the shell)
 * @param {string} options.cliPath path to packages/fit-trace-cli/src/cli.ts
 * @param {string | undefined} options.dataDir daemon data directory (--data);
 *   when omitted the daemon resolves its own default (`resolveDataDir`:
 *   `$FIT_TRACE_DATA_DIR` or `~/.fit-trace/data`)
 * @param {number} [options.port=0] preferred port; 0 lets the OS pick a free one
 * @param {NodeJS.ProcessEnv} [options.env] child environment (FIT_TRACE_DATA_DIR etc.)
 * @param {number} [options.urlTimeoutMs] how long to wait for the listen line
 *   before falling back / rejecting (default URL_TIMEOUT_MS; overridden by tests)
 * @returns {{ child: import("node:child_process").ChildProcess, url: Promise<string> }}
 *   `url` rejects if the child exits or stays silent past the timeout.
 */
function spawnDaemon({ nodePath, cliPath, dataDir, port = 0, env, urlTimeoutMs = URL_TIMEOUT_MS }) {
  const child = spawn(
    nodePath,
    [
      cliPath,
      "daemon",
      "--port",
      String(port),
      ...(dataDir ? ["--data", dataDir] : []),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const url = new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        // Timeout: try whatever the daemon logged so far before giving up.
        const parsed = parseDaemonUrl(stdout);
        if (parsed) {
          resolve(parsed);
        } else {
          reject(new Error(`daemon did not report a listen URL within ${urlTimeoutMs}ms`));
        }
      }
    }, urlTimeoutMs);
    const settle = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const parsed = parseDaemonUrl(stdout);
      if (parsed) {
        settle(parsed);
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`daemon exited before listening (code ${code ?? "signal"})`));
      }
    });
  });

  return { child, url };
}

/**
 * Stop the daemon: SIGTERM, then SIGKILL after the grace period if it is
 * still alive. Resolves once the child is gone. Safe to call twice.
 *
 * @param {import("node:child_process").ChildProcess | null} child
 * @returns {Promise<void>}
 */
function stopDaemonChild(child) {
  return new Promise((resolve) => {
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

module.exports = {
  LISTEN_LINE_RE,
  LOOPBACK_URL_RE,
  URL_TIMEOUT_MS,
  STOP_GRACE_MS,
  HEALTH_TIMEOUT_MS,
  parseDaemonUrl,
  nextRestartDelay,
  healthCheck,
  spawnDaemon,
  stopDaemonChild,
};
