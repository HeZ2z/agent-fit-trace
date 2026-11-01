"use strict";

/**
 * `package` — run electron-builder for the CURRENT host, unsigned.
 *
 * Explicitly unsigned by design (see docs/adr/0006):
 *   - `CSC_IDENTITY_AUTO_DISCOVERY=false` so macOS never picks up a developer
 *     identity from the keychain even on a maintainer's machine with a cert;
 *   - the electron-builder config sets `mac.identity: null` and defines no
 *     notarization hook;
 *   - no auto-update publisher is configured, so no `latest*.yml` is consumed.
 * The result is an INTERNAL build that Gatekeeper/SmartScreen will warn about.
 * We do not claim otherwise anywhere.
 *
 * Usage:
 *   node scripts/package.cjs           # real artifacts into release/
 *   node scripts/package.cjs --dir     # unpacked app only (fast smoke build)
 *
 * Run via: pnpm --filter @agent-fit-trace/desktop run package [-- --dir]
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PKG_DIR,
  RELEASE_DIR,
  fail,
  isSupportedBuildHost,
  packagingInputProblems,
  resolveElectronBinary,
} = require("./buildSupport.cjs");

const SCRIPT = "package";
const unpackedOnly = process.argv.includes("--dir");

if (!isSupportedBuildHost(process.platform)) {
  fail(SCRIPT, `unsupported build host: ${process.platform} (expected darwin, win32, or linux)`);
}

// Refuse to hand electron-builder a half-staged tree: its failure mode is a
// working-looking .app with no daemon inside, discovered only at launch.
const problems = packagingInputProblems();
if (problems.length > 0) {
  fail(SCRIPT, `cannot package yet:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

let builderBin;
try {
  builderBin = require.resolve("electron-builder/cli.js", { paths: [PKG_DIR] });
} catch {
  fail(SCRIPT, 'electron-builder is not installed — run "pnpm install" at the repo root first.');
}

const args = [builderBin, "--config", path.join(PKG_DIR, "electron-builder.yml")];
if (unpackedOnly) {
  // --dir: build the unpacked app without producing installers. Still one
  // platform (the host), still unsigned — this is the fast smoke build used
  // to prove the packaged layout boots.
  args.push("--dir");
} else {
  args.push(`--${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}`);
}

/**
 * Reuse the Electron distribution already installed in the workspace instead
 * of letting electron-builder download a second copy.
 *
 * Why: electron-builder's download path goes through `@electron/get`, whose
 * cache root is `~/Library/Caches/electron` — outside the workspace. That
 * fails with `EPERM: mkdir '~/Library/Caches/electron/<sha>'` in any sandboxed
 * or restricted-home build (and it re-downloads ~120MB that `pnpm install`
 * already qualified, so the version could in principle diverge from the one
 * `prepareRuntime` verified). `electronDist` accepts an already-unpacked
 * Electron directory: we hand it exactly the binary that strategy A tested.
 *
 * `--dir` and full builds both use it; there is no fallback to network here on
 * purpose — a build that silently downloads a different Electron is worse than
 * a loud failure.
 */
function resolveElectronDistDir() {
  const binary = resolveElectronBinary(PKG_DIR);
  if (binary === null) {
    fail(
      SCRIPT,
      "electron binary is missing — run prepare:runtime first " +
        "(pnpm --filter @agent-fit-trace/desktop run prepare:runtime).",
    );
  }
  // electron's npm package layout is `<electron>/dist/<platform payload>`:
  //   macOS:   dist/Electron.app/Contents/MacOS/Electron
  //   win32:   dist/electron.exe
  //   linux:   dist/electron
  // electron-builder's `electronDist` wants the DIRECTORY CONTAINING the
  // platform payload (i.e. `dist`) — handing it the executable's own directory
  // produced "corrupted Electron dist". Resolve through the package manifest so
  // the per-platform nesting never has to be re-derived here.
  let electronDir;
  try {
    electronDir = path.dirname(require.resolve("electron/package.json", { paths: [PKG_DIR] }));
  } catch {
    fail(SCRIPT, 'electron is not installed — run "pnpm install" at the repo root first.');
  }
  return path.join(electronDir, "dist");
}

const electronDist = resolveElectronDistDir();
args.push("--config.electronDist", electronDist);

/**
 * Probe whether this environment can actually create a macOS disk image.
 *
 * Building a dmg shells out to `hdiutil create`, which needs privileges a
 * sandboxed/restricted build environment denies; the failure surfaces deep
 * inside dmg-builder as a Python `plistlib.InvalidFileException` that names
 * neither hdiutil nor the cause. Probe once, up front, with a throwaway image:
 * if it fails, drop the dmg target for this run and say so loudly, instead of
 * dying with a stack trace that looks like a config bug.
 *
 * On a real macOS runner (CI, a maintainer's machine) the probe succeeds and
 * the dmg is built as configured. This never silently *claims* a dmg exists.
 *
 * @returns {boolean} true when dmg creation is possible here
 */
function canCreateDmg() {
  if (process.platform !== "darwin") {
    return false;
  }
  const probeImage = path.join(os.tmpdir(), `fit-trace-hdiutil-probe-${process.pid}.dmg`);
  const result = spawnSync("hdiutil", ["create", "-size", "1m", "-fs", "HFS+", "-volname", "fit-trace-probe", probeImage], {
    encoding: "utf8",
    timeout: 60_000,
  });
  try {
    fs.rmSync(probeImage, { force: true });
  } catch {
    // Best effort; a stray temp image is not a build failure.
  }
  return result.status === 0;
}

if (process.platform === "darwin" && !unpackedOnly && !canCreateDmg()) {
  console.warn(
    `[desktop:${SCRIPT}] WARNING: this environment cannot create a macOS disk image ` +
      "(`hdiutil create` is not permitted — typical of a sandboxed build). " +
      "Building the ZIP target only; NO .dmg was produced by this run.\n" +
      `[desktop:${SCRIPT}] This is an environment limit, not a configuration error. ` +
      "A normal macOS machine or CI runner produces the dmg.",
  );
  // Restrict to zip so electron-builder does not attempt the dmg and fail.
  args.push("--config.mac.target=zip");
}

// electron-builder downloads Electron zips + nsis/7z helpers into a cache; keep
// it inside this package (gitignored) so CI can cache it without touching $HOME
// and desktop builds never write into the repo root.
//
// BOTH cache roots are redirected, and for different reasons:
//   - ELECTRON_CACHE: where @electron/get keeps the Electron zip electron-builder
//     downloads. Its default (`~/Library/Caches/electron`) is outside the
//     workspace, which breaks sandboxed/CI builds with
//     `EPERM: mkdir '~/Library/Caches/electron/<sha>'`. Pointing it at the
//     package makes the build self-contained and cacheable.
//   - ELECTRON_BUILDER_CACHE: electron-builder's own tool downloads (nsis, 7z,
//     app-builder helpers).
const cacheRoot = path.join(PKG_DIR, ".cache");
const builderCache = process.env.ELECTRON_BUILDER_CACHE || path.join(cacheRoot, "electron-builder");
const electronCache = process.env.ELECTRON_CACHE || path.join(cacheRoot, "electron");

// Electron builds from the BUILD HOST's platform — never cross-build silently.
// (electron-builder can cross-target, but an unsigned internal build that
// claims "Linux artifacts" while produced on macOS would be a lie.)
const env = {
  ...process.env,
  // Belt and braces: even on a machine with a signing identity in the
  // keychain, never auto-discover it. The config also pins mac.identity: null.
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ELECTRON_BUILDER_CACHE: builderCache,
  ELECTRON_CACHE: electronCache,
};

fs.mkdirSync(RELEASE_DIR, { recursive: true });

console.log(
  `[desktop:${SCRIPT}] electron-builder ${unpackedOnly ? "--dir (unpacked)" : "full artifacts"} ` +
    `for ${process.platform}/${process.arch}, unsigned`,
);
const result = spawnSync(process.execPath, args, {
  cwd: PKG_DIR,
  stdio: "inherit",
  env,
});
if (result.error !== undefined) {
  fail(SCRIPT, `could not run electron-builder: ${result.error.message}`);
}
if (result.status !== 0) {
  fail(SCRIPT, `electron-builder exited with code ${result.status}`);
}

if (unpackedOnly) {
  console.log(`[desktop:${SCRIPT}] ok — unpacked app under ${RELEASE_DIR}`);
  process.exit(0);
}

// Report what actually landed. A silent empty `release/` is the failure mode
// a CI upload step reports as "no files found", which is a poor error message.
const artifacts = fs.existsSync(RELEASE_DIR)
  ? fs
      .readdirSync(RELEASE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(dmg|zip|exe|msi|AppImage|deb|rpm|snap|tar\.gz)$/i.test(name))
      .sort()
  : [];
if (artifacts.length === 0) {
  fail(
    SCRIPT,
    `electron-builder reported success but produced no installers in ${RELEASE_DIR}. ` +
      "Check the electron-builder output above (an --dir-only build produces none).",
  );
}
console.log(`[desktop:${SCRIPT}] artifacts in ${RELEASE_DIR}:`);
for (const artifact of artifacts) {
  const bytes = fs.statSync(path.join(RELEASE_DIR, artifact)).size;
  console.log(`  ${artifact} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}
console.log(
  `[desktop:${SCRIPT}] NOTE: UNSIGNED build — no code signing, no notarization, no auto-update. ` +
    "macOS Gatekeeper and Windows SmartScreen will warn on first launch.",
);
// Only claim what is on disk. A missing dmg here is the environment limit
// reported above, never something to gloss over.
if (process.platform === "darwin" && !artifacts.some((name) => name.endsWith(".dmg"))) {
  console.log(
    `[desktop:${SCRIPT}] no .dmg in this run (see the hdiutil warning above); the .zip contains the same app.`,
  );
}
