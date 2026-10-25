import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveActiveStore, resolveDataDir } from "@agent-fit-trace/store";
import type { IdentityFile } from "@agent-fit-trace/store";

/**
 * Startup configuration for the stdio MCP server: argument parsing plus store
 * and skill path resolution. Pure path/argument logic with no MCP or server
 * I/O, so it is unit-testable without a client.
 */

export interface McpArgs {
  store?: string;
  principal?: string;
  skill?: string;
  help: boolean;
  version: boolean;
}

/** Which storage backend backs the resolved store path. */
export type StoreKind = "json" | "sqlite";

export interface ResolvedMcpStore {
  path: string;
  kind: StoreKind;
}

/** `.json` keeps the JSON backend; anything else opens as a SQLite database. */
function storeKindForPath(path: string): StoreKind {
  return path.endsWith(".json") ? "json" : "sqlite";
}

/** Treat `undefined` and blank strings the same way, matching the repo's override convention. */
function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  // An explicit empty value is allowed through: the resolvers treat a blank
  // override as unset, matching the documented flag/env behavior.
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

/**
 * Recognize `--store PATH`, `--principal NAME`, `--skill PATH`, `--help`,
 * `--version`; anything else throws.
 */
export function parseArgs(argv: readonly string[]): McpArgs {
  const args: McpArgs = { help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--store") {
      args.store = takeValue(argv, index + 1, "--store");
      index += 1;
    } else if (token === "--principal") {
      args.principal = takeValue(argv, index + 1, "--principal");
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
 * Legacy JSON-path resolution: `--store` flag > `PI_FIT_TRACE_STORE` >
 * `$HOME/.fit-trace/workouts.json`. A blank flag or env value is treated as
 * unset, mirroring the pi extension's store override. Superseded by
 * {@link resolveMcpStore} for backend-aware resolution; retained for callers
 * that only ever want the JSON file location.
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
 * Store resolution for the MCP server, pinned precedence:
 *
 * 1. `--store PATH` — explicit file, used as-is (`.json` keeps the JSON
 *    backend, anything else opens as SQLite);
 * 2. legacy `PI_FIT_TRACE_STORE` env — same explicit-file semantics, kept as
 *    the JSON compatibility escape hatch for one release;
 * 3. `--principal` / `FIT_TRACE_PRINCIPAL` > the active principal recorded in
 *    `identity.json` > guest — delegated to the shared `resolveActiveStore`,
 *    which also owns the loud `STALE_IDENTITY` error when `identity.json`
 *    names a principal whose database file is missing (no silent guest
 *    fallback that would fragment the dataset).
 */
export async function resolveMcpStore(options: {
  storeArg?: string;
  principalArg?: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  /** Injectable for tests, mirroring `resolveActiveStore`'s seams. */
  readIdentity?: (filePath: string) => Promise<IdentityFile | null>;
  /** Injectable for tests, mirroring `resolveActiveStore`'s seams. */
  fileExists?: (filePath: string) => Promise<boolean>;
}): Promise<ResolvedMcpStore> {
  const { storeArg, principalArg, env, homeDir, readIdentity, fileExists } = options;
  const explicitStore = nonBlank(storeArg) ?? nonBlank(env.PI_FIT_TRACE_STORE);
  if (explicitStore !== undefined) {
    return { path: explicitStore, kind: storeKindForPath(explicitStore) };
  }
  const path = await resolveActiveStore({
    principal: principalArg,
    env,
    dataDir: resolveDataDir(env, homeDir),
    readIdentity,
    fileExists,
  });
  return { path, kind: storeKindForPath(path) };
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
