import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_ERROR_CODES,
  ApiError,
  MalformedResponseError,
  NetworkError,
} from "@agent-fit-trace/api-contracts";
import { CURRENT_SCHEMA_VERSION } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import {
  canSync,
  classifySyncFailure,
  classifySyncStatus,
  planSync,
} from "../mobile/src/sync/syncModel.ts";
import { resolveSyncConfig } from "../mobile/src/sync/syncConfig.ts";

/**
 * Pure coverage for the mobile sync foundation.
 *
 * No network, Expo, SQLite or React is imported: the plan model and config
 * resolver are deterministic, so the root `node:test` suite never needs a
 * device or a server. HTTP behavior is covered by types and the app export,
 * not by a live request.
 */

function record(id: string, overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id,
    schema_version: CURRENT_SCHEMA_VERSION,
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "Back squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

function ids(records: readonly WorkoutRecord[]): string[] {
  return records.map((entry) => entry.id);
}

test("empty history on both sides yields an empty plan", () => {
  const plan = planSync([], []);

  assert.deepEqual(plan, {
    toPush: [],
    toInsertLocal: [],
    identical: 0,
    conflicts: [],
    summary: {
      toPush: 0,
      toInsertLocal: 0,
      identical: 0,
      conflicts: 0,
      total: 0,
    },
  });
});

test("local-only records are scheduled for push in ascending id order", () => {
  const plan = planSync([record("wkt_b"), record("wkt_a")], []);

  assert.deepEqual(ids(plan.toPush), ["wkt_a", "wkt_b"]);
  assert.deepEqual(plan.toInsertLocal, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.identical, 0);
  assert.equal(plan.summary.total, 2);
});

test("remote-only records are scheduled for local insertion in ascending id order", () => {
  const plan = planSync([], [record("wkt_d"), record("wkt_c")]);

  assert.deepEqual(ids(plan.toInsertLocal), ["wkt_c", "wkt_d"]);
  assert.deepEqual(plan.toPush, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.identical, 0);
  assert.equal(plan.summary.total, 2);
});

test("disjoint local and remote histories produce one push and one insert", () => {
  const plan = planSync([record("local")], [record("remote")]);

  assert.deepEqual(ids(plan.toPush), ["local"]);
  assert.deepEqual(ids(plan.toInsertLocal), ["remote"]);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.identical, 0);
  assert.equal(plan.summary.total, 2);
});

test("same-id/same-content records are identical and never pushed or inserted", () => {
  const local = record("shared", { notes: "felt strong" });
  const remote = record("shared", { notes: "felt strong" });

  const plan = planSync([local], [remote]);

  assert.deepEqual(plan.toPush, []);
  assert.deepEqual(plan.toInsertLocal, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.identical, 1);
  assert.deepEqual(plan.summary, {
    toPush: 0,
    toInsertLocal: 0,
    identical: 1,
    conflicts: 0,
    total: 1,
  });
});

test("same-id/different-content records become conflicts and are never overwritten", () => {
  const local = record("shared", { notes: "local version" });
  const remote = record("shared", { notes: "cloud version" });

  const plan = planSync([local], [remote]);

  assert.deepEqual(plan.toPush, []);
  assert.deepEqual(plan.toInsertLocal, []);
  assert.equal(plan.identical, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0]?.id, "shared");
  assert.equal(plan.conflicts[0]?.local, local, "the local record is offered unchanged");
  assert.equal(plan.conflicts[0]?.remote, remote, "the cloud record is offered unchanged");
  assert.deepEqual(plan.summary, {
    toPush: 0,
    toInsertLocal: 0,
    identical: 0,
    conflicts: 1,
    total: 1,
  });
});

test("mixed histories are partitioned deterministically regardless of input order", () => {
  const local = [
    record("c-identical"),
    record("b-conflict", { notes: "local" }),
    record("a-local-only"),
  ];
  const remote = [
    record("e-remote-only"),
    record("c-identical"),
    record("b-conflict", { notes: "cloud" }),
  ];

  const plan = planSync(local, remote);

  assert.deepEqual(ids(plan.toPush), ["a-local-only"]);
  assert.deepEqual(ids(plan.toInsertLocal), ["e-remote-only"]);
  assert.deepEqual(
    plan.conflicts.map((entry) => entry.id),
    ["b-conflict"],
  );
  assert.equal(plan.identical, 1);
  assert.deepEqual(plan.summary, {
    toPush: 1,
    toInsertLocal: 1,
    identical: 1,
    conflicts: 1,
    total: 4,
  });

  const reversed = planSync([...local].reverse(), [...remote].reverse());
  assert.deepEqual(ids(reversed.toPush), ids(plan.toPush));
  assert.deepEqual(ids(reversed.toInsertLocal), ids(plan.toInsertLocal));
  assert.deepEqual(
    reversed.conflicts.map((entry) => entry.id),
    plan.conflicts.map((entry) => entry.id),
  );
  assert.deepEqual(reversed.summary, plan.summary);
});

test("planning never mutates the input lists or their records", () => {
  const local = [record("b", { notes: "local" }), record("a")];
  const remote = [record("b", { notes: "cloud" }), record("c")];
  const localBefore = structuredClone(local);
  const remoteBefore = structuredClone(remote);

  planSync(local, remote);

  assert.deepEqual(local, localBefore);
  assert.deepEqual(remote, remoteBefore);
});

test("an identical duplicate id within one side is represented once", () => {
  const plan = planSync(
    [record("a"), record("a")],
    [record("a")],
  );

  assert.equal(plan.identical, 1);
  assert.deepEqual(plan.toPush, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.summary.total, 1);
});

test("two different records with one id on the same side fail closed", () => {
  assert.throws(
    () => planSync([record("a"), record("a", { notes: "different" })], []),
    /two different records with id "a"/,
  );
  assert.throws(() => planSync([], [record("a"), record("a", { date: "2026-09-02" })]), /remote/);
});

test("failure classification maps typed errors and status codes to UI buckets", () => {
  assert.equal(classifySyncFailure(new NetworkError()), "offline");
  assert.equal(classifySyncFailure({ code: API_ERROR_CODES.NETWORK_ERROR }), "offline");
  assert.equal(classifySyncFailure({ name: "NetworkError" }), "offline");

  assert.equal(
    classifySyncFailure(
      new ApiError({ code: API_ERROR_CODES.UNAUTHENTICATED, message: "expired", status: 401 }),
    ),
    "auth",
  );
  assert.equal(
    classifySyncFailure(new ApiError({ code: API_ERROR_CODES.FORBIDDEN, message: "scope", status: 403 })),
    "auth",
  );
  assert.equal(classifySyncFailure({ status: 401 }), "auth");
  assert.equal(classifySyncFailure({ status: 403 }), "auth");

  assert.equal(
    classifySyncFailure(new ApiError({ code: API_ERROR_CODES.CONFLICT, message: "exists", status: 409 })),
    "conflict",
  );
  assert.equal(classifySyncFailure({ status: 409 }), "conflict");
  assert.equal(classifySyncFailure(409), "conflict");

  assert.equal(
    classifySyncFailure(new ApiError({ code: API_ERROR_CODES.API_ERROR, message: "boom", status: 500 })),
    "other",
  );
  assert.equal(classifySyncFailure(new MalformedResponseError("(root)", "is not JSON")), "other");
  assert.equal(classifySyncFailure({ code: API_ERROR_CODES.VALIDATION_ERROR, status: 400 }), "other");
  assert.equal(classifySyncFailure(null), "other");
  assert.equal(classifySyncFailure("offline"), "other");
  assert.equal(classifySyncFailure(undefined), "other");
});

test("status classification only buckets auth and conflict", () => {
  assert.equal(classifySyncStatus(401), "auth");
  assert.equal(classifySyncStatus(403), "auth");
  assert.equal(classifySyncStatus(409), "conflict");
  assert.equal(classifySyncStatus(400), "other");
  assert.equal(classifySyncStatus(500), "other");
  assert.equal(classifySyncStatus(0), "other");
});

test("canSync requires both a signed-in session and configured cloud sync", () => {
  const authStatuses = ["loading", "signed-out", "signed-in", "unconfigured", "error"] as const;
  const configStatuses = ["configured", "unconfigured", "invalid"] as const;

  for (const authStatus of authStatuses) {
    for (const configStatus of configStatuses) {
      assert.equal(
        canSync(authStatus, configStatus),
        authStatus === "signed-in" && configStatus === "configured",
        `${authStatus}/${configStatus}`,
      );
    }
  }
});

test("sync config treats missing or blank values as unconfigured", () => {
  assert.deepEqual(resolveSyncConfig(undefined), { status: "unconfigured" });
  assert.deepEqual(resolveSyncConfig(null), { status: "unconfigured" });
  assert.deepEqual(resolveSyncConfig(""), { status: "unconfigured" });
  assert.deepEqual(resolveSyncConfig("   "), { status: "unconfigured" });
});

test("sync config accepts and normalizes absolute http(s) API bases", () => {
  assert.deepEqual(resolveSyncConfig(" https://fit-trace.example.com/api/v1/ "), {
    status: "configured",
    baseUrl: "https://fit-trace.example.com/api/v1",
  });
  assert.deepEqual(resolveSyncConfig("http://127.0.0.1:5199/api/v1"), {
    status: "configured",
    baseUrl: "http://127.0.0.1:5199/api/v1",
  });
  assert.deepEqual(resolveSyncConfig("https://fit-trace.example.com"), {
    status: "configured",
    baseUrl: "https://fit-trace.example.com",
  });
  assert.deepEqual(resolveSyncConfig("https://fit-trace.example.com/custom/api/v1/"), {
    status: "configured",
    baseUrl: "https://fit-trace.example.com/custom/api/v1",
  });
});

test("sync config rejects non-http(s), malformed and ambiguous bases", () => {
  assert.deepEqual(resolveSyncConfig("fit-trace.example.com/api/v1"), {
    status: "invalid",
    reason: "malformed-url",
  });
  assert.deepEqual(resolveSyncConfig("https://fit trace.example.com/api/v1"), {
    status: "invalid",
    reason: "malformed-url",
  });
  assert.deepEqual(resolveSyncConfig("/api/v1"), {
    status: "invalid",
    reason: "malformed-url",
  });
  assert.deepEqual(resolveSyncConfig("ftp://fit-trace.example.com/api/v1"), {
    status: "invalid",
    reason: "not-http",
  });
  assert.deepEqual(resolveSyncConfig("javascript:alert(1)"), {
    status: "invalid",
    reason: "not-http",
  });
  assert.deepEqual(resolveSyncConfig("https://user:secret@fit-trace.example.com/api/v1"), {
    status: "invalid",
    reason: "credentials",
  });
  assert.deepEqual(resolveSyncConfig("https://fit-trace.example.com/api/v1?owner=1"), {
    status: "invalid",
    reason: "query",
  });
  assert.deepEqual(resolveSyncConfig("https://fit-trace.example.com/api/v1#top"), {
    status: "invalid",
    reason: "fragment",
  });
});
