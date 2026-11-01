#!/usr/bin/env node
/**
 * Keep every package version in lockstep with the root `package.json`.
 *
 * Why: the release workflow tags a commit (`v0.1.0`) and attaches artifacts
 * built from three independent trees — the root/app TypeScript packages, the
 * Expo mobile app (whose version lives in `mobile/app.json` under `expo.version`,
 * not in its `package.json` alone) and the Electron desktop shell. Nothing
 * keeps those numbers agreeing today: a hand edit of one file per release is a
 * silent way to ship an APK that claims 0.1.0 next to a desktop app that claims
 * 0.2.0, and every store/sidecar that reads one but not the other inherits the
 * difference. `--check` is the CI guard; the write mode is the one-step fix.
 *
 * The root `package.json` is the single source of truth. Every other file is a
 * copy: this script never bumps anything, it only propagates (write) or
 * compares (`--check`).
 *
 * Determinism: the file list is derived from the filesystem (sorted), the only
 * input is the root version, and rewriting is byte-surgical — the version line
 * is replaced in place and the result is re-parsed and compared with the
 * expected object, so key order, indentation and every other field survive
 * untouched. No clock, no randomness, no network.
 *
 * Usage:
 *   node scripts/sync-versions.mjs                  # stamp every copy from the root version
 *   node scripts/sync-versions.mjs --check          # verify; exit 1 and list every drifted file
 *   node scripts/sync-versions.mjs --check --root <dir>
 *   node scripts/sync-versions.mjs --root <dir>
 *
 * `--root` is a test/maintenance hook: it points the same logic at a fixture
 * tree instead of the repository root, and it is never a way to reach a
 * committed file other than through the default.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const USAGE = `sync-versions: keep every package version in lockstep with the root package.json.

  node scripts/sync-versions.mjs                  stamp every copy from the root version
  node scripts/sync-versions.mjs --check          verify only; exit 1 if any copy drifted
  node scripts/sync-versions.mjs --check --root <dir>
  node scripts/sync-versions.mjs --root <dir>

The root package.json is the single source of truth. Bump it first
("pnpm version <x> --no-git-tag-version" or a hand edit), then run this script
once to stamp app/, packages/*, mobile/package.json and mobile/app.json
("expo.version"). --check is what CI runs.`;

/** Where the version lives inside a target file. */
const KIND_PACKAGE_VERSION = "package-version";
const KIND_EXPO_VERSION = "expo-version";

/**
 * Indentation of the version line the script rewrites, per kind. Both files are
 * 2-space pretty-printed JSON, so the key sits at depth 1 (packages) or depth 2
 * (inside app.json's `expo` object). A mismatch is reported, never guessed.
 */
const EXPECTED_INDENT = new Map([
  [KIND_PACKAGE_VERSION, 2],
  [KIND_EXPO_VERSION, 4],
]);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(message);
}

function readJson(filePath, label) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${label}: cannot read ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    fail(`${label}: ${filePath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every file that mirrors the root version, in a stable order: the lockstep
 * inputs a release touches, nobody's private tree.
 *
 * @param {string} root absolute repository (or fixture) root
 * @returns {{ label: string, path: string, kind: string }[]}
 */
function discoverTargets(root) {
  const targets = [
    { label: "app/package.json", path: join(root, "app", "package.json"), kind: KIND_PACKAGE_VERSION },
  ];

  const packagesDir = join(root, "packages");
  if (!isDirectory(packagesDir)) {
    fail("packages/ is missing — run this script from a repository checkout");
  }
  const packageDirs = readdirSync(packagesDir)
    .filter((entry) => !entry.startsWith(".") && entry !== "node_modules")
    .filter((entry) => isDirectory(join(packagesDir, entry)))
    .filter((entry) => {
      try {
        return statSync(join(packagesDir, entry, "package.json")).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  for (const entry of packageDirs) {
    targets.push({
      label: `packages/${entry}/package.json`,
      path: join(packagesDir, entry, "package.json"),
      kind: KIND_PACKAGE_VERSION,
    });
  }

  targets.push({ label: "mobile/package.json", path: join(root, "mobile", "package.json"), kind: KIND_PACKAGE_VERSION });
  targets.push({ label: "mobile/app.json expo.version", path: join(root, "mobile", "app.json"), kind: KIND_EXPO_VERSION });
  return targets;
}

/** The version a parsed document currently claims; a missing field is an error. */
function versionOf(value, kind, label) {
  const version = kind === KIND_EXPO_VERSION ? value?.expo?.version : value?.version;
  if (typeof version !== "string" || version === "") {
    fail(`${label}: no version field (${kind === KIND_EXPO_VERSION ? "expo.version" : "version"})`);
  }
  return version;
}

/** A clone of `value` carrying `version` at the same place `versionOf` reads. */
function withVersion(value, kind, version) {
  if (kind === KIND_EXPO_VERSION) {
    return { ...value, expo: { ...value.expo, version } };
  }
  return { ...value, version };
}

/**
 * Replace the version line in place. Both the "exactly one candidate at the
 * expected depth" precondition and the caller's re-parse comparison keep this
 * from silently rewriting the wrong field.
 */
function stampText(text, kind, current, next, label) {
  const trimmed = text.split("\n");
  const indent = EXPECTED_INDENT.get(kind);
  const candidates = [];
  trimmed.forEach((line, index) => {
    const match = /^(\s*)"version":\s*"([^"]*)"\s*,?\s*$/.exec(line);
    if (match !== null) {
      candidates.push({ index, indent: match[1].length, value: match[2] });
    }
  });

  const matches = candidates.filter((candidate) => candidate.indent === indent);
  if (matches.length !== 1) {
    fail(
      `${label}: expected exactly one "${"  ".repeat(indent)}"version"" line at depth ${indent}, found ${matches.length}` +
        (candidates.length > 0
          ? ` (candidates: ${candidates.map((candidate) => `depth ${candidate.indent} = ${candidate.value}`).join(", ")})`
          : " (no version line at all)"),
    );
  }
  const found = matches[0];
  if (found.value !== current) {
    fail(`${label}: version line reads "${found.value}" but the parsed document says "${current}"`);
  }

  const replacement = trimmed[found.index].replace(/("version":\s*)"[^"]*"/, `$1"${next}"`);
  return trimmed
    .map((line, index) => (index === found.index ? replacement : line))
    .join("\n");
}

/**
 * Compare the root version against every copy.
 *
 * @returns {{ ok: boolean, expected: string, files: { label: string, path: string, kind: string, text: string, value: unknown, actual: string }[] }}
 */
function inspect(root) {
  const rootManifestPath = join(root, "package.json");
  const rootManifest = readJson(rootManifestPath, "package.json");
  const expected = versionOf(rootManifest.value, KIND_PACKAGE_VERSION, "package.json");
  if (!SEMVER.test(expected)) {
    fail(`package.json: version "${expected}" is not a plain semver string`);
  }

  const files = discoverTargets(root).map((target) => {
    const parsed = readJson(target.path, target.label);
    return { ...target, text: parsed.text, value: parsed.value, actual: versionOf(parsed.value, target.kind, target.label) };
  });

  return { ok: files.every((file) => file.actual === expected), expected, files };
}

function formatRow(file, expected) {
  return `  ${file.label.padEnd(36)} ${file.actual.padEnd(12)} → ${expected}`;
}

function main(argv) {
  let check = false;
  let root = REPO_ROOT;

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--root") {
      const value = args.shift();
      if (typeof value !== "string" || value === "") {
        fail("--root needs a directory");
      }
      root = resolve(process.cwd(), value);
      continue;
    }
    fail(`unknown argument "${arg}"\n\n${USAGE}`);
  }

  if (!isDirectory(root)) {
    fail(`root ${root} is not a directory`);
  }

  const { ok, expected, files } = inspect(root);

  if (check) {
    if (ok) {
      console.log(`sync-versions: up to date (${expected}; ${files.length} file(s) checked)`);
      return;
    }
    const drifted = files.filter((file) => file.actual !== expected);
    const lines = [
      `${drifted.length} file(s) disagree with the root package.json version ${expected}.`,
      "",
      ...drifted.map((file) => formatRow(file, expected)),
      "",
      'The root package.json is the source of truth. Stamp the copies with "node scripts/sync-versions.mjs",',
      "or fix the root version if the copies are right.",
    ];
    fail(lines.join("\n"));
  }

  const changed = [];
  for (const file of files) {
    if (file.actual === expected) {
      continue;
    }
    const nextText = stampText(file.text, file.kind, file.actual, expected, file.label);
    const reparsed = JSON.parse(nextText);
    if (JSON.stringify(reparsed) !== JSON.stringify(withVersion(file.value, file.kind, expected))) {
      fail(
        `${file.label}: rewriting the version line would change more than the version — refusing to write. ` +
          "Reformat the file so the version sits on its own line at the expected depth.",
      );
    }
    writeFileSync(file.path, nextText, "utf8");
    changed.push(file);
  }

  if (changed.length === 0) {
    console.log(`sync-versions: nothing to do (${expected}; ${files.length} file(s) already match)`);
    return;
  }
  for (const file of changed) {
    console.log(`sync-versions: stamped ${file.label} (${file.actual} → ${expected})`);
  }
  console.log(`sync-versions: stamped ${changed.length} file(s) at ${expected}`);
}

const invokedPath = process.argv[1];
const isMain =
  typeof invokedPath === "string" &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href;

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`sync-versions: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
