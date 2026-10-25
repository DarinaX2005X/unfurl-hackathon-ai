import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  ConfusableDiscriminationConfigSchema, CounterexampleConstructionConfigSchema, ExampleConstructionConfigSchema,
  ProcedureReconstructionConfigSchema, RecallReconstructionConfigSchema, RelationalMappingConfigSchema,
  RepresentationTranslationConfigSchema, RuleInductionConfigSchema,
  confusableDiscriminationDescriptor, counterexampleConstructionDescriptor, descriptors, exampleConstructionDescriptor,
  normalizeAffineExpression, procedureReconstructionDescriptor, recallReconstructionDescriptor, relationalMappingDescriptor,
  representationTranslationDescriptor,
} from "@/domain/mechanic-families/v2/foundations";
import {
  FoundationsSubmissionError, ProcedureReconstructionPrivateSchema, CounterexampleConstructionPrivateSchema,
  confusableDiscriminationEvaluator, counterexampleConstructionEvaluator, evaluators, exampleConstructionEvaluator,
  procedureReconstructionEvaluator, recallReconstructionEvaluator, relationalMappingEvaluator, representationTranslationEvaluator,
  ruleInductionEvaluator, validateConfusableDiscriminationPrivate, validateCounterexampleClaim,
  validateCounterexampleConstructionPrivate, validateProcedureReconstructionPrivate, validateRelationalMappingPrivate,
} from "@/server/evaluation/foundations";
import { GradeDecisionSchema, type EvaluationContext, type RubricRequest } from "@/server/evaluation/contracts";
import { construction, counterexample, counterexamplePrivate, distinction, distinctionPrivate, induction, mapping,
  procedure, procedurePrivate, recall, rubric, task, tolerance, translation, validEdges, validOrder } from "./fixtures";

const context: EvaluationContext = { model: null, signal: new AbortController().signal };
// An explicit boundary stub verifies request/evidence flow, not live model or educational accuracy.
function rubricContext(status: "met" | "not_met" | "uncertain"): EvaluationContext {
  return { ...context, model: { judge: vi.fn(async (request: RubricRequest) => ({
    dimensions: request.rubric.dimensions.map((dimension) => ({ id: dimension.id, status,
      evidenceRefs: status === "uncertain" ? [] : [{ responsePath: request.allowedResponsePaths[0], span: null }],
      explanation: "Fixture assessment of the submitted concept." })),
    feedback: "Fixture feedback tied to the submitted answer.", uncertainReasons: status === "uncertain" ? ["valid_alternative"] : [],
  })) } };
}
const recallPrivate = { rubric: rubric("accuracy", "Accuracy is correct predictions divided by all evaluated predictions. One minus classification error rate is equivalent.") };
const gradeRecall = (text: string, supplied = rubricContext("met")) => recallReconstructionEvaluator.evaluate({
  task: task(recall), response: { kind: "recall_reconstruction", action: "recall", text }, privateData: recallPrivate, activity: null,
}, supplied);

describe("recall reconstruction acceptance", () => {
  it("sends the correct accuracy concept and public cue to semantic assessment", async () => {
    const supplied = rubricContext("met");
    expect(await gradeRecall("Accuracy is correct predictions divided by evaluated predictions.", supplied)).toMatchObject({ outcome: "correct" });
    expect(supplied.model!.judge).toHaveBeenCalledWith(expect.objectContaining({ context: { instruction: "Complete this learning task.", material: recall },
      allowedResponsePaths: [["text"]] }), expect.any(AbortSignal));
  });
  it("preserves the rubric's rejection of a plausible wrong numerator", async () => {
    expect(await gradeRecall("Positive labels divided by evaluated predictions.", rubricContext("not_met"))).toMatchObject({ outcome: "incorrect" });
  });
  it("accepts a semantic alternative through the same rubric boundary", async () => {
    expect(await gradeRecall("One minus classification error rate.")).toMatchObject({ outcome: "correct" });
  });
  it("returns unavailable without a judge and preserves the original answer", async () => {
    const text = "One minus classification error rate.";
    expect(await gradeRecall(text, context)).toMatchObject({ status: "unavailable", outcome: null });
    expect(recallReconstructionDescriptor.responseSchema.parse({ kind: "recall_reconstruction", action: "recall", text }).text).toBe(text);
  });
});

const distinguish = (caseId: string, start: number, end: number) => ({ kind: "confusable_discrimination" as const, action: "distinguish" as const,
  caseId, evidenceSpans: [{ blockId: caseId, start, end }], distinction: "Fitting computes statistics from X_all, which includes held-out validation rows. Transforming with already fitted statistics does not learn them." });
const gradeDistinction = (response: ReturnType<typeof distinguish>) => confusableDiscriminationEvaluator.evaluate({
  task: task(distinction), response, privateData: distinctionPrivate, activity: null,
}, rubricContext("met"));
describe("confusable discrimination acceptance", () => {
  it("accepts the fit case with its whole call as evidence and an essential distinction", async () => {
    expect(await gradeDistinction(distinguish("fit", 0, 17))).toMatchObject({ outcome: "correct" });
  });
  it("rejects merely transforming held-out values as the fitting error", async () => {
    expect(await gradeDistinction(distinguish("transform", 0, 30))).toMatchObject({ outcome: "incorrect" });
  });
  it("accepts the narrower X_all token as equivalent evidence", async () => {
    expect(await gradeDistinction(distinguish("fit", 11, 16))).toMatchObject({ outcome: "correct" });
  });
  it("reports an out-of-range span before an Attempt can be graded", async () => {
    const response = distinguish("fit", 0, 500);
    expect(confusableDiscriminationDescriptor.validateSubmission(distinction, response)).toContainEqual(expect.objectContaining({ path: ["evidenceSpans", 0] }));
    await expect(gradeDistinction(response)).rejects.toBeInstanceOf(FoundationsSubmissionError);
  });
});

const inductionResponse = () => ({ kind: "rule_induction" as const, action: "infer_rule" as const,
  rule: { form: "coefficients" as const, slope: 2, intercept: 1 }, probeValues: [7] });
describe("rule induction acceptance", () => {
  it("checks the inferred slope, intercept, and new probe", async () => {
    expect(await ruleInductionEvaluator.evaluate({ task: task(induction), response: inductionResponse(), privateData: { tolerance }, activity: null }, context)).toMatchObject({ outcome: "correct" });
  });
  it("rejects a correct rule with an incorrect prediction on the new input", async () => {
    expect(await ruleInductionEvaluator.evaluate({ task: task(induction), response: { ...inductionResponse(), probeValues: [6] }, privateData: { tolerance }, activity: null }, context)).toMatchObject({ outcome: "incorrect" });
  });
  it("normalizes the equivalent expression 1 + 2*x", async () => {
    const response = { ...inductionResponse(), rule: { form: "expression" as const, expression: { op: "add" as const,
      left: { op: "constant" as const, value: 1 }, right: { op: "multiply" as const, left: { op: "constant" as const, value: 2 }, right: { op: "variable" as const, name: "x" } } } } };
    expect(await ruleInductionEvaluator.evaluate({ task: task(induction), response, privateData: { tolerance }, activity: null }, context)).toMatchObject({ outcome: "correct" });
  });
  it("rejects unidentifiable and inconsistent visible examples at materialization", () => {
    expect(RuleInductionConfigSchema.safeParse({ ...induction, pairs: [[0, 1], [0, 1]] }).success).toBe(false);
    expect(RuleInductionConfigSchema.safeParse({ ...induction, pairs: [[0, 1], [1, 3], [2, 6]] }).success).toBe(false);
    expect(RuleInductionConfigSchema.safeParse({ ...induction, pairs: [[0, 1], [1, 3], [2, 5 + 1e-10]] }).success).toBe(false);
    expect(RuleInductionConfigSchema.safeParse({ ...induction, pairs: [[0, 0.1], [1, 0.2], [2, 0.3]] }).success).toBe(true);
  });
});

const construct = (tp: number, fp: number, tn: number, fn: number) => ({ kind: "example_construction" as const, action: "construct_example" as const, matrix: { tp, fp, tn, fn } });
const gradeConstruction = (response: ReturnType<typeof construct>) => exampleConstructionEvaluator.evaluate({ task: task(construction), response, privateData: { kind: "confusion_matrix_constraints" }, activity: null }, context);
describe("example construction acceptance", () => {
  it("accepts a matrix satisfying every stated property", async () => { expect(await gradeConstruction(construct(3, 0, 5, 2))).toMatchObject({ outcome: "correct" }); });
  it("rejects a plausible matrix with a false positive", async () => { expect(await gradeConstruction(construct(3, 1, 4, 2))).toMatchObject({ outcome: "incorrect" }); });
  it("accepts a different matrix with the same required properties", async () => { expect(await gradeConstruction(construct(4, 0, 5, 1))).toMatchObject({ outcome: "correct" }); });
  it("treats negative or noninteger cells as form errors", async () => {
    for (const response of [construct(-1, 0, 9, 2), construct(3.5, 0, 4.5, 2)]) {
      expect(exampleConstructionDescriptor.validateSubmission(construction, response).length).toBeGreaterThan(0);
      await expect(gradeConstruction(response)).rejects.toBeInstanceOf(FoundationsSubmissionError);
    }
  });
});

const refute = (constant: number, trainY: number, validationY: number) => ({ kind: "counterexample_construction" as const,
  action: "refute" as const, model: { constant }, train: [{ x: 0, y: trainY }], validation: [{ x: 1, y: validationY }] });
const gradeCounterexample = (response: ReturnType<typeof refute>) => counterexampleConstructionEvaluator.evaluate({ task: task(counterexample), response,
  privateData: counterexamplePrivate, activity: null }, context);
describe("counterexample construction acceptance", () => {
  it("executes a constant predictor whose training premise holds and validation conclusion fails", async () => { expect(await gradeCounterexample(refute(0, 0, 1))).toMatchObject({ outcome: "correct" }); });
  it("rejects a case that also fits validation and therefore refutes nothing", async () => { expect(await gradeCounterexample(refute(0, 0, 0))).toMatchObject({ outcome: "incorrect" }); });
  it("accepts a different constant and different counterexample", async () => { expect(await gradeCounterexample(refute(1, 1, 0))).toMatchObject({ outcome: "correct" }); });
  it("rejects an empty validation set or a row present in both sets as a form error", async () => {
    for (const validation of [[], [{ x: 0, y: 0 }]]) {
      const response = { ...refute(0, 0, 1), validation };
      expect(counterexampleConstructionDescriptor.validateSubmission(counterexample, response).length).toBeGreaterThan(0);
      await expect(gradeCounterexample(response)).rejects.toBeInstanceOf(FoundationsSubmissionError);
    }
  });
});

const order = (stepIds: string[]) => ({ kind: "procedure_reconstruction" as const, action: "order_steps" as const, stepIds });
const gradeOrder = (stepIds: string[]) => procedureReconstructionEvaluator.evaluate({ task: task(procedure), response: order(stepIds), privateData: procedurePrivate, activity: null }, context);
describe("procedure reconstruction acceptance", () => {
  it("accepts an ordering with every prerequisite in place", async () => { expect(await gradeOrder(validOrder)).toMatchObject({ outcome: "correct" }); });
  it("rejects fitting the scaler before splitting", async () => { expect(await gradeOrder(["fit_scaler", "split", ...validOrder.slice(2)])).toMatchObject({ outcome: "incorrect" }); });
  it("accepts moving validation transformation before training transformation", async () => {
    expect(await gradeOrder(["split", "fit_scaler", "transform_validation", "transform_train", "fit_model", "predict", "score"])).toMatchObject({ outcome: "correct" });
  });
  it("reports missing or duplicate steps as field errors", async () => {
    for (const ids of [validOrder.slice(1), ["split", "split", ...validOrder.slice(2)]]) {
      expect(procedureReconstructionDescriptor.validateSubmission(procedure, order(ids)).length).toBeGreaterThan(0);
      await expect(gradeOrder(ids)).rejects.toBeInstanceOf(FoundationsSubmissionError);
    }
  });
});

const map = (edges: typeof validEdges) => ({ kind: "relational_mapping" as const, action: "map_relations" as const, edges });
const gradeMap = (edges: typeof validEdges) => relationalMappingEvaluator.evaluate({ task: task(mapping), response: map(edges), privateData: { acceptedGraphs: [validEdges] }, activity: null }, context);
describe("relational mapping acceptance", () => {
  it("accepts the gradient, loss, parameters, and optimizer relationships", async () => { expect(await gradeMap(validEdges)).toMatchObject({ outcome: "correct" }); });
  it("rejects reversing gradient_of", async () => { expect(await gradeMap([{ from: "loss", relation: "gradient_of", to: "gradient" }, ...validEdges.slice(1)])).toMatchObject({ outcome: "incorrect" }); });
  it("accepts reordered edges and the declared weights alias", async () => {
    expect(await gradeMap([...validEdges].reverse().map((edge) => ({ ...edge, to: edge.to === "parameters" ? "weights" : edge.to })))).toMatchObject({ outcome: "correct" });
  });
  it("rejects undeclared endpoints, aliases, and relation types as form errors", async () => {
    for (const edge of [{ from: "gradient", relation: "gradient_of", to: "unknown" }, { from: "gradient", relation: "is", to: "loss" }]) {
      expect(relationalMappingDescriptor.validateSubmission(mapping, map([edge])).length).toBeGreaterThan(0);
      await expect(gradeMap([edge])).rejects.toBeInstanceOf(FoundationsSubmissionError);
    }
  });
});

const translate = (value: number, unit: "ratio" | "percent" | "byte") => ({ kind: "representation_translation" as const, action: "translate_representation" as const, quantity: { value, unit } });
const gradeTranslation = (response: ReturnType<typeof translate>) => representationTranslationEvaluator.evaluate({ task: task(translation), response, privateData: { tolerance }, activity: null }, context);
describe("representation translation acceptance", () => {
  it("calculates precision from the actual matrix counts", async () => { expect(await gradeTranslation(translate(2 / 3, "ratio"))).toMatchObject({ outcome: "correct" }); });
  it("rejects accuracy supplied as precision", async () => { expect(await gradeTranslation(translate(6 / 8, "ratio"))).toMatchObject({ outcome: "incorrect" }); });
  it("accepts an equivalent percentage within private tolerance", async () => { expect(await gradeTranslation(translate(66.66666667, "percent"))).toMatchObject({ outcome: "correct" }); });
  it("rejects incompatible units as form errors and zero denominators at materialization", async () => {
    expect(representationTranslationDescriptor.validateSubmission(translation, translate(2 / 3, "byte"))).toContainEqual(expect.objectContaining({ code: "incompatible_unit" }));
    await expect(gradeTranslation(translate(2 / 3, "byte"))).rejects.toBeInstanceOf(FoundationsSubmissionError);
    expect(RepresentationTranslationConfigSchema.safeParse({ ...translation, from: { ...translation.from, tp: 0, fp: 0 } }).success).toBe(false);
  });
});

describe("foundation contract defenses", () => {
  it("exposes eight v2 registrations and accepts every initial editing response", () => {
    const configs = [recall, distinction, induction, construction, counterexample, procedure, mapping, translation];
    expect(evaluators.map((entry) => entry.id)).toEqual(descriptors.map((entry) => entry.id));
    descriptors.forEach((entry, index) => {
      expect(entry).toMatchObject({ version: 2, responseSchemaVersion: 2, actions: [] });
      // The tuples are aligned intentionally; each public schema validates its own initial response.
      const initial = (entry.createInitialResponse as (config: typeof configs[number]) => unknown)(configs[index]!);
      expect(entry.responseSchema.safeParse(initial).success).toBe(true);
      expect(entry.responseSchema.safeParse({ ...(initial as object), awardedXp: 10 }).success).toBe(false);
    });
  });
  it("rejects unknown config fields and impossible example constraints", () => {
    const schemas = [RecallReconstructionConfigSchema, ConfusableDiscriminationConfigSchema, RuleInductionConfigSchema, ExampleConstructionConfigSchema,
      CounterexampleConstructionConfigSchema, ProcedureReconstructionConfigSchema, RelationalMappingConfigSchema, RepresentationTranslationConfigSchema];
    const configs = [recall, distinction, induction, construction, counterexample, procedure, mapping, translation];
    schemas.forEach((schema, index) => expect(schema.safeParse({ ...configs[index], expectedAnswer: "private" }).success).toBe(false));
    expect(ExampleConstructionConfigSchema.safeParse({ ...construction, constraints: { total: 1, falsePositive: 0, minTruePositive: 1, minFalseNegative: 1 } }).success).toBe(false);
  });
  it("does not admit nonlinear expressions that happen to fit visible points", () => {
    const x = { op: "variable" as const, name: "x" };
    expect(() => normalizeAffineExpression({ op: "multiply", left: x, right: x })).toThrow();
    expect(() => normalizeAffineExpression({ op: "divide", left: { op: "constant", value: 1 }, right: x })).toThrow();
    expect(() => normalizeAffineExpression({ op: "abs", value: x })).toThrow();
    expect(normalizeAffineExpression({ op: "divide", left: { op: "add", left: x, right: { op: "constant", value: 3 } }, right: { op: "constant", value: 2 } })).toEqual({ slope: 0.5, intercept: 1.5 });
  });
  it("checks private DAGs, evidence references, and accepted graphs before use", () => {
    expect(ProcedureReconstructionPrivateSchema.safeParse({ prerequisites: [{ before: "a", after: "b" }, { before: "b", after: "a" }] }).success).toBe(false);
    expect(() => validateProcedureReconstructionPrivate(procedure, { prerequisites: [{ before: "missing", after: "split" }] })).toThrow();
    expect(() => validateConfusableDiscriminationPrivate(distinction, { ...distinctionPrivate, acceptedEvidence: [{ caseId: "fit", requiredSpans: [{ blockId: "fit", start: 11, end: 100 }] }] })).toThrow();
    expect(() => validateRelationalMappingPrivate(mapping, { acceptedGraphs: [[{ from: "missing", relation: "updates", to: "parameters" }]] })).toThrow();
  });
  it("requires semantic claim review and binds its actual text without requiring English wording", async () => {
    const translated = { ...counterexample, claim: "Нулевая ошибка на обучающей выборке гарантирует нулевую ошибку на проверочной выборке." };
    expect(await validateCounterexampleClaim(translated, context)).toMatchObject({ status: "unavailable", outcome: null });
    const supplied = rubricContext("met");
    expect(await validateCounterexampleClaim(translated, supplied)).toMatchObject({ outcome: "correct" });
    expect(validateCounterexampleConstructionPrivate(translated, { ...counterexamplePrivate, reviewedClaim: translated.claim }).reviewedClaim).toBe(translated.claim);
    expect(() => validateCounterexampleConstructionPrivate(translated, counterexamplePrivate)).toThrow();
    expect(CounterexampleConstructionPrivateSchema.safeParse({ ...counterexamplePrivate, predicate: "arbitrary_theorem" }).success).toBe(false);
  });
  it("preserves uncertainty from semantic review instead of turning it into an incorrect answer", async () => {
    const result = await gradeRecall("Accuracy for this dataset means a weighted score.", rubricContext("uncertain"));
    expect(result).toMatchObject({ status: "uncertain", outcome: null });
    expect(GradeDecisionSchema.safeParse(result).success).toBe(true);
    expect(result).not.toHaveProperty("awardedXp");
  });
  it("rejects a version mismatch instead of dispatching v2 as the frozen sample", async () => {
    await expect(ruleInductionEvaluator.evaluate({ task: { ...task(induction), mechanicVersion: 1 }, response: inductionResponse(), privateData: { tolerance }, activity: null }, context)).rejects.toThrow();
  });
});
