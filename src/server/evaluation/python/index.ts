import "server-only";
import { z } from "zod";
import { IdSchema } from "../../../domain/common";
import type { TaskPublic } from "../../../domain/mechanics";
import { LocalIdSchema, parseFamilyResponse, parseFamilyTask } from "../../../domain/mechanic-families/v2/shared";
import {
  ExecutionJsonSchema,
  PYTHON_LIMITS,
  PYTHON_RUNTIME_PROFILE,
  PythonFaultRegionSchema,
  canonicalExecutionJson,
  parseExecutionValue,
  pythonArtifactDescriptor,
  pythonRepairDescriptor,
  type BoundedValueShape,
  type ExecutionJson,
  type PythonArtifactConfig,
  type PythonArtifactResponse,
  type PythonRepairConfig,
  type PythonRepairResponse,
} from "../../../domain/mechanic-families/v3/python";
import {
  ExecutionResultSchema,
  pythonSourceDigest,
  type ExecutionResult,
} from "../../execution/python/contracts";
import {
  GradeDecisionSchema,
  RubricRequestSchema,
  evaluateRubric,
  type EvaluationContext,
  type EvaluatorRegistration,
  type GradeDecision,
} from "../contracts";

const comparatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json_exact") }).strict(),
  z.object({
    kind: z.literal("numeric_tolerance"),
    absolute: z.number().finite().nonnegative(),
    relative: z.number().finite().nonnegative(),
  }).strict(),
]);
const hiddenCaseSchema = z.object({
  id: LocalIdSchema,
  input: ExecutionJsonSchema,
  expected: ExecutionJsonSchema,
  dimensionId: LocalIdSchema,
}).strict();
const requiredDimensionsSchema = z.array(LocalIdSchema).min(1).max(24)
  .refine((ids) => new Set(ids).size === ids.length, "Required dimensions must be unique");
const privateBaseShape = {
  testSetId: IdSchema,
  hiddenCases: z.array(hiddenCaseSchema).min(1).max(PYTHON_LIMITS.hiddenCases),
  comparator: comparatorSchema,
  requiredDimensions: requiredDimensionsSchema,
};
const rubricSchema = RubricRequestSchema.shape.rubric;

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id) => expected.includes(id));
}

function validateHiddenCases(
  data: { hiddenCases: Array<{ id: string; dimensionId: string }>; requiredDimensions: string[] },
  context: z.RefinementCtx,
): string[] {
  if (new Set(data.hiddenCases.map((item) => item.id)).size !== data.hiddenCases.length) {
    context.addIssue({ code: "custom", path: ["hiddenCases"], message: "Hidden case identifiers must be unique" });
  }
  return [...new Set(data.hiddenCases.map((item) => item.dimensionId))];
}

export const PythonArtifactPrivateSchema = z.object(privateBaseShape).strict().superRefine((data, context) => {
  const behavioral = validateHiddenCases(data, context);
  if (!sameSet(data.requiredDimensions, behavioral)) {
    context.addIssue({ code: "custom", path: ["requiredDimensions"], message: "Artifact dimensions must exactly match hidden behavioral dimensions" });
  }
});
export type PythonArtifactPrivate = z.infer<typeof PythonArtifactPrivateSchema>;

export const PythonRepairPrivateSchema = z.object({
  ...privateBaseShape,
  acceptedFaultRegions: z.array(PythonFaultRegionSchema).min(1).max(PYTHON_LIMITS.repairLocations),
  repairLocationDimensionId: LocalIdSchema,
  explanationRubric: rubricSchema.nullable(),
}).strict().superRefine((data, context) => {
  const behavioral = validateHiddenCases(data, context);
  const explanation = data.explanationRubric?.dimensions.map((item) => item.id) ?? [];
  const derived = [...behavioral, data.repairLocationDimensionId, ...explanation];
  if (new Set(derived).size !== derived.length) {
    context.addIssue({ code: "custom", message: "Behavior, location and explanation dimension identifiers must not collide" });
  }
  if (!sameSet(data.requiredDimensions, derived)) {
    context.addIssue({ code: "custom", path: ["requiredDimensions"], message: "Repair dimensions must exactly bind behavior, location and explanation criteria" });
  }
  const regions = data.acceptedFaultRegions.map((region) => `${region.startLine}:${region.endLine}`);
  if (new Set(regions).size !== regions.length) {
    context.addIssue({ code: "custom", path: ["acceptedFaultRegions"], message: "Accepted fault regions must be unique" });
  }
});
export type PythonRepairPrivate = z.infer<typeof PythonRepairPrivateSchema>;

type PythonPrivate = PythonArtifactPrivate | PythonRepairPrivate;
type Dimension = GradeDecision["dimensions"][number];

function unavailable(ids: readonly string[], explanation: string): GradeDecision {
  return GradeDecisionSchema.parse({
    status: "unavailable",
    outcome: null,
    dimensions: ids.map((id) => ({ id, status: "uncertain", explanation })),
    feedback: { explanation, nextAction: "wait" },
  });
}

function validatePrivateValues(
  inputShape: BoundedValueShape,
  outputShape: BoundedValueShape,
  data: PythonPrivate,
): boolean {
  try {
    if (data.comparator.kind === "numeric_tolerance") {
      if (outputShape.type !== "number") return false;
      const maximumMagnitude = Math.max(Math.abs(outputShape.minimum), Math.abs(outputShape.maximum));
      const maximumAllowance = data.comparator.absolute + data.comparator.relative * maximumMagnitude;
      if (!Number.isFinite(maximumAllowance)) return false;
    }
    for (const item of data.hiddenCases) {
      parseExecutionValue(inputShape, item.input);
      parseExecutionValue(outputShape, item.expected);
      if (data.comparator.kind === "numeric_tolerance" && typeof item.expected !== "number") return false;
    }
    return true;
  } catch { return false; }
}

function valuesEqual(
  actual: ExecutionJson,
  expected: ExecutionJson,
  comparator: PythonPrivate["comparator"],
): boolean {
  if (comparator.kind === "json_exact") return canonicalExecutionJson(actual) === canonicalExecutionJson(expected);
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  const difference = Math.abs(actual - expected);
  const allowance = comparator.absolute + comparator.relative * Math.max(Math.abs(actual), Math.abs(expected));
  return Number.isFinite(difference) && Number.isFinite(allowance) && difference <= allowance;
}

function behaviorDimensions(
  outputShape: BoundedValueShape,
  data: PythonPrivate,
  result: Extract<ExecutionResult, { status: "completed" }>,
): Dimension[] {
  const passed = new Map(data.hiddenCases.map((item) => [item.dimensionId, true]));
  data.hiddenCases.forEach((item, index) => {
    const program = result.cases[index]!.result;
    let met = program.status === "ok";
    if (program.status === "ok") {
      try {
        const actual = parseExecutionValue(outputShape, program.value);
        met = valuesEqual(actual, item.expected, data.comparator);
      } catch { met = false; }
    }
    if (!met) passed.set(item.dimensionId, false);
  });
  return [...passed].map(([id, met]) => ({
    id,
    status: met ? "met" : "not_met",
    explanation: met ? "The implementation satisfies the required behavior." :
      "The implementation does not satisfy every required behavior. Revise the function against the specification.",
  }));
}

function orderedDimensions(required: readonly string[], dimensions: readonly Dimension[]): Dimension[] {
  const byId = new Map(dimensions.map((dimension) => [dimension.id, dimension]));
  if (byId.size !== required.length || required.some((id) => !byId.has(id))) throw new Error("Python evaluator dimension coverage mismatch");
  return required.map((id) => byId.get(id)!);
}

function evaluatedDecision(required: readonly string[], dimensions: readonly Dimension[], feedback?: string): GradeDecision {
  const ordered = orderedDimensions(required, dimensions);
  const allMet = ordered.every((dimension) => dimension.status === "met");
  const allNotMet = ordered.every((dimension) => dimension.status === "not_met");
  const outcome = allMet ? "correct" : allNotMet ? "incorrect" : "partial";
  return GradeDecisionSchema.parse({
    status: "evaluated",
    outcome,
    dimensions: ordered,
    feedback: {
      explanation: feedback ?? (allMet ? "The implementation meets every assessed criterion." : "The implementation needs revision before it meets every assessed criterion."),
      nextAction: allMet ? "continue" : "revise",
    },
  });
}

async function executeHidden(
  source: string,
  data: PythonPrivate,
  context: EvaluationContext,
): Promise<Extract<ExecutionResult, { status: "completed" }> | null> {
  if (context.python === null || context.python === undefined) return null;
  let raw: ExecutionResult;
  try {
    raw = await context.python.execute({
      source,
      cases: data.hiddenCases.map(({ id, input }) => ({ id, input })),
      runtimeProfile: PYTHON_RUNTIME_PROFILE,
    }, context.signal);
    context.signal.throwIfAborted();
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  }
  const parsed = ExecutionResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.status !== "completed" || parsed.data.purpose === "public_run" ||
      parsed.data.sourceDigest !== pythonSourceDigest(source) || parsed.data.cases.length !== data.hiddenCases.length ||
      parsed.data.cases.some((item, index) => item.id !== data.hiddenCases[index]!.id)) return null;
  return parsed.data;
}

function parseArtifactSubmission(task: TaskPublic<PythonArtifactConfig>, response: PythonArtifactResponse) {
  const parsedTask = parseFamilyTask(pythonArtifactDescriptor, task);
  const parsedResponse = parseFamilyResponse(pythonArtifactDescriptor, response);
  if (pythonArtifactDescriptor.validateSubmission(parsedTask.config, parsedResponse).length > 0) throw new Error("Invalid Python artifact submission");
  return { config: parsedTask.config, response: parsedResponse };
}

function parseRepairSubmission(task: TaskPublic<PythonRepairConfig>, response: PythonRepairResponse) {
  const parsedTask = parseFamilyTask(pythonRepairDescriptor, task);
  const parsedResponse = parseFamilyResponse(pythonRepairDescriptor, response);
  if (pythonRepairDescriptor.validateSubmission(parsedTask.config, parsedResponse).length > 0) throw new Error("Invalid Python repair submission");
  return { config: parsedTask.config, response: parsedResponse };
}

export const pythonArtifactEvaluator: EvaluatorRegistration<
  PythonArtifactConfig, PythonArtifactResponse, PythonArtifactPrivate, 3
> = {
  id: "artifact_construction",
  version: 3,
  privateSchema: PythonArtifactPrivateSchema,
  async evaluate(input, context) {
    context.signal.throwIfAborted();
    const { config, response } = parseArtifactSubmission(input.task, input.response);
    const data = PythonArtifactPrivateSchema.parse(input.privateData);
    if (!validatePrivateValues(config.inputShape, config.outputShape, data)) {
      return unavailable(data.requiredDimensions, "The private execution criteria need review before this answer can be assessed.");
    }
    const result = await executeHidden(response.source, data, context);
    if (result === null) return unavailable(data.requiredDimensions, "The isolated Python assessment could not finish. Your source is retained for retry.");
    return evaluatedDecision(data.requiredDimensions, behaviorDimensions(config.outputShape, data, result));
  },
};

function locationDimension(response: PythonRepairResponse, data: PythonRepairPrivate): Dimension {
  const accepted = new Set(data.acceptedFaultRegions.map((region) => `${region.startLine}:${region.endLine}`));
  const selected = response.locations.map((region) => `${region.startLine}:${region.endLine}`);
  const met = selected.length > 0 && selected.every((region) => accepted.has(region));
  return {
    id: data.repairLocationDimensionId,
    status: met ? "met" : "not_met",
    explanation: met ? "The selected source region identifies the authored defect." :
      "The selected source region does not identify the defect targeted by this task.",
  };
}

export const pythonRepairEvaluator: EvaluatorRegistration<
  PythonRepairConfig, PythonRepairResponse, PythonRepairPrivate, 3
> = {
  id: "diagnosis_repair",
  version: 3,
  privateSchema: PythonRepairPrivateSchema,
  async evaluate(input, context) {
    context.signal.throwIfAborted();
    const { config, response } = parseRepairSubmission(input.task, input.response);
    const data = PythonRepairPrivateSchema.parse(input.privateData);
    if (!validatePrivateValues(config.inputShape, config.outputShape, data)) {
      return unavailable(data.requiredDimensions, "The private repair criteria need review before this answer can be assessed.");
    }
    const result = await executeHidden(response.source, data, context);
    if (result === null) return unavailable(data.requiredDimensions, "The isolated Python assessment could not finish. Your repair is retained for retry.");
    const dimensions: Dimension[] = [
      ...behaviorDimensions(config.outputShape, data, result),
      locationDimension(response, data),
    ];
    if (data.explanationRubric !== null) {
      const explanation = await evaluateRubric({
        rubric: data.explanationRubric,
        response,
        allowedResponsePaths: [["explanation"], ["locations"]],
        context: {
          instruction: input.task.instruction,
          material: config,
          referenceFacts: { acceptedFaultRegions: data.acceptedFaultRegions },
        },
      }, context);
      dimensions.push(...explanation.dimensions);
      const ordered = orderedDimensions(data.requiredDimensions, dimensions);
      if (explanation.status !== "evaluated") {
        return GradeDecisionSchema.parse({
          status: explanation.status,
          outcome: null,
          dimensions: ordered,
          feedback: explanation.feedback,
        });
      }
      return evaluatedDecision(data.requiredDimensions, ordered, explanation.feedback.explanation);
    }
    return evaluatedDecision(data.requiredDimensions, dimensions);
  },
};

export const pythonEvaluators = [pythonArtifactEvaluator, pythonRepairEvaluator] as const;

