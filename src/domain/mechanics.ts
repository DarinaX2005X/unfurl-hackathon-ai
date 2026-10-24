import { z } from "zod";
import { ContentLanguageSchema, IdSchema, JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from "./common";
import { DomainError } from "./errors";

export const MECHANIC_IDS = [
  "recall_reconstruction", "confusable_discrimination", "rule_induction",
  "example_construction", "counterexample_construction", "procedure_reconstruction",
  "state_tracing", "outcome_prediction", "cause_diagnosis", "experimental_investigation",
  "causal_intervention", "relational_mapping", "analogy_transfer", "representation_translation",
  "estimation", "strategy_selection", "plan_construction", "artifact_construction",
  "diagnosis_repair", "adversarial_testing", "constrained_optimization", "self_explanation",
  "argument_rebuttal", "source_investigation", "critique_revision", "misconception_tutoring",
  "information_gap", "role_simulation", "audience_mediation",
] as const;
export const MechanicIdSchema = z.enum(MECHANIC_IDS);
export type MechanicId = z.infer<typeof MechanicIdSchema>;

export function createTaskPublicSchema<TConfig extends JsonValue>(configSchema: z.ZodType<TConfig>) {
  return z.object({
    id: IdSchema,
    taskVersion: z.number().int().positive(),
    mechanicId: MechanicIdSchema,
    mechanicVersion: z.number().int().positive(),
    outcomeIds: z.array(IdSchema).min(1),
    instruction: z.string().trim().min(1).max(20_000),
    contentLanguage: ContentLanguageSchema,
    config: configSchema,
    availableHints: z.number().int().nonnegative(),
    responseSchemaVersion: z.number().int().positive(),
  }).strict();
}

export const TaskPublicSchema = createTaskPublicSchema(JsonObjectSchema);
export interface TaskPublic<TConfig extends JsonValue = JsonObject> {
  id: string;
  taskVersion: number;
  mechanicId: MechanicId;
  mechanicVersion: number;
  outcomeIds: string[];
  instruction: string;
  contentLanguage: string;
  config: TConfig;
  availableHints: number;
  responseSchemaVersion: number;
}

export const EvaluationSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deterministic"),
    evaluatorId: z.string().min(1), evaluatorVersion: z.number().int().positive(),
    secretConfig: JsonValueSchema,
  }).strict(),
  z.object({
    kind: z.literal("execution"), executorId: z.string().min(1), dialect: z.string().min(1),
    testSetId: IdSchema,
    resourceLimits: z.object({ timeoutMs: z.number().int().positive(), memoryMb: z.number().int().positive() }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("rubric"), rubricId: IdSchema,
    requiredDimensions: z.array(z.string().min(1)).min(1), calibrationSetId: IdSchema.nullable(),
  }).strict(),
]);
export const TaskPrivateSchema = z.object({
  taskId: IdSchema, evaluationSpec: EvaluationSpecSchema,
  sourceClaimIds: z.array(IdSchema), validationReceiptId: IdSchema,
}).strict();
export type EvaluationSpec = z.infer<typeof EvaluationSpecSchema>;
export type TaskPrivate = z.infer<typeof TaskPrivateSchema>;

export interface MechanicDefinition<TConfig extends JsonValue, TResponse extends JsonValue> {
  id: MechanicId;
  version: number;
  configSchema: z.ZodType<TConfig>;
  responseSchema: z.ZodType<TResponse>;
  requiredAffordances: string[];
  supportedEvaluators: EvaluationSpec["kind"][];
  rendererKey: string;
  accessibility: { keyboardEquivalent: boolean; nonVisualSummary: boolean };
}

const privateKeys = new Set([
  "evaluationSpec", "secretConfig", "expectedAnswer", "referenceAnswer", "answerKey",
  "privateResearch", "sourceClaimIds", "validationReceiptId",
]);

function assertPublicConfig(value: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(assertPublicConfig);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (privateKeys.has(key)) {
        throw new DomainError("unsafe_public_payload", "private_config_key", "The task configuration includes a private field");
      }
      assertPublicConfig(child);
    }
  }
}

export function serializePublicTask<TConfig extends JsonValue>(
  value: unknown,
  configSchema: z.ZodType<TConfig>,
): TaskPublic<TConfig> {
  const source = z.record(z.string(), z.unknown()).parse(value);
  const result = createTaskPublicSchema(configSchema).parse({
    id: source.id,
    taskVersion: source.taskVersion,
    mechanicId: source.mechanicId,
    mechanicVersion: source.mechanicVersion,
    outcomeIds: source.outcomeIds,
    instruction: source.instruction,
    contentLanguage: source.contentLanguage,
    config: source.config,
    availableHints: source.availableHints,
    responseSchemaVersion: source.responseSchemaVersion,
  });
  assertPublicConfig(result.config);
  return result;
}
