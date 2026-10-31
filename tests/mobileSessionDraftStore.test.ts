import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

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

test("the migration list is contiguous and ends at schema version 8", () => {
  assert.equal(WORKOUTS_DB_SCHEMA_VERSION, 8);
  assert.equal(WORKOUTS_DB_SCHEMA_VERSION, latestWorkoutSchemaVersion());
  assert.deepEqual(
    WORKOUTS_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "later migrations are appended without changing earlier versions",
  );
  for (const migration of WORKOUTS_MIGRATIONS) {
    assert.ok(migration.statements.length > 0, `migration v${migration.version} has statements`);
  }
});

test("a v1 database applies only the session-draft and later sync migrations", () => {
  const pending = pendingWorkoutMigrations(1);
  assert.deepEqual(
    pending.map((migration) => migration.version),
    [2, 3, 4, 5, 6, 7, 8],
    "the workouts table migration never re-runs",
  );
  assert.deepEqual(pending[0].statements, [SESSION_DRAFT_TABLE_SQL]);
  assert.ok(!pending[0].statements.includes(WORKOUTS_TABLE_SQL));
  assert.doesNotMatch(pending[0].statements.join("\n"), /\bworkouts\b/i);

  assert.deepEqual(pendingWorkoutMigrations(WORKOUTS_DB_SCHEMA_VERSION), []);
  assert.deepEqual(
    pendingWorkoutMigrations(0).map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "a fresh database applies every migration in order",
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

test("migration v3 adds provenance and account-endpoint scoped durable consent and outbox", () => {
  const migration = WORKOUTS_MIGRATIONS[2];
  assert.equal(migration.version, 3);
  assert.match(migration.statements.join("\n"), /ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'/);
  assert.match(migration.statements.join("\n"), /CREATE TABLE IF NOT EXISTS sync_outbox/);
  assert.match(migration.statements.join("\n"), /CREATE TABLE IF NOT EXISTS sync_consent/);
  assert.match(migration.statements.join("\n"), /PRIMARY KEY \(account_id, endpoint\)/);
  assert.match(migration.statements.join("\n"), /CHECK \(state IN \('unassigned', 'pending', 'retry', 'complete', 'device-only'\)\)/);
});

test("migration v4 stores account-endpoint scoped conflict acknowledgements", () => {
  const migration = WORKOUTS_MIGRATIONS[3];
  assert.equal(migration.version, 4);
  assert.match(migration.statements.join("\n"), /CREATE TABLE IF NOT EXISTS sync_conflict_ack/);
  assert.match(migration.statements.join("\n"), /PRIMARY KEY \(account_id, endpoint, workout_id\)/);
  assert.match(migration.statements.join("\n"), /local_fingerprint TEXT NOT NULL/);
  assert.match(migration.statements.join("\n"), /remote_fingerprint TEXT NOT NULL/);
});

test("migration v5 scopes pulled remote membership to account, endpoint and payload fingerprint", () => {
  const migration = WORKOUTS_MIGRATIONS[4];
  assert.equal(migration.version, 5);
  assert.match(migration.statements.join("\n"), /CREATE TABLE IF NOT EXISTS sync_remote_membership/);
  assert.match(migration.statements.join("\n"), /PRIMARY KEY \(account_id, endpoint, workout_id\)/);
  assert.match(migration.statements.join("\n"), /fingerprint TEXT NOT NULL/);
});

test("migration v6 stores complete-sync status per account and endpoint", () => {
  const migration = WORKOUTS_MIGRATIONS[5];
  assert.equal(migration.version, 6);
  assert.match(migration.statements.join("\n"), /CREATE TABLE IF NOT EXISTS sync_status/);
  assert.match(migration.statements.join("\n"), /PRIMARY KEY \(account_id, endpoint\)/);
  assert.match(migration.statements.join("\n"), /last_success_at TEXT/);
});

test("migration v7 defines an account-endpoint lease with fencing generation and expiry", () => {
  const migration = WORKOUTS_MIGRATIONS[6];
  assert.equal(migration.version, 7);
  assert.match(migration.statements.join("\n"), /CREATE TABLE IF NOT EXISTS sync_lease/);
  assert.match(migration.statements.join("\n"), /PRIMARY KEY \(account_id, endpoint\)/);
  assert.match(migration.statements.join("\n"), /generation INTEGER NOT NULL/);
  assert.match(migration.statements.join("\n"), /expires_at TEXT NOT NULL/);
});

test("migration v8 creates explicit unassigned enrollment rows for preexisting workouts", () => {
  const migration = WORKOUTS_MIGRATIONS[7];
  assert.equal(migration.version, 8);
  assert.match(migration.statements.join("\n"), /INSERT INTO sync_outbox/);
  assert.match(migration.statements.join("\n"), /'unassigned'/);
  assert.match(migration.statements.join("\n"), /NOT EXISTS/);
});

test("all migrations execute and expired lease takeover fences the previous owner", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of WORKOUTS_MIGRATIONS) {
      for (const statement of migration.statements) database.exec(statement);
      database.exec(`PRAGMA user_version = ${migration.version};`);
    }
    const columns = database.prepare("PRAGMA table_info(workouts)").all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === "origin"));

    const acquire = database.prepare(`INSERT INTO sync_lease (account_id, endpoint, owner, generation, expires_at)
      VALUES (?, ?, ?, 1, ?) ON CONFLICT(account_id, endpoint) DO UPDATE SET owner = excluded.owner,
      generation = sync_lease.generation + 1, expires_at = excluded.expires_at
      WHERE sync_lease.expires_at <= ?`);
    const first = acquire.run("acct", "https://api", "worker-a", "2026-10-31T00:01:00.000Z", "2026-10-31T00:00:00.000Z");
    assert.equal(first.changes, 1);
    const blocked = acquire.run("acct", "https://api", "worker-b", "2026-10-31T00:02:00.000Z", "2026-10-31T00:00:30.000Z");
    assert.equal(blocked.changes, 0);
    const takeover = acquire.run("acct", "https://api", "worker-b", "2026-10-31T00:02:00.000Z", "2026-10-31T00:01:00.000Z");
    assert.equal(takeover.changes, 1);
    const row = database.prepare("SELECT owner, generation FROM sync_lease WHERE account_id = ? AND endpoint = ?").get("acct", "https://api") as { owner: string; generation: number };
    assert.deepEqual({ ...row }, { owner: "worker-b", generation: 2 });
    const staleRelease = database.prepare("DELETE FROM sync_lease WHERE account_id = ? AND endpoint = ? AND owner = ? AND generation = ?");
    assert.equal(staleRelease.run("acct", "https://api", "worker-a", 1).changes, 0);
  } finally {
    database.close();
  }
});

test("legacy workouts receive unassigned outbox rows and are enrolled only by include-existing opt-in", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const statement of WORKOUTS_MIGRATIONS[0].statements) database.exec(statement);
    database.prepare(`INSERT INTO workouts (id, schema_version, date, session_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("legacy-a", 1, "2026-01-01", "strength", "{}", "2026-01-02T00:00:00.000Z");

    for (const migration of WORKOUTS_MIGRATIONS.slice(1)) {
      for (const statement of migration.statements) database.exec(statement);
    }
    const pendingBeforeConsent = database.prepare("SELECT state FROM sync_outbox WHERE workout_id = ?")
      .get("legacy-a") as { state: string };
    assert.deepEqual({ ...pendingBeforeConsent }, { state: "unassigned" });

    const scope = { account: "acct-a", endpoint: "https://api.example.test/api/v1" };
    database.prepare(`INSERT INTO sync_consent (account_id, endpoint, enabled, include_existing, enrollment_cutoff, updated_at)
      VALUES (?, ?, 1, 1, ?, ?)`)
      .run(scope.account, scope.endpoint, "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    database.prepare(`UPDATE sync_outbox SET account_id = ?, endpoint = ?, state = 'pending', updated_at = ?
      WHERE state = 'unassigned' AND workout_id IN (SELECT id FROM workouts WHERE origin IN ('local', 'legacy'))`)
      .run(scope.account, scope.endpoint, "2026-01-03T00:00:00.000Z");
    const enrolled = database.prepare("SELECT account_id, endpoint, state FROM sync_outbox WHERE workout_id = ?")
      .get("legacy-a") as { account_id: string; endpoint: string; state: string };
    assert.deepEqual({ ...enrolled }, { account_id: scope.account, endpoint: scope.endpoint, state: "pending" });
  } finally {
    database.close();
  }
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
