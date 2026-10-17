-- Cloud execution guards (additive corrective migration).
--
-- 20261017000200_coaching_cloud.sql has already been applied in at least one
-- isolated environment. Never rewrite or re-run that base file. This migration
-- only adds columns/tables and replaces functions/grants.
--
-- Guards added here:
-- - finite, atomically reserved per-run token budget + per-run request budget;
-- - a per-step token ceiling enforced by the database before every fetch;
-- - a database-owned global provider kill switch (default OFF);
-- - bounds on direct-RPC text/request sizes and real calendar-date validation;
-- - canonical request identity derived from normalized RPC arguments, not from
--   caller-supplied extra JSON keys;
-- - settlement of known actual usage exactly once, retaining the unknown part
--   of the reservation instead of refunding it;
-- - a corrected `coaching_authorize_provider_step` that reads
--   `coaching_quota.configured` (the base function referenced the nonexistent
--   `quota_configured` column).
--
-- There is deliberately no nullable "unlimited" budget. A quota row without a
-- finite token limit, per-run budget, per-step budget, or request limit is
-- unconfigured and fails closed. Token budgets are not a USD guarantee;
-- operator-configured provider/model pricing remains required for that claim.

alter table public.coaching_quota
  add column if not exists tokens_reserved bigint not null default 0
    check (tokens_reserved >= 0),
  add column if not exists per_run_token_budget bigint not null default 0
    check (per_run_token_budget >= 0),
  add column if not exists per_step_token_budget bigint not null default 0
    check (per_step_token_budget >= 0),
  add column if not exists per_run_request_limit integer not null default 0
    check (per_run_request_limit >= 0 and per_run_request_limit <= 64),
  add column if not exists cost_limit_usd numeric(12, 6)
    check (cost_limit_usd is null or cost_limit_usd >= 0);

comment on column public.coaching_quota.cost_limit_usd is
  'Operator reporting bound only. It is NOT enforced as a hard USD cap because providers may omit cost data; token/request budgets are the enforced guards.';

alter table public.coaching_runs
  add column if not exists token_budget bigint not null default 0
    check (token_budget >= 0),
  add column if not exists request_budget integer not null default 0
    check (request_budget >= 0),
  add column if not exists provider_tokens_committed bigint not null default 0
    check (provider_tokens_committed >= 0),
  add column if not exists provider_requests_committed integer not null default 0
    check (provider_requests_committed >= 0),
  add column if not exists budget_released boolean not null default false;

alter table public.coaching_usage_ledger
  add column if not exists usage_complete boolean not null default true;

-- Global provider kill switch. Operators set this explicitly through SQL; it
-- is never writable through a request-path RPC. Missing/false means no paid
-- provider step is authorized.
create table if not exists public.coaching_runtime_control (
  id text primary key check (id = 'global'),
  provider_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.coaching_runtime_control (id, provider_enabled)
values ('global', false)
on conflict (id) do nothing;

alter table public.coaching_runtime_control enable row level security;
revoke all on table public.coaching_runtime_control from public, anon, authenticated;
-- Service role bypasses RLS; no direct table grant is needed for the worker
-- because every read happens inside SECURITY DEFINER RPCs.

-- Bounded text and real date helpers ---------------------------------------

create or replace function public.coaching_assert_bounded_text(
  p_value text,
  p_max_bytes integer
)
returns void
language plpgsql
immutable
as $$
begin
  if p_value is null or btrim(p_value) = '' or octet_length(p_value) > p_max_bytes then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.coaching_assert_bounded_text(text, integer) from public, anon, authenticated;

-- Regex alone accepts 2026-02-30. A real cast rejects impossible dates.
create or replace function public.coaching_assert_iso_date(p_value text)
returns void
language plpgsql
immutable
as $$
begin
  if p_value is null then
    return;
  end if;
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  begin
    perform p_value::date;
  exception when others then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end;
end;
$$;

revoke all on function public.coaching_assert_iso_date(text) from public, anon, authenticated;

-- Canonical identity is derived from normalized arguments. Caller-supplied
-- extra keys never change the hash.
create or replace function public.coaching_canonical_request(
  p_prompt text,
  p_backend_id text,
  p_runtime_id text,
  p_snapshot_id text,
  p_snapshot_source text,
  p_account_id uuid
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'prompt', p_prompt,
    'backendId', p_backend_id,
    'runtimeId', p_runtime_id,
    'snapshot', jsonb_build_object(
      'snapshotId', p_snapshot_id,
      'source', p_snapshot_source,
      'accountId', p_account_id
    )
  );
$$;

revoke all on function public.coaching_canonical_request(text, text, text, text, text, uuid)
  from public, anon, authenticated;

-- Truthful state including finite-budget readiness. `tokensRemaining` is 0,
-- never "unlimited", when the token limit is missing.
create or replace function public.coaching_cloud_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_anonymous boolean;
  v_quota public.coaching_quota%rowtype;
  v_provider_enabled boolean;
begin
  if v_uid is null then
    raise exception 'CLOUD_ACCOUNT_NOT_FORMAL' using errcode = '42501';
  end if;
  select u.is_anonymous into v_anonymous from auth.users u where u.id = v_uid;
  select * into v_quota from public.coaching_quota q where q.owner_id = v_uid;
  select c.provider_enabled into v_provider_enabled
  from public.coaching_runtime_control c where c.id = 'global';
  return jsonb_build_object(
    'accountId', v_uid,
    'isAnonymous', coalesce(v_anonymous, true),
    'providerEnabled', coalesce(v_provider_enabled, false),
    'quotaConfigured', coalesce(v_quota.configured, false),
    'budgetConfigured', coalesce(v_quota.configured, false)
      and v_quota.tokens_limit is not null
      and coalesce(v_quota.per_run_token_budget, 0) > 0
      and coalesce(v_quota.per_step_token_budget, 0) > 0
      and coalesce(v_quota.per_run_request_limit, 0) > 0,
    'concurrentLimit', coalesce(v_quota.concurrent_limit, 0),
    'reservedCount', coalesce(v_quota.reserved_count, 0),
    'tokensLimit', v_quota.tokens_limit,
    'tokensUsed', coalesce(v_quota.tokens_used, 0),
    'tokensReserved', coalesce(v_quota.tokens_reserved, 0),
    'perRunTokenBudget', coalesce(v_quota.per_run_token_budget, 0),
    'perStepTokenBudget', coalesce(v_quota.per_step_token_budget, 0),
    'perRunRequestLimit', coalesce(v_quota.per_run_request_limit, 0),
    'tokensRemaining', case
      when v_quota.tokens_limit is null then 0
      else greatest(
        v_quota.tokens_limit - v_quota.tokens_used - coalesce(v_quota.tokens_reserved, 0),
        0
      )
    end
  );
end;
$$;

revoke all on function public.coaching_cloud_state() from public, anon;
grant execute on function public.coaching_cloud_state() to authenticated;

-- Session creation: byte-bounded id, same trusted TTL clamp, same per-account
-- serialization.
create or replace function public.coaching_create_session(p_id text, p_ttl_ms integer)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_id text := coalesce(nullif(btrim(p_id), ''), 'sess-' || gen_random_uuid()::text);
  v_row public.coaching_sessions%rowtype;
  v_count integer;
begin
  perform public.coaching_assert_bounded_text(v_id, 128);
  perform pg_advisory_xact_lock(hashtext('fit-trace-cloud-sessions-v1:' || v_uid::text));
  -- Expired sessions do not need retention. Reclaim them under the same
  -- per-account lock, then count only sessions whose TTL has not elapsed.
  -- Nothing references a session row by FK; a run keeps its session id as
  -- text, so dropping an expired row never orphans an accepted run.
  delete from public.coaching_sessions s
  where s.owner_id = v_uid and s.expires_at <= now();
  select count(*) into v_count
  from public.coaching_sessions s
  where s.owner_id = v_uid and s.expires_at > now();
  if not exists (select 1 from public.coaching_sessions s where s.owner_id = v_uid and s.id = v_id)
     and v_count >= 50 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  insert into public.coaching_sessions (owner_id, id, expires_at)
  values (
    v_uid, v_id,
    now() + (
      least(greatest(coalesce(p_ttl_ms, 1800000), 60000), 86400000) / 1000.0
    ) * interval '1 second'
  )
  on conflict (owner_id, id) do update set expires_at = excluded.expires_at
  returning * into v_row;
  return jsonb_build_object(
    'id', v_row.id,
    'expiresAt', floor(extract(epoch from v_row.expires_at) * 1000)::bigint
  );
end;
$$;

-- Snapshot creation: byte-bounded handles, real calendar dates, records still
-- derived from the caller's own workouts under auth.uid().
create or replace function public.coaching_create_snapshot(
  p_snapshot_id text,
  p_source text,
  p_from text,
  p_to text,
  p_ttl_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_row public.coaching_snapshots%rowtype;
  v_live integer;
  v_records jsonb;
  v_record_ids jsonb;
  v_count integer;
begin
  perform public.coaching_assert_bounded_text(p_snapshot_id, 128);
  perform public.coaching_assert_bounded_text(p_source, 64);
  if p_source is distinct from 'authenticated-store' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  perform public.coaching_assert_iso_date(p_from);
  perform public.coaching_assert_iso_date(p_to);
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;

  select
    coalesce(jsonb_agg(w.payload order by w.date, w.id), '[]'::jsonb),
    coalesce(jsonb_agg(w.id order by w.date, w.id), '[]'::jsonb),
    count(*)::integer
  into v_records, v_record_ids, v_count
  from public.workouts w
  where w.owner_id = v_uid
    and (p_from is null or w.date >= p_from)
    and (p_to is null or w.date <= p_to);
  if v_count > 5000 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('fit-trace-cloud-snapshots-v1:' || v_uid::text));
  delete from public.coaching_snapshots s
  where s.owner_id = v_uid and s.expires_at <= now();
  select count(*) into v_live from public.coaching_snapshots s where s.owner_id = v_uid;
  if v_live >= 50 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  insert into public.coaching_snapshots (
    owner_id, id, source, record_ids, records, record_count, from_date, to_date, expires_at
  ) values (
    v_uid, p_snapshot_id, p_source, v_record_ids, v_records, v_count, p_from, p_to,
    now() + (
      least(greatest(coalesce(p_ttl_ms, 1800000), 60000), 86400000) / 1000.0
    ) * interval '1 second'
  )
  returning * into v_row;
  return jsonb_build_object(
    'snapshotId', v_row.id,
    'source', v_row.source,
    'accountId', v_row.owner_id,
    'recordIds', v_row.record_ids,
    'recordCount', v_row.record_count,
    'from', v_row.from_date,
    'to', v_row.to_date,
    'expiresAt', floor(extract(epoch from v_row.expires_at) * 1000)::bigint
  );
end;
$$;

-- Atomic submit with finite budget reservation.
--
-- Replay is checked before session/snapshot/provider readiness so an identical
-- request keeps replaying after either handle expires. The request hash is
-- derived inside SQL from normalized arguments; unknown JSON keys are rejected
-- rather than folded into identity.
create or replace function public.coaching_submit_run(
  p_run_id text,
  p_session_id text,
  p_idempotency_key text,
  p_prompt text,
  p_backend_id text,
  p_runtime_id text,
  p_snapshot_id text,
  p_snapshot_source text,
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_hash text;
  v_run public.coaching_runs%rowtype;
  v_snapshot public.coaching_snapshots%rowtype;
  v_quota public.coaching_quota%rowtype;
  v_total integer;
  v_seq integer;
  v_provider_enabled boolean;
begin
  if p_backend_id <> 'cloud-default' or p_runtime_id <> 'hosted-sdk' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  perform public.coaching_assert_bounded_text(p_run_id, 128);
  perform public.coaching_assert_bounded_text(p_session_id, 128);
  perform public.coaching_assert_bounded_text(p_idempotency_key, 200);
  perform public.coaching_assert_bounded_text(p_prompt, 65536);
  perform public.coaching_assert_bounded_text(p_snapshot_id, 128);
  perform public.coaching_assert_bounded_text(p_snapshot_source, 64);

  if p_request is null
     or jsonb_typeof(p_request) <> 'object'
     or octet_length(p_request::text) > 131072 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  -- Reject unknown top-level and snapshot keys. The request body is a shape
  -- check, not a source of identity.
  if (p_request - 'prompt' - 'backendId' - 'runtimeId' - 'snapshot') <> '{}'::jsonb
     or jsonb_typeof(p_request -> 'snapshot') is distinct from 'object'
     or ((p_request -> 'snapshot') - 'snapshotId' - 'source' - 'accountId') <> '{}'::jsonb then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if (p_request ->> 'prompt') is distinct from p_prompt
     or (p_request ->> 'backendId') is distinct from p_backend_id
     or (p_request ->> 'runtimeId') is distinct from p_runtime_id
     or (p_request -> 'snapshot' ->> 'snapshotId') is distinct from p_snapshot_id
     or (p_request -> 'snapshot' ->> 'source') is distinct from p_snapshot_source
     or (p_request -> 'snapshot' ->> 'accountId') is distinct from v_uid::text then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;

  v_hash := md5(public.coaching_canonical_request(
    p_prompt, p_backend_id, p_runtime_id, p_snapshot_id, p_snapshot_source, v_uid
  )::text);

  -- Replay a retained identical request before requiring live handles.
  select * into v_run from public.coaching_runs r
  where r.owner_id = v_uid and r.session_id = p_session_id and r.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_run.request_hash = v_hash then
      select coalesce(max(e.seq), -1) into v_seq from public.coaching_run_events e where e.run_id = v_run.id;
      return jsonb_build_object(
        'run', public.coaching_run_json(v_run),
        'lastSeq', v_seq,
        'replayed', true
      );
    end if;
    raise exception 'CLOUD_CONFLICT' using errcode = '23505';
  end if;

  select c.provider_enabled into v_provider_enabled
  from public.coaching_runtime_control c where c.id = 'global';
  if coalesce(v_provider_enabled, false) is not true then
    raise exception 'CLOUD_DISABLED' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.coaching_sessions s
    where s.owner_id = v_uid and s.id = p_session_id and s.expires_at > now()
  ) then
    raise exception 'CLOUD_SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_snapshot from public.coaching_snapshots s
  where s.owner_id = v_uid and s.id = p_snapshot_id;
  if not found or v_snapshot.expires_at <= now() then
    raise exception 'CLOUD_SNAPSHOT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_snapshot_source is distinct from v_snapshot.source then
    raise exception 'CLOUD_SNAPSHOT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('fit-trace-cloud-quota-v1'));
  -- A concurrent identical submit may have inserted its run while this
  -- transaction waited for the quota lock. Replay it now, before evaluating
  -- quota: otherwise the loser of the race reports CLOUD_QUOTA_EXHAUSTED
  -- (having missed the last slot/allocation) instead of the accepted run.
  select * into v_run from public.coaching_runs r
  where r.owner_id = v_uid and r.session_id = p_session_id and r.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_run.request_hash = v_hash then
      select coalesce(max(e.seq), -1) into v_seq from public.coaching_run_events e where e.run_id = v_run.id;
      return jsonb_build_object(
        'run', public.coaching_run_json(v_run),
        'lastSeq', v_seq,
        'replayed', true
      );
    end if;
    raise exception 'CLOUD_CONFLICT' using errcode = '23505';
  end if;
  select * into v_quota from public.coaching_quota q where q.owner_id = v_uid for update;
  if not found or v_quota.configured is not true then
    raise exception 'CLOUD_QUOTA_NOT_CONFIGURED' using errcode = '42501';
  end if;
  -- Finite budget is mandatory. A null token limit or zero allocation is
  -- unconfigured, never "unlimited".
  if v_quota.tokens_limit is null
     or coalesce(v_quota.per_run_token_budget, 0) <= 0
     or coalesce(v_quota.per_step_token_budget, 0) <= 0
     or coalesce(v_quota.per_run_request_limit, 0) <= 0
     or v_quota.per_run_token_budget > v_quota.tokens_limit then
    raise exception 'CLOUD_QUOTA_NOT_CONFIGURED' using errcode = '42501';
  end if;
  select coalesce(sum(q.reserved_count), 0) into v_total from public.coaching_quota q;
  if v_quota.reserved_count >= least(v_quota.concurrent_limit, 20) or v_total >= 20 then
    raise exception 'CLOUD_QUOTA_EXHAUSTED' using errcode = '53400';
  end if;
  if v_quota.tokens_used + coalesce(v_quota.tokens_reserved, 0) + v_quota.per_run_token_budget
     > v_quota.tokens_limit then
    raise exception 'CLOUD_QUOTA_EXHAUSTED' using errcode = '53400';
  end if;

  begin
    insert into public.coaching_runs (
      id, owner_id, session_id, idempotency_key, request_hash, prompt, status,
      backend_id, runtime_id, snapshot, snapshot_records, token_budget,
      request_budget, expires_at
    ) values (
      p_run_id, v_uid, p_session_id, p_idempotency_key, v_hash, p_prompt, 'queued',
      p_backend_id, p_runtime_id,
      jsonb_build_object(
        'snapshotId', v_snapshot.id,
        'source', v_snapshot.source,
        'accountId', v_uid,
        'recordIds', v_snapshot.record_ids,
        'recordCount', v_snapshot.record_count,
        'from', v_snapshot.from_date,
        'to', v_snapshot.to_date
      ),
      v_snapshot.records,
      v_quota.per_run_token_budget,
      v_quota.per_run_request_limit,
      now() + interval '30 minutes'
    )
    returning * into v_run;
  exception when unique_violation then
    select * into v_run from public.coaching_runs r
    where r.owner_id = v_uid and r.session_id = p_session_id and r.idempotency_key = p_idempotency_key;
    if found and v_run.request_hash = v_hash then
      select coalesce(max(e.seq), -1) into v_seq from public.coaching_run_events e where e.run_id = v_run.id;
      return jsonb_build_object(
        'run', public.coaching_run_json(v_run),
        'lastSeq', v_seq,
        'replayed', true
      );
    end if;
    raise exception 'CLOUD_CONFLICT' using errcode = '23505';
  end;

  update public.coaching_quota q
  set reserved_count = q.reserved_count + 1,
      tokens_reserved = q.tokens_reserved + v_quota.per_run_token_budget,
      updated_at = now()
  where q.owner_id = v_uid;

  insert into public.coaching_outbox (run_id, owner_id, available_at)
  values (v_run.id, v_uid, now());

  return jsonb_build_object(
    'run', public.coaching_run_json(v_run),
    'lastSeq', -1,
    'replayed', false
  );
end;
$$;

-- Replay lookup for a same-key submit. The HTTP layer calls this BEFORE
-- applying new-execution gates (provider kill switch, provider configuration,
-- budget), so a response lost after the server accepted a run can still be
-- recovered after the operator disables the provider. Returns NULL when no run
-- exists yet; a same-key different request is CLOUD_CONFLICT, exactly as
-- `coaching_submit_run` would report it.
create or replace function public.coaching_find_run(
  p_session_id text,
  p_idempotency_key text,
  p_prompt text,
  p_snapshot_id text,
  p_snapshot_source text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_hash text;
  v_run public.coaching_runs%rowtype;
  v_seq integer;
begin
  perform public.coaching_assert_bounded_text(p_session_id, 128);
  perform public.coaching_assert_bounded_text(p_idempotency_key, 200);
  perform public.coaching_assert_bounded_text(p_prompt, 65536);
  perform public.coaching_assert_bounded_text(p_snapshot_id, 128);
  perform public.coaching_assert_bounded_text(p_snapshot_source, 64);

  v_hash := md5(public.coaching_canonical_request(
    p_prompt, 'cloud-default', 'hosted-sdk', p_snapshot_id, p_snapshot_source, v_uid
  )::text);

  select * into v_run from public.coaching_runs r
  where r.owner_id = v_uid and r.session_id = p_session_id and r.idempotency_key = p_idempotency_key;
  if not found then
    return null;
  end if;
  if v_run.request_hash is distinct from v_hash then
    raise exception 'CLOUD_CONFLICT' using errcode = '23505';
  end if;
  select coalesce(max(e.seq), -1) into v_seq from public.coaching_run_events e where e.run_id = v_run.id;
  return jsonb_build_object(
    'run', public.coaching_run_json(v_run),
    'lastSeq', v_seq,
    'replayed', true
  );
end;
$$;

-- Cancellation before any fetch releases BOTH the concurrency slot and the
-- token allocation exactly once. After a fetch it records intent only.
create or replace function public.coaching_cancel_run(p_run_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_run public.coaching_runs%rowtype;
  v_seq integer;
  v_reason text := coalesce(p_reason, 'cancel requested');
  v_release_concurrency boolean;
  v_release_budget boolean;
begin
  perform public.coaching_assert_bounded_text(p_run_id, 128);
  if octet_length(v_reason) > 512 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  select * into v_run from public.coaching_runs r
  where r.owner_id = v_uid and r.id = p_run_id
  for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  select coalesce(max(e.seq), -1) into v_seq from public.coaching_run_events e where e.run_id = v_run.id;

  if v_run.status in ('completed','failed','cancelled','unconfirmed') then
    return jsonb_build_object('run', public.coaching_run_json(v_run), 'lastSeq', v_seq);
  end if;

  if v_run.provider_fetch_started_at is null then
    v_release_concurrency := not v_run.reservation_released;
    v_release_budget := not v_run.budget_released;
    v_seq := v_seq + 1;
    insert into public.coaching_run_events (run_id, seq, payload)
    values (
      v_run.id,
      v_seq,
      jsonb_build_object(
        'protocolVersion', 1,
        'sessionId', v_run.session_id,
        'runId', v_run.id,
        'seq', v_seq,
        'event', jsonb_build_object('type', 'terminal', 'status', 'cancelled', 'reason', v_reason)
      )
    );
    update public.coaching_runs r
    set status = 'cancelled',
        cancel_requested_at = now(),
        cancel_reason = v_reason,
        termination_confirmed = true,
        reservation_released = true,
        budget_released = true,
        updated_at = now()
    where r.id = v_run.id
    returning * into v_run;
    if v_release_concurrency then
      update public.coaching_quota q
      set reserved_count = greatest(q.reserved_count - 1, 0), updated_at = now()
      where q.owner_id = v_uid;
    end if;
    if v_release_budget then
      update public.coaching_quota q
      set tokens_reserved = greatest(q.tokens_reserved - v_run.token_budget, 0), updated_at = now()
      where q.owner_id = v_uid;
    end if;
    update public.coaching_outbox o
    set status = 'done', updated_at = now()
    where o.run_id = v_run.id;
    return jsonb_build_object('run', public.coaching_run_json(v_run), 'lastSeq', v_seq);
  end if;

  update public.coaching_runs r
  set cancel_requested_at = coalesce(r.cancel_requested_at, now()),
      cancel_reason = coalesce(r.cancel_reason, v_reason),
      status = 'cancelling',
      updated_at = now()
  where r.id = v_run.id
  returning * into v_run;
  return jsonb_build_object('run', public.coaching_run_json(v_run), 'lastSeq', v_seq);
end;
$$;

-- Worker RPCs ---------------------------------------------------------------

-- Called before EVERY provider HTTP request. It validates the global switch,
-- current lease/fence, cancellation, formal account, finite per-run budget,
-- per-step ceiling, and request budget; only then does it record the fetch
-- marker and add the step to the run's committed budget.
drop function if exists public.coaching_authorize_provider_step(text, integer);

create or replace function public.coaching_authorize_provider_step(
  p_run_id text,
  p_generation integer,
  p_step_tokens bigint,
  p_step_requests integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_run public.coaching_runs%rowtype;
  v_out public.coaching_outbox%rowtype;
  v_anonymous boolean;
  v_quota public.coaching_quota%rowtype;
  v_provider_enabled boolean;
begin
  perform public.coaching_assert_service();
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.status in ('completed','failed','cancelled','unconfirmed') then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', true,
      'leaseValid', false, 'reason', 'terminal'
    );
  end if;
  select * into v_out from public.coaching_outbox o where o.run_id = p_run_id for update;
  if not found or v_out.lease_owner is null
     or v_out.lease_generation <> p_generation
     or v_out.lease_until <= now() then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.lease_generation <> p_generation then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.cancel_requested_at is not null then
    return jsonb_build_object(
      'allowed', false, 'cancelled', true, 'terminal', false,
      'leaseValid', true, 'reason', 'cancel-requested'
    );
  end if;
  if v_run.provider_call_started_at is null then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'call-not-started'
    );
  end if;

  select c.provider_enabled into v_provider_enabled
  from public.coaching_runtime_control c where c.id = 'global';
  if coalesce(v_provider_enabled, false) is not true then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'global-disabled'
    );
  end if;

  select u.is_anonymous into v_anonymous
  from auth.users u where u.id = v_run.owner_id;
  if not found or v_anonymous is not false then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'account-not-formal'
    );
  end if;

  select * into v_quota from public.coaching_quota q where q.owner_id = v_run.owner_id;
  if not found or v_quota.configured is not true then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'quota-not-configured'
    );
  end if;
  if v_quota.tokens_limit is null
     or coalesce(v_quota.per_run_token_budget, 0) <= 0
     or coalesce(v_quota.per_step_token_budget, 0) <= 0
     or coalesce(v_quota.per_run_request_limit, 0) <= 0
     or v_run.token_budget <= 0
     or v_run.request_budget <= 0 then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'budget-not-configured'
    );
  end if;
  if p_step_tokens is null or p_step_tokens <= 0
     or p_step_requests is null or p_step_requests < 1 then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'invalid-step-budget'
    );
  end if;
  if p_step_tokens > v_quota.per_step_token_budget then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'step-budget-exceeded'
    );
  end if;
  if v_run.provider_tokens_committed + p_step_tokens > v_run.token_budget then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'token-budget-exhausted'
    );
  end if;
  if v_run.provider_requests_committed + p_step_requests > v_run.request_budget then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'request-budget-exhausted'
    );
  end if;
  if v_quota.tokens_used + coalesce(v_quota.tokens_reserved, 0) > v_quota.tokens_limit then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'quota-exhausted'
    );
  end if;

  update public.coaching_runs r
  set provider_fetch_started_at = coalesce(r.provider_fetch_started_at, now()),
      provider_tokens_committed = r.provider_tokens_committed + p_step_tokens,
      provider_requests_committed = r.provider_requests_committed + p_step_requests,
      status = case when r.status = 'queued' then 'dispatching' else r.status end,
      updated_at = now()
  where r.id = p_run_id;
  return jsonb_build_object(
    'allowed', true, 'cancelled', false, 'terminal', false,
    'leaseValid', true
  );
end;
$$;

create or replace function public.coaching_append_event(
  p_run_id text,
  p_generation integer,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_run public.coaching_runs%rowtype;
  v_out public.coaching_outbox%rowtype;
  v_seq integer;
begin
  perform public.coaching_assert_service();
  if p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 65536 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if (p_payload ->> 'type') = 'terminal' then
    raise exception 'CLOUD_INVALID_TRANSITION' using errcode = '22023';
  end if;
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_out from public.coaching_outbox o where o.run_id = p_run_id for update;
  if not found or v_out.lease_owner is null
     or v_out.lease_generation <> p_generation
     or v_out.lease_until <= now() then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.lease_generation <> p_generation then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.status in ('completed','failed','cancelled','unconfirmed') then
    raise exception 'CLOUD_TERMINAL' using errcode = '55000';
  end if;

  select coalesce(max(e.seq), -1) + 1 into v_seq
  from public.coaching_run_events e where e.run_id = v_run.id;
  if v_seq >= 1000 then
    raise exception 'CLOUD_EVENT_CAP' using errcode = '54000';
  end if;

  insert into public.coaching_run_events (run_id, seq, payload)
  values (
    v_run.id,
    v_seq,
    jsonb_build_object(
      'protocolVersion', 1,
      'sessionId', v_run.session_id,
      'runId', v_run.id,
      'seq', v_seq,
      'event', p_payload
    )
  );

  update public.coaching_runs r
  set status = case
        when r.cancel_requested_at is not null then 'cancelling'
        when r.status = 'queued' then 'running'
        else r.status
      end,
      updated_at = now()
  where r.id = v_run.id;

  return jsonb_build_object('seq', v_seq);
end;
$$;

-- Terminal write. Concurrency release and budget release are separate:
-- a completed run with missing usage releases the concurrency slot but keeps
-- the unknown token allocation reserved. Budget is released here only when
-- the run provably never made a provider call.
create or replace function public.coaching_terminate_run(
  p_run_id text,
  p_generation integer,
  p_status text,
  p_reason text,
  p_failure_code text,
  p_failure_message text,
  p_termination_confirmed boolean,
  p_release_reservation boolean,
  p_proven_not_accepted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_run public.coaching_runs%rowtype;
  v_out public.coaching_outbox%rowtype;
  v_seq integer;
  v_status text := p_status;
  v_confirmed boolean := p_termination_confirmed is true;
  v_release boolean := p_release_reservation is true;
  v_reason text := p_reason;
  v_was_released boolean;
  v_was_budget_released boolean;
  v_budget_release boolean;
begin
  perform public.coaching_assert_service();
  if p_status not in ('completed','failed','cancelled','unconfirmed') then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if p_reason is not null and octet_length(p_reason) > 2048 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if p_failure_message is not null and octet_length(p_failure_message) > 2048 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  select coalesce(max(e.seq), -1) into v_seq from public.coaching_run_events e where e.run_id = v_run.id;
  if v_run.status in ('completed','failed','cancelled','unconfirmed') then
    return jsonb_build_object('run', public.coaching_run_json(v_run), 'lastSeq', v_seq);
  end if;
  select * into v_out from public.coaching_outbox o where o.run_id = p_run_id for update;
  if not found or v_out.lease_owner is null
     or v_out.lease_generation <> p_generation
     or v_out.lease_until <= now() then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.lease_generation <> p_generation then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  v_was_released := v_run.reservation_released;
  v_was_budget_released := v_run.budget_released;

  if v_run.cancel_requested_at is not null and v_status in ('completed','failed') then
    if v_run.provider_fetch_started_at is not null and p_proven_not_accepted is not true then
      v_status := 'unconfirmed';
      v_reason := coalesce(v_reason, 'cancel requested; provider termination unconfirmed');
    else
      v_status := 'cancelled';
      v_confirmed := true;
      v_release := true;
      v_reason := coalesce(v_reason, 'cancel requested');
    end if;
  end if;
  if v_status = 'cancelled'
     and v_run.provider_fetch_started_at is not null
     and p_proven_not_accepted is not true then
    v_status := 'unconfirmed';
    v_confirmed := false;
    v_release := false;
    v_reason := coalesce(v_reason, 'provider termination unconfirmed');
  end if;
  if v_status = 'unconfirmed' then
    v_confirmed := false;
    v_release := false;
  end if;

  v_seq := v_seq + 1;
  insert into public.coaching_run_events (run_id, seq, payload)
  values (
    v_run.id,
    v_seq,
    jsonb_build_object(
      'protocolVersion', 1,
      'sessionId', v_run.session_id,
      'runId', v_run.id,
      'seq', v_seq,
      'event', jsonb_build_object(
        'type', 'terminal',
        'status', case when v_status = 'unconfirmed' then 'failed' else v_status end,
        'reason', coalesce(v_reason, '')
      )
    )
  );

  -- A token allocation is only refunded when no provider fetch could have
  -- billed. Known settlement handles the normal completed path; unknown usage
  -- intentionally retains its remaining allocation.
  v_budget_release := (v_status = 'cancelled' and v_run.provider_fetch_started_at is null)
    or p_proven_not_accepted is true;

  update public.coaching_runs r
  set status = v_status,
      termination_confirmed = v_confirmed,
      reservation_released = (v_was_released or v_release),
      budget_released = (r.budget_released or v_budget_release),
      failure_code = p_failure_code,
      failure_message = p_failure_message,
      updated_at = now()
  where r.id = v_run.id
  returning * into v_run;

  if v_release and not v_was_released then
    update public.coaching_quota q
    set reserved_count = greatest(q.reserved_count - 1, 0), updated_at = now()
    where q.owner_id = v_run.owner_id;
  end if;
  if v_budget_release and not v_was_budget_released then
    update public.coaching_quota q
    set tokens_reserved = greatest(q.tokens_reserved - v_run.token_budget, 0), updated_at = now()
    where q.owner_id = v_run.owner_id and q.tokens_reserved > 0
      and not exists (
        select 1 from public.coaching_usage_ledger l where l.run_id = v_run.id
      );
  end if;

  update public.coaching_outbox o
  set status = case when v_status = 'unconfirmed' then 'dead' else 'done' end,
      last_error = case when v_status = 'unconfirmed' then 'execution unconfirmed' else null end,
      updated_at = now()
  where o.run_id = v_run.id;

  return jsonb_build_object('run', public.coaching_run_json(v_run), 'lastSeq', v_seq);
end;
$$;

-- Settle known actual usage once, fenced by generation. `p_usage_complete`
-- false means part of the provider usage was unavailable: charge the known
-- amount and retain the rest of the allocation instead of refunding it.
drop function if exists public.coaching_settle_usage(text, integer, integer, integer, integer, numeric, text);

create or replace function public.coaching_settle_usage(
  p_run_id text,
  p_generation integer,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_total_tokens integer,
  p_cost_usd numeric,
  p_generation_id text,
  p_usage_complete boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_run public.coaching_runs%rowtype;
  v_out public.coaching_outbox%rowtype;
  v_inserted text;
  v_charge bigint;
  v_complete boolean := p_usage_complete is true;
begin
  perform public.coaching_assert_service();
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_prompt_tokens is not null and p_prompt_tokens < 0
     or p_completion_tokens is not null and p_completion_tokens < 0
     or p_total_tokens is not null and p_total_tokens < 0
     or p_cost_usd is not null and p_cost_usd < 0 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  -- Idempotency wins even if the lease has since been reaped: a prior
  -- settlement is never repeated or reattributed.
  if exists (select 1 from public.coaching_usage_ledger l where l.run_id = p_run_id) then
    return jsonb_build_object('settled', false);
  end if;
  select * into v_out from public.coaching_outbox o where o.run_id = p_run_id for update;
  if not found or v_out.lease_owner is null
     or v_out.lease_generation <> p_generation
     or v_out.lease_until <= now() then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.lease_generation <> p_generation then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.status in ('completed','failed','cancelled','unconfirmed') then
    return jsonb_build_object('settled', false);
  end if;

  v_charge := greatest(coalesce(p_total_tokens, 0), 0);
  insert into public.coaching_usage_ledger (
    run_id, owner_id, prompt_tokens, completion_tokens, total_tokens, cost_usd,
    provider_generation_id, usage_complete
  ) values (
    v_run.id, v_run.owner_id,
    greatest(coalesce(p_prompt_tokens, 0), 0),
    greatest(coalesce(p_completion_tokens, 0), 0),
    v_charge,
    p_cost_usd,
    p_generation_id,
    v_complete
  )
  on conflict (run_id) do nothing
  returning run_id into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('settled', false);
  end if;

  update public.coaching_quota q
  set tokens_used = q.tokens_used + v_charge,
      tokens_reserved = case
        when v_complete then greatest(q.tokens_reserved - v_run.token_budget, 0)
        else greatest(q.tokens_reserved - least(v_run.token_budget, v_charge), 0)
      end,
      updated_at = now()
  where q.owner_id = v_run.owner_id;

  update public.coaching_runs r
  set budget_released = (r.budget_released or v_complete),
      updated_at = now()
  where r.id = v_run.id;

  return jsonb_build_object('settled', true, 'usageComplete', v_complete);
end;
$$;

create or replace function public.coaching_release_reservation(
  p_run_id text,
  p_generation integer,
  p_proven_not_accepted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_run public.coaching_runs%rowtype;
  v_release_concurrency boolean;
  v_release_budget boolean;
begin
  perform public.coaching_assert_service();
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.lease_generation <> p_generation then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.reservation_released and v_run.budget_released then
    return jsonb_build_object('released', false, 'reason', 'already-released');
  end if;
  if v_run.provider_accepted_at is not null then
    raise exception 'CLOUD_REFUND_UNPROVEN' using errcode = '42501';
  end if;
  if v_run.provider_fetch_started_at is not null and p_proven_not_accepted is not true then
    raise exception 'CLOUD_REFUND_UNPROVEN' using errcode = '42501';
  end if;
  v_release_concurrency := not v_run.reservation_released;
  v_release_budget := not v_run.budget_released;
  update public.coaching_runs r
  set reservation_released = true,
      budget_released = true,
      updated_at = now()
  where r.id = v_run.id;
  if v_release_concurrency then
    update public.coaching_quota q
    set reserved_count = greatest(q.reserved_count - 1, 0), updated_at = now()
    where q.owner_id = v_run.owner_id;
  end if;
  if v_release_budget then
    update public.coaching_quota q
    set tokens_reserved = greatest(q.tokens_reserved - v_run.token_budget, 0), updated_at = now()
    where q.owner_id = v_run.owner_id;
  end if;
  return jsonb_build_object('released', true);
end;
$$;

-- Grants. The base migration granted the old signatures; re-grant the new
-- ones and keep helpers/internal functions private.
revoke all on function public.coaching_create_session(text, integer) from public, anon, authenticated;
revoke all on function public.coaching_create_snapshot(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.coaching_submit_run(text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.coaching_find_run(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.coaching_cancel_run(text, text) from public, anon, authenticated;
revoke all on function public.coaching_authorize_provider_step(text, integer, bigint, integer) from public, anon, authenticated;
revoke all on function public.coaching_append_event(text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.coaching_terminate_run(text, integer, text, text, text, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.coaching_settle_usage(text, integer, integer, integer, integer, numeric, text, boolean) from public, anon, authenticated;
revoke all on function public.coaching_release_reservation(text, integer, boolean) from public, anon, authenticated;

grant execute on function public.coaching_create_session(text, integer) to authenticated;
grant execute on function public.coaching_create_snapshot(text, text, text, text, integer) to authenticated;
grant execute on function public.coaching_submit_run(text, text, text, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.coaching_find_run(text, text, text, text, text) to authenticated;
grant execute on function public.coaching_cancel_run(text, text) to authenticated;
grant execute on function public.coaching_authorize_provider_step(text, integer, bigint, integer) to service_role;
grant execute on function public.coaching_append_event(text, integer, jsonb) to service_role;
grant execute on function public.coaching_terminate_run(text, integer, text, text, text, text, boolean, boolean, boolean) to service_role;
grant execute on function public.coaching_settle_usage(text, integer, integer, integer, integer, numeric, text, boolean) to service_role;
grant execute on function public.coaching_release_reservation(text, integer, boolean) to service_role;
