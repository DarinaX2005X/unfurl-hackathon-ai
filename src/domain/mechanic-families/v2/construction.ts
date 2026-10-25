import { z } from "zod";
import { IdSchema } from "../../common";
import {
  BlockSchema, BoundedModelSchema, BoundedVariableSchema, ExprSchema, FiniteNumberSchema,
  FiniteValuesSchema, LocalIdSchema, MECHANIC_LIMITS, NonemptyTextSchema, TextSchema,
  evaluateBoundedModel, validateExpression, type Expr, type FamilyDescriptor, type SubmissionIssue,
} from "./shared";

const factsSchema = z.array(LocalIdSchema).max(MECHANIC_LIMITS.graphNodes).superRefine((facts, context) => {
  if (new Set(facts).size !== facts.length) context.addIssue({ code: "custom", message: "Facts must be unique" });
});
const variablesSchema = z.array(BlockSchema).max(MECHANIC_LIMITS.variables).superRefine((variables, context) => {
  if (new Set(variables.map(({ id }) => id)).size !== variables.length) {
    context.addIssue({ code: "custom", message: "Variable identifiers must be unique" });
  }
});
const publicCaseSchema = z.object({ id: LocalIdSchema, input: FiniteValuesSchema }).strict();
const publicCasesSchema = z.array(publicCaseSchema).min(1).max(MECHANIC_LIMITS.actions)
  .superRefine((cases, context) => {
    if (new Set(cases.map(({ id }) => id)).size !== cases.length) {
      context.addIssue({ code: "custom", message: "Public case identifiers must be unique" });
    }
    if (cases.reduce((count, item) => count + Object.keys(item.input).length, 0) > MECHANIC_LIMITS.tableCells) {
      context.addIssue({ code: "custom", message: "Public inputs exceed the table cell limit" });
    }
  });

function refineExpression(expression: Expr, variables: readonly string[], context: z.RefinementCtx, path: Array<string | number>): void {
  for (const issue of validateExpression(expression, variables)) {
    context.addIssue({ code: "custom", path: [...path, ...issue.path], message: issue.message });
  }
}

export function exactInputIssues(input: Record<string, number>, variables: readonly string[], path: Array<string | number> = []): SubmissionIssue[] {
  const issues: SubmissionIssue[] = [];
  for (const name of variables) if (!Object.hasOwn(input, name)) {
    issues.push({ path: [...path, name], code: "required", message: `Enter a value for ${name}.` });
  }
  for (const name of Object.keys(input)) if (!variables.includes(name)) {
    issues.push({ path: [...path, name], code: "invalid_reference", message: `The task does not declare ${name}.` });
  }
  return issues;
}

function refinePublicCases(cases: Array<{ id: string; input: Record<string, number> }>, variables: string[], context: z.RefinementCtx): void {
  cases.forEach((item, index) => {
    for (const issue of exactInputIssues(item.input, variables, ["publicCases", index, "input"])) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
}

export const PlanConstructionConfigSchema = z.object({
  kind: z.literal("plan_construction"),
  goal: NonemptyTextSchema,
  initialFacts: factsSchema,
  operators: z.array(z.object({
    id: LocalIdSchema, label: NonemptyTextSchema, requires: factsSchema, adds: factsSchema,
    removes: factsSchema, cost: FiniteNumberSchema.nonnegative(),
  }).strict()).min(1).max(MECHANIC_LIMITS.steps),
  budgetSteps: z.number().int().min(1).max(MECHANIC_LIMITS.steps),
  budgetCost: FiniteNumberSchema.nonnegative(),
}).strict().superRefine((config, context) => {
  if (new Set(config.operators.map(({ id }) => id)).size !== config.operators.length) {
    context.addIssue({ code: "custom", path: ["operators"], message: "Operator identifiers must be unique" });
  }
  const vocabulary = new Set([...config.initialFacts, ...config.operators.flatMap(({ adds }) => adds)]);
  if (vocabulary.size > MECHANIC_LIMITS.graphNodes) {
    context.addIssue({ code: "custom", path: ["operators"], message: "The fact vocabulary is too large" });
  }
  config.operators.forEach((operator, index) => {
    for (const field of ["requires", "removes"] as const) {
      operator[field].forEach((fact, factIndex) => {
        if (!vocabulary.has(fact)) context.addIssue({ code: "custom", path: ["operators", index, field, factIndex], message: "A fact must be declared by the initial state or an added effect" });
      });
    }
    if (operator.adds.some((fact) => operator.removes.includes(fact))) {
      context.addIssue({ code: "custom", path: ["operators", index], message: "An operator cannot add and remove the same fact" });
    }
  });
  if (!config.operators.some(({ cost }) => cost <= config.budgetCost)) {
    context.addIssue({ code: "custom", path: ["budgetCost"], message: "The budget must permit at least one operator" });
  }
});
export type PlanConstructionConfig = z.infer<typeof PlanConstructionConfigSchema>;

export const PlanConstructionResponseSchema = z.object({
  kind: z.literal("plan_construction"), action: z.literal("build_plan"),
  steps: z.array(z.object({
    id: LocalIdSchema, operatorId: LocalIdSchema.nullable(),
    after: z.array(LocalIdSchema).max(MECHANIC_LIMITS.steps),
  }).strict()).max(MECHANIC_LIMITS.steps),
}).strict().superRefine((response, context) => {
  if (response.steps.reduce((count, step) => count + step.after.length, 0) > MECHANIC_LIMITS.graphEdges) {
    context.addIssue({ code: "custom", path: ["steps"], message: "The plan has too many dependency edges" });
  }
});
export type PlanConstructionResponse = z.infer<typeof PlanConstructionResponseSchema>;

/** The returned order is only used after checking every unordered pair for conflicts. */
export function inspectPlan(config: PlanConstructionConfig, response: PlanConstructionResponse): {
  issues: SubmissionIssue[]; order: string[];
} {
  const issues: SubmissionIssue[] = [];
  const steps = response.steps;
  if (steps.length === 0) issues.push({ path: ["steps"], code: "required", message: "Add at least one step to your plan." });
  if (steps.length > config.budgetSteps) issues.push({ path: ["steps"], code: "out_of_bounds", message: `Use no more than ${config.budgetSteps} steps.` });
  if (steps.reduce((count, step) => count + step.after.length, 0) > MECHANIC_LIMITS.graphEdges) {
    issues.push({ path: ["steps"], code: "out_of_bounds", message: `Use no more than ${MECHANIC_LIMITS.graphEdges} prerequisite links.` });
  }
  const ids = new Set(steps.map(({ id }) => id));
  if (ids.size !== steps.length) issues.push({ path: ["steps"], code: "duplicate", message: "Each step needs a unique identifier." });
  const operators = new Map(config.operators.map((operator) => [operator.id, operator]));
  steps.forEach((step, index) => {
    if (step.operatorId === null) issues.push({ path: ["steps", index, "operatorId"], code: "required", message: "Choose an operation for this step." });
    else if (!operators.has(step.operatorId)) issues.push({ path: ["steps", index, "operatorId"], code: "invalid_reference", message: "Choose an operation provided by this task." });
    if (new Set(step.after).size !== step.after.length) issues.push({ path: ["steps", index, "after"], code: "duplicate", message: "List each prerequisite once." });
    for (const dependency of step.after) {
      if (!ids.has(dependency) || dependency === step.id) issues.push({ path: ["steps", index, "after"], code: "invalid_reference", message: "A prerequisite must be another step in this plan." });
    }
  });
  if (issues.length > 0) return { issues, order: [] };
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.after)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].find(([, dependencies]) => dependencies.size === 0)?.[0];
    if (ready === undefined) {
      issues.push({ path: ["steps"], code: "invalid_structure", message: "Remove the circular dependency so every step can start." });
      return { issues, order: [] };
    }
    order.push(ready);
    remaining.delete(ready);
    remaining.forEach((dependencies) => dependencies.delete(ready));
  }
  const ancestors = new Map<string, Set<string>>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const id of order) {
    const predecessors = new Set<string>();
    for (const dependency of byId.get(id)!.after) {
      predecessors.add(dependency);
      for (const ancestor of ancestors.get(dependency)!) predecessors.add(ancestor);
    }
    ancestors.set(id, predecessors);
  }
  for (let leftIndex = 0; leftIndex < steps.length; leftIndex++) {
    const left = steps[leftIndex]!;
    const leftOperator = operators.get(left.operatorId!)!;
    for (let rightIndex = leftIndex + 1; rightIndex < steps.length; rightIndex++) {
      const right = steps[rightIndex]!;
      if (ancestors.get(left.id)!.has(right.id) || ancestors.get(right.id)!.has(left.id)) continue;
      const rightOperator = operators.get(right.operatorId!)!;
      const leftWrites = [...leftOperator.adds, ...leftOperator.removes];
      const rightWrites = [...rightOperator.adds, ...rightOperator.removes];
      const conflict = leftWrites.some((fact) => [...rightWrites, ...rightOperator.requires].includes(fact)) ||
        rightWrites.some((fact) => leftOperator.requires.includes(fact));
      if (conflict) issues.push({ path: ["steps", rightIndex, "after"], code: "invalid_structure", message: `Order ${left.id} and ${right.id} explicitly because they use or change the same facts.` });
    }
  }
  return { issues, order };
}

export const ArtifactConstructionConfigSchema = z.object({
  kind: z.literal("artifact_construction"), artifactType: z.literal("numeric_expression"),
  variables: variablesSchema, specification: NonemptyTextSchema,
  maxNodes: z.number().int().min(1).max(MECHANIC_LIMITS.expressionNodes),
  publicCases: publicCasesSchema,
}).strict().superRefine((config, context) => refinePublicCases(config.publicCases, config.variables.map(({ id }) => id), context));
export type ArtifactConstructionConfig = z.infer<typeof ArtifactConstructionConfigSchema>;
export const ArtifactConstructionResponseSchema = z.object({
  kind: z.literal("artifact_construction"), action: z.literal("build_artifact"), expression: ExprSchema.nullable(),
}).strict();
export type ArtifactConstructionResponse = z.infer<typeof ArtifactConstructionResponseSchema>;

/** Node occurrences count independently, even when an in-memory caller shares a subtree. */
export function expressionNodeCount(expression: Expr): number {
  return 1 + (expression.op === "abs" ? expressionNodeCount(expression.value) :
    "left" in expression ? expressionNodeCount(expression.left) + expressionNodeCount(expression.right) : 0);
}

export const DiagnosisRepairConfigSchema = z.object({
  kind: z.literal("diagnosis_repair"), artifactType: z.literal("numeric_expression"),
  initialExpression: ExprSchema, variables: variablesSchema, specification: NonemptyTextSchema,
  publicCases: publicCasesSchema,
}).strict().superRefine((config, context) => {
  const names = config.variables.map(({ id }) => id);
  refineExpression(config.initialExpression, names, context, ["initialExpression"]);
  refinePublicCases(config.publicCases, names, context);
});
export type DiagnosisRepairConfig = z.infer<typeof DiagnosisRepairConfigSchema>;
export const DiagnosisRepairResponseSchema = z.object({
  kind: z.literal("diagnosis_repair"), action: z.literal("repair"),
  locationPaths: z.array(z.string().max(256)).max(MECHANIC_LIMITS.expressionNodes),
  replacement: ExprSchema.nullable(), explanation: TextSchema,
}).strict();
export type DiagnosisRepairResponse = z.infer<typeof DiagnosisRepairResponseSchema>;

/** Canonical JSON Pointer, including the empty root. It never follows inherited properties. */
export function resolveExpressionPointer(expression: Expr, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: expression };
  if (!pointer.startsWith("/")) return { found: false };
  const encoded = pointer.slice(1).split("/");
  if (encoded.some((segment) => /~(?:[^01]|$)/.test(segment))) return { found: false };
  const segments = encoded.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const canonical = `/${segments.map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
  if (canonical !== pointer) return { found: false };
  let value: unknown = expression;
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ["__proto__", "prototype", "constructor"].includes(segment) || !Object.hasOwn(value, segment)) return { found: false };
    value = (value as Record<string, unknown>)[segment];
  }
  return { found: true, value };
}

export function expressionLocations(expression: Expr, root = ""): Array<{ path: string; expression: Expr }> {
  const locations = [{ path: root, expression }];
  if (expression.op === "abs") locations.push(...expressionLocations(expression.value, `${root}/value`));
  if ("left" in expression) {
    locations.push(...expressionLocations(expression.left, `${root}/left`));
    locations.push(...expressionLocations(expression.right, `${root}/right`));
  }
  return locations;
}

export const AdversarialTestingConfigSchema = z.object({
  kind: z.literal("adversarial_testing"), candidate: ExprSchema,
  variables: z.array(BoundedVariableSchema).max(MECHANIC_LIMITS.variables),
  specification: NonemptyTextSchema, maxCases: z.number().int().min(1).max(MECHANIC_LIMITS.actions),
}).strict().superRefine((config, context) => {
  const names = config.variables.map(({ id }) => id);
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["variables"], message: "Variable identifiers must be unique" });
  if (config.maxCases * (config.variables.length + 1) > MECHANIC_LIMITS.tableCells) {
    context.addIssue({ code: "custom", path: ["maxCases"], message: "Test inputs and expected values must fit within the table cell limit" });
  }
  refineExpression(config.candidate, names, context, ["candidate"]);
});
export type AdversarialTestingConfig = z.infer<typeof AdversarialTestingConfigSchema>;
export const AdversarialTestingResponseSchema = z.object({
  kind: z.literal("adversarial_testing"), action: z.literal("design_tests"),
  cases: z.array(z.object({ input: FiniteValuesSchema, expected: FiniteNumberSchema.nullable() }).strict()).max(MECHANIC_LIMITS.actions),
  failureExplanation: TextSchema,
}).strict();
export type AdversarialTestingResponse = z.infer<typeof AdversarialTestingResponseSchema>;

export function boundedInputIssues(
  variables: z.infer<typeof BoundedVariableSchema>[], input: Record<string, number>, path: Array<string | number> = [],
): SubmissionIssue[] {
  const issues = exactInputIssues(input, variables.map(({ id }) => id), path);
  for (const variable of variables) {
    const value = input[variable.id];
    if (value === undefined) continue;
    const step = (value - variable.min) / variable.step;
    if (!Number.isFinite(value) || value < variable.min || value > variable.max || !Number.isFinite(step) || Math.abs(step - Math.round(step)) > 1e-9) {
      issues.push({ path: [...path, variable.id], code: "out_of_bounds", message: `Use a value from ${variable.min} to ${variable.max} in steps of ${variable.step}.` });
    }
  }
  return issues;
}

export const ConstrainedOptimizationConfigSchema = z.object({
  kind: z.literal("constrained_optimization"), model: BoundedModelSchema, baseline: FiniteValuesSchema,
  objective: z.object({ outputId: LocalIdSchema, direction: z.enum(["minimize", "maximize"]), minimumImprovement: FiniteNumberSchema.positive() }).strict(),
  constraints: z.array(z.object({ outputId: LocalIdSchema, operator: z.enum(["lte", "gte"]), value: FiniteNumberSchema }).strict()).max(MECHANIC_LIMITS.variables),
}).strict().superRefine((config, context) => {
  const outputIds = new Set(config.model.outputs.map(({ id }) => id));
  if (!outputIds.has(config.objective.outputId)) context.addIssue({ code: "custom", path: ["objective", "outputId"], message: "The objective must name a model output" });
  config.constraints.forEach((constraint, index) => {
    if (!outputIds.has(constraint.outputId)) context.addIssue({ code: "custom", path: ["constraints", index, "outputId"], message: "The constraint must name a model output" });
  });
  const constraints = config.constraints.map(({ outputId, operator }) => `${outputId}:${operator}`);
  if (new Set(constraints).size !== constraints.length) context.addIssue({ code: "custom", path: ["constraints"], message: "Each output bound must occur once" });
  try { evaluateBoundedModel(config.model, config.baseline); }
  catch { context.addIssue({ code: "custom", path: ["baseline"], message: "The baseline must be a finite, valid model configuration" }); }
  for (const lower of config.constraints.filter(({ operator }) => operator === "gte")) {
    const upper = config.constraints.find((constraint) => constraint.outputId === lower.outputId && constraint.operator === "lte");
    if (upper && lower.value > upper.value) context.addIssue({ code: "custom", path: ["constraints"], message: "Lower and upper bounds conflict" });
  }
});
export type ConstrainedOptimizationConfig = z.infer<typeof ConstrainedOptimizationConfigSchema>;
export const ConstrainedOptimizationResponseSchema = z.object({
  kind: z.literal("constrained_optimization"), action: z.literal("optimize"),
  configuration: FiniteValuesSchema, observationReceiptId: IdSchema.nullable(),
}).strict();
export type ConstrainedOptimizationResponse = z.infer<typeof ConstrainedOptimizationResponseSchema>;

function expressionIssues(expression: Expr | null, names: string[], path: string): SubmissionIssue[] {
  if (expression === null) return [{ path: [path], code: "required", message: "Build an expression before submitting." }];
  return validateExpression(expression, names).map((issue) => ({ ...issue, path: [path, ...issue.path] }));
}

export const planConstructionDescriptor: FamilyDescriptor<PlanConstructionConfig, PlanConstructionResponse> = {
  id: "plan_construction", version: 2, responseSchemaVersion: 2,
  configSchema: PlanConstructionConfigSchema, responseSchema: PlanConstructionResponseSchema,
  requiredAffordances: ["dependency_editor", "operator_effects", "keyboard_step_controls"],
  supportedEvaluators: ["deterministic"], rendererKey: "construction.plan.v2",
  accessibility: { keyboardEquivalent: true, nonVisualSummary: true }, actions: [], requirements: [],
  limitations: ["Finite propositional operators and explicit budgets only.", "Unordered steps require commuting read and write sets."],
  createInitialResponse: () => ({ kind: "plan_construction", action: "build_plan", steps: [] }),
  validateSubmission: (config, response) => inspectPlan(config, response).issues,
};
export const artifactConstructionDescriptor: FamilyDescriptor<ArtifactConstructionConfig, ArtifactConstructionResponse> = {
  id: "artifact_construction", version: 2, responseSchemaVersion: 2,
  configSchema: ArtifactConstructionConfigSchema, responseSchema: ArtifactConstructionResponseSchema,
  requiredAffordances: ["expression_builder", "public_case_results", "run_submit_distinction"],
  supportedEvaluators: ["deterministic"], rendererKey: "construction.artifact.v2",
  accessibility: { keyboardEquivalent: true, nonVisualSummary: true }, actions: ["run"], requirements: ["activity"],
  limitations: ["Bounded numeric expressions only; this variant does not execute Python or arbitrary programs.", "Private numeric cases establish behavior on those cases, not general symbolic equivalence."],
  createInitialResponse: () => ({ kind: "artifact_construction", action: "build_artifact", expression: null }),
  validateSubmission: (config, response) => {
    const issues = expressionIssues(response.expression, config.variables.map(({ id }) => id), "expression");
    if (issues.length === 0 && response.expression && expressionNodeCount(response.expression) > config.maxNodes) {
      issues.push({ path: ["expression"], code: "out_of_bounds", message: `Use no more than ${config.maxNodes} expression parts.` });
    }
    return issues;
  },
};
export const diagnosisRepairDescriptor: FamilyDescriptor<DiagnosisRepairConfig, DiagnosisRepairResponse> = {
  id: "diagnosis_repair", version: 2, responseSchemaVersion: 2,
  configSchema: DiagnosisRepairConfigSchema, responseSchema: DiagnosisRepairResponseSchema,
  requiredAffordances: ["original_artifact", "location_selection", "expression_builder", "public_case_results"],
  supportedEvaluators: ["deterministic", "rubric"], rendererKey: "construction.repair.v2",
  accessibility: { keyboardEquivalent: true, nonVisualSummary: true }, actions: ["run"], requirements: ["activity", "model"],
  limitations: ["Repairs a complete bounded numeric expression, not arbitrary code.", "Causal explanations require a connected rubric assessment when the task targets that skill."],
  createInitialResponse: (config) => ({ kind: "diagnosis_repair", action: "repair", locationPaths: [], replacement: config.initialExpression, explanation: "" }),
  validateSubmission: (config, response) => {
    const issues = expressionIssues(response.replacement, config.variables.map(({ id }) => id), "replacement");
    if (response.locationPaths.length === 0) issues.push({ path: ["locationPaths"], code: "required", message: "Locate the part of the original expression that needs repair." });
    if (new Set(response.locationPaths).size !== response.locationPaths.length) issues.push({ path: ["locationPaths"], code: "duplicate", message: "Select each repair location once." });
    response.locationPaths.forEach((path, index) => {
      if (!resolveExpressionPointer(config.initialExpression, path).found) issues.push({ path: ["locationPaths", index], code: "invalid_reference", message: "Choose a location that exists in the original expression." });
    });
    if (!response.explanation.trim()) issues.push({ path: ["explanation"], code: "required", message: "Explain the defect and how your repair changes the result." });
    return issues;
  },
};
export const adversarialTestingDescriptor: FamilyDescriptor<AdversarialTestingConfig, AdversarialTestingResponse> = {
  id: "adversarial_testing", version: 2, responseSchemaVersion: 2,
  configSchema: AdversarialTestingConfigSchema, responseSchema: AdversarialTestingResponseSchema,
  requiredAffordances: ["test_case_editor", "candidate_results", "expected_output", "run_submit_distinction"],
  supportedEvaluators: ["deterministic"], rendererKey: "construction.adversarial.v2",
  accessibility: { keyboardEquivalent: true, nonVisualSummary: true }, actions: ["run"], requirements: ["activity"],
  limitations: ["Tests execute the bounded expression candidate against a private numeric oracle.", "One exposed defect does not establish the behavior of an unrestricted program."],
  createInitialResponse: () => ({ kind: "adversarial_testing", action: "design_tests", cases: [], failureExplanation: "" }),
  validateSubmission: (config, response) => {
    const issues: SubmissionIssue[] = [];
    if (response.cases.length === 0) issues.push({ path: ["cases"], code: "required", message: "Add a test case." });
    if (response.cases.length > config.maxCases) issues.push({ path: ["cases"], code: "out_of_bounds", message: `Use no more than ${config.maxCases} cases.` });
    response.cases.forEach((item, index) => {
      issues.push(...boundedInputIssues(config.variables, item.input, ["cases", index, "input"]));
      if (item.expected === null) issues.push({ path: ["cases", index, "expected"], code: "required", message: "Enter the result required by the specification." });
    });
    const inputs = response.cases.map(({ input }) => JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
    if (new Set(inputs).size !== inputs.length) issues.push({ path: ["cases"], code: "duplicate", message: "Use different inputs for each test case." });
    if (!response.failureExplanation.trim()) issues.push({ path: ["failureExplanation"], code: "required", message: "Explain what the cases show about the candidate." });
    return issues;
  },
};
export const constrainedOptimizationDescriptor: FamilyDescriptor<ConstrainedOptimizationConfig, ConstrainedOptimizationResponse> = {
  id: "constrained_optimization", version: 2, responseSchemaVersion: 2,
  configSchema: ConstrainedOptimizationConfigSchema, responseSchema: ConstrainedOptimizationResponseSchema,
  requiredAffordances: ["bounded_parameters", "baseline_comparison", "constraint_results", "run_submit_distinction"],
  supportedEvaluators: ["deterministic"], rendererKey: "construction.optimization.v2",
  accessibility: { keyboardEquivalent: true, nonVisualSummary: true }, actions: ["run"], requirements: ["activity"],
  limitations: ["Only the declared bounded model and objective are assessed.", "A qualifying improvement is not a claim of global optimality or future performance."],
  createInitialResponse: (config) => ({ kind: "constrained_optimization", action: "optimize", configuration: { ...config.baseline }, observationReceiptId: null }),
  validateSubmission: (config, response) => {
    const issues = boundedInputIssues(config.model.inputs, response.configuration, ["configuration"]);
    if (response.observationReceiptId === null) issues.push({ path: ["observationReceiptId"], code: "required", message: "Run this configuration before submitting it." });
    return issues;
  },
};

export const descriptors = [planConstructionDescriptor, artifactConstructionDescriptor, diagnosisRepairDescriptor,
  adversarialTestingDescriptor, constrainedOptimizationDescriptor] as const;
