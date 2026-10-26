import "server-only";
import { z } from "zod";
import { IdSchema, type JsonValue } from "@/domain/common";
import { EvaluationSpecSchema, TaskAssessmentSchema, TaskPrivateCandidateSchema } from "@/domain/mechanics";
import { stableExecutionId } from "@/server/runs/identity";
import { AuthoredTaskSchema, type AuthoredTask } from "./checkpoints";

export const TASK_PRIVATE_IDENTITY_POLICY = "task-private-identities-v1" as const;
export type TaskPrivateIdentityPolicy = typeof TASK_PRIVATE_IDENTITY_POLICY;
export const EvidenceGroupProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), key: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/) }).strict(),
  z.object({ kind: z.literal("existing"), id: IdSchema }).strict(),
]);
const [deterministic, execution, rubric] = EvaluationSpecSchema.options;
const ProposedEvaluationSpecSchema = z.discriminatedUnion("kind", [
  deterministic,
  execution.extend({ testSetId: z.null() }),
  rubric.extend({ rubricId: z.null(), calibrationSetId: z.null() }),
]);
const ProposedAssessmentSchema = z.object({ ...TaskAssessmentSchema.shape, evidenceGroupId: EvidenceGroupProposalSchema }).strict();

/** Only fresh private identities change shape. Approved task, outcome and source references retain their UUID schemas. */
export const TaskIdentityProposalSchema = AuthoredTaskSchema.extend({
  privateTask: TaskPrivateCandidateSchema.extend({ assessment: ProposedAssessmentSchema, evaluationSpec: ProposedEvaluationSpecSchema }),
});
export type TaskIdentityProposal = z.infer<typeof TaskIdentityProposalSchema>;
export const TaskIdentityContextSchema = z.object({ policy: z.literal(TASK_PRIVATE_IDENTITY_POLICY),
  existingEvidenceGroupIds: z.array(IdSchema).refine((ids) => new Set(ids).size === ids.length, "Evidence groups must be distinct"),
}).strict();

export function taskIdentityMaterial(policy: TaskPrivateIdentityPolicy | undefined, passedPreviousTasks: readonly Pick<AuthoredTask, "privateTask">[] | undefined) {
  if (policy === undefined) return {};
  if (!passedPreviousTasks) throw new Error("Task identity capture requires passed prior tasks");
  return { taskIdentityContext: { policy, existingEvidenceGroupIds: [...new Set(passedPreviousTasks.map((entry) => entry.privateTask.assessment.evidenceGroupId))].sort() } };
}

function record(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Private evaluator must be an object");
  return value as Record<string, JsonValue>;
}

/** Maps a whole saved response, keeping deliberate same-key evidence groups shared within that batch. */
export function projectTaskIdentityBatch(batchStepId: string, material: unknown,
  items: readonly { itemId: string; value: unknown }[]): { itemId: string; value: AuthoredTask }[] {
  IdSchema.parse(batchStepId);
  const request = z.object({ batchKind: z.literal("candidate"), requestedIds: z.array(IdSchema),
    items: z.array(z.object({ itemId: IdSchema, material: z.object({ taskIdentityContext: TaskIdentityContextSchema }).passthrough() }).passthrough()) }).parse(material);
  if (request.requestedIds.length !== items.length || request.items.length !== items.length || new Set(request.requestedIds).size !== items.length
    || items.some((item, index) => item.itemId !== request.requestedIds[index] || item.itemId !== request.items[index]!.itemId)) throw new Error("Task identity batch membership changed");
  return items.map((item, index) => {
    const proposed = TaskIdentityProposalSchema.parse(item.value), context = request.items[index]!.material.taskIdentityContext;
    const group = proposed.privateTask.assessment.evidenceGroupId;
    if (group.kind === "existing" && !context.existingEvidenceGroupIds.includes(group.id)) throw new Error("Evidence group is not from a passed prior task");
    const evidenceGroupId = group.kind === "existing" ? group.id : stableExecutionId(batchStepId, `task-evidence:${group.key}`);
    const evaluatorData = structuredClone(proposed.privateTask.evaluatorData), rubrics: string[] = [];
    for (const field of ["rubric", "basisRubric", "explanationRubric"] as const) {
      if (evaluatorData[field] === undefined || evaluatorData[field] === null) continue;
      const value = record(evaluatorData[field]);
      if (value.id !== null) throw new Error("Fresh rubric identity must use the null placeholder");
      const id = stableExecutionId(batchStepId, `task-private:${item.itemId}:${field}`);
      evaluatorData[field] = { ...value, id }; rubrics.push(id);
    }
    let evaluationSpec: z.infer<typeof EvaluationSpecSchema>;
    if (proposed.privateTask.evaluationSpec.kind === "execution") {
      if (evaluatorData.testSetId !== null) throw new Error("Fresh test-set identity must use the null placeholder");
      const testSetId = stableExecutionId(batchStepId, `task-private:${item.itemId}:test-set`);
      evaluatorData.testSetId = testSetId;
      evaluationSpec = { ...proposed.privateTask.evaluationSpec, testSetId };
    } else if (proposed.privateTask.evaluationSpec.kind === "rubric") {
      if (rubrics.length !== 1) throw new Error("Rubric evaluation must bind exactly one authored rubric");
      evaluationSpec = { ...proposed.privateTask.evaluationSpec, rubricId: rubrics[0]!, calibrationSetId: null };
    } else evaluationSpec = proposed.privateTask.evaluationSpec;
    return { itemId: item.itemId, value: AuthoredTaskSchema.parse({ ...proposed, privateTask: { ...proposed.privateTask, evaluatorData,
      evaluationSpec, assessment: { ...proposed.privateTask.assessment, evidenceGroupId } } }) };
  });
}

/** Captured request material selects the raw paid-response schema on every replay. */
export function usesTaskIdentityProjection(material: unknown): boolean {
  const parsed = z.object({ batchKind: z.string(), items: z.array(z.object({ material: z.unknown() }).passthrough()) }).safeParse(material);
  if (!parsed.success || parsed.data.batchKind !== "candidate") return false;
  const contexts = parsed.data.items.map((item) => z.object({ taskIdentityContext: TaskIdentityContextSchema.optional() }).passthrough().parse(item.material).taskIdentityContext);
  if (contexts.some(Boolean) && contexts.some((context) => context === undefined)) throw new Error("Mixed task identity policies");
  return contexts.length > 0 && contexts.every(Boolean);
}

/** Copies only the fresh-ID leaves in a complete family contract. Reference UUID leaves are untouched. */
export function taskIdentityOutputContract<T extends Record<string, unknown>>(schema: T): T {
  const output = structuredClone(schema);
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const expand = (value: Record<string, unknown>) => {
    if (typeof value.$ref !== "string") return;
    if (!value.$ref.startsWith("#/")) throw new Error("Task contract has an external schema reference");
    let target: unknown = output;
    for (const part of value.$ref.slice(2).split("/").map((piece) => piece.replace(/~1/g, "/").replace(/~0/g, "~"))) target = object(target)?.[part];
    if (!object(target)) throw new Error("Task contract reference is unavailable");
    const copy = structuredClone(target) as Record<string, unknown>;
    delete value.$ref; Object.assign(value, copy);
  };
  const property = (node: unknown, name: string, update: (value: unknown) => unknown) => {
    const value = object(node); if (!value) return;
    expand(value);
    const properties = object(value.properties);
    if (properties && name in properties) properties[name] = update(properties[name]);
    for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(value[key])) for (const branch of value[key]) property(branch, name, update);
  };
  property(output, "privateTask", (privateTask) => {
    property(privateTask, "assessment", (assessment) => {
      property(assessment, "evidenceGroupId", () => z.toJSONSchema(EvidenceGroupProposalSchema)); return assessment;
    });
    property(privateTask, "evaluationSpec", (spec) => {
      for (const field of ["rubricId", "calibrationSetId", "testSetId"]) property(spec, field, () => ({ type: "null" }));
      return spec;
    });
    property(privateTask, "evaluatorData", (data) => {
      property(data, "testSetId", () => ({ type: "null" }));
      for (const field of ["rubric", "basisRubric", "explanationRubric"]) property(data, field, (rubric) => {
        property(rubric, "id", () => ({ type: "null" })); return rubric;
      });
      return data;
    });
    return privateTask;
  });
  return output;
}
