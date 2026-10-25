-- Admission is durable even when concurrency or daily quota prevents a run row.
-- This keeps a denied idempotency key from dispatching a VM on a later replay.
create table unfurl.python_execution_admissions (
  idempotency_key uuid primary key,
  execution_id uuid not null unique,
  job_id uuid not null references unfurl.execution_jobs(id) on delete restrict,
  job_lease_owner text not null check (length(job_lease_owner) between 1 and 128),
  job_fencing_token bigint not null check (job_fencing_token >= 1),
  logical_execution_id uuid not null,
  execution_attempt integer not null check (execution_attempt >= 1),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('assessing', 'dispatch', 'unavailable')),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 2097152)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (logical_execution_id, execution_attempt),
  check ((state = 'unavailable') = (result is not null))
);

create function unfurl.guard_python_execution_admission() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Python admission receipts are immutable' using errcode = '23514';
  end if;
  if row(new.idempotency_key, new.execution_id, new.job_id, new.job_lease_owner, new.job_fencing_token,
      new.logical_execution_id, new.execution_attempt, new.request_digest, new.created_at)
    is distinct from row(old.idempotency_key, old.execution_id, old.job_id, old.job_lease_owner, old.job_fencing_token,
      old.logical_execution_id, old.execution_attempt, old.request_digest, old.created_at) then
    raise exception 'Python admission identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'assessing' or new.state not in ('dispatch', 'unavailable') then
    raise exception 'Python admission outcome is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger python_execution_admission_guard before update or delete on unfurl.python_execution_admissions
  for each row execute function unfurl.guard_python_execution_admission();

alter table unfurl.python_execution_admissions enable row level security;
alter table unfurl.python_execution_admissions force row level security;
revoke all on unfurl.python_execution_admissions from public, anon, authenticated;
grant all on unfurl.python_execution_admissions to service_role;
revoke all on function unfurl.guard_python_execution_admission() from public;
