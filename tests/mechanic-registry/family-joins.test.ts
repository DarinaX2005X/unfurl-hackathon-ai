import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MECHANIC_IDS } from "@/domain/mechanics";
import { getAssessmentDimensionIds } from "@/server/mechanics/catalog";
import { getServerMechanic } from "@/server/mechanics/registry";
import { prepareTaskCandidate, serializeProductionTask, validateTaskReadiness } from "@/server/mechanics/materialization";
import { getProductionMechanic } from "@/features/learning/registry";
import { authored, approvalDigest, modelContext, registryFixtures, repairPrivate, repairResponse, rubric, runtime } from "./fixtures";

describe("actual public/private/assessment joins", () => {
  it("has a versioned authored case for every production family", () => {
    expect(registryFixtures.map((fixture) => fixture.id).sort()).toEqual([...MECHANIC_IDS].sort());
  });
  for (const fixture of registryFixtures) it(`${fixture.id}: joins strict schemas and the evaluator's successful dimension set`, async () => {
    const input = await fixture.make();
    const candidate = prepareTaskCandidate(authored(input, fixture.dimensions), { approvalDigest });
    expect(getAssessmentDimensionIds(input.task, input.privateData).sort()).toEqual([...fixture.dimensions].sort());
    const handle = getServerMechanic(fixture.id, 2)!;
    const decision = await handle.evaluate(input, modelContext());
    expect(decision.status).toBe("evaluated");
    expect(decision.outcome).toBe("correct");
    expect(decision.dimensions.map((dimension) => dimension.id).sort()).toEqual([...fixture.dimensions].sort());
    expect(validateTaskReadiness(candidate, { runtime, receipt: null }).status).toBe("unreviewed");
    expect(getProductionMechanic(fixture.id, 2)!.parseTask(candidate.task)).toEqual(candidate.task);
    expect(serializeProductionTask({ ...candidate.task, ...candidate.privateTask, validationReceiptId: crypto.randomUUID() })).toEqual(candidate.task);
    const badPrivate = authored(input, fixture.dimensions);
    badPrivate.privateTask.evaluatorData.forbiddenPrivateField = "not in the actual family schema";
    expect(() => prepareTaskCandidate(badPrivate, { approvalDigest })).toThrow();
    const badMapping = authored(input, fixture.dimensions);
    badMapping.privateTask.assessment.outcomes[0]!.dimensions[0]!.evaluationDimensionIds = ["invented_local_dimension"];
    expect(() => prepareTaskCandidate(badMapping, { approvalDigest })).toThrow(/actual successful evaluator dimensions/);
  });
  it("includes properties and optional diagnosis/explanation only when the successful grade emits them", async () => {
    const fixture = registryFixtures.find((item) => item.id === "diagnosis_repair")!;
    const input = await fixture.make();
    input.privateData = { ...repairPrivate,
      properties: [{ id: "nonnegative", kind: "nonnegative", input: { x: 0 } }], explanationRubric: rubric };
    input.response = repairResponse;
    const dimensions = ["numeric_cases", "properties", "diagnosis", "scope"];
    expect(() => prepareTaskCandidate(authored(input, dimensions), { approvalDigest })).not.toThrow();
    expect(getAssessmentDimensionIds(input.task, input.privateData)).toEqual(dimensions);
    const grade = await getServerMechanic("diagnosis_repair", 2)!.evaluate(input, modelContext());
    expect(grade.dimensions.map((dimension) => dimension.id)).toEqual(dimensions);
  });
  it("requires actual rubric identifiers and raw dimensions, not computed prefixes or unrelated calibration labels", async () => {
    const fixture = registryFixtures.find((item) => item.id === "estimation")!;
    const input = authored(await fixture.make(), fixture.dimensions);
    if (input.privateTask.evaluationSpec.kind !== "rubric") throw new Error("Expected fixture rubric");
    input.privateTask.evaluationSpec.requiredDimensions = ["reasoning.scope"];
    expect(() => prepareTaskCandidate(input, { approvalDigest })).toThrow(/actual private rubric/);
    input.privateTask.evaluationSpec.requiredDimensions = ["scope"];
    input.privateTask.evaluationSpec.rubricId = crypto.randomUUID();
    expect(() => prepareTaskCandidate(input, { approvalDigest })).toThrow(/actual private rubric/);
  });
  it("rejects mismatched task version, missing/extra outcomes and repeated canonical/local criteria", async () => {
    const fixture = registryFixtures.find((item) => item.id === "rule_induction")!;
    const base = authored(await fixture.make(), fixture.dimensions);
    const version = structuredClone(base); version.privateTask.taskVersion += 1;
    expect(() => prepareTaskCandidate(version, { approvalDigest })).toThrow(/identity\/version/);
    const outcome = structuredClone(base); outcome.privateTask.assessment.outcomes[0]!.outcomeId = crypto.randomUUID();
    expect(() => prepareTaskCandidate(outcome, { approvalDigest })).toThrow(/exactly the task's outcomes/);
    const canonical = structuredClone(base); canonical.privateTask.assessment.outcomes[0]!.dimensions.push(canonical.privateTask.assessment.outcomes[0]!.dimensions[0]!);
    expect(() => prepareTaskCandidate(canonical, { approvalDigest })).toThrow(/Canonical criteria/);
    const local = structuredClone(base); local.privateTask.assessment.outcomes[0]!.dimensions[0]!.evaluationDimensionIds.push("slope");
    expect(() => prepareTaskCandidate(local, { approvalDigest })).toThrow(/unique/);
  });
});
