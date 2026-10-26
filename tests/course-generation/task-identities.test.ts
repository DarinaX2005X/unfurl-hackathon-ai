import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { IdSchema } from "@/domain/common";
import { TaskIdentityProposalSchema, TASK_PRIVATE_IDENTITY_POLICY, taskIdentityMaterial, projectTaskIdentityBatch,
  usesTaskIdentityProjection, type TaskIdentityProposal } from "@/server/course-generation/task-authoring-identities";
import { COMPLETE_TASK_AUTHORING_CONTRACT_POLICY, getCompleteTaskAuthoringContract } from "@/server/course-generation/authored-output-contract";
import { AuthoredTaskSchema, type AuthoredTask, COURSE_GENERATION_SCHEMA_DIGEST, COURSE_GENERATION_V2_SCHEMA_DIGEST,
  COURSE_VALIDATION_POLICY_DIGEST, COURSE_VALIDATION_V2_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { createBatchItemProof } from "@/server/course-generation/batch-provenance";
import { verifyStoredBatchItem } from "@/server/course-generation/repository";
import { advanceCandidateBatch, assertIndependentOptionalCandidate } from "@/server/course-generation/newbatch-stages";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { taskDigest } from "@/server/mechanics/digest";
import { modelPolicy } from "@/server/ai/model-policy";
import { jsonDigest } from "@/server/ai/json";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { DbTransaction } from "@/server/db";
import type { RunContext } from "@/server/runs/ports";
import type { ModelPort } from "@/server/ai/ports";
import * as stages from "@/server/course-generation/stages";
import { authored, registryFixtures } from "../mechanic-registry/fixtures";
import { fixture, id, digest } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
function proposal(value: AuthoredTask, key = "independent"): TaskIdentityProposal {
  const privateTask = structuredClone(value.privateTask), spec = privateTask.evaluationSpec;
  for (const field of ["rubric", "basisRubric", "explanationRubric"]) {
    const rubric = privateTask.evaluatorData[field];
    if (rubric && typeof rubric === "object" && !Array.isArray(rubric)) privateTask.evaluatorData[field] = { ...rubric, id: null };
  }
  if (spec.kind === "execution") privateTask.evaluatorData.testSetId = null;
  return TaskIdentityProposalSchema.parse({ ...value, privateTask: { ...privateTask,
    evaluationSpec: spec.kind === "rubric" ? { ...spec, rubricId: null, calibrationSetId: null } : spec.kind === "execution" ? { ...spec, testSetId: null } : spec,
    assessment: { ...privateTask.assessment, evidenceGroupId: { kind: "local", key } } } });
}
function batch(values: TaskIdentityProposal[], existing: string[] = []) {
  const items = values.map((value) => ({ itemId: value.task.id, value }));
  const material = { batchKind: "candidate", requestedIds: items.map(({ itemId }) => itemId), items: items.map(({ itemId }) => ({ itemId,
    material: { taskIdentityContext: { policy: TASK_PRIVATE_IDENTITY_POLICY, existingEvidenceGroupIds: existing } } })) };
  return { items, material };
}
const project = (values: TaskIdentityProposal[], existing: string[] = [], namespace = id(700)) => {
  const value = batch(values, existing); return projectTaskIdentityBatch(namespace, value.material, value.items);
};

describe("server-assigned private task identities", () => {
  it("preserves intentional shared evidence groups and keeps independent keys distinct", () => {
    const data = fixture(), first = proposal(data.authored[0]!.tasks[0]!, "shared"), second = proposal(data.authored[0]!.tasks[1]!, "shared");
    const same = project([first, second]);
    expect(same[0]!.value.privateTask.assessment.evidenceGroupId).toBe(same[1]!.value.privateTask.assessment.evidenceGroupId);
    second.privateTask.assessment.evidenceGroupId = { kind: "local", key: "independent" };
    const distinct = project([first, second]);
    expect(distinct[0]!.value.privateTask.assessment.evidenceGroupId).not.toBe(distinct[1]!.value.privateTask.assessment.evidenceGroupId);
    expect(project([first, second])).toEqual(distinct);
    expect(project([first, second], [], id(701))).not.toEqual(distinct);
    expect(IdSchema.safeParse(distinct[0]!.value.privateTask.assessment.evidenceGroupId).success).toBe(true);
    expect(distinct[0]!.value.task).toEqual(first.task);
    expect(distinct[0]!.value.privateTask.sourceClaimIds).toEqual(first.privateTask.sourceClaimIds);
  });
  it("only reuses an explicitly captured group from passed previous tasks", () => {
    const data = fixture(), prior = data.authored[0]!.tasks[0]!, raw = proposal(data.authored[0]!.tasks[1]!);
    raw.privateTask.assessment.evidenceGroupId = { kind: "existing", id: prior.privateTask.assessment.evidenceGroupId };
    expect(() => project([raw])).toThrow("passed prior task");
    const context = taskIdentityMaterial(TASK_PRIVATE_IDENTITY_POLICY, [prior]);
    expect(project([raw], context.taskIdentityContext!.existingEvidenceGroupIds)[0]!.value.privateTask.assessment.evidenceGroupId).toBe(prior.privateTask.assessment.evidenceGroupId);
    expect(() => taskIdentityMaterial(TASK_PRIVATE_IDENTITY_POLICY, undefined)).toThrow();
    expect(taskIdentityMaterial(undefined, undefined)).toEqual({});
  });
  it("does not turn shared optional material into independent evidence by assigning per-task UUIDs", () => {
    const data = fixture(), raw = data.authored[0]!.tasks.map((task) => proposal(task, "shared"));
    raw[1]!.privateTask.assessment.role = "practice";
    const peers = project(raw).map(({ value }) => value);
    expect(() => assertIndependentOptionalCandidate(peers[1]!, peers)).toThrow("evidence group");
  });
  it.each(["recall_reconstruction", "estimation"])("binds the real %s rubric and preserves strict evaluator preparation", async (mechanicId) => {
    const sample = registryFixtures.find(({ id }) => id === mechanicId)!;
    const value = authored(await sample.make(), sample.dimensions);
    const task = AuthoredTaskSchema.parse({ ...value, design: { ...fixture().authored[0]!.tasks[0]!.design, taskId: value.task.id } });
    const raw = proposal(task), before = structuredClone(raw), projected = project([raw])[0]!.value;
    const spec = projected.privateTask.evaluationSpec;
    expect(spec.kind).toBe("rubric");
    const rubric = projected.privateTask.evaluatorData.rubric ?? projected.privateTask.evaluatorData.basisRubric;
    expect(spec.kind === "rubric" && spec.rubricId).toBe((rubric as { id: string }).id);
    expect(spec.kind === "rubric" && spec.calibrationSetId).toBeNull();
    expect(() => prepareTaskCandidate(projected, { approvalDigest: digest })).not.toThrow();
    expect(raw).toEqual(before);
    expect(() => TaskIdentityProposalSchema.parse({ ...raw, privateTask: { ...raw.privateTask,
      evaluationSpec: { ...raw.privateTask.evaluationSpec, calibrationSetId: id(999) } } })).toThrow();
  });
  it("binds both Python test-set IDs and optional explanation rubric without asking for a UUID", () => {
    const task = structuredClone(fixture().authored[0]!.tasks[0]!);
    const raw = proposal(task);
    Object.assign(raw.privateTask, { evaluationSpec: { kind: "execution", executorId: "python_stdlib_v1", dialect: "python3.14", testSetId: null,
      resourceLimits: { timeoutMs: 3000, memoryMb: 256 } }, evaluatorData: { testSetId: null, explanationRubric: { id: null, dimensions: [] } } });
    const value = project([raw])[0]!.value, spec = value.privateTask.evaluationSpec;
    expect(spec.kind === "execution" && spec.testSetId).toBe(value.privateTask.evaluatorData.testSetId);
    expect(IdSchema.safeParse((value.privateTask.evaluatorData.explanationRubric as { id: string }).id).success).toBe(true);
    const invalid = structuredClone(raw); invalid.privateTask.evaluatorData.testSetId = id(999);
    expect(() => project([invalid])).toThrow("null placeholder");
  });
  it.each(["task", "outcome", "source", "design"])("still rejects malformed existing %s references", (field) => {
    const raw = proposal(fixture().authored[0]!.tasks[0]!);
    if (field === "task") raw.task.id = "made-up";
    if (field === "outcome") raw.task.outcomeIds[0] = "made-up";
    if (field === "source") raw.privateTask.sourceClaimIds[0] = "made-up";
    if (field === "design") raw.design.taskId = "made-up";
    expect(() => TaskIdentityProposalSchema.parse(raw)).toThrow();
  });
  it("updates only fresh identity leaves in the complete family contract", () => {
    const at = (root: unknown, ...path: string[]): unknown => path.reduce((value, key) => (value as Record<string, unknown>)[key], root);
    const property = (node: unknown, name: string): unknown => {
      if (!node || typeof node !== "object") return undefined;
      const value = node as Record<string, unknown>, properties = value.properties as Record<string, unknown> | undefined;
      if (properties && name in properties) return properties[name];
      for (const branch of ["anyOf", "oneOf", "allOf"].flatMap((key) => Array.isArray(value[key]) ? value[key] : [])) {
        const found = property(branch, name); if (found !== undefined) return found;
      }
      return undefined;
    };
    const path = ["properties", "privateTask", "properties"];
    for (const mechanic of ["recall_reconstruction", "estimation"]) {
      const old = getCompleteTaskAuthoringContract(mechanic, 2), next = getCompleteTaskAuthoringContract(mechanic, 2, TASK_PRIVATE_IDENTITY_POLICY);
      expect(property(at(old.authoredTaskSchema, ...path, "evaluationSpec"), "rubricId")).toMatchObject({ format: "uuid" });
      expect(property(at(next.authoredTaskSchema, ...path, "evaluationSpec"), "rubricId")).toEqual({ type: "null" });
      expect(property(at(next.authoredTaskSchema, ...path, "evaluationSpec"), "calibrationSetId")).toEqual({ type: "null" });
      const rubricField = mechanic === "estimation" ? "basisRubric" : "rubric";
      expect(property(at(next.authoredTaskSchema, ...path, "evaluatorData", "properties", rubricField), "id")).toEqual({ type: "null" });
      expect(at(next.authoredTaskSchema, "properties", "task", "properties", "id")).toEqual(at(old.authoredTaskSchema, "properties", "task", "properties", "id"));
    }
    const python = getCompleteTaskAuthoringContract("artifact_construction", 3, TASK_PRIVATE_IDENTITY_POLICY);
    expect(at(python.authoredTaskSchema, ...path, "evaluationSpec", "properties", "testSetId")).toEqual({ type: "null" });
    expect(at(python.authoredTaskSchema, ...path, "evaluatorData", "properties", "testSetId")).toEqual({ type: "null" });
  });
});

function replayFixture() {
  const data = fixture(), original = data.authored[0]!.tasks[0]!, raw = proposal(original), itemId = original.task.id;
  const context = { slot: { id: itemId, lessonId: data.authored[0]!.lessons[0]!.id, outcomeIds: original.task.outcomeIds,
    mechanicId: original.task.mechanicId, mechanicVersion: original.task.mechanicVersion, design: original.design,
    assessmentRole: original.privateTask.assessment.role, criteria: original.privateTask.assessment.outcomes.map((outcome) => ({ outcomeId: outcome.outcomeId,
      criterionIds: outcome.dimensions.map(({ dimensionId }) => dimensionId) })) }, knowledge: data.knowledge[0]!, approvalDigest: digest,
    ...taskIdentityMaterial(TASK_PRIVATE_IDENTITY_POLICY, []) };
  const material = { batchKind: "candidate", moduleId: data.draft.modules[0]!.id, approvalDigest: digest, requestedIds: [itemId], items: [{ itemId, material: context }] };
  const items = [{ itemId, value: raw }], parentId = id(700), operationId = id(701), knowledgeId = id(703);
  const projected = projectTaskIdentityBatch(parentId, material, items)[0]!.value;
  const policy = modelPolicy("gemini-flash-google-schema-v2"), rateCard = { model: policy.model, provider: policy.provider, policyVersion: policy.id };
  const generationPolicy = { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384,
    approvalDigest: digest, taskIdentityPolicy: TASK_PRIVATE_IDENTITY_POLICY };
  const parent = { id: parentId, input_digest: jsonDigest(material), schema_digest: COURSE_GENERATION_V2_SCHEMA_DIGEST,
    validation_policy_digest: COURSE_VALIDATION_V2_POLICY_DIGEST, capability_digest: getCapabilityCatalogDigest(), approval_digest: digest,
    generation_policy: { result: generationPolicy, schema: COURSE_GENERATION_SCHEMA_DIGEST, validationPolicy: COURSE_VALIDATION_POLICY_DIGEST,
      capability: getCapabilityCatalogDigest(), approval: digest },
    result_reference: { kind: "course.model.batch.v2", batchKind: "candidate", operationId, material, items } };
  const knowledge = { ...parent, id: knowledgeId, result_reference: { kind: "course.module.knowledge", knowledge: data.knowledge[0], operationId: id(705), sourceReadStepIds: [id(706)] } };
  const provider = { operation_id: operationId, run_step_id: parentId, input_digest: parent.input_digest, request_digest: "b".repeat(64), response_digest: "c".repeat(64),
    provider_request_id: "synthetic-contract-only", state: "settled", usage: {}, rate_card_digest: jsonDigest(rateCard), model_id: policy.model, provider_tag: policy.provider, rate_card: rateCard,
    result: { model: policy.model, provider: policy.providerName, failure: null, finishReason: "stop", content: JSON.stringify({ items }) } };
  const query = vi.fn(async (sql: string, values: unknown[]) => ({ rows: [sql.includes("WITH RECURSIVE lineage") ? values[0] === knowledgeId ? knowledge : parent : provider] }));
  const tx = { query } as unknown as DbTransaction;
  const binding = { run: { id: id(800) }, course: { id: data.draft.courseId, ownerId: id(6) },
    approval: { id: id(801), draftRevision: 1, contentDigest: digest }, draft: data.draft } as ApprovedBuildBinding;
  const child = { id: id(702), inputDigest: jsonDigest(context), result: { moduleId: data.draft.modules[0]!.id, knowledgeStepId: knowledgeId } };
  const proof = createBatchItemProof(parentId, items, itemId);
  const verify = () => verifyStoredBatchItem(tx, binding, child, operationId, proof, AuthoredTaskSchema, projected, "candidate");
  return { data, original, raw, context, material, items, projected, parent, provider, query, proof, verify };
}

describe("raw paid task-ID projection replay", () => {
  it("verifies original raw bytes and reproduces the same canonical candidate without inference", async () => {
    const x = replayFixture();
    expect(x.proof.itemDigest).toBe(taskDigest(x.raw));
    expect(x.proof.itemDigest).not.toBe(taskDigest(x.projected));
    await expect(x.verify()).resolves.toBe("google/gemini-3.8-flash");
    await expect(x.verify()).resolves.toBe("google/gemini-3.8-flash");
  });
  it.each(["paid-response", "raw-proof", "canonical", "capture"])("rejects tampered %s", async (field) => {
    const x = replayFixture();
    if (field === "paid-response") x.provider.result.content = JSON.stringify({ items: [{ ...x.items[0], value: { ...x.raw, task: { ...x.raw.task, instruction: "Changed" } } }] });
    if (field === "raw-proof") x.proof.itemDigest = taskDigest(x.projected);
    if (field === "canonical") x.projected.privateTask.assessment.evidenceGroupId = id(999);
    if (field === "capture") delete (x.parent.generation_policy.result as { taskIdentityPolicy?: string }).taskIdentityPolicy;
    await expect(x.verify()).rejects.toThrow();
  });
  it("captures the new raw schema and only passed existing groups, not unpassed repair peers", async () => {
    const x = replayFixture(), capture = vi.spyOn(stages, "mappedModelStageV2").mockResolvedValue(undefined);
    const peer = structuredClone(x.original); peer.privateTask.assessment.evidenceGroupId = id(999);
    await advanceCandidateBatch({ context: {} as RunContext, binding: { run: { id: id(900), phase: "building_tasks" }, approval: { contentDigest: digest }, draft: x.data.draft } as ApprovedBuildBinding,
      index: new Map(), model: {} as ModelPort, moduleId: x.data.draft.modules[0]!.id, prefix: "module/0", batchKey: "module/batch/0", slots: [x.context.slot], attempt: 0,
      taskAuthoringContractPolicy: COMPLETE_TASK_AUTHORING_CONTRACT_POLICY, taskIdentityPolicy: TASK_PRIVATE_IDENTITY_POLICY,
      previousTasks: [x.original, peer], passedPreviousTasks: [x.original], knowledge: x.data.knowledge[0]!, knowledgeStepId: id(901), facts: x.data.context, correction: null });
    const request = capture.mock.calls[0]![0];
    expect(request.schema.safeParse({ items: x.items }).success).toBe(true);
    const material = z.object({ items: z.array(z.object({ material: z.object({ taskIdentityContext: z.object({ existingEvidenceGroupIds: z.array(IdSchema) }) }) })) }).parse(request.material);
    expect(material.items[0]!.material.taskIdentityContext.existingEvidenceGroupIds).toEqual([x.original.privateTask.assessment.evidenceGroupId]);
    expect(usesTaskIdentityProjection(request.material)).toBe(true);
    expect(request.instructions).toContain("Never generate these UUIDs");
    expect(z.object({ items: z.array(z.object({ material: z.object({ contract: z.record(z.string(), z.unknown()) }) })) }).parse(request.material).items[0]!.material.contract).not.toHaveProperty("evaluatorDataSchema");
  });
});
