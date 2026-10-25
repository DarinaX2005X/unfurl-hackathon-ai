import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Actor } from "../../src/server/auth/actor";
import { createCatalogService } from "../../src/server/catalog/service";
import type { DbTransaction } from "../../src/server/db";
import { createPublicationService } from "../../src/server/publication";
import {
  applyEvaluationProgressTx,
  lockLearnerCourseStableTaskTx,
  previewEvaluationAwardTx,
  readAccountProgressTx,
} from "../../src/server/progression";

const live = process.env.RUN_LIVE_PROGRESSION === "1";
const liveTest = (name: string, test: () => Promise<void>) => it(name, test, 90_000);

function connection(): Client {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const url = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  if (!ref || (!decodeURIComponent(url.username).endsWith(`.${ref}`) && url.hostname !== `db.${ref}.supabase.co`) || url.port === "6543") {
    throw new Error("Invalid test database target");
  }
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
  return new Client({
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}),
    },
    connectionTimeoutMillis: 5_000,
  });
}

type TaskFixture = { taskId: string; activityId: string };
type AttemptFixture = { attemptId: string; evaluationId: string; evidenceId: string; awardedXp: 0 | 10 | 25 };

describe.skipIf(!live)("actual progression and publication SQL (rollback-only fixtures)", () => {
  let client: Client;
  let peer: Client;
  let actor: Actor;
  const tx = () => client as unknown as DbTransaction;

  beforeAll(async () => {
    client = connection();
    peer = connection();
    await client.connect();
    await peer.connect();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    const migrations = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM unfurl_meta.schema_migrations
       WHERE version = ANY($1::text[])`,
      [[
        "202610250005_catalog_and_learning.sql",
        "202610250006_learning_traversal.sql",
        "202610250007_share_contract_repairs.sql",
      ]],
    );
    if (migrations.rows[0]?.count !== 3) throw new Error("Required migrated schema is not active");
    const account = await client.query<{ id: string; email: string | null }>(
      "SELECT id, email FROM auth.users WHERE email_confirmed_at IS NOT NULL ORDER BY created_at, id LIMIT 1",
    );
    const row = account.rows[0];
    if (!row) throw new Error("A confirmed development account is required");
    actor = { id: row.id, sessionId: randomUUID(), email: row.email };
    await client.query("SET LOCAL ROLE service_role");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL lock_timeout='5s'");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    await peer.query("ROLLBACK");
  });

  afterAll(async () => {
    await client?.end();
    await peer?.end();
  });

  liveTest("serializes the shared learner/course/stable-task lock across real transactions", async () => {
    const identity = { learnerId: actor.id, courseId: randomUUID(), taskId: randomUUID() };
    await lockLearnerCourseStableTaskTx(tx(), identity);
    await peer.query("BEGIN");
    await peer.query("SET LOCAL ROLE service_role");
    await peer.query("SET LOCAL lock_timeout='150ms'");
    await expect(lockLearnerCourseStableTaskTx(peer as unknown as DbTransaction, identity)).rejects.toMatchObject({ code: "55P03" });
  });

  liveTest("proves award uniqueness, review correction, publication pinning and private revocation in one rollback", async () => {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const messageId = randomUUID();
    const courseId = randomUUID();
    const draftId = randomUUID();
    const approvalId = randomUUID();
    const runId = randomUUID();
    const versionId = randomUUID();
    const validationId = randomUUID();
    const lessonId = randomUUID();
    const moduleId = randomUUID();
    const outcomeId = randomUUID();
    const enrollmentId = randomUUID();
    const tasks: TaskFixture[] = Array.from({ length: 21 }, () => ({ taskId: randomUUID(), activityId: randomUUID() }));

    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      "INSERT INTO unfurl.conversations (id,owner_id,title,active_branch_id) VALUES ($1,$2,'Rollback progression proof',$3)",
      [conversationId, actor.id, branchId],
    );
    await client.query("INSERT INTO unfurl.conversation_branches (id,conversation_id) VALUES ($1,$2)", [branchId, conversationId]);
    await client.query(
      `INSERT INTO unfurl.messages (id,conversation_id,branch_id,role,status,parts,client_request_id)
       VALUES ($1,$2,$3,'user','complete','[]'::jsonb,$4)`,
      [messageId, conversationId, branchId, randomUUID()],
    );
    await client.query(
      `INSERT INTO unfurl.courses (id,owner_id,slug,title,summary,content_language,visibility,cover)
       VALUES ($1,$2,$3,'Rollback course','Transaction-only evidence','en','private',$4::jsonb)`,
      [courseId, actor.id, `rollback-${courseId}`, JSON.stringify({ motifId: "proof", alt: "Rollback-only proof" })],
    );
    await client.query(
      `INSERT INTO unfurl.curriculum_drafts (id,course_id,conversation_id,revision,document)
       VALUES ($1,$2,$3,1,'{}'::jsonb)`,
      [draftId, courseId, conversationId],
    );
    await client.query(
      `INSERT INTO unfurl.curriculum_revisions (draft_id,revision,content_digest,document)
       VALUES ($1,1,$2,'{}'::jsonb)`,
      [draftId, "a".repeat(64)],
    );
    await client.query(
      `INSERT INTO unfurl.curriculum_approvals (id,draft_id,draft_revision,content_digest,approved_by)
       VALUES ($1,$2,1,$3,$4)`,
      [approvalId, draftId, "a".repeat(64), actor.id],
    );
    await client.query(
      `INSERT INTO unfurl.generation_runs
       (id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,'validating','running')`,
      [runId, actor.id, courseId, conversationId, branchId, messageId, approvalId],
    );
    const outcomes = [{ id: outcomeId, title: "Prove a result", demonstration: "Submit validated evidence", prerequisiteOutcomeIds: [], requirement: "core" }];
    const modules = [{ id: moduleId, title: "Proof", summary: "Produce evidence", outcomeIds: [outcomeId], prerequisiteModuleIds: [], estimatedStudyMinutes: 30 }];
    await client.query(
      `INSERT INTO unfurl.course_versions
       (id,course_id,number,approval_id,source_run_id,content_digest,state,title,summary,content_language,
        assumed_knowledge,outcomes,modules,lesson_ids,cover)
       VALUES ($1,$2,1,$3,$4,$5,'building','Rollback course','Transaction-only evidence','en','[]'::jsonb,$6::jsonb,$7::jsonb,'{}',$8::jsonb)`,
      [versionId, courseId, approvalId, runId, "b".repeat(64), JSON.stringify(outcomes), JSON.stringify(modules),
        JSON.stringify({ motifId: "proof", alt: "Rollback-only proof" })],
    );
    await client.query(
      `INSERT INTO unfurl.lessons (id,course_version_id,module_id,title,outcome_ids,blocks,task_ids)
       VALUES ($1,$2,$3,'Evidence',$4,'[]'::jsonb,$5)`,
      [lessonId, versionId, moduleId, [outcomeId], tasks.map((item) => item.taskId)],
    );
    await client.query(
      "INSERT INTO unfurl.version_validation_receipts (id,course_version_id,verdict,document) VALUES ($1,$2,'passed','{}'::jsonb)",
      [validationId, versionId],
    );
    for (const item of tasks) {
      await client.query(
        `INSERT INTO unfurl.tasks_public
         (id,task_version,course_version_id,mechanic_id,mechanic_version,outcome_ids,instruction,content_language,config,available_hints,response_schema_version)
         VALUES ($1,1,$2,'recall_reconstruction',2,$3,'Provide the verified result','en','{}'::jsonb,1,1)`,
        [item.taskId, versionId, [outcomeId]],
      );
    }
    await client.query(
      "UPDATE unfurl.course_versions SET state='ready',lesson_ids=$2,validation_receipt_id=$3,ready_at=now() WHERE id=$1",
      [versionId, [lessonId], validationId],
    );
    await client.query(
      "UPDATE unfurl.generation_runs SET status='succeeded',output_version_id=$2 WHERE id=$1",
      [runId, versionId],
    );
    await client.query("UPDATE unfurl.courses SET current_ready_version_id=$2 WHERE id=$1", [courseId, versionId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO unfurl.enrollments (id,learner_id,course_id,course_version_id,status,route_revision)
       VALUES ($1,$2,$3,$4,'active',1)`,
      [enrollmentId, actor.id, courseId, versionId],
    );

    async function attempt(task: TaskFixture, assistance: "independent" | "hinted"): Promise<AttemptFixture> {
      const attemptId = randomUUID();
      const evaluationId = randomUUID();
      const evidenceId = randomUUID();
      const digest = createHash("sha256").update(attemptId).digest("hex");
      await client.query(
        `INSERT INTO unfurl.activity_sessions
         (id,enrollment_id,task_id,task_version,hidden_state,action_budget,actions_used,status,revision,input_revision)
         VALUES ($1,$2,$3,1,'{}'::jsonb,6,0,'completed',1,1)
         ON CONFLICT (enrollment_id,task_id,task_version) DO NOTHING`,
        [task.activityId, enrollmentId, task.taskId],
      );
      const activity = await client.query<{ id: string }>(
        "SELECT id FROM unfurl.activity_sessions WHERE enrollment_id=$1 AND task_id=$2 AND task_version=1",
        [enrollmentId, task.taskId],
      );
      const activityId = activity.rows[0]!.id;
      await client.query(
        `INSERT INTO unfurl.activity_inputs (activity_session_id,input_revision,response_digest,response)
         VALUES ($1,1,$2,'{}'::jsonb) ON CONFLICT DO NOTHING`,
        [activityId, digest],
      );
      const savedInput = await client.query<{ response_digest: string }>(
        "SELECT response_digest FROM unfurl.activity_inputs WHERE activity_session_id=$1 AND input_revision=1",
        [activityId],
      );
      const savedDigest = savedInput.rows[0]!.response_digest;
      await client.query(
        `INSERT INTO unfurl.attempts
         (id,learner_id,enrollment_id,course_version_id,task_id,task_version,client_attempt_id,idempotency_key,response,
          assistance,hint_ids_used,activity_session_id,activity_input_revision,response_digest,request_digest,activity_snapshot,
          submitted_activity_revision,submitted_route_revision)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7,'{}'::jsonb,$8,'{}',$9,1,$10,$11,'{}'::jsonb,1,1)`,
        [attemptId, actor.id, enrollmentId, versionId, task.taskId, randomUUID(), randomUUID(), assistance, activityId, savedDigest, digest],
      );
      await client.query(
        `INSERT INTO unfurl.evaluations (id,attempt_id,status,outcome,dimensions,feedback,awarded_xp,revision)
         VALUES ($1,$2,'pending',NULL,'[]'::jsonb,'{}'::jsonb,0,1)`,
        [evaluationId, attemptId],
      );
      const awardedXp = await previewEvaluationAwardTx(tx(), {
        attemptId, evaluationId, evaluationRevision: 1, status: "evaluated", outcome: "correct",
      });
      await client.query(
        "UPDATE unfurl.evaluations SET status='evaluated',outcome='correct',awarded_xp=$2,updated_at=now() WHERE id=$1",
        [evaluationId, awardedXp],
      );
      await client.query(
        `INSERT INTO unfurl.evaluation_revisions
         (evaluation_id,attempt_id,revision,status,outcome,dimensions,feedback,awarded_xp)
         VALUES ($1,$2,1,'evaluated','correct','[]'::jsonb,'{}'::jsonb,$3)`,
        [evaluationId, attemptId, awardedXp],
      );
      await client.query(
        `INSERT INTO unfurl.learner_evidence
         (id,enrollment_id,outcome_id,source,observation,dimension_ids,context,attempt_id,evaluation_id,evaluation_revision,
          task_id,task_version,evidence_group_id,assistance,review_state)
         VALUES ($1,$2,$3,$4::jsonb,$11,ARRAY['criterion'],$5::jsonb,$6,$7,1,$8,1,$9,$10,'confirmed')`,
        [evidenceId, enrollmentId, outcomeId, JSON.stringify({ kind: "attempt", attemptId }),
          JSON.stringify({ evaluationId, evaluationRevision: 1 }), attemptId, evaluationId, task.taskId, randomUUID(), assistance,
          assistance === "independent" ? "independent_success" : "assisted_success"],
      );
      await applyEvaluationProgressTx(tx(), { evaluationId, evaluationRevision: 1 });
      const stored = await client.query<{ projection_xp: number; semantic_xp: number }>(
        `SELECT evaluation.awarded_xp AS projection_xp, semantic.awarded_xp AS semantic_xp
         FROM unfurl.evaluations evaluation
         JOIN unfurl.evaluation_revisions semantic ON semantic.evaluation_id=evaluation.id AND semantic.revision=1
         WHERE evaluation.id=$1`,
        [evaluationId],
      );
      expect(stored.rows[0]).toEqual({ projection_xp: awardedXp, semantic_xp: awardedXp });
      return { attemptId, evaluationId, evidenceId, awardedXp };
    }

    const firstAttempts: AttemptFixture[] = [];
    for (const task of tasks.slice(0, 20)) firstAttempts.push(await attempt(task, "independent"));
    expect(await readAccountProgressTx(tx(), actor.id)).toMatchObject({ xpTotal: 500, level: 3, publication: { eligible: true } });
    expect(await previewEvaluationAwardTx(tx(), {
      attemptId: firstAttempts[0]!.attemptId,
      evaluationId: firstAttempts[0]!.evaluationId,
      evaluationRevision: 1,
      status: "evaluated",
      outcome: "correct",
    })).toBe(25);

    const hinted = await attempt(tasks[20]!, "hinted");
    await attempt(tasks[20]!, "independent");
    expect(await readAccountProgressTx(tx(), actor.id)).toMatchObject({ xpTotal: 510, level: 3 });
    const hintedAward = await client.query<{ amount: number; policy_version: string }>(
      "SELECT amount,policy_version FROM unfurl.xp_awards WHERE learner_id=$1 AND course_id=$2 AND task_id=$3",
      [actor.id, courseId, tasks[20]!.taskId],
    );
    expect(hintedAward.rows).toEqual([{ amount: 10, policy_version: "xp-v1" }]);

    await client.query("SAVEPOINT duplicate_award");
    await expect(client.query(
      `INSERT INTO unfurl.xp_awards (id,learner_id,course_id,task_id,qualifying_evidence_id,policy_version,amount)
       VALUES ($1,$2,$3,$4,$5,'xp-v2',25)`,
      [randomUUID(), actor.id, courseId, tasks[20]!.taskId, hinted.evidenceId],
    )).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_award");

    const publish = createPublicationService({ transactions: { run: async (work) => work(tx()) } });
    const published = await publish.setVisibility(actor, courseId, {
      expectedRevision: 1, visibility: "public", courseVersionId: versionId,
    }, randomUUID());
    expect(published.data).toMatchObject({ visibility: "public", publishedVersionId: versionId, revision: 2 });
    const catalog = createCatalogService({ transactions: { read: async (work) => work(tx()) } });
    expect((await catalog.listPublic({ limit: 24 })).items.some((item) => item.id === courseId)).toBe(true);
    const grantId = randomUUID();
    await client.query(
      `INSERT INTO unfurl.share_grants
       (id,course_id,course_version_id,created_by,token_hash,token_key_version)
       VALUES ($1,$2,$3,$4,$5,'1')`,
      [grantId, courseId, versionId, actor.id, createHash("sha256").update(grantId).digest("hex")],
    );
    const unpublished = await publish.setVisibility(actor, courseId, {
      expectedRevision: 2, visibility: "private", courseVersionId: versionId,
    }, randomUUID());
    expect(unpublished.data).toMatchObject({ visibility: "private", publishedVersionId: null, revision: 3 });
    expect((await catalog.listPublic({ limit: 24 })).items.some((item) => item.id === courseId)).toBe(false);
    expect((await client.query("SELECT revoked_at IS NOT NULL AS revoked FROM unfurl.share_grants WHERE id=$1", [grantId])).rows[0]).toEqual({ revoked: true });
    expect((await client.query("SELECT count(*)::int AS count FROM unfurl.enrollments WHERE id=$1", [enrollmentId])).rows[0]).toEqual({ count: 1 });

    const original = firstAttempts[0]!;
    const uncertainAward = await previewEvaluationAwardTx(tx(), {
      attemptId: original.attemptId,
      evaluationId: original.evaluationId,
      evaluationRevision: 2,
      status: "uncertain",
      outcome: null,
    });
    expect(uncertainAward).toBe(0);
    await client.query(
      "UPDATE unfurl.evaluations SET status='uncertain',outcome=NULL,awarded_xp=$2,revision=2,updated_at=now() WHERE id=$1",
      [original.evaluationId, uncertainAward],
    );
    await client.query(
      `INSERT INTO unfurl.evaluation_revisions
       (evaluation_id,attempt_id,revision,status,outcome,dimensions,feedback,awarded_xp)
       VALUES ($1,$2,2,'uncertain',NULL,'[]'::jsonb,'{}'::jsonb,0)`,
      [original.evaluationId, original.attemptId],
    );
    await client.query("UPDATE unfurl.learner_evidence SET review_state='superseded' WHERE id=$1", [original.evidenceId]);
    await client.query(
      `INSERT INTO unfurl.learner_evidence
       (id,enrollment_id,outcome_id,source,observation,dimension_ids,context,attempt_id,evaluation_id,evaluation_revision,
        task_id,task_version,evidence_group_id,assistance,review_state)
       VALUES ($1,$2,$3,$4::jsonb,'uncertain',ARRAY['criterion'],$5::jsonb,$6,$7,2,$8,1,$9,'independent','confirmed')`,
      [randomUUID(), enrollmentId, outcomeId, JSON.stringify({ kind: "attempt", attemptId: original.attemptId }),
        JSON.stringify({ evaluationId: original.evaluationId, evaluationRevision: 2 }), original.attemptId, original.evaluationId,
        tasks[0]!.taskId, randomUUID()],
    );
    await applyEvaluationProgressTx(tx(), { evaluationId: original.evaluationId, evaluationRevision: 2 });
    expect(await readAccountProgressTx(tx(), actor.id)).toMatchObject({ xpTotal: 510 });
    expect((await client.query(
      `SELECT evaluation.awarded_xp AS projection_xp, semantic.awarded_xp AS semantic_xp
       FROM unfurl.evaluations evaluation JOIN unfurl.evaluation_revisions semantic
         ON semantic.evaluation_id=evaluation.id AND semantic.revision=2 WHERE evaluation.id=$1`,
      [original.evaluationId],
    )).rows[0]).toEqual({ projection_xp: 0, semantic_xp: 0 });

    const correctedAward = await previewEvaluationAwardTx(tx(), {
      attemptId: original.attemptId,
      evaluationId: original.evaluationId,
      evaluationRevision: 3,
      status: "evaluated",
      outcome: "incorrect",
    });
    expect(correctedAward).toBe(0);
    await client.query(
      "UPDATE unfurl.evaluations SET status='evaluated',outcome='incorrect',awarded_xp=$2,revision=3,updated_at=now() WHERE id=$1",
      [original.evaluationId, correctedAward],
    );
    await client.query(
      `INSERT INTO unfurl.evaluation_revisions
       (evaluation_id,attempt_id,revision,status,outcome,dimensions,feedback,awarded_xp)
       VALUES ($1,$2,3,'evaluated','incorrect','[]'::jsonb,'{}'::jsonb,0)`,
      [original.evaluationId, original.attemptId],
    );
    await client.query(
      `INSERT INTO unfurl.learner_evidence
       (id,enrollment_id,outcome_id,source,observation,dimension_ids,context,attempt_id,evaluation_id,evaluation_revision,
        task_id,task_version,evidence_group_id,assistance,review_state)
       VALUES ($1,$2,$3,$4::jsonb,'incorrect',ARRAY['criterion'],$5::jsonb,$6,$7,3,$8,1,$9,'independent','confirmed')`,
      [randomUUID(), enrollmentId, outcomeId, JSON.stringify({ kind: "attempt", attemptId: original.attemptId }),
        JSON.stringify({ evaluationId: original.evaluationId, evaluationRevision: 3 }), original.attemptId, original.evaluationId,
        tasks[0]!.taskId, randomUUID()],
    );
    await applyEvaluationProgressTx(tx(), { evaluationId: original.evaluationId, evaluationRevision: 3 });
    await applyEvaluationProgressTx(tx(), { evaluationId: original.evaluationId, evaluationRevision: 2 });
    expect(await readAccountProgressTx(tx(), actor.id)).toMatchObject({ xpTotal: 485, level: 2, publication: { eligible: false } });
    const adjustments = await client.query<{ count: number; delta: number }>(
      "SELECT count(*)::int AS count,COALESCE(sum(delta),0)::int AS delta FROM unfurl.xp_award_adjustments WHERE evaluation_id=$1",
      [original.evaluationId],
    );
    expect(adjustments.rows[0]).toEqual({ count: 1, delta: -25 });
    expect((await client.query(
      `SELECT evaluation.awarded_xp AS projection_xp, semantic.awarded_xp AS semantic_xp
       FROM unfurl.evaluations evaluation JOIN unfurl.evaluation_revisions semantic
         ON semantic.evaluation_id=evaluation.id AND semantic.revision=3 WHERE evaluation.id=$1`,
      [original.evaluationId],
    )).rows[0]).toEqual({ projection_xp: 0, semantic_xp: 0 });
  });
});
