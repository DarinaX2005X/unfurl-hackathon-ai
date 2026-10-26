import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { RunSnapshotSchema } from "../../domain/generation";
import { GenerationSnapshotSchema } from "../../domain/generation-observer";
import type { Actor } from "../auth/actor";
import { ServiceFault, unavailable } from "../auth/errors";
import { withSystemTransaction, type DbTransaction } from "../db";
import { executeIdempotentInTransaction } from "../idempotency";
import {PostgresBudget} from "../budget/postgres";
import {resolveJobFunding} from "../budget/funding";
import { getRuntimeAdmission } from "./composition";
import { enqueueAcceptedRun } from "./enqueue";
import { readRunSnapshot, requireObservedRun, type ObservedRunKind } from "./observer";
import { reconcileSavedSearchBeforeRetry, resumeSavedAgentDecision } from "./receipt-resume";

const conflict=()=>new ServiceFault(409,"revision_conflict","generation.changed");
export async function retryRunInTransaction(tx:DbTransaction,actor:Actor,id:string,kind:ObservedRunKind){
  // Course/draft/conversation locks precede run and job locks, as in authoring mutations.
  const identity=(await tx.query<{course_id:string|null;conversation_id:string}>(`SELECT ${kind==="generation"?"r.course_id":"NULL::uuid AS course_id"},r.conversation_id
    FROM unfurl.${kind==="generation"?"generation_runs":"agent_turn_runs"} r JOIN unfurl.conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id AND c.deleted_at IS NULL
    WHERE r.id=$1 AND r.owner_id=$2`,[id,actor.id])).rows[0];
  if(!identity)throw new ServiceFault(404,"not_found","generation.notFound");
  if(identity.course_id)await tx.query("SELECT id FROM unfurl.courses WHERE id=$1 AND owner_id=$2 FOR UPDATE",[identity.course_id,actor.id]);
  const conversation=(await tx.query<{active_branch_id:string}>("SELECT active_branch_id FROM unfurl.conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE",[identity.conversation_id,actor.id])).rows[0];
  if(!conversation)throw new ServiceFault(404,"not_found","generation.notFound");
  const run=await requireObservedRun(tx,actor,id,kind,true);
  if(!["failed","cancelled"].includes(run.status))throw conflict();
  const next=randomUUID();
  if(kind==="agent_turn"){
    if(conversation.active_branch_id!==run.branch_id)throw conflict();
    const latest=(await tx.query<{id:string}>("SELECT id FROM unfurl.agent_turn_runs WHERE conversation_id=$1 AND branch_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[run.conversation_id,run.branch_id])).rows[0];
    if(latest?.id!==id)throw conflict();
    const intent=(await tx.query<{course_id:string;expected_course_revision:number;draft_id:string;expected_draft_revision:number;target_language:string}>("SELECT * FROM unfurl.course_language_revision_intents WHERE run_id=$1 AND owner_id=$2",[id,actor.id])).rows[0];
    const patch=(await tx.query<{draft_id:string;expected_draft_revision:number;changes:unknown}>("SELECT * FROM unfurl.curriculum_patch_intents WHERE run_id=$1 AND owner_id=$2",[id,actor.id])).rows[0];
    if(patch){const valid=(await tx.query(`SELECT d.id FROM unfurl.curriculum_drafts d JOIN unfurl.courses c ON c.id=d.course_id
      WHERE d.id=$1 AND d.revision=$2 AND d.conversation_id=$3 AND c.owner_id=$4 FOR UPDATE OF d`,[patch.draft_id,patch.expected_draft_revision,run.conversation_id,actor.id])).rowCount;if(valid!==1)throw conflict();}
    if(intent){
      const valid=(await tx.query(`SELECT c.id FROM unfurl.courses c JOIN unfurl.curriculum_drafts d ON d.course_id=c.id
        WHERE c.id=$1 AND c.owner_id=$2 AND c.revision=$3 AND d.id=$4 AND d.revision=$5`,[intent.course_id,actor.id,intent.expected_course_revision,intent.draft_id,intent.expected_draft_revision])).rowCount;
      if(valid!==1)throw conflict();
    }
    if(await resumeSavedAgentDecision(tx,actor,run))return{runId:id};
    await tx.query("INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status,retry_of_run_id) VALUES($1,$2,$3,$4,$5,'queued',$6)",[next,actor.id,run.conversation_id,run.branch_id,run.input_message_id,id]);
    if(intent)await tx.query(`INSERT INTO unfurl.course_language_revision_intents(run_id,owner_id,course_id,expected_course_revision,draft_id,expected_draft_revision,target_language)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[next,actor.id,intent.course_id,intent.expected_course_revision,intent.draft_id,intent.expected_draft_revision,intent.target_language]);
    if(patch)await tx.query("INSERT INTO unfurl.curriculum_patch_intents(run_id,owner_id,draft_id,expected_draft_revision,changes) VALUES($1,$2,$3,$4,$5)",[next,actor.id,patch.draft_id,patch.expected_draft_revision,JSON.stringify(patch.changes)]);
  }else{
    const approved=(await tx.query<{document:unknown;content_digest:string;summary:string}>(`SELECT revision.document,a.content_digest,c.summary
      FROM unfurl.curriculum_approvals a JOIN unfurl.curriculum_drafts d ON d.id=a.draft_id AND d.revision=a.draft_revision
      JOIN unfurl.curriculum_revisions revision ON revision.draft_id=a.draft_id AND revision.revision=a.draft_revision AND revision.content_digest=a.content_digest
      JOIN unfurl.courses c ON c.id=d.course_id WHERE a.id=$1 AND a.approved_by=$2 AND c.owner_id=$2 AND c.id=$3 AND a.draft_revision=$4 FOR UPDATE OF d`,
    [run.approval_id,actor.id,run.course_id,run.source_draft_revision])).rows[0];
    if(!approved)throw conflict();
    const latest=(await tx.query<{id:string}>("SELECT id FROM unfurl.generation_runs WHERE approval_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[run.approval_id])).rows[0];
    if(latest?.id!==id)throw conflict();
    const version=(await tx.query<{id:string}>(`SELECT id FROM unfurl.course_versions WHERE course_id=$1 AND approval_id=$2 AND source_run_id=$3
      AND content_digest=$4 AND state<>'ready' FOR UPDATE`,[run.course_id,run.approval_id,id,approved.content_digest])).rows[0];
    if(!version)throw conflict();
    await tx.query(`INSERT INTO unfurl.generation_runs(id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status,retry_of_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'module_research','queued',$9)`,[next,actor.id,run.course_id,run.conversation_id,run.branch_id,run.input_message_id,run.source_draft_revision,run.approval_id,id]);
    const rebound=await tx.query(`UPDATE unfurl.course_versions SET source_run_id=$2,state='building'
      WHERE id=$1 AND source_run_id=$3 AND approval_id=$4 AND content_digest=$5 AND state<>'ready' RETURNING id`,[version.id,next,id,run.approval_id,approved.content_digest]);
    if(rebound.rowCount!==1)throw conflict();
  }
  await enqueueAcceptedRun(tx,{kind,runId:next});
  return {runId:next};
}
export async function retryRun(actor:Actor,id:string,kind:ObservedRunKind,key:string){
  if(kind==="agent_turn")await withSystemTransaction("run_execution",tx=>reconcileSavedSearchBeforeRetry(tx,actor,id));
  await getRuntimeAdmission().assertAvailable(kind,{deferBudget:kind==="agent_turn"});
  return withSystemTransaction("run_execution",async tx=>{
    // Ownership is checked even on idempotent replay, including after deletion.
    const owned=(await tx.query(`SELECT r.id FROM unfurl.${kind==="generation"?"generation_runs":"agent_turn_runs"} r
      JOIN unfurl.conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id AND c.deleted_at IS NULL WHERE r.id=$1 AND r.owner_id=$2`,[id,actor.id])).rowCount;
    if(owned!==1)throw new ServiceFault(404,"not_found","generation.notFound");
    // Persist only identity; the returned snapshot is always current.
    const result=await executeIdempotentInTransaction(tx,actor,{operation:`run.${kind}.retry`,key,body:{runId:id},parseResult:z.object({runId:IdSchema}).strict()},async()=>{const data=await retryRunInTransaction(tx,actor,id,kind);
      if(kind==="agent_turn"){
        // Receipt recovery may return the original run. Its immutable job funding,
        // rather than the actor's current default, remains authoritative.
        const job=(await tx.query<{id:string}>("SELECT id FROM unfurl.execution_jobs WHERE agent_turn_run_id=$1",[data.runId])).rows[0];
        if(!job)throw unavailable("generation.unavailable");
        const funding=await resolveJobFunding(tx,job.id);
        await new PostgresBudget(funding.budgetId,work=>work(tx)).assertAvailable({probe:false});
      }
      return{status:202,data};});
    const snapshot=await readRunSnapshot(tx,actor,result.data.runId,kind);
    return {status:result.status,data:kind==="generation"?GenerationSnapshotSchema.parse(snapshot):RunSnapshotSchema.parse(snapshot)};
  });
}
