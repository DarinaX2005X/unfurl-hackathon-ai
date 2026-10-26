-- Financial holds remain intact. Only proved ended local transports cease occupying a slot.
alter table unfurl.ai_provider_operations drop constraint ai_provider_operations_model_id_check;
alter table unfurl.ai_provider_operations drop constraint ai_provider_operations_provider_tag_check;
alter table unfurl.ai_provider_operations add constraint ai_provider_operation_route_check check (
  (model_id='moonshotai/kimi-k2.6' and provider_tag='digitalocean') or
  (model_id='google/gemini-3.8-flash' and provider_tag='google-ai-studio'));

create table unfurl.ai_provider_attempt_retirements (
  operation_id uuid primary key references unfurl.ai_provider_operations(id),
  kind text not null check(kind in ('ended_probe','explicit_decision_retry')),
  actor_id uuid references auth.users(id),
  job_id uuid references unfurl.execution_jobs(id), step_id uuid references unfurl.run_steps(id),
  from_epoch integer, to_epoch integer, authorized_model_policy text, reader_policy_digest text,
  input_digest text, schema_digest text, request_digest text not null,
  retained_micro_usd bigint not null check(retained_micro_usd>0),
  authorized_at timestamptz not null default now(),
  check((kind='ended_probe' and actor_id is null and job_id is null and step_id is null and from_epoch is null and to_epoch is null)
    or (kind='explicit_decision_retry' and actor_id is not null and job_id is not null and step_id is not null
      and from_epoch is not null and to_epoch is not null and from_epoch>=0 and to_epoch=from_epoch+1 and authorized_model_policy is not null and authorized_model_policy in ('kimi-digitalocean-v1','gemini-flash-google-v1')
      and reader_policy_digest is not null and reader_policy_digest ~ '^[a-f0-9]{64}$' and input_digest is not null and schema_digest is not null))
);
create trigger ai_provider_attempt_retirements_immutable before update or delete on unfurl.ai_provider_attempt_retirements
  for each row execute function unfurl.reject_immutable_change();
alter table unfurl.ai_provider_attempt_retirements enable row level security;
alter table unfurl.ai_provider_attempt_retirements force row level security;
revoke all on unfurl.ai_provider_attempt_retirements from public,anon,authenticated,service_role;
grant select on unfurl.ai_provider_attempt_retirements to service_role;

create function unfurl.retire_ended_provider_probe(p_operation_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare op unfurl.ai_provider_operations%rowtype;
begin
  select * into op from unfurl.ai_provider_operations where id=p_operation_id;
  if not found then raise exception 'Missing probe' using errcode='40001'; end if;
  perform 1 from unfurl.ai_budgets where id=op.budget_id for update;
  select * into op from unfurl.ai_provider_operations where id=p_operation_id for update;
  if exists(select 1 from unfurl.ai_provider_attempt_retirements where operation_id=op.id and kind='ended_probe') then return; end if;
  if op.purpose<>'capability_probe' or op.run_step_id is not null or op.state<>'unknown'
    or op.dispatched_at is null or op.dispatched_at>now()-interval '1835 seconds'
    or exists(select 1 from unfurl.ai_provider_responses where operation_id=op.id)
  then raise exception 'Probe transport is not eligible for retirement' using errcode='55000'; end if;
  insert into unfurl.ai_provider_attempt_retirements(operation_id,kind,request_digest,retained_micro_usd)
    values(op.id,'ended_probe',op.request_digest,op.reserved_micro_usd);
end;
$$;

create function unfurl.authorize_ambiguous_decision_retry(p_operation_id uuid,p_actor_id uuid,p_job_id uuid,p_step_id uuid,p_epoch integer,p_model_policy text,p_reader_policy_digest text)
returns void language plpgsql security definer set search_path='' as $$
declare op unfurl.ai_provider_operations%rowtype; job unfurl.execution_jobs%rowtype; step unfurl.run_steps%rowtype;
begin
  select * into job from unfurl.execution_jobs where id=p_job_id for update;
  select * into step from unfurl.run_steps where id=p_step_id and job_id=p_job_id for update;
  select * into op from unfurl.ai_provider_operations where id=p_operation_id and run_step_id=p_step_id;
  perform 1 from unfurl.ai_budgets where id=op.budget_id for update;
  select * into op from unfurl.ai_provider_operations where id=p_operation_id and run_step_id=p_step_id for update;
  if job.id is null or step.id is null or op.id is null or job.status<>'failed' or step.status<>'failed'
    or p_epoch is null or job.retry_epoch<>p_epoch or step.step_key!~'^agent\.v1:[0-9]{6}:decision$'
    or coalesce(job.lease_expires_at>now(),false) or coalesce(step.lease_expires_at>now(),false)
    or op.purpose<>'turn_planning' or op.state<>'unknown' or op.attempt<>1 or op.dispatched_at is null
    or p_model_policy is null or p_model_policy not in ('kimi-digitalocean-v1','gemini-flash-google-v1')
    or p_reader_policy_digest is null or p_reader_policy_digest!~'^[a-f0-9]{64}$'
    or op.safe_failure_code is null or op.safe_failure_code not in ('timeout','unavailable','cancelled')
    or exists(select 1 from unfurl.ai_provider_responses where operation_id=op.id)
    or not exists(select 1 from unfurl.agent_turn_runs r join unfurl.conversations c on c.id=r.conversation_id
      where r.id=job.agent_turn_run_id and r.owner_id=p_actor_id and c.owner_id=p_actor_id and c.deleted_at is null
      and r.status='failed' and c.active_branch_id=r.branch_id
      and r.id=(select latest.id from unfurl.agent_turn_runs latest where latest.conversation_id=r.conversation_id
        and latest.branch_id=r.branch_id order by latest.created_at desc,latest.id desc limit 1))
  then raise exception 'Ambiguous decision retry authorization failed' using errcode='40001'; end if;
  insert into unfurl.ai_provider_attempt_retirements(operation_id,kind,actor_id,job_id,step_id,from_epoch,to_epoch,
      input_digest,schema_digest,request_digest,retained_micro_usd,authorized_model_policy,reader_policy_digest)
    values(op.id,'explicit_decision_retry',p_actor_id,job.id,step.id,p_epoch,p_epoch+1,
      step.input_digest,step.schema_digest,op.request_digest,op.reserved_micro_usd,p_model_policy,p_reader_policy_digest);
end;
$$;
create or replace function unfurl.advance_execution_job_retry(
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
  if not found or p_expected_epoch is null or job.retry_epoch <> p_expected_epoch or job.status not in ('waiting','failed') then
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
    where s.job_id=job.id and o.state in ('reserved','dispatched','unknown') and not exists(
      select 1 from unfurl.ai_provider_attempt_retirements a where a.operation_id=o.id and a.kind='explicit_decision_retry'
        and a.job_id=job.id and a.actor_id=p_actor_id and ((a.from_epoch=job.retry_epoch and a.to_epoch=job.retry_epoch+1)
          or exists(select 1 from unfurl.execution_job_retry_receipts previous where previous.job_id=a.job_id and previous.from_epoch=a.from_epoch
            and previous.to_epoch=a.to_epoch and previous.actor_id=a.actor_id and previous.to_epoch<=job.retry_epoch))
        and a.request_digest=o.request_digest and a.retained_micro_usd=o.reserved_micro_usd)
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

create or replace function unfurl.guard_retry_receipt_no_held_cost() returns trigger language plpgsql set search_path='' as $$
begin
  if exists(select 1 from unfurl.ai_provider_operations o join unfurl.run_steps s on s.id=o.run_step_id
    where s.job_id=new.job_id and o.state in ('reserved','dispatched','unknown') and not exists(
      select 1 from unfurl.ai_provider_attempt_retirements a where a.operation_id=o.id and a.kind='explicit_decision_retry'
        and a.job_id=new.job_id and a.actor_id=new.actor_id and ((a.from_epoch=new.from_epoch and a.to_epoch=new.to_epoch)
          or exists(select 1 from unfurl.execution_job_retry_receipts previous where previous.job_id=a.job_id and previous.from_epoch=a.from_epoch
            and previous.to_epoch=a.to_epoch and previous.actor_id=a.actor_id and previous.to_epoch<=new.from_epoch))
        and a.request_digest=o.request_digest and a.retained_micro_usd=o.reserved_micro_usd))
  then raise exception 'Execution retry has a held provider reservation' using errcode='55000'; end if;
  return new;
end;
$$;
revoke all on function unfurl.retire_ended_provider_probe(uuid),unfurl.authorize_ambiguous_decision_retry(uuid,uuid,uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function unfurl.retire_ended_provider_probe(uuid),unfurl.authorize_ambiguous_decision_retry(uuid,uuid,uuid,uuid,integer,text,text) to service_role;
