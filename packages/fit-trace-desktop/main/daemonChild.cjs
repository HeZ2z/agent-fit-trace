"use strict";

/**
 * Daemon child-process management for the desktop shell (issue #41).
 *
 * This module intentionally does NOT import electron: it is plain Node so it
 * can be unit-tested with `node:test` without an Electron runtime. The main
 * process (`main.cjs`) is the only electron-aware consumer.
 *
 * Responsibilities:
 *   - spawn `node <cli.ts|daemon.mjs> daemon --port 0 --data <dir> [--dist <dir>]`
 *     and resolve the daemon's loopback URL from its stdout
 *     ("listening at <url>");
 *   - health-check the daemon via GET /api/v1/public-config;
 *   - restart backoff planning (exponential 1s/2s/4s, capped at 4s);
 *   - stop with SIGTERM → 3s grace → SIGKILL (preserving the daemon's own
 *     SIGTERM shutdown semantics, see `docs/local-daemon.md`).
 */

const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

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
 * Daemon exit code for a fail-closed stale coaching-journal lock. Mirrors
 * `STALE_JOURNAL_LOCK_EXIT_CODE` in server/coaching/coachingJournal.ts.
 */
const STALE_JOURNAL_LOCK_EXIT_CODE = 3;

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
 * @param {string} options.nodePath absolute path to a node-compatible binary.
 *   Dev: a real `node` (NOT process.execPath, which is the Electron binary);
 *   packaged: the Electron binary re-entered as Node via
 *   `ELECTRON_RUN_AS_NODE=1`, which `main/paths.cjs` supplies.
 * @param {string} options.cliPath path to the daemon entry: the source
 *   `packages/fit-trace-cli/src/cli.ts` in dev, or the esbuild `daemon.mjs`
 *   bundle inside the packaged app's resources directory
 * @param {string | undefined} options.dataDir daemon data directory (--data);
 *   when omitted the daemon resolves its own default (`resolveDataDir`:
 *   `$FIT_TRACE_DATA_DIR` or `~/.fit-trace/data`)
 * @param {string | undefined} [options.distDir] built app shell directory
 *   (--dist). Omitted in dev so the daemon keeps its own `<repo>/app/dist`
 *   default; set in packaged builds, where that default resolves against the
 *   bundle and would be wrong.
 * @param {number} [options.port=0] preferred port; 0 lets the OS pick a free one
 * @param {NodeJS.ProcessEnv} [options.env] child environment (FIT_TRACE_DATA_DIR etc.)
 * @param {number} [options.urlTimeoutMs] how long to wait for the listen line
 *   before falling back / rejecting (default URL_TIMEOUT_MS; overridden by tests)
 * @returns {{ child: import("node:child_process").ChildProcess, url: Promise<string> }}
 *   `url` rejects if the child exits or stays silent past the timeout.
 */
function spawnDaemon({ nodePath, cliPath, dataDir, distDir, port = 0, env, urlTimeoutMs = URL_TIMEOUT_MS }) {
  const child = spawn(
    nodePath,
    [
      cliPath,
      "daemon",
      "--port",
      String(port),
      ...(dataDir ? ["--data", dataDir] : []),
      ...(distDir ? ["--dist", distDir] : []),
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
          // Never leave a possibly-live child behind: stop it (SIGTERM →
          // SIGKILL) before rejecting. Fire-and-forget on purpose — the url
          // promise must reject immediately, not wait out the 3s grace
          // period; a later stopDaemonChild() call remains safe (idempotent).
          void stopDaemonChild(child);
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
      // Covers spawn failures (e.g. a bad nodePath emits ENOENT here, not an
      // exception from spawn()) — surface it and fail the url promise.
      console.error(`[desktop] daemon spawn error: ${error instanceof Error ? error.message : String(error)}`);
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
        const error = new Error(`daemon exited before listening (code ${code ?? "signal"})`);
        // Carry the numeric exit code (if any) so the supervisor (main.cjs)
        // can react to specific daemon exit codes, e.g. the stale journal
        // lock reclaim path for STALE_JOURNAL_LOCK_EXIT_CODE.
        if (typeof code === "number") {
          error.exitCode = code;
        }
        reject(error);
      }
    });
  });

  return { child, url };
}

/**
 * Stop the daemon: SIGTERM, then SIGKILL after the grace period if it is
 * still alive. Resolves once the child is gone. Safe to call twice.
 *
 * A child that never successfully spawned (e.g. a bad nodePath: `pid` is
 * undefined and no "exit" event will ever fire) counts as already stopped,
 * and a kill-phase "error" event resolves instead of hanging the promise.
 *
 * @param {import("node:child_process").ChildProcess | null} child
 * @returns {Promise<void>}
 */
function stopDaemonChild(child) {
  return new Promise((resolve) => {
    if (
      child === null ||
      child.pid == null ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      // Never spawned or already gone: nothing to kill.
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
    // A kill-phase error (e.g. EPERM) must not leave the promise pending.
    child.once("error", () => {
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

/**
 * Reclaim a coaching-journal lock left behind by a confirmed-dead daemon
 * (e.g. one the shell SIGKILLed or that was killed externally). The journal
 * lock itself fail-closes on a dead owner (see
 * server/coaching/coachingJournal.ts `acquireCoachingJournalLock`); the shell
 * owns the daemon process tree, so it is the one component allowed to remove
 * the stale file out of band.
 *
 * Lock path mirrors the daemon exactly: daemonServer.ts joins
 * `coaching-journal.json` under the data dir and
 * `acquireCoachingJournalLock` appends `.lock`.
 *
 * Fails closed: only a readable lock whose pid is confirmed dead via
 * `process.kill(pid, 0)` throwing ESRCH is reclaimed. A live owner, an
 * unreadable/absent lock file, an unconfirmable pid (EPERM), or a missing
 * data dir all leave the filesystem untouched.
 *
 * @param {string | undefined} dataDir daemon data directory (must be known;
 *   the daemon's own default dir is unknowable here, so undefined is a no-op)
 * @returns {number | false} the dead owner's pid when the lock was removed,
 *   false otherwise (the pid feeds the retry log line)
 */
function reclaimStaleJournalLock(dataDir) {
  if (!dataDir) {
    return false;
  }
  const lockPath = path.join(dataDir, "coaching-journal.json.lock");
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    // Missing or unreadable: nothing safely reclaimable.
    return false;
  }
  const pid = owner !== null && typeof owner === "object" ? owner.pid : null;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    // Owner is alive (or unconfirmable without an error): not ours to remove.
    return false;
  } catch (error) {
    if ((error ?? {}).code !== "ESRCH") {
      // EPERM etc: pid exists but death is not confirmed — fail closed.
      return false;
    }
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    return false;
  }
  return pid;
}

module.exports = {
  LISTEN_LINE_RE,
  LOOPBACK_URL_RE,
  URL_TIMEOUT_MS,
  STOP_GRACE_MS,
  HEALTH_TIMEOUT_MS,
  STALE_JOURNAL_LOCK_EXIT_CODE,
  parseDaemonUrl,
  nextRestartDelay,
  healthCheck,
  spawnDaemon,
  stopDaemonChild,
  reclaimStaleJournalLock,
};
