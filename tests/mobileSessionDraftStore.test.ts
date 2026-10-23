import assert from "node:assert/strict";
import { test } from "node:test";

import { stableStringify } from "@agent-fit-trace/core";
import {
  CORRUPT_SESSION_DRAFT,
  SessionDraftCorruptionError,
  createDraftPain,
  createSessionDraft,
} from "../packages/fit-trace-workout-session/src/index.ts";
import type { SessionDraft } from "../packages/fit-trace-workout-session/src/index.ts";
import {
  SESSION_DRAFT_TABLE_SQL,
  WORKOUTS_DB_SCHEMA_VERSION,
  WORKOUTS_MIGRATIONS,
  WORKOUTS_TABLE_SQL,
  latestWorkoutSchemaVersion,
  pendingWorkoutMigrations,
} from "../mobile/src/data/schema.ts";
import {
  LOCAL_GUEST_OWNER_ID,
  fromSessionDraftRow,
  toSessionDraftRow,
} from "../mobile/src/data/sessionDraftSchema.ts";
import type { SessionDraftRow } from "../mobile/src/data/sessionDraftSchema.ts";

/**
 * Pure coverage for the mobile session-draft persistence boundary: the SQLite
 * migration that creates the draft table and the row <-> draft mapping.
 *
 * The native repository is intentionally not imported: only dependency-free
 * modules are exercised, so the root `node:test` suite never needs expo or a
 * device runtime. The shared payload codec is tested in its own suite.
 */

const UPDATED_AT = "2026-10-24T01:30:00.000Z";
const OWNER = "owner-a";

function timedDraft(): SessionDraft {
  const draft = createSessionDraft("2026-10-24");
  return {
    ...draft,
    durationMinutes: "",
    sleepHours: "7.5",
    notes: "morning session",
    exercises: [
      {
        key: 1,
        name: "bench_press",
        restSeconds: 120,
        sets: [
          { key: 2, reps: "5", weight: "80", rpe: "8", done: true, prefilled: false },
          { key: 3, reps: "5", weight: "80", rpe: "", done: false, prefilled: true },
        ],
      },
    ],
    pain: [{ ...createDraftPain(4), area: "lower_back", level: "2" }],
    timing: {
      startedAtMs: 1_000,
      endedAtMs: null,
      pausedAtMs: null,
      pausedTotalMs: 0,
      lastActiveAtMs: 1_500,
    },
  };
}

function rowFor(draft: SessionDraft = createSessionDraft("2026-10-24")): SessionDraftRow {
  return toSessionDraftRow(OWNER, draft, UPDATED_AT);
}

test("the migration list is contiguous and ends at schema version 2", () => {
  assert.equal(WORKOUTS_DB_SCHEMA_VERSION, 2);
  assert.equal(WORKOUTS_DB_SCHEMA_VERSION, latestWorkoutSchemaVersion());
  assert.deepEqual(
    WORKOUTS_MIGRATIONS.map((migration) => migration.version),
    [1, 2],
    "migration v2 is appended after the untouched v1",
  );
  for (const migration of WORKOUTS_MIGRATIONS) {
    assert.ok(migration.statements.length > 0, `migration v${migration.version} has statements`);
  }
});

test("a v1 database only applies the session-draft migration", () => {
  const pending = pendingWorkoutMigrations(1);
  assert.deepEqual(
    pending.map((migration) => migration.version),
    [2],
    "the workouts table migration never re-runs",
  );
  assert.deepEqual(pending[0].statements, [SESSION_DRAFT_TABLE_SQL]);
  assert.ok(!pending[0].statements.includes(WORKOUTS_TABLE_SQL));
  assert.doesNotMatch(pending[0].statements.join("\n"), /\bworkouts\b/i);

  assert.deepEqual(pendingWorkoutMigrations(WORKOUTS_DB_SCHEMA_VERSION), []);
  assert.deepEqual(
    pendingWorkoutMigrations(0).map((migration) => migration.version),
    [1, 2],
    "a fresh database applies both migrations in order",
  );
  assert.throws(
    () => pendingWorkoutMigrations(WORKOUTS_DB_SCHEMA_VERSION + 1),
    /newer than supported/,
  );
});

test("v1 still creates only the workouts table and its index", () => {
  const v1 = WORKOUTS_MIGRATIONS[0];
  assert.equal(v1.version, 1);
  assert.ok(v1.statements.includes(WORKOUTS_TABLE_SQL));
  assert.doesNotMatch(v1.statements.join("\n"), /session_draft/i);
});

test("the draft DDL is owner-scoped, single-row and self-creating", () => {
  assert.match(SESSION_DRAFT_TABLE_SQL, /CREATE TABLE IF NOT EXISTS session_draft/i);
  assert.match(SESSION_DRAFT_TABLE_SQL, /owner_id TEXT PRIMARY KEY NOT NULL/i);
  assert.match(SESSION_DRAFT_TABLE_SQL, /payload TEXT NOT NULL/i);
  assert.match(SESSION_DRAFT_TABLE_SQL, /updated_at TEXT NOT NULL/i);
  assert.doesNotMatch(SESSION_DRAFT_TABLE_SQL, /rest/i, "rest is transient and never stored");
  assert.ok(
    !/UNIQUE\s*\(\s*owner_id/i.test(SESSION_DRAFT_TABLE_SQL),
    "the primary key is the owner",
  );
});

test("migration v2 is exactly the draft table", () => {
  const v2 = WORKOUTS_MIGRATIONS[1];
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.statements, [SESSION_DRAFT_TABLE_SQL]);
});

test("a row round-trips a timed draft through canonical payload JSON", () => {
  const draft = timedDraft();
  const row = rowFor(draft);

  assert.deepEqual(row, {
    owner_id: OWNER,
    payload: stableStringify(draft),
    updated_at: UPDATED_AT,
  });
  assert.deepEqual(fromSessionDraftRow(row), draft);
  assert.deepEqual(toSessionDraftRow(OWNER, fromSessionDraftRow(row), UPDATED_AT), row);
});

test("untimed drafts and invalid mid-edit input are restored, not rejected", () => {
  const draft: SessionDraft = {
    ...createSessionDraft(""),
    sessionType: "cardio",
    exercises: [{ key: 1, name: "", restSeconds: 0, sets: [] }],
    notes: "mid-edit",
    timing: null,
  };

  assert.deepEqual(fromSessionDraftRow(rowFor(draft)), draft);
  assert.equal(fromSessionDraftRow(rowFor(draft)).timing, null);
});

test("owner identity is part of the row, and the guest owner is stable", () => {
  assert.equal(LOCAL_GUEST_OWNER_ID, "local-guest");

  const guestRow = toSessionDraftRow(
    LOCAL_GUEST_OWNER_ID,
    createSessionDraft("2026-10-24"),
    UPDATED_AT,
  );
  const otherRow = toSessionDraftRow("owner-b", createSessionDraft("2026-10-24"), UPDATED_AT);

  assert.equal(guestRow.owner_id, "local-guest");
  assert.equal(otherRow.owner_id, "owner-b");
  assert.equal(guestRow.payload, otherRow.payload, "the owner is not part of the draft payload");
});

test("a bad payload throws the shared corruption error", () => {
  const valid = rowFor();

  const payloads: unknown[] = [
    "{not json",
    "",
    JSON.stringify({ version: 999 }),
    42,
    null,
  ];
  for (const payload of payloads) {
    assert.throws(
      () => fromSessionDraftRow({ ...valid, payload: payload as string }),
      (error: unknown) => {
        assert.ok(error instanceof SessionDraftCorruptionError);
        assert.equal(error.code, CORRUPT_SESSION_DRAFT);
        assert.equal(error.name, "SessionDraftCorruptionError");
        return true;
      },
      `payload ${JSON.stringify(payload)} must fail closed`,
    );
  }
});

test("owner id and update timestamp must be non-empty", () => {
  const draft = createSessionDraft("2026-10-24");
  const valid = rowFor(draft);

  for (const ownerId of ["", "   ", undefined, null]) {
    assert.throws(
      () => toSessionDraftRow(ownerId as unknown as string, draft, UPDATED_AT),
      TypeError,
      `owner id ${String(ownerId)} must be rejected`,
    );
  }
  for (const updatedAt of ["", "   ", undefined, null]) {
    assert.throws(
      () => toSessionDraftRow(OWNER, draft, updatedAt as unknown as string),
      TypeError,
      `timestamp ${String(updatedAt)} must be rejected`,
    );
  }

  assert.throws(() => fromSessionDraftRow({ ...valid, owner_id: "" }), TypeError);
  assert.throws(() => fromSessionDraftRow({ ...valid, owner_id: "  " }), TypeError);
  assert.throws(() => fromSessionDraftRow({ ...valid, updated_at: "" }), TypeError);
  assert.throws(() => fromSessionDraftRow({ ...valid, updated_at: "  " }), TypeError);
});
