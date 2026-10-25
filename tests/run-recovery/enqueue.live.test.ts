import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { withSystemTransaction } from "../../src/server/db";
import { cancelGenerationInTransaction, enqueueAcceptedRun } from "../../src/server/runs/enqueue";

it.skipIf(process.env.RUN_LIVE_RUN_ENQUEUE !== "1")("atomically enqueues once and invalidates a cancelled generation's job/step fences (rollback)", async () => {
  const ids = { conversation: randomUUID(), branch: randomUUID(), message: randomUUID(), course: randomUUID(), draft: randomUUID(),
    approval: randomUUID(), run: randomUUID(), version: randomUUID(), step: randomUUID(), turn: randomUUID() };
  const digest = "a".repeat(64);
  const rollback = new Error("intentional_rollback");
  await expect(withSystemTransaction("run_execution", async (tx) => {
    const owner = (await tx.query<{ id: string }>("SELECT id FROM unfurl.profiles ORDER BY created_at LIMIT 1")).rows[0]?.id;
    if (!owner) throw new Error("Existing QA identity required");
    await tx.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'Rollback execution proof',$3)", [ids.conversation, owner, ids.branch]);
    await tx.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)", [ids.branch, ids.conversation]);
    await tx.query("INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id) VALUES($1,$2,$3,'user','complete','[]',$4)", [ids.message, ids.conversation, ids.branch, randomUUID()]);
    await tx.query("INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status) VALUES($1,$2,$3,$4,$5,'queued')", [ids.turn, owner, ids.conversation, ids.branch, ids.message]);
    const turn = await enqueueAcceptedRun(tx, { kind: "agent_turn", runId: ids.turn });
    expect(await enqueueAcceptedRun(tx, { kind: "agent_turn", runId: ids.turn })).toEqual(turn);
    await tx.query("INSERT INTO unfurl.courses(id,owner_id,slug,title,summary,content_language) VALUES($1,$2,$3,'Rollback proof','Rollback only','en')", [ids.course, owner, "rollback-" + randomUUID()]);
    await tx.query("INSERT INTO unfurl.curriculum_drafts(id,course_id,conversation_id,revision,document) VALUES($1,$2,$3,1,'{}')", [ids.draft, ids.course, ids.conversation]);
    await tx.query("INSERT INTO unfurl.curriculum_revisions(draft_id,revision,content_digest,document) VALUES($1,1,$2,'{}')", [ids.draft, digest]);
    await tx.query("INSERT INTO unfurl.curriculum_approvals(id,draft_id,draft_revision,content_digest,approved_by) VALUES($1,$2,1,$3,$4)", [ids.approval, ids.draft, digest, owner]);
    await tx.query(`INSERT INTO unfurl.generation_runs(id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,'module_research','queued')`, [ids.run, owner, ids.course, ids.conversation, ids.branch, ids.message, ids.approval]);
    await tx.query(`INSERT INTO unfurl.course_versions(id,course_id,number,approval_id,source_run_id,content_digest,state,title,summary,content_language,outcomes,modules)
      VALUES($1,$2,1,$3,$4,$5,'building','Rollback proof','Rollback only','en','[{}]','[{}]')`, [ids.version, ids.course, ids.approval, ids.run, digest]);
    const job = await enqueueAcceptedRun(tx, { kind: "generation", runId: ids.run });
    expect(await enqueueAcceptedRun(tx, { kind: "generation", runId: ids.run })).toEqual(job);
    expect((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM unfurl.outbox WHERE job_id=$1 AND operation='start'", [job.jobId])).rows[0]?.n).toBe(1);
    await tx.query("UPDATE unfurl.execution_jobs SET status='running',lease_owner='proof',lease_expires_at=now()+interval '60s',fencing_token=1 WHERE id=$1", [job.jobId]);
    await tx.query(`INSERT INTO unfurl.run_steps(id,job_id,step_key,input_digest,approval_digest,schema_digest,capability_digest,validation_policy_digest,status,lease_owner,lease_expires_at,fencing_token)
      VALUES($1,$2,'proof',$3,$3,$3,$3,$3,'running','proof',now()+interval '60s',1)`, [ids.step, job.jobId, digest]);
    expect(await cancelGenerationInTransaction(tx, { runId: ids.run, ownerId: owner, reason: "superseded" })).toEqual({ cancelled: true });
    expect(await cancelGenerationInTransaction(tx, { runId: ids.run, ownerId: owner, reason: "superseded" })).toEqual({ cancelled: false });
    const state = (await tx.query<{ status: string; fencing_token: string; lease_owner: string | null }>("SELECT status,fencing_token::text,lease_owner FROM unfurl.execution_jobs WHERE id=$1", [job.jobId])).rows[0];
    expect(state).toEqual({ status: "cancelled", fencing_token: "2", lease_owner: null });
    expect((await tx.query<{ fencing_token: string }>("SELECT fencing_token::text FROM unfurl.run_steps WHERE id=$1", [ids.step])).rows[0]?.fencing_token).toBe("2");
    expect((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM unfurl.generation_events WHERE run_id=$1", [ids.run])).rows[0]?.n).toBe(2);
    expect((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM unfurl.outbox WHERE job_id=$1 AND operation='cancel'", [job.jobId])).rows[0]?.n).toBe(1);
    await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
    throw rollback;
  })).rejects.toBe(rollback);
  expect((await withSystemTransaction("run_execution", (tx) => tx.query("SELECT id FROM unfurl.generation_runs WHERE id=$1", [ids.run]))).rowCount).toBe(0);
}, 30_000);
