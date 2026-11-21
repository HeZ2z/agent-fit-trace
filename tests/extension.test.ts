import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import fitTraceExtension from "../.pi/extensions/fit-trace/index.ts";
import { loadFixture } from "./helpers.ts";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: any;
};

type AnyTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
};

/** Minimal pi harness: captures registered tool definitions without a runtime. */
function createHarness(): Map<string, AnyTool> {
  const tools = new Map<string, AnyTool>();
  const pi = {
    registerTool: (definition: AnyTool) => {
      tools.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;

  fitTraceExtension(pi);
  return tools;
}

const ctx = { cwd: process.cwd() } as unknown as ExtensionContext;

test("registers exactly the four documented tools", () => {
  const tools = createHarness();
  assert.deepEqual([...tools.keys()].sort(), [
    "analyze_progress",
    "generate_next_plan",
    "get_training_history",
    "import_workout",
  ]);
});

test("drives import -> history -> analyze -> draft plan through the adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-ext-"));
  process.env.PI_FIT_TRACE_STORE = join(dir, "workouts.json");
  try {
    const tools = createHarness();
    const raw = await loadFixture<unknown[]>("history-strength.json");

    for (const entry of raw) {
      const result = await tools.get("import_workout")!.execute("call", { record: entry }, undefined, undefined, ctx);
      assert.equal(result.details.accepted, true);
      assert.equal(result.details.duplicate, false);
    }

    const duplicate = await tools.get("import_workout")!.execute("call", { record: raw[0] }, undefined, undefined, ctx);
    assert.equal(duplicate.details.duplicate, true);
    assert.equal(duplicate.details.total_records, 3);

    const history = await tools.get("get_training_history")!.execute("call", {}, undefined, undefined, ctx);
    assert.equal(history.details.total, 3);
    const historyText = history.content[0].text;
    assert.match(historyText, /^Returned 3 of 3 matching record\(s\)\./);
    assert.match(historyText, /2026-09-01-strength \| 2026-09-01 \| strength \| bench_press \(3 sets\), squat \(3 sets\)/);
    assert.match(historyText, /2026-09-08-strength/);

    const analysis = await tools.get("analyze_progress")!.execute("call", {}, undefined, undefined, ctx);
    assert.equal(analysis.details.metrics.sessions, 3);
    assert.equal(analysis.details.metrics.volume_kg, 8325);
    const analysisText = analysis.content[0].text;
    assert.match(analysisText, /^Analyzed 3 session\(s\): volume 8325 kg/);
    assert.match(analysisText, /Barbell Bench Press - Medium Grip: 93\.33 -> 99\.17 kg/);
    assert.match(analysisText, /Source records: 2026-09-01-strength, 2026-09-04-strength, 2026-09-08-strength\./);

    const plan = await tools.get("generate_next_plan")!.execute("call", { goal: "strength" }, undefined, undefined, ctx);
    assert.equal(plan.details.is_draft, true);
    assert.equal(plan.details.requires_confirmation, true);
    assert.ok(plan.details.recommendations.length > 0);
    const planText = plan.content[0].text;
    assert.match(planText, /^Generated a draft plan with \d+ recommendation\(s\)\. This is a draft and requires user confirmation\./);
    assert.match(planText, /Evidence: \{/);
    assert.match(planText, /2026-09-01-strength/);
  } finally {
    delete process.env.PI_FIT_TRACE_STORE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an invalid record with a readable VALIDATION_ERROR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-ext-"));
  process.env.PI_FIT_TRACE_STORE = join(dir, "workouts.json");
  try {
    const tools = createHarness();
    const invalid = await loadFixture("invalid-negative-weight.json");
    await assert.rejects(
      () => tools.get("import_workout")!.execute("call", { record: invalid }, undefined, undefined, ctx),
      /VALIDATION_ERROR/,
    );
  } finally {
    delete process.env.PI_FIT_TRACE_STORE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports a conflict when the same id is re-imported with different content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-ext-"));
  process.env.PI_FIT_TRACE_STORE = join(dir, "workouts.json");
  try {
    const tools = createHarness();
    const record = await loadFixture<Record<string, unknown>>("valid-strength.json");
    await tools.get("import_workout")!.execute("call", { record }, undefined, undefined, ctx);

    const mutated = structuredClone(record);
    (mutated.exercises as Array<{ sets: Array<{ weight: number }> }>)[0].sets[0].weight = 90;
    await assert.rejects(
      () => tools.get("import_workout")!.execute("call", { record: mutated }, undefined, undefined, ctx),
      /CONFLICT/,
    );
  } finally {
    delete process.env.PI_FIT_TRACE_STORE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("surfaces a readable error for an invalid history filter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-ext-"));
  process.env.PI_FIT_TRACE_STORE = join(dir, "workouts.json");
  try {
    const tools = createHarness();
    await assert.rejects(
      () =>
        tools
          .get("get_training_history")!
          .execute("call", { from: "not-a-date" }, undefined, undefined, ctx),
      /VALIDATION_ERROR/,
    );
  } finally {
    delete process.env.PI_FIT_TRACE_STORE;
    await rm(dir, { recursive: true, force: true });
  }
});
