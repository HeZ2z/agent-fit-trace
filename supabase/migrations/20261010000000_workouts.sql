-- Workouts owned by Supabase Auth users.
--
-- Design notes (see docs/supabase-setup.md):
-- - Primary key is (owner_id, id): two users may hold the same business id
--   without seeing each other, and concurrent inserts of the same key are
--   serialized by the PK constraint — never by a JS queue.
-- - `owner_id` references `auth.users(id)` so orphaned rows are impossible.
-- - Tables are append-only: NO update/delete/truncate grants or policies
--   exist. Default privileges on a fresh project can grant
--   UPDATE/DELETE/TRUNCATE to anon/authenticated, and TRUNCATE bypasses RLS,
--   so this migration explicitly REVOKEs ALL then re-grants only
--   SELECT + INSERT to `authenticated` (nothing to `anon`).
-- - RLS is the second line of defence (the app also scopes every query by
--   owner); the server uses the caller's access token for PostgREST so RLS
--   always applies. The service-role key must never be used as user auth.
-- - `payload` holds the core-validated record; `date` is duplicated for
--   indexed ordering. The SQL layer never re-implements core validation, but
--   the RPC enforces that p_id/p_date equal payload.id/payload.date, and
--   table CHECKs enforce that the row id/date equal the payload's for direct
--   inserts too.
-- - The migration is additive only: it never DROP/CREATEs a pre-existing
--   production table (IF NOT EXISTS) and only replaces the RPC + policies.

create table if not exists public.workouts (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  payload jsonb not null,
  date text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create index if not exists workouts_owner_date_idx
  on public.workouts (owner_id, date);

alter table public.workouts enable row level security;

-- Routing columns must equal the embedded payload, enforced for EVERY writer
-- (RPC and direct PostgREST inserts alike): a direct insert whose payload
-- id/date disagrees with the row columns is rejected. Additive only — the
-- `DO` guards skip existing deployments that already have the constraints,
-- and no table is recreated.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workouts_payload_id_match'
      and conrelid = 'public.workouts'::regclass
  ) then
    alter table public.workouts
      add constraint workouts_payload_id_match
      check (jsonb_typeof(payload) = 'object'
        and jsonb_typeof(payload -> 'id') = 'string'
        and (payload ->> 'id') is not null and (payload ->> 'id') = id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'workouts_payload_date_match'
      and conrelid = 'public.workouts'::regclass
  ) then
    alter table public.workouts
      add constraint workouts_payload_date_match
      check (jsonb_typeof(payload -> 'date') = 'string'
        and (payload ->> 'date') is not null and (payload ->> 'date') = date);
  end if;
end;
$$;

-- Explicit least-privilege grants. REVOKE ALL first because Supabase default
-- privileges may have granted UPDATE/DELETE/TRUNCATE (TRUNCATE bypasses RLS).
-- Authenticated callers may only SELECT + INSERT their own rows (via the
-- policies below); `anon` gets nothing on this table.
revoke all on table public.workouts from public, anon, authenticated;
grant select, insert on table public.workouts to authenticated;

drop policy if exists workouts_select_own on public.workouts;
create policy workouts_select_own
  on public.workouts
  for select
  to authenticated
  using (auth.uid() = owner_id);

drop policy if exists workouts_insert_own on public.workouts;
create policy workouts_insert_own
  on public.workouts
  for insert
  to authenticated
  with check (auth.uid() = owner_id);

-- No update/delete/truncate policies exist (append-only). The REVOKE above
-- already removed those privileges; no GRANTs for them are added here.

-- Atomic idempotent create. SECURITY INVOKER (the default) is intentional:
-- the function runs as the caller, so `auth.uid()` is the verified user and
-- RLS still applies to the inner statements. The owner always comes from
-- `auth.uid()`; caller-supplied owner ids are not accepted as arguments.
--
-- Semantics mirror the in-memory store: inserting a new key creates one row;
-- re-inserting byte-identical canonical payload is a duplicate no-op;
-- the same key with different content raises WORKOUT_CONFLICT (mapped by the
-- server to 409 CONFLICT). `payload` equality is jsonb `=` (order-insensitive
-- for objects, order-sensitive for arrays — matching stableStringify).
create or replace function public.create_workout(p_id text, p_payload jsonb, p_date text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing jsonb;
begin
  if p_id is null or btrim(p_id) = '' then
    raise exception 'WORKOUT_INVALID' using errcode = '22023', detail = 'missing id';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'WORKOUT_INVALID' using errcode = '22023', detail = 'invalid payload';
  end if;
  -- The routing columns must equal the embedded payload: direct
  -- insert/RPC callers cannot smuggle a mismatched id/date.
  if (p_payload ->> 'id') is distinct from p_id then
    raise exception 'WORKOUT_INVALID' using errcode = '22023', detail = 'id mismatch';
  end if;
  if (p_payload ->> 'date') is distinct from p_date then
    raise exception 'WORKOUT_INVALID' using errcode = '22023', detail = 'date mismatch';
  end if;
  if p_date is null or btrim(p_date) = '' then
    raise exception 'WORKOUT_INVALID' using errcode = '22023', detail = 'missing date';
  end if;

  begin
    insert into public.workouts (owner_id, id, payload, date)
    values (auth.uid(), p_id, p_payload, p_date);
    return jsonb_build_object('created', true, 'payload', p_payload);
  exception when unique_violation then
    select w.payload into v_existing
    from public.workouts as w
    where w.owner_id = auth.uid() and w.id = p_id;
    if v_existing is null then
      raise;
    end if;
    if v_existing = p_payload then
      return jsonb_build_object('created', false, 'payload', v_existing);
    end if;
    raise exception 'WORKOUT_CONFLICT' using errcode = '23505', detail = p_id;
  end;
end;
$$;

-- Only authenticated callers may execute the RPC; anon/public are denied.
revoke all on function public.create_workout(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_workout(text, jsonb, text) to authenticated;
