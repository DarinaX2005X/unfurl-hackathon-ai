import { z } from "zod";
import { DigestSchema, IdSchema, IsoDateTimeSchema, type JsonValue } from "../../common";
import {
  BlockSchema, BoundedModelSchema, BoundedVariableSchema, ExprSchema, FiniteNumberSchema,
  FiniteValuesSchema, LocalIdSchema, MECHANIC_LIMITS, NonemptyTextSchema, QuantitySchema,
  SpanSchema, TextSchema, UnitSchema, convertQuantity, evaluateBoundedModel, evaluateExpression,
  isValidSpan, validateExpression, type Expr, type FamilyDescriptor, type NamedQuantity,
  type SubmissionIssue, type Unit,
} from "./shared";

const ids = z.array(LocalIdSchema).max(MECHANIC_LIMITS.variables)
  .refine((items) => new Set(items).size === items.length, "Identifiers must be unique");
const blocks = z.array(BlockSchema).min(1).max(MECHANIC_LIMITS.variables)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Block identifiers must be unique");
const units = z.array(UnitSchema).min(1).max(8)
  .refine((items) => new Set(items).size === items.length, "Units must be unique");
const editableValues = z.record(LocalIdSchema, FiniteNumberSchema.nullable())
  .refine((values) => Object.keys(values).length <= MECHANIC_LIMITS.variables, "Too many variables");
const expressions = z.record(LocalIdSchema, ExprSchema)
  .refine((values) => Object.keys(values).length <= MECHANIC_LIMITS.variables, "Too many equations");
const interval = z.object({ lower: FiniteNumberSchema.nullable(), upper: FiniteNumberSchema.nullable(), unit: UnitSchema.nullable() }).strict();
const issue = (path: Array<string | number>, code: SubmissionIssue["code"], message: string): SubmissionIssue => ({ path, code, message });
const sameKeys = (left: object, right: object) => {
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every((name) => Object.hasOwn(right, name));
};
function compatible(from: Unit, to: Unit): boolean {
  try { convertQuantity({ value: 1, unit: from }, to); return true; } catch { return false; }
}
function intervalIssues(value: z.infer<typeof interval>, allowedUnits: Unit[], path: Array<string | number> = []): SubmissionIssue[] {
  const result: SubmissionIssue[] = [];
  if (value.lower === null) result.push(issue([...path, "lower"], "required", "Enter the lower bound."));
  if (value.upper === null) result.push(issue([...path, "upper"], "required", "Enter the upper bound."));
  if (value.unit === null) result.push(issue([...path, "unit"], "required", "Choose a unit."));
  else if (!allowedUnits.includes(value.unit)) result.push(issue([...path, "unit"], "incompatible_unit", "Use one of the task's allowed units."));
  if (value.lower !== null && value.upper !== null && (value.lower > value.upper || !Number.isFinite(value.upper - value.lower))) {
    result.push(issue(path, "out_of_bounds", "The lower bound must not exceed the upper bound, and the interval must be finite."));
  }
  return result;
}
function textIssue(text: string, path: Array<string | number>, message: string): SubmissionIssue[] {
  return text.trim() ? [] : [issue(path, "required", message)];
}

export const StateTracingConfigSchema = z.object({
  kind: z.literal("state_tracing"), initial: FiniteValuesSchema,
  inputs: z.array(FiniteValuesSchema).min(1).max(MECHANIC_LIMITS.steps), updates: expressions,
  units: z.record(LocalIdSchema, UnitSchema),
}).strict().superRefine((config, context) => {
  const stateNames = Object.keys(config.initial);
  const inputNames = Object.keys(config.inputs[0]!);
  if (!stateNames.length || !sameKeys(config.initial, config.updates) || !sameKeys(config.initial, config.units)) {
    context.addIssue({ code: "custom", message: "Initial state, updates and units must declare the same nonempty state keys" });
  }
  if (stateNames.length + inputNames.length > MECHANIC_LIMITS.variables || inputNames.some((name) => stateNames.includes(name))) {
    context.addIssue({ code: "custom", path: ["inputs"], message: "State and input variables must be distinct, with at most 24 declarations" });
  }
  if (stateNames.length * config.inputs.length > MECHANIC_LIMITS.tableCells) {
    context.addIssue({ code: "custom", message: "A trace may have at most 100 state cells" });
  }
  config.inputs.forEach((input, index) => {
    if (!sameKeys(input, config.inputs[0]!)) context.addIssue({ code: "custom", path: ["inputs", index], message: "Use the same input keys at every step" });
  });
  for (const [key, expression] of Object.entries(config.updates)) {
    for (const error of validateExpression(expression, [...stateNames, ...inputNames])) {
      context.addIssue({ code: "custom", path: ["updates", key, ...error.path], message: error.message });
    }
  }
  try { traceState(config); } catch { context.addIssue({ code: "custom", path: ["updates"], message: "Every step must produce a finite state from the declared inputs" }); }
});
export type StateTracingConfig = z.infer<typeof StateTracingConfigSchema>;
export const StateTracingResponseSchema = z.object({ kind: z.literal("state_tracing"), action: z.literal("trace"), states: z.array(editableValues).max(MECHANIC_LIMITS.steps) }).strict();
export type StateTracingResponse = z.infer<typeof StateTracingResponseSchema>;

/** Every update reads the prior state; object insertion order cannot change a step. */
export function traceState(config: StateTracingConfig): Record<string, number>[] {
  let state = { ...config.initial };
  return config.inputs.map((input) => {
    const previous = { ...state, ...input };
    const next = Object.fromEntries(Object.entries(config.updates).map(([key, expression]) => [key, evaluateExpression(expression, previous)]));
    state = next;
    return next;
  });
}

export const OutcomePredictionConfigSchema = z.object({
  kind: z.literal("outcome_prediction"), model: BoundedModelSchema, settings: FiniteValuesSchema,
  targetOutputId: LocalIdSchema, allowedUnits: units, maxIntervalWidth: FiniteNumberSchema.nonnegative(),
}).strict().superRefine((config, context) => {
  const target = config.model.outputs.find((output) => output.id === config.targetOutputId);
  if (!target) context.addIssue({ code: "custom", path: ["targetOutputId"], message: "Choose a declared model output" });
  else if (config.allowedUnits.some((unit) => !compatible(unit, target.unit))) context.addIssue({ code: "custom", path: ["allowedUnits"], message: "Prediction units must be compatible with the target output" });
  try { evaluateBoundedModel(config.model, config.settings); } catch { context.addIssue({ code: "custom", path: ["settings"], message: "Settings must satisfy the bounded model and produce finite outputs" }); }
});
export type OutcomePredictionConfig = z.infer<typeof OutcomePredictionConfigSchema>;
export const OutcomePredictionResponseSchema = z.object({
  kind: z.literal("outcome_prediction"), action: z.literal("predict"), commitReceiptId: IdSchema.nullable(),
  interval, observationReceiptId: IdSchema.nullable(),
}).strict();
export type OutcomePredictionResponse = z.infer<typeof OutcomePredictionResponseSchema>;
export function predictOutcome(config: OutcomePredictionConfig): NamedQuantity {
  const output = evaluateBoundedModel(config.model, config.settings).find((value) => value.id === config.targetOutputId);
  if (!output) throw new Error("The prediction target must be a declared output");
  return output;
}

export const CauseDiagnosisConfigSchema = z.object({ kind: z.literal("cause_diagnosis"), observations: blocks, candidateCauses: blocks }).strict();
export type CauseDiagnosisConfig = z.infer<typeof CauseDiagnosisConfigSchema>;
export const CauseDiagnosisResponseSchema = z.object({
  kind: z.literal("cause_diagnosis"), action: z.literal("diagnose"), conclusion: z.enum(["identified", "unidentified"]).nullable(),
  consistentCauseIds: ids, neededEvidence: TextSchema,
}).strict();
export type CauseDiagnosisResponse = z.infer<typeof CauseDiagnosisResponseSchema>;

export const ExperimentalInvestigationConfigSchema = z.object({
  kind: z.literal("experimental_investigation"),
  hypotheses: z.array(z.object({ id: LocalIdSchema, expression: ExprSchema }).strict()).min(2).max(MECHANIC_LIMITS.variables),
  inputVariable: LocalIdSchema, allowedInputs: z.array(FiniteNumberSchema).min(1).max(MECHANIC_LIMITS.steps),
  queryBudget: z.number().int().min(1).max(MECHANIC_LIMITS.actions),
}).strict().superRefine((config, context) => {
  if (new Set(config.hypotheses.map((hypothesis) => hypothesis.id)).size !== config.hypotheses.length) context.addIssue({ code: "custom", path: ["hypotheses"], message: "Hypothesis identifiers must be unique" });
  if (new Set(config.allowedInputs).size !== config.allowedInputs.length) context.addIssue({ code: "custom", path: ["allowedInputs"], message: "Allowed inputs must be unique" });
  const signatures = new Set<string>();
  config.hypotheses.forEach((hypothesis, index) => {
    for (const error of validateExpression(hypothesis.expression, [config.inputVariable])) context.addIssue({ code: "custom", path: ["hypotheses", index, "expression", ...error.path], message: error.message });
    try {
      const signature = JSON.stringify(config.allowedInputs.map((input) => experimentOutput(config, hypothesis.id, input)));
      if (signatures.has(signature)) context.addIssue({ code: "custom", path: ["hypotheses", index], message: "Hypotheses must be distinguishable by an allowed query" });
      signatures.add(signature);
    } catch { context.addIssue({ code: "custom", path: ["hypotheses", index], message: "Every allowed query must produce a finite result" }); }
  });
});
export type ExperimentalInvestigationConfig = z.infer<typeof ExperimentalInvestigationConfigSchema>;
export const ExperimentalInvestigationResponseSchema = z.object({
  kind: z.literal("experimental_investigation"), action: z.literal("investigate"),
  observationReceiptIds: z.array(IdSchema).max(MECHANIC_LIMITS.actions).refine((values) => new Set(values).size === values.length, "Observation receipts must be unique"),
  conclusionHypothesisId: LocalIdSchema.nullable(), rationale: TextSchema,
}).strict();
export type ExperimentalInvestigationResponse = z.infer<typeof ExperimentalInvestigationResponseSchema>;
/** The caller selects a declared hypothesis; the hidden selection is stored only by the server. */
export function experimentOutput(config: ExperimentalInvestigationConfig, hypothesisId: string, input: number): number {
  if (!config.allowedInputs.includes(input)) throw new Error("Choose an allowed query input");
  const hypothesis = config.hypotheses.find((item) => item.id === hypothesisId);
  if (!hypothesis) throw new Error("Unknown hypothesis");
  return evaluateExpression(hypothesis.expression, { [config.inputVariable]: input }, [config.inputVariable]);
}

function expressionNames(expression: Expr): string[] {
  if (expression.op === "variable") return [expression.name];
  if (expression.op === "constant") return [];
  return expression.op === "abs" ? expressionNames(expression.value) : [...expressionNames(expression.left), ...expressionNames(expression.right)];
}
export const CausalInterventionConfigSchema = z.object({
  kind: z.literal("causal_intervention"), variables: z.array(BoundedVariableSchema).min(1).max(MECHANIC_LIMITS.variables),
  equations: expressions, target: z.object({ variableId: LocalIdSchema, quantity: QuantitySchema }).strict(),
  actionBudget: z.number().int().min(1).max(MECHANIC_LIMITS.actions),
}).strict().superRefine((config, context) => {
  const exogenous = config.variables.map((variable) => variable.id);
  const derived = Object.keys(config.equations);
  if (!derived.length || exogenous.length + derived.length > MECHANIC_LIMITS.variables || new Set([...exogenous, ...derived]).size !== exogenous.length + derived.length) {
    context.addIssue({ code: "custom", message: "Inputs and derived nodes must be distinct, with at most 24 declarations" });
  }
  if (config.variables.some((variable) => variable.unit !== "unitless") || config.target.quantity.unit !== "unitless") context.addIssue({ code: "custom", message: "This causal model supports unitless quantities only" });
  if (!derived.includes(config.target.variableId)) context.addIssue({ code: "custom", path: ["target"], message: "The target must be derived and cannot be directly assigned" });
  for (const [name, expression] of Object.entries(config.equations)) {
    for (const error of validateExpression(expression, [...exogenous, ...derived])) context.addIssue({ code: "custom", path: ["equations", name, ...error.path], message: error.message });
  }
  try { causalEvaluationOrder(config); } catch { context.addIssue({ code: "custom", path: ["equations"], message: "Causal equations must form an acyclic graph with declared references" }); }
});
export type CausalInterventionConfig = z.infer<typeof CausalInterventionConfigSchema>;
export const CausalInterventionResponseSchema = z.object({
  kind: z.literal("causal_intervention"), action: z.literal("intervene"), assignments: editableValues, observationReceiptId: IdSchema.nullable(),
}).strict();
export type CausalInterventionResponse = z.infer<typeof CausalInterventionResponseSchema>;
export function causalEvaluationOrder(config: CausalInterventionConfig): string[] {
  const resolved = new Set(config.variables.map((variable) => variable.id));
  const pending = new Set(Object.keys(config.equations));
  const order: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter((id) => expressionNames(config.equations[id]!).every((name) => resolved.has(name)));
    if (!ready.length) throw new Error("Unresolved or cyclic equation dependency");
    for (const id of ready) { pending.delete(id); resolved.add(id); order.push(id); }
  }
  return order;
}
export function evaluateCausalModel(config: CausalInterventionConfig, assignments: Record<string, number>): NamedQuantity[] {
  // Reuse the bounded interpreter's exact keys, range and step checks for exogenous values.
  evaluateBoundedModel({ inputs: config.variables, outputs: [{ id: "input_validation", unit: "unitless", expression: { op: "constant", value: 0 } }] }, assignments);
  const values = { ...assignments };
  return causalEvaluationOrder(config).map((id) => {
    const value = evaluateExpression(config.equations[id]!, values);
    values[id] = value;
    return { id, quantity: { value, unit: "unitless" as const } };
  });
}

export const EstimationConfigSchema = z.object({
  kind: z.literal("estimation"), facts: blocks, requestedQuantity: NonemptyTextSchema,
  allowedUnits: units, maxRelativeIntervalWidth: FiniteNumberSchema.nonnegative(),
}).strict().superRefine((config, context) => {
  if (config.allowedUnits.some((unit) => !compatible(unit, config.allowedUnits[0]!))) context.addIssue({ code: "custom", path: ["allowedUnits"], message: "Estimation units must describe the same dimension" });
});
export type EstimationConfig = z.infer<typeof EstimationConfigSchema>;
export const EstimationResponseSchema = z.object({
  kind: z.literal("estimation"), action: z.literal("estimate"), lower: FiniteNumberSchema.nullable(),
  upper: FiniteNumberSchema.nullable(), unit: UnitSchema.nullable(), basis: TextSchema,
}).strict();
export type EstimationResponse = z.infer<typeof EstimationResponseSchema>;

export const StrategySelectionConfigSchema = z.object({ kind: z.literal("strategy_selection"), situation: blocks, strategies: blocks, constraints: blocks }).strict();
export type StrategySelectionConfig = z.infer<typeof StrategySelectionConfigSchema>;
export const StrategySelectionResponseSchema = z.object({
  kind: z.literal("strategy_selection"), action: z.literal("select_strategy"), strategyId: LocalIdSchema.nullable(),
  assumptions: z.array(TextSchema).max(MECHANIC_LIMITS.steps), justification: TextSchema,
}).strict();
export type StrategySelectionResponse = z.infer<typeof StrategySelectionResponseSchema>;

export const InvestigationSourceSchema = z.object({
  id: LocalIdSchema, url: z.url().max(2_048).refine((url) => /^https?:\/\//.test(url), "Use an HTTP or HTTPS source URL"),
  title: NonemptyTextSchema, retrievedAt: IsoDateTimeSchema, contentDigest: DigestSchema, passages: blocks,
}).strict();
export type InvestigationSource = z.infer<typeof InvestigationSourceSchema>;
export const SourceInvestigationConfigSchema = z.object({
  kind: z.literal("source_investigation"), claim: NonemptyTextSchema,
  sources: z.array(InvestigationSourceSchema).min(1).max(MECHANIC_LIMITS.variables)
    .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length, "Source identifiers must be unique"),
}).strict();
export type SourceInvestigationConfig = z.infer<typeof SourceInvestigationConfigSchema>;
export const SourceInvestigationResponseSchema = z.object({
  kind: z.literal("source_investigation"), action: z.literal("investigate_sources"), verdict: z.enum(["supported", "not_supported", "mixed"]).nullable(),
  citations: z.array(z.object({ sourceId: LocalIdSchema, passageId: LocalIdSchema, span: SpanSchema.nullable() }).strict()).max(MECHANIC_LIMITS.variables),
  explanation: TextSchema,
}).strict();
export type SourceInvestigationResponse = z.infer<typeof SourceInvestigationResponseSchema>;

function family<C extends JsonValue, R extends JsonValue>(definition: Omit<FamilyDescriptor<C, R>, "version" | "responseSchemaVersion" | "rendererKey" | "accessibility">): FamilyDescriptor<C, R> {
  return { ...definition, version: 2, responseSchemaVersion: 2, rendererKey: `${definition.id}@2`, accessibility: { keyboardEquivalent: true, nonVisualSummary: true } };
}
export const stateTracingDescriptor = family<StateTracingConfig, StateTracingResponse>({
  id: "state_tracing", configSchema: StateTracingConfigSchema, responseSchema: StateTracingResponseSchema,
  requiredAffordances: ["editable_state_table", "prior_state_equations"], supportedEvaluators: ["deterministic"], actions: [], requirements: [],
  limitations: ["Bounded numerical state updates only; every update reads the previous state simultaneously."],
  createInitialResponse: (config) => ({ kind: "state_tracing", action: "trace", states: config.inputs.map(() => Object.fromEntries(Object.keys(config.initial).map((name) => [name, null]))) }),
  validateSubmission: (config, response) => {
    const result: SubmissionIssue[] = [];
    if (response.states.length !== config.inputs.length) result.push(issue(["states"], "required", "Enter one state for every input step."));
    response.states.forEach((state, index) => {
      if (!sameKeys(state, config.initial)) result.push(issue(["states", index], "invalid_structure", "Supply exactly the declared state variables."));
      Object.entries(state).forEach(([name, value]) => { if (value === null) result.push(issue(["states", index, name], "required", "Enter this intermediate state value.")); });
    });
    return result;
  },
});
export const outcomePredictionDescriptor = family<OutcomePredictionConfig, OutcomePredictionResponse>({
  id: "outcome_prediction", configSchema: OutcomePredictionConfigSchema, responseSchema: OutcomePredictionResponseSchema,
  requiredAffordances: ["interval_editor", "commit_before_run", "observed_values"], supportedEvaluators: ["deterministic"], actions: ["prediction.commit", "run"], requirements: ["activity"],
  limitations: ["Prediction is assessed only against a saved commitment and server observation for the configured bounded model and settings."],
  createInitialResponse: () => ({ kind: "outcome_prediction", action: "predict", commitReceiptId: null, interval: { lower: null, upper: null, unit: null }, observationReceiptId: null }),
  validateSubmission: (config, response) => [
    ...intervalIssues(response.interval, config.allowedUnits, ["interval"]),
    ...(response.commitReceiptId ? [] : [issue(["commitReceiptId"], "required", "Commit your prediction before running the model.")]),
    ...(response.observationReceiptId ? [] : [issue(["observationReceiptId"], "required", "Run the model after committing your prediction.")]),
  ],
});
export const causeDiagnosisDescriptor = family<CauseDiagnosisConfig, CauseDiagnosisResponse>({
  id: "cause_diagnosis", configSchema: CauseDiagnosisConfigSchema, responseSchema: CauseDiagnosisResponseSchema,
  requiredAffordances: ["observations", "candidate_set", "discriminating_evidence"], supportedEvaluators: ["rubric"], actions: [], requirements: ["model"],
  limitations: ["Consistency with observations does not establish an identified real-world cause; ambiguity must remain explicit."],
  createInitialResponse: () => ({ kind: "cause_diagnosis", action: "diagnose", conclusion: null, consistentCauseIds: [], neededEvidence: "" }),
  validateSubmission: (config, response) => [
    ...(response.conclusion ? [] : [issue(["conclusion"], "required", "State whether the cause is identified.")]),
    ...(response.consistentCauseIds.length ? [] : [issue(["consistentCauseIds"], "required", "Retain at least one cause consistent with the observations.")]),
    ...response.consistentCauseIds.flatMap((id, index) => config.candidateCauses.some((cause) => cause.id === id) ? [] : [issue(["consistentCauseIds", index], "invalid_reference", "Choose a declared candidate cause.")]),
    ...textIssue(response.neededEvidence, ["neededEvidence"], "Explain what evidence distinguishes the remaining causes."),
  ],
});
export const experimentalInvestigationDescriptor = family<ExperimentalInvestigationConfig, ExperimentalInvestigationResponse>({
  id: "experimental_investigation", configSchema: ExperimentalInvestigationConfigSchema, responseSchema: ExperimentalInvestigationResponseSchema,
  requiredAffordances: ["query_input", "observation_history", "hypothesis_conclusion"], supportedEvaluators: ["deterministic", "rubric"], actions: ["experiment.query"], requirements: ["activity", "model"],
  limitations: ["One fixed server-owned hypothesis, one numerical input and at most six queries; inconclusive evidence cannot establish unique identification."],
  createInitialResponse: () => ({ kind: "experimental_investigation", action: "investigate", observationReceiptIds: [], conclusionHypothesisId: null, rationale: "" }),
  validateSubmission: (config, response) => [
    ...(response.observationReceiptIds.length ? [] : [issue(["observationReceiptIds"], "required", "Make at least one measurement before drawing a conclusion.")]),
    ...(response.observationReceiptIds.length <= config.queryBudget ? [] : [issue(["observationReceiptIds"], "out_of_bounds", "The observations exceed this experiment's query budget.")]),
    ...(response.conclusionHypothesisId === null || config.hypotheses.some((hypothesis) => hypothesis.id === response.conclusionHypothesisId) ? [] : [issue(["conclusionHypothesisId"], "invalid_reference", "Choose a declared hypothesis or an inconclusive result.")]),
    ...textIssue(response.rationale, ["rationale"], "Explain what your measurements establish."),
  ],
});
export const causalInterventionDescriptor = family<CausalInterventionConfig, CausalInterventionResponse>({
  id: "causal_intervention", configSchema: CausalInterventionConfigSchema, responseSchema: CausalInterventionResponseSchema,
  requiredAffordances: ["exogenous_controls", "structural_equations", "target_comparison"], supportedEvaluators: ["deterministic"], actions: ["intervention.apply"], requirements: ["activity"],
  limitations: ["Unitless acyclic structural models only; derived values and the target cannot be directly assigned. This model does not establish real-world causality."],
  createInitialResponse: (config) => ({ kind: "causal_intervention", action: "intervene", assignments: Object.fromEntries(config.variables.map((variable) => [variable.id, null])), observationReceiptId: null }),
  validateSubmission: (config, response) => {
    const result: SubmissionIssue[] = [];
    const names = config.variables.map((variable) => variable.id);
    if (Object.keys(response.assignments).some((name) => !names.includes(name))) result.push(issue(["assignments"], "invalid_reference", "Assign only the declared input variables, never derived nodes."));
    for (const variable of config.variables) {
      const value = response.assignments[variable.id];
      const step = value === null || value === undefined ? NaN : (value - variable.min) / variable.step;
      if (value === null || value === undefined) result.push(issue(["assignments", variable.id], "required", "Set this input variable."));
      else if (value < variable.min || value > variable.max || !Number.isFinite(step) || Math.abs(step - Math.round(step)) > 1e-9) result.push(issue(["assignments", variable.id], "out_of_bounds", "Use the stated range and step."));
    }
    if (result.length === 0) {
      try { evaluateCausalModel(config, response.assignments as Record<string, number>); }
      catch { result.push(issue(["assignments"], "out_of_bounds", "These inputs do not produce finite values in this model.")); }
    }
    if (!response.observationReceiptId) result.push(issue(["observationReceiptId"], "required", "Apply the intervention to save its observed result."));
    return result;
  },
});
export const estimationDescriptor = family<EstimationConfig, EstimationResponse>({
  id: "estimation", configSchema: EstimationConfigSchema, responseSchema: EstimationResponseSchema,
  requiredAffordances: ["facts", "quantity_interval", "reasoning_basis"], supportedEvaluators: ["deterministic", "rubric"], actions: [], requirements: ["model"],
  limitations: ["Compatible declared units and a nonzero private reference quantity only; reasoning requires a private assessment rubric."],
  createInitialResponse: () => ({ kind: "estimation", action: "estimate", lower: null, upper: null, unit: null, basis: "" }),
  validateSubmission: (config, response) => [...intervalIssues(response, config.allowedUnits), ...textIssue(response.basis, ["basis"], "Explain the quantities and assumptions behind your estimate.")],
});
export const strategySelectionDescriptor = family<StrategySelectionConfig, StrategySelectionResponse>({
  id: "strategy_selection", configSchema: StrategySelectionConfigSchema, responseSchema: StrategySelectionResponseSchema,
  requiredAffordances: ["constraints", "strategy_choice", "assumptions", "justification"], supportedEvaluators: ["rubric"], actions: [], requirements: ["model"],
  limitations: ["Admissibility applies to the stated situation and constraints, never to a universally best strategy."],
  createInitialResponse: () => ({ kind: "strategy_selection", action: "select_strategy", strategyId: null, assumptions: [], justification: "" }),
  validateSubmission: (config, response) => [
    ...(response.strategyId === null ? [issue(["strategyId"], "required", "Choose a strategy.")] : config.strategies.some((strategy) => strategy.id === response.strategyId) ? [] : [issue(["strategyId"], "invalid_reference", "Choose a declared strategy.")]),
    ...(response.assumptions.length ? [] : [issue(["assumptions"], "required", "State at least one assumption your strategy needs.")]),
    ...response.assumptions.flatMap((assumption, index) => textIssue(assumption, ["assumptions", index], "Complete or remove this assumption.")),
    ...textIssue(response.justification, ["justification"], "Explain how the strategy meets the stated constraints."),
  ],
});
export const sourceInvestigationDescriptor = family<SourceInvestigationConfig, SourceInvestigationResponse>({
  id: "source_investigation", configSchema: SourceInvestigationConfigSchema, responseSchema: SourceInvestigationResponseSchema,
  requiredAffordances: ["versioned_sources", "passage_citations", "claim_scope"], supportedEvaluators: ["rubric"], actions: [], requirements: ["model"],
  limitations: ["Citations must resolve to course research snapshots; a source title or URL alone never establishes support for a claim."],
  createInitialResponse: () => ({ kind: "source_investigation", action: "investigate_sources", verdict: null, citations: [], explanation: "" }),
  validateSubmission: (config, response) => {
    const result: SubmissionIssue[] = [
      ...(response.verdict === null ? [issue(["verdict"], "required", "State how the sources bear on the claim.")] : []),
      ...(response.citations.length ? [] : [issue(["citations"], "required", "Cite at least one passage supporting your assessment.")]),
      ...textIssue(response.explanation, ["explanation"], "Explain the relationship between the passages and the claim."),
    ];
    const seen = new Set<string>();
    response.citations.forEach((citation, index) => {
      const source = config.sources.find((item) => item.id === citation.sourceId);
      const passage = source?.passages.find((item) => item.id === citation.passageId);
      if (!passage) result.push(issue(["citations", index], "invalid_reference", "This passage does not belong to the cited source."));
      else if (citation.span !== null && (citation.span.blockId !== citation.passageId || !isValidSpan(citation.span, [passage]))) result.push(issue(["citations", index, "span"], "out_of_bounds", "The cited span must exist in this source's exact passage."));
      const key = JSON.stringify(citation);
      if (seen.has(key)) result.push(issue(["citations", index], "duplicate", "Cite each passage or span only once."));
      seen.add(key);
    });
    return result;
  },
});

export const descriptors = [stateTracingDescriptor, outcomePredictionDescriptor, causeDiagnosisDescriptor,
  experimentalInvestigationDescriptor, causalInterventionDescriptor, estimationDescriptor,
  strategySelectionDescriptor, sourceInvestigationDescriptor] as const;
