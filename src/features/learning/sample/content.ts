import { z } from "zod";
import { serializePublicTask } from "@/domain";

export const SAMPLE_TASK_ID = "4a5eea9e-28c6-4c80-9f78-c0c2a449ea21";
export const SAMPLE_HINT_ID = "705b1053-a1ba-4670-9cec-30f0944a2421";

export const CapacityConfigSchema = z.object({
  dataset: z.literal("model-capacity-v1"),
  degrees: z.tuple([z.literal(1), z.literal(3), z.literal(7)]),
  regularizations: z.tuple([z.literal(0), z.literal(0.1), z.literal(1)]),
  validationTarget: z.literal(0.21),
}).strict();

export const CapacityResponseSchema = z.object({
  degree: z.union([z.literal(1), z.literal(3), z.literal(7)]),
  lambda: z.union([z.literal(0), z.literal(0.1), z.literal(1)]),
  prediction: z.enum(["lower", "higher", "unsure"]).nullable(),
  explanation: z.enum(["noise", "guarantee", "training_only"]).nullable(),
  reflection: z.string().max(1200),
}).strict();

export type CapacityConfig = z.infer<typeof CapacityConfigSchema>;
export type CapacityResponse = z.infer<typeof CapacityResponseSchema>;

export function createInitialResponse(): CapacityResponse {
  return { degree: 7, lambda: 0, prediction: null, explanation: null, reflection: "" };
}

export const sampleTask = serializePublicTask({
  id: SAMPLE_TASK_ID,
  taskVersion: 1,
  mechanicId: "constrained_optimization",
  mechanicVersion: 1,
  outcomeIds: ["ceec78af-427c-471b-8377-c13a4fe9d016"],
  instruction: "Find a model with validation error below 0.210, then explain why a perfect fit to the training points can be misleading.",
  contentLanguage: "en",
  config: { dataset: "model-capacity-v1", degrees: [1, 3, 7], regularizations: [0, 0.1, 1], validationTarget: 0.21 },
  availableHints: 1,
  responseSchemaVersion: 1,
}, CapacityConfigSchema);

export const explanationOptions = [
  { value: "noise", label: "A flexible model can fit noise. We need evidence from points it did not train on." },
  { value: "guarantee", label: "Zero training error guarantees accurate predictions on future data." },
  { value: "training_only", label: "Only training error matters when choosing a model." },
] as const;

export const sampleHint = "Try degree 3, or keep degree 7 and add a little regularization. Watch both errors: a small increase in training error can accompany a large drop in validation error.";
