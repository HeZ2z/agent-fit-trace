-- Link durable conversations to otherwise short-lived runs. These columns are
-- immutable once the guarded submission transaction has committed.
alter table public.coaching_runs
  add column conversation_id text,
  add column conversation_context jsonb not null default '[]'::jsonb;

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
    'conversationContext', r.conversation_context,
    'conversationId', r.conversation_id,
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

-- The legacy signatures are retained through guards so a caller cannot replay
-- a conversation-bound idempotency key while omitting its conversation ID.
alter function public.coaching_submit_run(text,text,text,text,text,text,text,text,jsonb) rename to coaching_submit_run_guarded;
alter function public.coaching_find_run(text,text,text,text,text) rename to coaching_find_run_guarded;
revoke all on function public.coaching_submit_run_guarded(text,text,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.coaching_find_run_guarded(text,text,text,text,text) from public,anon,authenticated;

create function public.coaching_submit_run(
 p_run_id text,p_session_id text,p_idempotency_key text,p_prompt text,p_backend_id text,
 p_runtime_id text,p_snapshot_id text,p_snapshot_source text,p_request jsonb
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare result jsonb; linked text;
begin
  result := public.coaching_submit_run_guarded(p_run_id,p_session_id,p_idempotency_key,p_prompt,
    p_backend_id,p_runtime_id,p_snapshot_id,p_snapshot_source,p_request);
  select r.conversation_id into linked from public.coaching_runs r where r.id=result -> 'run' ->> 'id';
  if linked is not null then raise exception 'CLOUD_CONFLICT' using errcode='23505'; end if;
  return result;
end $$;
create function public.coaching_find_run(
 p_session_id text,p_idempotency_key text,p_prompt text,p_snapshot_id text,p_snapshot_source text
) returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare result jsonb; linked text;
begin
  result := public.coaching_find_run_guarded(p_session_id,p_idempotency_key,p_prompt,p_snapshot_id,p_snapshot_source);
  if result is null then return null; end if;
  select r.conversation_id into linked from public.coaching_runs r where r.id=result -> 'run' ->> 'id';
  if linked is not null then raise exception 'CLOUD_CONFLICT' using errcode='23505'; end if;
  return result;
end $$;
revoke all on function public.coaching_submit_run(text,text,text,text,text,text,text,text,jsonb) from public,anon;
revoke all on function public.coaching_find_run(text,text,text,text,text) from public,anon;
grant execute on function public.coaching_submit_run(text,text,text,text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.coaching_find_run(text,text,text,text,text) to authenticated;

-- Preserve the existing guarded RPC and its quota / replay behaviour. The
-- overload locks the conversation, snapshots completed turns and writes the
-- user message in the same transaction as run submission.
create function public.coaching_submit_run(
  p_run_id text, p_session_id text, p_idempotency_key text, p_prompt text,
  p_backend_id text, p_runtime_id text, p_snapshot_id text,
  p_snapshot_source text, p_request jsonb, p_conversation_id text
) returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  uid uuid := public.coaching_assert_formal_account();
  result jsonb; existing public.coaching_runs%rowtype;
  ctx jsonb; run_id text;
begin
  if p_conversation_id is null or p_conversation_id !~ '^[A-Za-z0-9_-]{1,128}$'
     or octet_length(p_prompt) > 32768 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  perform 1 from public.coaching_conversations c
    where c.owner_id = uid and c.id = p_conversation_id for update;
  if not found then raise exception 'CLOUD_CONVERSATION_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into existing from public.coaching_runs r
    where r.owner_id = uid and r.session_id = p_session_id and r.idempotency_key = p_idempotency_key;
  if found then
    if existing.conversation_id is distinct from p_conversation_id then
      raise exception 'CLOUD_CONFLICT' using errcode = '23505';
    end if;
    return public.coaching_submit_run_guarded(p_run_id,p_session_id,p_idempotency_key,p_prompt,
      p_backend_id,p_runtime_id,p_snapshot_id,p_snapshot_source,p_request);
  end if;
  if exists (select 1 from public.coaching_runs r where r.owner_id=uid
      and r.conversation_id=p_conversation_id
      and r.status not in ('completed','failed','cancelled')) then
    raise exception 'CLOUD_CONFLICT' using errcode = '23505';
  end if;
  -- Reserve room for the user and assistant messages, including under concurrent submits.
  if (select count(*) from public.coaching_conversation_messages m
      where m.owner_id=uid and m.conversation_id=p_conversation_id) > 198 then
    raise exception 'CLOUD_INVALID' using errcode = '22023';
  end if;
  -- Only completed turns enter context. Both the number of messages and total
  -- bytes are bounded before the context is frozen on the run.
  with completed as (
    select u.id as user_id, a.id as assistant_id, a.created_at,
      octet_length(jsonb_build_object('role','user','content',u.content)::text)
      + octet_length(jsonb_build_object('role','assistant','content',a.content)::text) + 4 as bytes
    from public.coaching_conversation_messages u
    join public.coaching_conversation_messages a
      on a.owner_id=u.owner_id and a.conversation_id=u.conversation_id
      and a.id='a_' || substr(u.id,3) and a.role='assistant'
    where u.owner_id=uid and u.conversation_id=p_conversation_id and u.role='user'
      and u.id like 'u_%'
  ), bounded as (
    select *, row_number() over (order by created_at desc, assistant_id desc) n,
      sum(bytes) over (order by created_at desc, assistant_id desc) total_bytes
    from completed
  )
  select coalesce(jsonb_agg(jsonb_build_object('role',m.role,'content',m.content)
           order by b.created_at,b.assistant_id, case m.role when 'user' then 0 else 1 end), '[]'::jsonb)
    into ctx
  from bounded b join public.coaching_conversation_messages m
    on m.owner_id=uid and m.conversation_id=p_conversation_id
      and m.id in (b.user_id,b.assistant_id)
  where b.n <= 10 and b.total_bytes <= 16000;
  result := public.coaching_submit_run_guarded(p_run_id,p_session_id,p_idempotency_key,p_prompt,
      p_backend_id,p_runtime_id,p_snapshot_id,p_snapshot_source,p_request);
  run_id := result -> 'run' ->> 'id';
  if (result ->> 'replayed')::boolean then
    select * into existing from public.coaching_runs where id=run_id;
    if existing.conversation_id is distinct from p_conversation_id then
      raise exception 'CLOUD_CONFLICT' using errcode = '23505';
    end if;
    return result;
  end if;
  update public.coaching_runs set conversation_id=p_conversation_id, conversation_context=ctx
    where id=run_id and owner_id=uid;
  insert into public.coaching_conversation_messages(owner_id,conversation_id,id,role,content)
    values(uid,p_conversation_id,'u_' || md5(run_id),'user',p_prompt);
  update public.coaching_conversations set updated_at=clock_timestamp()
    where owner_id=uid and id=p_conversation_id;
  select * into existing from public.coaching_runs where id=run_id;
  return jsonb_set(result, '{run}', public.coaching_run_json(existing));
end $$;

create function public.coaching_find_run(
  p_session_id text,p_idempotency_key text,p_prompt text,p_snapshot_id text,
  p_snapshot_source text,p_conversation_id text
) returns jsonb language plpgsql stable security definer set search_path = public, auth as $$
declare uid uuid := public.coaching_assert_formal_account(); result jsonb; existing public.coaching_runs%rowtype;
begin
  result := public.coaching_find_run_guarded(p_session_id,p_idempotency_key,p_prompt,p_snapshot_id,p_snapshot_source);
  if result is null then return null; end if;
  select * into existing from public.coaching_runs r where r.id=result -> 'run' ->> 'id' and r.owner_id=uid;
  if existing.conversation_id is distinct from p_conversation_id then
    raise exception 'CLOUD_CONFLICT' using errcode = '23505';
  end if;
  return result;
end $$;
revoke all on function public.coaching_submit_run(text,text,text,text,text,text,text,text,jsonb,text) from public,anon;
revoke all on function public.coaching_find_run(text,text,text,text,text,text) from public,anon;
grant execute on function public.coaching_submit_run(text,text,text,text,text,text,text,text,jsonb,text) to authenticated;
grant execute on function public.coaching_find_run(text,text,text,text,text,text) to authenticated;

-- The successful terminal transition and assistant message are committed
-- together, so a browser disconnect cannot lose a completed answer.
create function public.coaching_save_completed_answer() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare answer text;
begin
  if new.conversation_id is null or new.status <> 'completed' or old.status = 'completed' then return new; end if;
  select string_agg(e.payload -> 'event' ->> 'delta', '' order by e.seq) into answer
    from public.coaching_run_events e
    where e.run_id=new.id and e.payload -> 'event' ->> 'type'='text_delta';
  if coalesce(answer,'') = '' then return new; end if;
  -- Keep UTF-8 intact and mark a truncated answer explicitly.
  if octet_length(answer) > 32768 then
    answer := left(answer, 32000);
    while octet_length(answer) > 32700 loop answer := left(answer, length(answer)-100); end loop;
    answer := answer || E'\n…';
  end if;
  insert into public.coaching_conversation_messages(owner_id,conversation_id,id,role,content)
    values(new.owner_id,new.conversation_id,'a_' || md5(new.id),'assistant',answer)
    on conflict (owner_id,conversation_id,id) do nothing;
  update public.coaching_conversations set updated_at=clock_timestamp()
    where owner_id=new.owner_id and id=new.conversation_id;
  return new;
end $$;
revoke all on function public.coaching_save_completed_answer() from public,anon,authenticated;
create trigger coaching_completed_answer after update of status on public.coaching_runs
  for each row execute function public.coaching_save_completed_answer();
