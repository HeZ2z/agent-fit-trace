-- Remote MCP resource binding: server-maintained client map + custom access
-- token hook claim.
--
-- Background (docs/mcp.md "Remote MCP (HTTP)"):
-- The remote MCP endpoint (`/api/mcp`) is an OAuth 2.1 resource server. The
-- tokens it accepts are issued by Supabase Auth for the *same* user account
-- that also signs in to the browser app, so the token alone is not enough to
-- distinguish "this token may call the MCP endpoint" from "this is an ordinary
-- browser session token". The endpoint must refuse the latter — otherwise any
-- first-party session token could be replayed as an MCP credential.
--
-- The binding is deliberately NOT carried in `aud`. Supabase access tokens are
-- shared with Auth (`GET /auth/v1/user`) and PostgREST, both of which expect
-- `aud: authenticated`; rewriting `aud` for OAuth-issued tokens would put the
-- caller's own RLS-scoped token at risk. Instead the custom access token hook
-- below *adds* one claim, `fit_trace_mcp_resource`, whose value is the exact
-- MCP resource URL the token is minted for. `aud` is left untouched, so the
-- same token keeps working against Auth and PostgREST exactly as before.
--
-- The claim is stamped ONLY for OAuth clients present in the server-maintained
-- mapping table below. Every other token (browser password/OTP/anonymous
-- sign-in, non-listed OAuth clients) gets no claim, the MCP verifier rejects it
-- for the missing claim, and the app keeps working unchanged.
--
-- The claim value comes only from this table: never from user metadata, never
-- from the request, never from anything the client controls.
--
-- VERIFICATION STATUS: this migration is SQL-only and has NOT been applied
-- anywhere as part of this change (no Supabase CLI and no isolated project were
-- available). Applying it is one operator step; enabling the hook is a second,
-- separate step — see the rollback/enable notes at the end of this header.
-- Until both are done, nothing in this file has any runtime effect.
--
-- Schema note — why `client_id` is `text`, not a UUID foreign key:
-- The real GoTrue table is `auth.oauth_clients(id uuid, ...)`, not
-- `auth.clients`, and GoTrue migration 20250903112500 removed its separate
-- `client_id` text column, so `id` *is* the public client id. A `public.`-side
-- FK to `auth.oauth_clients(id)` was rejected for two reasons:
--   1. `auth.oauth_clients` exists only if the target environment's GoTrue is
--      new enough to have run 20250731150234; on an older local image the FK
--      makes this migration fail to apply. A migration that cannot apply is
--      worse than one without referential integrity.
--   2. The table is owned by `supabase_auth_admin`, so a cross-schema FK adds a
--      managed-Auth dependency to an operator-maintained table.
-- Tradeoff accepted: no database-level referential integrity here. The map is
-- operator-maintained with the service role; a stale row (client deleted or
-- renamed in the dashboard) simply never matches, so the claim is absent and
-- the MCP endpoint keeps rejecting — it fails closed, never open.
--
-- This migration is additive and inert until (a) a row is inserted and (b) the
-- hook is enabled. Apply the migration BEFORE enabling the hook.
--
-- Rollback (forward-only migration; run manually only after taking a backup):
--   -- 1. disable the hook first (dashboard, or remove the
--   --    [auth.hook.custom_access_token] block from supabase/config.toml);
--   drop function if exists public.hook_stamp_mcp_resource(jsonb);
--   drop table if exists public.mcp_oauth_client_resources;
-- Dropping the function stops all claim stamping immediately; dropping the
-- table additionally forgets which clients were ever allowed. Neither statement
-- touches `auth.oauth_clients` (Auth's own table) or any user data. Rolling back
-- also requires removing the MCP route (`api/mcp.mjs`) and the `FIT_TRACE_MCP_*`
-- env vars; see docs/deployment.md.

create table if not exists public.mcp_oauth_client_resources (
  -- Canonical lowercase UUID string: the identical text GoTrue puts in the
  -- token's `client_id` claim (`client.ID.String()`). Stored as text so this
  -- migration applies whether or not `auth.oauth_clients` exists.
  client_id text primary key
    check (client_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- Exact MCP resource URL. RFC 8707 resource indicators are absolute URIs
  -- without a query or fragment; the same shape is enforced here so a typo
  -- fails at insert time instead of silently never matching.
  resource text not null
    check (resource ~ '^https?://[^?#[:space:]]+$'),
  -- Flip to false to stop stamping for a client without deleting the audit
  -- trail of which resource it was ever bound to.
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.mcp_oauth_client_resources is
  'Server-maintained OAuth client id -> remote MCP resource URL map. The custom access token hook stamps fit_trace_mcp_resource from this table only; an empty or stale table means no token carries the claim (fail closed). Insert with the service role only.';

comment on column public.mcp_oauth_client_resources.client_id is
  'Canonical lowercase UUID string of auth.oauth_clients.id, i.e. the value GoTrue puts in the token client_id claim. No FK is declared on purpose; see the migration header.';

comment on column public.mcp_oauth_client_resources.resource is
  'Exact MCP resource URL, e.g. https://agent-fit-trace.vercel.app/api/mcp. No trailing slash, no query, no fragment.';

-- Same posture as public.signup_invites: anon/authenticated get nothing, the
-- service role (operator/back office) manages rows. The hook itself runs as
-- `security definer` (owner = migration role), so it can read the table without
-- granting the Auth role table access.
alter table public.mcp_oauth_client_resources enable row level security;

revoke all on table public.mcp_oauth_client_resources from anon, authenticated;
grant all on table public.mcp_oauth_client_resources to service_role;

-- Custom access token hook.
--
-- Contract (GoTrue v2.197.0, internal/hooks/v0hooks/v0hooks.go):
--   input  = { metadata, user_id, claims, authentication_method }
--   output = { claims }  <-- the *whole* object is unmarshalled into
--                          CustomAccessTokenOutput, which requires a `claims`
--                          key and 500s the token issuance if it is missing.
-- Therefore this function always returns the complete `event` object with only
-- `claims` replaced. Do NOT "simplify" it into returning the bare claims map,
-- or into returning an event that lost `claims`: either change fails every
-- login and token refresh with "output claims field is missing".
create or replace function public.hook_stamp_mcp_resource(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Declared (not assigned inline later) so the exception handler always has
  -- a well-formed object to return: returning NULL instead would make GoTrue
  -- fail the whole token issuance, which is exactly what this hook must never
  -- do.
  v_event jsonb := coalesce(event, '{}'::jsonb);
  v_claims jsonb;
  v_client_id text;
  v_resource text;
begin
  v_claims := v_event->'claims';

  -- Only OAuth tokens carry `client_id`. Browser password/OTP/anonymous
  -- sign-ins have none, so they are returned byte-identical and keep working
  -- against Auth/PostgREST with no extra claim.
  if v_claims is null or jsonb_typeof(v_claims) <> 'object' then
    return v_event;
  end if;

  v_client_id := lower(btrim(coalesce(v_claims->>'client_id', '')));
  if v_client_id = '' then
    return v_event;
  end if;

  -- Lookup only; the claim value can never come from anything the caller or
  -- the client supplies. A missing/disabled/renamed row leaves `v_resource`
  -- NULL and the claim absent.
  select resources.resource
  into v_resource
  from public.mcp_oauth_client_resources as resources
  where resources.client_id = v_client_id
    and resources.enabled;

  if v_resource is null or btrim(v_resource) = '' then
    return v_event;
  end if;

  -- create_missing = true; the `claims` path is already known to be an object.
  return jsonb_set(
    v_event,
    '{claims,fit_trace_mcp_resource}',
    to_jsonb(v_resource),
    true
  );
exception
  when others then
    -- Fail CLOSED, never loud: a malformed event, a missing table (migration
    -- not applied), a lock timeout, or any other error leaves the claim absent
    -- so the MCP endpoint rejects the token, while the user's ordinary login
    -- and token refresh still succeed. Never re-raise from here.
    return coalesce(event, '{}'::jsonb);
end;
$$;

comment on function public.hook_stamp_mcp_resource(jsonb) is
  'Supabase custom access token hook: stamps fit_trace_mcp_resource on tokens issued to allow-listed MCP OAuth clients. Never raises; on any miss the claim is simply absent (fail closed for the MCP endpoint, no impact on login).';

-- Grant pattern copied exactly from the sibling hook
-- `public.hook_allow_anonymous_or_invited` in 20261017000100_signup_gate.sql:
-- nobody but the Auth server may execute it.
revoke all on function public.hook_stamp_mcp_resource(jsonb)
  from public, anon, authenticated;
grant execute on function public.hook_stamp_mcp_resource(jsonb)
  to supabase_auth_admin;
