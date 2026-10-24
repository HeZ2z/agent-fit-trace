import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeProgress } from "@agent-fit-trace/core";
import type { WorkoutStore } from "@agent-fit-trace/store";

/**
 * MCP resources exposing read-only snapshots of the store. Every read queries
 * the store live — there is no cache — so results always reflect the current
 * JSON file. Read failures propagate to the SDK, which answers the request
 * with a protocol-level error.
 */

const RECENT_URI = "fit-trace://workouts/recent";
const ANALYSIS_URI = "fit-trace://analysis/summary";
const RECENT_RECORD_COUNT = 10;

/** Register the fit-trace read-only resources on an MCP server. */
export function registerFitTraceResources(server: McpServer, store: WorkoutStore): void {
  server.registerResource(
    "recent-workouts",
    RECENT_URI,
    {
      description: "The 10 most recent stored training records as pretty-printed JSON.",
      mimeType: "application/json",
    },
    async () => {
      const result = await store.query({});
      // query({}) returns records in ascending date order; the tail is the most recent.
      const recent = result.records.slice(-RECENT_RECORD_COUNT);
      return {
        contents: [
          {
            uri: RECENT_URI,
            mimeType: "application/json",
            text: JSON.stringify(recent, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "analysis-summary",
    ANALYSIS_URI,
    {
      description:
        "Progress analysis over all stored records with the analyze_progress defaults, as pretty-printed JSON.",
      mimeType: "application/json",
    },
    async () => {
      const records = await store.all();
      const analysis = analyzeProgress(records, {});
      return {
        contents: [
          {
            uri: ANALYSIS_URI,
            mimeType: "application/json",
            text: JSON.stringify(analysis, null, 2),
          },
        ],
      };
    },
  );
}
