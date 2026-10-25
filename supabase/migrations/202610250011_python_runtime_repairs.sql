-- Post-009 additive repair: pin the proven Python 3.14.4 runtime, persist its
-- session identity, and admit quota before immediate foreign-key checks.

alter table unfurl.execution_capability_receipts
  add constraint python_capability_pinned_runtime check (capability <> 'python_sandbox' or (
    sandbox_runtime_profile = 'python_stdlib_v1'
    and sandbox_image = 'vercel/sandbox/python@sha256:3bc79de820271c18e2506c132ce20cc15c6215c0ae5725575b1d8e37ecca0218'
  ));

alter table unfurl.code_execution_runs
  drop constraint code_execution_runs_runtime_profile_check,
  drop constraint code_execution_runs_runtime_image_check,
  add column provider_session_id text check (provider_session_id is null or length(provider_session_id) between 1 and 256),
  add constraint code_execution_runtime_profile check (runtime_profile = 'python_stdlib_v1'),
  add constraint code_execution_runtime_image check (
    runtime_image = 'vercel/sandbox/python@sha256:3bc79de820271c18e2506c132ce20cc15c6215c0ae5725575b1d8e37ecca0218'
  ),
  add constraint code_execution_provider_session check (
    (provider_sandbox_id is null and provider_session_id is null and sandbox_created_at is null)
    or (provider_sandbox_id is not null and provider_session_id is not null and sandbox_created_at is not null)
  );

create function unfurl.guard_code_execution_session() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.provider_session_id is not null
    and new.provider_session_id is distinct from old.provider_session_id then
    raise exception 'Sandbox session identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger code_execution_session_guard before insert or update on unfurl.code_execution_runs
  for each row execute function unfurl.guard_code_execution_session();

drop trigger code_execution_quota on unfurl.code_execution_runs;
create trigger code_execution_quota before insert on unfurl.code_execution_runs
  for each row execute function unfurl.reserve_python_daily_quota();

revoke all on function unfurl.guard_code_execution_session() from public;
