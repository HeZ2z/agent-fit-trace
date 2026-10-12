/**
 * pi Extension adapter for fit-trace.
 *
 * This is the only module that depends on the pi runtime. All domain behavior
 * lives in `@pi-fit-trace/core` so it can be tested without pi.
 *
 * Discovery: pi auto-loads project-local extensions from `.pi/extensions/`.
 *
 * Coached (analysis-only) mode: the local pi bridge spawns
 * `pi --mode rpc --no-extensions -e <this file>` with the trusted,
 * server-set-only env `PI_FIT_TRACE_COACHED=1` plus `PI_FIT_TRACE_STORE`
 * pointing at the run's validated snapshot file. In that mode this same
 * default export registers ONLY `get_training_history` + `analyze_progress`
 * (reusing the builders below — no copied implementations), and the store
 * path NEVER falls back to the user's default store: an unset
 * `PI_FIT_TRACE_STORE` throws instead of reading user data.
 *
 * Coached isolation (code-backed, enforced below — not comments):
 * - Analysis instructions reach the model via the host's system instructions,
 *   NOT via per-tool prompt augmentation: coached registrations strip
 *   `promptSnippet`/`promptGuidelines` so nothing is appended to the generic
 *   coding-agent prompt.
 * - No theme-dependent rendering (`renderCall`/`renderResult`), no commands,
 *   no shortcuts, no flags are registered here, so there is no
 *   prompt-template/command dispatch surface in either mode.
 * - This module reads exactly two env keys (`PI_FIT_TRACE_STORE`,
 *   `PI_FIT_TRACE_COACHED`) and never reads other `PI_*` config, settings
 *   dirs, or packages. In coached mode the `ctx.cwd`-derived default store
 *   is unreachable (missing snapshot throws first).
 * - Allowed-tools startup probe: in coached mode, when the host launched us
 *   with an explicit `--tools` argv flag, its value must equal exactly the
 *   coached allowlist or registration throws `COACHED_TOOL_PROBE_FAILED`.
 *   (Absent flag = direct load such as unit tests; nothing to probe.)
 *
 * Retained auth config (set by the coaching bridge, documented here because
 * this module runs inside that child): locale/fs basics (`PATH`, `HOME`,
 * `TMPDIR`/`TEMP`/`TMP`, `LANG`/`LC_*`, `TERM`, `TZ`), pi auth config and
 * model-provider credentials (`PI_*`, `ANTHROPIC_*`, `OPENAI_*`, `GOOGLE_*`,
 * `GEMINI_*`, `OLLAMA_*`, `OPENROUTER_*`), minus anything matching
 * `SUPABASE|SERVICE_ROLE|SERVICE_KEY`. Unavoidable exposure: the pi child
 * necessarily sees the model-provider credentials and pi auth config it
 * needs to call the model — this transport is cwd+env/flag isolation, NOT
 * a security sandbox.
 */
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  SESSION_TYPES,
  FitTraceError,
  analyzeProgress,
  generateNextPlan,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";

import { JsonFileStorage, WorkoutStore } from "./store.ts";

/** Read-only tools exposed to coached runs. */
export const COACHED_TOOL_NAMES = ["get_training_history", "analyze_progress"] as const;

/**
 * Trusted coached-mode flag. Set ONLY by the local coaching bridge when it
 * spawns the isolated pi subprocess (`--no-extensions -e` this file); never
 * set it by hand in a dev shell — it narrows the registered tools.
 */
export function isCoachedMode(): boolean {
  return process.env.PI_FIT_TRACE_COACHED === "1";
}

/**
 * Code-backed allowed-tools probe for coached runs. When the host passed an
 * explicit `--tools` flag (normal coached spawn), its value must be exactly
 * the coached allowlist; otherwise registration throws instead of running
 * with an unexpected tool surface. No `--tools` flag (direct load / unit
 * tests) means there is no host claim to check, so the probe passes.
 */
export function assertCoachedToolProbe(argv: readonly string[] = process.argv): void {
  const index = argv.indexOf("--tools");
  if (index === -1) return;
  const actual = (argv[index + 1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .sort();
  const expected = [...COACHED_TOOL_NAMES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `COACHED_TOOL_PROBE_FAILED: host --tools allowlist is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    );
  }
}

/** `PI_FIT_TRACE_STORE` overrides the default project-local store location. */
function resolveStorePath(cwd: string): string {
  const override = process.env.PI_FIT_TRACE_STORE;
  if (override !== undefined && override.trim() !== "") return override;
  if (isCoachedMode()) {
    throw new Error(
      "COACHED_STORE_MISSING: coached runs require PI_FIT_TRACE_STORE to point at the run snapshot; refusing to fall back to the default store",
    );
  }
  return join(cwd, CONFIG_DIR_NAME, "fit-trace", "workouts.json");
}

function rethrow(error: unknown): never {
  if (error instanceof FitTraceError) {
    throw new Error(`${error.code}: ${error.message}`);
  }
  throw error;
}

/** Shared `{ content, details }` tool-result envelope. */
function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

/** Shared inclusive ISO 8601 date-range filter fields. */
const dateRangeFields = {
  from: Type.Optional(Type.String({ description: "Inclusive ISO 8601 start date" })),
  to: Type.Optional(Type.String({ description: "Inclusive ISO 8601 end date" })),
} as const;

type StoreOf = (ctx: ExtensionContext) => WorkoutStore;

const setSchema = Type.Object({
  weight: Type.Optional(Type.Number({ minimum: 0, description: "Weight in kilograms" })),
  reps: Type.Integer({ minimum: 0, description: "Repetitions" }),
  rpe: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Rate of perceived exertion" })),
});

const exerciseSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  sets: Type.Array(setSchema, { minItems: 1 }),
});

const painSchema = Type.Object({
  area: Type.Optional(Type.String()),
  level: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
});

const recordSchema = Type.Object({
  id: Type.String({ minLength: 1, description: "Stable App-assigned id; used as the idempotency key" }),
  schema_version: Type.Optional(Type.Integer({ minimum: 1 })),
  date: Type.String({ description: "ISO 8601 date (YYYY-MM-DD) or datetime" }),
  session_type: StringEnum(SESSION_TYPES),
  exercises: Type.Array(exerciseSchema, { minItems: 1 }),
  duration_minutes: Type.Optional(Type.Number({ minimum: 0 })),
  sleep_hours: Type.Optional(Type.Number({ minimum: 0, maximum: 24 })),
  pain: Type.Optional(Type.Array(painSchema)),
  notes: Type.Optional(Type.String()),
});

function importWorkoutTool(getStore: StoreOf) {
  return defineTool({
    name: "import_workout",
    label: "Import Workout",
    description:
      "Validate and store one training session. Rejects invalid records; accepts suspicious-but-usable records with warnings. Idempotent by record id.",
    promptSnippet: "Validate and store one training session (idempotent by id)",
    promptGuidelines: [
      "Use import_workout to store a single training session submitted by the App.",
      "Use import_workout again with the same id to retry safely; identical content is a no-op.",
    ],
    parameters: Type.Object({ record: recordSchema }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { record, warnings } = validateWorkoutRecord(params.record);
        const result = await getStore(ctx).import(record);
        const text = result.duplicate
          ? `Record ${record.id} is already stored with identical content; no change made.`
          : `Imported record ${record.id}.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ""}`;
        return textResult(text, {
          id: record.id,
          accepted: true,
          duplicate: result.duplicate,
          warnings,
          total_records: result.total,
        });
      } catch (error) {
        return rethrow(error);
      }
    },
  });
}

function trainingHistoryTool(getStore: StoreOf, options?: { coached?: boolean }) {
  return defineTool({
    name: "get_training_history",
    label: "Get Training History",
    description:
      "Query stored training records by date range and exercise. Returns records in ascending date order with pagination info.",
    // Coached runs get analysis instructions from the host system prompt, so
    // coached registrations contribute nothing to the generic coding-agent
    // prompt (no promptSnippet here).
    ...(options?.coached
      ? {}
      : { promptSnippet: "Query stored training records by date range or exercise" }),
    parameters: Type.Object({
      ...dateRangeFields,
      exercise: Type.Optional(Type.String({ description: "Exact exercise name (case-insensitive)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await getStore(ctx).query(params);
        return textResult(
          `Returned ${result.records.length} of ${result.total} matching record(s).`,
          result,
        );
      } catch (error) {
        return rethrow(error);
      }
    },
  });
}

function analyzeProgressTool(getStore: StoreOf, options?: { coached?: boolean }) {
  return defineTool({
    name: "analyze_progress",
    label: "Analyze Progress",
    description:
      "Deterministically compute metrics, per-exercise trends, and safety flags from stored training records.",
    // Coached runs get analysis instructions from the host system prompt, so
    // coached registrations contribute nothing to the generic coding-agent
    // prompt (no promptSnippet/promptGuidelines here).
    ...(options?.coached
      ? {}
      : {
          promptSnippet: "Compute metrics, trends, and safety flags from training history",
          promptGuidelines: [
            "Use analyze_progress before making any claim about progress or trends.",
          ],
        }),
    parameters: Type.Object({
      ...dateRangeFields,
      exercises: Type.Optional(Type.Array(Type.String(), { description: "Restrict to these exercises" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const records = await getStore(ctx).all();
        const analysis = analyzeProgress(records, params);
        return textResult(
          `Analyzed ${analysis.metrics.sessions} session(s): volume ${analysis.metrics.volume_kg} kg, avg RPE ${analysis.metrics.avg_rpe ?? "n/a"}, ${analysis.flags.length} flag(s).`,
          analysis,
        );
      } catch (error) {
        return rethrow(error);
      }
    },
  });
}

function generateNextPlanTool(getStore: StoreOf) {
  return defineTool({
    name: "generate_next_plan",
    label: "Generate Next Plan",
    description:
      "Generate an explainable DRAFT plan for the next session. Each recommendation cites evidence. Never modifies stored records and never auto-adopts a plan.",
    promptSnippet: "Draft the next training plan with cited evidence (requires user confirmation)",
    promptGuidelines: [
      "Use generate_next_plan only after retrieving history and metrics.",
      "Present the draft to the user and wait for confirmation before treating it as adopted.",
    ],
    parameters: Type.Object({
      goal: Type.Optional(Type.String()),
      days_available: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
      equipment: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const records = await getStore(ctx).all();
        const draft = generateNextPlan(records, params);
        return textResult(
          `Generated a draft plan with ${draft.recommendations.length} recommendation(s). This is a draft and requires user confirmation.`,
          draft,
        );
      } catch (error) {
        return rethrow(error);
      }
    },
  });
}

export default function fitTraceExtension(pi: ExtensionAPI): void {
  let store: WorkoutStore | null = null;

  const getStore = (ctx: ExtensionContext): WorkoutStore => {
    if (store === null) {
      store = new WorkoutStore(new JsonFileStorage(resolveStorePath(ctx.cwd)));
    }
    return store;
  };

  if (isCoachedMode()) {
    assertCoachedToolProbe();
    pi.registerTool(trainingHistoryTool(getStore, { coached: true }));
    pi.registerTool(analyzeProgressTool(getStore, { coached: true }));
    return;
  }

  pi.registerTool(importWorkoutTool(getStore));
  pi.registerTool(trainingHistoryTool(getStore));
  pi.registerTool(analyzeProgressTool(getStore));
  pi.registerTool(generateNextPlanTool(getStore));
}
