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
 *   2. spawn the daemon (`node cli.ts daemon --port 0 --data <dir>` in dev;
 *      package: the Electron binary as Node + bundled `daemon.mjs` + `--dist`);
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
 *
 * Testing trade-off: the startup/recovery/retry/give-up orchestration in this
 * file is coupled to electron (app, BrowserWindow, dialog) and is deliberately
 * NOT extracted behind injection seams for automated tests — the pure helpers
 * it uses are covered by tests/desktopDaemonChild.test.ts and
 * tests/desktopPaths.test.ts, while the orchestration itself is covered by
 * reproducible manual verification (documented in the PR description).
 *
 * Packaging: the same file runs in dev and in an unsigned packaged build.
 * `main/paths.cjs` owns the difference (daemon bundle + staged app-dist +
 * `ELECTRON_RUN_AS_NODE=1` under `process.resourcesPath` vs. the repo's
 * `cli.ts` and a real `node`); nothing here path-joins a repo layout.
 */

const path = require("node:path");
const fs = require("node:fs");
const { childEnvironment } = require("./publicConfig.cjs");
const { loadOrigin, saveOrigin } = require("./origin.cjs");
const { app, BrowserWindow, dialog } = require("electron");
const {
  STALE_JOURNAL_LOCK_EXIT_CODE,
  healthCheck,
  nextRestartDelay,
  reclaimStaleJournalLock,
  spawnDaemon,
  stopDaemonChild,
} = require("./daemonChild.cjs");
const { MIN_NODE_MAJOR, describeLaunchPlan, isSupportedNodeVersion, resolveLaunchPlan } = require("./paths.cjs");

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
let desktopPort = 0;
let childEnv = null;
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
 * Launch plan for this run. `app.isPackaged` is read once at startup; both
 * branches and their invariants live in `main/paths.cjs` so they are testable
 * without electron. Logged once so a packaged failure is diagnosable from a
 * user's log excerpt.
 */
const LAUNCH_PLAN = resolveLaunchPlan({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  devRepoRoot: path.join(__dirname, "..", "..", ".."),
  execPath: process.execPath,
  env: process.env,
});

function startDaemon() {
  daemon = spawnDaemon({
    nodePath: LAUNCH_PLAN.nodePath,
    cliPath: LAUNCH_PLAN.daemonPath,
    // FIT_TRACE_DATA_DIR passes through the env untouched (dev.cjs inherits
    // the caller's environment); unset means the daemon applies its own
    // default resolution ($FIT_TRACE_DATA_DIR or ~/.fit-trace/data).
    dataDir: DATA_DIR,
    // Packaged builds must name the staged shell explicitly: the daemon's own
    // default is `<import.meta.url>/../../..`-relative, and when bundled that
    // is the resources dir, not a repo root.
    distDir: LAUNCH_PLAN.distDir,
    // Same reasoning for the pi extension: bundled, the daemon's own default
    // lands outside the app bundle. Undefined in dev, where the repo layout is
    // correct and the daemon's default must stay in charge.
    extensionPath: LAUNCH_PLAN.extensionPath,
    port: desktopPort,
    env: childEnv ?? LAUNCH_PLAN.env,
  });
  daemon.child.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  daemon.child.stderr.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));
  daemon.child.once("exit", (code) => {
    if (!stopping) {
      console.log(`[desktop] daemon exited (code ${code ?? "signal"})`);
    }
  });
  return daemon.url.then((url) => {
    if (desktopPort === 0) {
      saveOrigin(app.getPath("userData"), url);
      desktopPort = new URL(url).port * 1;
    }
    daemonUrl = url;
    console.log(`[desktop] daemon at ${url}`);
  });
}

/**
 * Safe stale-lock reclaim for a daemon that failed to start. The daemon exits
 * with STALE_JOURNAL_LOCK_EXIT_CODE (3, from
 * server/coaching/coachingJournal.ts via daemonChild.cjs) when the
 * coaching-journal lock fail-closed on a dead owner — e.g. a daemon that was
 * SIGKILLed. The shell owns the daemon process tree, so it may remove the
 * stale lock file — but only when the data dir is actually known: DATA_DIR
 * comes from FIT_TRACE_DATA_DIR (dev.cjs passes it through), and when it is
 * unset the daemon resolved its own default dir whose path is unknowable
 * here, so reclaiming is skipped and the failure stands.
 */
function reclaimStaleJournalLockAndRetry() {
  if (DATA_DIR === undefined) {
    return false;
  }
  const deadPid = reclaimStaleJournalLock(DATA_DIR);
  if (deadPid === false) {
    return false;
  }
  console.log(`[desktop] reclaimed stale journal lock (dead pid ${deadPid}), retrying`);
  return true;
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
      await givingUp();
      return;
    }
    // A daemon killed while holding the journal lock fails closed forever
    // until the lock file is gone. If it exited with the stale-lock code and
    // the data dir is known, reclaim the lock and retry once inside this
    // same attempt budget; a failed retry falls through to the ordinary
    // failure path below.
    if (
      error !== null &&
      typeof error === "object" &&
      error.exitCode === STALE_JOURNAL_LOCK_EXIT_CODE &&
      reclaimStaleJournalLockAndRetry()
    ) {
      try {
        await startDaemon();
        consecutiveFailures = 0;
        restartAttempts = 0;
        await bootShell();
        console.log(`[desktop] daemon recovered on attempt ${attempt} (stale journal lock reclaimed)`);
        restarting = false;
        return;
      } catch (retryError) {
        console.error(
          `[desktop] daemon restart failed after lock reclaim: ${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`,
        );
      }
    }
    // Nothing else re-triggers us from here (the health timer only fires
    // once a daemon URL exists), so schedule the next attempt ourselves.
    restarting = false;
    setTimeout(() => restartDaemon(), nextRestartDelay(attempt + 1));
    return;
  }
  restarting = false;
}

async function givingUp() {
  dialog.showErrorBox(
    "fit-trace daemon",
    "The local fit-trace daemon failed to start after 3 restart attempts.\n\n" +
      "The saved local port may be in use. Close the other application using it, then " +
      (app.isPackaged ? "relaunch the app." : "relaunch: pnpm desktop:dev"),
  );
  // Last exit path: the final child must not survive the shell. stop is
  // idempotent, so an already-stopped (or never-spawned) child is a no-op.
  await stopDaemonChild(daemon === null ? null : daemon.child);
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
    console.log(describeLaunchPlan(LAUNCH_PLAN));
    // The daemon bundle needs `node:sqlite` (Node >= 24). In dev the caller's
    // node is checked by the CLI itself; packaged, the runtime is Electron's
    // own Node, so a mismatch would otherwise surface as an obscure child
    // failure — fail visibly with the version instead.
    if (!isSupportedNodeVersion(process.versions.node)) {
      dialog.showErrorBox(
        "fit-trace",
        `This build needs Node >= ${MIN_NODE_MAJOR} (Electron's bundled runtime reports ` +
          `${process.versions.node}).\n\nReinstall the app from an official internal build.`,
      );
      app.exit(1);
      return;
    }
    try {
      desktopPort = loadOrigin(app.getPath("userData"));
      if (app.isPackaged) {
        const config = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "desktop-public-config.json"), "utf8"));
        childEnv = childEnvironment(config, LAUNCH_PLAN.env);
      }
    } catch (error) {
      dialog.showErrorBox("fit-trace configuration", "Desktop configuration or saved origin is invalid. Reinstall the app or contact support. No account details were displayed.");
      app.exit(1);
      return;
    }
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
