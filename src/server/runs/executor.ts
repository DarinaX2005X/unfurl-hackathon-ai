import "server-only";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../domain/common";
import type { DbTransaction } from "../db";
import { ProviderFailure, publicProviderFault } from "../ai/failure";
import { canonicalJson, jsonDigest } from "../ai/json";
import { stableExecutionId } from "./identity";
import { appendChatEvent, appendGenerationEvent, completeGenerationInTransaction, completeTurnInTransaction } from "./events";
import type { DurableStep, JobClaim, RunContext, RunHandler, StepEffectContext } from "./ports";
import { claimJob, guardClaim, runtimeTransaction, type RuntimeTransaction } from "./store";
import type { RunHandlerRegistry } from "./registry";

interface StepRow { id: string; input_digest: string; schema_digest: string; capability_digest: string; validation_policy_digest: string;
  approval_digest: string | null; status: string; result_reference: unknown; fencing_token: string; live: boolean }
class AdvanceBoundary extends Error {}
export class DurableRunExecutor {
  constructor(private readonly registry: RunHandlerRegistry, private readonly transaction: RuntimeTransaction = runtimeTransaction) {}
  async advance(jobId: string): Promise<{ status: "continue" | "busy" | "finished" }> {
    const claimed = await this.transaction(tx => claimJob(tx, jobId, this.registry));
    if (claimed.kind !== "claimed") return { status: claimed.kind };
    const claim = claimed.claim; const handler = this.registry.require(claim.target.kind);
    const abort = new AbortController();
    const deadlineAt = Date.now() + 100000;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(100000)]);
    let commitTx: DbTransaction | null = null; let effects = 0;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return; polling = true;
      void this.transaction(tx => guardClaim(tx, claim, handler)).catch(() => abort.abort()).finally(() => { polling = false; });
    }, 5000);
    const requireCommit = (tx: DbTransaction) => { if (commitTx !== tx) throw new ProviderFailure("invalid_output"); };
    const context: RunContext = {
      claim, signal,
      read: reader => this.transaction(async tx => { await guardClaim(tx, claim, handler); return reader(tx, claim.target); }),
      step: async <I extends JsonValue, O extends JsonValue, R extends JsonValue>(spec: DurableStep<I, O, R>) => {
        if (!/^[a-zA-Z0-9:._/-]{1,240}$/.test(spec.key)) throw new ProviderFailure("invalid_output");
        const inputDigest = jsonDigest(spec.input);
        const begun = await this.transaction(async tx => {
          await guardClaim(tx, claim, handler);
          const prior = (await tx.query<StepRow>(`SELECT *,fencing_token::text,lease_expires_at>now() AS live FROM unfurl.run_steps WHERE job_id=$1 AND step_key=$2 FOR UPDATE`, [jobId, spec.key])).rows;
          if (prior.length > 1) throw new ProviderFailure("invalid_output");
          const row = prior[0];
          if (row && (row.input_digest !== inputDigest || row.schema_digest !== spec.digests.schema || row.capability_digest !== spec.digests.capability ||
            row.validation_policy_digest !== spec.digests.validationPolicy || row.approval_digest !== spec.digests.approval)) throw new ProviderFailure("invalid_output");
          if (row?.status === "succeeded") return { replay: true as const, result: spec.resultSchema.parse(row.result_reference) };
          if (effects >= 1) throw new AdvanceBoundary();
          if (row?.status === "cancelled" || row?.status === "failed") throw new ProviderFailure("cancelled");
          const stepId = row?.id ?? stableExecutionId(jobId, spec.key);
          const owner = randomUUID();
          const saved = (await tx.query<{ fencing_token: string }>(`INSERT INTO unfurl.run_steps
            (id,job_id,step_key,input_digest,approval_digest,schema_digest,capability_digest,validation_policy_digest,status,attempt_count,lease_owner,lease_expires_at,fencing_token)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',1,$9,now()+interval '110s',1)
            ON CONFLICT(id) DO UPDATE SET status='running',attempt_count=run_steps.attempt_count+1,lease_owner=$9,
            lease_expires_at=now()+interval '110s',fencing_token=run_steps.fencing_token+1,updated_at=now() RETURNING fencing_token::text`,
          [stepId, jobId, spec.key, inputDigest, spec.digests.approval, spec.digests.schema, spec.digests.capability, spec.digests.validationPolicy, owner])).rows[0]!;
          return { replay: false as const, stepId, owner, fence: saved.fencing_token };
        });
        if (begun.replay) return begun.result;
        effects++;
        const effectContext: StepEffectContext = { stepId: begun.stepId, signal, deadlineAt,
          stepFence: { jobId, jobLeaseOwner: claim.leaseOwner, jobFencingToken: claim.fencingToken, retryEpoch: claim.retryEpoch,
            stepId: begun.stepId, stepLeaseOwner: begun.owner, stepFencingToken: begun.fence },
          budgetOperation(name, attempt = 1) {
            if (!/^[a-zA-Z0-9:._/-]{1,160}$/.test(name) || attempt !== 1) throw new ProviderFailure("invalid_output");
            const logicalOperationId = stableExecutionId(begun.stepId, name);
            return { logicalOperationId, reservationId: stableExecutionId(logicalOperationId, "attempt:1"), attempt: 1, runStepId: begun.stepId, probe: false };
          },
        };
        const output = spec.outputSchema.parse(await spec.effect(effectContext, spec.input));
        return this.transaction(async tx => {
          await guardClaim(tx, claim, handler);
          const step = (await tx.query<{ id: string }>(`SELECT id FROM unfurl.run_steps WHERE id=$1 AND status='running'
            AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>now() FOR UPDATE`, [begun.stepId, begun.owner, begun.fence])).rows[0];
          if (!step || signal.aborted) throw new ProviderFailure("cancelled");
          commitTx = tx;
          try {
            const result = spec.resultSchema.parse(await spec.commit(tx, output));
            canonicalJson(result, 2 * 1024 * 1024);
            await tx.query("UPDATE unfurl.run_steps SET status='succeeded',result_reference=$2,error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1", [begun.stepId, JSON.stringify(result)]);
            return result;
          } finally { commitTx = null; }
        });
      },
      emitChat: (tx, payload) => { requireCommit(tx); if (claim.target.kind !== "agent_turn") throw new ProviderFailure("invalid_output"); return appendChatEvent(tx, claim.target, payload); },
      emitGeneration: (tx, payload) => { requireCommit(tx); if (claim.target.kind !== "generation") throw new ProviderFailure("invalid_output"); return appendGenerationEvent(tx, claim.target, payload); },
      completeTurn: (tx, result) => { requireCommit(tx); return completeTurnInTransaction(tx, claim, result.status); },
      completeGeneration: (tx, result) => { requireCommit(tx); return completeGenerationInTransaction(tx, claim, result.courseVersionId); },
    };
    try {
      let status: "continue" | "awaiting_user" | "succeeded";
      try { status = (await handler.advance(context)).status; } catch (error) { if (error instanceof AdvanceBoundary) status = "continue"; else throw error; }
      await this.transaction(async tx => {
        const current = (await tx.query<{ status: string }>("SELECT status FROM unfurl.execution_jobs WHERE id=$1", [jobId])).rows[0];
        if (current && ["succeeded", "waiting"].includes(current.status)) return;
        await guardClaim(tx, claim, handler);
        if (status !== "continue" && ["agent_turn", "generation"].includes(claim.target.kind)) throw new ProviderFailure("invalid_output");
        await tx.query("UPDATE unfurl.execution_jobs SET status=$2,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1", [jobId, status === "continue" ? "queued" : status === "succeeded" ? "succeeded" : "waiting"]);
      });
      return { status: status === "continue" ? "continue" : "finished" };
    } catch (error) {
      if (error instanceof ProviderFailure) { await this.fail(claim, handler, error); return { status: "finished" }; }
      // Infrastructure interruption is left leased for the durable workflow to recover after expiry.
      throw error;
    } finally { clearInterval(timer); abort.abort(); }
  }
  private async fail(claim: JobClaim, handler: RunHandler, error: ProviderFailure) {
    await this.transaction(async tx => {
      try { await guardClaim(tx, claim, handler); } catch (failure) { if (failure instanceof ProviderFailure && failure.code === "cancelled") return; throw failure; }
      const fault = publicProviderFault(error);
      const safe = fault ? fault.toApiError(randomUUID()).error : null;
      const status = safe ? "failed" : "cancelled";
      if (claim.target.kind === "agent_turn") {
        await tx.query("UPDATE unfurl.agent_turn_runs SET status=$2,error=$3,updated_at=now() WHERE id=$1", [claim.target.runId,status,safe ? JSON.stringify(safe) : null]);
        await appendChatEvent(tx, claim.target, safe ? { type: "run.failed", error: safe } : { type: "run.cancelled", reason: "user" });
      } else if (claim.target.kind === "generation") {
        await tx.query("UPDATE unfurl.generation_runs SET status=$2,error=$3,updated_at=now() WHERE id=$1", [claim.target.runId,status,safe ? JSON.stringify(safe) : null]);
        await appendGenerationEvent(tx, claim.target, safe ? { type: "generation.failed", error: safe } : { type: "generation.cancelled", reason: "user" });
        await tx.query("UPDATE unfurl.course_versions SET state='failed' WHERE id=$1 AND state IN ('building','validating')", [claim.target.courseVersionId]);
      }
      await tx.query("UPDATE unfurl.execution_jobs SET status=$2,safe_error=$3,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1", [claim.jobId,status,safe ? JSON.stringify(safe) : null]);
      await tx.query("UPDATE unfurl.run_steps SET status=$2,error=$3,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE job_id=$1 AND status='running'", [claim.jobId,status,safe ? JSON.stringify(safe) : null]);
    });
  }
}
