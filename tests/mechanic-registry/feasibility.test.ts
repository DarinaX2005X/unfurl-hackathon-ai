import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { prepareTaskCandidate, validateTaskReadiness } from "@/server/mechanics/materialization";
import { authored, approvalDigest, registryFixtures, runtime, numericPrivate, numericConfig, adversarialConfig, tolerance, planConfig, planPrivate } from "./fixtures";
import { task } from "../mechanics/foundations/fixtures";
import { constant, variable, add, experiment, intervention, estimation, rubric } from "../mechanics/investigation/fixtures";

describe("feasibility across the public/private boundary", () => {
  it("rejects private evidence spans, prerequisites and accepted edges absent from public material", async () => {
    for (const id of ["confusable_discrimination", "procedure_reconstruction", "relational_mapping"] as const) {
      const fixture = registryFixtures.find((item) => item.id === id)!;
      const input = authored(await fixture.make(), fixture.dimensions);
      if (id === "confusable_discrimination") input.privateTask.evaluatorData.acceptedEvidence = [{ caseId: "fit", requiredSpans: [{ blockId: "fit", start: 0, end: 1000 }] }];
      if (id === "procedure_reconstruction") input.privateTask.evaluatorData.prerequisites = [{ before: "missing", after: "score" }];
      if (id === "relational_mapping") input.privateTask.evaluatorData.acceptedGraphs = [[{ from: "missing", relation: "updates", to: "parameters" }]];
      expect(() => prepareTaskCandidate(input, { approvalDigest })).toThrow();
    }
  });
  it("rejects nonexistent cause/strategy identities and an unspecified decision target", async () => {
    for (const id of ["cause_diagnosis", "strategy_selection"] as const) {
      const fixture = registryFixtures.find((item) => item.id === id)!;
      const input = authored(await fixture.make(), fixture.dimensions);
      input.privateTask.evaluatorData[id === "cause_diagnosis" ? "consistentCauseIds" : "admissibleStrategyIds"] = ["not_displayed"];
      expect(() => prepareTaskCandidate(input, { approvalDigest })).toThrow(/absent|displayed/);
      if (id === "strategy_selection") {
        input.privateTask.evaluatorData.admissibleStrategyIds = [];
        input.privateTask.evaluatorData.targetSpecified = false;
        expect(() => prepareTaskCandidate(input, { approvalDigest })).toThrow(/unspecified/);
      }
    }
  });
  it("joins estimate reference units and rejects numeric contradiction in reference properties", () => {
    const mismatch = authored({ task: task(estimation), privateData: { referenceQuantity: { value: 4, unit: "second" }, tolerance, basisRubric: rubric } }, ["quantity", "reasoning.scope"]);
    expect(() => prepareTaskCandidate(mismatch, { approvalDigest })).toThrow(/convert/);
    const contradiction = authored({ task: task(numericConfig), privateData: { ...numericPrivate,
      properties: [{ id: "nonnegative", kind: "nonnegative", input: { x: -2 } }] } }, ["numeric_cases", "properties"]);
    expect(() => prepareTaskCandidate(contradiction, { approvalDigest })).toThrow(/contradicts/);
    const undeclared = authored({ task: task(numericConfig), privateData: { ...numericPrivate, cases: [{ id: "hidden", input: { x: 1, extra: 2 } }] } }, ["numeric_cases"]);
    expect(() => prepareTaskCandidate(undeclared, { approvalDigest })).toThrow(/exactly the declared/);
  });
  it("rejects an already-correct repair, missing defect locations and an adversary identical to the oracle", async () => {
    const fixture = registryFixtures.find((item) => item.id === "diagnosis_repair")!;
    const correct = authored(await fixture.make(), fixture.dimensions);
    correct.task.config.initialExpression = numericPrivate.reference;
    expect(() => prepareTaskCandidate(correct, { approvalDigest })).toThrow(/already passes/);
    const missing = authored(await fixture.make(), fixture.dimensions);
    missing.privateTask.evaluatorData.acceptedLocationSets = [["/missing"]];
    expect(() => prepareTaskCandidate(missing, { approvalDigest })).toThrow(/absent/);
    const identical = authored({ task: task(adversarialConfig), privateData: { oracle: adversarialConfig.candidate, tolerance } }, ["reproduced_defect"]);
    expect(() => prepareTaskCandidate(identical, { approvalDigest })).toThrow(/no reachable witness/);
  });
  it("requires a hidden hypothesis distinguishable within the actual query budget and tolerance", () => {
    // Three alternatives differ only at different declared queries. One query cannot identify hidden zero.
    const config = { ...experiment, queryBudget: 1, allowedInputs: [0, 1], hypotheses: [
      { id: "zero", expression: constant(0) }, { id: "left", expression: variable("x") },
      { id: "right", expression: { op: "subtract" as const, left: constant(1), right: variable("x") } },
    ] };
    const data = { hiddenHypothesisId: "zero", tolerance, rubric };
    expect(() => prepareTaskCandidate(authored({ task: task(config), privateData: data }, ["identification", "reasoning.scope"]), { approvalDigest })).toThrow(/no reachable witness/);
    config.queryBudget = 2;
    expect(() => prepareTaskCandidate(authored({ task: task(config), privateData: data }, ["identification", "reasoning.scope"]), { approvalDigest })).not.toThrow();
    expect(() => prepareTaskCandidate(authored({ task: task(config), privateData: { ...data, hiddenHypothesisId: "absent" } }, ["identification", "reasoning.scope"]), { approvalDigest })).toThrow(/not declared/);
    const close = { ...experiment, hypotheses: [{ id: "a", expression: variable("x") }, { id: "b", expression: add(variable("x"), constant(1e-10)) }] };
    expect(() => prepareTaskCandidate(authored({ task: task(close), privateData: { hiddenHypothesisId: "a", tolerance, rubric } }, ["identification", "reasoning.scope"]), { approvalDigest })).toThrow(/indistinguishable/);
  });
  it("detects impossible causal targets and keeps large unsearched domains unreviewed", () => {
    const impossible = { ...intervention, target: { variableId: "y", quantity: { value: 100, unit: "unitless" as const } } };
    expect(() => prepareTaskCandidate(authored({ task: task(impossible), privateData: { tolerance } }, ["target"]), { approvalDigest })).toThrow(/no reachable witness/);
    const large = { ...intervention, variables: [{ id: "x", min: 0, max: 100_000, step: 1, unit: "unitless" as const }], equations: { y: variable("x") } };
    const candidate = prepareTaskCandidate(authored({ task: task(large), privateData: { tolerance } }, ["target"]), { approvalDigest });
    expect(candidate.requiredChecks).toContainEqual({ id: "reachability", method: "external" });
    expect(validateTaskReadiness(candidate, { runtime, receipt: null }).status).toBe("unreviewed");
  });
  it("finds valid decimal endpoints without rounding them beyond the authored bounds", () => {
    const config = { ...intervention, variables: [{ id: "x", min: 0, max: 0.3, step: 0.1, unit: "unitless" as const }], equations: { y: variable("x") },
      target: { variableId: "y", quantity: { value: 0.3, unit: "unitless" as const } } };
    expect(() => prepareTaskCandidate(authored({ task: task(config), privateData: { tolerance: { absTol: 0, relTol: 0 } } }, ["target"]), { approvalDigest })).not.toThrow();
  });
  it("rejects unreachable plans, invalid initial invariants and optimization goals", async () => {
    const config = { ...planConfig, operators: [{ ...planConfig.operators[0]!, requires: ["finished"] }] };
    expect(() => prepareTaskCandidate(authored({ task: task(config), privateData: planPrivate }, ["executable_plan"]), { approvalDigest })).toThrow(/no reachable witness/);
    expect(() => prepareTaskCandidate(authored({ task: task(planConfig), privateData: { ...planPrivate, invariants: [{ id: "no_raw", forbidAll: ["raw"] }] } }, ["executable_plan"]), { approvalDigest })).toThrow(/starting state/);
    const fixture = registryFixtures.find((item) => item.id === "constrained_optimization")!;
    const input = authored(await fixture.make(), fixture.dimensions);
    input.task.config.objective = { outputId: "gain", direction: "maximize", minimumImprovement: 10 };
    expect(() => prepareTaskCandidate(input, { approvalDigest })).toThrow(/no reachable witness/);
  });
  it("does not infer semantic dialogue reachability from nonempty private facts and outcomes", async () => {
    for (const id of ["misconception_tutoring", "information_gap", "role_simulation"] as const) {
      const fixture = registryFixtures.find((item) => item.id === id)!;
      const candidate = prepareTaskCandidate(authored(await fixture.make(), fixture.dimensions), { approvalDigest });
      expect(candidate.requiredChecks).toEqual(expect.arrayContaining([
        { id: "dialogue_compatibility", method: "external" }, { id: "reachability", method: "external" },
      ]));
      expect(validateTaskReadiness(candidate, { runtime, receipt: null }).status).toBe("unreviewed");
    }
  });
  it("requires a bounded alternative witness when the reference exceeds the learner's expression budget", () => {
    const config = { ...numericConfig, maxNodes: 1 };
    const candidate = prepareTaskCandidate(authored({ task: task(config), privateData: numericPrivate }, ["numeric_cases"]), { approvalDigest });
    expect(candidate.requiredChecks).toContainEqual({ id: "reachability", method: "external" });
  });
});
