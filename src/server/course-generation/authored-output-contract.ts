import "server-only";
import { z } from "zod";
import { createTaskPublicSchema, EvaluationSpecSchema, TaskPrivateCandidateSchema } from "@/domain/mechanics";
import { MECHANIC_VERSION } from "@/domain/mechanic-families/v2/shared";
import { PYTHON_RUNTIME_PROFILE } from "@/domain/mechanic-families/v3/python";
import { PYTHON_PROFILE_LIMITS } from "@/server/execution/python/profile";
import { getServerMechanic } from "@/server/mechanics/registry";
import { TaskDesignSchema } from "./contracts";

/** Additive generation policy. The historical mechanic catalog and its digest remain unchanged. */
export const COMPLETE_TASK_AUTHORING_CONTRACT_POLICY = "complete-task-contract-v1" as const;
export type TaskAuthoringContractPolicy = typeof COMPLETE_TASK_AUTHORING_CONTRACT_POLICY;
// This dialect is an existing fixed validatePrivateJoin invariant, not a configurable runtime choice.
// Contract tests pass this exact profile through prepareTaskCandidate and reject alternatives.
const pythonExecution = {
  executorId: PYTHON_RUNTIME_PROFILE,
  dialect: "python3.14" as const,
  resourceLimits: {
    timeoutMs: PYTHON_PROFILE_LIMITS.learnerWallMs,
    memoryMb: PYTHON_PROFILE_LIMITS.learnerMemoryBytes / (1024 * 1024),
  },
};

/** Describe the same full envelope and family schemas accepted by task preparation.
 * JSON Schema cannot express every cross-field join; those are explicit below and
 * remain enforced by the existing validators, never waived by this authoring aid.
 */
export function getCompleteTaskAuthoringContract(id: string, version: number) {
  const registration = getServerMechanic(id, version);
  if (!registration) throw new Error(`Unsupported mechanic: ${id}@${version}`);
  const descriptor = registration.descriptor;
  const evaluatorSchemas = EvaluationSpecSchema.options.filter(schema => descriptor.supportedEvaluators.includes(schema.shape.kind.value))
    .map(schema => {
      if (schema.shape.kind.value === "deterministic") return schema.extend({
        evaluatorId: z.literal(descriptor.id), evaluatorVersion: z.literal(MECHANIC_VERSION), secretConfig: z.null(),
      });
      if (schema.shape.kind.value === "execution") return schema.extend({
        executorId: z.literal(pythonExecution.executorId), dialect: z.literal(pythonExecution.dialect),
        resourceLimits: z.object({ timeoutMs: z.literal(pythonExecution.resourceLimits.timeoutMs), memoryMb: z.literal(pythonExecution.resourceLimits.memoryMb) }).strict(),
      });
      return schema;
    });
  if (!evaluatorSchemas.length) throw new Error("The mechanic has no supported evaluator");
  const evaluationSpec = evaluatorSchemas.length === 1 ? evaluatorSchemas[0]! : z.union([evaluatorSchemas[0]!, evaluatorSchemas[1]!, ...evaluatorSchemas.slice(2)]);
  const task = createTaskPublicSchema(descriptor.configSchema).extend({
    taskVersion: z.literal(1), mechanicId: z.literal(descriptor.id), mechanicVersion: z.literal(descriptor.version),
    responseSchemaVersion: z.literal(descriptor.responseSchemaVersion),
  });
  const privateTask = TaskPrivateCandidateSchema.extend({ taskVersion: z.literal(1), evaluationSpec, evaluatorData: registration.privateSchema });
  const authoredTask = z.object({ task, privateTask, design: TaskDesignSchema }).strict();
  return {
    policy: COMPLETE_TASK_AUTHORING_CONTRACT_POLICY,
    mechanicIdentity: { mechanicId: descriptor.id, mechanicVersion: descriptor.version, responseSchemaVersion: descriptor.responseSchemaVersion },
    // Output exposes concrete validated data behind the family preflight/normalization pipes.
    authoredTaskSchema: z.toJSONSchema(authoredTask, { io: "output" }),
    crossFieldConstraints: {
      identity: [
        "task.id = slot.id = privateTask.taskId = design.taskId",
        "task.taskVersion = privateTask.taskVersion = 1",
        "task.mechanicId, task.mechanicVersion and task.responseSchemaVersion equal mechanicIdentity exactly",
        "task.availableHints = privateTask.hints.length",
      ],
      approvedSlot: [
        "task.outcomeIds exactly equals slot.outcomeIds; design exactly equals slot.design",
        "privateTask.assessment.role = slot.assessmentRole",
        "privateTask.assessment.outcomes covers exactly task.outcomeIds; its canonical dimensionId values equal the corresponding slot.criteria criterionIds",
        "assessment evaluationDimensionIds must cover exactly the actual successful evaluator dimensions, not failure-only diagnostic dimensions",
      ],
      supportedEvaluators: descriptor.supportedEvaluators,
      ...(descriptor.supportedEvaluators.includes("execution") ? { execution: {
        ...pythonExecution,
        testSetId: "privateTask.evaluationSpec.testSetId = privateTask.evaluatorData.testSetId",
        assessmentDimensions: "Use privateTask.evaluatorData.requiredDimensions exactly; bind each to the approved canonical criterion it measures",
      } } : {}),
      ...(descriptor.supportedEvaluators.includes("deterministic") ? { deterministic: {
        evaluatorId: descriptor.id, evaluatorVersion: MECHANIC_VERSION, secretConfig: null,
        privateData: "All family-specific answer data belongs in privateTask.evaluatorData, never evaluationSpec.secretConfig",
      } } : {}),
      ...(descriptor.supportedEvaluators.includes("rubric") ? { rubric: {
        source: "Exactly one non-null rubric exists among privateTask.evaluatorData.rubric, basisRubric, explanationRubric",
        rubricId: "privateTask.evaluationSpec.rubricId = that rubric.id",
        requiredDimensions: "privateTask.evaluationSpec.requiredDimensions contains every raw rubric.dimensions[].id exactly once; do not substitute canonical assessment criterion IDs or evaluator prefixes",
      } } : {}),
    },
    runtimeRefinementsRequired: true as const,
  };
}

/** No property at all for historical captures: absence preserves paid request bytes. */
export function taskAuthoringContractMaterial(policy: TaskAuthoringContractPolicy | undefined, id: string, version: number) {
  return policy === COMPLETE_TASK_AUTHORING_CONTRACT_POLICY ? { authoredOutputContract: getCompleteTaskAuthoringContract(id, version) } : {};
}

export function taskAuthoringInstructions(legacy: string, policy: TaskAuthoringContractPolicy | undefined) {
  return policy === COMPLETE_TASK_AUTHORING_CONTRACT_POLICY ? `${legacy}\nThe separately captured authoredOutputContract describes the complete {task,privateTask,design} value. Follow its exact identity constants, full privateTask.evaluationSpec schema and crossFieldConstraints. Python config.language is not the evaluation dialect; copy the exact execution profile values rather than choosing your own.` : legacy;
}
