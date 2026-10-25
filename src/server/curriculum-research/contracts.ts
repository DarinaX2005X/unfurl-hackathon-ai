import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, IsoDateTimeSchema } from "../../domain/common";
import { ModuleEstimateSchema } from "../../domain/curriculum-authoring";

export const SourceClaimSchema = z.object({
  id: IdSchema, ownerId: IdSchema, runStepId: IdSchema.nullable(),
  text: z.string().trim().min(1).max(20000),
  passageIds: z.array(IdSchema).min(1).max(64), outcomeIds: z.array(IdSchema).max(24),
  scope: z.object({ subject: z.string().trim().min(1).max(4000), version: z.string().trim().min(1).max(1000).nullable() }).strict(),
  support: z.enum(["direct", "inferred"]),
  unresolvedConflicts: z.array(z.object({
    description: z.string().trim().min(1).max(2000), otherClaimIds: z.array(IdSchema), blocking: z.boolean(),
  }).strict()).max(32),
  createdAt: IsoDateTimeSchema,
}).strict();
export type SourceClaim = z.infer<typeof SourceClaimSchema>;

export const QuestionEvidenceSchema = z.object({
  questionId: IdSchema, question: z.string().trim().min(1).max(4000),
  questionDigest: DigestSchema, answer: z.string().trim().min(1).max(4000), answerDigest: DigestSchema,
  decision: z.enum(["resolved", "needs_clarification"]),
  basis: z.enum(["user_context", "source_evidence"]), claimIds: z.array(IdSchema),
  rationale: z.string().trim().min(1).max(4000),
}).strict();
export type QuestionEvidence = z.infer<typeof QuestionEvidenceSchema>;

/** Stored only in immutable curriculum_revision_evidence; never accepted from PATCH/approve. */
export const CurriculumResearchEvidenceSchema = z.object({
  schemaVersion: z.literal(1), contentDigest: DigestSchema, briefDigest: DigestSchema,
  rationale: z.string().trim().min(1).max(12000),
  outcomeEvidence: z.array(z.object({
    outcomeId: IdSchema, outcomeDigest: DigestSchema, claimIds: z.array(IdSchema).min(1),
    rationale: z.string().trim().min(1).max(4000),
  }).strict()),
  moduleEstimates: z.array(ModuleEstimateSchema.safeExtend({ moduleDigest: DigestSchema })),
  questionAnswers: z.array(QuestionEvidenceSchema),
  limitations: z.array(z.string().trim().min(1).max(2000)),
}).strict();
export type CurriculumResearchEvidence = z.infer<typeof CurriculumResearchEvidenceSchema>;

export interface ResearchValidationIssue {
  code: "invalid_shape" | "stale_evidence" | "unknown_source" | "unauthorized_source" | "unknown_claim"
    | "unauthorized_claim" | "invalid_passage" | "duplicate_reference" | "uncovered_outcome"
    | "unresolved_conflict" | "invalid_estimate" | "unverified_answer" | "blocking_question";
  path: Array<string | number>;
  message: string;
}
