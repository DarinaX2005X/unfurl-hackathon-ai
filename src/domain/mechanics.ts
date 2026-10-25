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
const assessmentDimensionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
  .refine((id) => !["__proto__", "prototype", "constructor"].includes(id), "Reserved identifier");
const uniqueIds = <T extends z.ZodType<string>>(schema: T, max: number) => z.array(schema).max(max)
  .refine((ids) => new Set(ids).size === ids.length, "Identifiers must be unique");
/** Bound untrusted private JSON before Zod's recursive parser visits it. */
function boundedPrivateJson(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 32) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 128 * 1024;
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const result = Object.values(descriptors).every((descriptor) => "value" in descriptor && visit(descriptor.value, depth + 1));
    ancestors.delete(item);
    return result;
  };
  try { return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 128 * 1024; }
  catch { return false; }
}
export const TaskAssessmentSchema = z.object({
  evidenceGroupId: IdSchema,
  role: z.enum(["required", "practice", "diagnostic", "challenge"]),
  outcomes: z.array(z.object({
    outcomeId: IdSchema,
    dimensions: z.array(z.object({
      dimensionId: assessmentDimensionId,
      evaluationDimensionIds: uniqueIds(assessmentDimensionId, 24).min(1),
    }).strict()).min(1).max(24).refine((items) => new Set(items.map((item) => item.dimensionId)).size === items.length,
      "Canonical criteria must be unique within an outcome"),
  }).strict()).min(1).max(24).refine((items) => new Set(items.map((item) => item.outcomeId)).size === items.length,
    "Assessment outcomes must be unique"),
}).strict().refine(boundedPrivateJson, "Assessment exceeds the private JSON bounds");
export type TaskAssessment = z.infer<typeof TaskAssessmentSchema>;

/** The family-specific private schema is enforced by the server registry after this envelope. */
export const TaskEvaluatorDataSchema = z.unknown().superRefine((data, context) => {
  if (!boundedPrivateJson(data)) context.addIssue({ code: "custom", message: "Private evaluator data must be bounded finite JSON within 128 KiB" });
}).pipe(JsonObjectSchema);
export const TaskPrivateSchema = z.object({
  taskId: IdSchema, taskVersion: z.number().int().positive(), evaluationSpec: EvaluationSpecSchema,
  evaluatorData: TaskEvaluatorDataSchema, assessment: TaskAssessmentSchema,
  sourceClaimIds: uniqueIds(IdSchema, 100), validationReceiptId: IdSchema,
  hints: z.array(z.string().trim().min(1).max(4_000)).max(6),
  workedExample: z.string().trim().min(1).max(12_000).nullable(),
}).strict();
export const TaskPrivateCandidateSchema = TaskPrivateSchema.omit({ validationReceiptId: true });
export type TaskPrivateCandidate = z.infer<typeof TaskPrivateCandidateSchema>;
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
  "evaluatorData", "assessment", "hints", "workedExample", "privateData",
  "rubric", "basisRubric", "explanationRubric", "acceptedEvidence", "acceptedGraphs",
  "reviewedClaim", "hiddenHypothesisId", "referenceQuantity", "requiredFinalFacts",
  "acceptedLocationSets", "oracle", "hiddenFacts", "disclosureRules", "scenarioConstraints", "permittedOutcomes",
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
