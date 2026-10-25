import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PythonArtifactConfigSchema, PythonRepairConfigSchema } from "@/domain/mechanic-families/v3/python";
import { getAssessmentDimensionIds, getGenerationMechanicCatalog, getMechanicAuthoringContract } from "@/server/mechanics/catalog";
import { getServerMechanic } from "@/server/mechanics/registry";
import { prepareTaskCandidate, validateTaskReadiness, serializeProductionTask } from "@/server/mechanics/materialization";
import { authoritativeStoredTaskValidationReceipt, type PreparedTaskCandidate, type StoredTaskValidationReceipt } from "@/server/mechanics/contracts";
import type { GradeDecision } from "@/server/evaluation/contracts";
import type { JsonValue } from "@/domain/common";
import { authored, approvalDigest, runtime } from "./fixtures";
import { task } from "../mechanics/foundations/fixtures";

const dimensions = ["behavior"];
const source = "def solve(payload):\n    return payload * payload";
const original = "def solve(payload):\n    return payload + payload";
function fixture(repair = false) {
  const base = { artifactType: "python_function", language: "python", runtimeProfile: "python_stdlib_v1", entrypoint: "solve",
    specification: "Return the square of the input.", inputShape: { type: "number", integer: true, minimum: -10, maximum: 10 },
    outputShape: { type: "number", integer: true, minimum: 0, maximum: 100 }, starterSource: original,
    publicCases: [{ id: "public_two", input: 2 }] };
  const config = repair ? PythonRepairConfigSchema.parse({ ...base, kind: "diagnosis_repair" }) : PythonArtifactConfigSchema.parse({ ...base, kind: "artifact_construction" });
  const data = { testSetId: "60f745b0-cbd5-4183-a5ee-53ff356c1b6f", hiddenCases: [{ id: "hidden_negative", input: -3, expected: 9, dimensionId: "behavior" }],
    comparator: { kind: "json_exact" }, requiredDimensions: repair ? ["behavior", "location"] : dimensions,
    ...(repair ? { acceptedFaultRegions: [{ startLine: 2, endLine: 2 }], repairLocationDimensionId: "location", explanationRubric: null } : {}) };
  const result = authored({ task: { ...task(config), mechanicVersion: 3, responseSchemaVersion: 3 }, privateData: data }, data.requiredDimensions);
  result.privateTask.evaluationSpec = { kind: "execution", executorId: "python_stdlib_v1", dialect: "python3.14", testSetId: data.testSetId,
    resourceLimits: { timeoutMs: 3000, memoryMb: 256 } };
  return result;
}
const available = { ...runtime, sandbox: { available: true, profiles: ["python_stdlib_v1"] } };
function response(candidate: PreparedTaskCandidate, code = source): JsonValue {
  return candidate.task.mechanicId === "artifact_construction" ? { kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source: code } :
    { kind: "diagnosis_repair", action: "repair", artifactType: "python_function", source: code, locations: [{ startLine: 2, endLine: 2 }], explanation: "Multiply the value by itself instead of adding it twice." };
}
function decision(candidate: PreparedTaskCandidate, correct = true): GradeDecision {
  return { status: "evaluated", outcome: correct ? "correct" : "incorrect",
    dimensions: getAssessmentDimensionIds(candidate.task, candidate.privateTask.evaluatorData).map((id) => ({ id, status: correct || id !== "behavior" ? "met" : "not_met", explanation: "Synthetic stored execution fixture." })),
    feedback: { explanation: "Synthetic stored execution fixture.", nextAction: correct ? "continue" : "revise" } };
}
/** Boundary fixtures only: these stored attestations are not evidence of live Python execution. */
function stored(candidate: PreparedTaskCandidate): StoredTaskValidationReceipt {
  const callId = crypto.randomUUID();
  const cases = (["valid", "alternative", "invalid"] as const).map((category, index) => ({ kind: "response_case" as const, caseId: crypto.randomUUID(), category,
    response: response(candidate, [source, "def solve(payload):\n    return pow(payload, 2)", original][index]!), decision: decision(candidate, category !== "invalid"),
    rejectedAsInvalid: false, modelCallId: null, activityEvidenceRef: crypto.randomUUID() }));
  return { id: crypto.randomUUID(), taskId: candidate.task.id, taskVersion: candidate.task.taskVersion, approvalDigest: candidate.approvalDigest,
    candidateDigest: candidate.candidateDigest, capabilityCatalogDigest: candidate.capabilityCatalogDigest, validatorVersion: "mechanic-readiness-v1",
    checks: [
      { id: "structure", status: "passed", reason: "Pure preparation passed.", evidence: [{ kind: "pure", validatorVersion: "mechanic-readiness-v1" }] },
      { id: "content_review", status: "passed", reason: "Synthetic content review.", evidence: [{ kind: "model_review", callId, modelId: "moonshotai/kimi-k2.6", validator: "content_review", candidateDigest: candidate.candidateDigest, decision: decision(candidate) }] },
      { id: "answer_cases", status: "passed", reason: "Synthetic stored execution cases.", evidence: cases },
      { id: "reachability", status: "passed", reason: "Synthetic successful execution witness.", evidence: [{ kind: "witness", response: response(candidate), decision: decision(candidate), executionEvidenceRef: crypto.randomUUID() }] },
    ], testEvidenceRefs: cases.map((item) => item.caseId), reviewCallRef: callId, verdict: "passed", createdAt: "2026-10-25T00:00:00.000Z" };
}
function readiness(candidate: PreparedTaskCandidate, receipt: StoredTaskValidationReceipt) {
  return validateTaskReadiness(candidate, { runtime: available, receipt: authoritativeStoredTaskValidationReceipt(receipt) });
}

describe("Python v3 materialization and readiness", () => {
  it.each([false, true])("joins execution specs, authored dimensions and public contracts (repair=%s)", (repair) => {
    const input = fixture(repair), candidate = prepareTaskCandidate(input, { approvalDigest });
    expect(candidate.requiredChecks).toContainEqual({ id: "reachability", method: "external" });
    expect(getAssessmentDimensionIds(candidate.task, candidate.privateTask.evaluatorData)).toEqual(repair ? ["behavior", "location"] : dimensions);
    expect(readiness(candidate, stored(candidate)).status).toBe("ready");
    expect(getServerMechanic(candidate.task.mechanicId, 2)?.descriptor.version).toBe(2);
    expect(() => getServerMechanic(candidate.task.mechanicId, 2)!.parseTask(candidate.task)).toThrow();
    const publicTask = serializeProductionTask({ ...input.task, ...input.privateTask });
    expect(JSON.stringify(publicTask)).not.toMatch(/hidden_negative|testSetId|acceptedFaultRegions|explanationRubric/);
    const contract = getMechanicAuthoringContract(candidate.task.mechanicId, 3);
    for (const schema of [contract.publicTaskSchema, contract.configSchema, contract.responseSchema, contract.evaluatorDataSchema]) {
      expect(schema.type).toBe("object"); expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    }
    expect(contract.configSchema.properties?.starterSource).toMatchObject({ type: "string", maxLength: 12000 });
  });
  it("validates hidden input/output shapes, comparator compatibility and fault region references before readiness", () => {
    const invalidInput = fixture(); (invalidInput.privateTask.evaluatorData.hiddenCases as Array<Record<string, JsonValue>>)[0]!.input = "bad";
    expect(() => prepareTaskCandidate(invalidInput, { approvalDigest })).toThrow();
    const invalidOutput = fixture(); (invalidOutput.privateTask.evaluatorData.hiddenCases as Array<Record<string, JsonValue>>)[0]!.expected = 101;
    expect(() => prepareTaskCandidate(invalidOutput, { approvalDigest })).toThrow();
    const invalidComparator = fixture(); invalidComparator.task.config.outputShape = { type: "boolean" };
    (invalidComparator.privateTask.evaluatorData.hiddenCases as Array<Record<string, JsonValue>>)[0]!.expected = true;
    invalidComparator.privateTask.evaluatorData.comparator = { kind: "numeric_tolerance", absolute: 0, relative: 0 };
    expect(() => prepareTaskCandidate(invalidComparator, { approvalDigest })).toThrow(/numeric output shape/);
    const overflowComparator = fixture(); overflowComparator.privateTask.evaluatorData.comparator = { kind: "numeric_tolerance", absolute: 0, relative: 1e308 };
    expect(() => prepareTaskCandidate(overflowComparator, { approvalDigest })).toThrow(/finite tolerance window/);
    const invalidRegion = fixture(true); invalidRegion.privateTask.evaluatorData.acceptedFaultRegions = [{ startLine: 3, endLine: 3 }];
    expect(() => prepareTaskCandidate(invalidRegion, { approvalDigest })).toThrow(/fault region/);
    const dimensions = fixture(); dimensions.privateTask.evaluatorData.requiredDimensions = ["self_claimed"];
    expect(() => prepareTaskCandidate(dimensions, { approvalDigest })).toThrow();
  });
  it("binds the server profile, limits, dialect and private test set", () => {
    for (const change of [{ executorId: "other" }, { dialect: "python2" }, { testSetId: crypto.randomUUID() }, { resourceLimits: { timeoutMs: 3001, memoryMb: 256 } }]) {
      const input = fixture(); Object.assign(input.privateTask.evaluationSpec, change);
      expect(() => prepareTaskCandidate(input, { approvalDigest })).toThrow(/fixed python_stdlib_v1/);
    }
    const blocked = getGenerationMechanicCatalog({ ...available, sandbox: { available: true, profiles: ["unrelated_profile"] } });
    expect(blocked.entries.filter((entry) => entry.version === 3).every((entry) => entry.reasons.includes("sandbox_profile_unavailable:python_stdlib_v1"))).toBe(true);
  });
  it("requires stored execution evidence for every response and reachability witness", () => {
    const candidate = prepareTaskCandidate(fixture(), { approvalDigest });
    const missingCase = stored(candidate);
    const test = missingCase.checks.find((check) => check.id === "answer_cases")!.evidence[0]!;
    if (test.kind === "response_case") test.activityEvidenceRef = null;
    expect(readiness(candidate, missingCase).status).toBe("unreviewed");
    const missingWitness = stored(candidate);
    const witness = missingWitness.checks.find((check) => check.id === "reachability")!.evidence[0]!;
    if (witness.kind === "witness") witness.executionEvidenceRef = null;
    expect(readiness(candidate, missingWitness).status).toBe("unreviewed");
  });
  it("requires a behavioral negative case and proves the original repair program is defective", () => {
    const candidate = prepareTaskCandidate(fixture(true), { approvalDigest });
    const locationOnly = stored(candidate), changedSource = stored(candidate), malformed = stored(candidate);
    for (const [receipt, mutation] of [[locationOnly, "location"], [changedSource, "source"], [malformed, "malformed"]] as const) {
      const test = receipt.checks.find((check) => check.id === "answer_cases")!.evidence.find((item) => item.kind === "response_case" && item.category === "invalid")!;
      if (test.kind !== "response_case") throw new Error("Missing test fixture");
      if (mutation === "location") test.decision = { ...decision(candidate, false), dimensions: [{ id: "behavior", status: "met", explanation: "Behavior succeeds." }, { id: "location", status: "not_met", explanation: "Wrong selected line." }] };
      if (mutation === "source") test.response = response(candidate, "def solve(payload):\n    return 0");
      if (mutation === "malformed") { test.response = {}; test.rejectedAsInvalid = true; test.decision = null; }
      expect(readiness(candidate, receipt).status).toBe("unreviewed");
    }
  });
});
