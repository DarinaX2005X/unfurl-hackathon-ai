import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema } from "@/domain/common";
import { LessonSchema } from "@/domain/learning";
import { TaskPrivateCandidateSchema, TaskPublicSchema } from "@/domain/mechanics";
import { PreparedTaskCandidateSchema } from "@/server/mechanics/contracts";

const text = z.string().trim().min(1).max(4000);
const ids = z.array(IdSchema).refine((values) => new Set(values).size === values.length, "References must be unique");
export const CriterionSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
    .refine((id) => !["__proto__", "prototype", "constructor"].includes(id)),
  description: text,
}).strict();

/** These are authored knowledge candidates, never research or readiness receipts. */
export const ModuleKnowledgeSchema = z.object({
  schemaVersion: z.literal(1), moduleId: IdSchema, approvalDigest: DigestSchema,
  outcomes: z.array(z.object({
    outcomeId: IdSchema, learnerAction: text, criteria: z.array(CriterionSchema).min(1),
    concepts: z.array(z.object({ explanation: text, claimIds: ids.min(1) }).strict()).min(1),
    misconceptions: z.array(z.object({ belief: text, correction: text, claimIds: ids.min(1) }).strict()),
  }).strict()).min(1),
  limitations: z.array(text),
}).strict();
export type ModuleKnowledge = z.infer<typeof ModuleKnowledgeSchema>;

export const TaskDesignSchema = z.object({
  taskId: IdSchema, learnerAction: text, mechanicRationale: text,
  affordances: z.array(z.string().trim().min(1).max(100)).min(1),
  purpose: z.enum(["practice", "demonstration", "support"]),
  transfer: z.object({ fromTaskIds: ids.min(1), changedContext: text, independentDemand: text }).strict().nullable(),
}).strict();
export const ReadingEvidenceSchema = z.object({
  lessonId: IdSchema, blockId: IdSchema, outcomeIds: ids.min(1), claimIds: ids.min(1),
}).strict();
export const OutcomeCoverageSchema = z.object({
  outcomeId: IdSchema,
  introducedAt: z.array(z.object({ lessonId: IdSchema, blockId: IdSchema }).strict()).min(1),
  practicedTaskIds: ids.min(1), demonstratedTaskIds: ids.min(1),
}).strict();

export const AuthoredModuleSchema = z.object({
  schemaVersion: z.literal(1), moduleId: IdSchema, approvalDigest: DigestSchema,
  lessons: z.array(LessonSchema).min(1),
  tasks: z.array(z.object({ task: TaskPublicSchema, privateTask: TaskPrivateCandidateSchema, design: TaskDesignSchema }).strict()),
  readingEvidence: z.array(ReadingEvidenceSchema),
}).strict();
export type AuthoredModule = z.infer<typeof AuthoredModuleSchema>;

export const PreparedModuleSchema = AuthoredModuleSchema.omit({ tasks: true }).extend({
  tasks: z.array(z.object({ candidate: PreparedTaskCandidateSchema, design: TaskDesignSchema }).strict()),
  knowledge: ModuleKnowledgeSchema, moduleDigest: DigestSchema,
}).strict();
export type PreparedModule = z.infer<typeof PreparedModuleSchema>;
export type OutcomeCoverage = z.infer<typeof OutcomeCoverageSchema>;

export interface GenerationValidationIssue {
  code: "invalid_shape" | "stale_approval" | "duplicate_reference" | "unknown_reference" | "invalid_source"
    | "unresolved_conflict" | "missing_outcome" | "invalid_task" | "unsupported_task" | "invalid_lesson"
    | "criterion_mismatch" | "prerequisite_order" | "invalid_transfer" | "stale_candidate";
  path: Array<string | number>;
  message: string;
}
