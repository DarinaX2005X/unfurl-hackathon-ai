import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import { loadApprovedBuild, type ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { PostgresResearchRepository } from "@/server/research/repository";
import { PostgresCurriculumResearchRepository } from "@/server/curriculum-research/repository";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import { loadProviderResponseEvidence } from "@/server/ai/receipts";
import { modelPolicy, ModelPolicySchema } from "@/server/ai/model-policy";
import { jsonDigest } from "@/server/ai/json";
import { ProviderFailure } from "@/server/ai/failure";
import { taskDigest } from "@/server/mechanics/digest";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { knowledgeClaimIds, validateModuleKnowledge } from "@/server/course-validation/knowledge";
import {
  AuthoredTaskSchema, COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST,
  AnyModuleKnowledgeCheckpointSchema, ApprovedKnowledgeSufficientProposalSchema, SourceClaimsCheckpointSchema, SourceClaimsProposalSchema,
  SourceReadCheckpointSchema, TaskCandidateCheckpointSchema, COURSE_GENERATION_V2_SCHEMA_DIGEST, COURSE_VALIDATION_V2_POLICY_DIGEST,
  COURSE_GENERATION_POLICY_KEY, CourseGenerationPolicyCheckpointSchema, ModelBatchCheckpointSchema, batchResponseSchema,
  type BatchItemProof, type BatchKind,
} from "./checkpoints";
import { ModuleKnowledgeSchema, type ModuleKnowledge } from "./contracts";
import { approvedResearchFactsDigest, assertBatchItemProjection } from "./batch-provenance";

const StepRowSchema = z.object({ id: IdSchema, input_digest: DigestSchema, result_reference: z.unknown(),
  schema_digest: DigestSchema, capability_digest: DigestSchema, validation_policy_digest: DigestSchema, approval_digest: DigestSchema,
  generation_policy: z.unknown().optional() });
export type StoredGenerationStep<T> = { id: string; inputDigest: string; result: T };
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

export async function resolveGenerationPolicy(tx: DbTransaction, binding: ApprovedBuildBinding): Promise<"legacy-v1" | "batch-v2"> {
  const rows = (await tx.query(`WITH RECURSIVE lineage AS (
    SELECT id,retry_of_run_id,0 AS depth,ARRAY[id] AS path FROM unfurl.generation_runs
      WHERE id=$1 AND owner_id=$2 AND course_id=$3 AND approval_id=$4 AND source_draft_revision=$5
    UNION ALL SELECT parent.id,parent.retry_of_run_id,lineage.depth+1,lineage.path||parent.id
      FROM unfurl.generation_runs parent JOIN lineage ON parent.id=lineage.retry_of_run_id
      WHERE parent.owner_id=$2 AND parent.course_id=$3 AND parent.approval_id=$4 AND parent.source_draft_revision=$5
        AND parent.status IN ('failed','cancelled') AND NOT parent.id=ANY(lineage.path)
  ) SELECT lineage.id,lineage.retry_of_run_id,lineage.depth,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('key',s.step_key,'status',s.status,'result',
      CASE WHEN s.step_key='course/generation-policy' THEN s.result_reference ELSE NULL END,
      'schema',s.schema_digest,'validationPolicy',s.validation_policy_digest,'capability',s.capability_digest,'approval',s.approval_digest))
      FROM unfurl.run_steps s JOIN unfurl.execution_jobs j ON j.id=s.job_id WHERE j.generation_run_id=lineage.id),'[]'::jsonb) AS steps
    FROM lineage ORDER BY depth`, [binding.run.id, binding.course.ownerId, binding.course.id, binding.approval.id, binding.approval.draftRevision])).rows;
  const lineage = z.array(z.object({ id: IdSchema, retry_of_run_id: IdSchema.nullable(), depth: z.number().int().nonnegative(),
    steps: z.array(z.object({ key: z.string(), status: z.string(), result: z.unknown(), schema: z.string().nullable(),
      validationPolicy: z.string().nullable(), capability: z.string().nullable(), approval: z.string().nullable() })) })).parse(rows);
  if (!lineage.length || lineage[0]!.id !== binding.run.id || lineage.at(-1)!.retry_of_run_id !== null ||
      lineage.some((row, index) => row.depth !== index || (index + 1 < lineage.length && row.retry_of_run_id !== lineage[index + 1]!.id))) return invalid();
  const states = lineage.map((row) => {
    const policies = row.steps.filter((step) => step.key === COURSE_GENERATION_POLICY_KEY);
    if (policies.length > 1) return invalid();
    const policy = policies[0];
    if (policy?.status === "succeeded") {
      const parsed = CourseGenerationPolicyCheckpointSchema.safeParse(policy.result);
      if (!parsed.success || parsed.data.approvalDigest !== binding.approval.contentDigest || policy.schema !== COURSE_GENERATION_SCHEMA_DIGEST ||
          policy.validationPolicy !== COURSE_VALIDATION_POLICY_DIGEST || policy.capability !== getCapabilityCatalogDigest() || policy.approval !== binding.approval.contentDigest) return invalid();
      return "batch-v2" as const;
    }
    return row.steps.some((step) => step.key !== COURSE_GENERATION_POLICY_KEY) ? "legacy-v1" as const : "empty" as const;
  });
  if (lineage.length > 1) {
    // An untouched failed delivery between the current retry and its v2 origin cannot change the protocol.
    const inherited = states.at(-1) === "batch-v2" && states.slice(1).every((state) => state !== "legacy-v1") ? "batch-v2" : "legacy-v1";
    if (states[0] === "batch-v2" && inherited !== "batch-v2") return invalid();
    if (states[0] === "legacy-v1" && inherited === "batch-v2") return invalid();
    return inherited;
  }
  return states[0] === "legacy-v1" ? "legacy-v1" : "batch-v2";
}

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
    step.capability_digest,step.validation_policy_digest,step.approval_digest,
    (SELECT jsonb_build_object('result',policy.result_reference,'schema',policy.schema_digest,
      'validationPolicy',policy.validation_policy_digest,'capability',policy.capability_digest,'approval',policy.approval_digest)
     FROM unfurl.run_steps policy WHERE policy.job_id=step.job_id AND policy.step_key='course/generation-policy'
       AND policy.status='succeeded') AS generation_policy
    FROM unfurl.run_steps step JOIN unfurl.execution_jobs job ON job.id=step.job_id
    WHERE step.id=$1 AND job.generation_run_id IN (SELECT id FROM lineage) AND step.status='succeeded'`,
  [IdSchema.parse(stepId), binding.run.id, binding.course.ownerId, binding.course.id, binding.approval.id, binding.approval.draftRevision])).rows[0];
  const parsed = StepRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.capability_digest !== getCapabilityCatalogDigest() || parsed.data.approval_digest !== binding.approval.contentDigest) return invalid();
  const oldProtocol = parsed.data.schema_digest === COURSE_GENERATION_SCHEMA_DIGEST && parsed.data.validation_policy_digest === COURSE_VALIDATION_POLICY_DIGEST;
  const newProtocol = parsed.data.schema_digest === COURSE_GENERATION_V2_SCHEMA_DIGEST && parsed.data.validation_policy_digest === COURSE_VALIDATION_V2_POLICY_DIGEST;
  if (!oldProtocol && !newProtocol) return invalid();
  const versioned = z.object({ kind: z.string().optional(), modelProof: z.unknown().optional() }).passthrough().safeParse(parsed.data.result_reference);
  if (!newProtocol && versioned.success && (versioned.data.kind === "course.model.batch.v2" ||
      versioned.data.kind === "course.module.approved_knowledge" || versioned.data.kind === "course.module.approved_knowledge_gap" || versioned.data.modelProof !== undefined)) return invalid();
  if (newProtocol) {
    const policy = z.object({ result: CourseGenerationPolicyCheckpointSchema, schema: z.literal(COURSE_GENERATION_SCHEMA_DIGEST),
      validationPolicy: z.literal(COURSE_VALIDATION_POLICY_DIGEST), capability: z.literal(getCapabilityCatalogDigest()), approval: z.literal(binding.approval.contentDigest) }).safeParse(parsed.data.generation_policy);
    if (!policy.success || policy.data.result.approvalDigest !== binding.approval.contentDigest) return invalid();
  }
  return { id: parsed.data.id, inputDigest: parsed.data.input_digest, result: schema.parse(parsed.data.result_reference) };
}

/** Exact persisted provider response, including actual operation/step linkage; no model-authored receipt is accepted. */
export async function verifyStoredModelData<T>(tx: DbTransaction, step: Pick<StoredGenerationStep<unknown>, "id" | "inputDigest">,
  operationId: string, schema: z.ZodType<T>, expected: T): Promise<void> {
  await verifyStoredModelDataAndIdentity(tx, step, operationId, schema, expected);
}

/** The operation's immutable approved profile, never today's active policy, decides its exact identity. */
export async function verifyStoredModelDataAndIdentity<T>(tx: DbTransaction, step: Pick<StoredGenerationStep<unknown>, "id" | "inputDigest">,
  operationId: string, schema: z.ZodType<T>, expected: T) {
  const evidence = await loadProviderResponseEvidence(tx, { operationId, runStepId: step.id, inputDigest: step.inputDigest });
  const operation = z.object({ model_id: z.string(), provider_tag: z.string(), rate_card_digest: DigestSchema,
    rate_card: z.object({ policyVersion: ModelPolicySchema, model: z.string(), provider: z.string() }).passthrough() }).safeParse(
    (await tx.query("SELECT model_id,provider_tag,rate_card_digest,rate_card FROM unfurl.ai_provider_operations WHERE id=$1 AND run_step_id=$2 AND state='settled'", [operationId, step.id])).rows[0]);
  if (!operation.success) return invalid();
  const recorded = operation.data, policy = modelPolicy(recorded.rate_card.policyVersion);
  if (recorded.model_id !== policy.model || recorded.provider_tag !== policy.provider || recorded.rate_card.model !== policy.model ||
      recorded.rate_card.provider !== policy.provider || recorded.rate_card_digest !== evidence.rateCardDigest ||
      jsonDigest(recorded.rate_card, 64 * 1024) !== recorded.rate_card_digest) return invalid();
  const result = z.object({ model: z.literal(policy.model), provider: z.literal(policy.providerName), failure: z.null(), finishReason: z.literal("stop"), content: z.string() }).safeParse(evidence.result);
  if (!result.success) return invalid();
  let data: T;
  try { data = schema.parse(JSON.parse(result.data.content) as unknown); } catch { return invalid(); }
  if (taskDigest(data) !== taskDigest(expected)) return invalid();
  return policy.model;
}

export async function verifyStoredBatchItem<T>(tx: DbTransaction, binding: ApprovedBuildBinding,
  childStep: StoredGenerationStep<unknown>, operationId: string, proof: BatchItemProof, itemSchema: z.ZodType<T>, expected: T, batchKind: BatchKind) {
  if (proof.batchStepId === childStep.id) return invalid();
  const parent = await loadGenerationStep(tx, binding, proof.batchStepId, ModelBatchCheckpointSchema);
  if (parent.result.operationId !== operationId || parent.inputDigest !== jsonDigest(parent.result.material)) return invalid();
  const responseSchema = batchResponseSchema(itemSchema), response = responseSchema.parse({ items: parent.result.items });
  const modelId = await verifyStoredModelDataAndIdentity(tx, parent, operationId, responseSchema, response);
  const child = z.object({ moduleId: IdSchema.optional(), knowledgeStepId: IdSchema.optional(), candidateStepId: IdSchema.optional(), candidateDigest: DigestSchema.optional(),
    material: z.unknown().optional() }).passthrough().parse(childStep.result);
  const candidateDigest = child.candidateDigest ?? (batchKind === "review" ? z.object({ candidateDigest: DigestSchema }).parse(child.material).candidateDigest : undefined);
  const projection = assertBatchItemProjection({ proof, batchKind: parent.result.batchKind, expectedKind: batchKind,
    material: parent.result.material, items: response.items, childInputDigest: childStep.inputDigest,
    approvalDigest: binding.approval.contentDigest, expected, candidateStepId: child.candidateStepId, candidateDigest });
  if (!binding.draft.modules.some((module) => module.id === projection.material.moduleId)) return invalid();
  if (batchKind === "candidate") {
    const authored = AuthoredTaskSchema.parse(expected);
    if (authored.task.id !== proof.itemId || child.moduleId !== projection.material.moduleId || !child.knowledgeStepId) return invalid();
    const knowledge = await loadGenerationStep(tx, binding, child.knowledgeStepId, AnyModuleKnowledgeCheckpointSchema);
    const authoredContext = z.object({ knowledge: ModuleKnowledgeSchema }).parse(projection.request.material);
    if (taskDigest(knowledge.result.knowledge) !== taskDigest(authoredContext.knowledge)) return invalid();
  } else {
    const candidate = await loadGenerationStep(tx, binding, child.candidateStepId!, TaskCandidateCheckpointSchema);
    if (candidate.result.candidate.task.id !== proof.itemId || candidate.result.candidate.candidateDigest !== candidateDigest ||
        candidate.result.moduleId !== projection.material.moduleId || candidate.result.authoringOperationId === operationId) return invalid();
  }
  return modelId;
}

export async function verifyStoredModelItem<T>(tx: DbTransaction, binding: ApprovedBuildBinding, step: StoredGenerationStep<unknown>,
  operationId: string, schema: z.ZodType<T>, expected: T, proof?: BatchItemProof, batchKind?: BatchKind) {
  if (proof) {
    if (!batchKind) return invalid();
    return verifyStoredBatchItem(tx, binding, step, operationId, proof, schema, expected, batchKind);
  }
  return verifyStoredModelDataAndIdentity(tx, step, operationId, schema, expected);
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
    const step = await loadGenerationStep(tx, binding, stepId, AnyModuleKnowledgeCheckpointSchema);
    if (step.result.kind === "course.module.approved_knowledge") {
      if (step.result.approvedFactsDigest !== approvedResearchFactsDigest(binding.facts) || taskDigest(step.result.knowledge) !== taskDigest(step.result.proposal.knowledge)) return invalid();
      await verifyStoredModelData(tx, step, step.result.operationId, ApprovedKnowledgeSufficientProposalSchema, step.result.proposal);
    } else await verifyStoredModelData(tx, step, step.result.operationId, ModuleKnowledgeSchema, step.result.knowledge);
    const facts = await this.sourceFacts(tx, binding, step.result.knowledge, step.result.sourceReadStepIds);
    if (step.result.kind === "course.module.approved_knowledge") {
      for (const claim of facts.claims) {
        const approved = binding.facts.claims.find((entry) => entry.id === claim.id);
        if (!approved || taskDigest(approved) !== taskDigest(claim)) return invalid();
      }
      for (const passage of facts.passages) {
        const approved = binding.facts.passages.find((entry) => entry.id === passage.id);
        if (!approved || taskDigest(approved) !== taskDigest(passage)) return invalid();
      }
    }
    if (validateModuleKnowledge(step.result.knowledge, { ...facts, draft: binding.draft, approvalDigest: binding.approval.contentDigest }).length) return invalid();
    return { step, knowledge: step.result.knowledge, facts };
  }

  async loadTaskCandidate(tx: DbTransaction, binding: ApprovedBuildBinding, stepId: string) {
    const step = await loadGenerationStep(tx, binding, stepId, TaskCandidateCheckpointSchema);
    await verifyStoredModelItem(tx, binding, step, step.result.authoringOperationId, AuthoredTaskSchema, step.result.authored, step.result.modelProof, "candidate");
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
