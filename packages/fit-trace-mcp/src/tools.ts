import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  SESSION_TYPES,
  FitTraceError,
  analyzeProgress,
  generateNextPlan,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type { FitTraceStore } from "./store.ts";

/**
 * MCP tool registrations mirroring the pi extension's four tools
 * (`.pi/extensions/fit-trace/index.ts`): same names, parameters, result text,
 * and structured payloads, so MCP clients see the same domain surface.
 *
 * Tool failures are returned as `isError` results — never thrown — so a bad
 * call cannot tear down the stdio server. Zod inputSchema failures never reach
 * the handlers: the SDK rejects them before dispatch.
 */

/** Shared inclusive ISO 8601 date-range filter fields (aligned with the pi extension). */
const dateRangeFields = {
  from: z.string().optional().describe("Inclusive ISO 8601 start date"),
  to: z.string().optional().describe("Inclusive ISO 8601 end date"),
};

// Loose at every record level: unknown keys must survive to
// validateWorkoutRecord so its UNKNOWN_FIELD warnings reach the caller, the
// same as the pi extension path (which does not pre-strip fields).
const setSchema = z.object({
  weight: z.number().min(0).optional().describe("Weight in kilograms"),
  reps: z.number().int().min(0).describe("Repetitions"),
  rpe: z.number().min(1).max(10).optional().describe("Rate of perceived exertion"),
}).loose();

const exerciseSchema = z.object({
  name: z.string().min(1),
  sets: z.array(setSchema).min(1),
}).loose();

const painSchema = z.object({
  area: z.string().optional(),
  level: z.number().min(0).max(10).optional(),
}).loose();

/** Zod mirror of the pi extension's typebox record schema. */
const recordSchema = z.object({
  id: z.string().min(1).describe("Stable App-assigned id; used as the idempotency key"),
  schema_version: z.number().int().min(1).optional(),
  date: z.string().describe("ISO 8601 date (YYYY-MM-DD) or datetime"),
  session_type: z.enum(SESSION_TYPES),
  exercises: z.array(exerciseSchema).min(1),
  duration_minutes: z.number().min(0).optional(),
  sleep_hours: z.number().min(0).max(24).optional(),
  pain: z.array(painSchema).optional(),
  notes: z.string().optional(),
}).loose();

function textResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

/**
 * A storage/authorization failure that carries a stable machine code but is
 * not a domain `FitTraceError` — e.g. the cloud adapter's `ApiError`s
 * (`CORRUPT_STORE`, `STORAGE_UNAVAILABLE`, `FORBIDDEN`, `UNAUTHENTICATED`),
 * which live in `@agent-fit-trace/api-contracts` rather than core.
 *
 * The MCP package cannot import that type without pulling the HTTP contract
 * into the local stdio server, so this narrows structurally on a string
 * `code` only. The message is never forwarded: those messages are already
 * sanitized, but the client only needs the code plus fixed copy.
 */
function codedErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() !== "" ? code : null;
}

/**
 * Map any thrown error to an `isError` result with a fixed shape: a domain
 * `FitTraceError` keeps its code and message, another coded error keeps only
 * its code, and anything else gets fixed copy without a stack — the process
 * survives either way.
 *
 * Preserving the code matters for operators and agents alike: collapsing
 * `STORAGE_UNAVAILABLE` (a retryable outage) and `CORRUPT_STORE` (needs
 * intervention) into one `INTERNAL_ERROR` text would make the failure
 * unactionable while still revealing nothing extra.
 */
function errorResult(error: unknown): CallToolResult {
  if (error instanceof FitTraceError) {
    return {
      isError: true,
      content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    };
  }
  // Unexpected failures never reach the client as-is (no stacks, no paths);
  // the detail goes to stderr so operators can still diagnose them.
  console.error("fit-trace-mcp unexpected tool failure:", error);
  const code = codedErrorCode(error);
  if (code !== null) {
    return {
      isError: true,
      content: [
        { type: "text", text: `${code}: the request could not be completed.` },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "INTERNAL_ERROR: unexpected tool failure; no further details are available.",
      },
    ],
  };
}

/** Register the four fit-trace tools on an MCP server. */
export function registerFitTraceTools(server: McpServer, store: FitTraceStore): void {
  server.registerTool(
    "import_workout",
    {
      title: "Import Workout",
      description:
        "Validate and store one training session. Rejects invalid records; accepts suspicious-but-usable records with warnings. Idempotent by record id.",
      inputSchema: { record: recordSchema },
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    async ({ record }) => {
      try {
        const { record: validated, warnings } = validateWorkoutRecord(record);
        const result = await store.import(validated);
        const text = result.duplicate
          ? `Record ${validated.id} is already stored with identical content; no change made.`
          : `Imported record ${validated.id}.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ""}`;
        return textResult(text, {
          id: validated.id,
          accepted: true,
          duplicate: result.duplicate,
          warnings,
          total_records: result.total,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_training_history",
    {
      title: "Get Training History",
      description:
        "Query stored training records by date range and exercise. Returns records in ascending date order with pagination info.",
      inputSchema: {
        ...dateRangeFields,
        exercise: z.string().optional().describe("Exact exercise name (case-insensitive)"),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const result = await store.query(params);
        return textResult(
          `Returned ${result.records.length} of ${result.total} matching record(s).`,
          { ...result },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "analyze_progress",
    {
      title: "Analyze Progress",
      description:
        "Deterministically compute metrics, per-exercise trends, and safety flags from stored training records.",
      inputSchema: {
        ...dateRangeFields,
        exercises: z.array(z.string()).optional().describe("Restrict to these exercises"),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const records = await store.all();
        const analysis = analyzeProgress(records, params);
        return textResult(
          `Analyzed ${analysis.metrics.sessions} session(s): volume ${analysis.metrics.volume_kg} kg, avg RPE ${analysis.metrics.avg_rpe ?? "n/a"}, ${analysis.flags.length} flag(s).`,
          { ...analysis },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "generate_next_plan",
    {
      title: "Generate Next Plan",
      description:
        "Generate an explainable DRAFT plan for the next session. Each recommendation cites evidence. This is a draft that requires user confirmation; never modifies stored records and never auto-adopts a plan.",
      inputSchema: {
        goal: z.string().optional(),
        days_available: z.number().int().min(1).max(7).optional(),
        equipment: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const records = await store.all();
        const draft = generateNextPlan(records, params);
        return textResult(
          `Generated a draft plan with ${draft.recommendations.length} recommendation(s). This is a draft and requires user confirmation.`,
          { ...draft },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
