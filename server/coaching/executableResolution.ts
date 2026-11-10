/**
 * Resolve a CLI command name to the ONE absolute executable path that both
 * detection and execution will use.
 *
 * Why this exists: `spawn("codex", …)` resolves against `PATH` at call time.
 * The capability probe and the coached run are two separate spawns seconds or
 * minutes apart, so a bare name lets them disagree — a user who prepends a
 * directory to `PATH`, or an npm shim that appears in between, is verified as
 * one binary and run as another. A probe that verifies the wrong executable is
 * worse than no probe: it reports a capability the run does not have.
 *
 * Resolving ONCE, then passing the absolute path to both the probe and the
 * adapter's `*Binary` option, removes the ambiguity. It also makes the resolved
 * path reportable (#68) — a settings page can show which of several installed
 * versions will run.
 *
 * Windows specifics are handled explicitly rather than left to `spawn`:
 * - `PATHEXT` decides which extensions are executable (`.CMD`, `.EXE`, …), so
 *   an npm shim (`codex.cmd`) is found instead of being missed.
 * - `PATH` entries may be quoted or empty; both are skipped/normalized rather
 *   than producing `<dir>/codex` for an empty entry (which means cwd and would
 *   silently prefer a local file).
 *
 * Deliberately NOT handled: spawning the `.cmd` shim itself. Node cannot exec a
 * batch file without a shell, and this module does not add one (`shell: true`
 * is a command-injection hazard for a path built from user data). Callers still
 * receive the resolved path; whether the installed distribution provides a
 * spawnable entry point is a property of that CLI, not of this resolver.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface ResolveExecutableOptions {
  /** `PATH`-style search path (default `process.env.PATH`). */
  pathEnv?: string;
  /** `PATHEXT`-style extension list (default: from the environment on win32). */
  pathExtEnv?: string;
  /** Host platform (default `process.platform`); injected for tests. */
  platform?: NodeJS.Platform;
  /** File-existence/writability probe (injected for tests). */
  isExecutableFile?: (path: string) => boolean;
}

function defaultIsExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // X_OK is advisory on Windows and always granted there; that is fine —
    // the extension, not the mode bit, is what decides executability.
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Split `PATHEXT` into lowercase extensions, always including the raw name. */
function extensionsFor(platform: NodeJS.Platform, pathExtEnv: string | undefined): string[] {
  if (platform !== "win32") return [""];
  const raw = pathExtEnv ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = raw
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  // A name that already carries one of these extensions must also be tried
  // as-is, or `codex.exe` would be searched as `codex.exe.exe`.
  return ["", ...extensions];
}

function stripQuotes(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Resolve `command` to an absolute executable path, or null when it cannot be
 * found.
 *
 * An ABSOLUTE `command` is checked directly (no PATH search): the caller named
 * an exact binary, and silently falling back to a different one from PATH would
 * reintroduce the mismatch this function exists to prevent. It may still get an
 * extension appended on Windows.
 */
export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile;
  const extensions = extensionsFor(platform, options.pathExtEnv);

  const candidatesFor = (base: string): string[] => {
    // Only add extensions the base does not already end with; a file genuinely
    // named `tool.CMD` must resolve to itself, not to `tool.CMD.EXE`.
    const lower = base.toLowerCase();
    const alreadyExtended = extensions.some(
      (extension) => extension !== "" && lower.endsWith(extension),
    );
    if (alreadyExtended) return [base];
    return extensions.map((extension) => `${base}${extension}`);
  };

  if (command === "") return null;

  // Relative paths are never explicit executable identities and must not be
  // interpreted relative to a PATH directory or the daemon's working dir.
  if (!isAbsolute(command) && (command.includes("/") || command.includes("\\"))) return null;

  if (isAbsolute(command)) {
    for (const candidate of candidatesFor(command)) {
      if (isExecutableFile(candidate)) return resolve(candidate);
    }
    return null;
  }

  const pathValue = options.pathEnv ?? process.env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    // An empty PATH entry means "current directory" in POSIX shell semantics.
    // Honouring it would let a binary sitting in the working directory win over
    // the installed CLI — the exact confusion this resolver removes — so it is
    // skipped. There is also no legitimate reason for a daemon to exec from cwd.
    const directory = stripQuotes(entry);
    if (directory === "" || !isAbsolute(directory)) continue;
    for (const candidate of candidatesFor(join(directory, command))) {
      if (isExecutableFile(candidate)) return resolve(candidate);
    }
  }
  return null;
}

/**
 * Resolve, or return the caller's original string when nothing matched.
 *
 * Falling back to the raw name keeps today's behavior for a CLI that the
 * resolver cannot see (a shell function, an alias, a platform quirk): the spawn
 * still happens and fails with its own error rather than the daemon pretending
 * the binary is absent. Discovery reports the unresolvable case as unavailable
 * with the probe's own reason, so this never manufactures a false "available".
 */
export function resolveExecutableOrName(
  command: string,
  options: ResolveExecutableOptions = {},
): string {
  return resolveExecutable(command, options) ?? command;
}

/** Capture the invocation path and target identity without resolving the shim for execution. */
export function executableIdentity(path: string): string | undefined {
  try {
    const target = realpathSync(path);
    const info = statSync(target, { bigint: true });
    return `${target}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return undefined;
  }
}
