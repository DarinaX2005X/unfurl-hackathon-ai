-- Python plan/ownership proof comes from the account API under a dedicated
-- read credential. OIDC authenticates runtime requests but is not plan evidence.
alter table unfurl.execution_capability_receipts
  drop constraint python_capability_environment,
  add column sandbox_project_id text check (sandbox_project_id is null or length(sandbox_project_id) between 1 and 128),
  add column sandbox_project_owner_id text check (sandbox_project_owner_id is null or length(sandbox_project_owner_id) between 1 and 128),
  add column sandbox_team_status text check (sandbox_team_status is null or sandbox_team_status = 'active'),
  add column sandbox_team_blocked boolean,
  add constraint python_capability_environment check (
    (capability = 'python_sandbox'
      and num_nonnulls(sandbox_team_id, sandbox_project_id, sandbox_project_owner_id, sandbox_runtime_profile,
        sandbox_image, sandbox_image_digest, sandbox_runner_digest, sandbox_plan, sandbox_team_status,
        sandbox_team_blocked) = 10
      and sandbox_project_owner_id = sandbox_team_id and sandbox_team_blocked = false)
    or (capability <> 'python_sandbox'
      and num_nonnulls(sandbox_team_id, sandbox_project_id, sandbox_project_owner_id, sandbox_runtime_profile,
        sandbox_image, sandbox_image_digest, sandbox_runner_digest, sandbox_plan, sandbox_team_status,
        sandbox_team_blocked) = 0)
  );
