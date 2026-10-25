import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerFitTraceResources } from "./resources.ts";
import { registerFitTraceTools } from "./tools.ts";
import type { FitTraceStore } from "./store.ts";

/** Identity reported in the MCP initialize handshake. */
export const MCP_SERVER_NAME = "agent-fit-trace";
export const MCP_SERVER_VERSION = "0.1.0";

export interface FitTraceMcpServerOptions {
  /** Either store backend: the JSON `WorkoutStore` or the SQLite `SqliteWorkoutStore`. */
  store: FitTraceStore;
  /** Training-coach skill body (frontmatter already stripped) served as the `training-coach` prompt. */
  skillText: string;
}

/**
 * Transport-agnostic MCP server: registers the four fit-trace tools, the two
 * read-only resources, and the training-coach prompt. Transports (stdio) are
 * wired by the entrypoint, never here.
 */
export function createFitTraceMcpServer(options: FitTraceMcpServerOptions): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  registerFitTraceTools(server, options.store);
  registerFitTraceResources(server, options.store);
  server.registerPrompt(
    "training-coach",
    {
      title: "Training Coach",
      description:
        "Training-coach skill instructions: evidence-based progress analysis and draft plans that require user confirmation.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: options.skillText },
        },
      ],
    }),
  );
  return server;
}
