-- An explicit first-party excerpt can expose one fully generated section while
-- preserving its stopped full-course run and original approved program.
alter table unfurl.course_versions add column release_metadata jsonb;
alter table unfurl.course_versions add constraint course_release_metadata_shape check (
  release_metadata is null or (state = 'ready' and jsonb_typeof(release_metadata) = 'object'
    and release_metadata->>'kind' = 'official-section-preview-v1'
    and release_metadata->>'publisher' = 'Unfurl')
);

create or replace function unfurl.validate_ready_version() returns trigger language plpgsql set search_path = '' as $$
declare
  receipt jsonb;
  approved_document jsonb;
  expected_outcomes jsonb;
  completed_module jsonb;
begin
  if new.state <> 'ready' then return new; end if;
  select v.document into receipt from unfurl.version_validation_receipts v
    where v.id = new.validation_receipt_id and v.course_version_id = new.id and v.verdict = 'passed';
  if receipt is null then
    raise exception 'A ready version needs successful validation' using errcode = '23514';
  end if;
  if (select count(*) from unfurl.lessons l where l.id = any(new.lesson_ids) and l.course_version_id = new.id) <> cardinality(new.lesson_ids) then
    raise exception 'A ready version must reference its saved lessons' using errcode = '23514';
  end if;
  if new.release_metadata is null then
    if not exists (select 1 from unfurl.generation_runs r where r.id = new.source_run_id and r.status = 'succeeded'
      and r.output_version_id = new.id and r.course_id = new.course_id) then
      raise exception 'A ready version needs its completed generation job' using errcode = '23514';
    end if;
    return new;
  end if;

  -- This separate release never relabels a stopped source run as a successful full build.
  select revision.document into approved_document
    from unfurl.generation_runs run
    join unfurl.courses course on course.id = run.course_id and course.owner_id = run.owner_id
    join unfurl.curriculum_approvals approval on approval.id = run.approval_id and approval.approved_by = run.owner_id
    join unfurl.curriculum_revisions revision on revision.draft_id = approval.draft_id
      and revision.revision = approval.draft_revision and revision.content_digest = approval.content_digest
    join unfurl.execution_jobs job on job.generation_run_id = run.id
    where run.id = new.source_run_id and run.course_id = new.course_id and run.approval_id = new.approval_id
      and run.source_draft_revision = approval.draft_revision and approval.content_digest = new.content_digest
      and run.status in ('failed','cancelled') and run.output_version_id is null and job.status in ('failed','cancelled')
      and not exists (select 1 from unfurl.run_steps step where step.job_id = job.id and step.status in ('pending','running'))
      and not exists (select 1 from unfurl.generation_runs active where active.course_id = new.course_id and active.status in ('queued','running','awaiting_user'));
  if approved_document is null or jsonb_array_length(approved_document->'modules') < 2 then
    raise exception 'A section preview needs an unchanged stopped source build' using errcode = '23514';
  end if;
  select jsonb_agg(outcome.value order by outcome.ordinality) into expected_outcomes
    from jsonb_array_elements(approved_document->'outcomes') with ordinality outcome(value, ordinality)
    where (approved_document#>'{modules,0,outcomeIds}') ? (outcome.value->>'id');
  select step.result_reference->'module' into completed_module
    from unfurl.run_steps step join unfurl.execution_jobs job on job.id = step.job_id
    where job.generation_run_id = new.source_run_id and step.id::text = new.release_metadata->>'completedStepId'
      and step.status = 'succeeded' and step.approval_digest = new.content_digest
      and step.result_reference->>'kind' = 'course.module.completed';
  if new.release_metadata->>'kind' is distinct from 'official-section-preview-v1'
    or new.release_metadata->>'publisher' is distinct from 'Unfurl'
    or new.release_metadata->>'sourceRunId' is distinct from new.source_run_id::text
    or new.release_metadata->>'courseVersionId' is distinct from new.id::text
    or new.release_metadata->>'approvalId' is distinct from new.approval_id::text
    or new.release_metadata->>'approvalDigest' is distinct from new.content_digest
    or new.release_metadata#>'{presentation,plannedModules}' is distinct from approved_document->'modules'
    or new.release_metadata#>'{presentation,availableModuleIds}' is distinct from jsonb_build_array(approved_document#>>'{modules,0,id}')
    or new.modules is distinct from jsonb_build_array(approved_document#>'{modules,0}')
    or new.outcomes is distinct from expected_outcomes
    or completed_module is null
    or completed_module->>'moduleId' is distinct from approved_document#>>'{modules,0,id}'
    or completed_module->>'moduleDigest' is distinct from new.release_metadata->>'moduleDigest'
    or receipt->>'validatorVersion' is distinct from 'official-section-preview-v1'
    or receipt->>'approvalDigest' is distinct from new.content_digest
    or receipt->>'sourceRunId' is distinct from new.source_run_id::text
    or receipt->>'completedStepId' is distinct from new.release_metadata->>'completedStepId'
    or receipt->>'contentDigest' is distinct from new.release_metadata->>'releaseDigest'
    or receipt#>'{scope,availableModuleIds}' is distinct from new.release_metadata#>'{presentation,availableModuleIds}'
    or receipt->>'normalRouteValidated' is distinct from 'true'
    or receipt->>'adaptiveMaterialValidated' is distinct from 'true' then
    raise exception 'Section preview metadata and validation must match the original completed section' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function unfurl.validate_ready_version() from public;
