#!/usr/bin/env node
/**
 * `agent-fit-trace-mcp` stdio entrypoint.
 *
 * Speaks MCP over stdio. Iron rule: stdout carries the protocol only — every
 * diagnostic goes to stderr. The `--help`/`--version` operator output prints
 * to stdout before any transport exists, so no protocol bytes are involved.
 *
 * Usage:
 *   node packages/fit-trace-mcp/src/main.ts [--store PATH] [--principal NAME]
 *                                          [--skill PATH]
 */
import { homedir } from "node:os";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { JsonFileStorage, SqliteWorkoutStore, WorkoutStore } from "@agent-fit-trace/store";

import { checkNodeRuntime, parseArgs, resolveMcpStore, resolveSkillPath } from "./config.ts";
import { loadTrainingCoachPrompt } from "./prompts.ts";
import { createFitTraceMcpServer, MCP_SERVER_VERSION } from "./server.ts";

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: agent-fit-trace-mcp [--store PATH] [--principal NAME] [--skill PATH] [--help] [--version]",
      "",
      "  --store PATH        workout store file used as-is: `.json` keeps the JSON backend,",
      "                      anything else opens as a SQLite database",
      "  --principal NAME    per-identity database <data-dir>/<NAME>.db (default $FIT_TRACE_PRINCIPAL)",
      "  --skill PATH        training-coach SKILL.md (default $FIT_TRACE_SKILL_PATH, else <repo>/.pi/skills/training-coach/SKILL.md)",
      "  --help              print this help and exit",
      "  --version           print the server version and exit",
      "",
      "Store resolution precedence: --store > $PI_FIT_TRACE_STORE (legacy file override) >",
      "--principal / $FIT_TRACE_PRINCIPAL > the active principal recorded in identity.json under",
      "the data dir ($FIT_TRACE_DATA_DIR, default ~/.fit-trace/data) > the guest database.",
      "An identity.json naming a missing database fails startup loudly instead of falling back.",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  checkNodeRuntime();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.version) {
    process.stdout.write(`agent-fit-trace-mcp ${MCP_SERVER_VERSION}\n`);
    return;
  }

  const resolved = await resolveMcpStore({
    storeArg: args.store,
    principalArg: args.principal,
    env: process.env,
    homeDir: homedir(),
  });
  const skillPath = resolveSkillPath({
    skillArg: args.skill,
    env: process.env,
    moduleUrl: import.meta.url,
  });

  let skillText: string;
  try {
    skillText = await loadTrainingCoachPrompt(skillPath);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }

  const store =
    resolved.kind === "json"
      ? new WorkoutStore(new JsonFileStorage(resolved.path))
      : new SqliteWorkoutStore(resolved.path);
  // Operator diagnostics only: stderr never carries protocol bytes.
  process.stderr.write(`agent-fit-trace-mcp store: ${resolved.path} (${resolved.kind})\n`);

  const server = createFitTraceMcpServer({ store, skillText });

  await server.connect(new StdioServerTransport());

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
