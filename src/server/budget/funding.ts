import "server-only";
import { z } from "zod";
import type { DbTransaction } from "../db";
import { withSystemTransaction } from "../db";
import { ProviderFailure } from "../ai/failure";
import { jsonDigest } from "../ai/json";
import type { BudgetOperationContext } from "./ports";

export const FUNDING_VERSION = "actor-funding-v1" as const;
export type FundingKind = "verification" | "site";
export interface ExecutionFunding { budgetId: string; kind: FundingKind }
export interface FundingConfiguration {
  version: typeof FUNDING_VERSION; verification_budget_id: string; site_budget_id: string;
  verification_actor_id: string;
}
const unavailable = () => new ProviderFailure("unavailable");
function legacyFunding(): ExecutionFunding {
  const id = z.uuid().safeParse(process.env.AI_BUDGET_ID);
  if (!id.success) throw unavailable();
  return { budgetId: id.data, kind: "verification" };
}
export async function readFundingConfiguration(tx: DbTransaction): Promise<FundingConfiguration | null> {
  const row = (await tx.query<FundingConfiguration>(`SELECT version,verification_budget_id,site_budget_id,verification_actor_id
    FROM unfurl.ai_funding_configuration WHERE singleton=true`)).rows[0];
  if (!row) return null;
  if (row.version !== FUNDING_VERSION || row.verification_budget_id !== legacyFunding().budgetId ||
      row.verification_budget_id === row.site_budget_id || !z.uuid().safeParse(row.site_budget_id).success ||
      !z.uuid().safeParse(row.verification_actor_id).success) throw unavailable();
  return row;
}
export function fundingForActor(config: FundingConfiguration | null, actorId: string): ExecutionFunding {
  z.uuid().parse(actorId);
  if (!config) return legacyFunding();
  return actorId === config.verification_actor_id
    ? { budgetId: config.verification_budget_id, kind: "verification" }
    : { budgetId: config.site_budget_id, kind: "site" };
}
export async function resolveActorFunding(actorId: string, tx?: DbTransaction): Promise<ExecutionFunding> {
  const resolve = async (db: DbTransaction) => fundingForActor(await readFundingConfiguration(db), actorId);
  return tx ? resolve(tx) : withSystemTransaction("run_execution", resolve);
}
export async function configuredFundingIds(tx: DbTransaction): Promise<string[]> {
  const config = await readFundingConfiguration(tx);
  return config ? [config.verification_budget_id, config.site_budget_id] : [legacyFunding().budgetId];
}
/** Public readiness describes ordinary site work; it never authorizes a paid operation. */
export async function resolveSiteFunding(): Promise<ExecutionFunding> {
  return withSystemTransaction("run_execution", async tx => {
    const config = await readFundingConfiguration(tx);
    return config ? { budgetId: config.site_budget_id, kind: "site" } : legacyFunding();
  });
}

interface JobIdentity {
  id: string; actor_id: string | null; agent_turn_run_id: string | null; generation_run_id: string | null;
  evaluation_id: string | null; target_evaluation_revision: number | null; activity_action_id: string | null; funding_version: string | null;
}
interface FundingRow { actor_id: string; budget_id: string; kind: FundingKind; target_digest: string; version: string }
const selectJob = `SELECT j.id,j.agent_turn_run_id,j.generation_run_id,j.evaluation_id,j.target_evaluation_revision,j.activity_action_id,j.funding_version,
  COALESCE(t.owner_id,g.owner_id,a.learner_id,e.learner_id) AS actor_id
  FROM unfurl.execution_jobs j
  LEFT JOIN unfurl.agent_turn_runs t ON t.id=j.agent_turn_run_id
  LEFT JOIN unfurl.generation_runs g ON g.id=j.generation_run_id
  LEFT JOIN unfurl.evaluations v ON v.id=j.evaluation_id LEFT JOIN unfurl.attempts a ON a.id=v.attempt_id
  LEFT JOIN unfurl.activity_actions aa ON aa.id=j.activity_action_id
  LEFT JOIN unfurl.activity_sessions s ON s.id=aa.activity_session_id LEFT JOIN unfurl.enrollments e ON e.id=s.enrollment_id`;
function targetDigest(job: JobIdentity): string {
  if (!job.actor_id || !z.uuid().safeParse(job.actor_id).success ||
      [job.agent_turn_run_id, job.generation_run_id, job.evaluation_id, job.activity_action_id].filter(Boolean).length !== 1) throw unavailable();
  return jsonDigest({ jobId: job.id, actorId: job.actor_id, agentTurnRunId: job.agent_turn_run_id,
    generationRunId: job.generation_run_id, evaluationId: job.evaluation_id,
    targetEvaluationRevision: job.target_evaluation_revision, activityActionId: job.activity_action_id });
}
/** New jobs only. Existing jobs deliberately retain the original verification ledger. */
export async function captureNewJobFunding(tx: DbTransaction, jobId: string): Promise<ExecutionFunding | null> {
  z.uuid().parse(jobId);
  const config = await readFundingConfiguration(tx);
  if (!config) return null;
  const job = (await tx.query<JobIdentity>(`${selectJob} WHERE j.id=$1`, [jobId])).rows[0];
  if (!job?.actor_id || job.funding_version !== FUNDING_VERSION) throw unavailable();
  const digest = targetDigest(job), funding = fundingForActor(config, job.actor_id);
  await tx.query(`INSERT INTO unfurl.execution_job_funding(job_id,actor_id,budget_id,kind,target_digest,version)
    VALUES($1,$2,$3,$4,$5,$6)`, [jobId, job.actor_id, funding.budgetId, funding.kind, digest, FUNDING_VERSION]);
  return funding;
}
/** Selection is derived from a durable step, never from a request-supplied budget id. */
export async function resolveOperationFunding(tx: DbTransaction, context: BudgetOperationContext): Promise<ExecutionFunding> {
  if (context.probe) {
    if (context.runStepId !== null) throw unavailable();
    return legacyFunding();
  }
  if (!context.runStepId) throw unavailable();
  const job = (await tx.query<JobIdentity>(`${selectJob} JOIN unfurl.run_steps effect ON effect.job_id=j.id WHERE effect.id=$1`, [context.runStepId])).rows[0];
  if (!job) throw unavailable();
  return fundingForJob(tx, job);
}
export async function resolveJobFunding(tx: DbTransaction, jobId: string): Promise<ExecutionFunding> {
  const job = (await tx.query<JobIdentity>(`${selectJob} WHERE j.id=$1`, [z.uuid().parse(jobId)])).rows[0];
  if (!job) throw unavailable();
  return fundingForJob(tx, job);
}
async function fundingForJob(tx: DbTransaction, job: JobIdentity): Promise<ExecutionFunding> {
  const binding = (await tx.query<FundingRow>(`SELECT actor_id,budget_id,kind,target_digest,version FROM unfurl.execution_job_funding WHERE job_id=$1`, [job.id])).rows[0];
  if (job.funding_version === null) {
    if (binding) throw unavailable();
    return legacyFunding();
  }
  if (job.funding_version !== FUNDING_VERSION || !binding) throw unavailable();
  const config = await readFundingConfiguration(tx);
  if (!config || !job.actor_id) throw unavailable();
  const expected = fundingForActor(config, job.actor_id);
  if (binding.version !== FUNDING_VERSION || binding.actor_id !== job.actor_id || binding.target_digest !== targetDigest(job) ||
      binding.budget_id !== expected.budgetId || binding.kind !== expected.kind) throw unavailable();
  return expected;
}
export async function assertOperationFunding(tx: DbTransaction, context: BudgetOperationContext, budgetId: string): Promise<void> {
  // Historical deployments and rollback fixtures have no scope configuration.
  // Even there, a site ledger is never eligible without a durable binding.
  const config = await readFundingConfiguration(tx);
  if (!config) {
    const row = (await tx.query<{kind: FundingKind}>("SELECT kind FROM unfurl.ai_budgets WHERE id=$1", [budgetId])).rows[0];
    if (!row || row.kind !== "verification") throw unavailable();
    return;
  }
  if ((await resolveOperationFunding(tx, context)).budgetId !== budgetId) throw unavailable();
}
