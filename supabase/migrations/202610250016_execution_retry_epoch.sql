-- A paid semantic retry is a user-authorized epoch, never a lease recovery.
alter table unfurl.execution_jobs
  add column retry_epoch integer not null default 0 check (retry_epoch >= 0);

create table unfurl.execution_job_retry_receipts (
  id uuid primary key,
  job_id uuid not null references unfurl.execution_jobs(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  from_epoch integer not null check (from_epoch >= 0),
  to_epoch integer not null check (to_epoch = from_epoch + 1),
  semantic_target jsonb not null check (jsonb_typeof(semantic_target) = 'object' and octet_length(semantic_target::text) <= 4096),
  created_at timestamptz not null default now(),
  unique (job_id, to_epoch)
);
create trigger execution_job_retry_receipt_immutable before update or delete on unfurl.execution_job_retry_receipts
  for each row execute function unfurl.reject_immutable_change();

create function unfurl.guard_execution_job_retry_epoch() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.retry_epoch is distinct from old.retry_epoch and (
    new.retry_epoch <> old.retry_epoch + 1 or not exists (
      select 1 from unfurl.execution_job_retry_receipts r
      where r.job_id=old.id and r.from_epoch=old.retry_epoch and r.to_epoch=new.retry_epoch
    )
  ) then
    raise exception 'Execution retry epoch requires an explicit receipt' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger execution_job_retry_epoch_guard before update on unfurl.execution_jobs
  for each row execute function unfurl.guard_execution_job_retry_epoch();

create function unfurl.advance_execution_job_retry(
  p_receipt_id uuid,
  p_job_id uuid,
  p_actor_id uuid,
  p_expected_epoch integer,
  p_expected_target jsonb
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  job unfurl.execution_jobs%rowtype;
  actual_target jsonb;
  target_owner uuid;
begin
  select * into job from unfurl.execution_jobs where id=p_job_id for update;
  if not found or job.retry_epoch <> p_expected_epoch or job.status not in ('waiting','failed') then
    raise exception 'Execution retry compare-and-set failed' using errcode = '40001';
  end if;

  if job.agent_turn_run_id is not null then
    actual_target := jsonb_build_object('kind','agent_turn','runId',job.agent_turn_run_id);
    select owner_id into target_owner from unfurl.agent_turn_runs where id=job.agent_turn_run_id;
  elsif job.generation_run_id is not null then
    actual_target := jsonb_build_object('kind','generation','runId',job.generation_run_id);
    select owner_id into target_owner from unfurl.generation_runs where id=job.generation_run_id;
  elsif job.evaluation_id is not null then
    actual_target := jsonb_build_object('kind','evaluation','evaluationId',job.evaluation_id,
      'targetEvaluationRevision',job.target_evaluation_revision);
    select a.learner_id into target_owner from unfurl.evaluations e
      join unfurl.attempts a on a.id=e.attempt_id where e.id=job.evaluation_id;
  else
    actual_target := jsonb_build_object('kind','activity_action','activityActionId',job.activity_action_id);
    select e.learner_id into target_owner from unfurl.activity_actions a
      join unfurl.activity_sessions s on s.id=a.activity_session_id
      join unfurl.enrollments e on e.id=s.enrollment_id where a.id=job.activity_action_id;
  end if;

  if target_owner is distinct from p_actor_id or actual_target is distinct from p_expected_target then
    raise exception 'Execution retry target changed' using errcode = '40001';
  end if;
  if exists (
    select 1 from unfurl.ai_provider_operations o join unfurl.run_steps s on s.id=o.run_step_id
    where s.job_id=job.id and o.state in ('dispatched','unknown')
  ) then
    raise exception 'Execution retry has unresolved provider cost' using errcode = '55000';
  end if;
  if exists (
    select 1 from unfurl.code_execution_runs c where c.job_id=job.id
      and c.status in ('reserved','creating','running','collecting','ambiguous','cleanup_pending')
  ) then
    raise exception 'Execution retry has active Python work' using errcode = '55000';
  end if;

  insert into unfurl.execution_job_retry_receipts
    (id,job_id,actor_id,from_epoch,to_epoch,semantic_target)
    values(p_receipt_id,job.id,p_actor_id,job.retry_epoch,job.retry_epoch+1,actual_target);
  update unfurl.execution_jobs set retry_epoch=retry_epoch+1,updated_at=now() where id=job.id;
  return job.retry_epoch+1;
end;
$$;

alter table unfurl.execution_job_retry_receipts enable row level security;
alter table unfurl.execution_job_retry_receipts force row level security;
revoke all on unfurl.execution_job_retry_receipts from public, anon, authenticated, service_role;
grant select on unfurl.execution_job_retry_receipts to service_role;
revoke all on function unfurl.guard_execution_job_retry_epoch(),
  unfurl.advance_execution_job_retry(uuid,uuid,uuid,integer,jsonb) from public, anon, authenticated;
grant execute on function unfurl.advance_execution_job_retry(uuid,uuid,uuid,integer,jsonb) to service_role;
