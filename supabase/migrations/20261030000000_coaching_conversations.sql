-- Conversation history is independent of the short-lived run/event retention.
create table public.coaching_conversations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, id)
);
create table public.coaching_conversation_messages (
  owner_id uuid not null,
  conversation_id text not null,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (octet_length(content) between 1 and 32768),
  created_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, conversation_id, id),
  foreign key (owner_id, conversation_id) references public.coaching_conversations(owner_id,id) on delete cascade
);
alter table public.coaching_conversations enable row level security;
alter table public.coaching_conversation_messages enable row level security;
revoke all on public.coaching_conversations, public.coaching_conversation_messages from public, anon, authenticated;

create function public.coaching_conversation_json(c public.coaching_conversations) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', c.id, 'createdAt', c.created_at, 'updatedAt', c.updated_at)
$$;
create function public.coaching_message_json(m public.coaching_conversation_messages) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', m.id, 'role', m.role, 'content', m.content, 'createdAt', m.created_at)
$$;
revoke all on function public.coaching_conversation_json(public.coaching_conversations) from public, anon, authenticated;
revoke all on function public.coaching_message_json(public.coaching_conversation_messages) from public, anon, authenticated;

create function public.coaching_list_conversations() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := public.coaching_assert_formal_account(); result jsonb;
begin
  select coalesce(jsonb_agg(public.coaching_conversation_json(c) order by c.updated_at desc, c.id), '[]'::jsonb)
  into result from (select * from public.coaching_conversations where owner_id=uid order by updated_at desc,id limit 100) c;
  return jsonb_build_object('conversations', result);
end $$;
create function public.coaching_create_conversation(p_id text) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := public.coaching_assert_formal_account(); c public.coaching_conversations%rowtype;
begin
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'CLOUD_INVALID'; end if;
  -- Serialize per-account creation to enforce a hard list bound under concurrency.
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  select * into c from public.coaching_conversations where owner_id=uid and id=p_id;
  if not found then
    if (select count(*) from public.coaching_conversations where owner_id=uid) >= 100 then raise exception 'CLOUD_INVALID conversation limit'; end if;
    insert into public.coaching_conversations(owner_id,id) values(uid,p_id) returning * into c;
  end if;
  return public.coaching_conversation_json(c);
end $$;
create function public.coaching_read_conversation(p_id text) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := public.coaching_assert_formal_account(); c public.coaching_conversations%rowtype; messages jsonb;
begin
  select * into c from public.coaching_conversations where owner_id=uid and id=p_id;
  if not found then raise exception 'CLOUD_CONVERSATION_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(public.coaching_message_json(m) order by m.created_at,m.id),'[]'::jsonb) into messages
    from public.coaching_conversation_messages m where m.owner_id=uid and m.conversation_id=p_id;
  return jsonb_build_object('conversation',public.coaching_conversation_json(c),'messages',messages);
end $$;
revoke all on function public.coaching_list_conversations(), public.coaching_create_conversation(text), public.coaching_read_conversation(text) from public, anon;
grant execute on function public.coaching_list_conversations(), public.coaching_create_conversation(text), public.coaching_read_conversation(text) to authenticated;
