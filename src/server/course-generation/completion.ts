import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { OutcomeCoverageSchema, PreparedModuleSchema } from "./contracts";
import { TaskValidationReferencesSchema } from "@/server/course-validation/receipts";

export const CompletedModuleCheckpointSchema = z.object({ kind: z.literal("course.module.completed"), module: PreparedModuleSchema,
  coverage: z.array(OutcomeCoverageSchema), knowledgeStepId: IdSchema, planStepId: IdSchema,
  readingStepIds: z.array(IdSchema), taskReferences: z.array(TaskValidationReferencesSchema), reviewStepId: IdSchema }).strict();
export type CompletedModuleCheckpoint = z.infer<typeof CompletedModuleCheckpointSchema>;
