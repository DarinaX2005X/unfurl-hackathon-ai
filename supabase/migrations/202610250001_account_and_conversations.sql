-- Apply only to the explicitly selected development project first.
-- This application schema is deliberately absent from Supabase Data API schemas.
create schema if not exists unfurl;
revoke all on schema unfurl from public, anon;
grant usage on schema unfurl to authenticated, service_role;
alter default privileges in schema unfurl revoke all on tables from public, anon, authenticated;
alter default privileges in schema unfurl grant all on tables to service_role;

create table unfurl.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or (length(btrim(display_name)) between 1 and 80)),
  default_content_language text check (default_content_language is null or length(default_content_language) between 2 and 64),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table unfurl.conversations (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  active_branch_id uuid not null,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index conversations_owner_updated on unfurl.conversations(owner_id, updated_at desc, id desc) where deleted_at is null;

create table unfurl.conversation_branches (
  id uuid primary key,
  conversation_id uuid not null references unfurl.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (conversation_id, id)
);
alter table unfurl.conversations add constraint conversation_active_branch
  foreign key (id, active_branch_id) references unfurl.conversation_branches(conversation_id, id)
  deferrable initially deferred;

create table unfurl.messages (
  id uuid primary key,
  conversation_id uuid not null references unfurl.conversations(id) on delete cascade,
  branch_id uuid not null,
  parent_message_id uuid,
  role text not null check (role in ('user', 'assistant')),
  status text not null check (status in ('complete', 'streaming', 'interrupted', 'failed')),
  parts jsonb not null check (jsonb_typeof(parts) = 'array'),
  client_request_id uuid,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, branch_id) references unfurl.conversation_branches(conversation_id, id),
  unique (conversation_id, id),
  unique (conversation_id, client_request_id),
  foreign key (conversation_id, parent_message_id) references unfurl.messages(conversation_id, id),
  check (role <> 'user' or client_request_id is not null)
);
create index messages_branch_created on unfurl.messages(conversation_id, branch_id, created_at, id);

create function unfurl.valid_pending_messages(value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) <> 'array' then false else
    jsonb_array_length(value) <= 100 and not exists (
      select 1 from jsonb_array_elements(value) item where
        jsonb_typeof(item) <> 'object'
        or not (item ?& array['messageId', 'requestId', 'text'])
        or (item - array['messageId', 'requestId', 'text', 'userLocale']) <> '{}'::jsonb
        or jsonb_typeof(item->'messageId') <> 'string'
        or (item->>'messageId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(item->'requestId') <> 'string'
        or (item->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(item->'text') <> 'string'
        or length(btrim(item->>'text')) < 1 or length(item->>'text') > 20000
        or (item ? 'userLocale' and (jsonb_typeof(item->'userLocale') <> 'string' or length(item->>'userLocale') not between 2 and 64))
    )
    and (select count(*) = count(distinct item->>'messageId') and count(*) = count(distinct item->>'requestId') from jsonb_array_elements(value) item)
  end;
$$;
revoke all on function unfurl.valid_pending_messages(jsonb) from public;
grant execute on function unfurl.valid_pending_messages(jsonb) to authenticated, service_role;

create table unfurl.composer_drafts (
  conversation_id uuid primary key references unfurl.conversations(id) on delete cascade,
  text text not null default '' check (length(text) <= 20000),
  pending_messages jsonb not null default '[]'::jsonb check (unfurl.valid_pending_messages(pending_messages)),
  revision integer not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now(),
  check (octet_length(convert_to(text || pending_messages::text, 'UTF8')) <= 2000000)
);

create table unfurl.local_imports (
  actor_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  conversation_id uuid not null references unfurl.conversations(id) on delete restrict,
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (actor_id, source_id)
);

create table unfurl.idempotency (
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (operation ~ '^[a-z][a-z0-9_.:-]{1,100}$'),
  key uuid not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  response_status integer check (response_status in (200, 201, 202, 204)),
  response_data jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (actor_id, operation, key),
  check ((response_status is null and completed_at is null) or (response_status is not null and completed_at is not null))
);

alter table unfurl.profiles enable row level security;
alter table unfurl.profiles force row level security;
alter table unfurl.conversations enable row level security;
alter table unfurl.conversations force row level security;
alter table unfurl.conversation_branches enable row level security;
alter table unfurl.conversation_branches force row level security;
alter table unfurl.messages enable row level security;
alter table unfurl.messages force row level security;
alter table unfurl.composer_drafts enable row level security;
alter table unfurl.composer_drafts force row level security;
alter table unfurl.local_imports enable row level security;
alter table unfurl.local_imports force row level security;
alter table unfurl.idempotency enable row level security;
alter table unfurl.idempotency force row level security;

create policy profile_owner on unfurl.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy conversation_owner on unfurl.conversations for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy branch_owner on unfurl.conversation_branches for all to authenticated
  using (exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())))
  with check (exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())));
create policy message_owner_read on unfurl.messages for select to authenticated
  using (exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())));
create policy message_owner_insert on unfurl.messages for insert to authenticated
  with check (role = 'user' and status = 'complete' and exists (
    select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid()) and c.deleted_at is null
  ));
create policy composer_owner on unfurl.composer_drafts for all to authenticated
  using (exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())))
  with check (exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid()) and c.deleted_at is null));
create policy local_import_owner on unfurl.local_imports for all to authenticated
  using (actor_id = (select auth.uid())) with check (
    actor_id = (select auth.uid()) and exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid()))
  );
create policy idempotency_owner on unfurl.idempotency for all to authenticated
  using (actor_id = (select auth.uid())) with check (actor_id = (select auth.uid()));

grant select, insert, update on unfurl.profiles, unfurl.conversations, unfurl.composer_drafts, unfurl.idempotency to authenticated;
grant select, insert on unfurl.conversation_branches, unfurl.messages to authenticated;
grant select, insert, update on unfurl.local_imports to authenticated;
grant all on all tables in schema unfurl to service_role;
