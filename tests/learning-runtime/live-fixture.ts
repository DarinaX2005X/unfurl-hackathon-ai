import { Client, type QueryResultRow } from "pg";
import type { Actor } from "@/server/auth/actor";
import type { DbTransaction } from "@/server/db";
import { createInitialLearningRoute } from "@/server/learning/initial-route";
import { createLearningService } from "@/server/learning/service";
import { prediction, tracing } from "../mechanics/investigation/fixtures";
import { program } from "./fixtures";

/** All material remains inside one rolled-back transaction. No generation/model or public catalog write. */
export async function withLiveLearningFixture(work: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!ref || !/^[a-z]{20}$/.test(ref)) throw new Error("Explicit configured QA project required");
  const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const database = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  if (api.hostname !== `${ref}.supabase.co` || !(decodeURIComponent(database.username).endsWith(`.${ref}`) || database.hostname === `db.${ref}.supabase.co`) || database.port === "6543") {
    throw new Error("QA database target mismatch");
  }
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) database.searchParams.delete(name);
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  const client = new Client({ connectionString: database.toString(), connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, application_name: "unfurl-learning-runtime-rollback" });
  await client.connect();
  let courseId: string | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const value = await fixture(client);
    courseId = value.program.version.courseId;
    await work(value);
  } finally {
    await client.query("ROLLBACK");
    if (courseId && (await client.query("SELECT id FROM unfurl.courses WHERE id=$1", [courseId])).rowCount !== 0) throw new Error("QA rollback failed");
    await client.end();
  }
}

async function fixture(client: Client) {
  const owner = (await client.query<{ id: string }>("SELECT id FROM auth.users ORDER BY created_at LIMIT 1")).rows[0]?.id;
  if (!owner) throw new Error("Existing QA identity required");
  const actor: Actor = { id: owner, sessionId: crypto.randomUUID(), email: null };
  const data = program();
  data.tasks.forEach((entry, index) => {
    entry.task.mechanicId = index === 2 ? "outcome_prediction" : "state_tracing";
    entry.task.config = index === 2 ? prediction : tracing;
    entry.task.availableHints = 1;
    entry.assessment.outcomes[0]!.dimensions[0]!.evaluationDimensionIds = index === 2 ? ["prediction"] : ["step.1", "step.2"];
  });
  const ids = { conversation: crypto.randomUUID(), branch: crypto.randomUUID(), message: crypto.randomUUID(), draft: crypto.randomUUID() };
  const version = data.version;
  const tx: DbTransaction = { query: <Row extends QueryResultRow>(sql: string, values?: unknown[]) => client.query<Row>(sql, values) };
  await tx.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'Runtime rollback fixture',$3)", [ids.conversation, owner, ids.branch]);
  await tx.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)", [ids.branch, ids.conversation]);
  await tx.query("INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id) VALUES($1,$2,$3,'user','complete','[]',$4)", [ids.message, ids.conversation, ids.branch, crypto.randomUUID()]);
  await tx.query("INSERT INTO unfurl.courses(id,owner_id,slug,title,summary,content_language,cover) VALUES($1,$2,$3,$4,$5,'en',$6)",
    [version.courseId, owner, `rollback-${crypto.randomUUID()}`, version.title, version.summary, version.cover]);
  await tx.query("INSERT INTO unfurl.curriculum_drafts(id,course_id,conversation_id,revision,document) VALUES($1,$2,$3,1,'{}')", [ids.draft, version.courseId, ids.conversation]);
  await tx.query("INSERT INTO unfurl.curriculum_revisions(draft_id,revision,content_digest,document) VALUES($1,1,$2,'{}')", [ids.draft, version.contentDigest]);
  await tx.query("INSERT INTO unfurl.curriculum_approvals(id,draft_id,draft_revision,content_digest,approved_by) VALUES($1,$2,1,$3,$4)", [version.approvalId, ids.draft, version.contentDigest, owner]);
  await tx.query(`INSERT INTO unfurl.generation_runs(id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,'validating','running')`, [version.sourceRunId, owner, version.courseId, ids.conversation, ids.branch, ids.message, version.approvalId]);
  await tx.query(`INSERT INTO unfurl.course_versions(id,course_id,number,approval_id,source_run_id,content_digest,state,title,summary,content_language,assumed_knowledge,outcomes,modules,cover)
    VALUES($1,$2,1,$3,$4,$5,'building',$6,$7,'en','[]',$8::jsonb,$9::jsonb,$10::jsonb)`,
  [version.id, version.courseId, version.approvalId, version.sourceRunId, version.contentDigest, version.title, version.summary, JSON.stringify(version.outcomes), JSON.stringify(version.modules), JSON.stringify(version.cover)]);
  await tx.query("INSERT INTO unfurl.version_validation_receipts(id,course_version_id,verdict,document) VALUES($1,$2,'passed','{}')", [version.validationReceiptId, version.id]);
  for (const lesson of data.lessons) await tx.query("INSERT INTO unfurl.lessons(id,course_version_id,module_id,title,outcome_ids,blocks,task_ids) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
    [lesson.id, version.id, lesson.moduleId, lesson.title, lesson.outcomeIds, JSON.stringify(lesson.blocks), lesson.taskIds]);
  for (const { task, assessment } of data.tasks) {
    await tx.query(`INSERT INTO unfurl.tasks_public(id,task_version,course_version_id,mechanic_id,mechanic_version,outcome_ids,instruction,content_language,config,available_hints,response_schema_version)
      VALUES($1,1,$2,$3,2,$4,$5,'en',$6::jsonb,1,2)`, [task.id, version.id, task.mechanicId, task.outcomeIds, task.instruction, JSON.stringify(task.config)]);
    const validationId = crypto.randomUUID();
    await tx.query("INSERT INTO unfurl.task_validation_receipts(id,task_id,task_version,verdict,document) VALUES($1,$2,1,'passed','{}')", [validationId, task.id]);
    await tx.query(`INSERT INTO unfurl.tasks_private(task_id,task_version,evaluation_spec,source_claim_ids,validation_receipt_id,hints,worked_example,evaluator_data,assessment)
      VALUES($1,1,$2::jsonb,'{}',$3,'["Use the declared update rule."]','Synthetic worked example',$4::jsonb,$5::jsonb)`,
    [task.id, JSON.stringify({ kind: "deterministic", evaluatorId: task.mechanicId, evaluatorVersion: 2, secretConfig: null }), validationId,
      JSON.stringify({ tolerance: { absTol: 1e-8, relTol: 1e-9 } }), JSON.stringify(assessment)]);
  }
  await tx.query("UPDATE unfurl.course_versions SET state='ready',lesson_ids=$2,validation_receipt_id=$3,ready_at=now() WHERE id=$1", [version.id, version.lessonIds, version.validationReceiptId]);
  await tx.query("UPDATE unfurl.generation_runs SET status='succeeded',output_version_id=$2 WHERE id=$1", [version.sourceRunId, version.id]);
  await tx.query("UPDATE unfurl.courses SET current_ready_version_id=$2 WHERE id=$1", [version.courseId, version.id]);
  const initial = createInitialLearningRoute(data);
  await tx.query(`INSERT INTO unfurl.enrollments(id,learner_id,course_id,course_version_id,current_lesson_id,current_task_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [data.enrollmentId, owner, version.courseId, version.id, initial.currentLessonId, initial.currentTaskId]);
  await tx.query("INSERT INTO unfurl.personal_routes(enrollment_id,revision,policy_version,document) VALUES($1,1,'adaptation-v1',$2::jsonb)", [data.enrollmentId, JSON.stringify(initial.route)]);
  await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
  await tx.query("SET LOCAL ROLE service_role");
  let sequence = 0;
  const service = createLearningService({ transactions: { async run<T>(work: (transaction: DbTransaction) => Promise<T>): Promise<T> {
    const savepoint = `learning_operation_${++sequence}`;
    await tx.query(`SAVEPOINT ${savepoint}`);
    try { const result = await work(tx); await tx.query(`RELEASE SAVEPOINT ${savepoint}`); return result; }
    catch (error) { await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await tx.query(`RELEASE SAVEPOINT ${savepoint}`); throw error; }
  } } });
  return { tx, actor, program: data, service };
}
