import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonValueSchema } from "@/domain/common";
import { AlternativeSpaceProofSchema, PreparedTaskCandidateSchema } from "@/server/mechanics/contracts";
import { AuthoredModuleSchema, ModuleKnowledgeSchema } from "./contracts";
import { jsonDigest } from "@/server/ai/json";
import { ProposedResponseCaseSchema, ResponseCaseSchema } from "@/server/course-validation/case-evaluation";
import { stableExecutionId } from "@/server/runs/identity";
import { SourceClaimSchema } from "@/server/curriculum-research/contracts";
import { PassageSchema } from "@/server/research/ports";
import { ContentReviewSchema } from "@/server/course-validation/content-review";

export const COURSE_GENERATION_SCHEMA_DIGEST = jsonDigest({ courseGeneration: 1, knowledge: 1, candidate: 1, validation: 1 });
export const COURSE_VALIDATION_POLICY_DIGEST = jsonDigest({ courseValidation: 1, independentContentReview: 1, requiredOutcomeCoverage: 1, immutableEvidence: 1 });
export const AuthoredTaskSchema = AuthoredModuleSchema.shape.tasks.element;
export type AuthoredTask = z.infer<typeof AuthoredTaskSchema>;

/** Private succeeded run-step outputs. Consumers load these by step ID, never from browser/author arguments. */
export const ModuleKnowledgeCheckpointSchema = z.object({
  kind: z.literal("course.module.knowledge"), knowledge: ModuleKnowledgeSchema,
  operationId: IdSchema, sourceReadStepIds: z.array(IdSchema).min(1),
}).strict();
export const TaskCandidateCheckpointSchema = z.object({
  kind: z.literal("course.task.candidate"), moduleId: IdSchema, knowledgeStepId: IdSchema,
  candidate: PreparedTaskCandidateSchema, authored: AuthoredTaskSchema, authoringOperationId: IdSchema,
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
  operationId: IdSchema, cases: z.array(ResponseCaseSchema).min(2), alternativeSpaceProof: AlternativeSpaceProofSchema.nullable(),
}).strict();
export type TaskCasesCheckpoint = z.infer<typeof TaskCasesCheckpointSchema>;
export const ContentReviewCheckpointSchema = z.object({
  kind: z.literal("course.task.review"), candidateStepId: IdSchema, operationId: IdSchema,
  material: JsonValueSchema, review: ContentReviewSchema,
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
}).strict();
export const SourceClaimsProposalSchema = z.object({
  passages: z.array(PassageSchema).min(1),
  claims: z.array(SourceClaimSchema.omit({ ownerId: true, runStepId: true, createdAt: true })).min(1),
}).strict();
export const SourceClaimsCheckpointSchema = z.object({
  kind: z.literal("course.source.claims"), moduleId: IdSchema, sourceReadStepIds: z.array(IdSchema).min(1),
  operationId: IdSchema, proposal: SourceClaimsProposalSchema,
  claims: z.array(SourceClaimSchema).min(1), passages: z.array(PassageSchema).min(1),
}).strict();
