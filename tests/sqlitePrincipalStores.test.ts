import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { PlanDraft, WorkoutRecord } from "@agent-fit-trace/core";
import { createAuthenticatedHandler } from "../server/authenticatedHandler.ts";
import { createLocalDaemonVerifier, LOCAL_DAEMON_BEARER } from "../server/auth/localVerifier.ts";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import { createSqlitePrincipalStores } from "../server/sqlitePrincipalStores.ts";
import type { PrincipalStoreFactory } from "../server/auth/verifier.ts";

/**
 * The daemon's SQLite-backed principal stores, exercised through the same
 * authenticated handler shape as `authenticatedApi.test.ts`, plus the
 * restart-persistence and corrupt-app_state behavior the in-memory backend
 * cannot have.
 */

const GUEST_AUTH = { authorization: `Bearer ${LOCAL_DAEMON_BEARER}` };

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

function makeHandler(stores: PrincipalStoreFactory) {
  return createAuthenticatedHandler({
    verifier: createLocalDaemonVerifier(),
    stores,
    publicConfig: null,
  });
}

async function withDataDir(
  run: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sqlite-principal-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("workout create, list, idempotent duplicate, and same-id conflict", async () => {
  await withDataDir(async (dataDir) => {
    const stores = createSqlitePrincipalStores(dataDir);
    try {
      const handler = makeHandler(stores);
      const record = seedRecord({ id: "w-guest", date: "2026-09-01" });

      const created = await handler("/workouts", {
        method: "POST",
        body: JSON.stringify({ record }),
        ...GUEST_AUTH,
      });
      assert.equal(created.status, 201);
      assert.equal(
        (JSON.parse(created.body) as { data: { duplicate: boolean } }).data.duplicate,
        false,
      );

      const retry = await handler("/workouts", {
        method: "POST",
        body: JSON.stringify({ record }),
        ...GUEST_AUTH,
      });
      assert.equal(retry.status, 200);
      assert.equal(
        (JSON.parse(retry.body) as { data: { duplicate: boolean } }).data.duplicate,
        true,
      );

      const list = JSON.parse((await handler("/workouts", GUEST_AUTH)).body) as {
        data: { id: string }[];
      };
      assert.deepEqual(
        list.data.filter((entry) => entry.id === "w-guest").map((entry) => entry.id),
        ["w-guest"],
      );

      const clash = await handler("/workouts", {
        method: "POST",
        body: JSON.stringify({
          record: seedRecord({
            id: "w-guest",
            date: "2026-09-02",
            exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }],
          }),
        }),
        ...GUEST_AUTH,
      });
      assert.equal(clash.status, 409);
      assert.equal(
        (JSON.parse(clash.body) as { error: { code: string } }).error.code,
        API_ERROR_CODES.CONFLICT,
      );
    } finally {
      stores.closeAll();
    }
  });
});

test("analyze respects the from/to window; inverted range → VALIDATION_ERROR", async () => {
  await withDataDir(async (dataDir) => {
    const stores = createSqlitePrincipalStores(dataDir);
    try {
      const handler = makeHandler(stores);
      for (const [id, date] of [
        ["w-an-early", "2026-10-02"],
        ["w-an-mid", "2026-10-05"],
        ["w-an-late", "2026-10-09"],
      ] as const) {
        const response = await handler("/workouts", {
          method: "POST",
          body: JSON.stringify({ record: seedRecord({ id, date }) }),
          ...GUEST_AUTH,
        });
        assert.equal(response.status, 201);
      }

      const analysis = await handler("/analysis?from=2026-10-03&to=2026-10-07", GUEST_AUTH);
      assert.equal(analysis.status, 200);
      assert.deepEqual(
        (JSON.parse(analysis.body) as { data: { source_records: string[] } }).data
          .source_records,
        ["w-an-mid"],
      );

      const inverted = await handler("/analysis?from=2026-09-10&to=2026-09-01", GUEST_AUTH);
      assert.equal(inverted.status, 400);
      assert.equal(
        (JSON.parse(inverted.body) as { error: { code: string } }).error.code,
        API_ERROR_CODES.VALIDATION_ERROR,
      );
    } finally {
      stores.closeAll();
    }
  });
});

test("plan drafts never write and validate constraints", async () => {
  await withDataDir(async (dataDir) => {
    const stores = createSqlitePrincipalStores(dataDir);
    try {
      const handler = makeHandler(stores);
      const before = JSON.parse((await handler("/workouts", GUEST_AUTH)).body) as {
        data: unknown[];
      };

      const draft = await handler("/plans/drafts", { method: "POST", ...GUEST_AUTH });
      assert.equal(draft.status, 200);
      const draftBody = JSON.parse(draft.body) as {
        data: { is_draft: boolean; requires_confirmation: boolean };
      };
      assert.equal(draftBody.data.is_draft, true);
      assert.equal(draftBody.data.requires_confirmation, true);

      const after = JSON.parse((await handler("/workouts", GUEST_AUTH)).body) as {
        data: unknown[];
      };
      assert.equal(after.data.length, before.data.length);

      const invalid = await handler("/plans/drafts", {
        method: "POST",
        body: JSON.stringify({ goal: 42 }),
        ...GUEST_AUTH,
      });
      assert.equal(invalid.status, 400);
      assert.equal(
        (JSON.parse(invalid.body) as { error: { code: string } }).error.code,
        API_ERROR_CODES.VALIDATION_ERROR,
      );
    } finally {
      stores.closeAll();
    }
  });
});

test("imported artifacts save/list/get, selection set/get, adoption set/clear", async () => {
  await withDataDir(async (dataDir) => {
    const stores = createSqlitePrincipalStores(dataDir);
    try {
      const handler = makeHandler(stores);

      const payload = analyzeProgress([seedRecord({ id: "w-imp", date: "2026-09-01" })]);
      const created = await handler("/imports", {
        method: "POST",
        body: JSON.stringify({ kind: "analysis", payload_schema_version: 1, payload }),
        ...GUEST_AUTH,
      });
      assert.equal(created.status, 201);
      const artifact = (
        JSON.parse(created.body) as {
          data: { artifact: { id: string; content_digest: string }; duplicate: boolean };
        }
      ).data.artifact;

      const retry = await handler("/imports", {
        method: "POST",
        body: JSON.stringify({ kind: "analysis", payload_schema_version: 1, payload }),
        ...GUEST_AUTH,
      });
      assert.equal(retry.status, 200);
      assert.equal(
        (JSON.parse(retry.body) as { data: { duplicate: boolean } }).data.duplicate,
        true,
      );

      const list = JSON.parse((await handler("/imports", GUEST_AUTH)).body) as {
        data: { items: { id: string }[] };
      };
      assert.deepEqual(list.data.items.map((item) => item.id), [artifact.id]);

      const fetched = await handler(`/imports/${encodeURIComponent(artifact.id)}`, GUEST_AUTH);
      assert.equal(fetched.status, 200);
      assert.equal(
        (JSON.parse(fetched.body) as { data: { id: string } }).data.id,
        artifact.id,
      );

      const selection = await handler("/import-selections/analysis", {
        method: "PUT",
        body: JSON.stringify({ artifact_id: artifact.id }),
        ...GUEST_AUTH,
      });
      assert.equal(selection.status, 200);
      assert.deepEqual(
        (JSON.parse(selection.body) as { data: unknown }).data,
        { artifact_id: artifact.id },
      );
      const selectionRead = JSON.parse(
        (await handler("/import-selections/analysis", GUEST_AUTH)).body,
      ) as { data: { artifact_id: string | null } };
      assert.deepEqual(selectionRead.data, { artifact_id: artifact.id });

      const cleared = await handler("/import-selections/analysis", {
        method: "PUT",
        body: JSON.stringify({ artifact_id: null }),
        ...GUEST_AUTH,
      });
      assert.equal(cleared.status, 200);
      const clearedRead = JSON.parse(
        (await handler("/import-selections/analysis", GUEST_AUTH)).body,
      ) as { data: { artifact_id: string | null } };
      assert.deepEqual(clearedRead.data, { artifact_id: null });

      // Adoption requires a plan snapshot; an analysis snapshot is rejected.
      const draft = (
        JSON.parse(
          (await handler("/plans/drafts", { method: "POST", ...GUEST_AUTH })).body,
        ) as { data: PlanDraft }
      ).data;
      const planCreated = await handler("/imports", {
        method: "POST",
        body: JSON.stringify({ kind: "plan", payload_schema_version: 1, payload: draft }),
        ...GUEST_AUTH,
      });
      assert.equal(planCreated.status, 201);
      const planArtifact = (
        JSON.parse(planCreated.body) as {
          data: { artifact: { id: string; content_digest: string } };
        }
      ).data.artifact;

      const analysisAdoption = await handler("/plan-adoption", {
        method: "PUT",
        body: JSON.stringify({ artifact_id: artifact.id, confirmed_digest: artifact.content_digest }),
        ...GUEST_AUTH,
      });
      assert.equal(analysisAdoption.status, 400);

      const adoption = await handler("/plan-adoption", {
        method: "PUT",
        body: JSON.stringify({
          artifact_id: planArtifact.id,
          confirmed_digest: planArtifact.content_digest,
        }),
        ...GUEST_AUTH,
      });
      assert.equal(adoption.status, 200);
      const adoptionData = (
        JSON.parse(adoption.body) as {
          data: { artifact_id: string; confirmed_digest: string; confirmed_at: string };
        }
      ).data;
      assert.equal(adoptionData.artifact_id, planArtifact.id);
      assert.equal(adoptionData.confirmed_digest, planArtifact.content_digest);

      const adoptionRead = JSON.parse(
        (await handler("/plan-adoption", GUEST_AUTH)).body,
      ) as { data: { artifact_id: string } | null };
      assert.equal(adoptionRead.data?.artifact_id, planArtifact.id);

      const revoked = await handler("/plan-adoption", {
        method: "PUT",
        body: JSON.stringify(null),
        ...GUEST_AUTH,
      });
      assert.equal(revoked.status, 200);
      const revokedRead = JSON.parse(
        (await handler("/plan-adoption", GUEST_AUTH)).body,
      ) as { data: unknown };
      assert.equal(revokedRead.data, null);
    } finally {
      stores.closeAll();
    }
  });
});

test("guest and alice are isolated into separate database files", async () => {
  await withDataDir(async (dataDir) => {
    // The daemon handler serves the guest; a second handler over the same
    // dataDir with an injected verifier stands in for the Supabase login path.
    const guestStores = createSqlitePrincipalStores(dataDir);
    const aliceStores = createSqlitePrincipalStores(dataDir);
    try {
      const guestHandler = makeHandler(guestStores);
      const aliceHandler = createAuthenticatedHandler({
        verifier: createTestVerifier({ "token-alice": { id: "alice" } }),
        stores: aliceStores,
        publicConfig: null,
      });
      const aliceAuth = { authorization: "Bearer token-alice" };

      const guestWrite = await guestHandler("/workouts", {
        method: "POST",
        body: JSON.stringify({ record: seedRecord({ id: "shared", date: "2026-09-01" }) }),
        ...GUEST_AUTH,
      });
      assert.equal(guestWrite.status, 201);

      const aliceWrite = await aliceHandler("/workouts", {
        method: "POST",
        body: JSON.stringify({ record: seedRecord({ id: "shared", date: "2026-09-02" }) }),
        ...aliceAuth,
      });
      // Same business id under a different owner is a separate record, not a conflict.
      assert.equal(aliceWrite.status, 201);

      const guestList = JSON.parse((await guestHandler("/workouts", GUEST_AUTH)).body) as {
        data: { date: string }[];
      };
      const aliceList = JSON.parse((await aliceHandler("/workouts", aliceAuth)).body) as {
        data: { date: string }[];
      };
      assert.deepEqual(guestList.data.map((entry) => entry.date), ["2026-09-01"]);
      assert.deepEqual(aliceList.data.map((entry) => entry.date), ["2026-09-02"]);

      const files = (await readdir(dataDir)).filter((name) => name.endsWith(".db")).sort();
      assert.deepEqual(files, ["alice.db", "guest.db"]);
    } finally {
      guestStores.closeAll();
      aliceStores.closeAll();
    }
  });
});

test("state survives closing and reopening the factory on the same dataDir", async () => {
  await withDataDir(async (dataDir) => {
    const first = createSqlitePrincipalStores(dataDir);
    let persisted: {
      artifactId: string;
      planArtifactId: string;
      digest: string;
      confirmedAt: string;
    };
    try {
      const handler = makeHandler(first);
      const workout = await handler("/workouts", {
        method: "POST",
        body: JSON.stringify({ record: seedRecord({ id: "w-persist", date: "2026-09-03" }) }),
        ...GUEST_AUTH,
      });
      assert.equal(workout.status, 201);

      const payload = analyzeProgress([seedRecord({ id: "w-persist", date: "2026-09-03" })]);
      const artifactCreated = await handler("/imports", {
        method: "POST",
        body: JSON.stringify({ kind: "analysis", payload_schema_version: 1, payload }),
        ...GUEST_AUTH,
      });
      const artifact = (
        JSON.parse(artifactCreated.body) as {
          data: { artifact: { id: string; content_digest: string } };
        }
      ).data.artifact;

      const selection = await handler("/import-selections/analysis", {
        method: "PUT",
        body: JSON.stringify({ artifact_id: artifact.id }),
        ...GUEST_AUTH,
      });
      assert.equal(selection.status, 200);

      const draft = (
        JSON.parse(
          (await handler("/plans/drafts", { method: "POST", ...GUEST_AUTH })).body,
        ) as { data: PlanDraft }
      ).data;
      const planCreated = await handler("/imports", {
        method: "POST",
        body: JSON.stringify({ kind: "plan", payload_schema_version: 1, payload: draft }),
        ...GUEST_AUTH,
      });
      const planArtifact = (
        JSON.parse(planCreated.body) as {
          data: { artifact: { id: string; content_digest: string } };
        }
      ).data.artifact;
      const adoption = await handler("/plan-adoption", {
        method: "PUT",
        body: JSON.stringify({
          artifact_id: planArtifact.id,
          confirmed_digest: planArtifact.content_digest,
        }),
        ...GUEST_AUTH,
      });
      const adoptionData = (
        JSON.parse(adoption.body) as {
          data: { confirmed_at: string };
        }
      ).data;

      persisted = {
        artifactId: artifact.id,
        planArtifactId: planArtifact.id,
        digest: planArtifact.content_digest,
        confirmedAt: adoptionData.confirmed_at,
      };
    } finally {
      first.closeAll();
    }

    // Restart: a fresh factory over the same directory must observe everything.
    const second = createSqlitePrincipalStores(dataDir);
    try {
      const handler = makeHandler(second);

      const list = JSON.parse((await handler("/workouts", GUEST_AUTH)).body) as {
        data: { id: string }[];
      };
      assert.deepEqual(
        list.data.filter((entry) => entry.id === "w-persist").map((entry) => entry.id),
        ["w-persist"],
      );

      const imports = JSON.parse((await handler("/imports", GUEST_AUTH)).body) as {
        data: { items: { id: string }[] };
      };
      assert.deepEqual(
        imports.data.items.map((item) => item.id).sort(),
        [persisted.artifactId, persisted.planArtifactId].sort(),
      );

      const selection = JSON.parse(
        (await handler("/import-selections/analysis", GUEST_AUTH)).body,
      ) as { data: { artifact_id: string | null } };
      assert.deepEqual(selection.data, { artifact_id: persisted.artifactId });

      const adoption = JSON.parse((await handler("/plan-adoption", GUEST_AUTH)).body) as {
        data: { artifact_id: string; confirmed_digest: string; confirmed_at: string } | null;
      };
      assert.equal(adoption.data?.artifact_id, persisted.planArtifactId);
      assert.equal(adoption.data?.confirmed_digest, persisted.digest);
      assert.equal(adoption.data?.confirmed_at, persisted.confirmedAt);
    } finally {
      second.closeAll();
    }
  });
});

test("local verifier resolves the fixed token to guest and rejects everything else", async () => {
  const verifier = createLocalDaemonVerifier();
  const principal = await verifier.verify(LOCAL_DAEMON_BEARER);
  assert.deepEqual(principal, { id: "guest" });

  for (const token of ["nope", "fit-trace-local-daemon ", ""]) {
    await assert.rejects(
      verifier.verify(token),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "UNAUTHENTICATED",
    );
  }
});

test("a corrupt app_state row surfaces a diagnosable error naming the key", async () => {
  await withDataDir(async (dataDir) => {
    const first = createSqlitePrincipalStores(dataDir);
    try {
      const client = first.storeFor({ id: "guest" });
      await client.saveImportedArtifact({
        kind: "analysis",
        payload_schema_version: 1,
        payload: analyzeProgress([seedRecord({ id: "w-corrupt", date: "2026-09-01" })]),
      });
    } finally {
      first.closeAll();
    }

    // Corrupt the persisted document behind the client's back; the restarted
    // client's lazy load must fail loudly instead of silently resetting state.
    const raw = new DatabaseSync(join(dataDir, "guest.db"));
    try {
      raw.exec("UPDATE app_state SET value='{bad' WHERE key='imported_artifacts'");
    } finally {
      raw.close();
    }

    const second = createSqlitePrincipalStores(dataDir);
    try {
      const client = second.storeFor({ id: "guest" });
      await assert.rejects(
        client.listImportedArtifacts(),
        (error: unknown) =>
          error instanceof ApiError &&
          error.code === API_ERROR_CODES.CORRUPT_STORE &&
          error.message.includes("imported_artifacts"),
      );
    } finally {
      second.closeAll();
    }
  });
});

test("a malformed artifact element in app_state reports CORRUPT_STORE with its index", async () => {
  await withDataDir(async (dataDir) => {
    const first = createSqlitePrincipalStores(dataDir);
    try {
      const client = first.storeFor({ id: "guest" });
      await client.saveImportedArtifact({
        kind: "analysis",
        payload_schema_version: 1,
        payload: analyzeProgress([seedRecord({ id: "w-malformed", date: "2026-09-01" })]),
      });
    } finally {
      first.closeAll();
    }

    // Corrupt the array element itself (a bare `null`), not the JSON envelope:
    // the restarted client must name the failing element instead of tripping on
    // `entry.id` with an opaque error.
    const raw = new DatabaseSync(join(dataDir, "guest.db"));
    try {
      raw.exec("UPDATE app_state SET value='[null]' WHERE key='imported_artifacts'");
    } finally {
      raw.close();
    }

    const second = createSqlitePrincipalStores(dataDir);
    try {
      const client = second.storeFor({ id: "guest" });
      for (const touch of [
        () => client.listImportedArtifacts(),
        () => client.getImportedArtifact("w-malformed"),
        () => client.saveImportedArtifact({
          kind: "analysis",
          payload_schema_version: 1,
          payload: analyzeProgress([seedRecord({ id: "w-malformed-2", date: "2026-09-02" })]),
        }),
      ]) {
        await assert.rejects(
          touch(),
          (error: unknown) =>
            error instanceof ApiError &&
            error.code === API_ERROR_CODES.CORRUPT_STORE &&
            error.message.includes("imported_artifacts") &&
            error.message.includes("index 0") &&
            (error.details as { key?: string; index?: number }).key === "imported_artifacts" &&
            (error.details as { key?: string; index?: number }).index === 0,
        );
      }
    } finally {
      second.closeAll();
    }
  });
});
