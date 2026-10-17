-- Immutable imported analysis/plan snapshots, their "currently viewing"
-- selections, and the explicitly separate plan adoption.
--
-- Design notes:
-- - Snapshots are append-only and content-addressed: the caller's server
--   code computes `sha256(stableStringify(payload))` and derives
--   `<kind>:v1:<digest>`; the table CHECKs enforce that structural identity,
--   and the save RPC compares canonical jsonb on a duplicate. API roles have
--   only SELECT on the snapshot table, so the RPC is the only writer and an
--   original record can never be inserted directly, updated, deleted, or
--   truncated.
-- - Mutable state lives in two separate tables: `artifact_preferences` only
--   remembers what the UI is viewing, and `plan_adoptions` records an
--   explicit confirmation. Selecting a plan never adopts it.
-- - `save_imported_artifact` is SECURITY DEFINER because API roles have no
--   INSERT grant on the snapshot table, so it is the only write path. The
--   read/selection/adoption RPCs (`list_imported_artifacts_page`,
--   `get_imported_artifact`, `get_artifact_selection`,
--   `set_artifact_selection`, `get_plan_adoption`, `set_plan_adoption`) are
--   SECURITY INVOKER and rely on RLS + explicit `auth.uid()` predicates.
-- - `owner_id` always comes from `auth.uid()` (read inside the RPC), never
--   from an argument; it is the only owner source and there is no
--   service-role path. RLS remains the second line of defence for reads.
-- - Every function pins `search_path = ''` and schema-qualifies all
--   relations/functions (`public.*`, `auth.*`) so a hostile object in
--   `public` cannot shadow anything.
-- - The migration is additive: `IF NOT EXISTS` leaves existing workouts and
--   tables untouched; only new tables, indexes, policies, and RPCs are
--   created.
-- - `created_at` is returned through PostgREST as ISO 8601, which the shared
--   guards re-validate on every read.

-- Structural guard for `source_record_ids`: an array of bounded, non-empty
-- strings. Used by the table CHECK and the save RPC so a direct write cannot
-- smuggle objects/empty ids into the denormalized source references.
create or replace function public.import_source_record_ids_valid(p_ids jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_ids) is distinct from 'array' then false
    else jsonb_array_length(p_ids) <= 1000
      and not exists (
        select 1
        from jsonb_array_elements(p_ids) as entry(value)
        where jsonb_typeof(entry.value) is distinct from 'string'
          or char_length(entry.value #>> '{}') not between 1 and 256
      )
  end;
$$;

create table if not exists public.imported_artifacts (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 256),
  kind text not null check (kind in ('analysis', 'plan')),
  schema_version integer not null check (schema_version = 1),
  payload_schema_version integer not null check (payload_schema_version = 1),
  source text not null check (source = 'file_import'),
  source_filename text check (
    source_filename is null
    or (btrim(source_filename) <> '' and char_length(source_filename) <= 255)
  ),
  source_record_ids jsonb not null check (public.import_source_record_ids_valid(source_record_ids)),
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    -- Defensive SQL bound (64 KiB). The shared TS contract already limits the
    -- normalized request to 40 KiB compact JSON; jsonb text adds one space
    -- after every comma/colon (worst case +50%, i.e. at most 60 KiB), so this
    -- slightly larger guard never rejects a valid near-limit request.
    and octet_length(payload::text) <= 65536
  ),
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint imported_artifacts_identity_check
    check (id = kind || ':v1:' || content_digest),
  -- The denormalized source refs must be exactly the refs in the canonical
  -- payload: a direct insert/RPC caller cannot forge one without the other.
  constraint imported_artifacts_source_records_match
    check (
      (
        (
          kind = 'analysis'
          and payload -> 'source_records' = source_record_ids
        ) or (
          kind = 'plan'
          and payload -> 'based_on' -> 'source_records' = source_record_ids
        )
      ) is true
    ),
  -- A stored plan must be an unconfirmed draft; adopting it is separate state.
  constraint imported_artifacts_plan_draft_check
    check (
      (
        kind <> 'plan' or (
          jsonb_typeof(payload -> 'is_draft') = 'boolean'
          and payload ->> 'is_draft' = 'true'
          -- `jsonb_typeof` keeps the JSON string "true" from passing `->>`.
          and jsonb_typeof(payload -> 'requires_confirmation') = 'boolean'
          and payload ->> 'requires_confirmation' = 'true'
          and jsonb_typeof(payload -> 'based_on') = 'object'
          and jsonb_typeof(payload -> 'based_on' -> 'source_records') = 'array'
          and jsonb_typeof(payload -> 'recommendations') = 'array'
          and jsonb_typeof(payload -> 'safety_notes') = 'array'
        )
      ) is true
    ),
  constraint imported_artifacts_analysis_shape_check
    check (
      (
        kind <> 'analysis' or (
          jsonb_typeof(payload -> 'metrics') = 'object'
          and jsonb_typeof(payload -> 'trends') = 'array'
          and jsonb_typeof(payload -> 'source_records') = 'array'
        )
      ) is true
    ),
  -- Composite uniqueness targets used by the selection/adoption foreign keys.
  constraint imported_artifacts_owner_kind_identity
    unique (owner_id, id, kind),
  constraint imported_artifacts_owner_kind_digest
    unique (owner_id, id, kind, content_digest)
);

create index if not exists imported_artifacts_owner_list_idx
  on public.imported_artifacts (owner_id, kind, created_at desc, id desc);

create index if not exists imported_artifacts_owner_created_idx
  on public.imported_artifacts (owner_id, created_at desc, id desc);

-- The selected snapshot per kind. A null `artifact_id` means "nothing
-- selected"; the row itself may be absent and is then read as null. The
-- composite foreign key keeps a selection from pointing at another owner's
-- (or a deleted) snapshot.
create table if not exists public.artifact_preferences (
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('analysis', 'plan')),
  artifact_id text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, kind),
  constraint artifact_preferences_artifact_fk
    foreign key (owner_id, artifact_id, kind)
    references public.imported_artifacts (owner_id, id, kind),
  constraint artifact_preferences_artifact_id_check
    check (artifact_id is null or char_length(artifact_id) between 1 and 256)
);

-- Explicit plan adoption. Separate from selections by design: adopting is a
-- deliberate confirmation carrying the digest the user saw.
create table if not exists public.plan_adoptions (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  artifact_id text not null,
  -- Adoptions are plan-only; the composite FK below also pins the kind and
  -- the confirmed digest to the referenced snapshot, so a direct write can
  -- neither adopt an analysis nor claim a digest the plan does not have.
  kind text not null default 'plan' check (kind = 'plan'),
  confirmed_digest text not null check (confirmed_digest ~ '^[0-9a-f]{64}$'),
  confirmed_at timestamptz not null default now(),
  constraint plan_adoptions_artifact_fk
    foreign key (owner_id, artifact_id, kind, confirmed_digest)
    references public.imported_artifacts (owner_id, id, kind, content_digest),
  constraint plan_adoptions_artifact_id_check
    check (char_length(artifact_id) between 1 and 256)
);

alter table public.imported_artifacts enable row level security;
alter table public.artifact_preferences enable row level security;
alter table public.plan_adoptions enable row level security;

-- Least-privilege grants. REVOKE ALL first because Supabase default
-- privileges may include UPDATE/DELETE/TRUNCATE (TRUNCATE bypasses RLS).
-- Snapshots are READ-ONLY for API roles: no direct INSERT/UPDATE/DELETE/
-- TRUNCATE grant exists, so the only write path is the SECURITY DEFINER save
-- RPC below, which re-checks every structural reference and draft invariant.
revoke all on table public.imported_artifacts from public, anon, authenticated;
grant select on table public.imported_artifacts to authenticated;

revoke all on table public.artifact_preferences from public, anon, authenticated;
grant select, insert, update on table public.artifact_preferences to authenticated;

revoke all on table public.plan_adoptions from public, anon, authenticated;
grant select, insert, update, delete on table public.plan_adoptions to authenticated;

drop policy if exists imported_artifacts_select_own on public.imported_artifacts;
create policy imported_artifacts_select_own
  on public.imported_artifacts
  for select
  to authenticated
  using (auth.uid() = owner_id);

drop policy if exists imported_artifacts_insert_own on public.imported_artifacts;
create policy imported_artifacts_insert_own
  on public.imported_artifacts
  for insert
  to authenticated
  with check (auth.uid() = owner_id);

-- No update/delete policy exists for snapshots: they are append-only.

drop policy if exists artifact_preferences_select_own on public.artifact_preferences;
create policy artifact_preferences_select_own
  on public.artifact_preferences
  for select
  to authenticated
  using (auth.uid() = owner_id);

drop policy if exists artifact_preferences_insert_own on public.artifact_preferences;
create policy artifact_preferences_insert_own
  on public.artifact_preferences
  for insert
  to authenticated
  with check (auth.uid() = owner_id);

drop policy if exists artifact_preferences_update_own on public.artifact_preferences;
create policy artifact_preferences_update_own
  on public.artifact_preferences
  for update
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists plan_adoptions_select_own on public.plan_adoptions;
create policy plan_adoptions_select_own
  on public.plan_adoptions
  for select
  to authenticated
  using (auth.uid() = owner_id);

drop policy if exists plan_adoptions_insert_own on public.plan_adoptions;
create policy plan_adoptions_insert_own
  on public.plan_adoptions
  for insert
  to authenticated
  with check (auth.uid() = owner_id);

drop policy if exists plan_adoptions_update_own on public.plan_adoptions;
create policy plan_adoptions_update_own
  on public.plan_adoptions
  for update
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists plan_adoptions_delete_own on public.plan_adoptions;
create policy plan_adoptions_delete_own
  on public.plan_adoptions
  for delete
  to authenticated
  using (auth.uid() = owner_id);

-- Atomic immutable save. SECURITY DEFINER is required because API roles have
-- no direct INSERT grant: this function is the only write path. It still takes
-- the owner from `auth.uid()` (never a caller argument) and validates every
-- structural reference/draft invariant before inserting. An identical
-- canonical payload is a duplicate no-op; the same id with different content
-- raises IMPORT_CONFLICT (mapped by the server to 409).
--
-- Digest-vs-payload verification stays in TypeScript: SHA-256 over
-- `stableStringify(payload)` cannot be reproduced reliably by Postgres
-- (`jsonb::text` orders keys differently). The SQL layer therefore enforces
-- id = kind:v1:digest, kind/source-ref/draft consistency, and read-only
-- tables; a caller who invokes this RPC directly with a made-up digest can
-- only create an internally inconsistent row for their own owner, which every
-- TypeScript read rejects as CORRUPT_STORE.
create or replace function public.save_imported_artifact(
  p_kind text,
  p_id text,
  p_payload_schema_version integer,
  p_payload jsonb,
  p_source_filename text,
  p_source_record_ids jsonb,
  p_content_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_created_at timestamptz;
  v_existing public.imported_artifacts%rowtype;
begin
  if v_owner is null then
    raise exception 'IMPORT_INVALID' using errcode = '42501', detail = 'missing owner';
  end if;
  if p_kind is null or p_kind not in ('analysis', 'plan') then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid kind';
  end if;
  if p_content_digest is null or p_content_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid digest';
  end if;
  if p_id is null or char_length(p_id) not between 1 and 256
    or p_id <> p_kind || ':v1:' || p_content_digest then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'id mismatch';
  end if;
  if p_payload_schema_version is distinct from 1 then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'unsupported payload version';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid payload';
  end if;
  -- Defensive SQL bound (64 KiB) independent of the shared TS 40-KiB
  -- compact normalized-request guard. jsonb text adds one space after every
  -- comma/colon (worst case +50%, i.e. at most 60 KiB), so the SQL guard is
  -- larger and never rejects a valid near-limit payload.
  if octet_length(p_payload::text) > 65536 then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'payload too large';
  end if;
  -- Reject a missing source id list as well as an invalid one: `is null or`
  -- avoids relying on three-valued logic from the helper alone.
  if p_source_record_ids is null
    or not public.import_source_record_ids_valid(p_source_record_ids) then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid source records';
  end if;
  if p_kind = 'analysis' then
    -- Independent shape checks, not just the denormalized ref equality.
    if jsonb_typeof(p_payload -> 'metrics') is distinct from 'object'
      or jsonb_typeof(p_payload -> 'trends') is distinct from 'array'
      or jsonb_typeof(p_payload -> 'source_records') is distinct from 'array' then
      raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid analysis shape';
    end if;
    if p_payload -> 'source_records' is distinct from p_source_record_ids then
      raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'source records mismatch';
    end if;
  end if;
  if p_kind = 'plan' then
    if jsonb_typeof(p_payload -> 'based_on') is distinct from 'object'
      or jsonb_typeof(p_payload -> 'based_on' -> 'source_records') is distinct from 'array' then
      raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid plan shape';
    end if;
    if p_payload -> 'based_on' -> 'source_records' is distinct from p_source_record_ids then
      raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'source records mismatch';
    end if;
    if jsonb_typeof(p_payload -> 'is_draft') is distinct from 'boolean'
      or p_payload ->> 'is_draft' is distinct from 'true'
      -- Require a JSON boolean, so the JSON string "true" cannot slip through.
      or jsonb_typeof(p_payload -> 'requires_confirmation') is distinct from 'boolean'
      or p_payload ->> 'requires_confirmation' is distinct from 'true'
      or jsonb_typeof(p_payload -> 'recommendations') is distinct from 'array'
      or jsonb_typeof(p_payload -> 'safety_notes') is distinct from 'array' then
      raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid plan draft';
    end if;
  end if;
  if p_source_filename is not null
    and (btrim(p_source_filename) = '' or char_length(p_source_filename) > 255) then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid filename';
  end if;

  begin
    insert into public.imported_artifacts (
      owner_id, id, kind, schema_version, payload_schema_version, source,
      source_filename, source_record_ids, content_digest, payload
    ) values (
      v_owner, p_id, p_kind, 1, p_payload_schema_version, 'file_import',
      p_source_filename, p_source_record_ids, p_content_digest, p_payload
    )
    returning created_at into v_created_at;

    return jsonb_build_object(
      'created', true,
      'artifact', jsonb_build_object(
        'owner_id', v_owner,
        'id', p_id,
        'kind', p_kind,
        'schema_version', 1,
        'payload_schema_version', p_payload_schema_version,
        'source', 'file_import',
        'source_filename', p_source_filename,
        'source_record_ids', p_source_record_ids,
        'content_digest', p_content_digest,
        'payload', p_payload,
        'created_at', v_created_at
      )
    );
  exception when unique_violation then
    select * into v_existing
    from public.imported_artifacts as a
    where a.owner_id = v_owner and a.id = p_id;
    if v_existing.id is null then
      raise;
    end if;
    if v_existing.kind = p_kind
      and v_existing.payload = p_payload
      and v_existing.content_digest = p_content_digest then
      return jsonb_build_object(
        'created', false,
        'artifact', jsonb_build_object(
          'owner_id', v_existing.owner_id,
          'id', v_existing.id,
          'kind', v_existing.kind,
          'schema_version', v_existing.schema_version,
          'payload_schema_version', v_existing.payload_schema_version,
          'source', v_existing.source,
          'source_filename', v_existing.source_filename,
          'source_record_ids', v_existing.source_record_ids,
          'content_digest', v_existing.content_digest,
          'payload', v_existing.payload,
          'created_at', v_existing.created_at
        )
      );
    end if;
    raise exception 'IMPORT_CONFLICT' using errcode = '23505', detail = p_id;
  end;
end;
$$;

-- Metadata-only keyset page over (created_at DESC, id DESC). Payloads are
-- deliberately absent so a list never downloads history-sized bodies.
create or replace function public.list_imported_artifacts_page(
  p_kind text,
  p_after_created_at text,
  p_after_id text,
  p_limit integer
)
returns table (
  owner_id uuid,
  id text,
  kind text,
  schema_version integer,
  payload_schema_version integer,
  source text,
  source_filename text,
  source_record_ids jsonb,
  content_digest text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    a.owner_id,
    a.id,
    a.kind,
    a.schema_version,
    a.payload_schema_version,
    a.source,
    a.source_filename,
    a.source_record_ids,
    a.content_digest,
    a.created_at
  from public.imported_artifacts as a
  where a.owner_id = auth.uid()
    and (p_kind is null or a.kind = p_kind)
    and (
      p_after_created_at is null
      or p_after_id is null
      or (a.created_at, a.id) < (p_after_created_at::timestamptz, p_after_id)
    )
  order by a.created_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Full snapshot plus owner_id so the server can re-verify ownership even if a
-- future RLS/policy mistake ever widened the result set.
create or replace function public.get_imported_artifact(p_id text)
returns table (
  owner_id uuid,
  id text,
  kind text,
  schema_version integer,
  payload_schema_version integer,
  source text,
  source_filename text,
  source_record_ids jsonb,
  content_digest text,
  payload jsonb,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    a.owner_id,
    a.id,
    a.kind,
    a.schema_version,
    a.payload_schema_version,
    a.source,
    a.source_filename,
    a.source_record_ids,
    a.content_digest,
    a.payload,
    a.created_at
  from public.imported_artifacts as a
  where a.owner_id = auth.uid() and a.id = p_id;
$$;

create or replace function public.get_artifact_selection(p_kind text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_artifact_id text;
begin
  if p_kind is null or p_kind not in ('analysis', 'plan') then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid kind';
  end if;
  select p.artifact_id into v_artifact_id
  from public.artifact_preferences as p
  where p.owner_id = auth.uid() and p.kind = p_kind;
  return jsonb_build_object('artifact_id', v_artifact_id);
end;
$$;

create or replace function public.set_artifact_selection(p_kind text, p_artifact_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind text;
begin
  if p_kind is null or p_kind not in ('analysis', 'plan') then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid kind';
  end if;
  if p_artifact_id is not null then
    select a.kind into v_kind
    from public.imported_artifacts as a
    where a.owner_id = auth.uid() and a.id = p_artifact_id;
    if not found then
      raise exception 'IMPORT_ARTIFACT_NOT_FOUND' using errcode = 'P0002', detail = 'selection target';
    end if;
    if v_kind <> p_kind then
      raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'kind mismatch';
    end if;
  end if;

  insert into public.artifact_preferences (owner_id, kind, artifact_id, updated_at)
  values (auth.uid(), p_kind, p_artifact_id, now())
  on conflict (owner_id, kind) do update
    set artifact_id = excluded.artifact_id,
        updated_at = now();

  return jsonb_build_object('artifact_id', p_artifact_id);
end;
$$;

create or replace function public.get_plan_adoption()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_artifact_id text;
  v_confirmed_digest text;
  v_confirmed_at timestamptz;
begin
  select a.artifact_id, a.confirmed_digest, a.confirmed_at
    into v_artifact_id, v_confirmed_digest, v_confirmed_at
  from public.plan_adoptions as a
  where a.owner_id = auth.uid();
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'artifact_id', v_artifact_id,
    'confirmed_digest', v_confirmed_digest,
    'confirmed_at', v_confirmed_at
  );
end;
$$;

create or replace function public.set_plan_adoption(
  p_artifact_id text,
  p_confirmed_digest text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.plan_adoptions%rowtype;
  v_kind text;
  v_digest text;
  v_confirmed_at timestamptz;
begin
  if p_artifact_id is null and p_confirmed_digest is null then
    delete from public.plan_adoptions where owner_id = auth.uid();
    return null;
  end if;
  if p_artifact_id is null or p_confirmed_digest is null then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'incomplete adoption';
  end if;
  if char_length(p_artifact_id) not between 1 and 256 then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid id';
  end if;
  if p_confirmed_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'invalid digest';
  end if;

  select a.kind, a.content_digest into v_kind, v_digest
  from public.imported_artifacts as a
  where a.owner_id = auth.uid() and a.id = p_artifact_id;
  if not found then
    raise exception 'IMPORT_ARTIFACT_NOT_FOUND' using errcode = 'P0002', detail = 'adoption target';
  end if;
  if v_kind <> 'plan' then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'not a plan';
  end if;
  if v_digest <> p_confirmed_digest then
    raise exception 'IMPORT_INVALID' using errcode = '22023', detail = 'digest mismatch';
  end if;

  select * into v_existing
  from public.plan_adoptions as a
  where a.owner_id = auth.uid();
  if found
    and v_existing.artifact_id = p_artifact_id
    and v_existing.confirmed_digest = p_confirmed_digest then
    return jsonb_build_object(
      'artifact_id', v_existing.artifact_id,
      'confirmed_digest', v_existing.confirmed_digest,
      'confirmed_at', v_existing.confirmed_at
    );
  end if;

  insert into public.plan_adoptions (owner_id, artifact_id, kind, confirmed_digest, confirmed_at)
  values (auth.uid(), p_artifact_id, 'plan', p_confirmed_digest, now())
  on conflict (owner_id) do update
    set artifact_id = excluded.artifact_id,
        confirmed_digest = excluded.confirmed_digest,
        confirmed_at = excluded.confirmed_at
  returning confirmed_at into v_confirmed_at;

  return jsonb_build_object(
    'artifact_id', p_artifact_id,
    'confirmed_digest', p_confirmed_digest,
    'confirmed_at', v_confirmed_at
  );
end;
$$;

-- Only authenticated callers may execute these RPCs; anon/public are denied.
-- The CHECK helper is internal to the table/RPC and is not callable via RPC.
revoke all on function public.import_source_record_ids_valid(jsonb)
  from public, anon, authenticated;

revoke all on function public.save_imported_artifact(text, text, integer, jsonb, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.save_imported_artifact(text, text, integer, jsonb, text, jsonb, text)
  to authenticated;

revoke all on function public.list_imported_artifacts_page(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_imported_artifacts_page(text, text, text, integer)
  to authenticated;

revoke all on function public.get_imported_artifact(text) from public, anon, authenticated;
grant execute on function public.get_imported_artifact(text) to authenticated;

revoke all on function public.get_artifact_selection(text) from public, anon, authenticated;
grant execute on function public.get_artifact_selection(text) to authenticated;

revoke all on function public.set_artifact_selection(text, text) from public, anon, authenticated;
grant execute on function public.set_artifact_selection(text, text) to authenticated;

revoke all on function public.get_plan_adoption() from public, anon, authenticated;
grant execute on function public.get_plan_adoption() to authenticated;

revoke all on function public.set_plan_adoption(text, text) from public, anon, authenticated;
grant execute on function public.set_plan_adoption(text, text) to authenticated;
