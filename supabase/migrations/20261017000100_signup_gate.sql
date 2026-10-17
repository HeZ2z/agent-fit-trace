-- Invite-only signup gate + same-UID guest upgrade guard.
--
-- Background (docs/supabase-setup.md §6):
-- GoTrue rejects anonymous sign-in when the global `auth.enable_signup` is
-- false (it maps to DISABLE_SIGNUP). There is therefore no native "anonymous
-- yes, public email signup no" combination. The safe profile keeps global
-- signup enabled only because the before-user-created hook below rejects every
-- non-anonymous creation that is not backed by a server-controlled invite row.
--
-- GoTrue's before-user-created hook does NOT run for email linking or email
-- verification. With `enable_manual_linking = true`, a guest could therefore
-- link any email and become a permanent account without passing the invite
-- hook. The narrow `auth.users` BEFORE UPDATE trigger below closes that gap at
-- the Auth database boundary: for a row that is currently anonymous, an email
-- initiation must reference an unconsumed invite, and the anonymous -> account
-- transition must atomically consume that invite inside the same GoTrue
-- transaction.
--
-- Pinned GoTrue v2.197.0 verification sequence
-- (https://github.com/supabase/auth/blob/v2.197.0/internal/api/verify.go):
--   1. `tx.UpdateOnly(user, "is_anonymous")` flips `is_anonymous` to false;
--   2. `user.ConfirmEmailChange(...)` sets `email`/`email_confirmed_at` in the
--      same transaction.
-- Therefore the conversion trigger must derive the target from
-- `NEW.email_change`/`OLD.email_change` while `NEW.email` is still empty; it
-- must not require `NEW.email_confirmed_at` on step 1. A later failure in step
-- 2 rolls the whole transaction back, including the invite consumption.
--
-- This migration is additive and inert until `supabase/config.toml` enables
-- the hook and manual linking. Apply it before enabling that profile.
--
-- Rollback (forward-only migration; run manually only after taking a backup):
--   drop trigger if exists enforce_guest_upgrade_invite on auth.users;
--   drop function if exists public.enforce_guest_upgrade_invite();
-- Dropping the trigger/function intentionally leaves `public.signup_invites`
-- and all invite data intact. Never drop `auth.users` or owned workout data as
-- part of an upgrade rollback.

create table if not exists public.signup_invites (
  email text primary key,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

comment on table public.signup_invites is
  'Server-controlled invite allowlist for the before-user-created hook and anonymous guest upgrades. Insert with the service role only.';

alter table public.signup_invites enable row level security;

-- No policies: anon/authenticated cannot read or write this table. The
-- service role (Admin API/back office) bypasses RLS and keeps explicit rights.
revoke all on table public.signup_invites from anon, authenticated;
grant all on table public.signup_invites to service_role;

-- Case-insensitive invite identity: one normalized email can never have two
-- pending rows, so the creation hook and the upgrade trigger compete for the
-- same single claim. Existing duplicates (only possible in a hand-edited
-- local DB) must be resolved before this migration; the service-only table is
-- never populated by the app.
create unique index if not exists signup_invites_email_normalized_key
  on public.signup_invites (lower(email));

create or replace function public.hook_allow_anonymous_or_invited(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Unique names (v_*) keep PL/pgSQL from resolving these as columns: bare
  -- `email` would be ambiguous against signup_invites.email.
  v_is_anonymous boolean := coalesce((event->'user'->>'is_anonymous')::boolean, false);
  v_email text := lower(btrim(coalesce(event->'user'->>'email', '')));
begin
  -- Anonymous guests are the only uninvited creation path.
  if v_is_anonymous then
    return '{}'::jsonb;
  end if;

  -- Formal accounts are created only after a server-side invite row exists.
  -- A single UPDATE...WHERE consumes the row atomically; checking EXISTS
  -- first and updating afterwards would let two concurrent signups both pass.
  if v_email <> '' then
    update public.signup_invites as invites
    set consumed_at = now()
    where lower(invites.email) = v_email
      and invites.consumed_at is null;

    -- FOUND is set by the UPDATE above: true iff an unused invite was consumed.
    if found then
      return '{}'::jsonb;
    end if;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'Invite-only signup. Ask an administrator for an invitation.',
      'http_code', 403
    )
  );
end;
$$;

revoke all on function public.hook_allow_anonymous_or_invited(jsonb)
  from public, anon, authenticated;
grant execute on function public.hook_allow_anonymous_or_invited(jsonb)
  to supabase_auth_admin;

-- Narrow guest-upgrade qualification at the Auth database boundary.
--
-- The trigger fires only for rows whose OLD.is_anonymous is true. Account
-- creation, invited-account login, recovery, refresh, and all post-upgrade
-- updates have OLD.is_anonymous = false and are untouched.
create or replace function public.enforce_guest_upgrade_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_email text;
  v_new_email text;
  v_old_change text;
  v_new_change text;
  v_target text;
begin
  -- Assign trigger rows in the body: OLD/NEW are trigger-scoped records and
  -- keeping all reads in the executable section is unambiguous across
  -- PostgreSQL versions.
  v_old_email := lower(btrim(coalesce(OLD.email, '')));
  v_new_email := lower(btrim(coalesce(NEW.email, '')));
  v_old_change := lower(btrim(coalesce(OLD.email_change, '')));
  v_new_change := lower(btrim(coalesce(NEW.email_change, '')));

  -- Defensive narrowness: the trigger's WHEN clause already filters this,
  -- but a function is callable only by the trigger and re-checks so a future
  -- trigger edit cannot accidentally gate ordinary account updates.
  if OLD.is_anonymous is distinct from true then
    return NEW;
  end if;

  if NEW.is_anonymous is false then
    -- GoTrue flips is_anonymous to false before ConfirmEmailChange runs in the
    -- same transaction. Prefer an actually changed NEW.email; otherwise use
    -- the pending target that ConfirmEmailChange will apply.
    if v_new_email <> '' and v_new_email <> v_old_email then
      v_target := v_new_email;
    else
      v_target := coalesce(
        nullif(v_new_change, ''),
        nullif(v_old_change, ''),
        nullif(v_new_email, '')
      );
    end if;

    if v_target is null then
      raise exception 'Guest upgrade requires an invited email target'
        using errcode = '42501';
    end if;

    -- Atomic single claim shared with the creation hook. If another principal
    -- consumed the invite first, FOUND is false and the whole GoTrue
    -- transaction (including the is_anonymous flip and final email change)
    -- rolls back.
    update public.signup_invites as invites
    set consumed_at = now()
    where lower(invites.email) = v_target
      and invites.consumed_at is null;

    if not found then
      raise exception 'Guest upgrade email is not invited'
        using errcode = '42501';
    end if;

    return NEW;
  end if;

  if NEW.is_anonymous is true then
    -- Still anonymous: this is the pending-email-change initiation/resend.
    -- Requiring an unconsumed invite here gives an early, non-destructive
    -- failure for uninvited targets. The invite is deliberately NOT consumed
    -- yet: GoTrue may reject the email, the link may expire, or the user may
    -- cancel. Consumption happens only on verified conversion above.
    if v_new_email = v_old_email and v_new_change = v_old_change then
      return NEW;
    end if;

    if v_new_email <> '' and v_new_email <> v_old_email then
      v_target := v_new_email;
    else
      v_target := coalesce(nullif(v_new_change, ''), nullif(v_new_email, ''));
    end if;

    -- Clearing a pending change (no target) is allowed.
    if v_target is null then
      return NEW;
    end if;

    if not exists (
      select 1
      from public.signup_invites as invites
      where lower(invites.email) = v_target
        and invites.consumed_at is null
    ) then
      raise exception 'Guest upgrade email is not invited'
        using errcode = '42501';
    end if;

    return NEW;
  end if;

  -- is_anonymous must never be null on an Auth user; fail closed rather than
  -- allowing an ambiguous conversion.
  raise exception 'Guest upgrade has an invalid anonymous classification'
    using errcode = '42501';
end;
$$;

revoke all on function public.enforce_guest_upgrade_invite()
  from public, anon, authenticated;
grant execute on function public.enforce_guest_upgrade_invite()
  to supabase_auth_admin;

-- Stable trigger name is intentionally part of the managed-Auth coupling.
-- `DROP TRIGGER IF EXISTS` makes re-applying this migration safe without
-- touching data. The trigger fires only when GoTrue includes one of these
-- columns in its UPDATE; the function narrows behavior further by OLD flag.
drop trigger if exists enforce_guest_upgrade_invite on auth.users;
create trigger enforce_guest_upgrade_invite
before update of email, email_change, is_anonymous on auth.users
for each row
when (OLD.is_anonymous is true)
execute function public.enforce_guest_upgrade_invite();
