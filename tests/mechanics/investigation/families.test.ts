import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { responseDigest } from "@/domain/activity";
import * as domain from "@/domain/mechanic-families/v2/investigation";
import * as grading from "@/server/evaluation/investigation";
import { tracing, diagnosis, experiment, intervention, estimation, strategy, source, task, tolerance, rubric, context, unavailable, predictionCase, experimentCase, interventionCase, variable, constant, add } from "./fixtures";

describe("state tracing", () => {
  const evaluate = (states: domain.StateTracingResponse["states"]) => grading.stateTracingEvaluator.evaluate({ task: task(tracing), response: { kind: "state_tracing", action: "trace", states }, privateData: { tolerance }, activity: null }, unavailable());
  it("calculates every intermediate gradient update from the previous state", async () => {
    expect(domain.traceState(tracing)).toEqual([{ w: -.2 }, { w: -.1 }]);
    expect(await evaluate([{ w: -.2 }, { w: -.1 }])).toMatchObject({ outcome: "correct" });
  });
  it("rejects the plausible sign-reversed update as incorrect", async () => { expect(await evaluate([{ w: .2 }, { w: .1 }])).toMatchObject({ outcome: "incorrect" }); });
  it("accepts a decimal alternative within the private tolerance", async () => { expect(await evaluate([{ w: -.2000000001 }, { w: -.1000000001 }])).toMatchObject({ outcome: "correct" }); });
  it("requires intermediate states and cannot pass a correct final value alone", async () => {
    const response: domain.StateTracingResponse = { kind: "state_tracing", action: "trace", states: [{ w: -.1 }] };
    expect(domain.stateTracingDescriptor.validateSubmission(tracing, response)).not.toHaveLength(0);
    expect(await evaluate(response.states)).toMatchObject({ status: "uncertain", outcome: null });
  });
  it("assigns simultaneous updates without depending on key order", () => {
    const config = domain.StateTracingConfigSchema.parse({ kind: "state_tracing", initial: { a: 1, b: 2 }, inputs: [{ increment: 1 }], units: { a: "unitless", b: "unitless" }, updates: { a: variable("b"), b: add(variable("a"), variable("increment")) } });
    expect(domain.traceState(config)).toEqual([{ a: 2, b: 2 }]);
    expect(domain.StateTracingConfigSchema.safeParse({ ...config, inputs: [{ a: 3 }] }).success).toBe(false);
  });
});

describe("outcome prediction", () => {
  it("checks a saved interval committed before observing y=7", async () => { expect(await grading.outcomePredictionEvaluator.evaluate(await predictionCase(), unavailable())).toMatchObject({ outcome: "correct" }); });
  it("grades a valid committed interval that misses the outcome", async () => { expect(await grading.outcomePredictionEvaluator.evaluate(await predictionCase(0, 1), unavailable())).toMatchObject({ outcome: "incorrect" }); });
  it("accepts a different narrow interval containing the outcome", async () => { expect(await grading.outcomePredictionEvaluator.evaluate(await predictionCase(6.95, 7.05), unavailable())).toMatchObject({ outcome: "correct" }); });
  it("cannot turn post-observation or edited predictions into independent success", async () => {
    const input = await predictionCase();
    input.activity.predictionBeforeObservation = false;
    expect(await grading.outcomePredictionEvaluator.evaluate(input, unavailable())).toMatchObject({ status: "uncertain", outcome: null });
    const edited = await predictionCase();
    edited.response.interval.lower = 6.8;
    edited.activity.input = { ...edited.activity.input, responseDigest: await responseDigest(edited.response) };
    expect(await grading.outcomePredictionEvaluator.evaluate(edited, unavailable())).toMatchObject({ status: "uncertain", outcome: null });
  });
  it("does not reject the stated interval width because of binary subtraction rounding", async () => {
    const input = await predictionCase(.7, .8);
    input.task.config = { ...input.task.config, maxIntervalWidth: .1, model: { ...input.task.config.model, outputs: [{ id: "y", unit: "unitless", expression: constant(.75) }] } };
    const observation = input.activity.receipts[1]!.observation;
    if (observation?.kind !== "values") throw new Error("Fixture observation is missing");
    observation.values[0]!.quantity.value = .75;
    expect(await grading.outcomePredictionEvaluator.evaluate(input, unavailable())).toMatchObject({ outcome: "correct" });
  });
});

describe("cause diagnosis", () => {
  const response: domain.CauseDiagnosisResponse = { kind: "cause_diagnosis", action: "diagnose", conclusion: "unidentified", consistentCauseIds: ["covariate", "conditional"], neededEvidence: "Compare input distributions and conditionals across organizations; the audit rules out preprocessing leakage." };
  const input = () => ({ task: task(diagnosis), response, privateData: { consistentCauseIds: ["covariate", "conditional"], rubric }, activity: null });
  it("retains unresolved causes and supplies discriminating evidence", async () => {
    expect(await grading.causeDiagnosisEvaluator.evaluate(input(), context("met", (request) => { expect(request.context?.material).toEqual(diagnosis); expect(request.response).toEqual(response); }))).toMatchObject({ outcome: "correct" });
  });
  it("rejects declaring audited preprocessing leakage proven by the score drop", async () => { expect(await grading.causeDiagnosisEvaluator.evaluate({ ...input(), response: { ...response, conclusion: "identified", consistentCauseIds: ["leakage"] } }, context())).toMatchObject({ outcome: "incorrect" }); });
  it("allows a qualified candidate with a useful discriminating measurement", async () => { expect(await grading.causeDiagnosisEvaluator.evaluate({ ...input(), response: { ...response, consistentCauseIds: ["covariate"], neededEvidence: "Covariate change is one candidate, not identified. Compare held-out input distributions and test whether conditional performance also changed." } }, context())).toMatchObject({ outcome: "correct" }); });
  it("preserves actual assessment uncertainty instead of forcing one cause", async () => { expect(await grading.causeDiagnosisEvaluator.evaluate(input(), context("uncertain"))).toMatchObject({ status: "uncertain", outcome: null }); });
});

describe("experimental investigation", () => {
  it("uses x=1 and actual output2 to distinguish h2", async () => { expect(await grading.experimentalInvestigationEvaluator.evaluate(await experimentCase(), context())).toMatchObject({ outcome: "correct" }); });
  it("does not call x=0 evidence of a unique h2", async () => { expect(await grading.experimentalInvestigationEvaluator.evaluate(await experimentCase(0), context())).toMatchObject({ outcome: "incorrect" }); });
  it("accepts the independent alternative x=2 and output4", async () => { expect(await grading.experimentalInvestigationEvaluator.evaluate(await experimentCase(2), context())).toMatchObject({ outcome: "correct" }); });
  it("rejects forged receipts and inputs outside the permitted queries", async () => {
    const input = await experimentCase(); input.response.observationReceiptIds = [crypto.randomUUID()];
    input.activity.input = { ...input.activity.input, responseDigest: await responseDigest(input.response) };
    expect(await grading.experimentalInvestigationEvaluator.evaluate(input, context())).toMatchObject({ status: "uncertain", outcome: null });
    expect(() => domain.experimentOutput(experiment, "h2", 99)).toThrow();
  });
  it("keeps an observed inconclusive result unresolved and rejects inseparable hypothesis configurations", async () => {
    expect(await grading.experimentalInvestigationEvaluator.evaluate(await experimentCase(0, null), context())).toMatchObject({ status: "uncertain", outcome: null });
    expect(domain.ExperimentalInvestigationConfigSchema.safeParse({ ...experiment, allowedInputs: [0] }).success).toBe(false);
    expect(grading.hasDistinguishableHypotheses(experiment, { absTol: 10, relTol: 0 })).toBe(false);
    const indistinguishable = await experimentCase();
    indistinguishable.privateData.tolerance = { absTol: 10, relTol: 0 };
    expect(await grading.experimentalInvestigationEvaluator.evaluate(indistinguishable, context())).toMatchObject({ status: "uncertain", outcome: null });
  });
});

describe("causal intervention", () => {
  it("recomputes y=2x+z from the saved x2,z0 intervention", async () => { expect(await grading.causalInterventionEvaluator.evaluate(await interventionCase(), unavailable())).toMatchObject({ outcome: "correct" }); });
  it("checks the actual y2 result against target4", async () => { expect(await grading.causalInterventionEvaluator.evaluate(await interventionCase(1, 0), unavailable())).toMatchObject({ outcome: "incorrect" }); });
  it("accepts x1,z2 as a different valid intervention", async () => { expect(await grading.causalInterventionEvaluator.evaluate(await interventionCase(1, 2), unavailable())).toMatchObject({ outcome: "correct" }); });
  it("prevents direct target assignment, unknown variables and cyclic models", () => {
    const response: domain.CausalInterventionResponse = { kind: "causal_intervention", action: "intervene", assignments: { x: 0, z: 0, y: 4 }, observationReceiptId: crypto.randomUUID() };
    expect(domain.causalInterventionDescriptor.validateSubmission(intervention, response)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_reference" })]));
    expect(() => domain.evaluateCausalModel(intervention, { x: 0, z: 0, unknown: 4 })).toThrow();
    expect(domain.CausalInterventionConfigSchema.safeParse({ ...intervention, equations: { y: variable("q"), q: variable("y") } }).success).toBe(false);
  });
  it("recomputes derived nodes in dependency order and refuses edited assignments with an old observation", async () => {
    const config = domain.CausalInterventionConfigSchema.parse({ ...intervention, equations: { y: add(variable("middle"), variable("z")), middle: add(variable("x"), variable("x")) } });
    expect(domain.evaluateCausalModel(config, { x: 1, z: 2 })).toEqual([{ id: "middle", quantity: { value: 2, unit: "unitless" } }, { id: "y", quantity: { value: 4, unit: "unitless" } }]);
    const input = await interventionCase(); input.response.assignments.x = 1;
    input.activity.input = { ...input.activity.input, responseDigest: await responseDigest(input.response) };
    expect(await grading.causalInterventionEvaluator.evaluate(input, unavailable())).toMatchObject({ status: "uncertain", outcome: null });
  });
});

describe("estimation", () => {
  const input = (lower = 3.8, upper = 4.2, unit: domain.EstimationResponse["unit"] = "MB") => ({ task: task(estimation), response: { kind: "estimation" as const, action: "estimate" as const, lower, upper, unit, basis: "1,000,000 parameters times 4 bytes is 4,000,000 bytes; decimal MB is 1,000,000 bytes. Overhead is excluded." }, privateData: { referenceQuantity: { value: 4_000_000, unit: "byte" as const }, tolerance, basisRubric: rubric }, activity: null });
  it("normalizes decimal MB before checking scale, coverage and width", async () => { expect(await grading.estimationEvaluator.evaluate(input(), context())).toMatchObject({ outcome: "correct" }); });
  it("rejects a numerically plausible bound with the wrong byte scale", async () => { expect(await grading.estimationEvaluator.evaluate(input(4_000, 4_000, "byte"), context())).toMatchObject({ outcome: "incorrect" }); });
  it("accepts an exact equivalent estimate expressed in bytes", async () => { expect(await grading.estimationEvaluator.evaluate(input(4_000_000, 4_000_000, "byte"), context())).toMatchObject({ outcome: "correct" }); });
  it("requires compatible units, rejects zero references and never fabricates basis grading", async () => {
    expect(domain.estimationDescriptor.validateSubmission(estimation, input(4, 4, null).response)).not.toHaveLength(0);
    expect(domain.estimationDescriptor.validateSubmission(estimation, input(4, 4, "second").response)).not.toHaveLength(0);
    expect(grading.EstimationPrivateSchema.safeParse({ ...input().privateData, referenceQuantity: { value: 0, unit: "byte" } }).success).toBe(false);
    expect(await grading.estimationEvaluator.evaluate(input(), unavailable())).toMatchObject({ status: "unavailable", outcome: null });
  });
});

describe("strategy selection", () => {
  const input = (strategyId = "holdout") => ({ task: task(strategy), response: { kind: "strategy_selection" as const, action: "select_strategy" as const, strategyId, assumptions: ["The held-out organizations and time periods represent the intended deployment."], justification: "Respect both organization membership and observation time when constructing the final evaluation." }, privateData: { admissibleStrategyIds: ["holdout", "nested"], targetSpecified: true, rubric }, activity: null });
  it("checks the target holdout strategy together with its representativeness assumption", async () => { expect(await grading.strategySelectionEvaluator.evaluate(input(), context("met", (request) => expect(request.allowedResponsePaths).toContainEqual(["assumptions"])))).toMatchObject({ outcome: "correct" }); });
  it("rejects a random split and universal deployment guarantee", async () => { const wrong = input("random"); wrong.response.justification = "A random split guarantees success at every future organization."; expect(await grading.strategySelectionEvaluator.evaluate(wrong, context())).toMatchObject({ outcome: "incorrect" }); });
  it("accepts nested selection followed by the same required final holdout", async () => { expect(await grading.strategySelectionEvaluator.evaluate(input("nested"), context())).toMatchObject({ outcome: "correct" }); });
  it("asks for a missing deployment target instead of requiring one universal split", async () => { const missing = input(); missing.privateData.targetSpecified = false; expect(await grading.strategySelectionEvaluator.evaluate(missing, context())).toMatchObject({ status: "uncertain", outcome: null }); });
});

describe("source investigation", () => {
  const input = () => ({ task: task(source), response: { kind: "source_investigation" as const, action: "investigate_sources" as const, verdict: "not_supported" as domain.SourceInvestigationResponse["verdict"], citations: [{ sourceId: "synthetic", passageId: "scope", span: null as domain.SourceInvestigationResponse["citations"][number]["span"] }], explanation: "The passage establishes how to avoid leakage during preprocessing. It does not establish robustness at every new organization." }, privateData: { sources: source.sources, rubric }, activity: null });
  it("assesses the actual passage and rejects the universal scope", async () => { expect(await grading.sourceInvestigationEvaluator.evaluate(input(), context("met", (request) => expect(request.context?.referenceFacts).toMatchObject({ citedPassages: [{ text: source.sources[0]!.passages[0]!.text }] })))).toMatchObject({ outcome: "correct" }); });
  it("does not accept a claim merely because the title appears authoritative", async () => { const wrong = input(); wrong.response.verdict = "supported"; wrong.response.explanation = "The title looks official, so it guarantees robustness."; expect(await grading.sourceInvestigationEvaluator.evaluate(wrong, context("not_met"))).toMatchObject({ outcome: "incorrect" }); });
  it("accepts a scope-qualified alternative and valid passage span", async () => { const alternative = input(); alternative.response.verdict = "mixed"; alternative.response.explanation = "Narrow the claim to avoiding held-out fitting data. Request separate evidence about the target organizations."; alternative.response.citations[0]!.span = { blockId: "scope", start: 0, end: 117 }; expect(await grading.sourceInvestigationEvaluator.evaluate(alternative, context())).toMatchObject({ outcome: "correct" }); });
  it("rejects missing, mismatched or invented evidence and reports absent semantic assessment", async () => {
    const malformed = input(); malformed.response.citations[0]!.span = { blockId: "scope", start: 0, end: 9999 };
    expect(domain.sourceInvestigationDescriptor.validateSubmission(source, malformed.response)).not.toHaveLength(0);
    const mismatch = input(); mismatch.task.config = { ...source, sources: [{ ...source.sources[0]!, contentDigest: "b".repeat(64) }] };
    expect(await grading.sourceInvestigationEvaluator.evaluate(mismatch, context())).toMatchObject({ status: "uncertain", outcome: null });
    expect(await grading.sourceInvestigationEvaluator.evaluate(input(), unavailable())).toMatchObject({ status: "unavailable", outcome: null });
  });
});

describe("strict public family boundaries", () => {
  it("keeps editable blanks separate from complete submissions", () => {
    const configById: Record<string, import("@/domain/common").JsonValue> = { state_tracing: tracing, outcome_prediction: predictionConfig(), cause_diagnosis: diagnosis, experimental_investigation: experiment, causal_intervention: intervention, estimation, strategy_selection: strategy, source_investigation: source };
    for (const descriptor of domain.descriptors) {
      const config = descriptor.configSchema.parse(configById[descriptor.id]);
      // The heterogeneous registry join is tested via each descriptor's own schema.
      const generic = descriptor as import("@/domain/mechanic-families/v2/shared").FamilyDescriptor<import("@/domain/common").JsonValue, import("@/domain/common").JsonValue>;
      const blank = generic.createInitialResponse(config);
      expect(generic.responseSchema.safeParse(blank).success).toBe(true);
      expect(generic.validateSubmission(config, blank).length).toBeGreaterThan(0);
      expect(generic.responseSchema.safeParse({ ...(blank as object), correct: true }).success).toBe(false);
    }
  });
  it("rejects undeclared and nonfinite numerical models", () => {
    expect(domain.StateTracingConfigSchema.safeParse({ ...tracing, updates: { w: variable("hidden") } }).success).toBe(false);
    expect(domain.ExperimentalInvestigationConfigSchema.safeParse({ ...experiment, hypotheses: [{ id: "bad", expression: { op: "divide", left: constant(1), right: constant(0) } }, experiment.hypotheses[1]] }).success).toBe(false);
  });
});
function predictionConfig() { return domain.OutcomePredictionConfigSchema.parse({ kind: "outcome_prediction", model: { inputs: [], outputs: [{ id: "y", unit: "unitless", expression: constant(7) }] }, settings: {}, targetOutputId: "y", allowedUnits: ["unitless"], maxIntervalWidth: 1 }); }
