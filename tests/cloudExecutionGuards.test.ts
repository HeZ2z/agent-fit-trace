import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BASE = fileURLToPath(
  new URL("../supabase/migrations/20261017000200_coaching_cloud.sql", import.meta.url),
);
const GUARDS = fileURLToPath(
  new URL("../supabase/migrations/20261017000300_cloud_execution_guards.sql", import.meta.url),
);

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** Return the last definition of a function, i.e. the effective replacement. */
function functionBody(sql: string, name: string): string {
  const marker = `create or replace function public.${name}(`;
  const start = sql.lastIndexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = sql.indexOf("$$", start);
  assert.ok(bodyStart > start, `missing body for ${name}`);
  const bodyEnd = sql.indexOf("$$;", bodyStart + 2);
  assert.ok(bodyEnd > bodyStart, `unterminated body for ${name}`);
  return sql.slice(start, bodyEnd + 3);
}

/** Read the column names declared in the base `create table` for a relation. */
function tableColumns(sql: string, table: string): Set<string> {
  const start = sql.indexOf(`create table if not exists public.${table} (`);
  assert.ok(start >= 0, `missing table ${table}`);
  const end = sql.indexOf("\n);", start);
  assert.ok(end > start, `unterminated table ${table}`);
  const columns = new Set<string>();
  for (const line of sql.slice(start, end).split("\n").slice(1)) {
    const match = /^\s{2}([a-z_]+)\s/.exec(line);
    if (match && !["constraint", "primary", "unique", "foreign", "check"].includes(match[1]!)) {
      columns.add(match[1]!);
    }
  }
  assert.ok(columns.size > 0, `no columns parsed for ${table}`);
  return columns;
}

test("cloud guards: the applied base migration is not rewritten; the fix is additive", async () => {
  const [base, guards] = await Promise.all([read(BASE), read(GUARDS)]);
  // The FATAL base defect must still be visible in the already-applied file:
  // editing it in place would make the migration history a lie.
  assert.match(base, /v_quota\.quota_configured/);
  assert.doesNotMatch(base, /coaching_runtime_control/);
  assert.doesNotMatch(guards, /drop table/i);
  assert.match(guards, /^-- Cloud execution guards \(additive corrective migration\)\./);
  assert.match(guards, /add column if not exists tokens_reserved/);
  assert.match(guards, /create table if not exists public\.coaching_runtime_control/);
});

test("cloud guards: effective authorize RPC reads the real `configured` column", async () => {
  const guards = await read(GUARDS);
  const authorize = functionBody(guards, "coaching_authorize_provider_step");
  assert.doesNotMatch(authorize, /quota_configured/);
  assert.match(authorize, /public\.coaching_quota q where q\.owner_id = v_run\.owner_id/);
  assert.match(authorize, /v_quota\.configured is not true/);
  assert.match(authorize, /p_step_tokens bigint/);
  assert.match(authorize, /p_step_requests integer/);
  assert.match(guards, /drop function if exists public\.coaching_authorize_provider_step\(text, integer\)/);
  assert.match(
    guards,
    /grant execute on function public\.coaching_authorize_provider_step\(text, integer, bigint, integer\) to service_role/,
  );
});

test("cloud guards: every referenced coaching_quota column exists in the base schema", async () => {
  const [base, guards] = await Promise.all([read(BASE), read(GUARDS)]);
  const known = new Set([
    ...tableColumns(base, "coaching_quota"),
    // Added by this migration.
    "tokens_reserved",
    "per_run_token_budget",
    "per_step_token_budget",
    "per_run_request_limit",
    "cost_limit_usd",
  ]);
  const referenced = new Set(
    [...guards.matchAll(/\bv_quota\.([a-z_]+)/g)].map((match) => match[1]!),
  );
  assert.ok(referenced.size > 0);
  for (const column of referenced) {
    assert.ok(known.has(column), `coaching_quota has no column ${column}`);
  }
  // The bug this migration fixes was exactly a misspelled column.
  assert.ok(!referenced.has("quota_configured"));
});

test("cloud guards: submit derives canonical identity in SQL and rejects unknown keys", async () => {
  const guards = await read(GUARDS);
  const submit = functionBody(guards, "coaching_submit_run");
  assert.doesNotMatch(submit, /p_request_hash/);
  assert.match(submit, /v_hash := md5\(public\.coaching_canonical_request\(/);
  assert.match(submit, /p_prompt, p_backend_id, p_runtime_id, p_snapshot_id, p_snapshot_source, v_uid/);
  // Unknown top-level and snapshot keys are rejected rather than hashed.
  assert.match(submit, /\(p_request - 'prompt' - 'backendId' - 'runtimeId' - 'snapshot'\) <> '\{\}'::jsonb/);
  assert.match(submit, /- 'snapshotId' - 'source' - 'accountId'\) <> '\{\}'::jsonb/);
  assert.match(submit, /octet_length\(p_request::text\) > 131072/);
  // Replay is checked before session/snapshot liveness.
  const replay = submit.indexOf("r.idempotency_key = p_idempotency_key");
  const session = submit.indexOf("public.coaching_sessions s");
  assert.ok(replay >= 0 && session > replay);
});

test("cloud guards: direct RPC text and payload sizes are byte-bounded", async () => {
  const guards = await read(GUARDS);
  const submit = functionBody(guards, "coaching_submit_run");
  assert.match(submit, /coaching_assert_bounded_text\(p_run_id, 128\)/);
  assert.match(submit, /coaching_assert_bounded_text\(p_session_id, 128\)/);
  assert.match(submit, /coaching_assert_bounded_text\(p_idempotency_key, 200\)/);
  assert.match(submit, /coaching_assert_bounded_text\(p_prompt, 65536\)/);
  assert.match(submit, /coaching_assert_bounded_text\(p_snapshot_id, 128\)/);
  assert.match(submit, /coaching_assert_bounded_text\(p_snapshot_source, 64\)/);
  assert.match(submit, /octet_length\(p_request::text\) > 131072/);

  const bounded = functionBody(guards, "coaching_assert_bounded_text");
  assert.match(bounded, /octet_length\(p_value\) > p_max_bytes/);
  assert.match(bounded, /btrim\(p_value\) = ''/);

  const session = functionBody(guards, "coaching_create_session");
  assert.match(session, /coaching_assert_bounded_text\(v_id, 128\)/);

  const snapshot = functionBody(guards, "coaching_create_snapshot");
  assert.match(snapshot, /coaching_assert_bounded_text\(p_snapshot_id, 128\)/);
  assert.match(snapshot, /coaching_assert_bounded_text\(p_source, 64\)/);

  const append = functionBody(guards, "coaching_append_event");
  assert.match(append, /octet_length\(p_payload::text\) > 65536/);

  const terminate = functionBody(guards, "coaching_terminate_run");
  assert.match(terminate, /octet_length\(p_reason\) > 2048/);
  assert.match(terminate, /octet_length\(p_failure_message\) > 2048/);

  const cancel = functionBody(guards, "coaching_cancel_run");
  assert.match(cancel, /octet_length\(v_reason\) > 512/);
});

test("cloud guards: dates are validated by a real calendar cast, not only a regex", async () => {
  const guards = await read(GUARDS);
  const helper = functionBody(guards, "coaching_assert_iso_date");
  assert.match(helper, /\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$/);
  assert.match(helper, /perform p_value::date;/);
  assert.match(helper, /exception when others then/);

  const snapshot = functionBody(guards, "coaching_create_snapshot");
  assert.match(snapshot, /coaching_assert_iso_date\(p_from\)/);
  assert.match(snapshot, /coaching_assert_iso_date\(p_to\)/);
  assert.match(snapshot, /p_from > p_to/);
});

test("cloud guards: submit atomically reserves a finite token and request budget", async () => {
  const guards = await read(GUARDS);
  const submit = functionBody(guards, "coaching_submit_run");
  assert.match(submit, /pg_advisory_xact_lock\(hashtext\('fit-trace-cloud-quota-v1'\)\)/);
  assert.match(submit, /v_quota\.tokens_limit is null/);
  assert.match(submit, /coalesce\(v_quota\.per_run_token_budget, 0\) <= 0/);
  assert.match(submit, /coalesce\(v_quota\.per_step_token_budget, 0\) <= 0/);
  assert.match(submit, /coalesce\(v_quota\.per_run_request_limit, 0\) <= 0/);
  assert.match(submit, /v_quota\.per_run_token_budget > v_quota\.tokens_limit/);
  assert.match(
    submit,
    /v_quota\.tokens_used \+ coalesce\(v_quota\.tokens_reserved, 0\) \+ v_quota\.per_run_token_budget[\s\S]*?> v_quota\.tokens_limit/,
  );
  assert.match(submit, /token_budget,[\s\S]*?request_budget,/);
  assert.match(submit, /tokens_reserved = q\.tokens_reserved \+ v_quota\.per_run_token_budget/);
});

test("cloud guards: every provider step is gated by the global switch, account, budget, and lease", async () => {
  const guards = await read(GUARDS);
  const authorize = functionBody(guards, "coaching_authorize_provider_step");
  assert.match(authorize, /coalesce\(v_provider_enabled, false\) is not true/);
  assert.match(authorize, /from auth\.users u where u\.id = v_run\.owner_id/);
  assert.match(authorize, /v_anonymous is not false/);
  assert.match(authorize, /v_out\.lease_generation <> p_generation/);
  assert.match(authorize, /v_out\.lease_until <= now\(\)/);
  assert.match(authorize, /v_run\.lease_generation <> p_generation/);
  assert.match(authorize, /p_step_tokens > v_quota\.per_step_token_budget/);
  assert.match(authorize, /v_run\.provider_tokens_committed \+ p_step_tokens > v_run\.token_budget/);
  assert.match(authorize, /v_run\.provider_requests_committed \+ p_step_requests > v_run\.request_budget/);
  assert.match(authorize, /provider_fetch_started_at = coalesce/);

  const control = guards.slice(
    guards.indexOf("create table if not exists public.coaching_runtime_control"),
    guards.indexOf("-- Bounded text and real date helpers"),
  );
  assert.match(control, /provider_enabled boolean not null default false/);
  assert.match(control, /enable row level security/);
  assert.match(control, /revoke all on table public\.coaching_runtime_control from public, anon, authenticated/);
});

test("cloud guards: settlement charges known usage once and retains unknown remainder", async () => {
  const guards = await read(GUARDS);
  const settle = functionBody(guards, "coaching_settle_usage");
  assert.match(settle, /p_usage_complete boolean/);
  assert.match(settle, /if exists \(select 1 from public\.coaching_usage_ledger l where l\.run_id = p_run_id\)/);
  assert.match(settle, /on conflict \(run_id\) do nothing/);
  assert.match(settle, /v_charge := greatest\(coalesce\(p_total_tokens, 0\), 0\)/);
  assert.match(settle, /tokens_used = q\.tokens_used \+ v_charge/);
  assert.match(settle, /when v_complete then greatest\(q\.tokens_reserved - v_run\.token_budget, 0\)/);
  assert.match(settle, /else greatest\(q\.tokens_reserved - least\(v_run\.token_budget, v_charge\), 0\)/);
  assert.match(settle, /usage_complete/);
  assert.match(settle, /budget_released = \(r\.budget_released or v_complete\)/);

  // The old 7-argument function must be dropped before the replacement exists.
  const drop = guards.indexOf(
    "drop function if exists public.coaching_settle_usage(text, integer, integer, integer, integer, numeric, text)",
  );
  assert.ok(drop >= 0 && drop < guards.lastIndexOf("create or replace function public.coaching_settle_usage("));
});

test("cloud guards: terminal release refunds only proven-free work and never double-decrements", async () => {
  const guards = await read(GUARDS);
  const terminate = functionBody(guards, "coaching_terminate_run");
  assert.match(terminate, /v_was_released := v_run\.reservation_released/);
  assert.match(terminate, /v_was_budget_released := v_run\.budget_released/);
  assert.match(
    terminate,
    /v_budget_release := \(v_status = 'cancelled' and v_run\.provider_fetch_started_at is null\)\s*or p_proven_not_accepted is true/,
  );
  assert.match(terminate, /if v_release and not v_was_released then/);
  assert.match(terminate, /if v_budget_release and not v_was_budget_released then/);
  assert.match(terminate, /not exists \(\s*select 1 from public\.coaching_usage_ledger l where l\.run_id = v_run\.id/);

  const release = functionBody(guards, "coaching_release_reservation");
  assert.match(release, /v_run\.provider_accepted_at is not null/);
  assert.match(release, /CLOUD_REFUND_UNPROVEN/);
  assert.match(release, /v_release_concurrency := not v_run\.reservation_released/);
  assert.match(release, /v_release_budget := not v_run\.budget_released/);
});

test("cloud guards: cloud state reports truthful readiness, never an unlimited default", async () => {
  const guards = await read(GUARDS);
  const state = functionBody(guards, "coaching_cloud_state");
  assert.match(state, /'providerEnabled', coalesce\(v_provider_enabled, false\)/);
  assert.match(state, /'quotaConfigured', coalesce\(v_quota\.configured, false\)/);
  assert.match(state, /'budgetConfigured', coalesce\(v_quota\.configured, false\)/);
  assert.match(state, /coalesce\(v_quota\.per_run_token_budget, 0\) > 0/);
  assert.match(state, /coalesce\(v_quota\.per_step_token_budget, 0\) > 0/);
  assert.match(state, /coalesce\(v_quota\.per_run_request_limit, 0\) > 0/);
  assert.match(state, /when v_quota\.tokens_limit is null then 0/);
});
