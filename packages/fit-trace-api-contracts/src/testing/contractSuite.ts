import { stableStringify, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { API_ERROR_CODES } from "../errors.ts";
import { deriveWorkoutId } from "../deriveWorkoutId.ts";
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
}
