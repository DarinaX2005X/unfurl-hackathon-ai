-- Private authority for pre-ready Python candidate validation. The binding is
-- subordinate to a generation job and its live validation step; it invents no
-- learner, enrollment, activity or attempt identity.

alter table unfurl.run_steps add constraint run_step_job_identity unique (id, job_id);

create table unfurl.python_authoring_validations (
  id uuid primary key,
  job_id uuid not null references unfurl.execution_jobs(id) on delete restrict,
  run_step_id uuid not null,
  candidate_step_id uuid not null,
  case_plan_step_id uuid not null,
  validation_case_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete restrict,
  generation_run_id uuid not null references unfurl.generation_runs(id) on delete restrict,
  course_id uuid not null references unfurl.courses(id) on delete restrict,
  course_version_id uuid not null references unfurl.course_versions(id) on delete restrict,
  approval_id uuid not null references unfurl.curriculum_approvals(id) on delete restrict,
  approval_digest text not null check (approval_digest ~ '^[a-f0-9]{64}$'),
  candidate_digest text not null check (candidate_digest ~ '^[a-f0-9]{64}$'),
  capability_catalog_digest text not null check (capability_catalog_digest ~ '^[a-f0-9]{64}$'),
  source text not null check (octet_length(convert_to(source, 'UTF8')) between 1 and 12000),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  cases_digest text not null check (cases_digest ~ '^[a-f0-9]{64}$'),
  case_key text not null check (case_key ~ '^[a-zA-Z0-9_-]{1,80}$'),
  case_category text not null check (case_category in ('valid','alternative','invalid')),
  case_bindings jsonb not null check (jsonb_typeof(case_bindings) = 'array' and jsonb_array_length(case_bindings) between 1 and 8),
  candidate_step_schema_digest text not null check (candidate_step_schema_digest ~ '^[a-f0-9]{64}$'),
  candidate_step_capability_digest text not null check (candidate_step_capability_digest ~ '^[a-f0-9]{64}$'),
  candidate_step_validation_policy_digest text not null check (candidate_step_validation_policy_digest ~ '^[a-f0-9]{64}$'),
  case_plan_schema_digest text not null check (case_plan_schema_digest ~ '^[a-f0-9]{64}$'),
  case_plan_capability_digest text not null check (case_plan_capability_digest ~ '^[a-f0-9]{64}$'),
  case_plan_validation_policy_digest text not null check (case_plan_validation_policy_digest ~ '^[a-f0-9]{64}$'),
  execution_schema_digest text not null check (execution_schema_digest ~ '^[a-f0-9]{64}$'),
  execution_capability_digest text not null check (execution_capability_digest ~ '^[a-f0-9]{64}$'),
  execution_validation_policy_digest text not null check (execution_validation_policy_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (run_step_id, job_id) references unfurl.run_steps(id, job_id) on delete restrict,
  foreign key (candidate_step_id, job_id) references unfurl.run_steps(id, job_id) on delete restrict,
  foreign key (case_plan_step_id, job_id) references unfurl.run_steps(id, job_id) on delete restrict,
  unique (run_step_id),
  unique (job_id, validation_case_id, candidate_digest, source_digest, cases_digest),
  check (run_step_id <> candidate_step_id and run_step_id <> case_plan_step_id and candidate_step_id <> case_plan_step_id)
);

create function unfurl.valid_python_authoring_case_bindings(value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  ids text[] := '{}';
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) not between 1 and 8 then return false; end if;
  for item in select value from jsonb_array_elements(value) loop
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
  add constraint python_authoring_case_bindings check (unfurl.valid_python_authoring_case_bindings(case_bindings));

create function unfurl.guard_python_authoring_validation() returns trigger language plpgsql set search_path = '' as $$
declare
  execution_step unfurl.run_steps%rowtype;
  candidate_step unfurl.run_steps%rowtype;
  case_step unfurl.run_steps%rowtype;
begin
  if not exists (
    select 1 from unfurl.execution_jobs j
    join unfurl.generation_runs g on g.id=j.generation_run_id
      and g.owner_id=new.owner_id and g.course_id=new.course_id and g.approval_id=new.approval_id
    join unfurl.courses c on c.id=g.course_id and c.owner_id=g.owner_id
    join unfurl.course_versions v on v.id=new.course_version_id and v.course_id=g.course_id
      and v.source_run_id=g.id and v.approval_id=g.approval_id and v.state in ('building','validating')
    join unfurl.curriculum_approvals a on a.id=g.approval_id and a.approved_by=g.owner_id
      and a.content_digest=new.approval_digest and a.draft_revision=g.source_draft_revision
    join unfurl.curriculum_drafts d on d.id=a.draft_id and d.course_id=g.course_id
      and d.revision=a.draft_revision
    where j.id=new.job_id and j.status='running' and j.lease_owner is not null
      and j.lease_expires_at > statement_timestamp() and g.id=new.generation_run_id and g.status='running'
  ) then
    raise exception 'Python authoring authority is stale' using errcode = '40001';
  end if;

  select * into execution_step from unfurl.run_steps where id=new.run_step_id and job_id=new.job_id;
  select * into candidate_step from unfurl.run_steps where id=new.candidate_step_id and job_id=new.job_id;
  select * into case_step from unfurl.run_steps where id=new.case_plan_step_id and job_id=new.job_id;
  if execution_step.status <> 'running' or execution_step.approval_digest is distinct from new.approval_digest
    or execution_step.schema_digest <> new.execution_schema_digest
    or execution_step.capability_digest <> new.execution_capability_digest
    or execution_step.validation_policy_digest <> new.execution_validation_policy_digest
    or candidate_step.status <> 'succeeded' or candidate_step.approval_digest is distinct from new.approval_digest
    or candidate_step.schema_digest <> new.candidate_step_schema_digest
    or candidate_step.capability_digest <> new.candidate_step_capability_digest
    or candidate_step.validation_policy_digest <> new.candidate_step_validation_policy_digest
    or case_step.status <> 'succeeded' or case_step.approval_digest is distinct from new.approval_digest
    or case_step.schema_digest <> new.case_plan_schema_digest
    or case_step.capability_digest <> new.case_plan_capability_digest
    or case_step.validation_policy_digest <> new.case_plan_validation_policy_digest then
    raise exception 'Python authoring steps are stale' using errcode = '40001';
  end if;

  if candidate_step.result_reference->>'kind' <> 'course.task.candidate'
    or candidate_step.result_reference#>>'{candidate,approvalDigest}' <> new.approval_digest
    or candidate_step.result_reference#>>'{candidate,candidateDigest}' <> new.candidate_digest
    or candidate_step.result_reference#>>'{candidate,capabilityCatalogDigest}' <> new.capability_catalog_digest
    or candidate_step.result_reference#>>'{candidate,task,mechanicVersion}' <> '3'
    or candidate_step.result_reference#>>'{candidate,task,mechanicId}' not in ('artifact_construction','diagnosis_repair') then
    raise exception 'Python candidate checkpoint does not match' using errcode = '23514';
  end if;
  if case_step.result_reference->>'kind' <> 'course.task.cases'
    or case_step.result_reference->>'candidateStepId' <> new.candidate_step_id::text
    or case_step.result_reference->>'candidateDigest' <> new.candidate_digest
    or not exists (
      select 1 from jsonb_array_elements(case_step.result_reference->'cases') item
      where item->>'caseId'=new.validation_case_id::text and item->>'key'=new.case_key
        and item->>'category'=new.case_category and item#>>'{response,source}'=new.source
    ) then
    raise exception 'Python case checkpoint does not match' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger python_authoring_validation_guard before insert on unfurl.python_authoring_validations
  for each row execute function unfurl.guard_python_authoring_validation();
create trigger python_authoring_validation_immutable before update or delete on unfurl.python_authoring_validations
  for each row execute function unfurl.reject_immutable_change();

alter table unfurl.python_authoring_validations enable row level security;
alter table unfurl.python_authoring_validations force row level security;
revoke all on unfurl.python_authoring_validations from public, anon, authenticated;
grant all on unfurl.python_authoring_validations to service_role;
revoke all on function unfurl.valid_python_authoring_case_bindings(jsonb),
  unfurl.guard_python_authoring_validation() from public;
