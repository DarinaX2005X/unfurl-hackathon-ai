-- Bind authoring validation to both live fences, repair JSON iteration, and
-- prevent a new retry epoch while any provider reservation is still held.

create or replace function unfurl.valid_python_authoring_case_bindings(value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  ids text[] := '{}';
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) not between 1 and 8 then return false; end if;
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
  add column job_lease_owner text not null check (length(job_lease_owner) between 1 and 128),
  add column job_fencing_token bigint not null check (job_fencing_token >= 1),
  add column job_retry_epoch integer not null check (job_retry_epoch >= 0),
  add column step_lease_owner text not null check (length(step_lease_owner) between 1 and 128),
  add column step_fencing_token bigint not null check (step_fencing_token >= 1);

create function unfurl.guard_python_authoring_fences() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from unfurl.execution_jobs j join unfurl.run_steps s on s.id=new.run_step_id and s.job_id=j.id
    where j.id=new.job_id and j.status='running' and j.lease_owner=new.job_lease_owner
      and j.fencing_token=new.job_fencing_token and j.retry_epoch=new.job_retry_epoch
      and j.lease_expires_at>statement_timestamp() and s.status='running'
      and s.lease_owner=new.step_lease_owner and s.fencing_token=new.step_fencing_token
      and s.lease_expires_at>statement_timestamp()
  ) then
    raise exception 'Python authoring fences are stale' using errcode = '40001';
  end if;
  return new;
end;
$$;
create trigger python_authoring_fence_guard before insert on unfurl.python_authoring_validations
  for each row execute function unfurl.guard_python_authoring_fences();

create function unfurl.guard_retry_receipt_no_held_cost() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from unfurl.ai_provider_operations o join unfurl.run_steps s on s.id=o.run_step_id
    where s.job_id=new.job_id and o.state in ('reserved','dispatched','unknown')
  ) then
    raise exception 'Execution retry has a held provider reservation' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger execution_retry_no_held_cost before insert on unfurl.execution_job_retry_receipts
  for each row execute function unfurl.guard_retry_receipt_no_held_cost();

revoke all on function unfurl.guard_python_authoring_fences(),
  unfurl.guard_retry_receipt_no_held_cost() from public;
