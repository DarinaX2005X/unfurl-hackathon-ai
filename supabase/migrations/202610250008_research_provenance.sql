-- Immutable research provenance shared by runtime recovery and course research.
-- Provider/network work remains outside database transactions.

create table unfurl.research_source_documents (
  id uuid primary key,
  requested_url text not null check (length(requested_url) between 1 and 4096 and requested_url ~ '^https?://'),
  final_url text not null check (length(final_url) between 1 and 4096 and final_url ~ '^https?://'),
  title text not null check (length(btrim(title)) between 1 and 1000),
  retrieved_at timestamptz not null,
  published_at timestamptz,
  media_type text not null check (media_type in ('text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json')),
  raw_digest text not null check (raw_digest ~ '^[a-f0-9]{64}$'),
  extractor_version text not null check (length(extractor_version) between 1 and 80),
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  blocks jsonb not null check (
    jsonb_typeof(blocks) = 'array' and jsonb_array_length(blocks) between 1 and 512
    and octet_length(blocks::text) <= 2097152
  ),
  extraction_state text not null check (extraction_state in ('complete', 'truncated'))
);

create table unfurl.research_passages (
  id uuid primary key,
  source_id uuid not null references unfurl.research_source_documents(id) on delete restrict,
  block_id text not null check (length(block_id) between 1 and 80),
  start_utf16 integer not null check (start_utf16 >= 0),
  end_utf16 integer not null,
  quote text not null check (length(quote) between 1 and 20000),
  unique (source_id, block_id, start_utf16, end_utf16),
  check (end_utf16 > start_utf16)
);
create index research_passages_source on unfurl.research_passages(source_id, block_id, start_utf16, id);

create table unfurl.research_searches (
  id uuid primary key,
  operation_id uuid not null unique references unfurl.ai_provider_operations(id) on delete restrict,
  requested_query text not null check (length(btrim(requested_query)) between 1 and 2000),
  executed_query text check (executed_query is null or length(btrim(executed_query)) between 1 and 2000),
  content_language text not null check (length(content_language) between 2 and 64),
  retrieved_at timestamptz not null,
  hits jsonb not null check (jsonb_typeof(hits) = 'array' and jsonb_array_length(hits) <= 5 and octet_length(hits::text) <= 131072),
  limitations jsonb not null check (jsonb_typeof(limitations) = 'array' and jsonb_array_length(limitations) <= 16 and octet_length(limitations::text) <= 16384),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  provider_request_id text not null check (length(provider_request_id) between 1 and 256)
);

create function unfurl.validate_research_search_operation() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from unfurl.ai_provider_operations operation
    where operation.id = new.operation_id
      and operation.purpose in ('web_search', 'capability_probe')
      and operation.state in ('unknown', 'settled')
  ) then
    raise exception 'Research search requires an accounted search operation' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger research_search_operation before insert on unfurl.research_searches
  for each row execute function unfurl.validate_research_search_operation();

-- Course research claims bind globally stored passages to an owned research run.
create table unfurl.source_claims (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  run_step_id uuid references unfurl.run_steps(id) on delete restrict,
  text text not null check (length(btrim(text)) between 1 and 20000),
  passage_ids uuid[] not null check (cardinality(passage_ids) between 1 and 64),
  outcome_ids uuid[] not null default '{}' check (cardinality(outcome_ids) <= 24),
  scope jsonb not null check (jsonb_typeof(scope) = 'object' and octet_length(scope::text) <= 65536),
  support text not null check (support in ('direct', 'inferred')),
  unresolved_conflicts jsonb not null default '[]' check (
    jsonb_typeof(unresolved_conflicts) = 'array' and jsonb_array_length(unresolved_conflicts) <= 32
    and octet_length(unresolved_conflicts::text) <= 65536
  ),
  created_at timestamptz not null default now()
);
create index source_claims_owner on unfurl.source_claims(owner_id, created_at, id);

create function unfurl.validate_source_claim_passages() returns trigger language plpgsql set search_path = '' as $$
declare passage_count integer;
begin
  if cardinality(new.passage_ids) <> (select count(distinct value) from unnest(new.passage_ids) value) then
    raise exception 'Claim passage identities must be unique' using errcode = '23514';
  end if;
  select count(*) into passage_count from unfurl.research_passages passage where passage.id = any(new.passage_ids);
  if passage_count <> cardinality(new.passage_ids) then
    raise exception 'Claim passages must exist' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger source_claim_passages before insert on unfurl.source_claims
  for each row execute function unfurl.validate_source_claim_passages();

create table unfurl.curriculum_revision_evidence (
  draft_id uuid not null,
  revision integer not null check (revision >= 1),
  document jsonb not null check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 2097152),
  created_at timestamptz not null default now(),
  primary key (draft_id, revision),
  foreign key (draft_id, revision) references unfurl.curriculum_revisions(draft_id, revision) on delete restrict
);

-- A language regeneration is an explicit trusted intent, not manufactured chat text.
create table unfurl.course_language_revision_intents (
  run_id uuid primary key references unfurl.agent_turn_runs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete restrict,
  course_id uuid not null references unfurl.courses(id) on delete restrict,
  expected_course_revision integer not null check (expected_course_revision >= 1),
  draft_id uuid not null,
  expected_draft_revision integer not null check (expected_draft_revision >= 1),
  target_language text not null check (length(target_language) between 2 and 64),
  created_at timestamptz not null default now(),
  foreign key (draft_id, course_id) references unfurl.curriculum_drafts(id, course_id) on delete restrict
);

create function unfurl.validate_language_revision_intent() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from unfurl.agent_turn_runs run where run.id = new.run_id and run.owner_id = new.owner_id)
    or not exists (select 1 from unfurl.courses course where course.id = new.course_id and course.owner_id = new.owner_id)
    or not exists (select 1 from unfurl.curriculum_drafts draft where draft.id = new.draft_id and draft.course_id = new.course_id and draft.revision = new.expected_draft_revision) then
    raise exception 'Language revision intent identities do not agree' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger language_revision_intent_identity before insert on unfurl.course_language_revision_intents
  for each row execute function unfurl.validate_language_revision_intent();

-- Approval snapshots and their researched revisions cannot be rewritten in place.
create trigger curriculum_revision_no_update before update on unfurl.curriculum_revisions
  for each row execute function unfurl.reject_immutable_change();
create trigger curriculum_approval_no_update before update on unfurl.curriculum_approvals
  for each row execute function unfurl.reject_immutable_change();
create unique index one_initial_generation_per_approval on unfurl.generation_runs(approval_id)
  where approval_id is not null and retry_of_run_id is null;
alter table unfurl.course_versions add constraint one_staging_version_per_approval unique (approval_id);

do $$ declare table_name text; begin
  foreach table_name in array array['research_source_documents', 'research_passages', 'research_searches', 'source_claims',
    'curriculum_revision_evidence', 'course_language_revision_intents'] loop
    execute format('alter table unfurl.%I enable row level security', table_name);
    execute format('alter table unfurl.%I force row level security', table_name);
    execute format('revoke all on unfurl.%I from public, anon, authenticated', table_name);
    execute format('grant all on unfurl.%I to service_role', table_name);
    execute format('create trigger %I before update or delete on unfurl.%I for each row execute function unfurl.reject_immutable_change()', table_name || '_immutable', table_name);
  end loop;
end $$;

revoke all on function unfurl.validate_research_search_operation(), unfurl.validate_source_claim_passages(),
  unfurl.validate_language_revision_intent() from public;
