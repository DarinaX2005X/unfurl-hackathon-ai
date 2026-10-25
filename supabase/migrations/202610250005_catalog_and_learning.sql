-- Catalog publication, stable progression and authoritative learning activity.
-- This is additive to migrations 001-004 and invokes no external provider.

alter table unfurl.course_versions
  add column cover jsonb check (cover is null or (jsonb_typeof(cover) = 'object' and octet_length(cover::text) <= 65536));
alter table unfurl.courses
  add column published_version_id uuid,
  add constraint course_published_version foreign key (published_version_id, id)
    references unfurl.course_versions(id, course_id) deferrable initially deferred;
create index courses_published on unfurl.courses(published_version_id) where published_version_id is not null;

alter table unfurl.share_grants
  add column key_version integer not null default 1 check (key_version >= 1);

create function unfurl.check_published_course_version() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.published_version_id is not null and not exists (
    select 1 from unfurl.course_versions version
    where version.id = new.published_version_id and version.course_id = new.id
      and version.state = 'ready' and version.cover is not null
  ) then
    raise exception 'A published course needs an exact ready version with complete metadata' using errcode = '23514';
  end if;
  if new.visibility = 'public' and new.published_version_id is null then
    raise exception 'A public course needs a published version' using errcode = '23514';
  end if;
  return new;
end;
$$;
create constraint trigger course_published_reference after insert or update on unfurl.courses
  deferrable initially deferred for each row execute function unfurl.check_published_course_version();

-- Private task material follows the exact mechanics-owned TaskPrivate envelope.
alter table unfurl.tasks_private
  add column evaluator_data jsonb not null check (jsonb_typeof(evaluator_data) = 'object' and octet_length(evaluator_data::text) <= 131072),
  add column assessment jsonb not null check (jsonb_typeof(assessment) = 'object' and octet_length(assessment::text) <= 131072),
  alter column worked_example type text using case
    when worked_example is null then null
    when jsonb_typeof(worked_example) = 'string' then worked_example #>> '{}'
    else worked_example::text
  end,
  add constraint task_private_hints_bound check (
    jsonb_typeof(hints) = 'array' and jsonb_array_length(hints) <= 6
    and not jsonb_path_exists(hints, '$[*] ? (@.type() != "string" || @.size() > 4000)')
  ),
  add constraint task_private_worked_example_bound check (worked_example is null or length(worked_example) <= 12000);

-- A saved activity is unique per pinned enrollment and stable task version.
alter table unfurl.activity_sessions
  drop constraint activity_sessions_turn_budget_check,
  drop constraint activity_sessions_turns_used_check,
  drop constraint activity_sessions_status_check,
  drop constraint activity_sessions_check;
alter table unfurl.activity_sessions rename column turn_budget to action_budget;
alter table unfurl.activity_sessions rename column turns_used to actions_used;
alter table unfurl.activity_sessions
  add column input_revision integer not null default 0 check (input_revision >= 0),
  add constraint activity_session_action_budget check (action_budget between 0 and 6),
  add constraint activity_session_actions_used check (actions_used >= 0 and actions_used <= action_budget),
  add constraint activity_session_status check (status in ('active', 'completed', 'budget_exhausted')),
  add constraint activity_session_budget_state check (status <> 'budget_exhausted' or actions_used = action_budget),
  add constraint activity_session_task_unique unique (enrollment_id, task_id, task_version),
  add constraint activity_session_input_identity unique (id, input_revision),
  add constraint activity_session_attempt_identity unique (id, enrollment_id, task_id, task_version);

create table unfurl.activity_inputs (
  activity_session_id uuid not null references unfurl.activity_sessions(id) on delete cascade,
  input_revision integer not null check (input_revision >= 1),
  response_digest text not null check (response_digest ~ '^[a-f0-9]{64}$'),
  response jsonb not null check (octet_length(response::text) <= 131072),
  created_at timestamptz not null default now(),
  primary key (activity_session_id, input_revision),
  unique (activity_session_id, input_revision, response_digest)
);

create table unfurl.activity_actions (
  id uuid primary key,
  activity_session_id uuid not null references unfurl.activity_sessions(id) on delete cascade,
  client_action_id uuid not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  action jsonb not null check (jsonb_typeof(action) = 'object' and octet_length(action::text) <= 131072),
  input_revision integer not null check (input_revision >= 1),
  response_digest text not null check (response_digest ~ '^[a-f0-9]{64}$'),
  session_revision integer not null check (session_revision >= 1),
  completed_session_revision integer check (completed_session_revision >= session_revision),
  status text not null check (status in ('pending', 'completed', 'unavailable')),
  public_observation jsonb check (public_observation is null or (jsonb_typeof(public_observation) = 'object' and octet_length(public_observation::text) <= 131072)),
  private_execution jsonb check (private_execution is null or (jsonb_typeof(private_execution) = 'object' and octet_length(private_execution::text) <= 131072)),
  safe_error jsonb check (safe_error is null or (jsonb_typeof(safe_error) = 'object' and octet_length(safe_error::text) <= 16384)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (activity_session_id, input_revision, response_digest)
    references unfurl.activity_inputs(activity_session_id, input_revision, response_digest) on delete restrict,
  unique (activity_session_id, client_action_id),
  unique (activity_session_id, session_revision),
  check ((status = 'pending' and completed_session_revision is null and public_observation is null)
    or (status = 'completed' and completed_session_revision is not null)
    or (status = 'unavailable' and completed_session_revision is not null and public_observation is null))
);
create index activity_actions_pending on unfurl.activity_actions(status, updated_at, id) where status = 'pending';

create trigger activity_input_immutable before update or delete on unfurl.activity_inputs
  for each row execute function unfurl.reject_immutable_change();

-- Attempts freeze the exact activity and route revision used by evaluators.
alter table unfurl.attempts
  add column activity_session_id uuid not null,
  add column activity_input_revision integer not null check (activity_input_revision >= 1),
  add column response_digest text not null check (response_digest ~ '^[a-f0-9]{64}$'),
  add column request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  add column activity_snapshot jsonb not null check (jsonb_typeof(activity_snapshot) = 'object' and octet_length(activity_snapshot::text) <= 2097152),
  add column submitted_activity_revision integer not null check (submitted_activity_revision >= 1),
  add column submitted_route_revision integer not null check (submitted_route_revision >= 1),
  add constraint attempt_activity_identity foreign key (activity_session_id, enrollment_id, task_id, task_version)
    references unfurl.activity_sessions(id, enrollment_id, task_id, task_version) on delete restrict,
  add constraint attempt_input_identity foreign key (activity_session_id, activity_input_revision, response_digest)
    references unfurl.activity_inputs(activity_session_id, input_revision, response_digest) on delete restrict;

alter table unfurl.evaluations add constraint evaluation_attempt_identity unique (id, attempt_id);

create table unfurl.evaluation_revisions (
  evaluation_id uuid not null,
  attempt_id uuid not null,
  revision integer not null check (revision >= 1),
  status text not null check (status in ('evaluated', 'uncertain')),
  outcome text check (outcome in ('correct', 'partial', 'incorrect')),
  dimensions jsonb not null check (jsonb_typeof(dimensions) = 'array' and octet_length(dimensions::text) <= 131072),
  feedback jsonb not null check (jsonb_typeof(feedback) = 'object' and octet_length(feedback::text) <= 131072),
  awarded_xp integer not null default 0 check (awarded_xp in (0, 10, 25)),
  created_at timestamptz not null default now(),
  primary key (evaluation_id, revision),
  foreign key (evaluation_id, attempt_id) references unfurl.evaluations(id, attempt_id) on delete cascade,
  unique (attempt_id, revision),
  check ((status = 'evaluated' and outcome is not null) or (status = 'uncertain' and outcome is null and awarded_xp = 0))
);
create trigger evaluation_revision_immutable before update or delete on unfurl.evaluation_revisions
  for each row execute function unfurl.reject_immutable_change();

alter table unfurl.learner_evidence
  add column attempt_id uuid not null references unfurl.attempts(id) on delete cascade,
  add column evaluation_id uuid not null,
  add column evaluation_revision integer not null check (evaluation_revision >= 1),
  add column task_id uuid not null,
  add column task_version integer not null check (task_version >= 1),
  add column evidence_group_id uuid not null,
  add column assistance text not null check (assistance in ('independent', 'hinted', 'worked_example')),
  add column review_state text not null default 'confirmed' check (review_state in ('confirmed', 'contested', 'superseded')),
  add constraint evidence_evaluation_revision foreign key (evaluation_id, evaluation_revision)
    references unfurl.evaluation_revisions(evaluation_id, revision) on delete restrict,
  add constraint evidence_task_version foreign key (task_id, task_version)
    references unfurl.tasks_public(id, task_version) on delete restrict,
  add constraint evidence_attempt_revision_outcome unique (attempt_id, evaluation_revision, outcome_id);

alter table unfurl.xp_awards
  add column course_id uuid not null references unfurl.courses(id) on delete restrict,
  add column task_id uuid not null,
  add constraint xp_award_amount check (amount in (10, 25)),
  add constraint xp_award_stable_task unique (learner_id, course_id, task_id);

create table unfurl.xp_award_adjustments (
  id uuid primary key,
  award_id uuid not null references unfurl.xp_awards(id) on delete restrict,
  evaluation_id uuid not null references unfurl.evaluations(id) on delete restrict,
  evaluation_revision integer not null check (evaluation_revision >= 1),
  delta integer not null check (delta in (-25, -10, 10, 25)),
  reason text not null check (reason = 'evaluation_corrected'),
  created_at timestamptz not null default now(),
  foreign key (evaluation_id, evaluation_revision)
    references unfurl.evaluation_revisions(evaluation_id, revision) on delete restrict,
  unique (award_id, evaluation_revision)
);
create trigger xp_adjustment_immutable before update or delete on unfurl.xp_award_adjustments
  for each row execute function unfurl.reject_immutable_change();

create table unfurl.assessment_review_requests (
  id uuid primary key,
  attempt_id uuid not null,
  evaluation_id uuid not null,
  expected_evaluation_revision integer not null check (expected_evaluation_revision >= 1),
  reason text not null check (reason in ('valid_alternative', 'unclear_prompt', 'other')),
  comment text not null check (length(btrim(comment)) between 1 and 2000),
  status text not null check (status in ('queued', 'running', 'resolved', 'unavailable', 'superseded')),
  resolution text check (resolution in ('upheld', 'corrected', 'uncertain')),
  resolved_evaluation_revision integer check (resolved_evaluation_revision >= 1),
  execution_job_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (evaluation_id, attempt_id) references unfurl.evaluations(id, attempt_id) on delete cascade,
  unique (attempt_id, expected_evaluation_revision),
  check ((status = 'resolved' and resolution is not null and resolved_evaluation_revision is not null and resolved_at is not null)
    or (status <> 'resolved' and resolution is null and resolved_evaluation_revision is null and resolved_at is null))
);

create table unfurl.feedback_acknowledgements (
  attempt_id uuid not null,
  evaluation_revision integer not null check (evaluation_revision >= 1),
  acknowledged_at timestamptz not null default now(),
  primary key (attempt_id, evaluation_revision),
  foreign key (attempt_id, evaluation_revision)
    references unfurl.evaluation_revisions(attempt_id, revision) on delete restrict
);

alter table unfurl.enrollments add constraint enrollment_version_identity unique (id, course_version_id);

create table unfurl.support_offers (
  id uuid primary key,
  enrollment_id uuid not null,
  course_version_id uuid not null,
  policy_version text not null check (policy_version = 'adaptation-v1'),
  based_on_route_revision integer not null check (based_on_route_revision >= 1),
  target_outcome_id uuid not null,
  target_dimension_ids text[] not null check (cardinality(target_dimension_ids) between 1 and 24),
  trigger_kind text not null check (trigger_kind in ('auto', 'user_request')),
  reason_code text not null check (reason_code in ('explanation', 'diagnostic_clarification', 'additional_practice', 'prerequisite_support', 'challenge')),
  basis_evidence_ids uuid[] not null default '{}' check (cardinality(basis_evidence_ids) <= 6),
  basis_digest text not null check (basis_digest ~ '^[a-f0-9]{64}$'),
  auto_basis_key text check (auto_basis_key is null or auto_basis_key ~ '^[a-f0-9]{64}$'),
  explanation text not null check (length(btrim(explanation)) between 1 and 1000),
  explanation_lesson_id uuid,
  explanation_block_id uuid,
  estimated_study_minutes integer not null check (estimated_study_minutes between 1 and 8),
  return_lesson_id uuid not null,
  return_task_id uuid,
  completion_task_id uuid,
  completion_dimension_ids text[] not null default '{}',
  status text not null check (status in ('offered', 'accepted', 'declined', 'returned', 'completed', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (enrollment_id, course_version_id) references unfurl.enrollments(id, course_version_id) on delete cascade,
  foreign key (explanation_lesson_id, course_version_id) references unfurl.lessons(id, course_version_id) on delete restrict,
  foreign key (return_lesson_id, course_version_id) references unfurl.lessons(id, course_version_id) on delete restrict,
  foreign key (return_task_id, course_version_id) references unfurl.tasks_public(id, course_version_id) on delete restrict,
  foreign key (completion_task_id, course_version_id) references unfurl.tasks_public(id, course_version_id) on delete restrict,
  unique (enrollment_id, auto_basis_key),
  check ((explanation_lesson_id is null) = (explanation_block_id is null)),
  check ((completion_task_id is null and cardinality(completion_dimension_ids) = 0)
    or (completion_task_id is not null and cardinality(completion_dimension_ids) between 1 and 24))
);
create unique index one_live_support on unfurl.support_offers(enrollment_id) where status in ('offered', 'accepted');

create table unfurl.support_offer_tasks (
  offer_id uuid not null references unfurl.support_offers(id) on delete cascade,
  slot smallint not null check (slot in (0, 1)),
  course_version_id uuid not null,
  lesson_id uuid not null,
  task_id uuid not null,
  task_version integer not null check (task_version >= 1),
  primary key (offer_id, slot),
  unique (offer_id, task_id),
  foreign key (lesson_id, course_version_id) references unfurl.lessons(id, course_version_id) on delete restrict,
  foreign key (task_id, task_version, course_version_id)
    references unfurl.tasks_public(id, task_version, course_version_id) on delete restrict
);

-- Reuse the single durable runner for evaluation and activity actions.
alter table unfurl.execution_jobs drop constraint execution_jobs_check;
alter table unfurl.execution_jobs
  add column evaluation_id uuid references unfurl.evaluations(id) on delete cascade,
  add column target_evaluation_revision integer check (target_evaluation_revision >= 1),
  add column activity_action_id uuid unique references unfurl.activity_actions(id) on delete cascade,
  add constraint execution_job_target check (
    num_nonnulls(agent_turn_run_id, generation_run_id, evaluation_id, activity_action_id) = 1
    and ((evaluation_id is not null and target_evaluation_revision is not null)
      or (evaluation_id is null and target_evaluation_revision is null))
  ),
  add constraint execution_evaluation_revision unique (evaluation_id, target_evaluation_revision);
alter table unfurl.assessment_review_requests
  add constraint review_execution_job foreign key (execution_job_id) references unfurl.execution_jobs(id) on delete set null;

create trigger assessment_review_no_delete before delete on unfurl.assessment_review_requests
  for each row execute function unfurl.reject_immutable_change();
create trigger feedback_ack_immutable before update or delete on unfurl.feedback_acknowledgements
  for each row execute function unfurl.reject_immutable_change();

-- New private authority tables are available only through checked server services.
do $$ declare table_name text; begin
  foreach table_name in array array['activity_inputs', 'activity_actions', 'evaluation_revisions', 'xp_award_adjustments',
    'assessment_review_requests', 'feedback_acknowledgements', 'support_offers', 'support_offer_tasks'] loop
    execute format('alter table unfurl.%I enable row level security', table_name);
    execute format('alter table unfurl.%I force row level security', table_name);
    execute format('revoke all on unfurl.%I from public, anon, authenticated', table_name);
    execute format('grant all on unfurl.%I to service_role', table_name);
  end loop;
end $$;

-- Publication/ready fields are system-derived even in actor-scoped transactions.
revoke insert, update on unfurl.courses from authenticated;
grant insert (id, owner_id, slug, title, summary, content_language, cover) on unfurl.courses to authenticated;
grant update (slug, title, summary, content_language, cover, revision, updated_at) on unfurl.courses to authenticated;

revoke all on function unfurl.check_published_course_version() from public;
