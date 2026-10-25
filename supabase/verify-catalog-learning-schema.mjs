import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Live rollback-only proof for migrations 005-006. No provider or HTTP calls.
// node --env-file=.env.local supabase/verify-catalog-learning-schema.mjs --project-ref <ref>
const args = process.argv.slice(2);
const expectedRef = args[args.indexOf("--project-ref") + 1];
const checks = [];
let client;
let phase = "configuration";
const digest = "b".repeat(64);
const check = (name, condition) => {
  assert.ok(condition, `check_failed:${name}`);
  checks.push(name);
  console.log(JSON.stringify({ check: name, ok: true }));
};
async function rejected(name, sql, values, expectedCodes) {
  await client.query(`SAVEPOINT ${name}`);
  let code;
  try { await client.query(sql, values); } catch (error) { code = error.code; }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
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
    ["202610250005_catalog_and_learning.sql", "202610250006_learning_traversal.sql"],
  ]);
  check("learning_migration_receipts", receipts.rowCount === 2);

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
  ].map((name) => [name, randomUUID()]));

  phase = "course_graph";
  await client.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'Learning rollback proof',$3)", [ids.conversation, owner, ids.branch]);
  await client.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)", [ids.branch, ids.conversation]);
  await client.query("INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id) VALUES($1,$2,$3,'user','complete','[]',$4)", [ids.message, ids.conversation, ids.branch, randomUUID()]);
  await client.query("INSERT INTO unfurl.courses(id,owner_id,slug,title,summary,content_language,cover) VALUES($1,$2,$3,'Learning proof','Rollback-only course','en',$4)", [ids.course, owner, `learning-proof-${randomUUID()}`, { motifId: "proof", alt: "Proof cover" }]);
  await client.query("INSERT INTO unfurl.curriculum_drafts(id,course_id,conversation_id,revision,document) VALUES($1,$2,$3,1,'{}')", [ids.draft, ids.course, ids.conversation]);
  await client.query("INSERT INTO unfurl.curriculum_revisions(draft_id,revision,content_digest,document) VALUES($1,1,$2,'{}')", [ids.draft, digest]);
  await client.query("INSERT INTO unfurl.curriculum_approvals(id,draft_id,draft_revision,content_digest,approved_by) VALUES($1,$2,1,$3,$4)", [ids.approval, ids.draft, digest, owner]);
  await client.query(`INSERT INTO unfurl.generation_runs
    (id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,'validating','running')`,
  [ids.generationRun, owner, ids.course, ids.conversation, ids.branch, ids.message, ids.approval]);
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
  await client.query(`INSERT INTO unfurl.tasks_private
    (task_id,task_version,evaluation_spec,source_claim_ids,validation_receipt_id,hints,worked_example,evaluator_data,assessment)
    VALUES($1,1,$2,'{}',$3,$4,'A worked example',$5,$6)`, [ids.task,
    { kind: "deterministic", evaluatorId: "recall_reconstruction", evaluatorVersion: 2, secretConfig: {} }, ids.taskValidation,
    JSON.stringify(["Look at the causal boundary."]), {}, { evidenceGroupId: randomUUID(), role: "required", outcomes: [{ outcomeId: ids.outcome, dimensions: [{ dimensionId: "distinction", evaluationDimensionIds: ["numeric_cases"] }] }] }]);
  await client.query("UPDATE unfurl.course_versions SET state='ready',lesson_ids=$2,validation_receipt_id=$3,ready_at=now() WHERE id=$1", [ids.version, [ids.lesson], ids.validation]);
  await client.query("UPDATE unfurl.generation_runs SET status='succeeded',output_version_id=$2 WHERE id=$1", [ids.generationRun, ids.version]);
  await client.query("UPDATE unfurl.courses SET current_ready_version_id=$2,published_version_id=$2,visibility='public' WHERE id=$1", [ids.course, ids.version]);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  check("ready_published_version_graph", (await client.query("SELECT published_version_id=current_ready_version_id AS ok FROM unfurl.courses WHERE id=$1", [ids.course])).rows[0]?.ok === true);
  await rejected("public_course_requires_pointer", "UPDATE unfurl.courses SET published_version_id=null WHERE id=$1", [ids.course], ["23514"]);

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

  await client.query("INSERT INTO unfurl.enrollment_lesson_traversal(enrollment_id,course_version_id,lesson_id) VALUES($1,$2,$3)", [ids.enrollment, ids.version, ids.lesson]);
  for (const [name, table, column, value] of [
    ["activity_input_immutable", "activity_inputs", "response", { changed: true }],
    ["evaluation_revision_immutable", "evaluation_revisions", "feedback", { changed: true }],
    ["xp_adjustment_immutable", "xp_award_adjustments", "delta", -10],
    ["traversal_immutable", "enrollment_lesson_traversal", "completed_at", new Date().toISOString()],
  ]) await rejected(name, `UPDATE unfurl.${table} SET ${column}=$2 WHERE ${table === "activity_inputs" ? "activity_session_id" : table === "evaluation_revisions" ? "evaluation_id" : table === "xp_award_adjustments" ? "id" : "enrollment_id"}=$1`,
    [table === "activity_inputs" ? ids.activity : table === "evaluation_revisions" ? ids.evaluation : table === "xp_award_adjustments" ? ids.adjustment : ids.enrollment, value], ["23514"]);

  const protectedTables = ["activity_inputs", "activity_actions", "evaluation_revisions", "xp_award_adjustments", "assessment_review_requests",
    "feedback_acknowledgements", "support_offers", "support_offer_tasks", "enrollment_lesson_traversal"];
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
  console.error(JSON.stringify({ ok: false, phase, code }));
  process.exitCode = 1;
} finally {
  await client?.end();
}
