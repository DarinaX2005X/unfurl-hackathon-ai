import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JsonValue } from "../../../src/domain/common";
import type { TaskPublic } from "../../../src/domain/mechanics";
import { responseDigest, type ActionReceipt, type InputSnapshot } from "../../../src/domain/activity";
import {
  ArtifactConstructionConfigSchema, ArtifactConstructionResponseSchema, ConstrainedOptimizationConfigSchema,
  DiagnosisRepairConfigSchema, PlanConstructionConfigSchema, descriptors, inspectPlan,
  PlanConstructionResponseSchema,
  artifactConstructionDescriptor, adversarialTestingDescriptor, constrainedOptimizationDescriptor,
  diagnosisRepairDescriptor, planConstructionDescriptor, resolveExpressionPointer,
  type ArtifactConstructionConfig, type ArtifactConstructionResponse,
  type AdversarialTestingConfig, type AdversarialTestingResponse,
  type ConstrainedOptimizationConfig, type ConstrainedOptimizationResponse,
  type DiagnosisRepairConfig, type DiagnosisRepairResponse, type PlanConstructionConfig, type PlanConstructionResponse,
} from "../../../src/domain/mechanic-families/v2/construction";
import { evaluateBoundedModel, type Expr } from "../../../src/domain/mechanic-families/v2/shared";
import {
  ConstructionSubmissionError, artifactConstructionEvaluator, adversarialTestingEvaluator,
  constrainedOptimizationEvaluator, diagnosisRepairEvaluator, planConstructionEvaluator,
  runConstructionActivity, type ArtifactConstructionPrivate, type DiagnosisRepairPrivate,
} from "../../../src/server/evaluation/construction";
import { GradeDecisionSchema, type AuthoritativeActivity, type EvaluationContext, type RubricJudge } from "../../../src/server/evaluation/contracts";

const constant = (value: number): Expr => ({ op: "constant", value });
const variable = (name: string): Expr => ({ op: "variable", name });
const subtract = (left: Expr, right: Expr): Expr => ({ op: "subtract", left, right });
const multiply = (left: Expr, right: Expr): Expr => ({ op: "multiply", left, right });
const add = (left: Expr, right: Expr): Expr => ({ op: "add", left, right });
const delta = subtract(variable("y"), variable("prediction"));
const squared = multiply(delta, delta);
const reversed = subtract(variable("prediction"), variable("y"));
const alternative = multiply(reversed, reversed);
const absolute: Expr = { op: "abs", value: delta };
const tolerance = { absTol: 1e-10, relTol: 1e-10 };
const variables = [{ id: "y", text: "Observed value" }, { id: "prediction", text: "Predicted value" }];
const publicCases = [{ id: "public1", input: { y: 1, prediction: 0 } }];
const context: EvaluationContext = { model: null, signal: new AbortController().signal };

function task<C extends JsonValue & { kind: TaskPublic["mechanicId"] }>(config: C): TaskPublic<C> {
  return { id: "11111111-1111-4111-8111-111111111111", taskVersion: 1, mechanicId: config.kind, mechanicVersion: 2,
    outcomeIds: ["22222222-2222-4222-8222-222222222222"], instruction: "Complete the stated task and explain your work where requested.",
    contentLanguage: "en", config, availableHints: 1, responseSchemaVersion: 2 };
}

const planConfig: PlanConstructionConfig = {
  kind: "plan_construction", goal: "Select a model before evaluating it on the untouched final test set.",
  initialFacts: ["raw", "test_untouched"], budgetSteps: 6, budgetCost: 6,
  operators: [
    { id: "split", label: "Split the data", requires: ["raw"], adds: ["train", "validation"], removes: ["raw"], cost: 1 },
    { id: "fit", label: "Fit on training data", requires: ["train"], adds: ["fitted"], removes: [], cost: 1 },
    { id: "select", label: "Select on validation data", requires: ["fitted", "validation"], adds: ["selected"], removes: [], cost: 1 },
    { id: "nested", label: "Use nested validation within development data", requires: ["train", "validation"], adds: ["selected"], removes: [], cost: 2 },
    { id: "leak", label: "Select from final test results", requires: ["fitted", "test_untouched"], adds: ["selected", "test_used_for_selection"], removes: [], cost: 1 },
    { id: "freeze", label: "Freeze the selected model", requires: ["selected"], adds: ["frozen"], removes: [], cost: 1 },
    { id: "evaluate", label: "Evaluate once on the final test", requires: ["frozen", "test_untouched"], adds: ["reported"], removes: ["test_untouched"], cost: 1 },
  ],
};
const planPrivate = { requiredFinalFacts: ["reported"], invariants: [{ id: "independence", forbidAll: ["test_used_for_selection"] }] };
function plan(...operators: string[]): PlanConstructionResponse {
  return { kind: "plan_construction", action: "build_plan", steps: operators.map((operatorId, index) => ({ id: `step${index + 1}`, operatorId, after: index === 0 ? [] : [`step${index}`] })) };
}
const gradePlan = (response: PlanConstructionResponse, config = planConfig) => planConstructionEvaluator.evaluate({ task: task(config), response, privateData: planPrivate, activity: null }, context);

const artifactConfig: ArtifactConstructionConfig = {
  kind: "artifact_construction", artifactType: "numeric_expression", variables,
  specification: "Construct squared error between y and prediction.", maxNodes: 15, publicCases,
};
const numericPrivate: ArtifactConstructionPrivate = {
  reference: squared, cases: [
    { id: "zero", input: { y: 2, prediction: 2 } },
    { id: "magnitude2", input: { y: 2, prediction: 0 } },
    { id: "negative", input: { y: -3, prediction: 1 } },
  ], properties: [
    { id: "nonnegative", kind: "nonnegative", input: { y: 0, prediction: 3 } },
    { id: "symmetric", kind: "invariant", input: { y: 3, prediction: 1 }, otherInput: { y: 1, prediction: 3 } },
  ], tolerance,
};
const artifactResponse = (expression: Expr | null): ArtifactConstructionResponse => ({ kind: "artifact_construction", action: "build_artifact", expression });
const gradeArtifact = (expression: Expr | null, data = numericPrivate) => artifactConstructionEvaluator.evaluate({
  task: task(artifactConfig), response: artifactResponse(expression), privateData: data, activity: null,
}, context);

const repairConfig: DiagnosisRepairConfig = {
  kind: "diagnosis_repair", artifactType: "numeric_expression", initialExpression: absolute, variables,
  specification: "Repair absolute error so it measures squared error.", publicCases,
};
const repairPrivate: DiagnosisRepairPrivate = { ...numericPrivate, acceptedLocationSets: [[""]], explanationRubric: null };
const repairResponse = (replacement: Expr, locationPaths = [""]): DiagnosisRepairResponse => ({
  kind: "diagnosis_repair", action: "repair", locationPaths, replacement,
  explanation: "Absolute error grows linearly with the error magnitude. Squaring the difference makes an error of two contribute four.",
});
const gradeRepair = (response: DiagnosisRepairResponse, data = repairPrivate, assessment = context) => diagnosisRepairEvaluator.evaluate({
  task: task(repairConfig), response, privateData: data, activity: null,
}, assessment);

const adversarialConfig: AdversarialTestingConfig = {
  kind: "adversarial_testing", candidate: absolute, specification: "The candidate must return squared error.", maxCases: 4,
  variables: [{ id: "y", min: -10, max: 10, step: 1, unit: "unitless" }, { id: "prediction", min: -10, max: 10, step: 1, unit: "unitless" }],
};
const testsResponse = (y: number, prediction: number, expected: number | null): AdversarialTestingResponse => ({
  kind: "adversarial_testing", action: "design_tests", cases: [{ input: { y, prediction }, expected }],
  failureExplanation: "The candidate takes an absolute difference, so an error magnitude greater than one distinguishes it from squared error.",
});
const gradeTests = (response: AdversarialTestingResponse) => adversarialTestingEvaluator.evaluate({
  task: task(adversarialConfig), response, privateData: { oracle: squared, tolerance }, activity: null,
}, context);

const optimizationConfig: ConstrainedOptimizationConfig = {
  kind: "constrained_optimization", baseline: { x: 0, y: 2 },
  model: {
    inputs: [{ id: "x", min: 0, max: 4, step: 1, unit: "unitless" }, { id: "y", min: 0, max: 4, step: 1, unit: "unitless" }],
    outputs: [
      { id: "cost", unit: "unitless", expression: add(variable("x"), multiply(constant(2), variable("y"))) },
      { id: "benefit", unit: "unitless", expression: add(multiply(constant(3), variable("x")), multiply(constant(2), variable("y"))) },
    ],
  }, objective: { outputId: "benefit", direction: "maximize", minimumImprovement: 4 },
  constraints: [{ outputId: "cost", operator: "lte", value: 4 }],
};
const optimizationResponse = (x: number, y: number, receipt: string | null = "33333333-3333-4333-8333-333333333333"): ConstrainedOptimizationResponse => ({
  kind: "constrained_optimization", action: "optimize", configuration: { x, y }, observationReceiptId: receipt,
});

async function activityFor(response: ConstrainedOptimizationResponse, ran = response.configuration, config = optimizationConfig): Promise<AuthoritativeActivity> {
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const runResponse: ConstrainedOptimizationResponse = { ...response, configuration: ran, observationReceiptId: null };
  const historicalInput: InputSnapshot = { activitySessionId: sessionId, inputRevision: 1, responseDigest: await responseDigest(runResponse), response: runResponse };
  const input: InputSnapshot = { activitySessionId: sessionId, inputRevision: 2, responseDigest: await responseDigest(response), response };
  const receipt: ActionReceipt = { id: response.observationReceiptId!, clientActionId: "55555555-5555-4555-8555-555555555555",
    input: { activitySessionId: sessionId, inputRevision: 1, responseDigest: historicalInput.responseDigest },
    sessionRevision: 1, status: "completed", observation: { kind: "values", values: evaluateBoundedModel(config.model, ran) } };
  return { session: { id: sessionId, enrollmentId: "66666666-6666-4666-8666-666666666666", taskId: task(config).id, taskVersion: 1,
    revision: 1, inputRevision: 2, status: "active", remainingActions: 5,
    events: [{ id: "77777777-7777-4777-8777-777777777777", seq: 1, at: "2026-10-25T08:00:00.000Z", action: { kind: "run" }, receipt }] },
    input, receipts: [receipt], receiptInputs: [historicalInput], assistance: "independent", revealedFactIds: [],
    committedPredictionReceiptId: null, predictionBeforeObservation: false };
}
async function gradeOptimization(response: ConstrainedOptimizationResponse, activity?: AuthoritativeActivity, config = optimizationConfig) {
  return constrainedOptimizationEvaluator.evaluate({ task: task(config), response, privateData: { tolerance }, activity: activity ?? await activityFor(response, response.configuration, config) }, context);
}

describe("plan construction: executable plans, not a reference list", () => {
  it("accepts split, fit, validation selection, freeze, then final evaluation", async () => {
    expect(await gradePlan(plan("split", "fit", "select", "freeze", "evaluate"))).toMatchObject({ status: "evaluated", outcome: "correct" });
  });
  it("rejects selection on the final test even though the plan reaches the final goal", async () => {
    expect(await gradePlan(plan("split", "fit", "leak", "freeze", "evaluate"))).toMatchObject({ outcome: "incorrect", dimensions: [{ id: "invariants", status: "not_met" }] });
  });
  it("accepts a different executable plan using nested validation", async () => {
    expect(await gradePlan(plan("split", "nested", "freeze", "evaluate"))).toMatchObject({ outcome: "correct" });
  });
  it("reports cycles, unknown operators and missing dependencies before grading", async () => {
    const cyclic = plan("split", "fit");
    cyclic.steps[0]!.after = ["step2"];
    const missing = plan("split"); missing.steps[0]!.after = ["missing"];
    for (const response of [cyclic, missing, plan("unknown")]) {
      await expect(gradePlan(response)).rejects.toBeInstanceOf(ConstructionSubmissionError);
    }
  });
  it("accepts commuting unordered steps regardless of the submitted array order", async () => {
    const config: PlanConstructionConfig = { ...planConfig, operators: [...planConfig.operators,
      { id: "inspect", label: "Inspect validation coverage", requires: ["validation"], adds: ["coverage_checked"], removes: [], cost: 0 }], };
    const response = plan("split", "fit", "select", "freeze", "evaluate");
    response.steps.push({ id: "inspection", operatorId: "inspect", after: ["step1"] });
    expect(inspectPlan(config, response).issues).toEqual([]);
    expect(await gradePlan({ ...response, steps: [...response.steps].reverse() }, config)).toMatchObject({ outcome: "correct" });
  });
  it("does not allow array order to silently resolve a conflicting unordered pair", () => {
    const response = plan("split", "fit", "select");
    response.steps[2]!.after = ["step1"];
    expect(inspectPlan(planConfig, response).issues).toContainEqual(expect.objectContaining({ code: "invalid_structure" }));
  });
  it("grades a well-formed unmet precondition and overspent budget as incorrect", async () => {
    expect(await gradePlan(plan("fit", "select", "freeze", "evaluate"))).toMatchObject({ outcome: "incorrect" });
    expect(await gradePlan(plan("split", "fit", "select", "freeze", "evaluate"), { ...planConfig, budgetCost: 4 })).toMatchObject({ outcome: "incorrect", dimensions: [{ id: "budget", status: "not_met" }] });
  });
  it("rejects undeclared facts and impossible config budgets", () => {
    expect(PlanConstructionConfigSchema.safeParse({ ...planConfig, budgetCost: -1 }).success).toBe(false);
    expect(PlanConstructionConfigSchema.safeParse({ ...planConfig, operators: [{ ...planConfig.operators[0], requires: ["never_declared"] }] }).success).toBe(false);
  });
  it("bounds the dependency graph instead of accepting an unbounded edge table", () => {
    const response = plan(...Array.from({ length: 12 }, () => "fit"));
    response.steps = response.steps.map((step, index) => ({ ...step, after: response.steps.slice(0, index).map(({ id }) => id) }));
    expect(PlanConstructionResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe("artifact construction: run expressions and checked properties", () => {
  it("accepts the squared-error artifact", async () => {
    expect(await gradeArtifact(squared)).toMatchObject({ status: "evaluated", outcome: "correct" });
  });
  it("rejects absolute error on a private case with error magnitude two", async () => {
    expect(await gradeArtifact(absolute)).toMatchObject({ outcome: "incorrect" });
  });
  it("accepts the reversed subtraction squared", async () => {
    expect(await gradeArtifact(alternative)).toMatchObject({ outcome: "correct" });
  });
  it("rejects undeclared variables, unsupported nodes and excess depth without execution success", async () => {
    await expect(gradeArtifact(variable("secret"))).rejects.toBeInstanceOf(ConstructionSubmissionError);
    expect(ArtifactConstructionResponseSchema.safeParse({ ...artifactResponse(squared), expression: { op: "eval", source: "process.env" } }).success).toBe(false);
    let deep: Expr = constant(1); for (let index = 0; index < 8; index++) deep = { op: "abs", value: deep };
    expect(ArtifactConstructionResponseSchema.safeParse(artifactResponse(deep)).success).toBe(false);
    expect(await gradeArtifact({ op: "divide", left: constant(1), right: constant(0) })).toMatchObject({ outcome: "incorrect" });
  });
  it("actually checks the properties on additional inputs, not just case names", async () => {
    const reference = variable("y");
    const propertyData: ArtifactConstructionPrivate = { reference, cases: [{ id: "case", input: { y: 1, prediction: 0 } }],
      properties: [{ id: "nonnegative", kind: "nonnegative", input: { y: 3, prediction: 0 } }], tolerance };
    const foolsVisible = subtract(constant(2), variable("y"));
    expect(await gradeArtifact(foolsVisible, propertyData)).toMatchObject({ outcome: "incorrect", dimensions: [
      { id: "numeric_cases", status: "met" }, { id: "properties", status: "not_met" },
    ] });
  });
  it("treats a broken private oracle as unavailable", async () => {
    expect(await gradeArtifact(squared, { ...numericPrivate, reference: { op: "divide", left: constant(1), right: constant(0) } })).toMatchObject({ status: "unavailable", outcome: null });
  });
  it("Run returns only declared public inputs and computed outputs, with no acceptance claims", () => {
    expect(runConstructionActivity(task(artifactConfig), artifactResponse(squared))).toEqual({ kind: "case_results", cases: [{
      caseId: "public1", input: { y: 1, prediction: 0 }, output: 1, error: null,
    }] });
    expect(runConstructionActivity(task(artifactConfig), artifactResponse({ op: "divide", left: constant(1), right: constant(0) }))).toMatchObject({ cases: [{ output: null, error: "division_by_zero" }] });
  });
  it("requires unique public case IDs and exactly the declared inputs", () => {
    expect(ArtifactConstructionConfigSchema.safeParse({ ...artifactConfig, publicCases: [{ id: "bad", input: { y: 1, secret: 3 } }] }).success).toBe(false);
    expect(ArtifactConstructionConfigSchema.safeParse({ ...artifactConfig, publicCases: [publicCases[0], publicCases[0]] }).success).toBe(false);
  });
});

describe("diagnosis and repair: location, changed behavior and explanation", () => {
  it("accepts a root diagnosis and a squared-error repair", async () => {
    expect(await gradeRepair(repairResponse(squared))).toMatchObject({ outcome: "correct" });
  });
  it("rejects a cosmetic rewrite that still computes absolute error", async () => {
    expect(await gradeRepair(repairResponse({ op: "abs", value: reversed }))).toMatchObject({ outcome: "incorrect" });
  });
  it("accepts a different correct squared repair", async () => {
    expect(await gradeRepair(repairResponse(alternative))).toMatchObject({ outcome: "correct" });
  });
  it("rejects nonexistent pointers before grading and retains an unassessed explanation on rubric outage", async () => {
    await expect(gradeRepair(repairResponse(squared, ["/left"]))).rejects.toBeInstanceOf(ConstructionSubmissionError);
    const withRubric: DiagnosisRepairPrivate = { ...repairPrivate, explanationRubric: { id: "88888888-8888-4888-8888-888888888888",
      dimensions: [{ id: "cause", criterion: "Explain how absolute and squared errors differ.", met: "Explains the change in growth with error magnitude.", partial: "Mentions the change without its effect.", notMet: "Claims the two losses are equivalent." }] } };
    const response = repairResponse(squared);
    const original = structuredClone(response);
    expect(await gradeRepair(response, withRubric)).toMatchObject({ status: "unavailable", outcome: null });
    expect(response).toEqual(original);
  });
  it("accepts only canonical existing JSON Pointers and respects the empty root", () => {
    expect(resolveExpressionPointer(absolute, "").found).toBe(true);
    expect(resolveExpressionPointer(absolute, "/value").found).toBe(true);
    expect(resolveExpressionPointer(absolute, "/value/left/name")).toEqual({ found: true, value: "y" });
    for (const path of ["value", "/value/", "/value~2", "/constructor", "/value/__proto__"]) {
      expect(resolveExpressionPointer(absolute, path).found).toBe(false);
    }
  });
  it("does not accept correct behavior with a wrong diagnosis location", async () => {
    expect(await gradeRepair(repairResponse(squared, ["/value/left"]))).toMatchObject({ outcome: "incorrect", dimensions: [{ id: "diagnosis", status: "not_met" }] });
  });
  it("passes actual original material to a rubric and validates the returned evidence", async () => {
    const data: DiagnosisRepairPrivate = { ...repairPrivate, explanationRubric: { id: "88888888-8888-4888-8888-888888888888",
      dimensions: [{ id: "cause", criterion: "Explain the changed loss.", met: "Correct explanation.", partial: "Incomplete explanation.", notMet: "Incorrect explanation." }] } };
    const model: RubricJudge = { async judge(request) {
      expect(request.context?.material).toEqual(repairConfig);
      expect(request.context?.referenceFacts).toEqual({ reference: squared });
      return { dimensions: [{ id: "cause", status: "met", evidenceRefs: [{ responsePath: ["explanation"], span: null }], explanation: "The response identifies the linear versus squared growth." }], feedback: "The repair and explanation agree.", uncertainReasons: [] };
    } };
    expect(GradeDecisionSchema.parse(await gradeRepair(repairResponse(squared), data, { ...context, model }))).toMatchObject({ outcome: "correct" });
  });
  it("can Run an in-progress repair before writing its diagnosis", () => {
    const response = diagnosisRepairDescriptor.createInitialResponse(repairConfig);
    expect(runConstructionActivity(task(repairConfig), response)).toMatchObject({ cases: [{ output: 1 }] });
    expect(diagnosisRepairDescriptor.validateSubmission(repairConfig, response).length).toBeGreaterThan(0);
    expect(DiagnosisRepairConfigSchema.safeParse({ ...repairConfig, initialExpression: variable("secret") }).success).toBe(false);
  });
});

describe("adversarial testing: verify assertions before accepting a defect", () => {
  it("reproduces a defect for y=2 and prediction=0 with expected squared error 4", async () => {
    expect(await gradeTests(testsResponse(2, 0, 4))).toMatchObject({ outcome: "correct" });
  });
  it("rejects a valid test that does not distinguish the candidate", async () => {
    expect(await gradeTests(testsResponse(1, 0, 1))).toMatchObject({ outcome: "incorrect" });
  });
  it("accepts a different counterexample with y=4 and prediction=1", async () => {
    expect(await gradeTests(testsResponse(4, 1, 9))).toMatchObject({ outcome: "correct" });
  });
  it("rejects expected 999 as a false assertion, never as evidence of a candidate defect", async () => {
    expect(await gradeTests(testsResponse(2, 0, 999))).toMatchObject({ outcome: "incorrect", dimensions: [{ id: "test_assertions", status: "not_met" }] });
  });
  it("requires all assertions to be valid even when another case exposes a real defect", async () => {
    const response = testsResponse(2, 0, 4); response.cases.push({ input: { y: 3, prediction: 0 }, expected: 999 });
    expect(await gradeTests(response)).toMatchObject({ outcome: "incorrect" });
  });
  it("rejects off-grid cases and repeated test inputs before Attempt", async () => {
    await expect(gradeTests(testsResponse(2.5, 0, 6.25))).rejects.toBeInstanceOf(ConstructionSubmissionError);
    const response = testsResponse(2, 0, 4); response.cases.push(response.cases[0]!);
    expect(adversarialTestingDescriptor.validateSubmission(adversarialConfig, response)).toContainEqual(expect.objectContaining({ code: "duplicate" }));
  });
  it("Run returns the running candidate's output, not the learner assertion or private oracle", () => {
    expect(runConstructionActivity(task(adversarialConfig), testsResponse(2, 0, 999))).toEqual({ kind: "case_results", cases: [{ caseId: "case1", input: { y: 2, prediction: 0 }, output: 2, error: null }] });
  });
});

describe("constrained optimization: actual baseline, all constraints, immutable Run", () => {
  it("accepts x=4,y=0 after recomputing the baseline and current configuration", async () => {
    expect(await gradeOptimization(optimizationResponse(4, 0))).toMatchObject({ status: "evaluated", outcome: "correct" });
  });
  it("rejects a higher objective that violates cost and an unchanged baseline", async () => {
    expect(await gradeOptimization(optimizationResponse(4, 4))).toMatchObject({ outcome: "incorrect", dimensions: [{ id: "constraints", status: "not_met" }, { id: "improvement", status: "met" }] });
    expect(await gradeOptimization(optimizationResponse(0, 2))).toMatchObject({ outcome: "incorrect", dimensions: [{ id: "constraints", status: "met" }, { id: "improvement", status: "not_met" }] });
  });
  it("accepts the alternative x=2,y=1 that exactly meets the required improvement", async () => {
    expect(await gradeOptimization(optimizationResponse(2, 1))).toMatchObject({ outcome: "correct" });
  });
  it("rejects off-grid input as a form error and stale Run as unverified", async () => {
    const invalid = optimizationResponse(2.5, 0);
    expect(constrainedOptimizationDescriptor.validateSubmission(optimizationConfig, invalid)).toContainEqual(expect.objectContaining({ code: "out_of_bounds" }));
    const response = optimizationResponse(4, 0);
    expect(await gradeOptimization(response, await activityFor(response, { x: 2, y: 1 }))).toMatchObject({ status: "unavailable", outcome: null });
  });
  it("resolves a historical Run snapshot even though recording its receipt changes the response digest", async () => {
    const response = optimizationResponse(4, 0); const activity = await activityFor(response);
    expect(activity.input.responseDigest).not.toBe(activity.receiptInputs[0]!.responseDigest);
    expect(await gradeOptimization(response, activity)).toMatchObject({ outcome: "correct" });
  });
  it("requires a unique stored receipt input, matching session, task and successful run", async () => {
    const response = optimizationResponse(4, 0);
    for (const mutation of [
      (activity: AuthoritativeActivity) => { activity.receiptInputs = []; },
      (activity: AuthoritativeActivity) => { activity.receiptInputs = [...activity.receiptInputs, ...activity.receiptInputs]; },
      (activity: AuthoritativeActivity) => { activity.receipts = [...activity.receipts, ...activity.receipts]; },
      (activity: AuthoritativeActivity) => { activity.session.taskVersion = 2; },
      (activity: AuthoritativeActivity) => { activity.receipts[0]!.status = "unavailable"; activity.receipts[0]!.observation = null; },
      (activity: AuthoritativeActivity) => { activity.receipts[0]!.input.activitySessionId = crypto.randomUUID(); },
    ]) {
      const activity = await activityFor(response); mutation(activity);
      expect(await gradeOptimization(response, activity)).toMatchObject({ status: "unavailable", outcome: null });
    }
  });
  it("recomputes the model rather than trusting recorded output values", async () => {
    const response = optimizationResponse(0, 2); const activity = await activityFor(response);
    activity.receipts[0]!.observation = { kind: "values", values: [{ id: "benefit", quantity: { value: 999, unit: "unitless" } }] };
    expect(await gradeOptimization(response, activity)).toMatchObject({ outcome: "incorrect" });
  });
  it("uses the right improvement direction for a minimization objective", async () => {
    const config: ConstrainedOptimizationConfig = { ...optimizationConfig, baseline: { x: 4, y: 0 }, objective: { outputId: "cost", direction: "minimize", minimumImprovement: 2 }, constraints: [{ outputId: "benefit", operator: "gte", value: 6 }] };
    const response = optimizationResponse(2, 0);
    expect(await gradeOptimization(response, undefined, config)).toMatchObject({ outcome: "correct" });
  });
  it("rejects impossible output references and off-grid baselines in config", () => {
    expect(ConstrainedOptimizationConfigSchema.safeParse({ ...optimizationConfig, baseline: { x: 0.1, y: 2 } }).success).toBe(false);
    expect(ConstrainedOptimizationConfigSchema.safeParse({ ...optimizationConfig, objective: { ...optimizationConfig.objective, outputId: "missing" } }).success).toBe(false);
  });
});

describe("production boundaries and editable responses", () => {
  it("exports exactly five v2 descriptors with distinct actions and no fake sandbox capability", () => {
    expect(descriptors.map(({ id }) => id)).toEqual(["plan_construction", "artifact_construction", "diagnosis_repair", "adversarial_testing", "constrained_optimization"]);
    expect(descriptors.every(({ version, responseSchemaVersion }) => version === 2 && responseSchemaVersion === 2)).toBe(true);
    expect(descriptors.some(({ requirements }) => requirements.includes("sandbox"))).toBe(false);
  });
  it("accepts the empty editing state but rejects incomplete submission", () => {
    const checks = [
      [planConstructionDescriptor.responseSchema.safeParse(planConstructionDescriptor.createInitialResponse(planConfig)).success, planConstructionDescriptor.validateSubmission(planConfig, planConstructionDescriptor.createInitialResponse(planConfig))],
      [artifactConstructionDescriptor.responseSchema.safeParse(artifactConstructionDescriptor.createInitialResponse(artifactConfig)).success, artifactConstructionDescriptor.validateSubmission(artifactConfig, artifactConstructionDescriptor.createInitialResponse(artifactConfig))],
      [diagnosisRepairDescriptor.responseSchema.safeParse(diagnosisRepairDescriptor.createInitialResponse(repairConfig)).success, diagnosisRepairDescriptor.validateSubmission(repairConfig, diagnosisRepairDescriptor.createInitialResponse(repairConfig))],
      [adversarialTestingDescriptor.responseSchema.safeParse(adversarialTestingDescriptor.createInitialResponse(adversarialConfig)).success, adversarialTestingDescriptor.validateSubmission(adversarialConfig, adversarialTestingDescriptor.createInitialResponse(adversarialConfig))],
      [constrainedOptimizationDescriptor.responseSchema.safeParse(constrainedOptimizationDescriptor.createInitialResponse(optimizationConfig)).success, constrainedOptimizationDescriptor.validateSubmission(optimizationConfig, constrainedOptimizationDescriptor.createInitialResponse(optimizationConfig))],
    ] as const;
    for (const [parsed, issues] of checks) { expect(parsed).toBe(true); expect(issues.length).toBeGreaterThan(0); }
  });
  it("rejects private or foreign payload fields in public schemas", () => {
    expect(ArtifactConstructionConfigSchema.safeParse({ ...artifactConfig, reference: squared }).success).toBe(false);
    expect(ArtifactConstructionResponseSchema.safeParse({ ...artifactResponse(squared), correct: true }).success).toBe(false);
    expect(ArtifactConstructionResponseSchema.safeParse({ ...artifactResponse(squared), action: "repair" }).success).toBe(false);
  });
});
