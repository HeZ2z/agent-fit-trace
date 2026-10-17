-- Durable, owned cloud coaching tables + RPCs.
--
-- Design:
-- - Runs are server-created ids (primary key `id`), so the worker can fence a
--   run by id without a caller-supplied owner. Ownership is still `owner_id`
--   and RLS/`auth.uid()` scopes every caller read.
-- - Sessions/snapshots use client-supplied ids, so they are keyed by
--   `(owner_id, id)` and are never visible across accounts.
-- - The caller-token RPCs are SECURITY DEFINER only because they must read
--   `auth.users.is_anonymous` (the authoritative classification). Each one
--   derives the owner from `auth.uid()` and never accepts an owner argument.
-- - Worker RPCs are SECURITY DEFINER and reject anything whose JWT role is not
--   `service_role`. The service key is never used by the request path.
-- - `coaching_quota` is operator-configured. A missing row is NOT unlimited.
-- - `coaching_outbox` has a row per run (one dispatch), leased with a
--   generation fence. A run with a provider-call marker but no terminal is
--   marked `unconfirmed` and is never auto-redispatched.
-- - The terminal event is written ONLY by `coaching_terminate_run`, so a run
--   has exactly one terminal and dense seq values.
--
-- Additive only: IF NOT EXISTS / CREATE OR REPLACE, no table drops.

create table if not exists public.coaching_sessions (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (owner_id, id)
);

create table if not exists public.coaching_snapshots (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  source text not null,
  record_ids jsonb not null,
  records jsonb not null,
  record_count integer not null,
  from_date text,
  to_date text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (owner_id, id),
  check (jsonb_typeof(records) = 'array'),
  check (jsonb_typeof(record_ids) = 'array'),
  check (record_count >= 0 and record_count <= 5000),
  check (jsonb_array_length(records) = record_count),
  check (jsonb_array_length(record_ids) = record_count)
);

create table if not exists public.coaching_runs (
  id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  session_id text not null,
  idempotency_key text not null,
  request_hash text not null,
  prompt text not null,
  status text not null default 'queued'
    check (status in ('queued','dispatching','running','cancelling','completed','failed','cancelled','unconfirmed')),
  backend_id text not null check (backend_id = 'cloud-default'),
  runtime_id text not null check (runtime_id = 'hosted-sdk'),
  snapshot jsonb not null,
  snapshot_records jsonb not null,
  cancel_requested_at timestamptz,
  cancel_reason text,
  provider_call_started_at timestamptz,
  -- Written immediately before the first actual provider HTTP request, by
  -- `coaching_authorize_provider_step`. A call before this marker is safe to
  -- cancel/refund; after it, acceptance is unknown unless recorded.
  provider_fetch_started_at timestamptz,
  provider_accepted_at timestamptz,
  provider_generation_id text,
  termination_confirmed boolean not null default false,
  reservation_released boolean not null default false,
  failure_code text,
  failure_message text,
  lease_generation integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (owner_id, session_id, idempotency_key)
);

create index if not exists coaching_runs_owner_created_idx
  on public.coaching_runs (owner_id, created_at desc);

create table if not exists public.coaching_run_events (
  run_id text not null references public.coaching_runs (id) on delete cascade,
  seq integer not null check (seq >= 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create table if not exists public.coaching_quota (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  configured boolean not null default true,
  concurrent_limit integer not null default 20 check (concurrent_limit between 0 and 20),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  tokens_limit bigint check (tokens_limit is null or tokens_limit >= 0),
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.coaching_usage_ledger (
  run_id text primary key references public.coaching_runs (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  cost_usd numeric(12, 6),
  provider_generation_id text,
  settled_at timestamptz not null default now()
);

create table if not exists public.coaching_outbox (
  run_id text primary key references public.coaching_runs (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','leased','done','dead')),
  attempts integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  lease_generation integer not null default 0,
  available_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists coaching_outbox_due_idx
  on public.coaching_outbox (status, available_at);

alter table public.coaching_sessions enable row level security;
alter table public.coaching_snapshots enable row level security;
alter table public.coaching_runs enable row level security;
alter table public.coaching_run_events enable row level security;
alter table public.coaching_quota enable row level security;
alter table public.coaching_usage_ledger enable row level security;
alter table public.coaching_outbox enable row level security;

-- Caller reads only. All writes go through the RPCs below. `anon` gets
-- nothing; the service role bypasses RLS for the worker RPCs.
revoke all on table public.coaching_sessions from public, anon, authenticated;
revoke all on table public.coaching_snapshots from public, anon, authenticated;
revoke all on table public.coaching_runs from public, anon, authenticated;
revoke all on table public.coaching_run_events from public, anon, authenticated;
revoke all on table public.coaching_quota from public, anon, authenticated;
revoke all on table public.coaching_usage_ledger from public, anon, authenticated;
revoke all on table public.coaching_outbox from public, anon, authenticated;

grant select on table public.coaching_sessions to authenticated;
grant select on table public.coaching_snapshots to authenticated;
grant select on table public.coaching_runs to authenticated;
grant select on table public.coaching_run_events to authenticated;
grant select on table public.coaching_quota to authenticated;
grant select on table public.coaching_usage_ledger to authenticated;

drop policy if exists coaching_sessions_select_own on public.coaching_sessions;
create policy coaching_sessions_select_own on public.coaching_sessions
  for select to authenticated using (auth.uid() = owner_id);

drop policy if exists coaching_snapshots_select_own on public.coaching_snapshots;
create policy coaching_snapshots_select_own on public.coaching_snapshots
  for select to authenticated using (auth.uid() = owner_id);

drop policy if exists coaching_runs_select_own on public.coaching_runs;
create policy coaching_runs_select_own on public.coaching_runs
  for select to authenticated using (auth.uid() = owner_id);

drop policy if exists coaching_run_events_select_own on public.coaching_run_events;
create policy coaching_run_events_select_own on public.coaching_run_events
  for select to authenticated
  using (exists (
    select 1 from public.coaching_runs r
    where r.id = coaching_run_events.run_id and r.owner_id = auth.uid()
  ));

drop policy if exists coaching_quota_select_own on public.coaching_quota;
create policy coaching_quota_select_own on public.coaching_quota
  for select to authenticated using (auth.uid() = owner_id);

drop policy if exists coaching_usage_select_own on public.coaching_usage_ledger;
create policy coaching_usage_select_own on public.coaching_usage_ledger
  for select to authenticated using (auth.uid() = owner_id);

-- Reject guests and unknown users. `is_anonymous is not false` fails closed
-- for NULL/missing rows; JWT metadata is never consulted.
create or replace function public.coaching_assert_formal_account()
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_anonymous boolean;
begin
  if v_uid is null then
    raise exception 'CLOUD_ACCOUNT_NOT_FORMAL' using errcode = '42501';
  end if;
  select u.is_anonymous into v_anonymous
  from auth.users u
  where u.id = v_uid;
  if not found or v_anonymous is not false then
    raise exception 'CLOUD_ACCOUNT_NOT_FORMAL' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function public.coaching_assert_formal_account() from public, anon;
grant execute on function public.coaching_assert_formal_account() to authenticated;

-- Truthful account/quota state for discovery. Guests get isAnonymous=true so
-- the HTTP handler can answer with a clear denial instead of a generic 500.
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
begin
  if v_uid is null then
    raise exception 'CLOUD_ACCOUNT_NOT_FORMAL' using errcode = '42501';
  end if;
  select u.is_anonymous into v_anonymous from auth.users u where u.id = v_uid;
  select * into v_quota from public.coaching_quota q where q.owner_id = v_uid;
  return jsonb_build_object(
    'accountId', v_uid,
    'isAnonymous', coalesce(v_anonymous, true),
    'quotaConfigured', coalesce(v_quota.configured, false),
    'concurrentLimit', coalesce(v_quota.concurrent_limit, 0),
    'reservedCount', coalesce(v_quota.reserved_count, 0),
    'tokensRemaining', case
      when v_quota.tokens_limit is null then null
      else greatest(v_quota.tokens_limit - v_quota.tokens_used, 0)
    end
  );
end;
$$;

revoke all on function public.coaching_cloud_state() from public, anon;
grant execute on function public.coaching_cloud_state() to authenticated;

-- Shared serialization of one run. Internal `snapshotRecords` is only ever
-- returned to the worker/service path; the request repository parses the
-- public fields and drops it before responding to a browser.
create or replace function public.coaching_run_json(r public.coaching_runs)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', r.id,
    'sessionId', r.session_id,
    'accountId', r.owner_id,
    'status', r.status,
    'idempotencyKey', r.idempotency_key,
    'requestHash', r.request_hash,
    'prompt', r.prompt,
    'snapshot', r.snapshot,
    'snapshotRecords', r.snapshot_records,
    'backendId', r.backend_id,
    'runtimeId', r.runtime_id,
    'createdAt', r.created_at,
    'updatedAt', r.updated_at,
    'expiresAt', floor(extract(epoch from r.expires_at) * 1000)::bigint,
    'cancelRequestedAt', r.cancel_requested_at,
    'cancelReason', r.cancel_reason,
    'providerCallStartedAt', r.provider_call_started_at,
    'providerFetchStartedAt', r.provider_fetch_started_at,
    'providerAcceptedAt', r.provider_accepted_at,
    'providerGenerationId', r.provider_generation_id,
    'terminationConfirmed', r.termination_confirmed,
    'reservationReleased', r.reservation_released,
    'failure', case
      when r.failure_code is null then null
      else jsonb_build_object('code', r.failure_code, 'message', r.failure_message)
    end
  );
$$;

revoke all on function public.coaching_run_json(public.coaching_runs) from public, anon, authenticated;

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
  if length(v_id) > 128 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  -- Per-account serialization: concurrent direct RPC calls cannot both pass
  -- the count check. Caller TTLs are clamped to a trusted hard maximum.
  perform pg_advisory_xact_lock(hashtext('fit-trace-cloud-sessions-v1:' || v_uid::text));
  select count(*) into v_count from public.coaching_sessions s where s.owner_id = v_uid;
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

create or replace function public.coaching_read_session(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_row public.coaching_sessions%rowtype;
begin
  select * into v_row from public.coaching_sessions s
  where s.owner_id = v_uid and s.id = p_id;
  if not found then
    raise exception 'CLOUD_SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'id', v_row.id,
    'expiresAt', floor(extract(epoch from v_row.expires_at) * 1000)::bigint
  );
end;
$$;

-- Snapshot contents are generated INSIDE this RPC from the caller's own
-- `public.workouts` rows. A direct authenticated caller cannot supply records,
-- ids, counts, or an owner. The caller only chooses a bounded date filter; the
-- immutable snapshot is then the authoritative source for a cloud run.
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
  if p_snapshot_id is null or btrim(p_snapshot_id) = ''
     or p_source is distinct from 'authenticated-store' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if p_from is not null and p_from !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if p_to is not null and p_to !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;

  -- Snapshot from the RLS-owned source table. The owner is auth.uid().
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

  -- Serialize count+insert per account so direct concurrent RPC calls cannot
  -- exceed the cap. TTL is clamped to a trusted hard maximum.
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

-- Atomic submit: one canonical hash per (account, session, idempotency key);
-- a retained identical request replays even after its snapshot expires; a
-- changed request is CLOUD_CONFLICT; a new request reserves quota under a
-- global advisory lock (max 20 concurrent reservations) before insert.
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
  v_hash text := md5(p_request::text);
  v_run public.coaching_runs%rowtype;
  v_snapshot public.coaching_snapshots%rowtype;
  v_quota public.coaching_quota%rowtype;
  v_total integer;
  v_seq integer;
begin
  if p_backend_id <> 'cloud-default' or p_runtime_id <> 'hosted-sdk' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  if p_run_id is null or btrim(p_run_id) = '' or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or p_prompt is null or btrim(p_prompt) = '' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;

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
  if (p_request ->> 'prompt') is distinct from p_prompt
     or (p_request -> 'snapshot' ->> 'snapshotId') is distinct from p_snapshot_id
     or (p_request -> 'snapshot' ->> 'source') is distinct from p_snapshot_source
     or (p_request -> 'snapshot' ->> 'accountId') is distinct from v_uid::text then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;

  -- Serialize reservations across accounts so the global cap is exact.
  perform pg_advisory_xact_lock(hashtext('fit-trace-cloud-quota-v1'));
  select * into v_quota from public.coaching_quota q where q.owner_id = v_uid for update;
  if not found or v_quota.configured is not true then
    raise exception 'CLOUD_QUOTA_NOT_CONFIGURED' using errcode = '42501';
  end if;
  select coalesce(sum(q.reserved_count), 0) into v_total from public.coaching_quota q;
  if v_quota.reserved_count >= least(v_quota.concurrent_limit, 20) or v_total >= 20 then
    raise exception 'CLOUD_QUOTA_EXHAUSTED' using errcode = '53400';
  end if;

  begin
    insert into public.coaching_runs (
      id, owner_id, session_id, idempotency_key, request_hash, prompt, status,
      backend_id, runtime_id, snapshot, snapshot_records, expires_at
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
  set reserved_count = q.reserved_count + 1, updated_at = now()
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

create or replace function public.coaching_read_run(p_run_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_run public.coaching_runs%rowtype;
  v_seq integer;
begin
  select * into v_run from public.coaching_runs r
  where r.owner_id = v_uid and r.id = p_run_id;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  select coalesce(max(e.seq), -1) into v_seq from public.coaching_run_events e where e.run_id = v_run.id;
  return jsonb_build_object(
    'run', public.coaching_run_json(v_run),
    'lastSeq', v_seq,
    'firstSeq', 0,
    'expiresAt', floor(extract(epoch from v_run.expires_at) * 1000)::bigint
  );
end;
$$;

create or replace function public.coaching_read_events(p_run_id text, p_from_seq integer, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := public.coaching_assert_formal_account();
  v_run public.coaching_runs%rowtype;
  v_last integer;
  v_events jsonb;
begin
  select * into v_run from public.coaching_runs r
  where r.owner_id = v_uid and r.id = p_run_id;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  select coalesce(max(e.seq), -1) into v_last from public.coaching_run_events e where e.run_id = v_run.id;
  if p_from_seq is null or p_from_seq < 0 or p_from_seq > v_last + 1 then
    raise exception 'CLOUD_EXPIRED_CURSOR' using errcode = 'P0003';
  end if;
  select coalesce(jsonb_agg(e.payload order by e.seq), '[]'::jsonb) into v_events
  from (
    select e.payload, e.seq
    from public.coaching_run_events e
    where e.run_id = v_run.id and e.seq >= p_from_seq
    order by e.seq
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  ) e;
  return jsonb_build_object(
    'events', v_events,
    'run', public.coaching_run_json(v_run),
    'lastSeq', v_last,
    'firstSeq', 0,
    'expiresAt', floor(extract(epoch from v_run.expires_at) * 1000)::bigint
  );
end;
$$;

-- Cancellation before an actual provider fetch is immediately terminal and
-- refunds the reservation. After the first fetch it records intent only; the
-- worker stops further calls, and termination is reported as `unconfirmed`
-- (never a clean `cancelled`) with the reservation retained.
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
begin
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

  -- Only an actual provider fetch makes cancellation unconfirmed. A worker
  -- that wrote the intent marker but never fetched is still safe to cancel.
  if v_run.provider_fetch_started_at is null then
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
        updated_at = now()
    where r.id = v_run.id
    returning * into v_run;
    update public.coaching_quota q
    set reserved_count = greatest(q.reserved_count - 1, 0), updated_at = now()
    where q.owner_id = v_uid;
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

revoke all on function public.coaching_create_session(text, integer) from public, anon, authenticated;
revoke all on function public.coaching_read_session(text) from public, anon, authenticated;
revoke all on function public.coaching_create_snapshot(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.coaching_submit_run(text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.coaching_read_run(text) from public, anon, authenticated;
revoke all on function public.coaching_read_events(text, integer, integer) from public, anon, authenticated;
revoke all on function public.coaching_cancel_run(text, text) from public, anon, authenticated;

grant execute on function public.coaching_create_session(text, integer) to authenticated;
grant execute on function public.coaching_read_session(text) to authenticated;
grant execute on function public.coaching_create_snapshot(text, text, text, text, integer) to authenticated;
grant execute on function public.coaching_submit_run(text, text, text, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.coaching_read_run(text) to authenticated;
grant execute on function public.coaching_read_events(text, integer, integer) to authenticated;
grant execute on function public.coaching_cancel_run(text, text) to authenticated;

-- Worker RPCs ---------------------------------------------------------------

create or replace function public.coaching_assert_service()
returns void
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'CLOUD_NOT_SERVICE' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.coaching_claim_outbox(
  p_worker_id text,
  p_lease_ms integer,
  p_limit integer
)
returns setof jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_now timestamptz := now();
  v_row record;
  v_run public.coaching_runs%rowtype;
  v_out public.coaching_outbox%rowtype;
  v_seq integer;
begin
  perform public.coaching_assert_service();
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;

  -- An expired lease with a provider-fetch marker is acceptance-unknown: never
  -- re-dispatch. Keep the reservation, expose `unconfirmed` honestly, and
  -- append exactly one terminal event so every terminal run is readable over
  -- replay. The shared event contract has no `unconfirmed` status, so the
  -- event is `failed` with an explicit reason.
  for v_row in
    select r.id
    from public.coaching_runs r
    join public.coaching_outbox o on o.run_id = r.id
    where r.status in ('queued','dispatching','running','cancelling')
      and r.provider_fetch_started_at is not null
      and o.status = 'leased'
      and o.lease_until <= v_now
    order by o.created_at asc
    for update of r, o skip locked
  loop
    select coalesce(max(e.seq), -1) + 1 into v_seq
    from public.coaching_run_events e where e.run_id = v_row.id;
    insert into public.coaching_run_events (run_id, seq, payload)
    values (
      v_row.id,
      v_seq,
      jsonb_build_object(
        'protocolVersion', 1,
        'sessionId', (select r.session_id from public.coaching_runs r where r.id = v_row.id),
        'runId', v_row.id,
        'seq', v_seq,
        'event', jsonb_build_object(
          'type', 'terminal',
          'status', 'failed',
          'reason', 'execution unconfirmed: provider acceptance cannot be proven'
        )
      )
    );
    update public.coaching_runs r
    set status = 'unconfirmed',
        failure_code = coalesce(r.failure_code, 'EXECUTION_UNCONFIRMED'),
        failure_message = coalesce(
          r.failure_message,
          'Provider acceptance is unconfirmed; the run will not be automatically re-dispatched.'
        ),
        termination_confirmed = false,
        reservation_released = false,
        updated_at = v_now
    where r.id = v_row.id;
    update public.coaching_outbox o
    set status = 'dead',
        last_error = 'lease expired with provider acceptance unconfirmed',
        updated_at = v_now
    where o.run_id = v_row.id;
  end loop;

  -- A lease that expired BEFORE any actual provider fetch is safe to reclaim,
  -- even if a worker wrote the intent marker but crashed before dispatch.
  update public.coaching_runs r
  set provider_call_started_at = null,
      status = case when r.cancel_requested_at is not null then 'cancelling' else 'queued' end,
      updated_at = v_now
  where r.status in ('queued','dispatching','running','cancelling')
    and r.provider_fetch_started_at is null
    and exists (
      select 1 from public.coaching_outbox o
      where o.run_id = r.id and o.status = 'leased' and o.lease_until <= v_now
    );
  update public.coaching_outbox o
  set status = 'pending',
      lease_owner = null,
      lease_until = null,
      available_at = v_now,
      updated_at = v_now
  where o.status = 'leased'
    and o.lease_until <= v_now
    and exists (
      select 1 from public.coaching_runs r
      where r.id = o.run_id and r.provider_fetch_started_at is null
        and r.status in ('queued','cancelling')
    );

  for v_row in
    select o.run_id
    from public.coaching_outbox o
    join public.coaching_runs r on r.id = o.run_id
    where o.status in ('pending','leased')
      and o.available_at <= v_now
      and (o.status = 'pending' or o.lease_until <= v_now)
      and r.status in ('queued','cancelling')
      and r.provider_fetch_started_at is null
    order by o.created_at asc
    limit least(greatest(coalesce(p_limit, 1), 1), 10)
    for update of o skip locked
  loop
    update public.coaching_outbox o
    set status = 'leased',
        lease_owner = p_worker_id,
        lease_until = v_now + (greatest(p_lease_ms, 15000) / 1000.0) * interval '1 second',
        lease_generation = o.lease_generation + 1,
        attempts = o.attempts + 1,
        last_error = null,
        updated_at = v_now
    where o.run_id = v_row.run_id
    returning * into v_out;

    update public.coaching_runs r
    set lease_generation = v_out.lease_generation, updated_at = v_now
    where r.id = v_out.run_id
    returning * into v_run;

    return next jsonb_build_object(
      'run', public.coaching_run_json(v_run),
      'leaseGeneration', v_out.lease_generation,
      'attempt', v_out.attempts
    );
  end loop;
end;
$$;

create or replace function public.coaching_mark_provider_call(p_run_id text, p_generation integer)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_run public.coaching_runs%rowtype;
  v_out public.coaching_outbox%rowtype;
begin
  perform public.coaching_assert_service();
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.status in ('completed','failed','cancelled','unconfirmed') then
    return jsonb_build_object('started', false, 'alreadyStarted', false, 'cancelled', false, 'terminal', true);
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
    return jsonb_build_object('started', false, 'alreadyStarted', false, 'cancelled', true, 'terminal', false);
  end if;
  if v_run.provider_call_started_at is not null then
    return jsonb_build_object('started', false, 'alreadyStarted', true, 'cancelled', false, 'terminal', false);
  end if;
  update public.coaching_runs r
  set provider_call_started_at = now(), status = 'dispatching', updated_at = now()
  where r.id = p_run_id;
  return jsonb_build_object('started', true, 'alreadyStarted', false, 'cancelled', false, 'terminal', false);
end;
$$;

create or replace function public.coaching_mark_provider_accepted(
  p_run_id text,
  p_generation integer,
  p_generation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_run public.coaching_runs%rowtype;
  v_out public.coaching_outbox%rowtype;
begin
  perform public.coaching_assert_service();
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.status in ('completed','failed','cancelled','unconfirmed') then
    return public.coaching_run_json(v_run);
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
  if v_run.provider_call_started_at is null or v_run.provider_fetch_started_at is null then
    raise exception 'CLOUD_INVALID_TRANSITION' using errcode = '22023';
  end if;
  update public.coaching_runs r
  set provider_accepted_at = coalesce(r.provider_accepted_at, now()),
      provider_generation_id = coalesce(r.provider_generation_id, p_generation_id),
      status = case when r.cancel_requested_at is not null then 'cancelling' else 'running' end,
      updated_at = now()
  where r.id = p_run_id
  returning * into v_run;
  return public.coaching_run_json(v_run);
end;
$$;

-- Called by the worker immediately before EVERY provider HTTP request. It
-- validates the current lease/fence, cancellation intent, the authoritative
-- formal-account classification, and remaining token quota; only then does it
-- record the first actual fetch. No caller-supplied identity is trusted.
create or replace function public.coaching_authorize_provider_step(
  p_run_id text,
  p_generation integer
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

  select u.is_anonymous into v_anonymous
  from auth.users u where u.id = v_run.owner_id;
  if not found or v_anonymous is not false then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'account-not-formal'
    );
  end if;

  select * into v_quota from public.coaching_quota q where q.owner_id = v_run.owner_id;
  if not found or v_quota.quota_configured is not true then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'quota-not-configured'
    );
  end if;
  if v_quota.tokens_limit is not null and v_quota.tokens_used >= v_quota.tokens_limit then
    return jsonb_build_object(
      'allowed', false, 'cancelled', false, 'terminal', false,
      'leaseValid', true, 'reason', 'quota-exhausted'
    );
  end if;

  update public.coaching_runs r
  set provider_fetch_started_at = coalesce(r.provider_fetch_started_at, now()),
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
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
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
begin
  perform public.coaching_assert_service();
  if p_status not in ('completed','failed','cancelled','unconfirmed') then
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

  -- Cancellation intent wins a late completion/failure. If an actual provider
  -- fetch happened, acceptance/termination is unknown: report `unconfirmed`,
  -- never a clean `cancelled`, and retain the reservation.
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
        -- The shared event contract has no `unconfirmed` terminal status. A
        -- run can still be `unconfirmed`; its terminal event is `failed` with
        -- an explicit reason so clients never render it as a clean cancel.
        'status', case when v_status = 'unconfirmed' then 'failed' else v_status end,
        'reason', coalesce(v_reason, '')
      )
    )
  );

  update public.coaching_runs r
  set status = v_status,
      termination_confirmed = v_confirmed,
      reservation_released = (v_was_released or v_release),
      failure_code = p_failure_code,
      failure_message = p_failure_message,
      updated_at = now()
  where r.id = v_run.id
  returning * into v_run;

  -- Decrement exactly once: only when this transition newly releases a
  -- reservation. A run that was already released (or already terminal) never
  -- decrements twice.
  if v_release and not v_was_released then
    update public.coaching_quota q
    set reserved_count = greatest(q.reserved_count - 1, 0), updated_at = now()
    where q.owner_id = v_run.owner_id;
  end if;

  update public.coaching_outbox o
  set status = case when v_status = 'unconfirmed' then 'dead' else 'done' end,
      last_error = case when v_status = 'unconfirmed' then 'execution unconfirmed' else null end,
      updated_at = now()
  where o.run_id = v_run.id;

  return jsonb_build_object('run', public.coaching_run_json(v_run), 'lastSeq', v_seq);
end;
$$;

create or replace function public.coaching_settle_usage(
  p_run_id text,
  p_generation integer,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_total_tokens integer,
  p_cost_usd numeric,
  p_generation_id text
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
begin
  perform public.coaching_assert_service();
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
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
  insert into public.coaching_usage_ledger (
    run_id, owner_id, prompt_tokens, completion_tokens, total_tokens, cost_usd, provider_generation_id
  ) values (
    v_run.id, v_run.owner_id,
    greatest(coalesce(p_prompt_tokens, 0), 0),
    greatest(coalesce(p_completion_tokens, 0), 0),
    greatest(coalesce(p_total_tokens, 0), 0),
    p_cost_usd,
    p_generation_id
  )
  on conflict (run_id) do nothing
  returning run_id into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('settled', false);
  end if;
  update public.coaching_quota q
  set tokens_used = q.tokens_used + greatest(coalesce(p_total_tokens, 0), 0),
      updated_at = now()
  where q.owner_id = v_run.owner_id;
  return jsonb_build_object('settled', true);
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
begin
  perform public.coaching_assert_service();
  select * into v_run from public.coaching_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'CLOUD_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.lease_generation <> p_generation then
    raise exception 'CLOUD_LEASE_LOST' using errcode = '40001';
  end if;
  if v_run.reservation_released then
    return jsonb_build_object('released', false, 'reason', 'already-released');
  end if;
  if v_run.provider_accepted_at is not null then
    raise exception 'CLOUD_REFUND_UNPROVEN' using errcode = '42501';
  end if;
  if v_run.provider_fetch_started_at is not null and p_proven_not_accepted is not true then
    raise exception 'CLOUD_REFUND_UNPROVEN' using errcode = '42501';
  end if;
  update public.coaching_runs r
  set reservation_released = true, updated_at = now()
  where r.id = v_run.id;
  update public.coaching_quota q
  set reserved_count = greatest(q.reserved_count - 1, 0), updated_at = now()
  where q.owner_id = v_run.owner_id;
  return jsonb_build_object('released', true);
end;
$$;

revoke all on function public.coaching_assert_service() from public, anon, authenticated;
revoke all on function public.coaching_claim_outbox(text, integer, integer) from public, anon, authenticated;
revoke all on function public.coaching_mark_provider_call(text, integer) from public, anon, authenticated;
revoke all on function public.coaching_mark_provider_accepted(text, integer, text) from public, anon, authenticated;
revoke all on function public.coaching_authorize_provider_step(text, integer) from public, anon, authenticated;
revoke all on function public.coaching_append_event(text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.coaching_terminate_run(text, integer, text, text, text, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.coaching_settle_usage(text, integer, integer, integer, integer, numeric, text) from public, anon, authenticated;
revoke all on function public.coaching_release_reservation(text, integer, boolean) from public, anon, authenticated;

grant execute on function public.coaching_assert_service() to service_role;
grant execute on function public.coaching_claim_outbox(text, integer, integer) to service_role;
grant execute on function public.coaching_mark_provider_call(text, integer) to service_role;
grant execute on function public.coaching_mark_provider_accepted(text, integer, text) to service_role;
grant execute on function public.coaching_authorize_provider_step(text, integer) to service_role;
grant execute on function public.coaching_append_event(text, integer, jsonb) to service_role;
grant execute on function public.coaching_terminate_run(text, integer, text, text, text, text, boolean, boolean, boolean) to service_role;
grant execute on function public.coaching_settle_usage(text, integer, integer, integer, integer, numeric, text) to service_role;
grant execute on function public.coaching_release_reservation(text, integer, boolean) to service_role;

-- Worker reads runs/events/outbox/quota directly through service-role
-- PostgREST only inside these RPCs; no extra table grants are needed.
