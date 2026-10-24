import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Startup configuration for the stdio MCP server: argument parsing plus store
 * and skill path resolution. Pure path/argument logic with no MCP or server
 * I/O, so it is unit-testable without a client.
 */

export interface McpArgs {
  store?: string;
  skill?: string;
  help: boolean;
  version: boolean;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

/** Recognize `--store PATH`, `--skill PATH`, `--help`, `--version`; anything else throws. */
export function parseArgs(argv: readonly string[]): McpArgs {
  const args: McpArgs = { help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--store") {
      args.store = takeValue(argv, index + 1, "--store");
      index += 1;
    } else if (token === "--skill") {
      args.skill = takeValue(argv, index + 1, "--skill");
      index += 1;
    } else if (token === "--help") {
      args.help = true;
    } else if (token === "--version") {
      args.version = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

/**
 * Store location precedence: `--store` flag > `PI_FIT_TRACE_STORE` >
 * `$HOME/.fit-trace/workouts.json`. A blank flag or env value is treated as
 * unset, mirroring the pi extension's store override.
 */
export function resolveStorePath(options: {
  storeArg?: string;
  env: Record<string, string | undefined>;
  homeDir: string;
}): string {
  const { storeArg, env, homeDir } = options;
  if (storeArg !== undefined && storeArg.trim() !== "") return storeArg;
  const override = env.PI_FIT_TRACE_STORE;
  if (override !== undefined && override.trim() !== "") return override;
  return join(homeDir, ".fit-trace", "workouts.json");
}

/**
 * Skill location precedence: `--skill` flag > `FIT_TRACE_SKILL_PATH` > the
 * repo checkout's `.pi/skills/training-coach/SKILL.md`, found by going three
 * directories up from `moduleUrl` (`import.meta.url` of this file, which sits
 * in `packages/fit-trace-mcp/src`).
 */
export function resolveSkillPath(options: {
  skillArg?: string;
  env: Record<string, string | undefined>;
  moduleUrl: string;
}): string {
  const { skillArg, env, moduleUrl } = options;
  if (skillArg !== undefined && skillArg.trim() !== "") return skillArg;
  const override = env.FIT_TRACE_SKILL_PATH;
  if (override !== undefined && override.trim() !== "") return override;
  const here = dirname(fileURLToPath(moduleUrl));
  return resolve(here, "..", "..", "..", ".pi", "skills", "training-coach", "SKILL.md");
}

/** Fail fast on an unsupported runtime; the repo requires Node >= 24. */
export function checkNodeRuntime(version = process.versions.node): void {
  const major = Number(version.replace(/^v/, "").split(".")[0] ?? "0");
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new Error(
      `@agent-fit-trace/mcp requires Node >= 24 (current: ${version}). ` +
        "Upgrade Node (for example `nvm install 24`) and rerun agent-fit-trace-mcp.",
    );
  }
}
