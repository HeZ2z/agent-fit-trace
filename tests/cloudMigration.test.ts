import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MIGRATION = fileURLToPath(
  new URL("../supabase/migrations/20261017000200_coaching_cloud.sql", import.meta.url),
);

async function migration(): Promise<string> {
  return readFile(MIGRATION, "utf8");
}

test("cloud migration: snapshot RPC derives records from caller-owned workouts", async () => {
  const sql = await migration();
  const start = sql.indexOf("create or replace function public.coaching_create_snapshot(");
  assert.ok(start >= 0);
  const end = sql.indexOf("create or replace function public.coaching_submit_run(", start);
  assert.ok(end > start);
  const fn = sql.slice(start, end);

  assert.doesNotMatch(fn, /p_records\s+jsonb/);
  assert.doesNotMatch(fn, /p_record_ids\s+jsonb/);
  assert.match(fn, /from public\.workouts w/);
  assert.match(fn, /w\.owner_id = v_uid/);
  assert.match(fn, /p_source is distinct from 'authenticated-store'/);
  assert.match(fn, /pg_advisory_xact_lock/);
  assert.match(fn, /least\(greatest\(coalesce\(p_ttl_ms/);
});

test("cloud migration: session and snapshot counts are per-account serialized and TTL-clamped", async () => {
  const sql = await migration();
  const sessionStart = sql.indexOf("create or replace function public.coaching_create_session(");
  const sessionEnd = sql.indexOf("create or replace function public.coaching_read_session(", sessionStart);
  const session = sql.slice(sessionStart, sessionEnd);
  assert.match(session, /pg_advisory_xact_lock/);
  assert.match(session, /least\(greatest\(coalesce\(p_ttl_ms/);
  assert.match(session, /v_count >= 50/);

  const snapshot = sql.slice(
    sql.indexOf("create or replace function public.coaching_create_snapshot("),
    sql.indexOf("create or replace function public.coaching_submit_run("),
  );
  assert.match(snapshot, /v_live >= 50/);
});

test("cloud migration: worker settlement is generation- and lease-fenced", async () => {
  const sql = await migration();
  const settleStart = sql.indexOf("create or replace function public.coaching_settle_usage(");
  const settleEnd = sql.indexOf("create or replace function public.coaching_release_reservation(", settleStart);
  const settle = sql.slice(settleStart, settleEnd);
  assert.match(settle, /p_generation integer/);
  assert.match(settle, /v_out\.lease_generation <> p_generation/);
  assert.match(settle, /v_out\.lease_until <= now\(\)/);
  assert.match(settle, /on conflict \(run_id\) do nothing/);
});

test("cloud migration: cancellation after a fetch is unconfirmed, not cancelled", async () => {
  const sql = await migration();
  const terminateStart = sql.indexOf("create or replace function public.coaching_terminate_run(");
  const terminateEnd = sql.indexOf("create or replace function public.coaching_settle_usage(", terminateStart);
  const terminate = sql.slice(terminateStart, terminateEnd);
  assert.match(terminate, /provider_fetch_started_at is not null/);
  assert.match(terminate, /v_status := 'unconfirmed'/);
  assert.match(terminate, /p_proven_not_accepted/);
  assert.doesNotMatch(terminate, /provider_call_started_at is not null/);
  // The shared event contract only allows completed/failed/cancelled. The run
  // row may be unconfirmed; the terminal event must be failed, never a clean
  // cancelled or an unparseable status.
  assert.match(terminate, /case when v_status = 'unconfirmed' then 'failed' else v_status end/);
});

test("cloud migration: expired accepted leases append one readable terminal event", async () => {
  const sql = await migration();
  const start = sql.indexOf("create or replace function public.coaching_claim_outbox(");
  const end = sql.indexOf("create or replace function public.coaching_mark_provider_call(", start);
  assert.ok(start >= 0 && end > start);
  const claim = sql.slice(start, end);
  assert.match(claim, /provider_fetch_started_at is not null/);
  assert.match(claim, /insert into public.coaching_run_events/);
  assert.match(claim, /'status', 'failed'/);
  assert.match(claim, /execution unconfirmed/);
  assert.match(claim, /for update of r, o skip locked/);
});

test("cloud migration: every provider fetch is authorized under the lease and formal account", async () => {
  const sql = await migration();
  const start = sql.indexOf("create or replace function public.coaching_authorize_provider_step(");
  const end = sql.indexOf("create or replace function public.coaching_append_event(", start);
  assert.ok(start >= 0 && end > start);
  const authorize = sql.slice(start, end);
  assert.match(authorize, /v_out\.lease_generation <> p_generation/);
  assert.match(authorize, /v_out\.lease_until <= now\(\)/);
  assert.match(authorize, /from auth\.users u where u\.id = v_run\.owner_id/);
  assert.match(authorize, /v_anonymous is not false/);
  assert.match(authorize, /provider_fetch_started_at = coalesce/);
  assert.match(authorize, /tokens_limit/);
});
