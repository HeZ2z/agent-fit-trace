import { describe, it, expect } from "vitest";
import { validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  API_ERROR_CODES,
  ApiError,
  MalformedResponseError,
  NetworkError,
} from "@pi-fit-trace/api-contracts";
import { createMemoryHandler, runFitTraceClientContractSuite } from "@pi-fit-trace/api-contracts/testing";
import type { HandlerInit } from "@pi-fit-trace/api-contracts/testing";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { HttpFitTraceClient } from "./httpFitTraceClient.ts";
import type { HttpResponseLike } from "./httpFitTraceClient.ts";
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
});
