-- Keyset pagination over the caller's own workouts in (date, id) order.
--
-- Why an RPC instead of offset/limit or a PostgREST `or=` cursor filter:
-- - `offset` shifts when a concurrent insert lands before the current page,
--   returning rows twice (analysis then double-counts them).
-- - A cursor expressed as a PostgREST `or=` URL filter would need quoting
--   rules for arbitrary business ids (quotes, commas, parentheses,
--   backslashes); a wrong guess silently splits or drops rows. RPC
--   arguments travel as JSON parameters, so ids round-trip byte-exact with
--   no quoting or injection surface at all.
--
-- Semantics:
-- - First page passes NULL cursor; later pages pass the previous page's last
--   (date, id). The row-value comparison `(w.date, w.id) > cursor` is strict.
-- - Rows are returned in database (date ASC, id ASC) order; the server
--   truncates to p_limit (clamped to 1..1000, PostgREST max_rows may cut
--   further). Clients stop on an empty page — never on a short page.
-- - SECURITY INVOKER like create_workout: owner comes from auth.uid(), RLS
--   still applies, and callers need the explicit EXECUTE grant below.
--
-- Read-consistency boundary (also documented in docs/supabase-setup.md): a
-- multi-page read is NOT a single MVCC snapshot. Rows inserted strictly
-- before the cursor while paging are picked up by the next reload instead;
-- rows are still never returned twice. Products needing a strict snapshot
-- must read in a single transaction — keyset pagination does not claim that.
--
-- Additive only: never touches existing tables, constraints, policies, or
-- the create_workout RPC. Rerunnable (IF NOT EXISTS / CREATE OR REPLACE /
-- idempotent REVOKE+GRANT).

create index if not exists workouts_owner_date_id_idx
  on public.workouts (owner_id, date, id);

create or replace function public.list_workouts_page(p_after_date text, p_after_id text, p_limit integer)
returns table (payload jsonb, owner_id uuid, id text, date text)
language sql
stable
security invoker
set search_path = public
as $$
  select w.payload, w.owner_id, w.id, w.date
  from public.workouts as w
  where w.owner_id = auth.uid()
    and (p_after_date is null or p_after_id is null
      or (w.date, w.id) > (p_after_date, p_after_id))
  order by w.date asc, w.id asc
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

-- Only authenticated callers may execute the RPC; anon/public are denied.
revoke all on function public.list_workouts_page(text, text, integer) from public, anon, authenticated;
grant execute on function public.list_workouts_page(text, text, integer) to authenticated;
