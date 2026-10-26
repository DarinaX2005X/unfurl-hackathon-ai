import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { productionMechanicManifest } from "@/domain/mechanic-manifest";
import { JsonObjectSchema } from "@/domain/common";
import { PythonArtifactConfigSchema } from "@/domain/mechanic-families/v3/python";
import { PYTHON_PROFILE_LIMITS } from "@/server/execution/python/profile";
import { getCapabilityCatalogDigest, getMechanicAuthoringContract } from "@/server/mechanics/catalog";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { projectCanonicalResearchSources } from "@/server/course-validation/source-grounding";
import { COMPLETE_TASK_AUTHORING_CONTRACT_POLICY, getCompleteTaskAuthoringContract, taskAuthoringContractMaterial } from "@/server/course-generation/authored-output-contract";
import { CourseGenerationPolicyCheckpointSchema } from "@/server/course-generation/checkpoints";
import { advanceCandidateBatch } from "@/server/course-generation/newbatch-stages";
import * as stages from "@/server/course-generation/stages";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { RunContext } from "@/server/runs/ports";
import type { ModelPort } from "@/server/ai/ports";
import { authored, registryFixtures } from "../mechanic-registry/fixtures";
import { digest, fixture, id } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

function schemaAt(root: unknown, ...path: string[]): Record<string, unknown> {
  let value = root;
  for (const key of path) value = z.record(z.string(), z.unknown()).parse(value)[key];
  return z.record(z.string(), z.unknown()).parse(value);
}

function pythonFixture() {
  const result = structuredClone(fixture().authored[0]!.tasks[0]!);
  result.task.mechanicId = "artifact_construction";
  result.task.mechanicVersion = 3;
  result.task.responseSchemaVersion = 3;
  result.task.config = JsonObjectSchema.parse(PythonArtifactConfigSchema.parse({
    kind: "artifact_construction", artifactType: "python_function", language: "python", runtimeProfile: "python_stdlib_v1", entrypoint: "solve",
    specification: "Return the square of the input.", inputShape: { type: "number", integer: true, minimum: -10, maximum: 10 },
    outputShape: { type: "number", integer: true, minimum: 0, maximum: 100 }, starterSource: "def solve(payload):\n    return payload + payload",
    publicCases: [{ id: "public_two", input: 2 }],
  }));
  result.privateTask.evaluatorData = { testSetId: id(802), hiddenCases: [{ id: "negative", input: -3, expected: 9, dimensionId: "behavior" }],
    comparator: { kind: "json_exact" }, requiredDimensions: ["behavior"] };
  result.privateTask.evaluationSpec = { kind: "execution", executorId: "python_stdlib_v1", dialect: "python3.14", testSetId: id(802),
    resourceLimits: { timeoutMs: 3000, memoryMb: 256 } };
  result.privateTask.assessment.outcomes[0]!.dimensions[0]!.evaluationDimensionIds = ["behavior"];
  return result;
}

function captureCandidateRequest(policy?: typeof COMPLETE_TASK_AUTHORING_CONTRACT_POLICY) {
  const data = fixture(), candidate = data.authored[0]!.tasks[0]!;
  const slot = { id: candidate.task.id, lessonId: data.authored[0]!.lessons[0]!.id, outcomeIds: candidate.task.outcomeIds,
    mechanicId: candidate.task.mechanicId, mechanicVersion: candidate.task.mechanicVersion, assessmentRole: candidate.privateTask.assessment.role,
    criteria: candidate.privateTask.assessment.outcomes.map(value => ({ outcomeId: value.outcomeId, criterionIds: value.dimensions.map(dimension => dimension.dimensionId) })),
    design: candidate.design };
  const binding = { run: { id: id(900), phase: "building_tasks" }, approval: { contentDigest: digest }, draft: data.draft } as ApprovedBuildBinding;
  const capture = vi.spyOn(stages, "mappedModelStageV2").mockResolvedValue(undefined);
  const input = { context: {} as RunContext, binding, index: new Map<string, string>(), model: {} as ModelPort,
    moduleId: data.draft.modules[0]!.id, prefix: "course/module/round/0", batchKey: "course/module/round/0/batch/v2/task/0",
    slots: [slot], attempt: 0, previousTasks: [], knowledge: data.knowledge[0]!, knowledgeStepId: id(901), facts: data.context, correction: null,
    ...(policy ? { taskAuthoringContractPolicy: policy } : {}) };
  return { data, slot, capture, input };
}

describe("captured complete task authoring contract", () => {
  it("describes concrete full envelopes for every registered family without changing the historical catalog", () => {
    const before = getCapabilityCatalogDigest();
    const historical = productionMechanicManifest.map(entry => getMechanicAuthoringContract(entry.id, entry.version));
    for (const entry of productionMechanicManifest) {
      const contract = getCompleteTaskAuthoringContract(entry.id, entry.version);
      expect(contract.mechanicIdentity).toEqual({ mechanicId: entry.id, mechanicVersion: entry.version, responseSchemaVersion: entry.responseSchemaVersion });
      expect(contract.authoredTaskSchema.required).toEqual(["task", "privateTask", "design"]);
      expect(schemaAt(contract.authoredTaskSchema, "properties", "task", "properties")).toMatchObject({ mechanicId: { const: entry.id }, mechanicVersion: { const: entry.version }, responseSchemaVersion: { const: entry.responseSchemaVersion } });
      const privateTask = schemaAt(contract.authoredTaskSchema, "properties", "privateTask");
      expect(privateTask.required).toContain("evaluationSpec");
      expect(schemaAt(privateTask, "properties").evaluationSpec).toBeDefined();
      expect(schemaAt(privateTask, "properties", "evaluatorData").type).toBe("object");
    }
    expect(getCapabilityCatalogDigest()).toBe(before);
    expect(productionMechanicManifest.map(entry => getMechanicAuthoringContract(entry.id, entry.version))).toEqual(historical);
    expect(historical.every(contract => !Object.hasOwn(contract, "authoredTaskSchema"))).toBe(true);
  });

  it("supplies the actual Python profile, full evaluationSpec, test-set join and response version", () => {
    const contract = getCompleteTaskAuthoringContract("artifact_construction", 3);
    expect(contract.crossFieldConstraints.execution).toMatchObject({ executorId: "python_stdlib_v1", dialect: "python3.14",
      resourceLimits: { timeoutMs: PYTHON_PROFILE_LIMITS.learnerWallMs, memoryMb: PYTHON_PROFILE_LIMITS.learnerMemoryBytes / (1024 * 1024) } });
    expect(schemaAt(contract.authoredTaskSchema, "properties", "privateTask", "properties", "evaluationSpec", "properties")).toMatchObject({
      kind: { const: "execution" }, executorId: { const: "python_stdlib_v1" }, dialect: { const: "python3.14" },
      testSetId: { type: "string", format: "uuid" }, resourceLimits: { properties: { timeoutMs: { const: 3000 }, memoryMb: { const: 256 } } },
    });
    expect(contract.crossFieldConstraints.execution?.testSetId).toContain("evaluatorData.testSetId");
    expect(() => prepareTaskCandidate(pythonFixture(), { approvalDigest: digest })).not.toThrow();
    for (const patch of [{ dialect: "python" }, { resourceLimits: { timeoutMs: 2000, memoryMb: 128 } }, { executorId: "invented" }, { testSetId: id(999) }]) {
      const wrong = pythonFixture(); Object.assign(wrong.privateTask.evaluationSpec, patch);
      expect(() => prepareTaskCandidate(wrong, { approvalDigest: digest })).toThrow(/dialect=python3.14, resourceLimits.timeoutMs=3000, resourceLimits.memoryMb=256/);
    }
    const wrongVersion = pythonFixture(); wrongVersion.task.responseSchemaVersion = 1;
    expect(() => prepareTaskCandidate(wrongVersion, { approvalDigest: digest })).toThrow(/mechanicVersion=3, responseSchemaVersion=3/);
  });

  it("makes deterministic and rubric joins explicit while keeping their actual validators strict", async () => {
    const deterministic = getCompleteTaskAuthoringContract("rule_induction", 2);
    expect(schemaAt(deterministic.authoredTaskSchema, "properties", "privateTask", "properties", "evaluationSpec", "properties")).toMatchObject({
      evaluatorId: { const: "rule_induction" }, evaluatorVersion: { const: 2 }, secretConfig: { type: "null" },
    });
    const wrong = structuredClone(fixture().authored[0]!.tasks[0]!);
    Object.assign(wrong.privateTask.evaluationSpec, { evaluatorVersion: 1 });
    expect(() => prepareTaskCandidate(wrong, { approvalDigest: digest })).toThrow(/evaluatorId=rule_induction, evaluatorVersion=2, secretConfig=null/);
    const rubricContract = getCompleteTaskAuthoringContract("recall_reconstruction", 2);
    expect(rubricContract.crossFieldConstraints.rubric?.requiredDimensions).toContain("raw rubric.dimensions[].id");
    const registered = registryFixtures.find(entry => entry.id === "recall_reconstruction")!;
    const rubricTask = authored(await registered.make(), registered.dimensions);
    expect(() => prepareTaskCandidate(rubricTask, { approvalDigest: digest })).not.toThrow();
    Object.assign(rubricTask.privateTask.evaluationSpec, { requiredDimensions: ["canonical_learning_criterion"] });
    expect(() => prepareTaskCandidate(rubricTask, { approvalDigest: digest })).toThrow(/raw dimensions\[\].id exactly once/);
  });

  it("leaves an absent historical policy absent and preserves legacy candidate material and instruction bytes", async () => {
    const old = { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384, approvalDigest: digest };
    expect(CourseGenerationPolicyCheckpointSchema.parse(old)).toEqual(old);
    expect(taskAuthoringContractMaterial(undefined, "rule_induction", 2)).toEqual({});
    const test = captureCandidateRequest();
    await advanceCandidateBatch(test.input);
    const request = test.capture.mock.calls[0]![0];
    expect(createHash("sha256").update(request.instructions).digest("hex")).toBe("76c2a668775f1af59710c61f2d34c9cb709786841671552ffe34244ee4efe6b8");
    expect(request.material).toEqual({ batchKind: "candidate", moduleId: test.input.moduleId, approvalDigest: digest, requestedIds: [test.slot.id],
      items: [{ itemId: test.slot.id, material: { slot: test.slot, contentLanguage: test.data.draft.contentLanguage, approvalDigest: digest,
        knowledge: test.data.knowledge[0], contract: getMechanicAuthoringContract(test.slot.mechanicId, test.slot.mechanicVersion),
        claims: test.data.context.claims, passages: test.data.context.passages, canonicalSourceEvidence: projectCanonicalResearchSources(test.data.context),
        existingTaskContexts: [], correction: null } }] });
  });

  it("adds the complete contract only when the new capture opts in, including singleton repairs", async () => {
    const test = captureCandidateRequest(COMPLETE_TASK_AUTHORING_CONTRACT_POLICY);
    test.input.attempt = 1;
    await advanceCandidateBatch(test.input);
    const request = test.capture.mock.calls[0]![0];
    const material = z.object({ items: z.array(z.object({ material: z.record(z.string(), z.unknown()) })) }).parse(request.material).items[0]!.material;
    expect(material.contract).toEqual(getMechanicAuthoringContract(test.slot.mechanicId, test.slot.mechanicVersion));
    expect(material.authoredOutputContract).toEqual(getCompleteTaskAuthoringContract(test.slot.mechanicId, test.slot.mechanicVersion));
    expect(request.instructions).toContain("full privateTask.evaluationSpec schema and crossFieldConstraints");
  });
});
