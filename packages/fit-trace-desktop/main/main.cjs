"use strict";

/**
 * Electron main process for the fit-trace desktop shell (issue #41).
 *
 * INTENTIONAL CONSTRAINT — zero custom IPC: the desktop shell is a carrier,
 * not a second application. The renderer is the ordinary web app served by
 * the daemon at the loopback URL; it needs no boot injection, no bridge, and
 * no privileged channel in v1. There is deliberately no `ipcMain`/`ipcRenderer`
 * usage in this package; revisit only when a native capability truly cannot
 * live behind the daemon's HTTP surface.
 *
 * Lifecycle:
 *   1. single-instance lock (second launch focuses the existing window);
 *   2. spawn the daemon (`node cli.ts daemon --port 0 --data <dir>`);
 *   3. BrowserWindow (contextIsolation, sandbox, no nodeIntegration) loads
 *      the daemon URL;
 *   4. health poll every 5s: two consecutive failures trigger a daemon
 *      restart with exponential backoff; the window shows a retry page until
 *      the daemon is back, then reloads it;
 *   5. three restarts without recovery → error dialog and quit; a failed
 *      first boot goes through the same restart/backoff path and only builds
 *      the window once a daemon URL exists (bootShell);
 *   6. window-all-closed / app quit → daemon.stop() (SIGTERM → SIGKILL);
 *      before-quit defers the quit until the daemon is actually stopped.
 */

const path = require("node:path");
const { app, BrowserWindow, dialog } = require("electron");
const { healthCheck, nextRestartDelay, spawnDaemon, stopDaemonChild } = require("./daemonChild.cjs");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "packages", "fit-trace-cli", "src", "cli.ts");
const DATA_DIR = process.env.FIT_TRACE_DATA_DIR || undefined;
/** Health poll cadence. */
const HEALTH_POLL_MS = 5_000;
/** Consecutive failed polls before a restart is scheduled. */
const FAILED_POLLS_TO_RESTART = 2;
/** Restart attempts allowed before the shell gives up. */
const MAX_RESTARTS = 3;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {ReturnType<typeof spawnDaemon> | null} */
let daemon = null;
/** @type {string | null} */
let daemonUrl = null;
/** @type {NodeJS.Timeout | null} */
let healthTimer = null;
let consecutiveFailures = 0;
let restartAttempts = 0;
let stopping = false;
let restarting = false;
/** True once a quit has been deferred pending daemon cleanup (before-quit). */
let quitRequested = false;

const RETRY_PAGE_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    "<!doctype html><title>fit-trace</title>" +
      '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#666">' +
      "<p>fit-trace daemon is restarting…</p></body>",
  );

/**
 * Resolve a real node binary. Inside the Electron main process
 * `process.execPath` is the Electron binary itself, which cannot run the
 * CLI; dev.cjs passes the node that started it via this env var.
 */
function resolveNodePath() {
  const fromEnv = process.env.FIT_TRACE_DESKTOP_NODE;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return "node";
}

function startDaemon() {
  daemon = spawnDaemon({
    nodePath: resolveNodePath(),
    cliPath: CLI_PATH,
    // FIT_TRACE_DATA_DIR passes through the env untouched (dev.cjs inherits
    // the caller's environment); unset means the daemon applies its own
    // default resolution ($FIT_TRACE_DATA_DIR or ~/.fit-trace/data).
    dataDir: DATA_DIR,
    port: 0,
    env: process.env,
  });
  daemon.child.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  daemon.child.stderr.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));
  daemon.child.once("exit", (code) => {
    if (!stopping) {
      console.log(`[desktop] daemon exited (code ${code ?? "signal"})`);
    }
  });
  return daemon.url.then((url) => {
    daemonUrl = url;
    console.log(`[desktop] daemon at ${url}`);
  });
}

async function restartDaemon() {
  if (restarting || stopping) {
    return;
  }
  restarting = true;
  restartAttempts += 1;
  const attempt = restartAttempts;
  console.log(`[desktop] restarting daemon (attempt ${attempt}/${MAX_RESTARTS})`);
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(RETRY_PAGE_URL).catch(() => {});
  }
  const delay = nextRestartDelay(attempt);
  await new Promise((resolveTimer) => setTimeout(resolveTimer, delay));
  if (stopping) {
    restarting = false;
    return;
  }
  await stopDaemonChild(daemon === null ? null : daemon.child);
  if (stopping) {
    restarting = false;
    return;
  }
  try {
    await startDaemon();
    consecutiveFailures = 0;
    // A recovery must not carry failure counts across incidents: every
    // incident gets the full attempt budget again.
    restartAttempts = 0;
    await bootShell();
    console.log(`[desktop] daemon recovered on attempt ${attempt}`);
  } catch (error) {
    console.error(`[desktop] daemon restart failed: ${error instanceof Error ? error.message : String(error)}`);
    if (attempt >= MAX_RESTARTS) {
      givingUp();
      return;
    }
    // Nothing else re-triggers us from here (the health timer only fires
    // once a daemon URL exists), so schedule the next attempt ourselves.
    restarting = false;
    setTimeout(() => restartDaemon(), nextRestartDelay(attempt + 1));
    return;
  }
  restarting = false;
}

function givingUp() {
  dialog.showErrorBox(
    "fit-trace daemon",
    "The local fit-trace daemon failed to start after 3 restart attempts.\n\n" +
      "Check the terminal output for details, then relaunch: pnpm desktop:dev",
  );
  app.exit(1);
}

function pollHealth() {
  if (daemonUrl === null || stopping || restarting) {
    return;
  }
  void healthCheck(daemonUrl).then((healthy) => {
    if (healthy) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures += 1;
    console.log(`[desktop] health check failed (${consecutiveFailures}/${FAILED_POLLS_TO_RESTART})`);
    if (consecutiveFailures >= FAILED_POLLS_TO_RESTART) {
      consecutiveFailures = 0;
      void restartDaemon();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "fit-trace",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (daemonUrl !== null) {
    void mainWindow.loadURL(daemonUrl).catch(() => {});
  }
}

/**
 * Bring the shell UI up: create the window if it does not exist yet, point it
 * at the daemon URL, and make sure the health poll is running. Used by the
 * first successful boot AND every successful daemon recovery — the recovery
 * path cannot assume a window exists (a failed first boot never created one)
 * or that the health timer is alive.
 */
async function bootShell() {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow();
  } else if (daemonUrl !== null) {
    await mainWindow.loadURL(daemonUrl).catch(() => {});
  }
  if (healthTimer === null) {
    healthTimer = setInterval(pollHealth, HEALTH_POLL_MS);
  }
}

async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  if (healthTimer !== null) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  await stopDaemonChild(daemon === null ? null : daemon.child);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another shell instance owns the daemon; focus it instead.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    startDaemon()
      .then(() => bootShell())
      .catch((error) => {
        console.error(`[desktop] daemon failed to start: ${error instanceof Error ? error.message : String(error)}`);
        restartDaemon();
      });
  });

  app.on("window-all-closed", () => {
    // The shell owns the daemon: it must not outlive the window on any
    // platform, so every platform stops the daemon and quits (non-darwin
    // would quit directly regardless; darwin deliberately does not stay
    // resident in v1 — a daemon-only background shell has no user value).
    // Quitting routes through before-quit, the single exit that waits for
    // daemon cleanup.
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitRequested) {
      // Cleanup already ran (or is running); let this quit proceed.
      return;
    }
    quitRequested = true;
    // Quit must wait for the daemon to actually stop (SIGTERM → SIGKILL),
    // otherwise the child is orphaned mid-shutdown.
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && daemonUrl !== null) {
      createWindow();
    }
  });
}
