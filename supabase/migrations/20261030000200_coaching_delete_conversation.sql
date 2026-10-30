-- Keep a conversation while any execution can still write to it. This lock is
-- shared with conversation-bound submit, so deletion cannot race a new run.
create function public.coaching_delete_conversation(p_id text) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := public.coaching_assert_formal_account();
begin
  perform 1 from public.coaching_conversations where owner_id=uid and id=p_id for update;
  if not found then raise exception 'CLOUD_CONVERSATION_NOT_FOUND' using errcode='P0002'; end if;
  if exists (select 1 from public.coaching_runs where owner_id=uid and conversation_id=p_id
      and status not in ('completed','failed','cancelled')) then
    raise exception 'CLOUD_CONVERSATION_BUSY' using errcode='23505';
  end if;
  delete from public.coaching_conversations where owner_id=uid and id=p_id;
  return jsonb_build_object('deleted',true);
end $$;
revoke all on function public.coaching_delete_conversation(text) from public,anon;
grant execute on function public.coaching_delete_conversation(text) to authenticated;
