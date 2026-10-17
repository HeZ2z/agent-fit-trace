import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupabaseCoachingRequestRepository } from "../server/cloud/supabaseCoachingRepository.ts";
import { CloudError } from "../server/cloud/repository.ts";

test("cloud request repository: createSession supplies the required RPC TTL argument", async () => {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const repository = createSupabaseCoachingRequestRepository({
    supabaseUrl: "http://127.0.0.1:54321",
    publishableKey: "publishable-key",
    accessToken: "access-token",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ id: "session-1", expiresAt: 1_700_000_000_000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const session = await repository.createSession("session-1");
  assert.equal(session.id, "session-1");
  assert.match(seen?.url ?? "", /\/rest\/v1\/rpc\/coaching_create_session$/);
  assert.equal(seen?.body.p_id, "session-1");
  // The SQL signature has no default, so omitting this key makes PostgREST
  // report "function not found" instead of creating a session.
  assert.equal(typeof seen?.body.p_ttl_ms, "number");
});

test("cloud request repository: readRun accepts real Postgres JSON nulls for optional fields", async () => {
  const runEnvelope = (from: unknown, cancelRequestedAt: unknown, failure: unknown): unknown => ({
    run: {
      id: "run-1",
      sessionId: "session-1",
      accountId: "user-1",
      status: "completed",
      idempotencyKey: "idem-1",
      prompt: "Review my training.",
      snapshot: {
        snapshotId: "snap-1",
        source: "authenticated-store",
        accountId: "user-1",
        recordIds: [],
        recordCount: 0,
        from,
        to: null,
      },
      backendId: "cloud-default",
      runtimeId: "hosted-sdk",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:01:00.000Z",
      expiresAt: 1_700_000_000_000,
      cancelRequestedAt,
      cancelReason: null,
      providerCallStartedAt: null,
      providerFetchStartedAt: null,
      providerAcceptedAt: null,
      providerGenerationId: null,
      terminationConfirmed: true,
      reservationReleased: true,
      failure,
    },
    lastSeq: 1,
    firstSeq: 0,
    expiresAt: 1_700_000_000_000,
  });
  const repositoryFor = (body: unknown) =>
    createSupabaseCoachingRequestRepository({
      supabaseUrl: "http://127.0.0.1:54321",
      publishableKey: "publishable-key",
      accessToken: "access-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

  // This is the shape `coaching_run_json` really returns: optional dates and
  // failure objects are JSON null, not missing properties.
  const read = await repositoryFor(runEnvelope(null, null, null)).readRun("run-1");
  assert.equal(read.run.snapshot.from, undefined);
  assert.equal(read.run.snapshot.to, undefined);
  assert.equal(read.run.cancelRequestedAt, undefined);
  assert.equal(read.run.failure, undefined);

  // Normalization must not weaken validation for non-null values.
  await assert.rejects(
    repositoryFor(runEnvelope("", null, null)).readRun("run-1"),
    (error: unknown) => error instanceof Error && "field" in error && error.field === "snapshot.from",
  );
});

test("cloud request repository: database validation errors stay client errors, not storage outages", async () => {
  const repository = createSupabaseCoachingRequestRepository({
    supabaseUrl: "http://127.0.0.1:54321",
    publishableKey: "publishable-key",
    accessToken: "access-token",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          code: "22023",
          message: "CLOUD_INVALID: prompt exceeds the configured byte bound",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  });

  await assert.rejects(
    repository.createSession("session-1"),
    (error: unknown) =>
      error instanceof CloudError && error.code === "VALIDATION_ERROR" && error.status === 400,
  );
});
