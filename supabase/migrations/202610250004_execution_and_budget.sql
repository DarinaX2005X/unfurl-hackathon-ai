-- Runtime/accounting foundation. Provider calls happen only after a committed
-- reservation and dispatch CAS; this migration does not invoke any provider.
alter table unfurl.execution_jobs
  add column status text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column lease_owner text check (lease_owner is null or length(lease_owner) between 1 and 128),
  add column lease_expires_at timestamptz,
  add column fencing_token bigint not null default 0 check (fencing_token >= 0),
  add column updated_at timestamptz not null default now(),
  add column safe_error jsonb check (safe_error is null or (jsonb_typeof(safe_error) = 'object' and octet_length(safe_error::text) <= 16384));
alter table unfurl.execution_jobs add constraint execution_job_lease
  check ((status = 'running' and lease_owner is not null and lease_expires_at is not null)
    or (status <> 'running' and lease_owner is null and lease_expires_at is null));
create index execution_jobs_recovery on unfurl.execution_jobs(status, lease_expires_at, id)
  where status in ('queued', 'running', 'waiting');

-- Zero is an explicit legacy/unavailable marker, not reusable capability proof.
alter table unfurl.run_steps
  add column schema_digest text not null default repeat('0', 64) check (schema_digest ~ '^[a-f0-9]{64}$'),
  add column capability_digest text not null default repeat('0', 64) check (capability_digest ~ '^[a-f0-9]{64}$'),
  add column validation_policy_digest text not null default repeat('0', 64) check (validation_policy_digest ~ '^[a-f0-9]{64}$');
alter table unfurl.run_steps
  alter column schema_digest drop default,
  alter column capability_digest drop default,
  alter column validation_policy_digest drop default,
  add constraint run_step_result_bound check (result_reference is null or octet_length(result_reference::text) <= 2097152),
  add constraint run_step_error_bound check (error is null or (jsonb_typeof(error) = 'object' and octet_length(error::text) <= 16384)),
  add constraint run_step_lease_pair check ((lease_owner is null) = (lease_expires_at is null));

alter table unfurl.outbox
  add column fencing_token bigint not null default 0 check (fencing_token >= 0),
  add column updated_at timestamptz not null default now(),
  add column safe_error jsonb check (safe_error is null or (jsonb_typeof(safe_error) = 'object' and octet_length(safe_error::text) <= 16384)),
  add constraint outbox_lease_pair check ((lease_owner is null) = (lease_expires_at is null));

create table unfurl.ai_budgets (
  id uuid primary key,
  campaign_key text not null unique check (length(campaign_key) between 1 and 120),
  hard_limit_micro_usd bigint not null default 10000000 check (hard_limit_micro_usd = 10000000),
  spendable_limit_micro_usd bigint not null default 9500000 check (spendable_limit_micro_usd = 9500000),
  settled_micro_usd bigint not null default 0 check (settled_micro_usd >= 0),
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  halted boolean not null default false,
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One deployment campaign. A new account/run/retry cannot acquire another cap.
create unique index one_ai_budget_campaign on unfurl.ai_budgets ((true));

create table unfurl.ai_provider_operations (
  id uuid primary key,
  budget_id uuid not null references unfurl.ai_budgets(id) on delete restrict,
  logical_operation_id uuid not null,
  attempt integer not null check (attempt >= 1),
  run_step_id uuid references unfurl.run_steps(id) on delete set null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  purpose text not null check (purpose in ('turn_planning', 'source_extraction', 'curriculum', 'module_knowledge',
    'task_authoring', 'content_review', 'rubric_grading', 'activity_dialogue', 'web_search', 'capability_probe')),
  state text not null check (state in ('reserved', 'dispatched', 'unknown', 'settled', 'released')),
  reserved_micro_usd bigint not null check (reserved_micro_usd > 0),
  actual_micro_usd bigint check (actual_micro_usd >= 0),
  model_id text not null check (model_id = 'moonshotai/kimi-k2.6'),
  provider_tag text not null check (provider_tag = 'digitalocean'),
  provider_request_id text check (provider_request_id is null or length(provider_request_id) between 1 and 256),
  rate_card_digest text not null check (rate_card_digest ~ '^[a-f0-9]{64}$'),
  rate_card jsonb not null check (jsonb_typeof(rate_card) = 'object' and octet_length(rate_card::text) <= 65536),
  dispatched_at timestamptz,
  settled_at timestamptz,
  safe_failure_code text check (safe_failure_code in ('unavailable', 'timeout', 'rate_limited', 'invalid_output', 'refused', 'budget_exhausted', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (logical_operation_id, attempt),
  check ((state = 'settled' and actual_micro_usd is not null and settled_at is not null and dispatched_at is not null)
    or (state <> 'settled' and actual_micro_usd is null and settled_at is null)),
  check ((state in ('reserved', 'released') and dispatched_at is null)
    or (state in ('dispatched', 'unknown', 'settled') and dispatched_at is not null))
);
create unique index ai_provider_request_identity on unfurl.ai_provider_operations(provider_request_id) where provider_request_id is not null;
create index ai_provider_operations_held on unfurl.ai_provider_operations(budget_id, purpose, id)
  where state in ('reserved', 'dispatched', 'unknown');

create table unfurl.ai_provider_responses (
  operation_id uuid primary key references unfurl.ai_provider_operations(id) on delete restrict,
  provider_request_id text check (provider_request_id is null or length(provider_request_id) between 1 and 256),
  response_digest text not null check (response_digest ~ '^[a-f0-9]{64}$'),
  reported_cost_usd text check (reported_cost_usd is null or
    (length(reported_cost_usd) <= 100 and reported_cost_usd ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$')),
  usage jsonb not null check (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 65536),
  result jsonb check (result is null or octet_length(result::text) <= 2097152),
  received_at timestamptz not null default now()
);

create table unfurl.ai_budget_entries (
  id uuid primary key,
  budget_id uuid not null references unfurl.ai_budgets(id) on delete restrict,
  operation_id uuid not null references unfurl.ai_provider_operations(id) on delete restrict,
  effect_key text not null unique check (length(effect_key) between 1 and 256),
  kind text not null check (kind in ('reserve', 'release', 'settle', 'reconcile')),
  reserved_delta_micro_usd bigint not null,
  settled_delta_micro_usd bigint not null,
  evidence_digest text check (evidence_digest is null or evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create index ai_budget_entries_campaign on unfurl.ai_budget_entries(budget_id, created_at, id);

create table unfurl.execution_capability_receipts (
  id uuid primary key,
  capability text not null check (capability in ('budget_accounting', 'model_structured', 'model_text', 'research_search', 'rubric', 'run_recovery', 'dispatcher')),
  world text not null check (world in ('local', 'vercel')),
  configuration_digest text not null check (configuration_digest ~ '^[a-f0-9]{64}$'),
  test_version text not null check (length(test_version) between 1 and 80),
  passed boolean not null,
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 65536),
  observed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  instance_id text not null check (length(instance_id) between 1 and 128),
  check (expires_at > observed_at),
  check (capability <> 'dispatcher' or expires_at <= observed_at + interval '120 seconds')
);
create index execution_capability_latest on unfurl.execution_capability_receipts(capability, world, configuration_digest, observed_at desc, id desc);

create function unfurl.reject_immutable_change() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Immutable receipt cannot be changed' using errcode = '23514';
end;
$$;
create trigger ai_response_immutable before update or delete on unfurl.ai_provider_responses
  for each row execute function unfurl.reject_immutable_change();
create trigger ai_budget_entry_immutable before update or delete on unfurl.ai_budget_entries
  for each row execute function unfurl.reject_immutable_change();
create trigger execution_capability_immutable before update or delete on unfurl.execution_capability_receipts
  for each row execute function unfurl.reject_immutable_change();
create trigger ai_budget_no_delete before delete on unfurl.ai_budgets
  for each row execute function unfurl.reject_immutable_change();
create trigger ai_operation_no_delete before delete on unfurl.ai_provider_operations
  for each row execute function unfurl.reject_immutable_change();

create function unfurl.guard_provider_operation() returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.id, new.budget_id, new.logical_operation_id, new.attempt, new.request_digest, new.purpose,
      new.reserved_micro_usd, new.model_id, new.provider_tag, new.rate_card_digest, new.rate_card, new.created_at)
    is distinct from row(old.id, old.budget_id, old.logical_operation_id, old.attempt, old.request_digest, old.purpose,
      old.reserved_micro_usd, old.model_id, old.provider_tag, old.rate_card_digest, old.rate_card, old.created_at) then
    raise exception 'Provider operation identity is immutable' using errcode = '23514';
  end if;
  if old.provider_request_id is not null and new.provider_request_id is distinct from old.provider_request_id then
    raise exception 'Provider request identity is immutable' using errcode = '23514';
  end if;
  if old.dispatched_at is not null and new.dispatched_at is distinct from old.dispatched_at then
    raise exception 'Dispatch evidence cannot be cleared' using errcode = '23514';
  end if;
  if new.state <> old.state and not (
    (old.state = 'reserved' and new.state in ('dispatched', 'released'))
    or (old.state = 'dispatched' and new.state in ('unknown', 'settled'))
    or (old.state = 'unknown' and new.state = 'settled')
  ) then
    raise exception 'Invalid provider operation transition' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger provider_operation_guard before update on unfurl.ai_provider_operations
  for each row execute function unfurl.guard_provider_operation();

do $$ declare table_name text; begin
  foreach table_name in array array['ai_budgets', 'ai_provider_operations', 'ai_provider_responses', 'ai_budget_entries', 'execution_capability_receipts'] loop
    execute format('alter table unfurl.%I enable row level security', table_name);
    execute format('alter table unfurl.%I force row level security', table_name);
    execute format('revoke all on unfurl.%I from public, anon, authenticated', table_name);
    execute format('grant all on unfurl.%I to service_role', table_name);
  end loop;
end $$;
revoke all on function unfurl.reject_immutable_change(), unfurl.guard_provider_operation() from public;
