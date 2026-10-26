import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { ProviderFailure } from "../ai/failure";

/** Private planner diagnostics: only typed record identities, never raw provider text or errors. */
export const CurriculumValidationFeedbackSchema = z.object({
  code: z.literal("claim_outcome_mismatch"),
  path: z.tuple([z.literal("outcomeEvidence"), z.number().int().min(0).max(65535), z.literal("claimRefs"), z.number().int().min(0).max(65535)]),
  claimRef: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  expectedOutcomeId: IdSchema, declaredOutcomeIds: z.array(IdSchema).max(24),
  researchPart: z.object({ phase: z.literal("research"), index: z.number().int().min(0).max(1000000) }).strict(),
}).strict();
export type CurriculumValidationFeedback = z.infer<typeof CurriculumValidationFeedbackSchema>;

export class CurriculumValidationFailure extends ProviderFailure {
  readonly feedback: CurriculumValidationFeedback;
  constructor(feedback: CurriculumValidationFeedback) {
    super("invalid_output");
    this.feedback = CurriculumValidationFeedbackSchema.parse(feedback);
  }
}
