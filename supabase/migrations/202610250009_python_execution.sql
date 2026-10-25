-- Durable Python Sandbox execution. This migration performs no provider or VM calls.
-- A code execution is subordinate to the existing leased execution job; it is not
-- a fifth job target and cannot outlive or bypass that job's fencing authority.

alter table unfurl.execution_capability_receipts
  drop constraint execution_capability_receipts_capability_check,
  add constraint execution_capability_receipts_capability_check check (capability in (
    'budget_accounting', 'model_structured', 'model_text', 'research_search', 'rubric',
    'run_recovery', 'dispatcher', 'python_sandbox'
  )),
  add column sandbox_team_id text check (sandbox_team_id is null or length(sandbox_team_id) between 1 and 128),
  add column sandbox_runtime_profile text check (sandbox_runtime_profile is null or length(sandbox_runtime_profile) between 1 and 80),
  add column sandbox_image text check (sandbox_image is null or length(sandbox_image) between 1 and 256),
  add column sandbox_image_digest text check (sandbox_image_digest is null or sandbox_image_digest ~ '^[a-f0-9]{64}$'),
  add column sandbox_runner_digest text check (sandbox_runner_digest is null or sandbox_runner_digest ~ '^[a-f0-9]{64}$'),
  add column sandbox_plan text check (sandbox_plan is null or sandbox_plan = 'hobby'),
  add constraint python_capability_environment check (
    (capability = 'python_sandbox' and num_nonnulls(sandbox_team_id, sandbox_runtime_profile, sandbox_image,
      sandbox_image_digest, sandbox_runner_digest, sandbox_plan) = 6)
    or (capability <> 'python_sandbox' and num_nonnulls(sandbox_team_id, sandbox_runtime_profile, sandbox_image,
      sandbox_image_digest, sandbox_runner_digest, sandbox_plan) = 0)
  );

-- These counters are deliberately monotonic. Reservation failures roll back their
-- increments, while admitted attempts retain quota even after cleanup.
create table unfurl.python_execution_global_daily_quotas (
  quota_day date primary key,
  reserved_count integer not null check (reserved_count between 1 and 60),
  updated_at timestamptz not null default now()
);
create table unfurl.python_execution_learner_daily_quotas (
  quota_day date not null,
  learner_id uuid not null references auth.users(id) on delete restrict,
  reserved_count integer not null check (reserved_count between 1 and 20),
  updated_at timestamptz not null default now(),
  primary key (quota_day, learner_id)
);

alter table unfurl.activity_actions
  add constraint activity_action_execution_identity unique (id, activity_session_id, input_revision, response_digest);
alter table unfurl.attempts
  add constraint attempt_execution_identity unique
    (id, learner_id, enrollment_id, course_version_id, task_id, task_version,
      activity_session_id, activity_input_revision, response_digest);

create table unfurl.code_execution_runs (
  id uuid primary key,
  job_id uuid not null references unfurl.execution_jobs(id) on delete restrict,
  activity_action_id uuid,
  attempt_id uuid,
  learner_id uuid not null,
  enrollment_id uuid not null,
  course_version_id uuid not null,
  task_id uuid not null,
  task_version integer not null check (task_version >= 1),
  activity_session_id uuid not null,
  input_revision integer not null check (input_revision >= 1),
  response_digest text not null check (response_digest ~ '^[a-f0-9]{64}$'),
  purpose text not null check (purpose in ('public_run', 'grade')),
  logical_execution_id uuid not null,
  execution_attempt integer not null check (execution_attempt >= 1),
  retry_of_execution_id uuid references unfurl.code_execution_runs(id) on delete restrict,
  idempotency_key uuid not null unique,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  runtime_digest text not null check (runtime_digest ~ '^[a-f0-9]{64}$'),
  image_digest text not null check (image_digest ~ '^[a-f0-9]{64}$'),
  runner_digest text not null check (runner_digest ~ '^[a-f0-9]{64}$'),
  runtime_profile text not null check (runtime_profile = 'python-3.13-standard-v1'),
  runtime_image text not null check (runtime_image = 'vercel-python-3.13'),
  job_lease_owner text not null check (length(job_lease_owner) between 1 and 128),
  job_fencing_token bigint not null check (job_fencing_token >= 1),
  quota_day date not null,
  resource_name text generated always as ('unfurl-py-' || replace(id::text, '-', '')) stored unique,
  deadline_at timestamptz not null,
  status text not null check (status in (
    'reserved', 'creating', 'running', 'collecting', 'ambiguous', 'cleanup_pending', 'completed', 'unavailable'
  )),
  provider_sandbox_id text check (provider_sandbox_id is null or length(provider_sandbox_id) between 1 and 256),
  provider_command_ids text[] not null default '{}',
  disposition text check (disposition in ('not_created', 'deleted')),
  safe_error jsonb check (safe_error is null or (jsonb_typeof(safe_error) = 'object' and octet_length(safe_error::text) <= 16384)),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 2097152)),
  result_digest text check (result_digest is null or result_digest ~ '^[a-f0-9]{64}$'),
  audit jsonb check (audit is null or (jsonb_typeof(audit) = 'object' and octet_length(audit::text) <= 2097152)),
  sandbox_created_at timestamptz,
  command_started_at timestamptz,
  create_ambiguous_at timestamptz,
  cleanup_pending_at timestamptz,
  disposed_at timestamptz,
  completed_at timestamptz,
  unavailable_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (enrollment_id, learner_id, course_version_id)
    references unfurl.enrollments(id, learner_id, course_version_id) on delete restrict,
  foreign key (task_id, task_version, course_version_id)
    references unfurl.tasks_public(id, task_version, course_version_id) on delete restrict,
  foreign key (activity_session_id, input_revision, response_digest)
    references unfurl.activity_inputs(activity_session_id, input_revision, response_digest) on delete restrict,
  foreign key (activity_action_id, activity_session_id, input_revision, response_digest)
    references unfurl.activity_actions(id, activity_session_id, input_revision, response_digest) on delete restrict,
  foreign key (attempt_id, learner_id, enrollment_id, course_version_id, task_id, task_version,
    activity_session_id, input_revision, response_digest)
    references unfurl.attempts(id, learner_id, enrollment_id, course_version_id, task_id, task_version,
      activity_session_id, activity_input_revision, response_digest) on delete restrict,
  foreign key (quota_day) references unfurl.python_execution_global_daily_quotas(quota_day) deferrable initially deferred,
  foreign key (quota_day, learner_id)
    references unfurl.python_execution_learner_daily_quotas(quota_day, learner_id) deferrable initially deferred,
  unique (logical_execution_id, execution_attempt),
  check (num_nonnulls(activity_action_id, attempt_id) = 1),
  check ((purpose = 'public_run' and activity_action_id is not null)
    or (purpose = 'grade' and attempt_id is not null)),
  check ((execution_attempt = 1 and retry_of_execution_id is null)
    or (execution_attempt > 1 and retry_of_execution_id is not null)),
  check (cardinality(provider_command_ids) <= 8),
  check (quota_day = (created_at at time zone 'UTC')::date),
  check (deadline_at > created_at),
  check ((provider_sandbox_id is null) = (sandbox_created_at is null)),
  check ((cardinality(provider_command_ids) = 0) = (command_started_at is null)),
  check (status not in ('running', 'collecting', 'completed') or provider_sandbox_id is not null),
  check (status <> 'collecting' or cardinality(provider_command_ids) > 0),
  check (status <> 'ambiguous' or create_ambiguous_at is not null),
  check (status not in ('cleanup_pending', 'completed') or cleanup_pending_at is not null),
  check (updated_at >= created_at),
  check ((status = 'completed' and disposition = 'deleted' and result is not null and result_digest is not null
      and audit is not null and disposed_at is not null and completed_at is not null and unavailable_at is null
      and cardinality(provider_command_ids) > 0)
    or (status = 'unavailable' and disposition in ('not_created', 'deleted') and result is null
      and result_digest is null and audit is not null and safe_error is not null
      and unavailable_at is not null and completed_at is null
      and ((disposition = 'deleted' and disposed_at is not null) or (disposition = 'not_created' and disposed_at is null)))
    or (status not in ('completed', 'unavailable') and disposition is null and result is null
      and result_digest is null and audit is null and disposed_at is null and completed_at is null and unavailable_at is null))
);
create unique index code_execution_target_action_attempt
  on unfurl.code_execution_runs(activity_action_id, execution_attempt) where activity_action_id is not null;
create unique index code_execution_target_grade_attempt
  on unfurl.code_execution_runs(attempt_id, execution_attempt) where attempt_id is not null;
create unique index code_execution_one_global_active on unfurl.code_execution_runs ((true))
  where status in ('reserved', 'creating', 'running', 'collecting', 'ambiguous', 'cleanup_pending');
create unique index code_execution_one_learner_active on unfurl.code_execution_runs (learner_id)
  where status in ('reserved', 'creating', 'running', 'collecting', 'ambiguous', 'cleanup_pending');

create function unfurl.guard_python_quota_counter() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.quota_day is distinct from old.quota_day
    or (tg_table_name = 'python_execution_learner_daily_quotas' and new.learner_id is distinct from old.learner_id)
    or new.reserved_count < old.reserved_count then
    raise exception 'Python quota counters are monotonic' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger python_global_quota_monotonic before update or delete on unfurl.python_execution_global_daily_quotas
  for each row execute function unfurl.guard_python_quota_counter();
create trigger python_learner_quota_monotonic before update or delete on unfurl.python_execution_learner_daily_quotas
  for each row execute function unfurl.guard_python_quota_counter();

create function unfurl.guard_execution_job_identity() returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.id, new.agent_turn_run_id, new.generation_run_id, new.evaluation_id, new.target_evaluation_revision,
      new.activity_action_id, new.created_at)
    is distinct from row(old.id, old.agent_turn_run_id, old.generation_run_id, old.evaluation_id,
      old.target_evaluation_revision, old.activity_action_id, old.created_at) then
    raise exception 'Execution job identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger execution_job_identity_immutable before update on unfurl.execution_jobs
  for each row execute function unfurl.guard_execution_job_identity();

create function unfurl.guard_code_execution() returns trigger language plpgsql set search_path = '' as $$
declare
  prior unfurl.code_execution_runs%rowtype;
  command_id text;
begin
  if not exists (
    select 1 from unfurl.execution_jobs j
    where j.id = new.job_id and j.status = 'running' and j.lease_owner = new.job_lease_owner
      and j.fencing_token = new.job_fencing_token and j.lease_expires_at > statement_timestamp()
      and ((new.activity_action_id is not null and j.activity_action_id = new.activity_action_id)
        or (new.attempt_id is not null and exists (
          select 1 from unfurl.evaluations e where e.id = j.evaluation_id and e.attempt_id = new.attempt_id
        )))
  ) then
    raise exception 'Live execution job claim does not authorize Python mutation' using errcode = '40001';
  end if;

  foreach command_id in array new.provider_command_ids loop
    if length(command_id) not between 1 and 256 then
      raise exception 'Provider command identity is invalid' using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'INSERT' then
    if new.quota_day <> (statement_timestamp() at time zone 'UTC')::date then
      raise exception 'Python quota day must be the current UTC day' using errcode = '23514';
    end if;
    if new.execution_attempt > 1 then
      select * into prior from unfurl.code_execution_runs where id = new.retry_of_execution_id;
      if not found or prior.logical_execution_id <> new.logical_execution_id
        or prior.execution_attempt + 1 <> new.execution_attempt
        or prior.activity_action_id is distinct from new.activity_action_id
        or prior.attempt_id is distinct from new.attempt_id
        or prior.learner_id <> new.learner_id or prior.enrollment_id <> new.enrollment_id
        or prior.course_version_id <> new.course_version_id or prior.task_id <> new.task_id
        or prior.task_version <> new.task_version or prior.activity_session_id <> new.activity_session_id
        or prior.input_revision <> new.input_revision or prior.response_digest <> new.response_digest
        or prior.purpose <> new.purpose or prior.request_digest <> new.request_digest
        or prior.source_digest <> new.source_digest or prior.runtime_digest <> new.runtime_digest
        or prior.image_digest <> new.image_digest or prior.runner_digest <> new.runner_digest
        or prior.runtime_profile <> new.runtime_profile or prior.runtime_image <> new.runtime_image
        or prior.status <> 'unavailable' or prior.disposition not in ('not_created', 'deleted')
        or exists (select 1 from unfurl.code_execution_runs r
          where r.logical_execution_id = new.logical_execution_id and r.status = 'completed') then
        raise exception 'Python retry is not conclusively safe' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  if row(new.id, new.job_id, new.activity_action_id, new.attempt_id, new.learner_id, new.enrollment_id,
      new.course_version_id, new.task_id, new.task_version, new.activity_session_id, new.input_revision,
      new.response_digest, new.purpose, new.logical_execution_id, new.execution_attempt, new.retry_of_execution_id,
      new.idempotency_key, new.request_digest, new.source_digest, new.runtime_digest, new.image_digest,
      new.runner_digest, new.runtime_profile, new.runtime_image, new.job_lease_owner, new.job_fencing_token,
      new.quota_day, new.deadline_at, new.created_at)
    is distinct from row(old.id, old.job_id, old.activity_action_id, old.attempt_id, old.learner_id, old.enrollment_id,
      old.course_version_id, old.task_id, old.task_version, old.activity_session_id, old.input_revision,
      old.response_digest, old.purpose, old.logical_execution_id, old.execution_attempt, old.retry_of_execution_id,
      old.idempotency_key, old.request_digest, old.source_digest, old.runtime_digest, old.image_digest,
      old.runner_digest, old.runtime_profile, old.runtime_image, old.job_lease_owner, old.job_fencing_token,
      old.quota_day, old.deadline_at, old.created_at) then
    raise exception 'Python execution identity is immutable' using errcode = '23514';
  end if;
  if old.provider_sandbox_id is not null and new.provider_sandbox_id is distinct from old.provider_sandbox_id then
    raise exception 'Sandbox identity is immutable' using errcode = '23514';
  end if;
  if (old.sandbox_created_at is not null and new.sandbox_created_at is distinct from old.sandbox_created_at)
    or (old.command_started_at is not null and new.command_started_at is distinct from old.command_started_at)
    or (old.create_ambiguous_at is not null and new.create_ambiguous_at is distinct from old.create_ambiguous_at)
    or (old.cleanup_pending_at is not null and new.cleanup_pending_at is distinct from old.cleanup_pending_at)
    or (old.disposed_at is not null and new.disposed_at is distinct from old.disposed_at)
    or (old.completed_at is not null and new.completed_at is distinct from old.completed_at)
    or (old.unavailable_at is not null and new.unavailable_at is distinct from old.unavailable_at) then
    raise exception 'Python lifecycle evidence is immutable' using errcode = '23514';
  end if;
  if cardinality(new.provider_command_ids) < cardinality(old.provider_command_ids)
    or (cardinality(old.provider_command_ids) > 0 and
      new.provider_command_ids[1:cardinality(old.provider_command_ids)] is distinct from old.provider_command_ids) then
    raise exception 'Provider command identities are append-only' using errcode = '23514';
  end if;
  if old.result is not null and new.result is distinct from old.result
    or old.result_digest is not null and new.result_digest is distinct from old.result_digest
    or old.audit is not null and new.audit is distinct from old.audit then
    raise exception 'Python result and audit are immutable' using errcode = '23514';
  end if;
  if new.status <> old.status and not (
    (old.status = 'reserved' and new.status in ('creating', 'ambiguous', 'unavailable'))
    or (old.status = 'creating' and new.status in ('running', 'ambiguous', 'cleanup_pending', 'unavailable'))
    or (old.status = 'running' and new.status in ('collecting', 'cleanup_pending'))
    or (old.status = 'collecting' and new.status = 'cleanup_pending')
    or (old.status = 'ambiguous' and new.status = 'cleanup_pending')
    or (old.status = 'cleanup_pending' and new.status in ('completed', 'unavailable'))
  ) then
    raise exception 'Invalid Python execution transition' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger code_execution_guard before insert or update on unfurl.code_execution_runs
  for each row execute function unfurl.guard_code_execution();
create trigger code_execution_no_delete before delete on unfurl.code_execution_runs
  for each row execute function unfurl.reject_immutable_change();

create function unfurl.reserve_python_daily_quota() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into unfurl.python_execution_global_daily_quotas(quota_day, reserved_count)
    values(new.quota_day, 1)
    on conflict (quota_day) do update set reserved_count = unfurl.python_execution_global_daily_quotas.reserved_count + 1,
      updated_at = statement_timestamp();
  insert into unfurl.python_execution_learner_daily_quotas(quota_day, learner_id, reserved_count)
    values(new.quota_day, new.learner_id, 1)
    on conflict (quota_day, learner_id) do update
      set reserved_count = unfurl.python_execution_learner_daily_quotas.reserved_count + 1,
        updated_at = statement_timestamp();
  return new;
end;
$$;
create trigger code_execution_quota after insert on unfurl.code_execution_runs
  for each row execute function unfurl.reserve_python_daily_quota();

do $$ declare table_name text; begin
  foreach table_name in array array['python_execution_global_daily_quotas',
    'python_execution_learner_daily_quotas', 'code_execution_runs'] loop
    execute format('alter table unfurl.%I enable row level security', table_name);
    execute format('alter table unfurl.%I force row level security', table_name);
    execute format('revoke all on unfurl.%I from public, anon, authenticated', table_name);
    execute format('grant all on unfurl.%I to service_role', table_name);
  end loop;
end $$;
revoke all on function unfurl.guard_python_quota_counter(), unfurl.guard_execution_job_identity(),
  unfurl.guard_code_execution(), unfurl.reserve_python_daily_quota() from public;
