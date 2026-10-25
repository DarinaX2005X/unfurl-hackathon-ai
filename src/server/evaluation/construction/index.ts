import "server-only";
import { z } from "zod";
import type { JsonValue } from "../../../domain/common";
import type { TaskPublic } from "../../../domain/mechanics";
import {
  ActionReceiptSchema, canonicalResponseJson,
  type PublicObservation,
} from "../../../domain/activity";
import {
  artifactConstructionDescriptor, adversarialTestingDescriptor, constrainedOptimizationDescriptor,
  diagnosisRepairDescriptor, exactInputIssues, inspectPlan, planConstructionDescriptor,
  resolveExpressionPointer,
  type ArtifactConstructionConfig, type ArtifactConstructionResponse,
  type AdversarialTestingConfig, type AdversarialTestingResponse,
  type ConstrainedOptimizationConfig, type ConstrainedOptimizationResponse,
  type DiagnosisRepairConfig, type DiagnosisRepairResponse,
  type PlanConstructionConfig, type PlanConstructionResponse,
} from "../../../domain/mechanic-families/v2/construction";
import {
  ExprSchema, FiniteValuesSchema, LocalIdSchema, MECHANIC_LIMITS, MechanicValueError,
  NumericToleranceSchema, evaluateBoundedModel, evaluateExpression, parseFamilyResponse,
  parseFamilyTask, validateExpression, withinTolerance,
  type Expr, type FamilyDescriptor, type SubmissionIssue,
} from "../../../domain/mechanic-families/v2/shared";
import {
  RubricRequestSchema, evaluateRubric, receiptInputFor, type AuthoritativeActivity,
  type EvaluatorRegistration, type GradeDecision,
} from "../contracts";

const uniqueFactsSchema = z.array(LocalIdSchema).max(MECHANIC_LIMITS.graphNodes)
  .refine((values) => new Set(values).size === values.length, "Facts must be unique");
export const PlanConstructionPrivateSchema = z.object({
  requiredFinalFacts: uniqueFactsSchema.min(1),
  invariants: z.array(z.object({ id: LocalIdSchema, forbidAll: uniqueFactsSchema.min(1) }).strict()).max(MECHANIC_LIMITS.graphNodes),
}).strict().superRefine((data, context) => {
  if (new Set(data.invariants.map(({ id }) => id)).size !== data.invariants.length) {
    context.addIssue({ code: "custom", path: ["invariants"], message: "Invariant identifiers must be unique" });
  }
});
export type PlanConstructionPrivate = z.infer<typeof PlanConstructionPrivateSchema>;

const numericCaseSchema = z.object({ id: LocalIdSchema, input: FiniteValuesSchema }).strict();
const numericPropertySchema = z.discriminatedUnion("kind", [
  z.object({ id: LocalIdSchema, kind: z.literal("nonnegative"), input: FiniteValuesSchema }).strict(),
  z.object({ id: LocalIdSchema, kind: z.literal("invariant"), input: FiniteValuesSchema, otherInput: FiniteValuesSchema }).strict(),
]);
const numericPrivateShape = {
  reference: ExprSchema,
  cases: z.array(numericCaseSchema).min(1).max(MECHANIC_LIMITS.steps),
  properties: z.array(numericPropertySchema).max(MECHANIC_LIMITS.steps),
  tolerance: NumericToleranceSchema,
};
export const ArtifactConstructionPrivateSchema = z.object(numericPrivateShape).strict().superRefine((data, context) => {
  const ids = [...data.cases, ...data.properties].map(({ id }) => id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Numeric check identifiers must be unique" });
});
export type ArtifactConstructionPrivate = z.infer<typeof ArtifactConstructionPrivateSchema>;
const rubricSchema = RubricRequestSchema.shape.rubric;
export const DiagnosisRepairPrivateSchema = z.object({
  ...numericPrivateShape,
  acceptedLocationSets: z.array(z.array(z.string().max(256)).min(1).max(MECHANIC_LIMITS.expressionNodes)).min(1).max(MECHANIC_LIMITS.steps),
  explanationRubric: rubricSchema.nullable(),
}).strict().superRefine((data, context) => {
  const ids = [...data.cases, ...data.properties].map(({ id }) => id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Numeric check identifiers must be unique" });
  data.acceptedLocationSets.forEach((locations, index) => {
    if (new Set(locations).size !== locations.length) context.addIssue({ code: "custom", path: ["acceptedLocationSets", index], message: "Locations must be unique" });
  });
  if (data.explanationRubric && (data.explanationRubric.dimensions.length > 21 ||
    data.explanationRubric.dimensions.some(({ id }) => ["numeric_cases", "properties", "diagnosis"].includes(id)))) {
    context.addIssue({ code: "custom", path: ["explanationRubric"], message: "Explanation criteria need distinct identifiers and room for the structural criteria" });
  }
});
export type DiagnosisRepairPrivate = z.infer<typeof DiagnosisRepairPrivateSchema>;
export const AdversarialTestingPrivateSchema = z.object({ oracle: ExprSchema, tolerance: NumericToleranceSchema }).strict();
export type AdversarialTestingPrivate = z.infer<typeof AdversarialTestingPrivateSchema>;
export const ConstrainedOptimizationPrivateSchema = z.object({ tolerance: NumericToleranceSchema }).strict();
export type ConstrainedOptimizationPrivate = z.infer<typeof ConstrainedOptimizationPrivateSchema>;

/** Service callers reject these issues before recording an Attempt. */
export class ConstructionSubmissionError extends Error {
  constructor(readonly issues: readonly SubmissionIssue[]) {
    super(issues[0]?.message ?? "The submission is incomplete.");
    this.name = "ConstructionSubmissionError";
  }
}

function parseSubmission<C extends JsonValue, R extends JsonValue>(descriptor: FamilyDescriptor<C, R>, task: TaskPublic<C>, response: R): { config: C; response: R } {
  const parsedTask = parseFamilyTask(descriptor, task);
  const parsedResponse = parseFamilyResponse(descriptor, response);
  const issues = descriptor.validateSubmission(parsedTask.config, parsedResponse);
  if (issues.length > 0) throw new ConstructionSubmissionError(issues);
  return { config: parsedTask.config, response: parsedResponse };
}

function decision(met: boolean, id: string, explanation: string): GradeDecision {
  return { status: "evaluated", outcome: met ? "correct" : "incorrect",
    dimensions: [{ id, status: met ? "met" : "not_met", explanation }],
    feedback: { explanation, nextAction: met ? "continue" : "revise" } };
}

function unavailable(explanation: string, id = "assessment"): GradeDecision {
  return { status: "unavailable", outcome: null, dimensions: [{ id, status: "uncertain", explanation }], feedback: { explanation, nextAction: "wait" } };
}

function assertReferenceVariables(reference: Expr, variables: string[]): void {
  if (validateExpression(reference, variables).length > 0) throw new Error("The private reference uses an undeclared variable");
}

function verifyInput(input: Record<string, number>, variables: string[]): void {
  if (exactInputIssues(input, variables).length > 0) throw new Error("A private numeric check must supply exactly the declared inputs");
}

function referenceValue(reference: Expr, input: Record<string, number>, variables: string[]): number {
  verifyInput(input, variables);
  return evaluateExpression(reference, input, variables);
}

function candidateValue(expression: Expr, input: Record<string, number>, variables: string[]): { ok: true; value: number } | { ok: false } {
  try { return { ok: true, value: evaluateExpression(expression, input, variables) }; }
  catch (error) {
    if (error instanceof MechanicValueError) return { ok: false };
    throw error;
  }
}

/** First verify the private check, then execute the learner artifact on every case/property. */
function checkNumericArtifact(expression: Expr, variables: string[], data: ArtifactConstructionPrivate): GradeDecision {
  assertReferenceVariables(data.reference, variables);
  const cases = data.cases.map((item) => ({ ...item, expected: referenceValue(data.reference, item.input, variables) }));
  for (const property of data.properties) {
    const reference = referenceValue(data.reference, property.input, variables);
    if (property.kind === "nonnegative" && reference < 0 && !withinTolerance(reference, 0, data.tolerance)) {
      throw new Error("The private reference does not satisfy a required property");
    }
    if (property.kind === "invariant" && !withinTolerance(reference, referenceValue(data.reference, property.otherInput, variables), data.tolerance)) {
      throw new Error("The private reference does not satisfy a required invariant");
    }
  }
  let casesMet = true;
  let propertiesMet = true;
  for (const item of cases) {
    const result = candidateValue(expression, item.input, variables);
    if (!result.ok || !withinTolerance(result.value, item.expected, data.tolerance)) casesMet = false;
  }
  for (const property of data.properties) {
    const result = candidateValue(expression, property.input, variables);
    if (!result.ok) { propertiesMet = false; continue; }
    if (property.kind === "nonnegative") {
      if (result.value < 0 && !withinTolerance(result.value, 0, data.tolerance)) propertiesMet = false;
    } else {
      const other = candidateValue(expression, property.otherInput, variables);
      if (!other.ok || !withinTolerance(result.value, other.value, data.tolerance)) propertiesMet = false;
    }
  }
  const met = casesMet && propertiesMet;
  const explanation = met ? "The expression satisfies the checked numeric cases and properties." :
    !casesMet ? "The expression does not produce the required result for every checked case. Compare its operation with the specification." :
      "The expression matches the checked values but violates a required property. Revisit how the result should change across inputs.";
  return { status: "evaluated", outcome: met ? "correct" : "incorrect",
    dimensions: [
      { id: "numeric_cases", status: casesMet ? "met" : "not_met", explanation: casesMet ? "All checked numeric cases meet the specification." : "At least one checked case gives a different or nonfinite result." },
      ...(data.properties.length > 0 ? [{ id: "properties", status: propertiesMet ? "met" as const : "not_met" as const,
        explanation: propertiesMet ? "The checked properties hold." : "A checked property does not hold." }] : []),
    ], feedback: { explanation, nextAction: met ? "continue" : "revise" } };
}

export const planConstructionEvaluator: EvaluatorRegistration<PlanConstructionConfig, PlanConstructionResponse, PlanConstructionPrivate> = {
  id: "plan_construction", version: 2, privateSchema: PlanConstructionPrivateSchema,
  async evaluate(input, context) {
    context.signal.throwIfAborted();
    const { config, response } = parseSubmission(planConstructionDescriptor, input.task, input.response);
    const data = PlanConstructionPrivateSchema.parse(input.privateData);
    const vocabulary = new Set([...config.initialFacts, ...config.operators.flatMap(({ adds }) => adds)]);
    if ([...data.requiredFinalFacts, ...data.invariants.flatMap(({ forbidAll }) => forbidAll)].some((fact) => !vocabulary.has(fact))) {
      return unavailable("The plan criteria need review before this answer can be assessed.");
    }
    const { order } = inspectPlan(config, response);
    const byId = new Map(response.steps.map((step) => [step.id, step]));
    const operators = new Map(config.operators.map((operator) => [operator.id, operator]));
    const facts = new Set(config.initialFacts);
    const invariantBroken = () => data.invariants.some(({ forbidAll }) => forbidAll.every((fact) => facts.has(fact)));
    if (invariantBroken()) return unavailable("The starting state conflicts with the plan constraints. Your plan is retained.");
    let cost = 0;
    for (const id of order) {
      const operator = operators.get(byId.get(id)!.operatorId!)!;
      if (operator.requires.some((fact) => !facts.has(fact))) return decision(false, "executable_plan", `Step ${id} starts before its required facts are available.`);
      cost += operator.cost;
      if (!Number.isFinite(cost) || cost > config.budgetCost) return decision(false, "budget", "The plan exceeds the allowed total cost.");
      operator.removes.forEach((fact) => facts.delete(fact));
      operator.adds.forEach((fact) => facts.add(fact));
      if (invariantBroken()) return decision(false, "invariants", `Step ${id} creates a state forbidden by the task constraints.`);
    }
    if (data.requiredFinalFacts.some((fact) => !facts.has(fact))) return decision(false, "goal", "The plan can run, but its final state does not satisfy the whole goal.");
    return decision(true, "executable_plan", "The plan reaches the required final state while preserving the constraints and budgets.");
  },
};

export const artifactConstructionEvaluator: EvaluatorRegistration<ArtifactConstructionConfig, ArtifactConstructionResponse, ArtifactConstructionPrivate> = {
  id: "artifact_construction", version: 2, privateSchema: ArtifactConstructionPrivateSchema,
  async evaluate(input, context) {
    context.signal.throwIfAborted();
    const { config, response } = parseSubmission(artifactConstructionDescriptor, input.task, input.response);
    const data = ArtifactConstructionPrivateSchema.parse(input.privateData);
    try { return checkNumericArtifact(response.expression!, config.variables.map(({ id }) => id), data); }
    catch { return unavailable("The numeric reference checks could not be verified. Your expression is retained for another assessment."); }
  },
};

export const diagnosisRepairEvaluator: EvaluatorRegistration<DiagnosisRepairConfig, DiagnosisRepairResponse, DiagnosisRepairPrivate> = {
  id: "diagnosis_repair", version: 2, privateSchema: DiagnosisRepairPrivateSchema,
  async evaluate(input, context) {
    context.signal.throwIfAborted();
    const { config, response } = parseSubmission(diagnosisRepairDescriptor, input.task, input.response);
    const data = DiagnosisRepairPrivateSchema.parse(input.privateData);
    if (data.acceptedLocationSets.some((locations) => locations.some((path) => !resolveExpressionPointer(config.initialExpression, path).found))) {
      return unavailable("The repair locations need review before this answer can be assessed.");
    }
    const localized = data.acceptedLocationSets.some((locations) => locations.length === response.locationPaths.length && locations.every((path) => response.locationPaths.includes(path)));
    if (!localized) return decision(false, "diagnosis", "The selected locations do not identify the defect targeted by this task. Revisit the original expression.");
    let numeric: GradeDecision;
    try { numeric = checkNumericArtifact(response.replacement!, config.variables.map(({ id }) => id), data); }
    catch { return unavailable("The reference repair checks could not be verified. Your repair and explanation are retained."); }
    if (numeric.status !== "evaluated" || numeric.outcome !== "correct" || data.explanationRubric === null) return numeric;
    const explanation = await evaluateRubric({ rubric: data.explanationRubric, response,
      allowedResponsePaths: [["explanation"], ["locationPaths"], ["replacement"]],
      context: { instruction: input.task.instruction, material: config, referenceFacts: { reference: data.reference } },
    }, context);
    // Behavioral success cannot replace a missing or uncertain explanation assessment.
    return { ...explanation, dimensions: [...numeric.dimensions, { id: "diagnosis", status: "met", explanation: "The diagnosis identifies an accepted defect location." }, ...explanation.dimensions] };
  },
};

export const adversarialTestingEvaluator: EvaluatorRegistration<AdversarialTestingConfig, AdversarialTestingResponse, AdversarialTestingPrivate> = {
  id: "adversarial_testing", version: 2, privateSchema: AdversarialTestingPrivateSchema,
  async evaluate(input, context) {
    context.signal.throwIfAborted();
    const { config, response } = parseSubmission(adversarialTestingDescriptor, input.task, input.response);
    const data = AdversarialTestingPrivateSchema.parse(input.privateData);
    const names = config.variables.map(({ id }) => id);
    let expected: number[];
    try {
      assertReferenceVariables(data.oracle, names);
      expected = response.cases.map((item) => referenceValue(data.oracle, item.input, names));
    } catch { return unavailable("The reference result could not be verified for these inputs. Your tests are retained."); }
    // Verify every assertion before running the candidate. A fabricated expected value is not a defect.
    if (response.cases.some((item, index) => !withinTolerance(item.expected!, expected[index]!, data.tolerance))) {
      return decision(false, "test_assertions", "At least one expected result disagrees with the specification. Correct the test assertion before using it as evidence of a defect.");
    }
    const exposed = response.cases.some((item, index) => {
      const result = candidateValue(config.candidate, item.input, names);
      return !result.ok || !withinTolerance(result.value, expected[index]!, data.tolerance);
    });
    return decision(exposed, "reproduced_defect", exposed ? "A test with a valid expected result reproduces a real defect in the candidate." :
      "These test assertions are valid, but the candidate produces the required result for all of them. Find an input that distinguishes its behavior.");
  },
};

function verifiedOptimizationRun(
  activity: AuthoritativeActivity | null, task: TaskPublic<ConstrainedOptimizationConfig>, response: ConstrainedOptimizationResponse,
): boolean {
  if (activity === null || activity.session.taskId !== task.id || activity.session.taskVersion !== task.taskVersion) return false;
  const receipt = activity.receipts.find(({ id }) => id === response.observationReceiptId);
  if (!receipt || !ActionReceiptSchema.safeParse(receipt).success || receipt.status !== "completed" || receipt.observation?.kind !== "values") return false;
  if (receipt.input.activitySessionId !== activity.session.id || receipt.input.inputRevision > activity.session.inputRevision) return false;
  const event = activity.session.events.find((event) => event.receipt.id === receipt.id);
  if (!event || event.action.kind !== "run" || canonicalResponseJson(event.receipt) !== canonicalResponseJson(receipt)) return false;
  try {
    const submitted = activity.input;
    if (submitted.activitySessionId !== activity.session.id || submitted.inputRevision !== activity.session.inputRevision ||
        canonicalResponseJson(submitted.response) !== canonicalResponseJson(response)) return false;
    const stored = receiptInputFor(activity, receipt.id);
    if (!stored) return false;
    const runResponse = parseFamilyResponse(constrainedOptimizationDescriptor, stored.response);
    return canonicalResponseJson(runResponse.configuration) === canonicalResponseJson(response.configuration);
  } catch { return false; }
}

export const constrainedOptimizationEvaluator: EvaluatorRegistration<ConstrainedOptimizationConfig, ConstrainedOptimizationResponse, ConstrainedOptimizationPrivate> = {
  id: "constrained_optimization", version: 2, privateSchema: ConstrainedOptimizationPrivateSchema,
  async evaluate(input, context) {
    context.signal.throwIfAborted();
    const { config, response } = parseSubmission(constrainedOptimizationDescriptor, input.task, input.response);
    const data = ConstrainedOptimizationPrivateSchema.parse(input.privateData);
    if (!verifiedOptimizationRun(input.activity, input.task, response)) {
      return unavailable("Run the current configuration before submitting. The available observation belongs to different or unverified work.", "current_run");
    }
    let result: ReturnType<typeof evaluateBoundedModel>;
    let baseline: ReturnType<typeof evaluateBoundedModel>;
    try { result = evaluateBoundedModel(config.model, response.configuration); baseline = evaluateBoundedModel(config.model, config.baseline); }
    catch { return decision(false, "finite_model", "This configuration does not produce a finite result for every model output."); }
    const values = new Map(result.map(({ id, quantity }) => [id, quantity.value]));
    const original = new Map(baseline.map(({ id, quantity }) => [id, quantity.value]));
    const constraintsMet = config.constraints.every(({ outputId, operator, value }) => {
      const actual = values.get(outputId)!;
      return operator === "lte" ? actual <= value : actual >= value;
    });
    const before = original.get(config.objective.outputId)!;
    const after = values.get(config.objective.outputId)!;
    const improvement = config.objective.direction === "maximize" ? after - before : before - after;
    const objectiveMet = Number.isFinite(improvement) && (improvement >= config.objective.minimumImprovement ||
      withinTolerance(improvement, config.objective.minimumImprovement, data.tolerance));
    const met = constraintsMet && objectiveMet;
    return { status: "evaluated", outcome: met ? "correct" : "incorrect",
      dimensions: [
        { id: "constraints", status: constraintsMet ? "met" : "not_met", explanation: constraintsMet ? "Every stated output constraint is satisfied." : "The configuration violates at least one stated output constraint." },
        { id: "improvement", status: objectiveMet ? "met" : "not_met", explanation: objectiveMet ? "The objective improves enough over the computed baseline." : "The objective does not improve enough over the computed baseline." },
      ], feedback: { explanation: met ? "This configuration meets every constraint and the required improvement over the baseline." :
        !constraintsMet ? "The objective value cannot compensate for a violated constraint. Adjust the configuration and run it again." :
          "The configuration respects the constraints but needs a larger improvement over the baseline.", nextAction: met ? "continue" : "revise" } };
  },
};

function publicCaseResult(id: string, expression: Expr, input: Record<string, number>, names: string[]): Extract<PublicObservation, { kind: "case_results" }>["cases"][number] {
  try { return { caseId: id, input, output: evaluateExpression(expression, input, names), error: null }; }
  catch (error) {
    return { caseId: id, input, output: null, error: error instanceof MechanicValueError && error.code === "division_by_zero" ? "division_by_zero" :
      error instanceof MechanicValueError && error.code === "nonfinite_result" ? "nonfinite_result" : "invalid_input" };
  }
}

/** Activity service adapter: computes public observations only, with no grading, receipts, Attempts or XP. */
export function runConstructionActivity(task: TaskPublic, response: JsonValue): PublicObservation {
  if (task.mechanicId === "artifact_construction") {
    const parsedTask = parseFamilyTask(artifactConstructionDescriptor, task);
    const parsedResponse = parseFamilyResponse(artifactConstructionDescriptor, response);
    const issues = artifactConstructionDescriptor.validateSubmission(parsedTask.config, parsedResponse);
    if (issues.length > 0) throw new ConstructionSubmissionError(issues);
    return { kind: "case_results", cases: parsedTask.config.publicCases.map(({ id, input }) => publicCaseResult(id, parsedResponse.expression!, input, parsedTask.config.variables.map(({ id }) => id))) };
  }
  if (task.mechanicId === "diagnosis_repair") {
    const parsedTask = parseFamilyTask(diagnosisRepairDescriptor, task);
    const parsedResponse = parseFamilyResponse(diagnosisRepairDescriptor, response);
    // Running a draft repair does not require a finished diagnosis or explanation.
    if (parsedResponse.replacement === null) throw new ConstructionSubmissionError([{ path: ["replacement"], code: "required", message: "Build a replacement expression before running." }]);
    const issues = validateExpression(parsedResponse.replacement, parsedTask.config.variables.map(({ id }) => id));
    if (issues.length > 0) throw new ConstructionSubmissionError(issues);
    return { kind: "case_results", cases: parsedTask.config.publicCases.map(({ id, input }) => publicCaseResult(id, parsedResponse.replacement!, input, parsedTask.config.variables.map(({ id }) => id))) };
  }
  if (task.mechanicId === "adversarial_testing") {
    const parsedTask = parseFamilyTask(adversarialTestingDescriptor, task);
    const parsedResponse = parseFamilyResponse(adversarialTestingDescriptor, response);
    const issues = adversarialTestingDescriptor.validateSubmission(parsedTask.config, parsedResponse).filter((issue) => issue.path[0] !== "failureExplanation");
    if (issues.length > 0) throw new ConstructionSubmissionError(issues);
    return { kind: "case_results", cases: parsedResponse.cases.map(({ input }, index) => publicCaseResult(`case${index + 1}`, parsedTask.config.candidate, input, parsedTask.config.variables.map(({ id }) => id))) };
  }
  if (task.mechanicId === "constrained_optimization") {
    const parsedTask = parseFamilyTask(constrainedOptimizationDescriptor, task);
    const parsedResponse = parseFamilyResponse(constrainedOptimizationDescriptor, response);
    const issues = constrainedOptimizationDescriptor.validateSubmission(parsedTask.config, parsedResponse).filter((issue) => issue.path[0] !== "observationReceiptId");
    if (issues.length > 0) throw new ConstructionSubmissionError(issues);
    return { kind: "values", values: evaluateBoundedModel(parsedTask.config.model, parsedResponse.configuration) };
  }
  throw new ConstructionSubmissionError([{ path: ["kind"], code: "invalid_reference", message: "This task does not support Run." }]);
}

export const evaluators = [planConstructionEvaluator, artifactConstructionEvaluator, diagnosisRepairEvaluator,
  adversarialTestingEvaluator, constrainedOptimizationEvaluator] as const;
