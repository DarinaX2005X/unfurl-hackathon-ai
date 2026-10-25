import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

// Live rollback-only proof for migrations 005-020. No provider, VM or HTTP calls.
// node --env-file=.env.local supabase/verify-catalog-learning-schema.mjs --project-ref <ref>
const args = process.argv.slice(2);
const expectedRef = args[args.indexOf("--project-ref") + 1];
const checks = [];
let client;
let phase = "configuration";
const digest = "b".repeat(64);
const pythonImage = "vercel/sandbox/python@sha256:3bc79de820271c18e2506c132ce20cc15c6215c0ae5725575b1d8e37ecca0218";
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const check = (name, condition) => {
  assert.ok(condition, `check_failed:${name}`);
  checks.push(name);
  console.log(JSON.stringify({ check: name, ok: true }));
};
async function rejected(name, sql, values, expectedCodes) {
  await client.query(`SAVEPOINT ${name}`);
  let code;
  let message;
  try { await client.query(sql, values); } catch (error) { code = error.code; message = error.message; }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  if (!expectedCodes.includes(code)) console.error(JSON.stringify({ check: name, observedCode: code ?? null, observedMessage: message ?? null }));
  check(name, expectedCodes.includes(code));
}

try {
  if (!args.includes("--project-ref") || !/^[a-z]{20}$/.test(expectedRef ?? "")) throw new Error("explicit_project_ref_required");
  const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const database = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  if (process.env.SUPABASE_PROJECT_REF !== expectedRef || api.hostname !== `${expectedRef}.supabase.co`
    || !(decodeURIComponent(database.username).endsWith(`.${expectedRef}`) || database.hostname === `db.${expectedRef}.supabase.co`)
    || database.port === "6543") throw new Error("target_project_mismatch_or_transaction_pooler");
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) database.searchParams.delete(name);
  client = new pg.Client({ connectionString: database.toString(), connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n") },
    application_name: "unfurl-learning-schema-proof" });
  await client.connect();
  const receipts = await client.query("SELECT version FROM unfurl_meta.schema_migrations WHERE version = ANY($1::text[])", [
    ["202610250005_catalog_and_learning.sql", "202610250006_learning_traversal.sql", "202610250007_share_contract_repairs.sql", "202610250008_research_provenance.sql", "202610250009_python_execution.sql", "202610250010_validation_receipts.sql", "202610250011_python_runtime_repairs.sql", "202610250012_python_quota_guard.sql", "202610250013_python_capability_authority.sql", "202610250014_python_admission_receipts.sql", "202610250015_python_capability_freshness.sql", "202610250016_execution_retry_epoch.sql", "202610250017_python_authoring_bindings.sql", "202610250018_authoring_fences_and_retry_holds.sql", "202610250019_python_authoring_execution.sql", "202610250020_python_oidc_execution_evidence.sql"],
  ]);
  check("learning_migration_receipts", receipts.rowCount === 16);

  phase = "fixture_graph";
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  const owner = (await client.query("SELECT id FROM auth.users ORDER BY created_at LIMIT 1")).rows[0]?.id;
  if (!owner) throw new Error("qa_identity_required");
  const ids = Object.fromEntries([
    "conversation", "branch", "message", "course", "draft", "approval", "turnRun", "generationRun", "version", "validation",
    "lesson", "outcome", "module", "task", "taskValidation", "enrollment", "activity", "action", "attempt", "evaluation",
    "evidence", "award", "adjustment", "review", "support", "jobEvaluation", "jobAction",
    "versionValidationUncertain", "taskValidationUncertain", "capability", "execution1", "execution2", "execution3",
    "admission", "admissionExecution", "jobGeneration", "candidateStep", "casePlanStep", "authoringStep",
    "authoringValidation", "validationCase", "authoringExecution",
    "source", "passage", "search", "claim", "languageIntent", "searchOperation", "badSearchOperation",
  ].map((name) => [name, randomUUID()]));

  phase = "course_graph";
  await client.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'Learning rollback proof',$3)", [ids.conversation, owner, ids.branch]);
  await client.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)", [ids.branch, ids.conversation]);
  await client.query("INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id) VALUES($1,$2,$3,'user','complete','[]',$4)", [ids.message, ids.conversation, ids.branch, randomUUID()]);
  await client.query(`INSERT INTO unfurl.agent_turn_runs
    (id,owner_id,conversation_id,branch_id,input_message_id,status)
    VALUES($1,$2,$3,$4,$5,'awaiting_user')`, [ids.turnRun, owner, ids.conversation, ids.branch, ids.message]);
  await client.query("INSERT INTO unfurl.courses(id,owner_id,slug,title,summary,content_language,cover) VALUES($1,$2,$3,'Learning proof','Rollback-only course','en',$4)", [ids.course, owner, `learning-proof-${randomUUID()}`, { motifId: "proof", alt: "Proof cover" }]);
  await client.query("INSERT INTO unfurl.curriculum_drafts(id,course_id,conversation_id,revision,document) VALUES($1,$2,$3,1,'{}')", [ids.draft, ids.course, ids.conversation]);
  await client.query("INSERT INTO unfurl.curriculum_revisions(draft_id,revision,content_digest,document) VALUES($1,1,$2,'{}')", [ids.draft, digest]);
  const budgetId = (await client.query("SELECT id FROM unfurl.ai_budgets")).rows[0]?.id;
  if (!budgetId) throw new Error("ai_budget_required");
  await client.query(`INSERT INTO unfurl.ai_provider_operations
    (id,budget_id,logical_operation_id,attempt,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card,dispatched_at,provider_request_id)
    VALUES($1,$2,$3,1,$4,'web_search','unknown',1000,'moonshotai/kimi-k2.6','digitalocean',$4,'{}',now(),$5)`,
  [ids.searchOperation, budgetId, randomUUID(), digest, `research-proof-${randomUUID()}`]);
  await client.query(`INSERT INTO unfurl.ai_provider_operations
    (id,budget_id,logical_operation_id,attempt,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card,dispatched_at,provider_request_id)
    VALUES($1,$2,$3,1,$4,'curriculum','unknown',1000,'moonshotai/kimi-k2.6','digitalocean',$4,'{}',now(),$5)`,
  [ids.badSearchOperation, budgetId, randomUUID(), digest, `research-proof-${randomUUID()}`]);
  await client.query(`INSERT INTO unfurl.research_source_documents
    (id,requested_url,final_url,title,retrieved_at,media_type,raw_digest,extractor_version,content_digest,blocks,extraction_state)
    VALUES($1,'https://example.com/requested','https://example.com/final','Research proof',now(),'text/html',$2,'html-v1',$2,$3,'complete')`,
  [ids.source, digest, JSON.stringify([{ id: "main", text: "Held-out evidence checks generalization." }])]);
  await client.query(`INSERT INTO unfurl.research_passages
    (id,source_id,block_id,start_utf16,end_utf16,quote)
    VALUES($1,$2,'main',0,18,'Held-out evidence')`, [ids.passage, ids.source]);
  await client.query(`INSERT INTO unfurl.research_searches
    (id,operation_id,requested_query,executed_query,content_language,retrieved_at,hits,limitations,request_digest,provider_request_id)
    VALUES($1,$2,'held-out evaluation','held-out evaluation','en',now(),$3,'[]',$4,$5)`,
  [ids.search, ids.searchOperation, JSON.stringify([{ id: randomUUID(), url: "https://example.com/final", title: "Research proof", snippet: "Held-out evidence", publishedAt: null }]), digest, `research-result-${randomUUID()}`]);
  await rejected("research_search_requires_search_purpose", `INSERT INTO unfurl.research_searches
    (id,operation_id,requested_query,content_language,retrieved_at,hits,limitations,request_digest,provider_request_id)
    VALUES($1,$2,'bad purpose','en',now(),'[]','[]',$3,$4)`,
  [randomUUID(), ids.badSearchOperation, digest, `research-result-${randomUUID()}`], ["23514"]);
  await client.query(`INSERT INTO unfurl.source_claims
    (id,owner_id,text,passage_ids,outcome_ids,scope,support,unresolved_conflicts)
    VALUES($1,$2,'Held-out evidence is distinct from fit.',$3,$4,$5,'direct','[]')`,
  [ids.claim, owner, [ids.passage], [ids.outcome], { version: "research-v1", topic: "evaluation" }]);
  await rejected("source_claim_requires_existing_passages", `INSERT INTO unfurl.source_claims
    (id,owner_id,text,passage_ids,scope,support)
    VALUES($1,$2,'Missing passage',$3,'{}','direct')`, [randomUUID(), owner, [randomUUID()]], ["23503"]);
  await client.query(`INSERT INTO unfurl.curriculum_revision_evidence(draft_id,revision,document)
    VALUES($1,1,$2)`, [ids.draft, {
    claimIds: [ids.claim], rationale: "Evidence is sufficient for the planned distinction.",
    outcomeEvidence: [{ outcomeId: ids.outcome, claimIds: [ids.claim], rationale: "Direct support" }],
    moduleEstimates: [{ moduleId: ids.module, minMinutes: 8, maxMinutes: 12, assumptions: ["One focused attempt"] }],
    questionAnswers: [],
  }]);
  await client.query(`INSERT INTO unfurl.course_language_revision_intents
    (run_id,owner_id,course_id,expected_course_revision,draft_id,expected_draft_revision,target_language)
    VALUES($1,$2,$3,1,$4,1,'ru')`, [ids.turnRun, owner, ids.course, ids.draft]);
  await client.query("INSERT INTO unfurl.curriculum_approvals(id,draft_id,draft_revision,content_digest,approved_by) VALUES($1,$2,1,$3,$4)", [ids.approval, ids.draft, digest, owner]);
  await client.query(`INSERT INTO unfurl.generation_runs
    (id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,'validating','running')`,
  [ids.generationRun, owner, ids.course, ids.conversation, ids.branch, ids.message, ids.approval]);
  await rejected("one_initial_generation_per_approval", `INSERT INTO unfurl.generation_runs
    (id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,'validating','queued')`,
  [randomUUID(), owner, ids.course, ids.conversation, ids.branch, ids.message, ids.approval], ["23505"]);
  const outcome = [{ id: ids.outcome, title: "Outcome", demonstration: "Show the distinction", prerequisiteOutcomeIds: [], requirement: "core" }];
  const modules = [{ id: ids.module, title: "Module", summary: "One module", outcomeIds: [ids.outcome], prerequisiteModuleIds: [], estimatedStudyMinutes: 10 }];
  await client.query(`INSERT INTO unfurl.course_versions
    (id,course_id,number,approval_id,source_run_id,content_digest,state,title,summary,content_language,assumed_knowledge,outcomes,modules,cover)
    VALUES($1,$2,1,$3,$4,$5,'building','Learning proof','Immutable metadata','en','[]',$6,$7,$8)`,
  [ids.version, ids.course, ids.approval, ids.generationRun, digest, JSON.stringify(outcome), JSON.stringify(modules), { motifId: "proof", alt: "Proof cover" }]);
  await client.query("INSERT INTO unfurl.version_validation_receipts(id,course_version_id,verdict,document) VALUES($1,$2,'passed','{}')", [ids.validation, ids.version]);
  await client.query("INSERT INTO unfurl.lessons(id,course_version_id,module_id,title,outcome_ids,blocks,task_ids) VALUES($1,$2,$3,'Lesson',$4,'[]',$5)", [ids.lesson, ids.version, ids.module, [ids.outcome], [ids.task]]);
  await client.query(`INSERT INTO unfurl.tasks_public
    (id,task_version,course_version_id,mechanic_id,mechanic_version,outcome_ids,instruction,content_language,config,available_hints,response_schema_version)
    VALUES($1,1,$2,'recall_reconstruction',2,$3,'Reconstruct it','en','{}',1,2)`, [ids.task, ids.version, [ids.outcome]]);
  await client.query("INSERT INTO unfurl.task_validation_receipts(id,task_id,task_version,verdict,document) VALUES($1,$2,1,'passed','{}')", [ids.taskValidation, ids.task]);
  await client.query("INSERT INTO unfurl.version_validation_receipts(id,course_version_id,verdict,document) VALUES($1,$2,'uncertain','{}')", [ids.versionValidationUncertain, ids.version]);
  await client.query("INSERT INTO unfurl.task_validation_receipts(id,task_id,task_version,verdict,document) VALUES($1,$2,1,'uncertain','{}')", [ids.taskValidationUncertain, ids.task]);
  await rejected("version_validation_receipt_immutable", "UPDATE unfurl.version_validation_receipts SET verdict='failed' WHERE id=$1", [ids.versionValidationUncertain], ["23514"]);
  await rejected("task_validation_receipt_immutable", "DELETE FROM unfurl.task_validation_receipts WHERE id=$1", [ids.taskValidationUncertain], ["23514"]);
  await client.query(`INSERT INTO unfurl.tasks_private
    (task_id,task_version,evaluation_spec,source_claim_ids,validation_receipt_id,hints,worked_example,evaluator_data,assessment)
    VALUES($1,1,$2,'{}',$3,$4,'A worked example',$5,$6)`, [ids.task,
    { kind: "deterministic", evaluatorId: "recall_reconstruction", evaluatorVersion: 2, secretConfig: {} }, ids.taskValidation,
    JSON.stringify(["Look at the causal boundary."]), {}, { evidenceGroupId: randomUUID(), role: "required", outcomes: [{ outcomeId: ids.outcome, dimensions: [{ dimensionId: "distinction", evaluationDimensionIds: ["numeric_cases"] }] }] }]);
  const candidateDigest = "1".repeat(64), catalogDigest = "2".repeat(64), source = "def solve(payload):\n    return payload";
  const executionCases = [{ id: "example", input: { value: 1 } }, { id: "held_out", input: { value: 2 } }];
  const sourceDigest = sha256(source), casesDigest = sha256(JSON.stringify(executionCases));
  phase = "authoring_fixture_job";
  await client.query(`INSERT INTO unfurl.execution_jobs
    (id,generation_run_id,status,attempt_count,lease_owner,lease_expires_at,fencing_token)
    VALUES($1,$2,'running',1,'authoring-proof',now()+interval '5 minutes',1)`, [ids.jobGeneration, ids.generationRun]);
  const stepSql = `INSERT INTO unfurl.run_steps
    (id,job_id,step_key,input_digest,approval_digest,schema_digest,capability_digest,validation_policy_digest,
      status,lease_owner,lease_expires_at,fencing_token,result_reference)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)`;
  phase = "authoring_fixture_candidate_step";
  await client.query(stepSql, [ids.candidateStep, ids.jobGeneration, "candidate:proof", digest, digest,
    "3".repeat(64), "4".repeat(64), "5".repeat(64), "succeeded", null, null, {
      kind: "course.task.candidate", moduleId: ids.module, knowledgeStepId: randomUUID(),
      candidate: { approvalDigest: digest, candidateDigest, capabilityCatalogDigest: catalogDigest,
        task: { mechanicId: "artifact_construction", mechanicVersion: 3,
          config: { publicCases: [executionCases[0]] } },
        privateTask: { evaluatorData: { hiddenCases: [{ ...executionCases[1], expected: { value: 2 } }] } } },
      authored: {}, authoringOperationId: randomUUID(),
    }]);
  phase = "authoring_fixture_case_step";
  await client.query(stepSql, [ids.casePlanStep, ids.jobGeneration, "cases:proof", digest, digest,
    "6".repeat(64), "7".repeat(64), "8".repeat(64), "succeeded", null, null, {
      kind: "course.task.cases", candidateStepId: ids.candidateStep, candidateDigest, operationId: randomUUID(),
      cases: [{ caseId: ids.validationCase, key: "valid_case", category: "valid", response: { source } }], alternativeSpaceProof: null,
    }]);
  phase = "authoring_fixture_execution_step";
  await client.query(stepSql, [ids.authoringStep, ids.jobGeneration, "authoring-python:proof", digest, digest,
    "9".repeat(64), "a".repeat(64), "c".repeat(64), "running", "authoring-proof", new Date(Date.now()+300000), null]);
  const authoringCases = [{ id: "example", role: "public", inputDigest: "d".repeat(64), expectedDigest: null },
    { id: "held_out", role: "hidden", inputDigest: "e".repeat(64), expectedDigest: "f".repeat(64) }];
  phase = "authoring_fixture_binding";
  const authoringBindingSql = `INSERT INTO unfurl.python_authoring_validations
    (id,job_id,run_step_id,candidate_step_id,case_plan_step_id,validation_case_id,owner_id,generation_run_id,
      course_id,course_version_id,approval_id,approval_digest,candidate_digest,capability_catalog_digest,source,
      source_digest,cases_digest,case_key,case_category,case_bindings,execution_cases,candidate_step_schema_digest,
      candidate_step_capability_digest,candidate_step_validation_policy_digest,case_plan_schema_digest,
      case_plan_capability_digest,case_plan_validation_policy_digest,execution_schema_digest,
      execution_capability_digest,execution_validation_policy_digest,job_lease_owner,job_fencing_token,
      job_retry_epoch,step_lease_owner,step_fencing_token)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'valid_case','valid',$18,
      $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,'authoring-proof',1,0,'authoring-proof',1)`;
  const authoringBindingValues = (id, boundSourceDigest = sourceDigest, boundCases = executionCases) => [id, ids.jobGeneration, ids.authoringStep,
    ids.candidateStep, ids.casePlanStep, ids.validationCase, owner, ids.generationRun, ids.course, ids.version,
    ids.approval, digest, candidateDigest, catalogDigest, source, boundSourceDigest, casesDigest, JSON.stringify(authoringCases), JSON.stringify(boundCases),
    "3".repeat(64), "4".repeat(64), "5".repeat(64), "6".repeat(64), "7".repeat(64), "8".repeat(64),
    "9".repeat(64), "a".repeat(64), "c".repeat(64)];
  await rejected("python_authoring_source_digest_is_exact", authoringBindingSql,
    authoringBindingValues(randomUUID(), "0".repeat(64)), ["23514"]);
  await rejected("python_authoring_cases_are_exact", authoringBindingSql,
    authoringBindingValues(randomUUID(), sourceDigest, [{ id: "forged", input: null }]), ["23514"]);
  await client.query(authoringBindingSql, authoringBindingValues(ids.authoringValidation));
  await rejected("python_authoring_binding_immutable", "UPDATE unfurl.python_authoring_validations SET source_digest=$2 WHERE id=$1",
    [ids.authoringValidation, "f".repeat(64)], ["23514"]);
  await client.query("UPDATE unfurl.execution_jobs SET fencing_token=2 WHERE id=$1", [ids.jobGeneration]);
  await client.query("UPDATE unfurl.run_steps SET fencing_token=2 WHERE id=$1", [ids.authoringStep]);
  await client.query(`INSERT INTO unfurl.code_execution_runs
    (id,job_id,authoring_validation_id,course_version_id,owner_id,generation_run_id,course_id,approval_id,
      approval_digest,candidate_digest,cases_digest,execution_cases,purpose,logical_execution_id,execution_attempt,
      idempotency_key,request_digest,source_digest,runtime_digest,image_digest,runner_digest,runtime_profile,
      runtime_image,job_lease_owner,job_fencing_token,job_retry_epoch,step_id,step_lease_owner,step_fencing_token,
      quota_day,deadline_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'authoring_validation',$1,1,$13,$14,$15,$16,$17,$18,
      'python_stdlib_v1',$19,'authoring-proof',2,0,$20,'authoring-proof',2,
      (now() at time zone 'UTC')::date,now()+interval '3 minutes','creating')`,
  [ids.authoringExecution, ids.jobGeneration, ids.authoringValidation, ids.version, owner, ids.generationRun,
    ids.course, ids.approval, digest, candidateDigest, casesDigest, JSON.stringify(executionCases), randomUUID(), digest,
    sourceDigest, "d".repeat(64), "e".repeat(64), "f".repeat(64), pythonImage, ids.authoringStep]);
  check("python_authoring_recovery_uses_current_fences",
    (await client.query("SELECT learner_id IS NULL AS scoped FROM unfurl.code_execution_runs WHERE id=$1",
      [ids.authoringExecution])).rows[0]?.scoped === true);
  await client.query(`UPDATE unfurl.code_execution_runs SET status='unavailable',disposition='not_created',
    safe_error='{"code":"proof_complete"}',audit='{"executionResult":{"status":"proof"}}',
    unavailable_at=now(),updated_at=now() WHERE id=$1`, [ids.authoringExecution]);
  check("python_authoring_consumes_global_not_learner_quota",
    (await client.query(`SELECT g.reserved_count=1 AND NOT EXISTS (
      SELECT 1 FROM unfurl.python_execution_learner_daily_quotas l WHERE l.quota_day=g.quota_day AND l.learner_id=$1
    ) AS ok FROM unfurl.python_execution_global_daily_quotas g WHERE g.quota_day=(now() at time zone 'UTC')::date`,
    [owner])).rows[0]?.ok === true);
  phase = "course_graph";
  await client.query("UPDATE unfurl.course_versions SET state='ready',lesson_ids=$2,validation_receipt_id=$3,ready_at=now() WHERE id=$1", [ids.version, [ids.lesson], ids.validation]);
  await client.query("UPDATE unfurl.generation_runs SET status='succeeded',output_version_id=$2 WHERE id=$1", [ids.generationRun, ids.version]);
  await client.query("UPDATE unfurl.courses SET current_ready_version_id=$2,published_version_id=$2,visibility='public' WHERE id=$1", [ids.course, ids.version]);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  check("ready_published_version_graph", (await client.query("SELECT published_version_id=current_ready_version_id AS ok FROM unfurl.courses WHERE id=$1", [ids.course])).rows[0]?.ok === true);
  await rejected("public_course_requires_pointer", "UPDATE unfurl.courses SET published_version_id=null WHERE id=$1", [ids.course], ["23514"]);
  await rejected("nonpublic_course_forbids_pointer", "UPDATE unfurl.courses SET visibility='unlisted' WHERE id=$1", [ids.course], ["23514"]);
  await client.query(`INSERT INTO unfurl.share_grants
    (id,course_id,course_version_id,created_by,token_hash,token_key_version)
    VALUES($1,$2,$3,$4,$5,'1')`, [randomUUID(), ids.course, ids.version, owner, "d".repeat(64)]);
  await rejected("share_key_version_is_bounded_ascii", `INSERT INTO unfurl.share_grants
    (id,course_id,course_version_id,created_by,token_hash,token_key_version)
    VALUES($1,$2,$3,$4,$5,'bad key')`, [randomUUID(), ids.course, ids.version, owner, "e".repeat(64)], ["23514"]);

  phase = "activity_graph";
  await client.query(`INSERT INTO unfurl.enrollments
    (id,learner_id,course_id,course_version_id,current_lesson_id,current_task_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [ids.enrollment, owner, ids.course, ids.version, ids.lesson, ids.task]);
  await client.query("INSERT INTO unfurl.personal_routes(enrollment_id,revision,policy_version,document) VALUES($1,1,'adaptation-v1',$2)", [ids.enrollment,
    { enrollmentId: ids.enrollment, revision: 1, policyVersion: "adaptation-v1", targetOutcomeIds: [ids.outcome], next: [], coveredOutcomeIds: [], pendingOutcomeIds: [ids.outcome] }]);
  await client.query(`INSERT INTO unfurl.activity_sessions
    (id,enrollment_id,task_id,task_version,hidden_state,action_budget,actions_used,status,revision,input_revision)
    VALUES($1,$2,$3,1,'{}',6,0,'active',1,1)`, [ids.activity, ids.enrollment, ids.task]);
  await client.query("INSERT INTO unfurl.activity_inputs(activity_session_id,input_revision,response_digest,response) VALUES($1,1,$2,$3)", [ids.activity, digest, { answer: "saved" }]);
  await client.query(`INSERT INTO unfurl.activity_actions
    (id,activity_session_id,client_action_id,request_digest,action,input_revision,response_digest,session_revision,completed_session_revision,status)
    VALUES($1,$2,$3,$4,$5,1,$4,1,2,'completed')`, [ids.action, ids.activity, randomUUID(), digest, { kind: "prediction.commit" }]);
  await rejected("action_requires_saved_input", `INSERT INTO unfurl.activity_actions
    (id,activity_session_id,client_action_id,request_digest,action,input_revision,response_digest,session_revision,status)
    VALUES($1,$2,$3,$4,$5,1,$6,2,'pending')`, [randomUUID(), ids.activity, randomUUID(), digest, { kind: "run" }, "c".repeat(64)], ["23503"]);
  await rejected("activity_unique_per_task_version", `INSERT INTO unfurl.activity_sessions
    (id,enrollment_id,task_id,task_version,hidden_state,action_budget,actions_used,status,revision)
    VALUES($1,$2,$3,1,'{}',6,0,'active',1)`, [randomUUID(), ids.enrollment, ids.task], ["23505"]);

  phase = "evaluation_graph";
  await client.query(`INSERT INTO unfurl.attempts
    (id,learner_id,enrollment_id,course_version_id,task_id,task_version,client_attempt_id,idempotency_key,response,assistance,hint_ids_used,
     activity_session_id,activity_input_revision,response_digest,request_digest,activity_snapshot,submitted_activity_revision,submitted_route_revision)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,'independent','{}',$9,1,$10,$10,$11,2,1)`,
  [ids.attempt, owner, ids.enrollment, ids.version, ids.task, randomUUID(), randomUUID(), { answer: "saved" }, ids.activity, digest, { session: { id: ids.activity }, input: { inputRevision: 1 } }]);
  await client.query(`INSERT INTO unfurl.evaluations(id,attempt_id,status,outcome,dimensions,feedback,awarded_xp,revision)
    VALUES($1,$2,'evaluated','correct',$3,$4,25,1)`, [ids.evaluation, ids.attempt,
    JSON.stringify([{ id: "numeric_cases", status: "met", explanation: "Matched" }]), { explanation: "Correct", nextAction: "continue" }]);
  await client.query(`INSERT INTO unfurl.evaluation_revisions
    (evaluation_id,attempt_id,revision,status,outcome,dimensions,feedback,awarded_xp)
    VALUES($1,$2,1,'evaluated','correct',$3,$4,25)`, [ids.evaluation, ids.attempt,
    JSON.stringify([{ id: "numeric_cases", status: "met", explanation: "Matched" }]), { explanation: "Correct", nextAction: "continue" }]);
  await client.query(`INSERT INTO unfurl.learner_evidence
    (id,enrollment_id,outcome_id,source,observation,dimension_ids,context,attempt_id,evaluation_id,evaluation_revision,task_id,task_version,evidence_group_id,assistance)
    VALUES($1,$2,$3,$4,'independent_success',$5,$6,$7,$8,1,$9,1,$10,'independent')`,
  [ids.evidence, ids.enrollment, ids.outcome, { kind: "attempt", attemptId: ids.attempt }, ["distinction"], {}, ids.attempt, ids.evaluation, ids.task, randomUUID()]);
  await client.query("INSERT INTO unfurl.xp_awards(id,learner_id,qualifying_evidence_id,policy_version,amount,course_id,task_id) VALUES($1,$2,$3,'xp-v1',25,$4,$5)", [ids.award, owner, ids.evidence, ids.course, ids.task]);
  await rejected("stable_task_xp_unique", "INSERT INTO unfurl.xp_awards(id,learner_id,qualifying_evidence_id,policy_version,amount,course_id,task_id) VALUES($1,$2,$3,'xp-v1',25,$4,$5)", [randomUUID(), owner, ids.evidence, ids.course, ids.task], ["23505"]);
  await client.query("INSERT INTO unfurl.xp_award_adjustments(id,award_id,evaluation_id,evaluation_revision,delta,reason) VALUES($1,$2,$3,1,-25,'evaluation_corrected')", [ids.adjustment, ids.award, ids.evaluation]);
  await client.query("INSERT INTO unfurl.feedback_acknowledgements(attempt_id,evaluation_revision) VALUES($1,1)", [ids.attempt]);
  await rejected("feedback_revision_fk", "INSERT INTO unfurl.feedback_acknowledgements(attempt_id,evaluation_revision) VALUES($1,2)", [ids.attempt], ["23503"]);

  phase = "review_support_graph";
  await client.query(`INSERT INTO unfurl.assessment_review_requests
    (id,attempt_id,evaluation_id,expected_evaluation_revision,reason,comment,status)
    VALUES($1,$2,$3,1,'valid_alternative','Equivalent answer','queued')`, [ids.review, ids.attempt, ids.evaluation]);
  await rejected("review_resolution_all_or_none", `INSERT INTO unfurl.assessment_review_requests
    (id,attempt_id,evaluation_id,expected_evaluation_revision,reason,comment,status,resolution)
    VALUES($1,$2,$3,2,'other','Partial metadata','running','upheld')`, [randomUUID(), ids.attempt, ids.evaluation], ["23514"]);

  await client.query(`INSERT INTO unfurl.support_offers
    (id,enrollment_id,course_version_id,policy_version,based_on_route_revision,target_outcome_id,target_dimension_ids,trigger_kind,reason_code,
     basis_evidence_ids,basis_digest,auto_basis_key,explanation,estimated_study_minutes,return_lesson_id,return_task_id,completion_task_id,completion_dimension_ids,status)
    VALUES($1,$2,$3,'adaptation-v1',1,$4,$5,'auto','additional_practice',$6,$7,$7,'Two independent misses',5,$8,$9,$9,$5,'offered')`,
  [ids.support, ids.enrollment, ids.version, ids.outcome, ["distinction"], [ids.evidence], digest, ids.lesson, ids.task]);
  await client.query("INSERT INTO unfurl.support_offer_tasks(offer_id,slot,course_version_id,lesson_id,task_id,task_version) VALUES($1,0,$2,$3,$4,1)", [ids.support, ids.version, ids.lesson, ids.task]);
  await rejected("one_live_support_per_enrollment", `INSERT INTO unfurl.support_offers
    (id,enrollment_id,course_version_id,policy_version,based_on_route_revision,target_outcome_id,target_dimension_ids,trigger_kind,reason_code,basis_digest,explanation,estimated_study_minutes,return_lesson_id,status)
    VALUES($1,$2,$3,'adaptation-v1',1,$4,$5,'user_request','explanation',$6,'Another live offer',2,$7,'offered')`,
  [randomUUID(), ids.enrollment, ids.version, ids.outcome, ["distinction"], "c".repeat(64), ids.lesson], ["23505"]);

  phase = "execution_and_immutability";
  await client.query("INSERT INTO unfurl.execution_jobs(id,evaluation_id,target_evaluation_revision) VALUES($1,$2,2)", [ids.jobEvaluation, ids.evaluation]);
  await client.query("UPDATE unfurl.assessment_review_requests SET execution_job_id=$2 WHERE id=$1", [ids.review, ids.jobEvaluation]);
  await client.query("INSERT INTO unfurl.execution_jobs(id,activity_action_id) VALUES($1,$2)", [ids.jobAction, ids.action]);
  await rejected("execution_job_exactly_one_target", "INSERT INTO unfurl.execution_jobs(id,evaluation_id,target_evaluation_revision,activity_action_id) VALUES($1,$2,2,$3)", [randomUUID(), ids.evaluation, ids.action], ["23514"]);

  phase = "python_execution_durability";
  await client.query(`INSERT INTO unfurl.execution_capability_receipts
    (id,capability,world,configuration_digest,test_version,passed,evidence_digest,evidence,expires_at,instance_id,
      sandbox_team_id,sandbox_project_id,sandbox_project_owner_id,sandbox_runtime_profile,sandbox_image,
      sandbox_image_digest,sandbox_runner_digest,sandbox_plan,sandbox_team_status,sandbox_team_blocked)
    VALUES($1,'python_sandbox','vercel',$2,'python-v1',true,$2,'{}',now()+interval '5 minutes','rollback-proof',
      'team-proof','project-proof','team-proof','python_stdlib_v1',$3,$2,$2,'hobby','active',false)`, [ids.capability, digest, pythonImage]);
  await rejected("python_capability_binds_environment", `INSERT INTO unfurl.execution_capability_receipts
    (id,capability,world,configuration_digest,test_version,passed,evidence_digest,evidence,expires_at,instance_id)
    VALUES($1,'python_sandbox','vercel',$2,'python-v1',true,$2,'{}',now()+interval '5 minutes','rollback-proof')`,
  [randomUUID(), digest], ["23514"]);
  await client.query(`UPDATE unfurl.execution_jobs SET status='running',attempt_count=1,lease_owner='python-proof',
    lease_expires_at=now()+interval '5 minutes',fencing_token=1 WHERE id=ANY($1::uuid[])`, [[ids.jobEvaluation, ids.jobAction]]);
  await client.query(`INSERT INTO unfurl.python_execution_admissions
    (idempotency_key,execution_id,job_id,job_lease_owner,job_fencing_token,logical_execution_id,execution_attempt,request_digest,state)
    VALUES($1,$2,$3,'python-proof',1,$2,1,$4,'assessing')`, [ids.admission, ids.admissionExecution, ids.jobAction, digest]);
  await client.query(`UPDATE unfurl.python_execution_admissions SET state='unavailable',result='{"status":"quota"}',updated_at=now()
    WHERE idempotency_key=$1`, [ids.admission]);
  await rejected("python_admission_outcome_is_immutable", `UPDATE unfurl.python_execution_admissions
    SET state='dispatch',result=null,updated_at=now() WHERE idempotency_key=$1`, [ids.admission], ["23514"]);

  const actionExecutionSql = `INSERT INTO unfurl.code_execution_runs
    (id,job_id,activity_action_id,learner_id,enrollment_id,course_version_id,task_id,task_version,
      activity_session_id,input_revision,response_digest,execution_cases,purpose,logical_execution_id,execution_attempt,
      retry_of_execution_id,idempotency_key,request_digest,source_digest,runtime_digest,image_digest,runner_digest,
      runtime_profile,runtime_image,job_lease_owner,job_fencing_token,quota_day,deadline_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,1,$9,$19,'public_run',$10,$11,$12,$13,$9,$14,$15,$16,$17,
      'python_stdlib_v1',$18,'python-proof',1,
      (now() at time zone 'UTC')::date,now()+interval '3 minutes','creating')`;
  const actionExecutionValues = (id, logicalId, attempt, retryId, key = randomUUID()) => [
    id, ids.jobAction, ids.action, owner, ids.enrollment, ids.version, ids.task, ids.activity, digest,
    logicalId, attempt, retryId, key, "c".repeat(64), "d".repeat(64), "e".repeat(64), "f".repeat(64), pythonImage,
    JSON.stringify([{ id: "example", input: { value: 1 } }]),
  ];
  await client.query(actionExecutionSql, actionExecutionValues(ids.execution1, ids.execution1, 1, null));
  const firstExecution = (await client.query("SELECT resource_name,status FROM unfurl.code_execution_runs WHERE id=$1", [ids.execution1])).rows[0];
  check("python_resource_name_is_deterministic", firstExecution?.resource_name === `unfurl-py-${ids.execution1.replaceAll("-", "")}` && firstExecution?.status === "creating");
  await rejected("unsafe_retry_while_create_active", actionExecutionSql,
    actionExecutionValues(ids.execution2, ids.execution1, 2, ids.execution1), ["23514"]);

  const gradeExecutionSql = `INSERT INTO unfurl.code_execution_runs
    (id,job_id,attempt_id,learner_id,enrollment_id,course_version_id,task_id,task_version,
      activity_session_id,input_revision,response_digest,execution_cases,purpose,logical_execution_id,execution_attempt,
      idempotency_key,request_digest,source_digest,runtime_digest,image_digest,runner_digest,runtime_profile,runtime_image,
      job_lease_owner,job_fencing_token,quota_day,deadline_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,1,$9,$17,'grade',$10,1,$11,$9,$12,$13,$14,$15,
      'python_stdlib_v1',$16,'python-proof',1,
      (now() at time zone 'UTC')::date,now()+interval '3 minutes','creating')`;
  const gradeExecutionValues = () => [randomUUID(), ids.jobEvaluation, ids.attempt, owner, ids.enrollment,
    ids.version, ids.task, ids.activity, digest, randomUUID(), randomUUID(), "c".repeat(64), "d".repeat(64), "e".repeat(64), "f".repeat(64), pythonImage,
    JSON.stringify([{ id: "hidden", input: { value: 1 } }])];
  await rejected("global_active_slot_is_exclusive", gradeExecutionSql, gradeExecutionValues(), ["23505"]);
  await client.query(`UPDATE unfurl.code_execution_runs SET status='unavailable',disposition='not_created',
    safe_error='{"code":"create_failed"}',audit='{"disposition":"not_created"}',unavailable_at=now(),updated_at=now() WHERE id=$1`, [ids.execution1]);
  await client.query(actionExecutionSql, actionExecutionValues(ids.execution2, ids.execution1, 2, ids.execution1));
  await client.query("UPDATE unfurl.code_execution_runs SET status='ambiguous',create_ambiguous_at=now(),updated_at=now() WHERE id=$1", [ids.execution2]);
  await rejected("ambiguous_create_cannot_retry", actionExecutionSql,
    actionExecutionValues(ids.execution3, ids.execution1, 3, ids.execution2), ["23514"]);
  await client.query("UPDATE unfurl.code_execution_runs SET status='cleanup_pending',cleanup_pending_at=now(),updated_at=now() WHERE id=$1", [ids.execution2]);
  await client.query(`UPDATE unfurl.code_execution_runs SET status='unavailable',disposition='deleted',disposed_at=now(),
    safe_error='{"code":"create_ambiguous"}',audit='{"disposition":"deleted"}',unavailable_at=now(),updated_at=now() WHERE id=$1`, [ids.execution2]);
  await client.query(actionExecutionSql, actionExecutionValues(ids.execution3, ids.execution1, 3, ids.execution2));

  await client.query("SAVEPOINT stale_python_fence");
  await client.query("UPDATE unfurl.execution_jobs SET fencing_token=2 WHERE id=$1", [ids.jobAction]);
  let staleFenceCode;
  try { await client.query("UPDATE unfurl.code_execution_runs SET updated_at=now() WHERE id=$1", [ids.execution3]); }
  catch (error) { staleFenceCode = error.code; }
  await client.query("ROLLBACK TO SAVEPOINT stale_python_fence");
  check("stale_python_fence_is_rejected", staleFenceCode === "40001");

  const oidcEvidence = { source: "vercel_oidc_signed_claim_v1", teamId: "team-proof", projectId: "prj_proof",
    environment: "production", issuer: "https://oidc.vercel.com/proof", subject: "owner:team-proof:project:prj_proof",
    issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+300000).toISOString(), plan: "hobby",
    runtimeProfile: "python_stdlib_v1", image: pythonImage, imageDigest: "e".repeat(64), runnerDigest: "f".repeat(64),
    runtimeDigest: "d".repeat(64) };
  await client.query("UPDATE unfurl.code_execution_runs SET capability_evidence=$2,updated_at=now() WHERE id=$1",
    [ids.execution3, oidcEvidence]);
  await rejected("python_oidc_execution_evidence_is_immutable",
    "UPDATE unfurl.code_execution_runs SET capability_evidence=capability_evidence||'{\"plan\":\"pro\"}'::jsonb,updated_at=now() WHERE id=$1",
    [ids.execution3], ["23514"]);
  await client.query(`UPDATE unfurl.code_execution_runs SET status='running',provider_sandbox_id='sb-proof',provider_session_id='session-proof',
    sandbox_created_at=now(),updated_at=now() WHERE id=$1`, [ids.execution3]);
  await client.query(`UPDATE unfurl.code_execution_runs SET status='collecting',provider_command_ids=ARRAY['cmd-proof'],
    command_started_at=now(),updated_at=now() WHERE id=$1`, [ids.execution3]);
  await rejected("provider_command_identity_is_append_only",
    "UPDATE unfurl.code_execution_runs SET provider_command_ids=ARRAY['cmd-changed'],updated_at=now() WHERE id=$1",
    [ids.execution3], ["23514"]);
  await client.query("UPDATE unfurl.code_execution_runs SET status='cleanup_pending',cleanup_pending_at=now(),updated_at=now() WHERE id=$1", [ids.execution3]);
  await client.query(`UPDATE unfurl.code_execution_runs SET status='completed',disposition='deleted',result=$2,result_digest=$3,
    audit='{"disposition":"deleted"}',disposed_at=now(),completed_at=now(),updated_at=now() WHERE id=$1`,
  [ids.execution3, { stdout: "ok", stderr: "", exitCode: 0 }, "a".repeat(64)]);
  await rejected("completed_execution_cannot_retry", actionExecutionSql,
    actionExecutionValues(randomUUID(), ids.execution1, 4, ids.execution3), ["23514"]);
  await rejected("completed_result_is_immutable", "UPDATE unfurl.code_execution_runs SET result='{}',updated_at=now() WHERE id=$1", [ids.execution3], ["23514"]);
  await rejected("python_quota_cannot_decrement", `UPDATE unfurl.python_execution_global_daily_quotas
    SET reserved_count=reserved_count-1 WHERE quota_day=(now() at time zone 'UTC')::date`, [], ["23514"]);
  const quota = (await client.query(`SELECT g.reserved_count AS global_count,l.reserved_count AS learner_count
    FROM unfurl.python_execution_global_daily_quotas g JOIN unfurl.python_execution_learner_daily_quotas l USING(quota_day)
    WHERE g.quota_day=(now() at time zone 'UTC')::date AND l.learner_id=$1`, [owner])).rows[0];
  check("python_attempts_consume_monotonic_quota", quota?.global_count === 4 && quota?.learner_count === 3);
  await client.query(`UPDATE unfurl.execution_jobs SET status='waiting',lease_owner=null,lease_expires_at=null WHERE id=$1`, [ids.jobEvaluation]);
  const retryTarget = { kind: "evaluation", evaluationId: ids.evaluation, targetEvaluationRevision: 2 };
  const retryEpoch = (await client.query(`SELECT unfurl.advance_execution_job_retry($1,$2,$3,0,$4) AS epoch`,
    [randomUUID(), ids.jobEvaluation, owner, retryTarget])).rows[0]?.epoch;
  check("explicit_retry_epoch_cas", retryEpoch === 1);
  await rejected("claim_cannot_increment_retry_epoch", "UPDATE unfurl.execution_jobs SET retry_epoch=2 WHERE id=$1", [ids.jobEvaluation], ["23514"]);

  await client.query("INSERT INTO unfurl.enrollment_lesson_traversal(enrollment_id,course_version_id,lesson_id) VALUES($1,$2,$3)", [ids.enrollment, ids.version, ids.lesson]);
  for (const [name, table, column, value] of [
    ["activity_input_immutable", "activity_inputs", "response", { changed: true }],
    ["evaluation_revision_immutable", "evaluation_revisions", "feedback", { changed: true }],
    ["xp_adjustment_immutable", "xp_award_adjustments", "delta", -10],
    ["traversal_immutable", "enrollment_lesson_traversal", "completed_at", new Date().toISOString()],
    ["research_source_immutable", "research_source_documents", "title", "Changed"],
    ["source_claim_immutable", "source_claims", "text", "Changed"],
    ["curriculum_evidence_immutable", "curriculum_revision_evidence", "document", { changed: true }],
  ]) await rejected(name, `UPDATE unfurl.${table} SET ${column}=$2 WHERE ${table === "activity_inputs" ? "activity_session_id" : table === "evaluation_revisions" ? "evaluation_id"
    : table === "xp_award_adjustments" || table === "research_source_documents" || table === "source_claims" ? "id"
      : table === "curriculum_revision_evidence" ? "draft_id" : "enrollment_id"}=$1`,
    [table === "activity_inputs" ? ids.activity : table === "evaluation_revisions" ? ids.evaluation : table === "xp_award_adjustments" ? ids.adjustment
      : table === "research_source_documents" ? ids.source : table === "source_claims" ? ids.claim : table === "curriculum_revision_evidence" ? ids.draft : ids.enrollment, value], ["23514"]);

  const protectedTables = ["activity_inputs", "activity_actions", "evaluation_revisions", "xp_award_adjustments", "assessment_review_requests",
    "feedback_acknowledgements", "support_offers", "support_offer_tasks", "enrollment_lesson_traversal", "research_source_documents",
    "research_passages", "research_searches", "source_claims", "curriculum_revision_evidence", "course_language_revision_intents",
    "python_execution_global_daily_quotas", "python_execution_learner_daily_quotas", "code_execution_runs",
    "python_execution_admissions", "execution_job_retry_receipts", "python_authoring_validations"];
  const protection = await client.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='unfurl' AND c.relname=ANY($1::text[]) AND c.relrowsecurity AND c.relforcerowsecurity`, [protectedTables]);
  check("learning_tables_force_rls", protection.rows[0]?.count === protectedTables.length);
  await client.query("SET LOCAL ROLE authenticated");
  await rejected("authenticated_private_learning_read_denied", "SELECT * FROM unfurl.activity_inputs", [], ["42501"]);
  await client.query("RESET ROLE");
  await client.query("ROLLBACK");
  check("rollback_removed_course_fixture", (await client.query("SELECT count(*)::int AS count FROM unfurl.courses WHERE id=$1", [ids.course])).rows[0]?.count === 0);
  console.log(JSON.stringify({ ok: true, checks: checks.length, paidCalls: 0, fixturesCommitted: 0 }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const code = error instanceof assert.AssertionError ? error.message : (error.code ?? error.message ?? "live_check_failed");
  console.error(JSON.stringify({ ok: false, phase, code, constraint: error.constraint ?? null, message: error.message ?? null }));
  process.exitCode = 1;
} finally {
  await client?.end();
}
