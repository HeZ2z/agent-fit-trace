import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  SkillFileNotFoundError,
  checkNodeRuntime,
  createFitTraceMcpServer,
  loadTrainingCoachPrompt,
  parseArgs,
  resolveSkillPath,
  resolveStorePath,
} from "@agent-fit-trace/mcp";
import { JsonFileStorage, WorkoutStore } from "@agent-fit-trace/store";

import { loadFixture } from "./helpers.ts";

type StructuredDetails = { [key: string]: any };

/** Minimal MCP harness: in-memory client wired to the real server, no process spawned. */
async function withClient<T>(
  storePath: string,
  skillText: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const store = new WorkoutStore(new JsonFileStorage(storePath));
  const server = createFitTraceMcpServer({ store, skillText });
  const client = new Client({ name: "fit-trace-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** First text block of a tool result, tolerating every callTool result variant. */
function firstText(result: unknown): string {
  const content = (result as { content?: ReadonlyArray<{ text?: unknown }> }).content;
  const block = content?.[0];
  return typeof block?.text === "string" ? block.text : "";
}

/** First text content of a resource read; this server always answers resources with text. */
function resourceText(result: unknown): string {
  const contents = (result as { contents?: ReadonlyArray<{ text?: unknown }> }).contents;
  const text = contents?.[0]?.text;
  assert.ok(typeof text === "string", "expected a text resource content");
  return text;
}

/** Import every fixture record through the MCP tool, asserting each succeeds. */
async function importAll(client: Client, records: Array<Record<string, unknown>>): Promise<void> {
  for (const record of records) {
    const result = await client.callTool({ name: "import_workout", arguments: { record } });
    assert.ok(!result.isError, `import of ${String((record as StructuredDetails).id)} failed: ${firstText(result)}`);
  }
}

test("lists exactly the four fit-trace tools with the expected annotations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["analyze_progress", "generate_next_plan", "get_training_history", "import_workout"],
      );
      const annotations = new Map(tools.map((tool) => [tool.name, tool.annotations]));
      assert.equal(annotations.get("import_workout")?.idempotentHint, true);
      assert.equal(annotations.get("import_workout")?.destructiveHint, false);
      for (const name of ["get_training_history", "analyze_progress", "generate_next_plan"]) {
        assert.equal(annotations.get(name)?.readOnlyHint, true);
      }
      const plan = tools.find((tool) => tool.name === "generate_next_plan")!;
      assert.match(plan.description ?? "", /draft/i);
      assert.match(plan.description ?? "", /requires user confirmation/i);
      assert.match(plan.description ?? "", /never modifies stored records/i);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("imports records, reports duplicates, and returns CONFLICT as an isError result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");
      await importAll(client, records);

      const duplicate = await client.callTool({
        name: "import_workout",
        arguments: { record: records[0] },
      });
      assert.ok(!duplicate.isError);
      assert.equal((duplicate.structuredContent as StructuredDetails).duplicate, true);
      assert.equal((duplicate.structuredContent as StructuredDetails).total_records, 3);
      assert.match(firstText(duplicate), /already stored with identical content/);

      const mutated = structuredClone(records[0]) as StructuredDetails;
      (mutated.exercises[0].sets[0] as { weight: number }).weight = 90;
      const conflict = await client.callTool({
        name: "import_workout",
        arguments: { record: mutated },
      });
      assert.equal(conflict.isError, true);
      assert.match(firstText(conflict), /CONFLICT/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an invalid record without touching the store file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");

      // A set without `reps` fails the tool's zod inputSchema; the SDK wraps
      // the InvalidParams error into an isError result, so no handler runs.
      const missingReps = structuredClone(records[0]) as StructuredDetails;
      delete missingReps.exercises[0].sets[0].reps;
      const zodFailure = await client.callTool({
        name: "import_workout",
        arguments: { record: missingReps },
      });
      assert.equal(zodFailure.isError, true);
      assert.match(firstText(zodFailure), /Invalid arguments for tool import_workout/);
      assert.equal(existsSync(join(dir, "workouts.json")), false);

      // A record that passes zod but fails the core validator comes back as
      // an isError result with the stable fit-trace error code.
      const invalidDate = structuredClone(records[0]) as StructuredDetails;
      invalidDate.date = "not-a-date";
      const result = await client.callTool({
        name: "import_workout",
        arguments: { record: invalidDate },
      });
      assert.equal(result.isError, true);
      assert.match(firstText(result), /VALIDATION_ERROR/);
      assert.equal(existsSync(join(dir, "workouts.json")), false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drives history, analysis, and draft plan through MCP with the documented numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");
      await importAll(client, records);

      const history = await client.callTool({ name: "get_training_history", arguments: {} });
      assert.ok(!history.isError);
      assert.match(firstText(history), /Returned 3 of 3 matching record\(s\)\./);
      assert.equal((history.structuredContent as StructuredDetails).total, 3);
      assert.equal((history.structuredContent as StructuredDetails).records.length, 3);

      const analysis = await client.callTool({ name: "analyze_progress", arguments: {} });
      assert.ok(!analysis.isError);
      assert.match(firstText(analysis), /Analyzed 3 session\(s\): volume 8325 kg/);
      const metrics = (analysis.structuredContent as StructuredDetails).metrics;
      assert.equal(metrics.sessions, 3);
      assert.equal(metrics.volume_kg, 8325);

      const plan = await client.callTool({
        name: "generate_next_plan",
        arguments: { goal: "strength" },
      });
      assert.ok(!plan.isError);
      assert.match(firstText(plan), /requires user confirmation/);
      const draft = plan.structuredContent as StructuredDetails;
      assert.equal(draft.is_draft, true);
      assert.equal(draft.requires_confirmation, true);
      assert.ok(draft.recommendations.length > 0);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serves empty-store resources: an empty recent list and a zero-session summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const recent = await client.readResource({ uri: "fit-trace://workouts/recent" });
      assert.equal(recent.contents[0].mimeType, "application/json");
      assert.deepEqual(JSON.parse(resourceText(recent)), []);

      const summary = await client.readResource({ uri: "fit-trace://analysis/summary" });
      assert.equal(summary.contents[0].mimeType, "application/json");
      const summaryAnalysis = JSON.parse(resourceText(summary)) as StructuredDetails;
      assert.equal(summaryAnalysis.metrics.sessions, 0);

      // Same accounting as the analyze_progress tool with default arguments.
      const toolAnalysis = await client.callTool({ name: "analyze_progress", arguments: {} });
      assert.deepEqual(summaryAnalysis, toolAnalysis.structuredContent);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("caps the recent-workouts resource at the 10 most recent records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const [first] = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");
      const twelve = Array.from({ length: 12 }, (_, index) => {
        const day = String(index + 1).padStart(2, "0");
        return { ...(first as StructuredDetails), id: `2026-08-${day}-strength`, date: `2026-08-${day}` };
      });
      await importAll(client, twelve);

      const recent = await client.readResource({ uri: "fit-trace://workouts/recent" });
      const stored = JSON.parse(resourceText(recent)) as Array<{ date: string }>;
      assert.ok(stored.length <= 10);
      assert.equal(stored.length, 10);
      // Ascending date order; the tail is the most recent, so the oldest kept
      // session is 2026-08-03 (records 1-2 fell off the window).
      assert.equal(stored[0].date, "2026-08-03");
      assert.equal(stored[stored.length - 1].date, "2026-08-12");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("matches the analysis summary resource to the analyze_progress defaults after imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");
      await importAll(client, records);

      const summary = await client.readResource({ uri: "fit-trace://analysis/summary" });
      const summaryAnalysis = JSON.parse(resourceText(summary)) as StructuredDetails;
      const toolAnalysis = await client.callTool({ name: "analyze_progress", arguments: {} });
      assert.deepEqual(summaryAnalysis, toolAnalysis.structuredContent);
      assert.equal(summaryAnalysis.metrics.sessions, 3);
      assert.equal(summaryAnalysis.metrics.volume_kg, 8325);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serves the training-coach prompt with frontmatter stripped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    const skillPath = join(dir, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: training-coach\ndescription: test skill\n---\n\n# Test Skill Body\n\nEvidence first.\n",
      "utf8",
    );
    const skillText = await loadTrainingCoachPrompt(skillPath);
    await withClient(join(dir, "workouts.json"), skillText, async (client) => {
      const result = await client.getPrompt({ name: "training-coach" });
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].role, "user");
      const text = (result.messages[0].content as { type: string; text: string }).text;
      assert.ok(!text.includes("name: training-coach"), "frontmatter must be stripped from the prompt");
      assert.ok(text.includes("# Test Skill Body"));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTrainingCoachPrompt reports a missing skill file with override guidance", async () => {
  await assert.rejects(
    () => loadTrainingCoachPrompt("/nonexistent/SKILL.md"),
    (error: unknown) => {
      assert.ok(error instanceof SkillFileNotFoundError);
      assert.match((error as Error).message, /\/nonexistent\/SKILL\.md/);
      assert.match((error as Error).message, /--skill/);
      assert.match((error as Error).message, /FIT_TRACE_SKILL_PATH/);
      return true;
    },
  );
});

test("config resolution follows flag > env > defaults and validates runtime and args", () => {
  assert.equal(
    resolveStorePath({ storeArg: "/flag.json", env: { PI_FIT_TRACE_STORE: "/env.json" }, homeDir: "/home/u" }),
    "/flag.json",
  );
  assert.equal(
    resolveStorePath({ env: { PI_FIT_TRACE_STORE: "/env.json" }, homeDir: "/home/u" }),
    "/env.json",
  );
  assert.equal(
    resolveStorePath({ env: {}, homeDir: "/home/u" }),
    join("/home/u", ".fit-trace", "workouts.json"),
  );

  const configModuleUrl = new URL("../packages/fit-trace-mcp/src/config.ts", import.meta.url).href;
  assert.equal(
    resolveSkillPath({ skillArg: "/custom.md", env: { FIT_TRACE_SKILL_PATH: "/env.md" }, moduleUrl: configModuleUrl }),
    "/custom.md",
  );
  assert.equal(
    resolveSkillPath({ env: { FIT_TRACE_SKILL_PATH: "/env.md" }, moduleUrl: configModuleUrl }),
    "/env.md",
  );
  const defaultSkill = resolveSkillPath({ env: {}, moduleUrl: configModuleUrl });
  assert.equal(
    defaultSkill,
    fileURLToPath(new URL("../../../.pi/skills/training-coach/SKILL.md", configModuleUrl)),
  );
  assert.ok(existsSync(defaultSkill), "the repo skill fallback must point at the real SKILL.md");

  assert.throws(() => checkNodeRuntime("v23.1.0"), /requires Node >= 24/);
  assert.doesNotThrow(() => checkNodeRuntime("v24.0.0"));

  assert.throws(() => parseArgs(["--bogus"]), /unknown argument: --bogus/);
  assert.deepEqual(parseArgs(["--store", "/a/b.json"]), { store: "/a/b.json", help: false, version: false });
});

test("preserves unknown record fields so core UNKNOWN_FIELD warnings reach the caller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    await withClient(join(dir, "workouts.json"), "", async (client) => {
      const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");
      const withUnknown = structuredClone(records[0]) as StructuredDetails;
      withUnknown.weight_unit = "kg";
      const result = await client.callTool({
        name: "import_workout",
        arguments: { record: withUnknown },
      });
      assert.ok(!result.isError, firstText(result));
      const warnings = (result.structuredContent as StructuredDetails).warnings as Array<{
        code: string;
        path?: string;
      }>;
      assert.ok(
        warnings.some((warning) => warning.code === "UNKNOWN_FIELD" && warning.path === ".weight_unit"),
        `expected an UNKNOWN_FIELD warning for .weight_unit, got ${JSON.stringify(warnings)}`,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("treats an explicitly empty --store value as unset during resolution", () => {
  assert.deepEqual(parseArgs(["--store", ""]), { store: "", help: false, version: false });
  assert.equal(
    resolveStorePath({ storeArg: "", env: { PI_FIT_TRACE_STORE: "/env.json" }, homeDir: "/home/u" }),
    "/env.json",
  );
  assert.equal(
    resolveStorePath({ storeArg: "", env: {}, homeDir: "/home/u" }),
    join("/home/u", ".fit-trace", "workouts.json"),
  );
});

test("returns a CORRUPT_STORE isError result when the store file is malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-"));
  try {
    const storePath = join(dir, "workouts.json");
    await writeFile(storePath, "{ this is not json", "utf8");
    await withClient(storePath, "", async (client) => {
      const result = await client.callTool({ name: "get_training_history", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(firstText(result), /CORRUPT_STORE/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
