-- Separate site traffic and verification accounting without changing historical balances.
-- Activation is a separate reviewed operator transaction. No historical money moves here.
drop index unfurl.one_ai_budget_campaign;
alter table unfurl.ai_budgets
  add column kind text not null default 'verification' check (kind in ('verification','site')),
  drop constraint ai_budgets_hard_limit_micro_usd_check,
  drop constraint ai_budgets_spendable_limit_micro_usd_check,
  alter column hard_limit_micro_usd drop not null,
  alter column spendable_limit_micro_usd drop not null,
  add constraint ai_budget_funding_limits check (
    (kind='verification' and hard_limit_micro_usd=20000000 and spendable_limit_micro_usd=19500000
      and hard_limit_micro_usd is not null and spendable_limit_micro_usd is not null)
    or (kind='site' and hard_limit_micro_usd is null and spendable_limit_micro_usd is null));
create unique index one_ai_budget_per_kind on unfurl.ai_budgets(kind);

create table unfurl.ai_funding_configuration (
  singleton boolean primary key default true check (singleton),
  version text not null check (version='actor-funding-v1'),
  verification_budget_id uuid not null references unfurl.ai_budgets(id) on delete restrict,
  site_budget_id uuid not null references unfurl.ai_budgets(id) on delete restrict,
  verification_actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (verification_budget_id<>site_budget_id)
);
alter table unfurl.execution_jobs add column funding_version text check (funding_version='actor-funding-v1');
create table unfurl.execution_job_funding (
  job_id uuid primary key references unfurl.execution_jobs(id) on delete restrict,
  actor_id uuid not null,
  budget_id uuid not null references unfurl.ai_budgets(id) on delete restrict,
  kind text not null check (kind in ('verification','site')),
  target_digest text not null check (target_digest ~ '^[a-f0-9]{64}$'),
  version text not null check (version='actor-funding-v1'),
  captured_at timestamptz not null default now()
);
create function unfurl.guard_ai_funding_configuration() returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from unfurl.ai_budgets where id=new.verification_budget_id and kind='verification')
    or not exists(select 1 from unfurl.ai_budgets where id=new.site_budget_id and kind='site') then
    raise exception 'Invalid funding ledgers' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger ai_funding_configuration_guard before insert on unfurl.ai_funding_configuration
  for each row execute function unfurl.guard_ai_funding_configuration();
create trigger ai_funding_configuration_immutable before update or delete on unfurl.ai_funding_configuration
  for each row execute function unfurl.reject_immutable_change();
create trigger execution_job_funding_immutable before update or delete on unfurl.execution_job_funding
  for each row execute function unfurl.reject_immutable_change();

create function unfurl.guard_ai_budget_kind() returns trigger language plpgsql set search_path='' as $$
begin
  if row(new.id,new.kind,new.hard_limit_micro_usd,new.spendable_limit_micro_usd)
    is distinct from row(old.id,old.kind,old.hard_limit_micro_usd,old.spendable_limit_micro_usd) then
    raise exception 'Funding identity is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger ai_budget_kind_immutable before update on unfurl.ai_budgets
  for each row execute function unfurl.guard_ai_budget_kind();

create function unfurl.mark_execution_job_funding() returns trigger language plpgsql set search_path='' as $$
begin
  if TG_OP='INSERT' then
    select version into new.funding_version from unfurl.ai_funding_configuration where singleton;
  elsif row(new.id,new.funding_version,new.agent_turn_run_id,new.generation_run_id,new.evaluation_id,new.target_evaluation_revision,new.activity_action_id)
    is distinct from row(old.id,old.funding_version,old.agent_turn_run_id,old.generation_run_id,old.evaluation_id,old.target_evaluation_revision,old.activity_action_id) then
    raise exception 'Execution funding target is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger execution_job_funding_target before insert or update on unfurl.execution_jobs
  for each row execute function unfurl.mark_execution_job_funding();

create function unfurl.guard_execution_job_funding() returns trigger language plpgsql set search_path='' as $$
declare actor uuid; marker text; config unfurl.ai_funding_configuration%rowtype;
begin
  select coalesce(t.owner_id,g.owner_id,a.learner_id,e.learner_id),j.funding_version into actor,marker
    from unfurl.execution_jobs j
    left join unfurl.agent_turn_runs t on t.id=j.agent_turn_run_id
    left join unfurl.generation_runs g on g.id=j.generation_run_id
    left join unfurl.evaluations v on v.id=j.evaluation_id left join unfurl.attempts a on a.id=v.attempt_id
    left join unfurl.activity_actions aa on aa.id=j.activity_action_id
    left join unfurl.activity_sessions s on s.id=aa.activity_session_id left join unfurl.enrollments e on e.id=s.enrollment_id
    where j.id=new.job_id;
  select * into config from unfurl.ai_funding_configuration where singleton;
  if config.singleton is null or marker is distinct from new.version or actor is distinct from new.actor_id
    or new.kind is distinct from (case when actor=config.verification_actor_id then 'verification' else 'site' end)
    or new.budget_id is distinct from (case when actor=config.verification_actor_id then config.verification_budget_id else config.site_budget_id end) then
    raise exception 'Invalid immutable execution funding' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger execution_job_funding_guard before insert on unfurl.execution_job_funding
  for each row execute function unfurl.guard_execution_job_funding();
create function unfurl.require_execution_job_funding() returns trigger language plpgsql set search_path='' as $$
begin
  if new.funding_version is not null and not exists(select 1 from unfurl.execution_job_funding where job_id=new.id and version=new.funding_version) then
    raise exception 'Execution funding must be captured atomically' using errcode='23514';
  end if;
  return null;
end;
$$;
create constraint trigger execution_job_funding_required after insert on unfurl.execution_jobs
  deferrable initially deferred for each row execute function unfurl.require_execution_job_funding();

-- Direct ledger calls must preserve each operation's assigned funding scope.
create function unfurl.guard_provider_operation_funding() returns trigger language plpgsql set search_path='' as $$
declare config unfurl.ai_funding_configuration%rowtype; expected uuid; marker text; ledger_kind text;
begin
  select * into config from unfurl.ai_funding_configuration where singleton;
  select kind into ledger_kind from unfurl.ai_budgets where id=new.budget_id;
  if new.purpose='capability_probe' then
    if new.run_step_id is not null or ledger_kind<>'verification' then
      raise exception 'Probes require verification funding' using errcode='23514';
    end if;
  elsif config.singleton is not null then
    select j.funding_version,coalesce(f.budget_id,config.verification_budget_id) into marker,expected
      from unfurl.run_steps s join unfurl.execution_jobs j on j.id=s.job_id
      left join unfurl.execution_job_funding f on f.job_id=j.id where s.id=new.run_step_id;
    if expected is null or expected<>new.budget_id or
      (marker is not null and not exists(select 1 from unfurl.run_steps s join unfurl.execution_job_funding f on f.job_id=s.job_id where s.id=new.run_step_id)) then
      raise exception 'Operation funding differs from execution' using errcode='23514';
    end if;
  elsif ledger_kind<>'verification' then
    raise exception 'Site funding is not activated' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger provider_operation_funding_guard before insert on unfurl.ai_provider_operations
  for each row execute function unfurl.guard_provider_operation_funding();
create function unfurl.guard_funding_step_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if TG_TABLE_NAME='run_steps' then
    if row(new.id,new.job_id) is distinct from row(old.id,old.job_id) then
      raise exception 'Funded step identity is immutable' using errcode='23514';
    end if;
  elsif new.run_step_id is distinct from old.run_step_id then
    raise exception 'Operation funding step is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger funding_step_identity before update on unfurl.run_steps
  for each row execute function unfurl.guard_funding_step_identity();
create trigger funding_operation_step_identity before update on unfurl.ai_provider_operations
  for each row execute function unfurl.guard_funding_step_identity();
alter table unfurl.ai_provider_operations add constraint ai_operation_budget_pair unique(id,budget_id);
alter table unfurl.ai_budget_entries add constraint ai_entry_operation_budget
  foreign key(operation_id,budget_id) references unfurl.ai_provider_operations(id,budget_id) on delete restrict;

do $$ declare table_name text; begin
  foreach table_name in array array['ai_funding_configuration','execution_job_funding'] loop
    execute format('alter table unfurl.%I enable row level security',table_name);
    execute format('alter table unfurl.%I force row level security',table_name);
    execute format('revoke all on unfurl.%I from public,anon,authenticated',table_name);
    execute format('grant all on unfurl.%I to service_role',table_name);
  end loop;
end $$;
revoke all on function unfurl.guard_ai_funding_configuration(),unfurl.guard_ai_budget_kind(),
  unfurl.mark_execution_job_funding(),unfurl.guard_execution_job_funding(),unfurl.require_execution_job_funding(),
  unfurl.guard_provider_operation_funding(),unfurl.guard_funding_step_identity() from public;
