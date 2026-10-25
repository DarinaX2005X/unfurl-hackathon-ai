import { z } from "zod";
import type { JsonValue } from "../../common";
import {
  BlockSchema, EdgeSchema, ExprSchema, FiniteNumberSchema, LocalIdSchema,
  MECHANIC_LIMITS, NonemptyTextSchema, SpanSchema, TextSchema, UnitSchema,
  evaluateExpression, isValidSpan, validateExpression, type Expr, type FamilyDescriptor, type SubmissionIssue,
} from "./shared";

const editableNumber = FiniteNumberSchema.nullable();
const count = z.number().int().min(0).max(1_000_000);
const row = z.object({ x: editableNumber, y: editableNumber }).strict();
const matrix = z.object({ tp: count, fp: count, tn: count, fn: count }).strict();
const editableMatrix = z.object({ tp: editableNumber, fp: editableNumber, tn: editableNumber, fn: editableNumber }).strict();
const issue = (path: SubmissionIssue["path"], code: SubmissionIssue["code"], message: string): SubmissionIssue => ({ path, code, message });
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const requiredNumber = (value: number | null, path: SubmissionIssue["path"]): SubmissionIssue[] =>
  value === null ? [issue(path, "required", "Enter a number.")] : [];

function family<C extends JsonValue, R extends JsonValue>(
  definition: Pick<FamilyDescriptor<C, R>, "id" | "configSchema" | "responseSchema" | "requiredAffordances" |
    "supportedEvaluators" | "requirements" | "limitations" | "createInitialResponse" | "validateSubmission">,
): FamilyDescriptor<C, R> {
  return { ...definition, version: 2, responseSchemaVersion: 2, actions: [],
    rendererKey: `foundations/${definition.id}`, accessibility: { keyboardEquivalent: true, nonVisualSummary: true } };
}

export const RecallReconstructionConfigSchema = z.object({
  kind: z.literal("recall_reconstruction"), cue: NonemptyTextSchema,
  maxChars: z.number().int().min(1).max(MECHANIC_LIMITS.text),
}).strict();
export const RecallReconstructionResponseSchema = z.object({
  kind: z.literal("recall_reconstruction"), action: z.literal("recall"), text: TextSchema,
}).strict();
export type RecallReconstructionConfig = z.infer<typeof RecallReconstructionConfigSchema>;
export type RecallReconstructionResponse = z.infer<typeof RecallReconstructionResponseSchema>;
export const recallReconstructionDescriptor = family<RecallReconstructionConfig, RecallReconstructionResponse>({
  id: "recall_reconstruction", configSchema: RecallReconstructionConfigSchema, responseSchema: RecallReconstructionResponseSchema,
  requiredAffordances: ["free_text"], supportedEvaluators: ["rubric"], requirements: ["model"],
  limitations: ["Recall is assessed by a semantic rubric with explicit uncertainty. Exact wording is not an answer key."],
  createInitialResponse: () => ({ kind: "recall_reconstruction", action: "recall", text: "" }),
  validateSubmission: (config, response) => !response.text.trim() ? [issue(["text"], "required", "Write your answer before checking it.")] :
    response.text.length > config.maxChars ? [issue(["text"], "out_of_bounds", `Use no more than ${config.maxChars} characters.`)] : [],
});

export const ConfusableDiscriminationConfigSchema = z.object({
  kind: z.literal("confusable_discrimination"), knownFacts: z.array(BlockSchema).max(20),
  cases: z.array(BlockSchema).min(2).max(20), requestedDistinction: NonemptyTextSchema,
}).strict().refine((config) => unique([...config.knownFacts, ...config.cases].map((block) => block.id)), "Block identifiers must be unique");
export const ConfusableDiscriminationResponseSchema = z.object({
  kind: z.literal("confusable_discrimination"), action: z.literal("distinguish"),
  caseId: LocalIdSchema.nullable(), evidenceSpans: z.array(SpanSchema).max(20), distinction: TextSchema,
}).strict();
export type ConfusableDiscriminationConfig = z.infer<typeof ConfusableDiscriminationConfigSchema>;
export type ConfusableDiscriminationResponse = z.infer<typeof ConfusableDiscriminationResponseSchema>;
export const confusableDiscriminationDescriptor = family<ConfusableDiscriminationConfig, ConfusableDiscriminationResponse>({
  id: "confusable_discrimination", configSchema: ConfusableDiscriminationConfigSchema, responseSchema: ConfusableDiscriminationResponseSchema,
  requiredAffordances: ["case_selection", "evidence_selection", "free_text"], supportedEvaluators: ["rubric"], requirements: ["model"],
  limitations: ["Evidence spans refer to actual case text using UTF-16 offsets. A case selection without an essential distinction is insufficient."],
  createInitialResponse: () => ({ kind: "confusable_discrimination", action: "distinguish", caseId: null, evidenceSpans: [], distinction: "" }),
  validateSubmission: (config, response) => {
    const issues: SubmissionIssue[] = [];
    if (response.caseId === null) issues.push(issue(["caseId"], "required", "Choose the case that demonstrates the distinction."));
    else if (!config.cases.some((item) => item.id === response.caseId)) issues.push(issue(["caseId"], "invalid_reference", "Choose one of the displayed cases."));
    if (!response.evidenceSpans.length) issues.push(issue(["evidenceSpans"], "required", "Select a passage that supports your answer."));
    response.evidenceSpans.forEach((span, index) => {
      if (!isValidSpan(span, config.cases) || span.blockId !== response.caseId) issues.push(issue(["evidenceSpans", index], "invalid_reference", "Evidence must come from the selected case."));
    });
    if (!unique(response.evidenceSpans.map((span) => JSON.stringify(span)))) issues.push(issue(["evidenceSpans"], "duplicate", "Use each evidence passage once."));
    if (!response.distinction.trim()) issues.push(issue(["distinction"], "required", "Explain the essential difference between the cases."));
    return issues;
  },
});

export type AffineRule = { slope: number; intercept: number };
/** Only constant arithmetic and affine operations are allowed, never executable source. */
export function normalizeAffineExpression(expression: Expr): AffineRule {
  const parsed = ExprSchema.parse(expression);
  if (validateExpression(parsed, ["x"]).length) throw new Error("Only the variable x is supported");
  const visit = (node: Expr): AffineRule & { variable: boolean } => {
    if (node.op === "constant") return { slope: 0, intercept: node.value, variable: false };
    if (node.op === "variable") return { slope: 1, intercept: 0, variable: true };
    if (node.op === "abs") {
      const value = visit(node.value);
      if (value.variable) throw new Error("An absolute value containing x is outside the affine variant");
      return { slope: 0, intercept: Math.abs(value.intercept), variable: false };
    }
    const left = visit(node.left), right = visit(node.right);
    let result: AffineRule;
    if (node.op === "add" || node.op === "subtract") {
      const sign = node.op === "add" ? 1 : -1;
      result = { slope: left.slope + sign * right.slope, intercept: left.intercept + sign * right.intercept };
    } else if (node.op === "multiply") {
      if (left.variable && right.variable) throw new Error("Multiplying two expressions containing x is outside the affine variant");
      result = { slope: left.slope * right.intercept + right.slope * left.intercept, intercept: left.intercept * right.intercept };
    } else {
      if (right.variable) throw new Error("A denominator containing x is outside the affine variant");
      if (right.intercept === 0) throw new Error("A denominator cannot be zero");
      result = { slope: left.slope / right.intercept, intercept: left.intercept / right.intercept };
    }
    if (!Number.isFinite(result.slope) || !Number.isFinite(result.intercept)) throw new Error("The expression exceeds the finite numeric range");
    return { ...result, variable: left.variable || right.variable };
  };
  const { slope, intercept } = visit(parsed);
  return { slope, intercept };
}

export function inferAffineRule(pairs: readonly [number, number][]): AffineRule {
  const first = pairs[0];
  const second = pairs.find((pair) => pair[0] !== first?.[0]);
  if (!first || !second) throw new Error("An affine rule needs at least two distinct input values");
  const slope = (second[1] - first[1]) / (second[0] - first[0]);
  const intercept = first[1] - slope * first[0];
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) throw new Error("The affine coefficients exceed the finite numeric range");
  for (const [x, y] of pairs) {
    const predicted = slope * x + intercept;
    // Permit floating-point roundoff, not a visibly or numerically different rule.
    if (!Number.isFinite(predicted) || Math.abs(y - predicted) > Number.EPSILON * 16 * Math.max(1, Math.abs(y), Math.abs(predicted))) {
      throw new Error("The examples do not define a consistent affine rule");
    }
  }
  return { slope, intercept };
}
export const RuleInductionConfigSchema = z.object({
  kind: z.literal("rule_induction"), pairs: z.array(z.tuple([FiniteNumberSchema, FiniteNumberSchema])).min(2).max(50),
  hypothesisClass: z.literal("affine"), probeXs: z.array(FiniteNumberSchema).min(1).max(20),
}).strict().superRefine((config, context) => {
  try {
    const rule = inferAffineRule(config.pairs);
    if (config.probeXs.some((x) => !Number.isFinite(rule.slope * x + rule.intercept))) throw new Error("A probe exceeds the finite numeric range");
  }
  catch (error) { context.addIssue({ code: "custom", path: ["pairs"], message: (error as Error).message }); }
  if (new Set(config.probeXs).size !== config.probeXs.length || config.probeXs.some((x) => config.pairs.some((pair) => pair[0] === x))) {
    context.addIssue({ code: "custom", path: ["probeXs"], message: "Probes must be distinct new inputs" });
  }
});
export const RuleInductionResponseSchema = z.object({
  kind: z.literal("rule_induction"), action: z.literal("infer_rule"),
  rule: z.discriminatedUnion("form", [
    z.object({ form: z.literal("coefficients"), slope: editableNumber, intercept: editableNumber }).strict(),
    z.object({ form: z.literal("expression"), expression: ExprSchema.nullable() }).strict(),
  ]), probeValues: z.array(editableNumber).max(20),
}).strict();
export type RuleInductionConfig = z.infer<typeof RuleInductionConfigSchema>;
export type RuleInductionResponse = z.infer<typeof RuleInductionResponseSchema>;
export const ruleInductionDescriptor = family<RuleInductionConfig, RuleInductionResponse>({
  id: "rule_induction", configSchema: RuleInductionConfigSchema, responseSchema: RuleInductionResponseSchema,
  requiredAffordances: ["numeric_rule", "probe_predictions"], supportedEvaluators: ["deterministic"], requirements: [],
  limitations: ["Only identifiable affine examples and bounded affine expressions in x are supported. Matching visible examples alone does not establish unrestricted inductive truth."],
  createInitialResponse: (config) => ({ kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: null, intercept: null }, probeValues: config.probeXs.map(() => null) }),
  validateSubmission: (config, response) => {
    const issues = response.rule.form === "coefficients" ? [
      ...requiredNumber(response.rule.slope, ["rule", "slope"]), ...requiredNumber(response.rule.intercept, ["rule", "intercept"]),
    ] : response.rule.expression === null ? [issue(["rule", "expression"], "required", "Enter an affine expression.")] : [];
    if (response.rule.form === "expression" && response.rule.expression !== null) {
      try {
        normalizeAffineExpression(response.rule.expression);
        for (const x of config.probeXs) evaluateExpression(response.rule.expression, { x }, ["x"]);
      }
      catch (error) { issues.push(issue(["rule", "expression"], "invalid_structure", (error as Error).message)); }
    }
    if (response.rule.form === "coefficients" && response.rule.slope !== null && response.rule.intercept !== null) {
      const { slope, intercept } = response.rule;
      if (config.probeXs.some((x) => !Number.isFinite(slope * x + intercept))) issues.push(issue(["rule"], "out_of_bounds", "The rule produces a value outside the finite numeric range."));
    }
    if (response.probeValues.length !== config.probeXs.length) issues.push(issue(["probeValues"], "invalid_structure", "Predict one value for every new input."));
    response.probeValues.forEach((value, index) => issues.push(...requiredNumber(value, ["probeValues", index])));
    return issues;
  },
});

export const ExampleConstructionConfigSchema = z.object({
  kind: z.literal("example_construction"), objectType: z.literal("confusion_matrix"),
  constraints: z.object({ total: count.positive(), falsePositive: count, minTruePositive: count, minFalseNegative: count }).strict(),
}).strict().refine(({ constraints: c }) => c.falsePositive + c.minTruePositive + c.minFalseNegative <= c.total, "The matrix constraints must be satisfiable");
export const ExampleConstructionResponseSchema = z.object({
  kind: z.literal("example_construction"), action: z.literal("construct_example"), matrix: editableMatrix,
}).strict();
export type ExampleConstructionConfig = z.infer<typeof ExampleConstructionConfigSchema>;
export type ExampleConstructionResponse = z.infer<typeof ExampleConstructionResponseSchema>;
export const exampleConstructionDescriptor = family<ExampleConstructionConfig, ExampleConstructionResponse>({
  id: "example_construction", configSchema: ExampleConstructionConfigSchema, responseSchema: ExampleConstructionResponseSchema,
  requiredAffordances: ["matrix_editor"], supportedEvaluators: ["deterministic"], requirements: [],
  limitations: ["The initial object is a binary confusion matrix with integer counts up to one million. Every construction satisfying all stated constraints is accepted."],
  createInitialResponse: () => ({ kind: "example_construction", action: "construct_example", matrix: { tp: null, fp: null, tn: null, fn: null } }),
  validateSubmission: (_config, response) => Object.entries(response.matrix).flatMap(([key, value]) => value === null ?
    requiredNumber(value, ["matrix", key]) : !Number.isInteger(value) || value < 0 || value > 1_000_000 ?
      [issue(["matrix", key], "out_of_bounds", "Enter a whole number from 0 to 1,000,000.")] : []),
});

export const CounterexampleConstructionConfigSchema = z.object({
  kind: z.literal("counterexample_construction"), claim: NonemptyTextSchema, modelGrammar: z.literal("constant"),
  maxTrainRows: z.number().int().min(1).max(25), maxValidationRows: z.number().int().min(1).max(25),
}).strict();
export const CounterexampleConstructionResponseSchema = z.object({
  kind: z.literal("counterexample_construction"), action: z.literal("refute"),
  model: z.object({ constant: editableNumber }).strict(), train: z.array(row).max(25), validation: z.array(row).max(25),
}).strict();
export type CounterexampleConstructionConfig = z.infer<typeof CounterexampleConstructionConfigSchema>;
export type CounterexampleConstructionResponse = z.infer<typeof CounterexampleConstructionResponseSchema>;
export const counterexampleConstructionDescriptor = family<CounterexampleConstructionConfig, CounterexampleConstructionResponse>({
  id: "counterexample_construction", configSchema: CounterexampleConstructionConfigSchema, responseSchema: CounterexampleConstructionResponseSchema,
  requiredAffordances: ["constant_predictor", "editable_data_tables"], supportedEvaluators: ["deterministic"], requirements: [],
  limitations: [
    "Only the coded implication from zero training error to zero validation error is supported, using a constant predictor.",
    "Before readiness, validateCounterexampleClaim must semantically verify the public claim in its content language and bind that exact reviewed text privately. An unknown, unreviewed, or unrelated theorem is not supported.",
    "Training and validation must be nonempty and share no identical x,y row. Each table supports at most 25 rows.",
  ],
  createInitialResponse: () => ({ kind: "counterexample_construction", action: "refute", model: { constant: null }, train: [], validation: [] }),
  validateSubmission: (config, response) => {
    const issues = requiredNumber(response.model.constant, ["model", "constant"]);
    for (const group of ["train", "validation"] as const) {
      const rows = response[group];
      if (!rows.length) issues.push(issue([group], "required", "Add at least one data row."));
      if (rows.length > (group === "train" ? config.maxTrainRows : config.maxValidationRows)) issues.push(issue([group], "out_of_bounds", "This table has more rows than the task allows."));
      rows.forEach((item, index) => {
        issues.push(...requiredNumber(item.x, [group, index, "x"]), ...requiredNumber(item.y, [group, index, "y"]));
        if (item.y !== null && response.model.constant !== null && !Number.isFinite(item.y - response.model.constant)) {
          issues.push(issue([group, index, "y"], "out_of_bounds", "The prediction error exceeds the finite numeric range."));
        }
      });
    }
    response.validation.forEach((item, index) => {
      if (item.x !== null && item.y !== null && response.train.some((train) => train.x === item.x && train.y === item.y)) {
        issues.push(issue(["validation", index], "invalid_structure", "Use a validation row that is not also in the training table."));
      }
    });
    return issues;
  },
});

export const ProcedureReconstructionConfigSchema = z.object({
  kind: z.literal("procedure_reconstruction"), steps: z.array(BlockSchema).min(2).max(MECHANIC_LIMITS.steps),
}).strict().refine((config) => unique(config.steps.map((step) => step.id)), "Step identifiers must be unique");
export const ProcedureReconstructionResponseSchema = z.object({
  kind: z.literal("procedure_reconstruction"), action: z.literal("order_steps"), stepIds: z.array(LocalIdSchema).max(MECHANIC_LIMITS.steps),
}).strict();
export type ProcedureReconstructionConfig = z.infer<typeof ProcedureReconstructionConfigSchema>;
export type ProcedureReconstructionResponse = z.infer<typeof ProcedureReconstructionResponseSchema>;
export const procedureReconstructionDescriptor = family<ProcedureReconstructionConfig, ProcedureReconstructionResponse>({
  id: "procedure_reconstruction", configSchema: ProcedureReconstructionConfigSchema, responseSchema: ProcedureReconstructionResponseSchema,
  requiredAffordances: ["ordered_steps", "keyboard_reordering"], supportedEvaluators: ["deterministic"], requirements: [],
  limitations: ["The private prerequisite graph must be acyclic and reference displayed steps. Every valid topological ordering is accepted."],
  createInitialResponse: () => ({ kind: "procedure_reconstruction", action: "order_steps", stepIds: [] }),
  validateSubmission: (config, response) => {
    const issues: SubmissionIssue[] = [];
    if (response.stepIds.length !== config.steps.length) issues.push(issue(["stepIds"], "required", "Place every step once before checking the order."));
    if (!unique(response.stepIds)) issues.push(issue(["stepIds"], "duplicate", "A step can appear only once."));
    response.stepIds.forEach((id, index) => {
      if (!config.steps.some((step) => step.id === id)) issues.push(issue(["stepIds", index], "invalid_reference", "Use only the displayed steps."));
    });
    return issues;
  },
});

export const RelationalMappingConfigSchema = z.object({
  kind: z.literal("relational_mapping"), nodes: z.array(BlockSchema).min(2).max(MECHANIC_LIMITS.graphNodes),
  aliases: z.record(LocalIdSchema, LocalIdSchema), relationTypes: z.array(LocalIdSchema).min(1).max(24),
}).strict().superRefine((config, context) => {
  const ids = config.nodes.map((node) => node.id);
  if (!unique(ids)) context.addIssue({ code: "custom", path: ["nodes"], message: "Node identifiers must be unique" });
  if (!unique(config.relationTypes)) context.addIssue({ code: "custom", path: ["relationTypes"], message: "Relation identifiers must be unique" });
  if (Object.keys(config.aliases).length > 24) context.addIssue({ code: "custom", path: ["aliases"], message: "At most 24 aliases are supported" });
  for (const [alias, target] of Object.entries(config.aliases)) {
    if (!ids.includes(target) || ids.includes(alias)) context.addIssue({ code: "custom", path: ["aliases", alias], message: "Aliases must have distinct names and point directly to canonical nodes" });
  }
});
export const RelationalMappingResponseSchema = z.object({
  kind: z.literal("relational_mapping"), action: z.literal("map_relations"), edges: z.array(EdgeSchema).max(MECHANIC_LIMITS.graphEdges),
}).strict();
export type RelationalMappingConfig = z.infer<typeof RelationalMappingConfigSchema>;
export type RelationalMappingResponse = z.infer<typeof RelationalMappingResponseSchema>;
export function canonicalNode(config: RelationalMappingConfig, id: string): string | null {
  if (config.nodes.some((node) => node.id === id)) return id;
  return Object.hasOwn(config.aliases, id) ? config.aliases[id]! : null;
}
export const relationalMappingDescriptor = family<RelationalMappingConfig, RelationalMappingResponse>({
  id: "relational_mapping", configSchema: RelationalMappingConfigSchema, responseSchema: RelationalMappingResponseSchema,
  requiredAffordances: ["directed_relation_editor", "graph_text_equivalent"], supportedEvaluators: ["deterministic"], requirements: [],
  limitations: ["Only declared directed relation types and aliases are supported. Graph equivalence is limited to explicitly accepted graphs, canonical aliases, and edge order."],
  createInitialResponse: () => ({ kind: "relational_mapping", action: "map_relations", edges: [] }),
  validateSubmission: (config, response) => {
    const issues: SubmissionIssue[] = [];
    if (!response.edges.length) issues.push(issue(["edges"], "required", "Add the relationships that connect these concepts."));
    const identities = new Set<string>();
    response.edges.forEach((edge, index) => {
      for (const endpoint of ["from", "to"] as const) {
        if (!canonicalNode(config, edge[endpoint])) issues.push(issue(["edges", index, endpoint], "invalid_reference", "Choose a displayed concept or declared alias."));
      }
      if (!config.relationTypes.includes(edge.relation)) issues.push(issue(["edges", index, "relation"], "invalid_reference", "Choose one of the available relations."));
      const key = JSON.stringify([canonicalNode(config, edge.from), edge.relation, canonicalNode(config, edge.to)]);
      if (identities.has(key)) issues.push(issue(["edges", index], "duplicate", "This directed relationship is already present."));
      identities.add(key);
    });
    return issues;
  },
});

export const RepresentationTranslationConfigSchema = z.object({
  kind: z.literal("representation_translation"),
  from: matrix.extend({ type: z.literal("confusion_matrix") }).strict(),
  to: z.enum(["precision", "recall", "accuracy"]), allowedUnits: z.array(UnitSchema).min(1).max(2),
}).strict().superRefine((config, context) => {
  const m = config.from;
  const denominator = config.to === "precision" ? m.tp + m.fp : config.to === "recall" ? m.tp + m.fn : m.tp + m.fp + m.tn + m.fn;
  if (denominator === 0) context.addIssue({ code: "custom", path: ["from"], message: "This metric has a zero denominator and is outside the numeric variant" });
  if (!unique(config.allowedUnits) || config.allowedUnits.some((unit) => unit !== "ratio" && unit !== "percent")) {
    context.addIssue({ code: "custom", path: ["allowedUnits"], message: "Allow ratio, percent, or both without duplicates" });
  }
});
export const RepresentationTranslationResponseSchema = z.object({
  kind: z.literal("representation_translation"), action: z.literal("translate_representation"),
  quantity: z.object({ value: editableNumber, unit: UnitSchema.nullable() }).strict(),
}).strict();
export type RepresentationTranslationConfig = z.infer<typeof RepresentationTranslationConfigSchema>;
export type RepresentationTranslationResponse = z.infer<typeof RepresentationTranslationResponseSchema>;
export const representationTranslationDescriptor = family<RepresentationTranslationConfig, RepresentationTranslationResponse>({
  id: "representation_translation", configSchema: RepresentationTranslationConfigSchema, responseSchema: RepresentationTranslationResponseSchema,
  requiredAffordances: ["confusion_matrix", "quantity_with_unit"], supportedEvaluators: ["deterministic"], requirements: [],
  limitations: ["Only precision, recall, or accuracy from a binary confusion matrix is supported, expressed as ratio or percent. Zero denominators are rejected before readiness."],
  createInitialResponse: (config) => ({ kind: "representation_translation", action: "translate_representation", quantity: { value: null, unit: config.allowedUnits[0]! } }),
  validateSubmission: (config, response) => {
    const issues = requiredNumber(response.quantity.value, ["quantity", "value"]);
    if (response.quantity.unit === null) issues.push(issue(["quantity", "unit"], "required", "Choose a unit for your answer."));
    else if (!config.allowedUnits.includes(response.quantity.unit)) issues.push(issue(["quantity", "unit"], "incompatible_unit", "Use one of the units allowed for this metric."));
    return issues;
  },
});

export const descriptors = [recallReconstructionDescriptor, confusableDiscriminationDescriptor, ruleInductionDescriptor,
  exampleConstructionDescriptor, counterexampleConstructionDescriptor, procedureReconstructionDescriptor,
  relationalMappingDescriptor, representationTranslationDescriptor] as const;
