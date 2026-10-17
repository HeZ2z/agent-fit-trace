import { describe, it, expect } from "vitest";
import { analyzeProgress, generateNextPlan, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  API_ERROR_CODES,
  ApiError,
  buildImportedArtifact,
  encodeArtifactCursor,
  MalformedResponseError,
  NetworkError,
} from "@pi-fit-trace/api-contracts";
import type {
  ImportArtifactInput,
  ImportedArtifact,
  ImportedArtifactMeta,
  PlanAdoption,
} from "@pi-fit-trace/api-contracts";
import { createMemoryHandler, runFitTraceClientContractSuite } from "@pi-fit-trace/api-contracts/testing";
import type { HandlerInit } from "@pi-fit-trace/api-contracts/testing";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { HttpFitTraceClient } from "./httpFitTraceClient.ts";
import type { HttpFetch, HttpResponseLike } from "./httpFitTraceClient.ts";
import { LocalFitTraceClient } from "./localFitTraceClient.ts";

/**
 * Both clients must satisfy the same contract suite, and the HTTP client must
 * also map transport-level failures correctly. Each factory call builds fresh
 * state, so no test can leak into another.
 */

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

interface HttpFixture {
  client: HttpFitTraceClient;
  requestCount(): number;
}

/**
 * Test-side bridge: the memory handler takes bare resource paths and returns
 * `{ status, body: string }`, while the client speaks `/api/v1`-prefixed URLs
 * and `Response.text()`. Adapt here so production code stays fetch-shaped.
 */
function createHttpFixture(): HttpFixture {
  const local = new LocalFitTraceClient(new MemoryStorageAdapter());
  const handler = createMemoryHandler(local);
  let requests = 0;
  const fetchImpl = async (
    input: string,
    init?: HandlerInit,
  ): Promise<HttpResponseLike> => {
    requests += 1;
    const url = new URL(input, "http://fit-trace.invalid");
    const route = url.pathname.replace(/^\/api\/v1(?=\/|$)/, "");
    const response = await handler(`${route}${url.search}`, init);
    return { status: response.status, text: () => Promise.resolve(response.body) };
  };
  return {
    client: new HttpFitTraceClient({ fetchImpl }),
    requestCount: () => requests,
  };
}

function jsonResponse(data: unknown): HttpResponseLike {
  return { status: 200, text: () => JSON.stringify({ data }) };
}

function clientReturning(data: unknown): HttpFitTraceClient {
  return new HttpFitTraceClient({ fetchImpl: async () => jsonResponse(data) });
}

function analysisInput(weight: number): ImportArtifactInput<"analysis"> {
  const workout = validateWorkoutRecord({
    schema_version: 1,
    id: `w-bind-${weight}`,
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight, reps: 5, rpe: 7 }] }],
  }).record;
  return {
    kind: "analysis",
    payload_schema_version: 1,
    payload: analyzeProgress([workout]),
  };
}

function planInput(goal: string): ImportArtifactInput<"plan"> {
  return {
    kind: "plan",
    payload_schema_version: 1,
    payload: generateNextPlan([seedRecord({ id: "w-bind-plan", date: "2026-09-01" })], { goal }),
  };
}

function artifactFor<K extends ImportedArtifact["kind"]>(
  input: ImportArtifactInput<K>,
  createdAt: string,
): Promise<ImportedArtifact<K>> {
  return buildImportedArtifact(input, { created_at: createdAt });
}

function metaOf(artifact: ImportedArtifact): ImportedArtifactMeta {
  const { payload, ...meta } = artifact;
  void payload;
  return meta;
}

async function expectMalformedResponse(
  run: () => Promise<unknown>,
  field: string,
): Promise<void> {
  const error = await run().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MalformedResponseError);
  expect((error as MalformedResponseError).field).toBe(field);
}

describe("LocalFitTraceClient contract", () => {
  runFitTraceClientContractSuite(
    "LocalFitTraceClient",
    (name, fn) => it(name, fn),
    () => new LocalFitTraceClient(new MemoryStorageAdapter()),
  );
});

describe("HttpFitTraceClient contract", () => {
  runFitTraceClientContractSuite(
    "HttpFitTraceClient",
    (name, fn) => it(name, fn),
    () => createHttpFixture().client,
  );

  it("rejects a success body that is not valid JSON with MalformedResponseError", async () => {
    const client = new HttpFitTraceClient({
      fetchImpl: async () => ({ status: 200, text: () => "{not json" }),
    });
    await expect(client.listWorkouts()).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("rejects wrong-shaped data naming the offending field", async () => {
    const client = new HttpFitTraceClient({
      fetchImpl: async () => ({
        status: 200,
        text: () =>
          JSON.stringify({
            data: { period: { from: null, to: null }, trends: [], flags: [], source_records: [] },
          }),
      }),
    });
    const error = await client.analyze().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect((error as MalformedResponseError).field).toBe("metrics");
  });

  it("maps a 409 error envelope to an ApiError with the server code and status", async () => {
    const client = new HttpFitTraceClient({
      fetchImpl: async () => ({
        status: 409,
        text: () =>
          JSON.stringify({ error: { code: API_ERROR_CODES.CONFLICT, message: "already exists" } }),
      }),
    });
    const error = await client
      .createWorkout(seedRecord({ id: "w-409", date: "2026-09-01" }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(API_ERROR_CODES.CONFLICT);
    expect((error as ApiError).status).toBe(409);
  });

  it("maps an unparseable error body to an ApiError with code API_ERROR", async () => {
    const client = new HttpFitTraceClient({
      fetchImpl: async () => ({ status: 500, text: () => "boom" }),
    });
    const error = await client.listWorkouts().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(API_ERROR_CODES.API_ERROR);
    expect((error as ApiError).status).toBe(500);
  });

  it("wraps a transport rejection in NetworkError without retrying", async () => {
    let requests = 0;
    const client = new HttpFitTraceClient({
      fetchImpl: async () => {
        requests += 1;
        throw new TypeError("offline");
      },
    });
    await expect(client.listWorkouts()).rejects.toBeInstanceOf(NetworkError);
    expect(requests).toBe(1);
  });

  it("sends exactly one request per createWorkout, including duplicate retries", async () => {
    const { client, requestCount } = createHttpFixture();
    const record = seedRecord({ id: "w-retry", date: "2026-09-01" });

    const first = await client.createWorkout(record);
    expect(first.duplicate).toBe(false);
    expect(requestCount()).toBe(1);

    const retry = await client.createWorkout(record);
    expect(retry.duplicate).toBe(true);
    // No client-side retry loop: the duplicate attempt is one more request.
    expect(requestCount()).toBe(2);
  });

  it("rejects getImportedArtifact when the response is a different artifact", async () => {
    const requested = await artifactFor(analysisInput(80), "2026-09-01T00:00:00.000Z");
    const other = await artifactFor(analysisInput(95), "2026-09-02T00:00:00.000Z");
    await expectMalformedResponse(
      () => clientReturning(other).getImportedArtifact(requested.id),
      "id",
    );
  });

  it("rejects a save response that is not the submitted snapshot", async () => {
    const other = await artifactFor(analysisInput(95), "2026-09-01T00:00:00.000Z");
    const client = clientReturning({ artifact: other, duplicate: false, warnings: [] });
    const error = await client.saveImportedArtifact(analysisInput(80)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect((error as MalformedResponseError).field).toBe("id");
    // A malformed reply can arrive after the server committed: the client must
    // not claim the write failed, only that the outcome is ambiguous.
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("normalizes save input before the wire and preserves unknown-field warnings", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const stored = await artifactFor(analysisInput(80), "2026-09-01T00:00:00.000Z");
    const fetchImpl: HttpFetch = async (_input, init) => {
      requestBody = JSON.parse(init?.body ?? "") as Record<string, unknown>;
      return jsonResponse({
        // The stored snapshot keeps its original filename; a duplicate save
        // must not require the reply to echo the submitted filename.
        artifact: { ...stored, source_filename: "stored-original.json" },
        duplicate: true,
        warnings: [],
      });
    };
    const rawInput = {
      ...analysisInput(80),
      source_filename: "/tmp/exports/analysis.json",
      extra: true,
    } as unknown as ImportArtifactInput<"analysis">;

    const result = await new HttpFitTraceClient({ fetchImpl }).saveImportedArtifact(rawInput);

    expect(requestBody).toEqual({
      kind: "analysis",
      payload_schema_version: 1,
      payload: analysisInput(80).payload,
      source_filename: "analysis.json",
    });
    expect(requestBody ?? {}).not.toHaveProperty("extra");
    expect(result.artifact.source_filename).toBe("stored-original.json");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_FIELD", path: "(root).extra" }),
    );
  });

  it("rejects list metadata outside the requested kind, order, limit, or cursor window", async () => {
    const older = await artifactFor(analysisInput(80), "2026-09-01T00:00:00.000Z");
    const newer = await artifactFor(analysisInput(85), "2026-09-02T00:00:00.000Z");
    const newest = await artifactFor(analysisInput(90), "2026-09-03T00:00:00.000Z");
    const plan = await artifactFor(planInput("add 5 kg"), "2026-09-01T00:00:00.000Z");

    await expectMalformedResponse(
      () =>
        clientReturning({ items: [metaOf(plan)], next_cursor: null }).listImportedArtifacts({
          kind: "analysis",
        }),
      "items",
    );
    await expectMalformedResponse(
      () =>
        clientReturning({ items: [metaOf(older), metaOf(newer)], next_cursor: null })
          .listImportedArtifacts({ kind: "analysis" }),
      "items",
    );
    await expectMalformedResponse(
      () =>
        clientReturning({ items: [metaOf(newer), metaOf(older)], next_cursor: null })
          .listImportedArtifacts({ limit: 1 }),
      "items",
    );
    const cursor = encodeArtifactCursor({
      kind: newer.kind,
      created_at: newer.created_at,
      id: newer.id,
    });
    await expectMalformedResponse(
      () =>
        clientReturning({ items: [metaOf(newest)], next_cursor: null })
          .listImportedArtifacts({ kind: "analysis", cursor }),
      "items",
    );
  });

  it("rejects a next_cursor that does not continue from the last item", async () => {
    const newest = await artifactFor(analysisInput(90), "2026-09-03T00:00:00.000Z");
    const older = await artifactFor(analysisInput(80), "2026-09-01T00:00:00.000Z");
    const staleCursor = encodeArtifactCursor({
      kind: older.kind,
      created_at: older.created_at,
      id: older.id,
    });
    await expectMalformedResponse(
      () =>
        clientReturning({ items: [metaOf(newest)], next_cursor: staleCursor })
          .listImportedArtifacts({ kind: "analysis" }),
      "next_cursor",
    );
  });

  it("rejects a selection response for a different artifact", async () => {
    const requested = await artifactFor(analysisInput(80), "2026-09-01T00:00:00.000Z");
    const other = await artifactFor(analysisInput(95), "2026-09-02T00:00:00.000Z");
    await expectMalformedResponse(
      () =>
        clientReturning({ artifact_id: other.id }).setArtifactSelection(
          "analysis",
          requested.id,
        ),
      "artifact_id",
    );
  });

  it("rejects an adoption response that does not echo the request", async () => {
    const plan = await artifactFor(planInput("add 5 kg"), "2026-09-01T00:00:00.000Z");
    const otherPlan = await artifactFor(planInput("add 10 kg"), "2026-09-02T00:00:00.000Z");
    const mismatched: PlanAdoption = {
      artifact_id: plan.id,
      confirmed_digest: otherPlan.content_digest,
      confirmed_at: "2026-09-05T00:00:00.000Z",
    };

    await expectMalformedResponse(
      () =>
        clientReturning(mismatched).setPlanAdoption({
          artifact_id: plan.id,
          confirmed_digest: plan.content_digest,
        }),
      "confirmed_digest",
    );
    await expectMalformedResponse(
      () => clientReturning(mismatched).setPlanAdoption(null),
      "(root)",
    );
    await expectMalformedResponse(
      () =>
        clientReturning(null).setPlanAdoption({
          artifact_id: plan.id,
          confirmed_digest: plan.content_digest,
        }),
      "(root)",
    );
  });
});
