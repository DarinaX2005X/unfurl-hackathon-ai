import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonValueSchema } from "@/domain/common";
import { AlternativeSpaceProofSchema, PreparedTaskCandidateSchema } from "@/server/mechanics/contracts";
import { AuthoredModuleSchema, ModuleKnowledgeSchema } from "./contracts";
import { jsonDigest } from "@/server/ai/json";
import { ProposedResponseCaseSchema, ResponseCaseSchema } from "@/server/course-validation/case-evaluation";
import { stableExecutionId } from "@/server/runs/identity";
import { SourceClaimSchema } from "@/server/curriculum-research/contracts";
import { PassageSchema, SourceReadInputSchema } from "@/server/research/ports";
import { ContentReviewSchema } from "@/server/course-validation/content-review";
import { KnowledgeCoverageReviewSchema } from "@/server/course-validation/knowledge";
import { ModelPolicySchema,SearchPolicySchema } from "@/server/ai/model-policy";
import { ReaderCapabilitiesSchema } from "@/server/research/reader-capabilities";

export const COURSE_GENERATION_SCHEMA_DIGEST = jsonDigest({ courseGeneration: 3, knowledge: 1, candidate: 1, validation: 1, readingPieces: 1, moduleReviewPages: 1, plannedAssessmentRoles: 1, planPages: 1 });
export const COURSE_VALIDATION_POLICY_DIGEST = jsonDigest({ courseValidation: 2, independentContentReview: 1, requiredOutcomeCoverage: 1, immutableEvidence: 1, adaptiveMaterial: 1 });
/** Additive protocol: old checkpoint digests and paid request schemas remain immutable. */
export const COURSE_GENERATION_V2_SCHEMA_DIGEST = jsonDigest({ legacy: COURSE_GENERATION_SCHEMA_DIGEST, batchItems: 2, approvedKnowledge: 1 });
export const COURSE_VALIDATION_V2_POLICY_DIGEST = jsonDigest({ legacy: COURSE_VALIDATION_POLICY_DIGEST, batchProvenance: 2, operationModelIdentity: 1 });
export const COURSE_GENERATION_POLICY_KEY = "course/generation-policy";
export const CourseGenerationPolicyCheckpointSchema = z.object({ kind: z.literal("course.generation.policy"),
  version: z.literal("course-generation-batch-v2"), batchSize: z.literal(5), maxOutputTokens: z.literal(16384), approvalDigest: DigestSchema,
  planPagePolicy: z.enum(["bounded-plan-pages-v1", "server-plan-identities-v2"]).optional(),
  knowledgeCoveragePolicy: z.literal("approved-scope-v1").optional(),
  taskAuthoringContractPolicy: z.literal("complete-task-contract-v1").optional(),
  taskIdentityPolicy: z.literal("task-private-identities-v1").optional(),
  sourceClaimIdentityPolicy: z.enum(["server-source-identities-v1", "server-source-spans-v2"]).optional(),
  modelPolicy: ModelPolicySchema.optional(),
  searchPolicy: SearchPolicySchema.optional(),
  readerCapabilities: ReaderCapabilitiesSchema.optional(),
  sourceSelectionPolicy: z.enum(["source-selection-v1", "source-selection-v2"]).optional(),
}).strict().refine(value => Boolean(value.readerCapabilities) === Boolean(value.sourceSelectionPolicy) &&
  (!value.readerCapabilities || value.sourceSelectionPolicy === (value.readerCapabilities.version === "text-pdf-parts-v2" ? "source-selection-v2" : "source-selection-v1")),
"Reader and source-selection policies must be captured together with matching versions");
export const BatchKindSchema = z.enum(["candidate", "cases", "review"]);
export type BatchKind = z.infer<typeof BatchKindSchema>;
export const BatchItemProofSchema = z.object({ kind: z.literal("batch-item-v2"), batchStepId: IdSchema,
  itemId: IdSchema, itemIndex: z.number().int().nonnegative(), itemDigest: DigestSchema }).strict();
export type BatchItemProof = z.infer<typeof BatchItemProofSchema>;
export function batchResponseSchema<T>(itemSchema: z.ZodType<T>) {
  return z.object({ items: z.array(z.object({ itemId: IdSchema, value: itemSchema }).strict()).min(1).max(5)
    .refine((items) => new Set(items.map((item) => item.itemId)).size === items.length, "Batch item IDs must be unique") }).strict();
}
export const ModelBatchCheckpointSchema = z.object({ kind: z.literal("course.model.batch.v2"), batchKind: BatchKindSchema,
  operationId: IdSchema, material: JsonValueSchema, items: batchResponseSchema(JsonValueSchema).shape.items }).strict();
export const AuthoredTaskSchema = AuthoredModuleSchema.shape.tasks.element;
export type AuthoredTask = z.infer<typeof AuthoredTaskSchema>;

/** Private succeeded run-step outputs. Consumers load these by step ID, never from browser/author arguments. */
export const ModuleKnowledgeCheckpointSchema = z.object({
  kind: z.literal("course.module.knowledge"), knowledge: ModuleKnowledgeSchema,
  operationId: IdSchema, sourceReadStepIds: z.array(IdSchema).min(1),
}).strict();
export const ApprovedKnowledgeSufficientProposalSchema = z.object({ status: z.literal("sufficient"), knowledge: ModuleKnowledgeSchema }).strict();
export const ApprovedKnowledgeProposalSchema = z.discriminatedUnion("status", [ApprovedKnowledgeSufficientProposalSchema,
  z.object({ status: z.literal("needs_research"), gaps: z.array(z.string().trim().min(1)).min(1) }).strict()]);
export const ApprovedKnowledgeCommentaryResponseSchema = z.object({ proposal: ApprovedKnowledgeProposalSchema,
  publicCommentary: z.string().trim().min(1).max(1600) }).strict();
export const ApprovedKnowledgeNarrationProofSchema = z.object({ kind: z.literal("approved-knowledge-commentary-v1"),
  response: ApprovedKnowledgeCommentaryResponseSchema }).strict();
export const ApprovedModuleKnowledgeCheckpointSchema = z.object({ kind: z.literal("course.module.approved_knowledge"),
  knowledge: ModuleKnowledgeSchema, proposal: ApprovedKnowledgeSufficientProposalSchema, operationId: IdSchema,
  sourceReadStepIds: z.array(IdSchema).max(0), approvedFactsDigest: DigestSchema,
  narration: ApprovedKnowledgeNarrationProofSchema.optional() }).strict();
export const KnowledgeCoverageCheckpointSchema = z.object({ kind: z.literal("course.module.knowledge.review.v1"),
  sourceKnowledgeStepId: IdSchema, operationId: IdSchema, material: JsonValueSchema, review: KnowledgeCoverageReviewSchema }).strict();
export const RevisedModuleKnowledgeCheckpointSchema = z.object({ kind: z.literal("course.module.knowledge.revision.v1"),
  knowledge: ModuleKnowledgeSchema, operationId: IdSchema, sourceReadStepIds: z.array(IdSchema).min(1),
  previousKnowledgeStepId: IdSchema, gapReviewStepIds: z.array(IdSchema).min(1), correction: JsonValueSchema,
  material: JsonValueSchema }).strict();
export const CheckedModuleKnowledgeCheckpointSchema = z.object({ kind: z.literal("course.module.knowledge.checked.v1"),
  knowledge: ModuleKnowledgeSchema, sourceKnowledgeStepId: IdSchema, sourceReadStepIds: z.array(IdSchema),
  reviewStepIds: z.array(IdSchema).min(1), correction: JsonValueSchema }).strict();
export const SourceModuleKnowledgeCheckpointSchema = z.union([
  ModuleKnowledgeCheckpointSchema, ApprovedModuleKnowledgeCheckpointSchema, RevisedModuleKnowledgeCheckpointSchema,
]);
export const AnyModuleKnowledgeCheckpointSchema = z.union([SourceModuleKnowledgeCheckpointSchema, CheckedModuleKnowledgeCheckpointSchema]);
export const TaskCandidateCheckpointSchema = z.object({
  kind: z.literal("course.task.candidate"), moduleId: IdSchema, knowledgeStepId: IdSchema,
  candidate: PreparedTaskCandidateSchema, authored: AuthoredTaskSchema, authoringOperationId: IdSchema, modelProof: BatchItemProofSchema.optional(),
}).strict();
export type TaskCandidateCheckpoint = z.infer<typeof TaskCandidateCheckpointSchema>;
export const ProposedTaskCasesSchema = z.object({
  cases: z.array(ProposedResponseCaseSchema).min(2), alternativeSpaceProof: AlternativeSpaceProofSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.cases.map((item) => item.key)).size !== value.cases.length ||
      !value.cases.some((item) => item.category === "valid") || !value.cases.some((item) => item.category === "invalid") ||
      (!value.cases.some((item) => item.category === "alternative") && value.alternativeSpaceProof === null)) {
    context.addIssue({ code: "custom", message: "Case keys must be unique with valid, invalid and alternative/proof candidates" });
  }
});
export const TaskCasesCheckpointSchema = z.object({
  kind: z.literal("course.task.cases"), candidateStepId: IdSchema, candidateDigest: DigestSchema,
  operationId: IdSchema, cases: z.array(ResponseCaseSchema).min(2), alternativeSpaceProof: AlternativeSpaceProofSchema.nullable(), modelProof: BatchItemProofSchema.optional(),
}).strict();
export type TaskCasesCheckpoint = z.infer<typeof TaskCasesCheckpointSchema>;
export const ContentReviewCheckpointSchema = z.object({
  kind: z.literal("course.task.review"), candidateStepId: IdSchema, operationId: IdSchema,
  material: JsonValueSchema, review: ContentReviewSchema, modelProof: BatchItemProofSchema.optional(),
}).strict();
export function prepareTaskCasesCheckpoint(input: { candidateStepId: string; candidateDigest: string; operationId: string; proposal: unknown }): TaskCasesCheckpoint {
  const proposal = ProposedTaskCasesSchema.parse(input.proposal);
  return TaskCasesCheckpointSchema.parse({ kind: "course.task.cases", candidateStepId: input.candidateStepId,
    candidateDigest: input.candidateDigest, operationId: input.operationId, alternativeSpaceProof: proposal.alternativeSpaceProof,
    cases: proposal.cases.map((item) => ({ ...item, caseId: stableExecutionId(input.candidateStepId, `case:${item.key}`) })) });
}

/** Read evidence is committed alongside the immutable source document by the read step. */
export const SourceReadCheckpointSchema = z.object({
  kind: z.literal("course.source.read"), moduleId: IdSchema, approvalDigest: DigestSchema,
  sourceId: IdSchema, contentDigest: DigestSchema,
  readProof: z.object({ version: z.literal("source-read-parts-v2"), input: SourceReadInputSchema,
    previousReadStepId: IdSchema.nullable() }).strict().optional(),
}).strict();
export const SourceClaimsProposalSchema = z.object({
  passages: z.array(PassageSchema).min(1),
  claims: z.array(SourceClaimSchema.omit({ ownerId: true, runStepId: true, createdAt: true })).min(1),
}).strict();
const SourceLocalIdSchema = z.string().min(1).max(200);
const SourceClaimProposalSchema = SourceClaimsProposalSchema.shape.claims.element;
/** Only identities created by this extraction are labels; trusted source/outcome IDs stay strict. */
export const ServerIdentitySourceClaimsProposalSchema = SourceClaimsProposalSchema.extend({
  passages: z.array(PassageSchema.safeExtend({ id: SourceLocalIdSchema })).min(1),
  claims: z.array(SourceClaimProposalSchema.extend({ id: SourceLocalIdSchema,
    passageIds: z.array(SourceLocalIdSchema).min(1).max(64),
    unresolvedConflicts: z.array(SourceClaimProposalSchema.shape.unresolvedConflicts.element.extend({
      otherClaimIds: z.array(SourceLocalIdSchema),
    })).max(32),
  })).min(1),
});
export const SourceClaimsCheckpointSchema = z.object({
  kind: z.literal("course.source.claims"), moduleId: IdSchema, sourceReadStepIds: z.array(IdSchema).min(1),
  operationId: IdSchema, proposal: SourceClaimsProposalSchema,
  passageProjection: z.literal("exact-quote-v1").optional(),
  claims: z.array(SourceClaimSchema).min(1), passages: z.array(PassageSchema).min(1),
}).strict();
export const ServerIdentitySourceClaimsCheckpointSchema = SourceClaimsCheckpointSchema.extend({
  kind: z.literal("course.source.claims.v2"),
  rawProposal: ServerIdentitySourceClaimsProposalSchema,
  passageProjection: z.literal("exact-quote-v1"),
});
/** The model selects server-owned source text; it cannot author quote coordinates. */
export const SourceSpanClaimsProposalSchema = z.object({
  passages: z.array(z.object({ id: SourceLocalIdSchema, sourceSpanId: z.string().min(1).max(80) }).strict()).min(1),
  claims: ServerIdentitySourceClaimsProposalSchema.shape.claims,
}).strict();
export const SourceSpanClaimsCheckpointSchema = SourceClaimsCheckpointSchema.extend({
  kind: z.literal("course.source.claims.v3"), rawProposal: SourceSpanClaimsProposalSchema,
  passageProjection: z.literal("exact-quote-v1"),
});
export const AnySourceClaimsCheckpointSchema = z.union([SourceClaimsCheckpointSchema, ServerIdentitySourceClaimsCheckpointSchema, SourceSpanClaimsCheckpointSchema]);
