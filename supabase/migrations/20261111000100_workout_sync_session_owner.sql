-- Exposes only whether the caller's signed session belongs to that caller.
-- Deploy only after reviewing the owner role's access to auth.sessions.
create or replace function public.fit_trace_sync_session_owned()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions s
    where s.id::text = pg_catalog.lower(auth.jwt() ->> 'session_id')
      and s.user_id = auth.uid()
  );
$$;

revoke all on function public.fit_trace_sync_session_owned() from public, anon;
grant execute on function public.fit_trace_sync_session_owned() to authenticated;
