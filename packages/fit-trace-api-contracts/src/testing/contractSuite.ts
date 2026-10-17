import {
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type { AnalysisResult, WorkoutRecord } from "@pi-fit-trace/core";
import { API_ERROR_CODES } from "../errors.ts";
import { deriveWorkoutId } from "../deriveWorkoutId.ts";
import type {
  ImportArtifactInput,
  ImportedArtifact,
  ImportedArtifactPage,
} from "../imports.ts";
import type { FitTraceClient } from "../types.ts";

/**
 * Runner-agnostic conformance suite for {@link FitTraceClient} implementations.
 *
 * The local and HTTP clients must be interchangeable, so the behaviors that
 * matter (idempotency, error codes, ordering, draft guarantees) are asserted
 * once and run against every implementation. No test-runner or `node:` imports
 * here: the host passes its own `test` registrar, and `factory` must hand out
 * a fresh, isolated client per call so tests never share state.
 */

export type ContractTestRegistrar = (name: string, fn: () => Promise<void>) => void;
export type ContractClientFactory = () => FitTraceClient | Promise<FitTraceClient>;
export type ContractReset = () => void | Promise<void>;

export function runFitTraceClientContractSuite(
  name: string,
  test: ContractTestRegistrar,
  factory: ContractClientFactory,
  reset?: ContractReset,
): void {
  const label = (message: string): string => `[${name}] ${message}`;

  const newClient = async (): Promise<FitTraceClient> => {
    if (reset !== undefined) await reset();
    return factory();
  };

  const record = (over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord =>
    validateWorkoutRecord({
      schema_version: 1,
      session_type: "strength",
      exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
      ...over,
    }).record;

  const assertEquals = (actual: unknown, expected: unknown, what: string): void => {
    if (stableStringify(actual) !== stableStringify(expected)) {
      throw new Error(
        label(`${what}: expected ${stableStringify(expected)}, got ${stableStringify(actual)}`),
      );
    }
  };

  const expectRejection = async (code: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      const received = (error as { code?: string }).code;
      if (received !== code) {
        throw new Error(
          label(`expected a ${code} rejection, got ${String(received)}: ${(error as Error).message}`),
        );
      }
      return;
    }
    throw new Error(label(`expected a ${code} rejection, but the call resolved.`));
  };

  test(`${name}: empty history lists no workouts`, async () => {
    const client = await newClient();
    assertEquals(await client.listWorkouts(), [], "empty history");
  });

  test(`${name}: list is deterministically ascending for out-of-order seeds`, async () => {
    const client = await newClient();
    await client.createWorkout(record({ id: "w-late", date: "2026-09-05" }));
    await client.createWorkout(record({ id: "w-early", date: "2026-09-01" }));
    await client.createWorkout(record({ id: "w-mid", date: "2026-09-03" }));
    const listed = await client.listWorkouts();
    assertEquals(
      listed.map((entry) => entry.id),
      ["w-early", "w-mid", "w-late"],
      "list order",
    );
  });

  test(`${name}: createWorkout returns the saved record and its warnings`, async () => {
    const client = await newClient();
    // A draft with neither id nor schema_version: the client must derive the
    // id from content and normalize the version, while surfacing warnings.
    const draft = { ...record({ id: "w-draft", date: "2026-09-01" }) } as Record<string, unknown>;
    delete draft.id;
    delete draft.schema_version;
    const result = await client.createWorkout(draft as unknown as WorkoutRecord);
    assertEquals(result.duplicate, false, "first create is not a duplicate");
    if (!result.warnings.some((warning) => warning.code === "MISSING_SCHEMA_VERSION")) {
      throw new Error(label("expected a MISSING_SCHEMA_VERSION warning."));
    }
    assertEquals(result.record.id, deriveWorkoutId(draft as unknown as WorkoutRecord), "derived id");
    assertEquals(result.record.schema_version, 1, "normalized schema_version");
    const listed = await client.listWorkouts();
    assertEquals(listed.length, 1, "history length after create");
    assertEquals(listed[0], result.record, "saved record matches the returned one");
  });

  test(`${name}: identical re-create is a duplicate no-op`, async () => {
    const client = await newClient();
    const seed = record({ id: "w-dup", date: "2026-09-01" });
    const first = await client.createWorkout(seed);
    const before = await client.listWorkouts();
    const second = await client.createWorkout(seed);
    assertEquals(second.duplicate, true, "re-create is a duplicate");
    assertEquals(second.record, first.record, "duplicate returns the stored record");
    assertEquals(await client.listWorkouts(), before, "history unchanged after duplicate");
  });

  test(`${name}: same id with different content conflicts`, async () => {
    const client = await newClient();
    await client.createWorkout(record({ id: "w-conf", date: "2026-09-01" }));
    await expectRejection(API_ERROR_CODES.CONFLICT, () =>
      client.createWorkout(
        record({
          id: "w-conf",
          date: "2026-09-01",
          exercises: [{ name: "bench_press", sets: [{ weight: 95, reps: 5, rpe: 9 }] }],
        }),
      ),
    );
  });

  test(`${name}: invalid record is rejected with VALIDATION_ERROR`, async () => {
    const client = await newClient();
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.createWorkout(
        record({
          id: "w-invalid",
          date: "2026-09-01",
          exercises: [{ name: "bench_press", sets: [{ weight: -5, reps: 5 }] }],
        }),
      ),
    );
  });

  test(`${name}: inverted date filter is rejected with VALIDATION_ERROR`, async () => {
    const client = await newClient();
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.analyze({ from: "2026-09-10", to: "2026-09-01" }),
    );
  });

  test(`${name}: analyze respects the filter`, async () => {
    const client = await newClient();
    await client.createWorkout(record({ id: "w-a1", date: "2026-09-01" }));
    await client.createWorkout(record({ id: "w-a2", date: "2026-09-08" }));
    const result = await client.analyze({ from: "2026-09-05" });
    assertEquals(result.source_records, ["w-a2"], "filtered source_records");
  });

  test(`${name}: plan draft is always confirmation-gated`, async () => {
    const client = await newClient();
    await client.createWorkout(record({ id: "w-plan", date: "2026-09-01" }));
    const draft = await client.createPlanDraft({ goal: "add 5 kg to bench" });
    assertEquals(draft.is_draft, true, "is_draft");
    assertEquals(draft.requires_confirmation, true, "requires_confirmation");
  });

  test(`${name}: list result is stable across two calls`, async () => {
    const client = await newClient();
    await client.createWorkout(record({ id: "w-stable", date: "2026-09-01" }));
    assertEquals(await client.listWorkouts(), await client.listWorkouts(), "repeat list");
  });

  /* --------------------------------------------------------------------- */
  /* Imported artifacts                                                     */
  /* --------------------------------------------------------------------- */

  const analysisInput = (over: { weight?: number; date?: string } = {}): ImportArtifactInput<"analysis"> => ({
    kind: "analysis",
    payload_schema_version: 1,
    payload: analyzeProgress([
      record({
        id: `w-analysis-${over.weight ?? 80}`,
        date: over.date ?? "2026-09-01",
        exercises: [
          { name: "bench_press", sets: [{ weight: over.weight ?? 80, reps: 5, rpe: 7 }] },
        ],
      }),
    ]),
  });

  const planInput = (): ImportArtifactInput<"plan"> => ({
    kind: "plan",
    payload_schema_version: 1,
    payload: generateNextPlan(
      [record({ id: "w-plan-source", date: "2026-09-01" })],
      { goal: "add 5 kg to bench" },
    ),
    source_filename: "../exports/plan.json",
  });

  const firstAnalysisPage = async (
    client: FitTraceClient,
    limit: number,
  ): Promise<ImportedArtifactPage> => client.listImportedArtifacts({ limit });

  test(`${name}: imported artifact identity is content-addressed and immutable`, async () => {
    const client = await newClient();
    const first = await client.saveImportedArtifact(analysisInput());
    assertEquals(first.duplicate, false, "first save is not a duplicate");
    if (!/^analysis:v1:[0-9a-f]{64}$/.test(first.artifact.id)) {
      throw new Error(label(`unexpected artifact id ${first.artifact.id}`));
    }
    const retry = await client.saveImportedArtifact(analysisInput());
    assertEquals(retry.duplicate, true, "identical retry is a duplicate");
    assertEquals(retry.artifact.id, first.artifact.id, "duplicate keeps the id");
    assertEquals(retry.artifact.created_at, first.artifact.created_at, "duplicate keeps created_at");

    const stored = await client.getImportedArtifact(first.artifact.id);
    assertEquals(stored, first.artifact, "stored artifact round-trips");
  });

  test(`${name}: filename is normalized and never part of the identity`, async () => {
    const client = await newClient();
    const named = await client.saveImportedArtifact({
      ...analysisInput(),
      source_filename: "/tmp/exports/analysis.json",
    });
    assertEquals(named.artifact.source_filename, "analysis.json", "basename only");

    // A duplicate keeps the original immutable metadata: the retry cannot
    // rewrite the stored filename, only confirm the payload matches.
    const bare = await client.saveImportedArtifact(analysisInput());
    assertEquals(bare.artifact.id, named.artifact.id, "filename does not change the id");
    assertEquals(bare.duplicate, true, "same payload is a duplicate");
    assertEquals(bare.artifact.source_filename, "analysis.json", "original filename preserved");
  });

  test(`${name}: missing artifact reads as NOT_FOUND`, async () => {
    const client = await newClient();
    await expectRejection(API_ERROR_CODES.NOT_FOUND, () =>
      client.getImportedArtifact("analysis:v1:" + "0".repeat(64)),
    );
  });

  test(`${name}: imported list returns metadata only and paginates without gaps`, async () => {
    const client = await newClient();
    const saved: ImportedArtifact[] = [];
    saved.push((await client.saveImportedArtifact(analysisInput({ weight: 80 }))).artifact);
    saved.push((await client.saveImportedArtifact(analysisInput({ weight: 90 }))).artifact);
    saved.push((await client.saveImportedArtifact(planInput())).artifact);

    const first = await firstAnalysisPage(client, 2);
    assertEquals(first.items.length, 2, "first page length");
    if (first.next_cursor === null) throw new Error(label("expected a next cursor"));
    for (const item of first.items) {
      if ((item as unknown as Record<string, unknown>).payload !== undefined) {
        throw new Error(label("list metadata must not include payloads"));
      }
    }

    const second = await client.listImportedArtifacts({ limit: 2, cursor: first.next_cursor });
    assertEquals(second.items.length, 1, "second page length");
    assertEquals(second.next_cursor, null, "last page has no cursor");

    const ids = [...first.items, ...second.items].map((item) => item.id).sort();
    assertEquals(ids, saved.map((artifact) => artifact.id).sort(), "paged ids");
    assertEquals(new Set(ids).size, saved.length, "no duplicates across pages");
  });

  test(`${name}: imported list filters by kind and rejects invalid windows`, async () => {
    const client = await newClient();
    const analysis = (await client.saveImportedArtifact(analysisInput())).artifact;
    const plan = (await client.saveImportedArtifact(planInput())).artifact;

    const analyses = await client.listImportedArtifacts({ kind: "analysis" });
    assertEquals(analyses.items.map((item) => item.id), [analysis.id], "analysis filter");
    const plans = await client.listImportedArtifacts({ kind: "plan" });
    assertEquals(plans.items.map((item) => item.id), [plan.id], "plan filter");

    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.listImportedArtifacts({ limit: 0 }),
    );
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.listImportedArtifacts({ limit: 101 }),
    );
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.listImportedArtifacts({ cursor: "not-a-cursor" }),
    );
  });

  test(`${name}: selection and adoption are explicit, separate mutations`, async () => {
    const client = await newClient();
    const analysis = (await client.saveImportedArtifact(analysisInput())).artifact;
    const plan = (await client.saveImportedArtifact(planInput())).artifact;

    assertEquals(await client.getArtifactSelection("analysis"), { artifact_id: null }, "default");
    assertEquals(await client.getArtifactSelection("plan"), { artifact_id: null }, "default plan");
    assertEquals(await client.getPlanAdoption(), null, "saving never adopts");

    const selected = await client.setArtifactSelection("analysis", analysis.id);
    assertEquals(selected, { artifact_id: analysis.id }, "selection set");
    assertEquals(await client.getArtifactSelection("analysis"), selected, "selection read");
    assertEquals(await client.getPlanAdoption(), null, "selection never adopts");

    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.setArtifactSelection("plan", analysis.id),
    );

    const adopted = await client.setPlanAdoption({
      artifact_id: plan.id,
      confirmed_digest: plan.content_digest,
    });
    if (adopted === null) throw new Error(label("expected an adoption"));
    assertEquals(adopted.artifact_id, plan.id, "adoption id");
    assertEquals(adopted.confirmed_digest, plan.content_digest, "adoption digest");
    assertEquals(await client.getPlanAdoption(), adopted, "adoption read");

    assertEquals(await client.setArtifactSelection("analysis", null), { artifact_id: null }, "clear selection");
    assertEquals((await client.getPlanAdoption())?.artifact_id, plan.id, "clearing a selection keeps adoption");

    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.setPlanAdoption({ artifact_id: analysis.id, confirmed_digest: analysis.content_digest }),
    );
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.setPlanAdoption({ artifact_id: plan.id, confirmed_digest: "0".repeat(64) }),
    );
    assertEquals(await client.setPlanAdoption(null), null, "revoke adoption");
  });

  test(`${name}: imported payloads are bounded before they are stored`, async () => {
    const client = await newClient();
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.saveImportedArtifact({
        ...analysisInput(),
        payload_schema_version: 2,
      } as unknown as ImportArtifactInput<"analysis">),
    );
    const huge = structuredClone(analysisInput().payload) as AnalysisResult;
    (huge as unknown as { source_records: string[] }).source_records = ["x".repeat(5000)];
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.saveImportedArtifact({ kind: "analysis", payload_schema_version: 1, payload: huge }),
    );
    const deep = structuredClone(analysisInput().payload) as unknown as Record<string, unknown>;
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 20; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.extra = next;
      cursor = next;
    }
    await expectRejection(API_ERROR_CODES.VALIDATION_ERROR, () =>
      client.saveImportedArtifact({
        kind: "analysis",
        payload_schema_version: 1,
        payload: deep as unknown as AnalysisResult,
      }),
    );
  });
}
