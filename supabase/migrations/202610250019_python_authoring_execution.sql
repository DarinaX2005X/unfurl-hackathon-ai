-- Persist authoring Python work without inventing learner identities. Every
-- authoring mutation remains subordinate to the immutable validation binding,
-- the current execution-job retry epoch, and both live lease fences.

create or replace function unfurl.valid_python_authoring_case_bindings(value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  ids text[] := '{}';
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) not between 2 and 12 then return false; end if;
  for item in select entry.item from jsonb_array_elements($1) entry(item) loop
    if jsonb_typeof(item) <> 'object'
      or not (item ?& array['id','role','inputDigest','expectedDigest'])
      or (item - array['id','role','inputDigest','expectedDigest']) <> '{}'::jsonb
      or jsonb_typeof(item->'id') <> 'string' or length(item->>'id') not between 1 and 80
      or (item->>'id') !~ '^[A-Za-z][A-Za-z0-9_-]*$'
      or item->>'role' not in ('public','hidden')
      or coalesce(item->>'inputDigest','') !~ '^[a-f0-9]{64}$'
      or (item->>'role'='public' and jsonb_typeof(item->'expectedDigest') <> 'null')
      or (item->>'role'='hidden' and coalesce(item->>'expectedDigest','') !~ '^[a-f0-9]{64}$') then
      return false;
    end if;
    ids := array_append(ids,item->>'id');
  end loop;
  return cardinality(ids) = (select count(distinct id) from unnest(ids) id);
end;
$$;

alter table unfurl.python_authoring_validations
  add column execution_cases jsonb not null check (
    jsonb_typeof(execution_cases)='array' and jsonb_array_length(execution_cases) between 2 and 12
  );

create function unfurl.guard_python_authoring_projection() returns trigger language plpgsql set search_path = '' as $$
declare
  candidate jsonb;
  public_cases jsonb;
  hidden_cases jsonb;
  projected jsonb;
  binding jsonb;
  item jsonb;
  position integer;
  public_count integer;
begin
  select result_reference into candidate from unfurl.run_steps
    where id=new.candidate_step_id and job_id=new.job_id and status='succeeded';
  public_cases := candidate#>'{candidate,task,config,publicCases}';
  hidden_cases := candidate#>'{candidate,privateTask,evaluatorData,hiddenCases}';
  if jsonb_typeof(public_cases)<>'array' or jsonb_typeof(hidden_cases)<>'array' then
    raise exception 'Python candidate case projection is absent' using errcode = '23514';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',entry.item->>'id','input',entry.item->'input')
    order by entry.ordinality),'[]'::jsonb) into projected
    from jsonb_array_elements(public_cases || hidden_cases) with ordinality entry(item,ordinality);
  if new.execution_cases is distinct from projected then
    raise exception 'Python execution cases do not match the candidate checkpoint' using errcode = '23514';
  end if;
  if new.source_digest <> pg_catalog.encode(extensions.digest(pg_catalog.convert_to(new.source,'UTF8'),'sha256'),'hex') then
    raise exception 'Python source digest does not match source' using errcode = '23514';
  end if;
  public_count := jsonb_array_length(public_cases);
  for position in 0..jsonb_array_length(projected)-1 loop
    item := projected->position;
    binding := new.case_bindings->position;
    if binding->>'id' is distinct from item->>'id'
      or binding->>'role' is distinct from (case when position<public_count then 'public' else 'hidden' end)
      or (position<public_count and jsonb_typeof(binding->'expectedDigest')<>'null')
      or (position>=public_count and coalesce(binding->>'expectedDigest','') !~ '^[a-f0-9]{64}$') then
      raise exception 'Python case bindings do not match the candidate checkpoint' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;
create trigger python_authoring_projection_guard before insert on unfurl.python_authoring_validations
  for each row execute function unfurl.guard_python_authoring_projection();

alter table unfurl.code_execution_runs
  drop constraint code_execution_runs_purpose_check,
  drop constraint code_execution_runs_check,
  drop constraint code_execution_runs_check1,
  drop constraint code_execution_runs_provider_command_ids_check,
  alter column learner_id drop not null,
  alter column enrollment_id drop not null,
  alter column task_id drop not null,
  alter column task_version drop not null,
  alter column activity_session_id drop not null,
  alter column input_revision drop not null,
  alter column response_digest drop not null,
  add column authoring_validation_id uuid references unfurl.python_authoring_validations(id) on delete restrict,
  add column owner_id uuid references auth.users(id) on delete restrict,
  add column generation_run_id uuid references unfurl.generation_runs(id) on delete restrict,
  add column course_id uuid references unfurl.courses(id) on delete restrict,
  add column approval_id uuid references unfurl.curriculum_approvals(id) on delete restrict,
  add column approval_digest text check (approval_digest is null or approval_digest ~ '^[a-f0-9]{64}$'),
  add column candidate_digest text check (candidate_digest is null or candidate_digest ~ '^[a-f0-9]{64}$'),
  add column cases_digest text check (cases_digest is null or cases_digest ~ '^[a-f0-9]{64}$'),
  add column execution_cases jsonb not null check (
    jsonb_typeof(execution_cases)='array' and jsonb_array_length(execution_cases) between 1 and 12
      and octet_length(execution_cases::text)<=196608
  ),
  add column job_retry_epoch integer not null default 0 check (job_retry_epoch >= 0),
  add column step_id uuid,
  add column step_lease_owner text check (step_lease_owner is null or length(step_lease_owner) between 1 and 128),
  add column step_fencing_token bigint check (step_fencing_token is null or step_fencing_token >= 1),
  add constraint code_execution_step_job foreign key (step_id, job_id)
    references unfurl.run_steps(id, job_id) on delete restrict,
  add constraint code_execution_purpose check (purpose in ('public_run','grade','authoring_validation')),
  add constraint code_execution_provider_command_limit check (
    cardinality(provider_command_ids)<=case when purpose='authoring_validation' then 12 else 8 end
  ),
  add constraint code_execution_target check (num_nonnulls(activity_action_id,attempt_id,authoring_validation_id)=1),
  add constraint code_execution_purpose_target check (
    (purpose='public_run' and activity_action_id is not null)
    or (purpose='grade' and attempt_id is not null)
    or (purpose='authoring_validation' and authoring_validation_id is not null)
  ),
  add constraint code_execution_scope check (
    (purpose in ('public_run','grade')
      and num_nonnulls(learner_id,enrollment_id,task_id,task_version,activity_session_id,input_revision,response_digest)=7
      and num_nonnulls(authoring_validation_id,owner_id,generation_run_id,course_id,approval_id,approval_digest,
        candidate_digest,cases_digest,step_id,step_lease_owner,step_fencing_token)=0)
    or (purpose='authoring_validation'
      and num_nonnulls(learner_id,enrollment_id,task_id,task_version,activity_session_id,input_revision,response_digest)=0
      and num_nonnulls(authoring_validation_id,owner_id,generation_run_id,course_id,approval_id,approval_digest,
        candidate_digest,cases_digest,step_id,step_lease_owner,step_fencing_token)=11)
  );

create unique index code_execution_target_authoring_attempt
  on unfurl.code_execution_runs(authoring_validation_id,execution_attempt)
  where authoring_validation_id is not null;

alter table unfurl.python_execution_admissions
  add column job_retry_epoch integer not null default 0 check (job_retry_epoch >= 0),
  add column step_id uuid,
  add column step_lease_owner text check (step_lease_owner is null or length(step_lease_owner) between 1 and 128),
  add column step_fencing_token bigint check (step_fencing_token is null or step_fencing_token >= 1),
  add constraint python_execution_admission_step_fence check (
    num_nonnulls(step_id,step_lease_owner,step_fencing_token) in (0,3)
  );

create or replace function unfurl.guard_python_execution_admission() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Python admission receipts are immutable' using errcode = '23514';
  end if;
  if row(new.idempotency_key,new.execution_id,new.job_id,new.job_lease_owner,new.job_fencing_token,
      new.job_retry_epoch,new.step_id,new.step_lease_owner,new.step_fencing_token,new.logical_execution_id,
      new.execution_attempt,new.request_digest,new.created_at)
    is distinct from row(old.idempotency_key,old.execution_id,old.job_id,old.job_lease_owner,old.job_fencing_token,
      old.job_retry_epoch,old.step_id,old.step_lease_owner,old.step_fencing_token,old.logical_execution_id,
      old.execution_attempt,old.request_digest,old.created_at) then
    raise exception 'Python admission identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'assessing' or new.state not in ('dispatch','unavailable') then
    raise exception 'Python admission outcome is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function unfurl.reserve_python_daily_quota() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into unfurl.python_execution_global_daily_quotas(quota_day,reserved_count)
    values(new.quota_day,1)
    on conflict (quota_day) do update
      set reserved_count=unfurl.python_execution_global_daily_quotas.reserved_count+1,
        updated_at=statement_timestamp();
  if new.learner_id is not null then
    insert into unfurl.python_execution_learner_daily_quotas(quota_day,learner_id,reserved_count)
      values(new.quota_day,new.learner_id,1)
      on conflict (quota_day,learner_id) do update
        set reserved_count=unfurl.python_execution_learner_daily_quotas.reserved_count+1,
          updated_at=statement_timestamp();
  end if;
  return new;
end;
$$;

create or replace function unfurl.guard_code_execution() returns trigger language plpgsql set search_path = '' as $$
declare
  prior unfurl.code_execution_runs%rowtype;
  command_id text;
begin
  if new.authoring_validation_id is not null then
    if not exists (
      select 1
      from unfurl.execution_jobs j
      join unfurl.python_authoring_validations b on b.id=new.authoring_validation_id and b.job_id=j.id
      join unfurl.run_steps s on s.id=b.run_step_id and s.job_id=j.id
      where j.id=new.job_id and j.status='running' and j.lease_owner=new.job_lease_owner
        and j.fencing_token=new.job_fencing_token and j.retry_epoch=new.job_retry_epoch
        and j.lease_expires_at>statement_timestamp()
        and j.generation_run_id=new.generation_run_id
        and b.job_retry_epoch=new.job_retry_epoch and b.run_step_id=new.step_id
        and b.owner_id=new.owner_id and b.generation_run_id=new.generation_run_id
        and b.course_id=new.course_id and b.course_version_id=new.course_version_id
        and b.approval_id=new.approval_id and b.approval_digest=new.approval_digest
        and b.candidate_digest=new.candidate_digest and b.source_digest=new.source_digest
        and b.cases_digest=new.cases_digest and b.execution_cases=new.execution_cases
        and s.status='running' and s.lease_owner=new.step_lease_owner
        and s.fencing_token=new.step_fencing_token and s.lease_expires_at>statement_timestamp()
    ) then
      raise exception 'Live authoring fences do not authorize Python mutation' using errcode = '40001';
    end if;
  elsif not exists (
    select 1 from unfurl.execution_jobs j
    where j.id=new.job_id and j.status='running' and j.lease_owner=new.job_lease_owner
      and j.fencing_token=new.job_fencing_token and j.retry_epoch=new.job_retry_epoch
      and j.lease_expires_at>statement_timestamp()
      and ((new.activity_action_id is not null and j.activity_action_id=new.activity_action_id)
        or (new.attempt_id is not null and exists (
          select 1 from unfurl.evaluations e where e.id=j.evaluation_id and e.attempt_id=new.attempt_id
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
      select * into prior from unfurl.code_execution_runs where id=new.retry_of_execution_id;
      if not found or prior.logical_execution_id is distinct from new.logical_execution_id
        or prior.execution_attempt+1 is distinct from new.execution_attempt
        or prior.job_id is distinct from new.job_id
        or prior.activity_action_id is distinct from new.activity_action_id
        or prior.attempt_id is distinct from new.attempt_id
        or prior.authoring_validation_id is distinct from new.authoring_validation_id
        or prior.learner_id is distinct from new.learner_id
        or prior.enrollment_id is distinct from new.enrollment_id
        or prior.course_version_id is distinct from new.course_version_id
        or prior.task_id is distinct from new.task_id or prior.task_version is distinct from new.task_version
        or prior.activity_session_id is distinct from new.activity_session_id
        or prior.input_revision is distinct from new.input_revision
        or prior.response_digest is distinct from new.response_digest
        or prior.owner_id is distinct from new.owner_id
        or prior.generation_run_id is distinct from new.generation_run_id
        or prior.course_id is distinct from new.course_id or prior.approval_id is distinct from new.approval_id
        or prior.approval_digest is distinct from new.approval_digest
        or prior.candidate_digest is distinct from new.candidate_digest
        or prior.cases_digest is distinct from new.cases_digest
        or prior.execution_cases is distinct from new.execution_cases
        or prior.purpose is distinct from new.purpose or prior.request_digest is distinct from new.request_digest
        or prior.source_digest is distinct from new.source_digest
        or prior.runtime_digest is distinct from new.runtime_digest
        or prior.image_digest is distinct from new.image_digest
        or prior.runner_digest is distinct from new.runner_digest
        or prior.runtime_profile is distinct from new.runtime_profile
        or prior.runtime_image is distinct from new.runtime_image
        or prior.job_retry_epoch is distinct from new.job_retry_epoch
        or prior.step_id is distinct from new.step_id
        or prior.status <> 'unavailable' or prior.disposition not in ('not_created','deleted')
        or exists (select 1 from unfurl.code_execution_runs r
          where r.logical_execution_id=new.logical_execution_id and r.status='completed') then
        raise exception 'Python retry is not conclusively safe' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  if row(new.id,new.job_id,new.activity_action_id,new.attempt_id,new.authoring_validation_id,new.learner_id,
      new.enrollment_id,new.course_version_id,new.task_id,new.task_version,new.activity_session_id,new.input_revision,
      new.response_digest,new.owner_id,new.generation_run_id,new.course_id,new.approval_id,new.approval_digest,
      new.candidate_digest,new.cases_digest,new.execution_cases,new.purpose,new.logical_execution_id,new.execution_attempt,
      new.retry_of_execution_id,new.idempotency_key,new.request_digest,new.source_digest,new.runtime_digest,
      new.image_digest,new.runner_digest,new.runtime_profile,new.runtime_image,new.job_lease_owner,
      new.job_fencing_token,new.job_retry_epoch,new.step_id,new.step_lease_owner,new.step_fencing_token,
      new.quota_day,new.deadline_at,new.created_at)
    is distinct from row(old.id,old.job_id,old.activity_action_id,old.attempt_id,old.authoring_validation_id,old.learner_id,
      old.enrollment_id,old.course_version_id,old.task_id,old.task_version,old.activity_session_id,old.input_revision,
      old.response_digest,old.owner_id,old.generation_run_id,old.course_id,old.approval_id,old.approval_digest,
      old.candidate_digest,old.cases_digest,old.execution_cases,old.purpose,old.logical_execution_id,old.execution_attempt,
      old.retry_of_execution_id,old.idempotency_key,old.request_digest,old.source_digest,old.runtime_digest,
      old.image_digest,old.runner_digest,old.runtime_profile,old.runtime_image,old.job_lease_owner,
      old.job_fencing_token,old.job_retry_epoch,old.step_id,old.step_lease_owner,old.step_fencing_token,
      old.quota_day,old.deadline_at,old.created_at) then
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
  if cardinality(new.provider_command_ids)<cardinality(old.provider_command_ids)
    or (cardinality(old.provider_command_ids)>0 and
      new.provider_command_ids[1:cardinality(old.provider_command_ids)] is distinct from old.provider_command_ids) then
    raise exception 'Provider command identities are append-only' using errcode = '23514';
  end if;
  if old.result is not null and new.result is distinct from old.result
    or old.result_digest is not null and new.result_digest is distinct from old.result_digest
    or old.audit is not null and new.audit is distinct from old.audit then
    raise exception 'Python result and audit are immutable' using errcode = '23514';
  end if;
  if new.status<>old.status and not (
    (old.status='reserved' and new.status in ('creating','ambiguous','unavailable'))
    or (old.status='creating' and new.status in ('running','ambiguous','cleanup_pending','unavailable'))
    or (old.status='running' and new.status in ('collecting','cleanup_pending'))
    or (old.status='collecting' and new.status='cleanup_pending')
    or (old.status='ambiguous' and new.status='cleanup_pending')
    or (old.status='cleanup_pending' and new.status in ('completed','unavailable'))
  ) then
    raise exception 'Invalid Python execution transition' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function unfurl.guard_retry_receipt_no_held_cost() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from unfurl.ai_provider_operations o join unfurl.run_steps s on s.id=o.run_step_id
    where s.job_id=new.job_id and o.state in ('reserved','dispatched','unknown')
  ) or exists (
    select 1 from unfurl.code_execution_runs c where c.job_id=new.job_id
      and c.status in ('reserved','creating','running','collecting','ambiguous','cleanup_pending')
  ) then
    raise exception 'Execution retry has held provider work' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function unfurl.guard_python_execution_admission(),
  unfurl.reserve_python_daily_quota(), unfurl.guard_code_execution(),
  unfurl.guard_python_authoring_projection(), unfurl.guard_retry_receipt_no_held_cost() from public;
