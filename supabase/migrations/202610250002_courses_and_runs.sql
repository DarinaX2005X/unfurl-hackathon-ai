create table unfurl.courses (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  slug text not null unique check (length(slug) <= 160 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) between 1 and 120),
  summary text not null check (length(btrim(summary)) between 1 and 4000),
  content_language text not null check (length(content_language) between 2 and 64),
  visibility text not null default 'private' check (visibility in ('private', 'unlisted', 'public')),
  current_ready_version_id uuid,
  cover jsonb check (cover is null or jsonb_typeof(cover) = 'object'),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_ready_version_id is null or cover is not null)
);
create index courses_owner_updated on unfurl.courses(owner_id, updated_at desc, id desc);
create index courses_public_language on unfurl.courses(content_language, updated_at desc, id desc) where visibility = 'public';

create table unfurl.conversation_artifacts (
  conversation_id uuid not null references unfurl.conversations(id) on delete cascade,
  course_id uuid not null references unfurl.courses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, course_id)
);

create table unfurl.curriculum_drafts (
  id uuid primary key,
  course_id uuid not null references unfurl.courses(id) on delete cascade,
  conversation_id uuid not null references unfurl.conversations(id) on delete restrict,
  revision integer not null check (revision >= 1),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  approval_requested_revision integer check (approval_requested_revision >= 1),
  updated_at timestamptz not null default now(),
  unique (course_id),
  unique (id, course_id)
);

create table unfurl.curriculum_revisions (
  draft_id uuid not null references unfurl.curriculum_drafts(id) on delete cascade,
  revision integer not null check (revision >= 1),
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  created_at timestamptz not null default now(),
  primary key (draft_id, revision),
  unique (draft_id, revision, content_digest)
);

create table unfurl.curriculum_approvals (
  id uuid primary key,
  draft_id uuid not null,
  draft_revision integer not null,
  content_digest text not null,
  approved_by uuid not null references auth.users(id) on delete restrict,
  approved_at timestamptz not null default now(),
  foreign key (draft_id, draft_revision, content_digest) references unfurl.curriculum_revisions(draft_id, revision, content_digest),
  unique (draft_id, draft_revision, content_digest)
);

-- A conversational turn can finish without creating a course.
create table unfurl.agent_turn_runs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references unfurl.conversations(id) on delete cascade,
  branch_id uuid not null,
  input_message_id uuid not null,
  status text not null check (status in ('queued', 'running', 'awaiting_user', 'succeeded', 'failed', 'cancelled')),
  last_seq integer not null default 0 check (last_seq >= 0),
  error jsonb,
  retry_of_run_id uuid references unfurl.agent_turn_runs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, branch_id) references unfurl.conversation_branches(conversation_id, id),
  foreign key (conversation_id, input_message_id) references unfurl.messages(conversation_id, id),
  check (status <> 'failed' or error is not null),
  unique (id, branch_id)
);
create index turn_runs_owner_updated on unfurl.agent_turn_runs(owner_id, updated_at desc, id desc);
create unique index one_active_turn_per_branch on unfurl.agent_turn_runs(conversation_id, branch_id) where status in ('queued', 'running');

-- Course building is a separate job with its own approval and completed version.
create table unfurl.generation_runs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid references unfurl.courses(id) on delete cascade,
  conversation_id uuid not null references unfurl.conversations(id) on delete restrict,
  branch_id uuid not null,
  input_message_id uuid not null,
  source_draft_revision integer check (source_draft_revision >= 1),
  approval_id uuid references unfurl.curriculum_approvals(id),
  phase text not null check (phase in ('briefing', 'researching', 'outlining', 'awaiting_approval', 'module_research', 'building_tasks', 'validating')),
  status text not null check (status in ('queued', 'running', 'awaiting_user', 'succeeded', 'failed', 'cancelled')),
  last_seq integer not null default 0 check (last_seq >= 0),
  output_version_id uuid,
  error jsonb,
  retry_of_run_id uuid references unfurl.generation_runs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, branch_id) references unfurl.conversation_branches(conversation_id, id),
  foreign key (conversation_id, input_message_id) references unfurl.messages(conversation_id, id),
  check ((status = 'succeeded' and course_id is not null and output_version_id is not null)
    or (status <> 'succeeded' and output_version_id is null)),
  check (status <> 'failed' or error is not null),
  unique (id, branch_id)
);
create index generation_runs_owner_updated on unfurl.generation_runs(owner_id, updated_at desc, id desc);

create table unfurl.course_versions (
  id uuid primary key,
  course_id uuid not null references unfurl.courses(id) on delete cascade,
  number integer not null check (number >= 1),
  approval_id uuid not null references unfurl.curriculum_approvals(id),
  source_run_id uuid not null references unfurl.generation_runs(id),
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('building', 'validating', 'ready', 'failed')),
  -- Public metadata is captured per version; editing a draft never relabels old lessons.
  title text not null check (length(btrim(title)) between 1 and 120),
  summary text not null check (length(btrim(summary)) between 1 and 4000),
  content_language text not null check (length(content_language) between 2 and 64),
  assumed_knowledge jsonb not null default '[]'::jsonb check (jsonb_typeof(assumed_knowledge) = 'array'),
  outcomes jsonb not null check (jsonb_typeof(outcomes) = 'array' and jsonb_array_length(outcomes) > 0),
  modules jsonb not null check (jsonb_typeof(modules) = 'array' and jsonb_array_length(modules) > 0),
  lesson_ids uuid[] not null default '{}',
  validation_receipt_id uuid,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (course_id, number),
  unique (id, course_id),
  check ((state = 'ready' and ready_at is not null and cardinality(lesson_ids) > 0 and validation_receipt_id is not null)
    or (state <> 'ready' and ready_at is null))
);
alter table unfurl.courses add constraint course_ready_version foreign key (current_ready_version_id, id)
  references unfurl.course_versions(id, course_id) deferrable initially deferred;
alter table unfurl.generation_runs add constraint generation_output_version foreign key (output_version_id, course_id)
  references unfurl.course_versions(id, course_id) deferrable initially deferred;

create table unfurl.version_validation_receipts (
  id uuid primary key,
  course_version_id uuid not null references unfurl.course_versions(id) on delete cascade,
  verdict text not null check (verdict in ('passed', 'failed')),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  created_at timestamptz not null default now(),
  unique (id, course_version_id)
);
alter table unfurl.course_versions add constraint version_validation_receipt foreign key (validation_receipt_id, id)
  references unfurl.version_validation_receipts(id, course_version_id) deferrable initially deferred;

create table unfurl.agent_turn_events (
  id uuid primary key,
  run_id uuid not null,
  branch_id uuid not null,
  seq integer not null check (seq >= 1),
  type text not null,
  event jsonb not null check (jsonb_typeof(event) = 'object'),
  at timestamptz not null default now(),
  foreign key (run_id, branch_id) references unfurl.agent_turn_runs(id, branch_id) on delete cascade,
  unique (run_id, seq)
);
create table unfurl.generation_events (
  id uuid primary key,
  run_id uuid not null,
  branch_id uuid not null,
  seq integer not null check (seq >= 1),
  type text not null,
  event jsonb not null check (jsonb_typeof(event) = 'object'),
  at timestamptz not null default now(),
  foreign key (run_id, branch_id) references unfurl.generation_runs(id, branch_id) on delete cascade,
  unique (run_id, seq)
);

create table unfurl.execution_jobs (
  id uuid primary key,
  agent_turn_run_id uuid unique references unfurl.agent_turn_runs(id) on delete cascade,
  generation_run_id uuid unique references unfurl.generation_runs(id) on delete cascade,
  workflow_run_id text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(agent_turn_run_id, generation_run_id) = 1)
);
create table unfurl.run_steps (
  id uuid primary key,
  job_id uuid not null references unfurl.execution_jobs(id) on delete cascade,
  step_key text not null,
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  approval_digest text check (approval_digest is null or approval_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  result_reference jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, step_key, input_digest),
  check (status <> 'running' or (lease_owner is not null and lease_expires_at is not null)),
  check (status <> 'succeeded' or result_reference is not null)
);
create table unfurl.outbox (
  id uuid primary key,
  job_id uuid not null references unfurl.execution_jobs(id) on delete cascade,
  operation text not null check (operation in ('start', 'cancel', 'resume')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (job_id, operation)
);
create index outbox_pending on unfurl.outbox(available_at, id) where dispatched_at is null;

create function unfurl.reject_ready_version_changes() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.state = 'ready' and new is distinct from old then
    raise exception 'Ready course versions are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger ready_version_immutable before update on unfurl.course_versions
  for each row execute function unfurl.reject_ready_version_changes();

create function unfurl.check_ready_course_and_run() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'courses' then
    if new.current_ready_version_id is not null then
      if not exists (select 1 from unfurl.course_versions v where v.id = new.current_ready_version_id and v.course_id = new.id and v.state = 'ready') then
        raise exception 'The selected course version is not ready' using errcode = '23514';
      end if;
    end if;
  elsif tg_table_name = 'generation_runs' then
    if new.status = 'succeeded' then
      if not exists (select 1 from unfurl.course_versions v where v.id = new.output_version_id and v.course_id = new.course_id and v.source_run_id = new.id and v.state = 'ready') then
        raise exception 'Completed generation requires its saved ready version' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create constraint trigger course_ready_reference after insert or update on unfurl.courses
  deferrable initially deferred for each row execute function unfurl.check_ready_course_and_run();
create constraint trigger generation_ready_reference after insert or update on unfurl.generation_runs
  deferrable initially deferred for each row execute function unfurl.check_ready_course_and_run();

do $$ declare table_name text; begin
  foreach table_name in array array['courses','conversation_artifacts','curriculum_drafts','curriculum_revisions','curriculum_approvals',
    'agent_turn_runs','generation_runs','course_versions','version_validation_receipts','agent_turn_events','generation_events','execution_jobs','run_steps','outbox'] loop
    execute format('alter table unfurl.%I enable row level security', table_name);
    execute format('alter table unfurl.%I force row level security', table_name);
  end loop;
end $$;

create policy course_owner on unfurl.courses for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy artifact_owner on unfurl.conversation_artifacts for all to authenticated
  using (exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())))
  with check (
    exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid()))
    and exists (select 1 from unfurl.courses c where c.id = course_id and c.owner_id = (select auth.uid()))
  );
create policy curriculum_owner on unfurl.curriculum_drafts for all to authenticated
  using (exists (select 1 from unfurl.courses c where c.id = course_id and c.owner_id = (select auth.uid())))
  with check (
    exists (select 1 from unfurl.courses c where c.id = course_id and c.owner_id = (select auth.uid()))
    and exists (select 1 from unfurl.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid()))
  );
create policy curriculum_revision_owner on unfurl.curriculum_revisions for select to authenticated
  using (exists (select 1 from unfurl.curriculum_drafts d where d.id = draft_id));
create policy approval_owner on unfurl.curriculum_approvals for select to authenticated
  using (approved_by = (select auth.uid()));
create policy turn_owner on unfurl.agent_turn_runs for select to authenticated
  using (owner_id = (select auth.uid()));
create policy generation_owner on unfurl.generation_runs for select to authenticated
  using (owner_id = (select auth.uid()));
create policy version_owner on unfurl.course_versions for select to authenticated
  using (exists (select 1 from unfurl.courses c where c.id = course_id and c.owner_id = (select auth.uid())));
create policy turn_event_owner on unfurl.agent_turn_events for select to authenticated
  using (exists (select 1 from unfurl.agent_turn_runs r where r.id = run_id and r.owner_id = (select auth.uid())));
create policy generation_event_owner on unfurl.generation_events for select to authenticated
  using (exists (select 1 from unfurl.generation_runs r where r.id = run_id and r.owner_id = (select auth.uid())));

grant select, insert, update on unfurl.courses, unfurl.curriculum_drafts to authenticated;
grant select, insert on unfurl.conversation_artifacts to authenticated;
grant select on unfurl.curriculum_revisions, unfurl.curriculum_approvals, unfurl.agent_turn_runs,
  unfurl.generation_runs, unfurl.course_versions, unfurl.agent_turn_events, unfurl.generation_events to authenticated;
grant all on all tables in schema unfurl to service_role;
revoke all on function unfurl.reject_ready_version_changes(), unfurl.check_ready_course_and_run() from public;
