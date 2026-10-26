import "server-only";
import { IdSchema } from "../../domain/common";
import type { GenerationRun } from "../../domain/generation";
import { GenerationProgressSchema, type GenerationProgress } from "../../domain/generation-observer";
import type { DbTransaction } from "../db";

interface StoredProgress {
  job_id: string; generation_run_id: string; owner_id: string; approval_id: string; approval_digest: string;
  job_status: string; job_live: boolean; job_updated_at: Date | string;
  step_key: string | null; step_status: string | null; step_live: boolean | null; step_updated_at: Date | string | null;
}
interface ClassifiedStep { stage: GenerationProgress["stage"]; moduleId?: string; caseId?: string }

/** Only this vocabulary crosses the observer boundary; durable keys and task material remain private. */
export function classifyGenerationStep(key: string | null, approvedModules: ReadonlySet<string>): ClassifiedStep | null {
  if (!key || !/^[a-zA-Z0-9:._/-]{1,240}$/.test(key)) return null;
  if (key === "course/materialize") return { stage: "finalizing_course" };
  const activity = /^course\/case\/([^/]+)\/activity\/(?:evaluate|\d+\/(?:draft|audit|action))$/.exec(key);
  if (activity && IdSchema.safeParse(activity[1]).success) return { stage: "validating_practice", caseId: activity[1]! };
  const section = /^course\/([^/]+)\/(.+)$/.exec(key);
  if (!section || !approvedModules.has(section[1]!) || !IdSchema.safeParse(section[1]).success) return null;
  const moduleId = section[1]!, suffix = section[2]!;
  const researchSuffix = suffix.replace(/^research\/coverage-v1\/round\/\d+\/revision\/\d+\//, "research/");
  let stage: GenerationProgress["stage"] | null = null;
  if (suffix === "research-v2/approved-knowledge" || /^research\/(?:plan|selection|knowledge|(?:search|claims)\/[^/]+)$/.test(researchSuffix)
    || /^research\/coverage-v1\/round\/\d+\/(?:checked|revision\/\d+\/review\/[^/]+)$/.test(suffix)) stage = "researching";
  else if (/^research\/read\/[^/]+$/.test(researchSuffix)) stage = "reading_sources";
  else if (/^round\/\d+\/plan(?:\/(?:bounded-v1\/)?[^/]+\/\d+)?$/.test(suffix)) stage = "planning_lessons";
  else if (/^round\/\d+\/reading\/[^/]+(?:\/[^/]+\/\d+)?$/.test(suffix)) stage = "writing_lessons";
  else if (/^round\/\d+\/(?:task\/[^/]+\/\d+|batch\/v2\/(?:repair\/)?[^/]+\/\d+)\/candidate$/.test(suffix)) stage = "creating_practice";
  else if (/^round\/\d+\/task\/[^/]+\/\d+\/(?:cases|review|validation|case\/[^/]+(?:\/execute)?|specialized\/[^/]+)$/.test(suffix)
    || /^round\/\d+\/batch\/v2\/(?:repair\/)?[^/]+\/\d+\/(?:cases|review|prepared)$/.test(suffix)) stage = "validating_practice";
  else if (/^round\/\d+\/review(?:\/[^/]+)?$/.test(suffix) || /^repair\/\d+$/.test(suffix)) stage = "reviewing_section";
  else if (suffix === "complete") stage = "saving_section";
  return stage ? { stage, moduleId } : null;
}

/** Read existing execution records so workflows pinned to older code gain truthful progress too. */
export async function readGenerationProgress(tx: DbTransaction, run: GenerationRun, approvalDigest: string,
  approvedModuleIds: readonly string[], completedModuleIds: ReadonlySet<string>): Promise<GenerationProgress | undefined> {
  if (!["queued", "running"].includes(run.status)) return undefined;
  const stored = (await tx.query<StoredProgress>(`SELECT j.id AS job_id,j.generation_run_id,r.owner_id,r.approval_id,
      a.content_digest AS approval_digest,j.status AS job_status,j.lease_expires_at>statement_timestamp() AS job_live,
      j.updated_at AS job_updated_at,s.step_key,s.status AS step_status,s.lease_expires_at>statement_timestamp() AS step_live,
      s.updated_at AS step_updated_at
    FROM unfurl.execution_jobs j JOIN unfurl.generation_runs r ON r.id=j.generation_run_id
    JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id AND a.approved_by=r.owner_id
    LEFT JOIN LATERAL (SELECT step_key,status,lease_expires_at,updated_at FROM unfurl.run_steps
      WHERE job_id=j.id AND approval_digest=$4 AND status IN ('running','succeeded')
      ORDER BY (status='running' AND lease_expires_at>statement_timestamp()) DESC NULLS LAST,updated_at DESC,id DESC LIMIT 1) s ON true
    WHERE r.id=$1 AND r.owner_id=$2 AND r.approval_id=$3 AND a.content_digest=$4 AND j.status IN ('queued','running')`,
  [run.id, run.ownerId, run.approvalId, approvalDigest])).rows[0];
  const waiting: GenerationProgress = { stage: "preparing", activity: "waiting", updatedAt: run.updatedAt };
  if (!stored || stored.generation_run_id !== run.id || stored.owner_id !== run.ownerId
    || stored.approval_id !== run.approvalId || stored.approval_digest !== approvalDigest) return waiting;
  const updatedAt = [run.updatedAt, stored.job_updated_at, stored.step_updated_at].filter(value => value !== null)
    .map(value => new Date(value!).toISOString()).sort().at(-1)!;
  const classified = classifyGenerationStep(stored.step_key, new Set(approvedModuleIds));
  const active = run.status === "running" && stored.job_status === "running" && stored.job_live === true
    && stored.step_status === "running" && stored.step_live === true;
  let moduleId = classified?.moduleId;
  if (classified?.caseId) {
    const candidates = (await tx.query<{ module_id: string }>(`SELECT DISTINCT candidate.result_reference->>'moduleId' AS module_id
      FROM unfurl.run_steps cases JOIN unfurl.run_steps candidate
        ON candidate.id::text=cases.result_reference->>'candidateStepId' AND candidate.job_id=cases.job_id
      WHERE cases.job_id=$1 AND cases.approval_digest=$2 AND candidate.approval_digest=$2
        AND cases.status='succeeded' AND candidate.status='succeeded'
        AND cases.result_reference->>'kind'='course.task.cases' AND candidate.result_reference->>'kind'='course.task.candidate'
        AND cases.result_reference->'cases' @> $3::jsonb AND candidate.result_reference->>'moduleId'=ANY($4::text[])
      LIMIT 2`, [stored.job_id, approvalDigest, JSON.stringify([{ caseId: classified.caseId }]), [...approvedModuleIds]])).rows;
    if (candidates.length === 1 && approvedModuleIds.includes(candidates[0]!.module_id)) moduleId = candidates[0]!.module_id;
  }
  if (moduleId && completedModuleIds.has(moduleId)) moduleId = undefined;
  let completedSources: number | undefined;
  if (moduleId) {
    // Count successful read proofs across original and targeted research paths.
    // A path name alone is neither evidence of a completed read nor its approved scope.
    const count = (await tx.query<{ completed_sources: number }>(`SELECT count(DISTINCT result_reference->>'sourceId')::int AS completed_sources
      FROM unfurl.run_steps WHERE job_id=$1 AND approval_digest=$2 AND status='succeeded'
        AND result_reference->>'kind'='course.source.read'
        AND result_reference->>'moduleId'=$3 AND result_reference->>'approvalDigest'=$2`,
    [stored.job_id, approvalDigest, moduleId])).rows[0]?.completed_sources;
    if (Number.isSafeInteger(count) && count! >= 0) completedSources = count;
  }
  return GenerationProgressSchema.parse({ stage: active ? classified?.stage ?? "preparing" : "preparing",
    activity: active ? "running" : "waiting", updatedAt,
    ...(moduleId ? { moduleId, ...(completedSources === undefined ? {} : { completedSources }) } : {}) });
}
