-- New output captures use the provider's actual completion allowance. Preserve all
-- existing rows and immutable receipt triggers; PostgreSQL's real type/storage
-- limits remain authoritative instead of an application-authored response ceiling.
alter table unfurl.ai_provider_responses drop constraint ai_provider_responses_result_check;
alter table unfurl.run_steps drop constraint run_step_result_bound;
