-- Preserve V1 requests and append a separately identifiable native grammar policy.
alter table unfurl.ai_provider_attempt_retirements drop constraint ai_provider_attempt_retirements_check;
alter table unfurl.ai_provider_attempt_retirements add constraint ai_provider_attempt_retirements_binding_check check ((kind='ended_probe' and actor_id is null and job_id is null and step_id is null and from_epoch is null and to_epoch is null)
    or (kind='explicit_decision_retry' and actor_id is not null and job_id is not null and step_id is not null
      and from_epoch is not null and to_epoch is not null and from_epoch>=0 and to_epoch=from_epoch+1 and authorized_model_policy is not null and authorized_model_policy in ('kimi-digitalocean-v1','gemini-flash-google-v1','gemini-flash-google-schema-v2')
      and reader_policy_digest is not null and reader_policy_digest ~ '^[a-f0-9]{64}$' and input_digest is not null and schema_digest is not null));

create or replace function unfurl.authorize_ambiguous_decision_retry(p_operation_id uuid,p_actor_id uuid,p_job_id uuid,p_step_id uuid,p_epoch integer,p_model_policy text,p_reader_policy_digest text)
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
    or p_model_policy is null or p_model_policy not in ('kimi-digitalocean-v1','gemini-flash-google-v1','gemini-flash-google-schema-v2')
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
