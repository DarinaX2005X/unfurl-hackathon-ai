import type { JsonObject, JsonValue } from "@/domain/common";
import type { TaskPublic, TaskPrivateCandidate, MechanicId } from "@/domain/mechanics";
import type { AuthoritativeActivity, EvaluationContext } from "@/server/evaluation/contracts";
import { JsonObjectSchema } from "@/domain/common";
import { RubricRequestSchema } from "@/server/evaluation/contracts";
import { traceState } from "@/domain/mechanic-families/v2/investigation";
import { evaluateBoundedModel } from "@/domain/mechanic-families/v2/shared";
import * as F from "../mechanics/foundations/fixtures";
import * as I from "../mechanics/investigation/fixtures";
import * as C from "../mechanics/communication/fixtures";

export const approvalDigest = "a".repeat(64);
export const tolerance = F.tolerance;
export const rubric = I.rubric;
export const runtime = {
  model: { modelId: "moonshotai/kimi-k2.6" as const, available: true },
  activity: { durable: true, supportedActions: ["run", "prediction.commit", "experiment.query", "intervention.apply", "dialogue.turn"] as Array<"run" | "prediction.commit" | "experiment.query" | "intervention.apply" | "dialogue.turn">, dialogue: true },
  sandbox: { available: false, profiles: [] as string[] }, budget: { available: true },
};
/** Wiring double only. Semantic correctness is neither measured nor asserted by these fixtures. */
export const modelContext: () => EvaluationContext = () => I.context();
export type FamilyCase = { task: TaskPublic; privateData: JsonObject; response: JsonValue; activity: AuthoritativeActivity | null };
export type RegistryFixture = { id: MechanicId; dimensions: string[]; make(): FamilyCase | Promise<FamilyCase> };
function simple(config: JsonObject & { kind: MechanicId }, privateData: JsonObject, response: JsonValue): FamilyCase {
  return { task: F.task(config), privateData, response, activity: null };
}
export function authored(input: Pick<FamilyCase, "task" | "privateData">, dimensions: string[]): { task: TaskPublic; privateTask: TaskPrivateCandidate } {
  const data = input.privateData;
  const actualRubric = data.rubric ?? data.basisRubric ?? data.explanationRubric;
  const rubricData = actualRubric == null ? null : RubricRequestSchema.shape.rubric.parse(actualRubric);
  return { task: structuredClone(input.task), privateTask: {
    taskId: input.task.id, taskVersion: input.task.taskVersion, evaluatorData: structuredClone(data),
    evaluationSpec: rubricData ? { kind: "rubric", rubricId: rubricData.id, requiredDimensions: rubricData.dimensions.map((dimension) => dimension.id), calibrationSetId: null } :
      { kind: "deterministic", evaluatorId: input.task.mechanicId, evaluatorVersion: 2, secretConfig: null },
    assessment: { evidenceGroupId: "c7f7e9e6-5f98-4d02-9425-d58091c26541", role: "required", outcomes: input.task.outcomeIds.map((outcomeId) => ({
      outcomeId, dimensions: [{ dimensionId: "canonical_learning_criterion", evaluationDimensionIds: [...dimensions] }],
    })) },
    sourceClaimIds: [], hints: Array.from({ length: input.task.availableHints }, () => "Use the supplied evidence and keep its limits in view."), workedExample: null,
  } };
}

const constant = I.constant, variable = I.variable, add = I.add;
export const numericConfig = {
  kind: "artifact_construction" as const, artifactType: "numeric_expression" as const,
  variables: [{ id: "x", text: "Input value" }], specification: "Return x plus one.", maxNodes: 5,
  publicCases: [{ id: "public", input: { x: 0 } }],
};
export const numericPrivate = {
  reference: add(variable("x"), constant(1)), cases: [{ id: "zero", input: { x: 0 } }, { id: "positive", input: { x: 2 } }],
  properties: [], tolerance,
};
export const planConfig = {
  kind: "plan_construction" as const, goal: "Reach a finished state without retaining raw material.",
  initialFacts: ["raw"], budgetSteps: 3, budgetCost: 3,
  operators: [{ id: "finish", label: "Finish the material", requires: ["raw"], adds: ["finished"], removes: ["raw"], cost: 1 }],
};
export const planPrivate = { requiredFinalFacts: ["finished"], invariants: [{ id: "exclusive", forbidAll: ["raw", "finished"] }] };
export const optimizationConfig = {
  kind: "constrained_optimization" as const, model: { inputs: [{ id: "x", min: 0, max: 4, step: 1, unit: "unitless" as const }],
    outputs: [{ id: "gain", unit: "unitless" as const, expression: variable("x") }] }, baseline: { x: 0 },
  objective: { outputId: "gain", direction: "maximize" as const, minimumImprovement: 2 },
  constraints: [{ outputId: "gain", operator: "lte" as const, value: 3 }],
};
export const repairConfig = { kind: "diagnosis_repair" as const, artifactType: "numeric_expression" as const,
  variables: numericConfig.variables, specification: numericConfig.specification,
  initialExpression: variable("x"), publicCases: numericConfig.publicCases };
export const repairPrivate = { ...numericPrivate, acceptedLocationSets: [[""]], explanationRubric: null };
export const repairResponse = { kind: "diagnosis_repair", action: "repair", locationPaths: [""], replacement: numericPrivate.reference,
  explanation: "The original expression omits the added constant one." };
export const adversarialConfig = { kind: "adversarial_testing" as const, candidate: variable("x"), specification: "Return x plus one.",
  variables: [{ id: "x", min: 0, max: 2, step: 1, unit: "unitless" as const }], maxCases: 3 };

export const registryFixtures: RegistryFixture[] = [
  { id: "recall_reconstruction", dimensions: ["accuracy"], make: () => simple(F.recall, { rubric: F.rubric("accuracy", "State the proportion classified correctly.") },
    { kind: "recall_reconstruction", action: "recall", text: "Accuracy is the fraction of evaluated examples classified correctly." }) },
  { id: "confusable_discrimination", dimensions: ["selected_case", "evidence_passage", "essential_distinction"], make: () => simple(F.distinction, F.distinctionPrivate,
    { kind: "confusable_discrimination", action: "distinguish", caseId: "fit", evidenceSpans: [{ blockId: "fit", start: 11, end: 16 }], distinction: "Fitting computes statistics from X_all, which contains validation rows." }) },
  { id: "rule_induction", dimensions: ["slope", "intercept", "new_inputs"], make: () => simple(F.induction, { tolerance },
    { kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: 2, intercept: 1 }, probeValues: [7] }) },
  { id: "example_construction", dimensions: ["total", "false_positives", "true_positives", "false_negatives"], make: () => simple(F.construction, { kind: "confusion_matrix_constraints" },
    { kind: "example_construction", action: "construct_example", matrix: { tp: 2, fp: 0, tn: 6, fn: 2 } }) },
  { id: "counterexample_construction", dimensions: ["antecedent", "refutation"], make: () => simple(F.counterexample, F.counterexamplePrivate,
    { kind: "counterexample_construction", action: "refute", model: { constant: 0 }, train: [{ x: 0, y: 0 }], validation: [{ x: 1, y: 1 }] }) },
  { id: "procedure_reconstruction", dimensions: ["dependencies"], make: () => simple(F.procedure, F.procedurePrivate,
    { kind: "procedure_reconstruction", action: "order_steps", stepIds: F.validOrder }) },
  { id: "relational_mapping", dimensions: ["directed_relations"], make: () => simple(F.mapping, { acceptedGraphs: [F.validEdges] },
    { kind: "relational_mapping", action: "map_relations", edges: F.validEdges }) },
  { id: "representation_translation", dimensions: ["metric_value"], make: () => simple(F.translation, { tolerance },
    { kind: "representation_translation", action: "translate_representation", quantity: { value: 2 / 3, unit: "ratio" } }) },
  { id: "state_tracing", dimensions: ["step.1", "step.2"], make: () => simple(I.tracing, { tolerance },
    { kind: "state_tracing", action: "trace", states: traceState(I.tracing) }) },
  { id: "outcome_prediction", dimensions: ["prediction"], make: I.predictionCase },
  { id: "cause_diagnosis", dimensions: ["scope"], make: () => simple(I.diagnosis, { consistentCauseIds: ["covariate", "conditional"], rubric },
    { kind: "cause_diagnosis", action: "diagnose", conclusion: "unidentified", consistentCauseIds: ["covariate", "conditional"], neededEvidence: "Compare target feature distributions and conditional outcomes to distinguish these causes." }) },
  { id: "experimental_investigation", dimensions: ["identification", "reasoning.scope"], make: I.experimentCase },
  { id: "causal_intervention", dimensions: ["target"], make: I.interventionCase },
  { id: "estimation", dimensions: ["quantity", "reasoning.scope"], make: () => simple(I.estimation,
    { referenceQuantity: { value: 4_000_000, unit: "byte" }, tolerance, basisRubric: rubric },
    { kind: "estimation", action: "estimate", lower: 3.9, upper: 4.1, unit: "MB", basis: "One million parameters times four bytes is four million bytes, or four decimal MB." }) },
  { id: "strategy_selection", dimensions: ["scope"], make: () => simple(I.strategy, { admissibleStrategyIds: ["holdout", "nested"], targetSpecified: true, rubric },
    { kind: "strategy_selection", action: "select_strategy", strategyId: "holdout", assumptions: ["Future deployment concerns new organizations."], justification: "Hold out both organizations and later observations to represent that target." }) },
  { id: "source_investigation", dimensions: ["scope"], make: () => simple(I.source, { sources: I.source.sources, rubric },
    { kind: "source_investigation", action: "investigate_sources", verdict: "not_supported", citations: [{ sourceId: "synthetic", passageId: "scope", span: null }], explanation: "The passage addresses fitting leakage, and gives no guarantee about a new organization." }) },
  { id: "plan_construction", dimensions: ["executable_plan"], make: () => simple(planConfig, planPrivate,
    { kind: "plan_construction", action: "build_plan", steps: [{ id: "first", operatorId: "finish", after: [] }] }) },
  { id: "artifact_construction", dimensions: ["numeric_cases"], make: () => simple(numericConfig, numericPrivate,
    { kind: "artifact_construction", action: "build_artifact", expression: numericPrivate.reference }) },
  { id: "diagnosis_repair", dimensions: ["numeric_cases"], make: () => simple(repairConfig, repairPrivate, repairResponse) },
  { id: "adversarial_testing", dimensions: ["reproduced_defect"], make: () => simple(adversarialConfig, { oracle: numericPrivate.reference, tolerance },
    { kind: "adversarial_testing", action: "design_tests", cases: [{ input: { x: 0 }, expected: 1 }], failureExplanation: "The candidate returns zero but the specification requires one." }) },
  { id: "constrained_optimization", dimensions: ["constraints", "improvement"], make: async () => {
    const receiptId = crypto.randomUUID(), response = { kind: "constrained_optimization", action: "optimize", configuration: { x: 2 }, observationReceiptId: receiptId };
    const result = simple(optimizationConfig, { tolerance }, response);
    result.activity = await I.activity(result.task, response, [{ id: receiptId, action: { kind: "run" }, response: { ...response, observationReceiptId: null },
      observation: { kind: "values", values: evaluateBoundedModel(optimizationConfig.model, response.configuration) } }]);
    return result;
  } },
];

for (const family of [C.analogy, C.explanation, C.argument, C.critique, C.tutoring, C.information, C.role, C.mediation]) {
  registryFixtures.push({ id: family.descriptor.id, dimensions: family.privateData.rubric.dimensions.map((dimension) => dimension.id), make: async () => {
    const candidate = family.cases[0]!, task = C.taskFor<JsonObject>({ descriptor: family.descriptor, config: JsonObjectSchema.parse(family.config) }), response = candidate.response;
    let activity: AuthoritativeActivity | null = null;
    if (candidate.turns) {
      activity = await I.activity(task, response, candidate.turns.map((turn, index) => ({
        id: index === 0 ? C.ids.turn : C.ids.secondTurn, action: { kind: "dialogue.turn", text: turn.question },
        response: { ...JsonObjectSchema.parse(response), dialogueDraft: turn.question },
        observation: { kind: "dialogue", text: turn.reply, revealedFacts: turn.facts },
      })));
      activity.revealedFactIds = candidate.turns.flatMap((turn) => turn.facts.map((fact) => fact.id));
    }
    return { task, response, privateData: JsonObjectSchema.parse(family.privateData), activity };
  } });
}
