-- Independent Python executions share the provider's actual Hobby allowance.
-- Current provider quotas: https://vercel.com/docs/sandbox/pricing (2026-10-26).
-- Remove application-only concurrency/day caps; keep each execution's immutable
-- identity, job/step fences, deadline, lifecycle, cleanup proof and audit history.
drop index unfurl.code_execution_one_global_active;
drop index unfurl.code_execution_one_learner_active;

-- Historical counters remain monotonic diagnostics, with no admission ceiling.
alter table unfurl.python_execution_global_daily_quotas
  drop constraint python_execution_global_daily_quotas_reserved_count_check,
  add constraint python_execution_global_daily_quotas_reserved_count_check check (reserved_count >= 1);
alter table unfurl.python_execution_learner_daily_quotas
  drop constraint python_execution_learner_daily_quotas_reserved_count_check,
  add constraint python_execution_learner_daily_quotas_reserved_count_check check (reserved_count >= 1);

comment on table unfurl.python_execution_global_daily_quotas is
  'Monotonic daily Python execution counts for diagnostics; provider quotas govern capacity.';
comment on table unfurl.python_execution_learner_daily_quotas is
  'Monotonic daily learner Python execution counts for diagnostics; no application admission ceiling.';
