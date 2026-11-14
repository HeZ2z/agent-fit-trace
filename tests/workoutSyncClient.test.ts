import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkoutSyncClient, SYNC_REQUEST_TIMEOUT_MS } from "../packages/fit-trace-sync/src/syncClient.ts";

test("sync times out when the response body does not finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new WorkoutSyncClient({
    config: { status: "configured", baseUrl: "https://example.test/api/v1" },
    accessToken: "token",
    fetchImpl: async () => ({ status: 200, text: () => new Promise<string>(() => {}) }),
  });
  const pending = client.listRemoteWorkouts();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(SYNC_REQUEST_TIMEOUT_MS);
  await assert.rejects(pending, /network/i);
});

test("sync stops reading a response once it exceeds the byte limit", async () => {
  let reads = 0;
  const client = new WorkoutSyncClient({
    config: { status: "configured", baseUrl: "https://example.test/api/v1" },
    accessToken: "token",
    maxResponseBytes: 4,
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(5)); },
    })),
  });
  await assert.rejects(() => client.listRemoteWorkouts(), /response limit/i);
  assert.ok(reads <= 2);
});
