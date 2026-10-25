import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import { loadApprovedBuild, type ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { PostgresResearchRepository } from "@/server/research/repository";
import { PostgresCurriculumResearchRepository } from "@/server/curriculum-research/repository";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import { loadProviderResponseEvidence } from "@/server/ai/receipts";
import { MODEL_ID } from "@/server/ai/constants";
import { ProviderFailure } from "@/server/ai/failure";
import { taskDigest } from "@/server/mechanics/digest";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { knowledgeClaimIds, validateModuleKnowledge } from "@/server/course-validation/knowledge";
import {
  AuthoredTaskSchema, COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST,
  ModuleKnowledgeCheckpointSchema, SourceClaimsCheckpointSchema, SourceClaimsProposalSchema,
  SourceReadCheckpointSchema, TaskCandidateCheckpointSchema,
} from "./checkpoints";
import { ModuleKnowledgeSchema, type ModuleKnowledge } from "./contracts";

const StepRowSchema = z.object({ id: IdSchema, input_digest: DigestSchema, result_reference: z.unknown(),
  schema_digest: DigestSchema, capability_digest: DigestSchema, validation_policy_digest: DigestSchema, approval_digest: DigestSchema });
export type StoredGenerationStep<T> = { id: string; inputDigest: string; result: T };
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

/** Reads original evidence from this run or an exact terminal retry ancestor. The runner is the only step writer. */
export async function loadGenerationStep<T>(tx: DbTransaction, binding: ApprovedBuildBinding, stepId: string, schema: z.ZodType<T>): Promise<StoredGenerationStep<T>> {
  const row = (await tx.query(`WITH RECURSIVE lineage AS (
    SELECT id,retry_of_run_id,ARRAY[id] AS path FROM unfurl.generation_runs
      WHERE id=$2 AND owner_id=$3 AND course_id=$4 AND approval_id=$5 AND source_draft_revision=$6
    UNION ALL
    SELECT parent.id,parent.retry_of_run_id,lineage.path||parent.id FROM unfurl.generation_runs parent
      JOIN lineage ON parent.id=lineage.retry_of_run_id
      WHERE parent.owner_id=$3 AND parent.course_id=$4 AND parent.approval_id=$5 AND parent.source_draft_revision=$6
        AND parent.status IN ('failed','cancelled') AND NOT parent.id=ANY(lineage.path)
  ) SELECT step.id,step.input_digest,step.result_reference,step.schema_digest,
    step.capability_digest,step.validation_policy_digest,step.approval_digest
    FROM unfurl.run_steps step JOIN unfurl.execution_jobs job ON job.id=step.job_id
    WHERE step.id=$1 AND job.generation_run_id IN (SELECT id FROM lineage) AND step.status='succeeded'`,
  [IdSchema.parse(stepId), binding.run.id, binding.course.ownerId, binding.course.id, binding.approval.id, binding.approval.draftRevision])).rows[0];
  const parsed = StepRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.schema_digest !== COURSE_GENERATION_SCHEMA_DIGEST ||
      parsed.data.validation_policy_digest !== COURSE_VALIDATION_POLICY_DIGEST || parsed.data.capability_digest !== getCapabilityCatalogDigest() ||
      parsed.data.approval_digest !== binding.approval.contentDigest) return invalid();
  return { id: parsed.data.id, inputDigest: parsed.data.input_digest, result: schema.parse(parsed.data.result_reference) };
}

/** Exact persisted provider response, including actual operation/step linkage; no model-authored receipt is accepted. */
export async function verifyStoredModelData<T>(tx: DbTransaction, step: Pick<StoredGenerationStep<unknown>, "id" | "inputDigest">,
  operationId: string, schema: z.ZodType<T>, expected: T): Promise<void> {
  const evidence = await loadProviderResponseEvidence(tx, { operationId, runStepId: step.id, inputDigest: step.inputDigest });
  const result = z.object({ model: z.literal(MODEL_ID), failure: z.null(), finishReason: z.literal("stop"), content: z.string() }).safeParse(evidence.result);
  if (!result.success) return invalid();
  let data: T;
  try { data = schema.parse(JSON.parse(result.data.content) as unknown); } catch { return invalid(); }
  if (taskDigest(data) !== taskDigest(expected)) return invalid();
}

export class GenerationEvidenceRepository {
  constructor(private readonly sources = new PostgresResearchRepository(), private readonly claims = new PostgresCurriculumResearchRepository()) {}

  async loadBinding(tx: DbTransaction, input: { runId: string; ownerId?: string; lock?: boolean }) {
    return loadApprovedBuild(tx, input);
  }

  private async sourceFacts(tx: DbTransaction, binding: ApprovedBuildBinding, knowledge: ModuleKnowledge,
    readStepIds: readonly string[]): Promise<CurriculumEvidenceFacts> {
    if (new Set(readStepIds).size !== readStepIds.length) return invalid();
    const sourceMap = new Map(binding.facts.sources.map((source) => [source.id, source]));
    const allowed = new Set(binding.facts.authorizedSourceIds);
    for (const stepId of readStepIds) {
      const read = await loadGenerationStep(tx, binding, stepId, SourceReadCheckpointSchema);
      if (read.result.moduleId !== knowledge.moduleId || read.result.approvalDigest !== binding.approval.contentDigest) return invalid();
      const source = await this.sources.getSource(tx, read.result.sourceId);
      if (!source || source.contentDigest !== read.result.contentDigest) return invalid();
      allowed.add(source.id); sourceMap.set(source.id, source);
    }
    const approvedClaims = new Set(binding.facts.claims.map((claim) => claim.id));
    const claims = [];
    for (const claimId of knowledgeClaimIds(knowledge)) {
      const claim = await this.claims.getClaim(tx, binding.course.ownerId, claimId);
      if (!claim) return invalid();
      if (!approvedClaims.has(claim.id)) {
        if (!claim.runStepId) return invalid();
        const extraction = await loadGenerationStep(tx, binding, claim.runStepId, SourceClaimsCheckpointSchema);
        if (extraction.result.moduleId !== knowledge.moduleId || extraction.result.sourceReadStepIds.some((id) => !readStepIds.includes(id))) return invalid();
        await verifyStoredModelData(tx, extraction, extraction.result.operationId, SourceClaimsProposalSchema, extraction.result.proposal);
        const savedClaim = extraction.result.claims.find((item) => item.id === claim.id);
        const proposed = extraction.result.proposal.claims.find((item) => item.id === claim.id);
        if (!savedClaim || !proposed || taskDigest(savedClaim) !== taskDigest(claim)) return invalid();
        const remappedIds = proposed.passageIds.map((id) => {
          const original = extraction.result.proposal.passages.find((passage) => passage.id === id);
          if (!original) return invalid();
          const { id: _id, ...coordinates } = original; void _id;
          const stored = extraction.result.passages.find((passage) => {
            const { id: _storedId, ...storedCoordinates } = passage; void _storedId;
            return taskDigest(storedCoordinates) === taskDigest(coordinates);
          });
          return stored?.id ?? invalid();
        });
        if (taskDigest({ ...proposed, passageIds: remappedIds, ownerId: claim.ownerId, runStepId: claim.runStepId, createdAt: claim.createdAt }) !== taskDigest(claim)) return invalid();
      }
      claims.push(claim);
    }
    const passages = await this.sources.getPassages(tx, [...new Set(claims.flatMap((claim) => claim.passageIds))]);
    return { ownerId: binding.course.ownerId, authorizedSourceIds: allowed, sources: [...sourceMap.values()], claims, passages };
  }

  async loadKnowledge(tx: DbTransaction, binding: ApprovedBuildBinding, stepId: string) {
    const step = await loadGenerationStep(tx, binding, stepId, ModuleKnowledgeCheckpointSchema);
    await verifyStoredModelData(tx, step, step.result.operationId, ModuleKnowledgeSchema, step.result.knowledge);
    const facts = await this.sourceFacts(tx, binding, step.result.knowledge, step.result.sourceReadStepIds);
    if (validateModuleKnowledge(step.result.knowledge, { ...facts, draft: binding.draft, approvalDigest: binding.approval.contentDigest }).length) return invalid();
    return { step, knowledge: step.result.knowledge, facts };
  }

  async loadTaskCandidate(tx: DbTransaction, binding: ApprovedBuildBinding, stepId: string) {
    const step = await loadGenerationStep(tx, binding, stepId, TaskCandidateCheckpointSchema);
    await verifyStoredModelData(tx, step, step.result.authoringOperationId, AuthoredTaskSchema, step.result.authored);
    const prepared = prepareTaskCandidate(step.result.authored, { approvalDigest: binding.approval.contentDigest });
    if (taskDigest(prepared) !== taskDigest(step.result.candidate)) return invalid();
    const knowledge = await this.loadKnowledge(tx, binding, step.result.knowledgeStepId);
    if (knowledge.knowledge.moduleId !== step.result.moduleId) return invalid();
    const knownClaims = knowledgeClaimIds(knowledge.knowledge);
    if (!prepared.privateTask.sourceClaimIds.length || prepared.privateTask.sourceClaimIds.some((id) => !knownClaims.has(id))) return invalid();
    for (const outcomeId of prepared.task.outcomeIds) {
      const outcome = knowledge.knowledge.outcomes.find((item) => item.outcomeId === outcomeId);
      if (!outcome || !prepared.privateTask.sourceClaimIds.some((id) => knowledgeClaimIds(knowledge.knowledge, outcomeId).has(id))) return invalid();
      if (prepared.privateTask.assessment.outcomes.find((item) => item.outcomeId === outcomeId)?.dimensions.some((dimension) => !outcome.criteria.some((criterion) => criterion.id === dimension.dimensionId))) return invalid();
    }
    return { step, candidate: prepared, design: step.result.authored.design,
      knowledge: knowledge.knowledge, facts: knowledge.facts, knowledgeStep: knowledge.step };
  }
}
