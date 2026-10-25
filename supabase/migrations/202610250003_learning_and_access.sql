create table unfurl.lessons (
  id uuid primary key,
  course_version_id uuid not null references unfurl.course_versions(id) on delete cascade,
  module_id uuid not null,
  title text not null check (length(btrim(title)) > 0),
  outcome_ids uuid[] not null check (cardinality(outcome_ids) > 0),
  blocks jsonb not null check (jsonb_typeof(blocks) = 'array'),
  task_ids uuid[] not null default '{}',
  unique (id, course_version_id)
);

create table unfurl.tasks_public (
  id uuid not null,
  task_version integer not null check (task_version >= 1),
  course_version_id uuid not null references unfurl.course_versions(id) on delete cascade,
  mechanic_id text not null,
  mechanic_version integer not null check (mechanic_version >= 1),
  outcome_ids uuid[] not null check (cardinality(outcome_ids) > 0),
  instruction text not null check (length(btrim(instruction)) between 1 and 20000),
  content_language text not null check (length(content_language) between 2 and 64),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  available_hints integer not null check (available_hints >= 0),
  response_schema_version integer not null check (response_schema_version >= 1),
  primary key (id, task_version),
  unique (id, course_version_id),
  unique (id, task_version, course_version_id)
);
create table unfurl.task_validation_receipts (
  id uuid primary key,
  task_id uuid not null,
  task_version integer not null,
  verdict text not null check (verdict in ('passed', 'failed')),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (task_id, task_version) references unfurl.tasks_public(id, task_version) on delete cascade,
  unique (id, task_id, task_version)
);
create table unfurl.tasks_private (
  task_id uuid not null,
  task_version integer not null,
  evaluation_spec jsonb not null check (jsonb_typeof(evaluation_spec) = 'object'),
  source_claim_ids uuid[] not null default '{}',
  validation_receipt_id uuid not null,
  hints jsonb not null default '[]'::jsonb check (jsonb_typeof(hints) = 'array'),
  worked_example jsonb,
  primary key (task_id, task_version),
  foreign key (task_id, task_version) references unfurl.tasks_public(id, task_version) on delete cascade,
  foreign key (validation_receipt_id, task_id, task_version) references unfurl.task_validation_receipts(id, task_id, task_version)
);

create table unfurl.enrollments (
  id uuid primary key,
  learner_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references unfurl.courses(id) on delete restrict,
  course_version_id uuid not null,
  status text not null default 'active' check (status in ('active', 'completed', 'archived')),
  route_revision integer not null default 1 check (route_revision >= 1),
  current_lesson_id uuid,
  current_task_id uuid,
  created_at timestamptz not null default now(),
  last_studied_at timestamptz,
  foreign key (course_version_id, course_id) references unfurl.course_versions(id, course_id) on delete restrict,
  foreign key (current_lesson_id, course_version_id) references unfurl.lessons(id, course_version_id),
  foreign key (current_task_id, course_version_id) references unfurl.tasks_public(id, course_version_id),
  unique (learner_id, course_version_id),
  unique (id, learner_id, course_version_id)
);
create index enrollment_learner_recent on unfurl.enrollments(learner_id, last_studied_at desc nulls last, id desc);

create table unfurl.personal_routes (
  enrollment_id uuid primary key references unfurl.enrollments(id) on delete cascade,
  revision integer not null check (revision >= 1),
  policy_version text not null,
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  updated_at timestamptz not null default now()
);
create table unfurl.attempts (
  id uuid primary key,
  learner_id uuid not null,
  enrollment_id uuid not null,
  course_version_id uuid not null,
  task_id uuid not null,
  task_version integer not null,
  client_attempt_id uuid not null,
  idempotency_key uuid not null,
  response jsonb not null,
  assistance text not null check (assistance in ('independent', 'hinted', 'worked_example')),
  hint_ids_used uuid[] not null default '{}',
  submitted_at timestamptz not null default now(),
  foreign key (enrollment_id, learner_id, course_version_id) references unfurl.enrollments(id, learner_id, course_version_id) on delete cascade,
  foreign key (task_id, task_version, course_version_id) references unfurl.tasks_public(id, task_version, course_version_id),
  unique (learner_id, client_attempt_id)
);
create index attempts_enrollment on unfurl.attempts(enrollment_id, submitted_at desc, id desc);
create table unfurl.evaluations (
  id uuid primary key,
  attempt_id uuid not null unique references unfurl.attempts(id) on delete cascade,
  status text not null check (status in ('evaluated', 'uncertain', 'pending', 'unavailable')),
  outcome text check (outcome in ('correct', 'partial', 'incorrect')),
  dimensions jsonb not null default '[]'::jsonb check (jsonb_typeof(dimensions) = 'array'),
  feedback jsonb not null check (jsonb_typeof(feedback) = 'object'),
  awarded_xp integer not null default 0 check (awarded_xp >= 0),
  revision integer not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now(),
  check ((status = 'evaluated' and outcome is not null) or (status <> 'evaluated' and outcome is null and awarded_xp = 0))
);
create table unfurl.learner_evidence (
  id uuid primary key,
  enrollment_id uuid not null references unfurl.enrollments(id) on delete cascade,
  outcome_id uuid not null,
  source jsonb not null check (jsonb_typeof(source) = 'object'),
  observation text not null check (observation in ('independent_success', 'assisted_success', 'incorrect', 'partial', 'uncertain', 'self_reported')),
  dimension_ids text[] not null default '{}',
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  recorded_at timestamptz not null default now(),
  unique (id, enrollment_id)
);
create table unfurl.hint_usage (
  id uuid primary key,
  enrollment_id uuid not null references unfurl.enrollments(id) on delete cascade,
  task_id uuid not null,
  task_version integer not null,
  kind text not null check (kind in ('hint', 'worked_example')),
  hint_index integer check (hint_index >= 0),
  created_at timestamptz not null default now(),
  foreign key (task_id, task_version) references unfurl.tasks_public(id, task_version),
  check ((kind = 'hint' and hint_index is not null) or (kind = 'worked_example' and hint_index is null)),
  unique nulls not distinct (enrollment_id, task_id, task_version, kind, hint_index)
);
create table unfurl.xp_awards (
  id uuid primary key,
  learner_id uuid not null references auth.users(id) on delete cascade,
  qualifying_evidence_id uuid not null references unfurl.learner_evidence(id) on delete restrict,
  policy_version text not null,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  -- Policy version is audit metadata, not permission to reward the same evidence twice.
  unique (learner_id, qualifying_evidence_id)
);

create table unfurl.share_grants (
  id uuid primary key,
  course_id uuid not null references unfurl.courses(id) on delete cascade,
  course_version_id uuid not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (course_version_id, course_id) references unfurl.course_versions(id, course_id) on delete cascade
);

create table unfurl.activity_sessions (
  id uuid primary key,
  enrollment_id uuid not null references unfurl.enrollments(id) on delete cascade,
  task_id uuid not null,
  task_version integer not null,
  hidden_state jsonb not null,
  turn_budget integer not null check (turn_budget between 1 and 100),
  turns_used integer not null default 0 check (turns_used >= 0),
  status text not null check (status in ('active', 'completed', 'exhausted')),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (task_id, task_version) references unfurl.tasks_public(id, task_version),
  check (turns_used <= turn_budget)
);
create table unfurl.activity_turns (
  id uuid primary key,
  activity_session_id uuid not null references unfurl.activity_sessions(id) on delete cascade,
  client_turn_id uuid not null,
  user_text text not null check (length(btrim(user_text)) between 1 and 20000),
  partner_result jsonb,
  created_at timestamptz not null default now(),
  unique (activity_session_id, client_turn_id)
);

create function unfurl.validate_ready_version() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.state = 'ready' then
    if not exists (select 1 from unfurl.version_validation_receipts v where v.id = new.validation_receipt_id and v.course_version_id = new.id and v.verdict = 'passed') then
      raise exception 'A ready version needs successful validation' using errcode = '23514';
    end if;
    if (select count(*) from unfurl.lessons l where l.id = any(new.lesson_ids) and l.course_version_id = new.id) <> cardinality(new.lesson_ids) then
      raise exception 'A ready version must reference its saved lessons' using errcode = '23514';
    end if;
    if not exists (select 1 from unfurl.generation_runs r where r.id = new.source_run_id and r.status = 'succeeded' and r.output_version_id = new.id and r.course_id = new.course_id) then
      raise exception 'A ready version needs its completed generation job' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create constraint trigger ready_version_validated after insert or update on unfurl.course_versions
  deferrable initially deferred for each row execute function unfurl.validate_ready_version();
revoke all on function unfurl.validate_ready_version() from public;

do $$ declare table_name text; begin
  foreach table_name in array array['lessons','tasks_public','task_validation_receipts','tasks_private','enrollments','personal_routes',
    'attempts','evaluations','learner_evidence','hint_usage','xp_awards','share_grants','activity_sessions','activity_turns'] loop
    execute format('alter table unfurl.%I enable row level security', table_name);
    execute format('alter table unfurl.%I force row level security', table_name);
  end loop;
end $$;

create policy enrollment_learner on unfurl.enrollments for select to authenticated
  using (learner_id = (select auth.uid()));
create policy route_learner on unfurl.personal_routes for select to authenticated
  using (exists (select 1 from unfurl.enrollments e where e.id = enrollment_id and e.learner_id = (select auth.uid())));
create policy attempt_learner on unfurl.attempts for select to authenticated
  using (learner_id = (select auth.uid()));
create policy evaluation_learner on unfurl.evaluations for select to authenticated
  using (exists (select 1 from unfurl.attempts a where a.id = attempt_id and a.learner_id = (select auth.uid())));
create policy evidence_learner on unfurl.learner_evidence for select to authenticated
  using (exists (select 1 from unfurl.enrollments e where e.id = enrollment_id and e.learner_id = (select auth.uid())));
create policy hint_learner on unfurl.hint_usage for select to authenticated
  using (exists (select 1 from unfurl.enrollments e where e.id = enrollment_id and e.learner_id = (select auth.uid())));
create policy xp_learner on unfurl.xp_awards for select to authenticated
  using (learner_id = (select auth.uid()));
create policy lesson_access on unfurl.lessons for select to authenticated using (
  exists (select 1 from unfurl.enrollments e where e.course_version_id = lessons.course_version_id and e.learner_id = (select auth.uid()))
  or exists (select 1 from unfurl.course_versions v join unfurl.courses c on c.id = v.course_id where v.id = lessons.course_version_id and c.owner_id = (select auth.uid()))
);
create policy task_access on unfurl.tasks_public for select to authenticated using (
  exists (select 1 from unfurl.enrollments e where e.course_version_id = tasks_public.course_version_id and e.learner_id = (select auth.uid()))
  or exists (select 1 from unfurl.course_versions v join unfurl.courses c on c.id = v.course_id where v.id = tasks_public.course_version_id and c.owner_id = (select auth.uid()))
);
create policy version_enrollment_access on unfurl.course_versions for select to authenticated
  using (exists (select 1 from unfurl.enrollments e where e.course_version_id = course_versions.id and e.learner_id = (select auth.uid())));
create policy course_enrollment_access on unfurl.courses for select to authenticated
  using (exists (select 1 from unfurl.enrollments e where e.course_id = courses.id and e.learner_id = (select auth.uid())));

-- Public/share access is a server projection with explicit ready/access predicates.
-- No public role or authenticated learner gets evaluator keys, hidden activity state,
-- validation internals, token hashes, or the durable execution tables.
grant select on unfurl.lessons, unfurl.tasks_public, unfurl.enrollments, unfurl.personal_routes,
  unfurl.attempts, unfurl.evaluations, unfurl.learner_evidence, unfurl.hint_usage, unfurl.xp_awards to authenticated;
grant all on all tables in schema unfurl to service_role;
