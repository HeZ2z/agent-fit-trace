"use strict";

/**
 * `prepare:runtime` — obtain and VERIFY the daemon runtime.
 *
 * Runtime strategy (decision recorded in `docs/adr/0006-desktop-packaging.md`):
 * **strategy A — no separate Node binary.** The daemon bundle is executed by
 * the app's own Electron binary re-entered as Node:
 *
 *     ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/<Product> <resources>/daemon.mjs daemon …
 *
 * That removes the ~50MB pinned-Node extraResource, removes a second thing to
 * patch for CVEs, and keeps one runtime per app. The one risk is that
 * Electron's bundled Node might not expose `node:sqlite` (the daemon's data
 * plane uses `DatabaseSync`). It does — verified locally:
 *
 *     $ ELECTRON_RUN_AS_NODE=1 Electron.app/Contents/MacOS/Electron -p "process.versions.node"
 *     24.22.0
 *     $ ELECTRON_RUN_AS_NODE=1 Electron.app/Contents/MacOS/Electron -e \
 *         "const s=require('node:sqlite');const db=new s.DatabaseSync(':memory:');\
 *          db.exec('CREATE TABLE t(a)');db.prepare('INSERT INTO t VALUES (?)').run(1);\
 *          console.log(JSON.stringify(db.prepare('SELECT * FROM t').all()));db.exec('PRAGMA journal_mode=WAL')"
 *     [{"a":1}]
 *
 * This script re-runs exactly that check at build time on the build host, so a
 * future Electron downgrade to a Node without `node:sqlite` fails the build
 * instead of shipping an app whose data plane cannot open a database.
 *
 * It also performs the binary download when it is missing: pnpm 10 does not
 * run unapproved postinstall scripts, so a fresh `pnpm install` never fetches
 * Electron (that keeps CI lean). Same one-shot `install.js` path as
 * `scripts/dev.cjs`.
 *
 * Run from the package: `node scripts/prepareRuntime.cjs`.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MIN_NODE_MAJOR,
  PKG_DIR,
  STAGING_DIR,
  fail,
  readDesktopManifest,
  resolveElectronBinary,
} = require("./buildSupport.cjs");
// Reuse the dev entry's resolver so the "where is the electron binary" logic
// exists exactly once (it is filesystem-based on purpose: requiring the
// electron package can trigger a synchronous download).
const { ensureElectronBinaryForBuild } = require("./electronBinary.cjs");

const SCRIPT = "prepare:runtime";

function ensureElectronBinary() {
  return ensureElectronBinaryForBuild({
    pkgDir: PKG_DIR,
    onDownloadStart: () => {
      console.log(
        `[desktop:${SCRIPT}] electron binary missing (pnpm 10 skips unapproved postinstall ` +
          "scripts; expected after a plain `pnpm install`). Downloading once…",
      );
    },
    onFailure: (message) => fail(SCRIPT, message),
  });
}

/**
 * The assertion that makes strategy A safe: run the SAME binary the app will
 * ship with, as Node, and open a REAL WAL SQLite database. Fails the build on
 * any mismatch (version too old, `node:sqlite` absent, WAL refused).
 *
 * The database is a file, not `:memory:`: `PRAGMA journal_mode = WAL` is
 * impossible for an in-memory database (SQLite answers "memory"), so an
 * in-memory probe would report a false failure — or worse, pass on a runtime
 * whose file-backed WAL mode is broken. The daemon's data plane is file-backed
 * (`server/sqlitePrincipalStores.ts`), so the probe must be too.
 *
 * @param {string} electronBinary
 */
function assertNodeSqliteRuntime(electronBinary) {
  const probeFile = path.join(os.tmpdir(), `fit-trace-runtime-probe-${process.pid}-${Date.now()}.db`);
  const probe = [
    "const s = require('node:sqlite');",
    `const db = new s.DatabaseSync(${JSON.stringify(probeFile)});`,
    "db.exec('PRAGMA busy_timeout = 5000');",
    "const mode = db.prepare('PRAGMA journal_mode = WAL').get();",
    "db.exec('CREATE TABLE t(a TEXT)');",
    "db.prepare('INSERT INTO t VALUES (?)').run('ok');",
    "const rows = db.prepare('SELECT a FROM t').all();",
    "db.close();",
    "process.stdout.write(JSON.stringify({",
    "  node: process.versions.node,",
    "  electron: process.versions.electron,",
    "  rows,",
    "  journal: Object.values(mode)[0],",
    "}));",
  ].join("\n");

  const result = spawnSync(electronBinary, ["-e", probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  // Always clean up: the probe database must never leak into a build tree.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${probeFile}${suffix}`, { force: true });
    } catch {
      // Best effort; a stray temp file is not a build failure.
    }
  }
  if (result.error !== undefined) {
    fail(SCRIPT, `could not run the electron binary as node: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      SCRIPT,
      "the app runtime cannot open a SQLite database via node:sqlite as node.\n" +
        `  binary: ${electronBinary}\n` +
        `  exit: ${result.status}\n` +
        `  stderr: ${(result.stderr ?? "").trim()}\n` +
        "  Strategy A is not viable on this Electron version — either upgrade Electron " +
        "or switch to a pinned Node extraResource (see docs/adr/0006-desktop-packaging.md).",
    );
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(SCRIPT, `unparseable runtime probe output: ${result.stdout}`);
  }
  const major = Number(String(report.node).split(".")[0]);
  if (!Number.isSafeInteger(major) || major < MIN_NODE_MAJOR) {
    fail(
      SCRIPT,
      `the app runtime reports Node ${report.node}, below the required ${MIN_NODE_MAJOR}.`,
    );
  }
  if (!Array.isArray(report.rows) || report.rows.length !== 1 || report.rows[0].a !== "ok") {
    fail(SCRIPT, `node:sqlite round-trip failed: ${JSON.stringify(report.rows)}`);
  }
  if (String(report.journal).toLowerCase() !== "wal") {
    fail(SCRIPT, `journal_mode = WAL was refused (got ${String(report.journal)})`);
  }
  return report;
}

const electronBinary = ensureElectronBinary();
const manifest = readDesktopManifest();
const runtime = assertNodeSqliteRuntime(electronBinary);

// Record the verified contract next to the artifacts so a release log, a bug
// report, or `release-ci` can tell which runtime an installer carries without
// unpacking it.
fs.mkdirSync(STAGING_DIR, { recursive: true });
fs.writeFileSync(
  path.join(STAGING_DIR, "runtime.json"),
  `${JSON.stringify(
    {
      strategy: "electron-run-as-node",
      electron: runtime.electron,
      node: runtime.node,
      nodeSqlite: true,
      journalMode: runtime.journal,
      productName: manifest.productName ?? manifest.name,
      version: manifest.version,
      signed: false,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `[desktop:${SCRIPT}] ok — electron ${runtime.electron} / node ${runtime.node}, ` +
    `node:sqlite + WAL verified (strategy A: no separate node binary)`,
);
