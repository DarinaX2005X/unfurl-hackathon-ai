import "server-only";
import { z } from "zod";
import type { JsonValue } from "@/domain/common";
import type { TaskPublic } from "@/domain/mechanics";
import { canonicalResponseJson, validateInputSnapshot, type ActivityEventPublic } from "@/domain/activity";
import {
  InvestigationSourceSchema, OutcomePredictionResponseSchema, CausalInterventionResponseSchema,
  stateTracingDescriptor, outcomePredictionDescriptor, causeDiagnosisDescriptor,
  experimentalInvestigationDescriptor, causalInterventionDescriptor, estimationDescriptor,
  strategySelectionDescriptor, sourceInvestigationDescriptor,
  traceState, predictOutcome, experimentOutput, evaluateCausalModel,
  type StateTracingConfig, type StateTracingResponse, type OutcomePredictionConfig, type OutcomePredictionResponse,
  type CauseDiagnosisConfig, type CauseDiagnosisResponse, type ExperimentalInvestigationConfig, type ExperimentalInvestigationResponse,
  type CausalInterventionConfig, type CausalInterventionResponse, type EstimationConfig, type EstimationResponse,
  type StrategySelectionConfig, type StrategySelectionResponse, type SourceInvestigationConfig, type SourceInvestigationResponse,
} from "@/domain/mechanic-families/v2/investigation";
import {
  LocalIdSchema, MECHANIC_LIMITS, NumericToleranceSchema, QuantitySchema, convertQuantity,
  parseFamilyTask, parseFamilyResponse, withinTolerance,
  type FamilyDescriptor, type NumericTolerance, type Quantity,
} from "@/domain/mechanic-families/v2/shared";
import {
  GradeDecisionSchema, RubricRequestSchema, evaluateRubric, receiptInputFor,
  type AuthoritativeActivity, type EvaluationContext, type EvaluatorRegistration,
  type GradeDecision, type RubricRequest,
} from "../contracts";

const rubricSchema = RubricRequestSchema.shape.rubric.superRefine((rubric, context) => {
  if (new Set(rubric.dimensions.map((dimension) => dimension.id)).size !== rubric.dimensions.length) {
    context.addIssue({ code: "custom", path: ["dimensions"], message: "Reasoning dimensions must be unique" });
  }
});
const computedRubricSchema = rubricSchema.refine((rubric) => rubric.dimensions.length <= 23, "Leave one assessment dimension for computed evidence");
const localIds = z.array(LocalIdSchema).max(MECHANIC_LIMITS.variables)
  .refine((ids) => new Set(ids).size === ids.length, "Identifiers must be unique");
export const StateTracingPrivateSchema = z.object({ tolerance: NumericToleranceSchema }).strict();
export const OutcomePredictionPrivateSchema = z.object({ tolerance: NumericToleranceSchema }).strict();
export const CauseDiagnosisPrivateSchema = z.object({ consistentCauseIds: localIds.min(1), rubric: rubricSchema }).strict();
export const ExperimentalInvestigationPrivateSchema = z.object({ hiddenHypothesisId: LocalIdSchema, tolerance: NumericToleranceSchema, rubric: computedRubricSchema }).strict();
export const CausalInterventionPrivateSchema = z.object({ tolerance: NumericToleranceSchema }).strict();
export const EstimationPrivateSchema = z.object({
  referenceQuantity: QuantitySchema.refine((quantity) => quantity.value !== 0, "Relative interval width needs a nonzero reference"),
  tolerance: NumericToleranceSchema, basisRubric: computedRubricSchema,
}).strict();
export const StrategySelectionPrivateSchema = z.object({ admissibleStrategyIds: localIds, targetSpecified: z.boolean(), rubric: rubricSchema }).strict()
  .refine((data) => !data.targetSpecified || data.admissibleStrategyIds.length > 0, "A specified target needs an admissible strategy");
export const SourceInvestigationPrivateSchema = z.object({
  sources: z.array(InvestigationSourceSchema).min(1).max(MECHANIC_LIMITS.variables)
    .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length, "Provenance identifiers must be unique"),
  rubric: rubricSchema,
}).strict();
export type StateTracingPrivate = z.infer<typeof StateTracingPrivateSchema>;
export type OutcomePredictionPrivate = z.infer<typeof OutcomePredictionPrivateSchema>;
export type CauseDiagnosisPrivate = z.infer<typeof CauseDiagnosisPrivateSchema>;
export type ExperimentalInvestigationPrivate = z.infer<typeof ExperimentalInvestigationPrivateSchema>;
export type CausalInterventionPrivate = z.infer<typeof CausalInterventionPrivateSchema>;
export type EstimationPrivate = z.infer<typeof EstimationPrivateSchema>;
export type StrategySelectionPrivate = z.infer<typeof StrategySelectionPrivateSchema>;
export type SourceInvestigationPrivate = z.infer<typeof SourceInvestigationPrivateSchema>;

function unresolved(explanation: string, unavailable = false): GradeDecision {
  return { status: unavailable ? "unavailable" : "uncertain", outcome: null,
    dimensions: [{ id: "evidence", status: "uncertain", explanation }],
    feedback: { explanation, nextAction: unavailable ? "wait" : "clarify" } };
}
function decision(correct: boolean, explanation: string, id = "result"): GradeDecision {
  return { status: "evaluated", outcome: correct ? "correct" : "incorrect",
    dimensions: [{ id, status: correct ? "met" : "not_met", explanation }],
    feedback: { explanation, nextAction: correct ? "continue" : "revise" } };
}
function formCheck<C extends JsonValue, R extends JsonValue>(descriptor: FamilyDescriptor<C, R>, task: TaskPublic<C>, response: R): GradeDecision | null {
  try {
    const parsedTask = parseFamilyTask(descriptor, task);
    const parsedResponse = parseFamilyResponse(descriptor, response);
    const issues = descriptor.validateSubmission(parsedTask.config, parsedResponse);
    return issues.length ? unresolved(issues[0]!.message) : null;
  } catch { return unresolved("This response or task has an invalid structure. Correct the fields before checking it."); }
}
function combine(computed: GradeDecision, semantic: GradeDecision): GradeDecision {
  const dimensions = [...computed.dimensions, ...semantic.dimensions.map((dimension) => ({ ...dimension, id: `reasoning.${dimension.id}` }))];
  if (semantic.status !== "evaluated") return GradeDecisionSchema.parse({ ...semantic, dimensions });
  const outcome = computed.outcome === "correct" && semantic.outcome === "correct" ? "correct" :
    computed.outcome === "incorrect" && semantic.outcome === "incorrect" ? "incorrect" : "partial";
  return GradeDecisionSchema.parse({ status: "evaluated", outcome, dimensions,
    feedback: { explanation: `${computed.feedback.explanation} ${semantic.feedback.explanation}`, nextAction: outcome === "correct" ? "continue" : "revise" } });
}
function rubricRequest<C extends JsonValue, R extends JsonValue>(task: TaskPublic<C>, response: R,
  rubric: RubricRequest["rubric"], allowedResponsePaths: RubricRequest["allowedResponsePaths"], referenceFacts: JsonValue): RubricRequest {
  return { rubric, response, allowedResponsePaths, context: { instruction: task.instruction, material: task.config, referenceFacts } };
}
async function assess(request: RubricRequest, context: EvaluationContext): Promise<GradeDecision> {
  const parsed = RubricRequestSchema.safeParse(request);
  return parsed.success ? evaluateRubric(parsed.data, context) : unresolved("The task's assessment material could not be verified within its limits. Your response is kept for review.");
}
function matchesQuantity(actual: Quantity, expected: Quantity, tolerance: NumericTolerance): boolean {
  try { return withinTolerance(convertQuantity(actual, expected.unit).value, expected.value, tolerance); }
  catch { return false; }
}
function intervalResult(lower: number, upper: number, expected: number, maxWidth: number, tolerance: NumericTolerance): boolean {
  const width = upper - lower;
  const widthRounding = Math.max(1, Math.abs(width), Math.abs(maxWidth)) * Number.EPSILON * 8;
  return Number.isFinite(width) && (width <= maxWidth || width - maxWidth <= widthRounding) &&
    (lower <= expected || withinTolerance(lower, expected, tolerance)) &&
    (upper >= expected || withinTolerance(upper, expected, tolerance));
}

/** Activity is already authorized and loaded by the service; these checks prevent stale evidence joins. */
async function receiptEvidence<C extends JsonValue, R extends JsonValue>(activity: AuthoritativeActivity | null,
  task: TaskPublic<C>, response: R, receiptId: string, kind: ActivityEventPublic["action"]["kind"]): Promise<
    { ok: true; event: ActivityEventPublic; response: JsonValue } | { ok: false; grade: GradeDecision }
  > {
  if (!activity) return { ok: false, grade: unresolved("The saved activity is unavailable. Your response is retained for retry.", true) };
  const input = receiptInputFor(activity, receiptId);
  const events = activity.session.events.filter((event) => event.receipt.id === receiptId);
  const receipt = activity.receipts.find((item) => item.id === receiptId);
  if (!input || events.length !== 1 || !receipt || events[0]!.action.kind !== kind ||
      activity.session.taskId !== task.id || activity.session.taskVersion !== task.taskVersion ||
      activity.input.activitySessionId !== activity.session.id ||
      canonicalResponseJson(activity.input.response) !== canonicalResponseJson(response) ||
      canonicalResponseJson(events[0]!.receipt) !== canonicalResponseJson(receipt)) {
    return { ok: false, grade: unresolved("The observation does not match this saved activity and response. Its history cannot validate changed work.") };
  }
  try { await validateInputSnapshot(input); await validateInputSnapshot(activity.input); }
  catch { return { ok: false, grade: unresolved("The saved observation input could not be verified. This result needs another review.") }; }
  if (receipt.status !== "completed") return { ok: false, grade: unresolved("This observation has not completed. Your response is retained.", true) };
  if ((kind === "prediction.commit") !== (receipt.observation === null)) return { ok: false, grade: unresolved("This receipt does not contain the expected activity result.") };
  return { ok: true, event: events[0]!, response: input.response };
}

export const stateTracingEvaluator: EvaluatorRegistration<StateTracingConfig, StateTracingResponse, StateTracingPrivate> = {
  id: "state_tracing", version: 2, privateSchema: StateTracingPrivateSchema,
  async evaluate({ task, response, privateData }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(stateTracingDescriptor, task, response); if (invalid) return invalid;
    const data = StateTracingPrivateSchema.parse(privateData);
    const expected = traceState(task.config);
    const dimensions = expected.map((state, index) => {
      const correct = Object.entries(state).every(([name, value]) => withinTolerance(response.states[index]![name]!, value, data.tolerance));
      return { id: `step.${index + 1}`, status: correct ? "met" as const : "not_met" as const,
        explanation: correct ? `Step ${index + 1} follows the prior state and current input.` : `Recalculate step ${index + 1}; all updates read the previous state.` };
    });
    const outcome = dimensions.every((dimension) => dimension.status === "met") ? "correct" : dimensions.every((dimension) => dimension.status === "not_met") ? "incorrect" : "partial";
    return { status: "evaluated", outcome, dimensions, feedback: {
      explanation: outcome === "correct" ? "Every intermediate state follows the update rule." : "Check each intermediate state, including the sign and the prior value used in every update.",
      nextAction: outcome === "correct" ? "continue" : "revise",
    } };
  },
};

export const outcomePredictionEvaluator: EvaluatorRegistration<OutcomePredictionConfig, OutcomePredictionResponse, OutcomePredictionPrivate> = {
  id: "outcome_prediction", version: 2, privateSchema: OutcomePredictionPrivateSchema,
  async evaluate({ task, response, privateData, activity }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(outcomePredictionDescriptor, task, response); if (invalid) return invalid;
    const data = OutcomePredictionPrivateSchema.parse(privateData);
    const commit = await receiptEvidence(activity, task, response, response.commitReceiptId!, "prediction.commit"); if (!commit.ok) return commit.grade;
    const observation = await receiptEvidence(activity, task, response, response.observationReceiptId!, "run"); if (!observation.ok) return observation.grade;
    const committed = OutcomePredictionResponseSchema.safeParse(commit.response);
    const observedInput = OutcomePredictionResponseSchema.safeParse(observation.response);
    if (!committed.success || !observedInput.success || canonicalResponseJson(committed.data.interval) !== canonicalResponseJson(response.interval) ||
        canonicalResponseJson(observedInput.data.interval) !== canonicalResponseJson(response.interval) || observedInput.data.commitReceiptId !== response.commitReceiptId) {
      return unresolved("The interval changed after its commitment. The observation cannot establish an independent prediction for this edited answer.");
    }
    if (!activity!.predictionBeforeObservation || activity!.committedPredictionReceiptId !== response.commitReceiptId ||
        commit.event.seq >= observation.event.seq || activity!.session.events.some((event) => event.seq < commit.event.seq && event.receipt.status === "completed" && event.receipt.observation !== null)) {
      return unresolved("The result was observed before this prediction was committed. It is assisted evidence, not an independent prediction.");
    }
    const expected = predictOutcome(task.config);
    const observationData = observation.event.receipt.observation;
    const actual = observationData?.kind === "values" ? observationData.values.find((value) => value.id === expected.id) : null;
    if (!actual || !matchesQuantity(actual.quantity, expected.quantity, data.tolerance)) return unresolved("The saved observation disagrees with the declared model. This task needs review.");
    const lower = convertQuantity({ value: response.interval.lower!, unit: response.interval.unit! }, expected.quantity.unit).value;
    const upper = convertQuantity({ value: response.interval.upper!, unit: response.interval.unit! }, expected.quantity.unit).value;
    const correct = intervalResult(lower, upper, expected.quantity.value, task.config.maxIntervalWidth, data.tolerance);
    return decision(correct, correct ? "Your committed interval contains the observed result within the allowed width." : "The committed interval misses the result or is wider than the stated limit.", "prediction");
  },
};

export const causeDiagnosisEvaluator: EvaluatorRegistration<CauseDiagnosisConfig, CauseDiagnosisResponse, CauseDiagnosisPrivate> = {
  id: "cause_diagnosis", version: 2, privateSchema: CauseDiagnosisPrivateSchema,
  async evaluate({ task, response, privateData }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(causeDiagnosisDescriptor, task, response); if (invalid) return invalid;
    const data = CauseDiagnosisPrivateSchema.parse(privateData);
    if (data.consistentCauseIds.some((id) => !task.config.candidateCauses.some((cause) => cause.id === id))) return unresolved("The cause assessment refers to missing task material.");
    if (response.consistentCauseIds.some((id) => !data.consistentCauseIds.includes(id))) return decision(false, "At least one retained cause conflicts with the observations, including their stated scope or audit.", "consistency");
    if (response.conclusion === "identified" && (data.consistentCauseIds.length !== 1 || response.consistentCauseIds.length !== 1)) return decision(false, "These observations do not identify a unique cause. Retain the uncertainty and name a discriminating observation.", "identification");
    return assess(rubricRequest(task, response, data.rubric, [["conclusion"], ["consistentCauseIds"], ["neededEvidence"]], { consistentCauseIds: data.consistentCauseIds }), context);
  },
};

/** Server action handlers may use this only after selecting the session's private fixed hypothesis. */
export function experimentalObservation(config: ExperimentalInvestigationConfig, hiddenHypothesisId: string, input: number) {
  return { kind: "values" as const, values: [{ id: "outcome", quantity: { value: experimentOutput(config, hiddenHypothesisId, input), unit: "unitless" as const } }] };
}
export function hasDistinguishableHypotheses(config: ExperimentalInvestigationConfig, tolerance: NumericTolerance): boolean {
  return config.hypotheses.every((hypothesis, index) => config.hypotheses.slice(index + 1).every((other) =>
    config.allowedInputs.some((input) => {
      const left = experimentOutput(config, hypothesis.id, input);
      const right = experimentOutput(config, other.id, input);
      return !withinTolerance(left, right, tolerance) && !withinTolerance(right, left, tolerance);
    })));
}
export const experimentalInvestigationEvaluator: EvaluatorRegistration<ExperimentalInvestigationConfig, ExperimentalInvestigationResponse, ExperimentalInvestigationPrivate> = {
  id: "experimental_investigation", version: 2, privateSchema: ExperimentalInvestigationPrivateSchema,
  async evaluate({ task, response, privateData, activity }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(experimentalInvestigationDescriptor, task, response); if (invalid) return invalid;
    const data = ExperimentalInvestigationPrivateSchema.parse(privateData);
    if (!task.config.hypotheses.some((hypothesis) => hypothesis.id === data.hiddenHypothesisId)) return unresolved("The experiment's fixed hypothesis is missing from its declared model.");
    if (!hasDistinguishableHypotheses(task.config, data.tolerance)) return unresolved("These hypotheses cannot be separated within the assessment tolerance. This experiment needs review.");
    const observations: Array<{ input: number; output: number }> = [];
    for (const id of response.observationReceiptIds) {
      context.signal.throwIfAborted();
      const evidence = await receiptEvidence(activity, task, response, id, "experiment.query"); if (!evidence.ok) return evidence.grade;
      const action = evidence.event.action;
      const observed = evidence.event.receipt.observation;
      if (action.kind !== "experiment.query" || !task.config.allowedInputs.includes(action.input) || observed?.kind !== "values") return unresolved("A cited measurement does not use an allowed experiment input.");
      const actual = observed.values.find((value) => value.id === "outcome");
      const expected = experimentOutput(task.config, data.hiddenHypothesisId, action.input);
      if (!actual || !matchesQuantity(actual.quantity, { value: expected, unit: "unitless" }, data.tolerance)) return unresolved("A saved measurement does not match the fixed experimental model.");
      observations.push({ input: action.input, output: expected });
    }
    if (activity!.session.events.filter((event) => event.action.kind === "experiment.query").length > task.config.queryBudget) return unresolved("The experiment history exceeds its authorized query budget.");
    const remaining = task.config.hypotheses.filter((hypothesis) => observations.every(({ input, output }) => withinTolerance(experimentOutput(task.config, hypothesis.id, input), output, data.tolerance))).map((hypothesis) => hypothesis.id);
    if (response.conclusionHypothesisId !== null && (remaining.length !== 1 || remaining[0] !== response.conclusionHypothesisId)) {
      return decision(false, remaining.length > 1 ? "The chosen measurements leave multiple hypotheses consistent with the observations." : "The claimed hypothesis conflicts with the measured result.", "identification");
    }
    const semantic = await assess(rubricRequest(task, response, data.rubric, [["rationale"], ["conclusionHypothesisId"]], { observations, consistentHypothesisIds: remaining }), context);
    if (semantic.status !== "evaluated") return semantic;
    if (response.conclusionHypothesisId === null) return { status: "uncertain", outcome: null, dimensions: [
      ...semantic.dimensions.map((dimension) => ({ ...dimension, id: `reasoning.${dimension.id}` })),
      { id: "identification", status: "uncertain", explanation: "No hypothesis was identified; the measurements and explanation remain available." },
    ], feedback: { explanation: remaining.length > 1 ? "The evidence is inconclusive. A measurement that separates the remaining hypotheses is needed." : "The measurements distinguish a hypothesis. State which one they support when you are ready.", nextAction: "clarify" } };
    return combine(decision(true, "Your chosen measurement distinguishes the identified hypothesis.", "identification"), semantic);
  },
};

export const causalInterventionEvaluator: EvaluatorRegistration<CausalInterventionConfig, CausalInterventionResponse, CausalInterventionPrivate> = {
  id: "causal_intervention", version: 2, privateSchema: CausalInterventionPrivateSchema,
  async evaluate({ task, response, privateData, activity }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(causalInterventionDescriptor, task, response); if (invalid) return invalid;
    const data = CausalInterventionPrivateSchema.parse(privateData);
    const evidence = await receiptEvidence(activity, task, response, response.observationReceiptId!, "intervention.apply"); if (!evidence.ok) return evidence.grade;
    const stored = CausalInterventionResponseSchema.safeParse(evidence.response);
    if (!stored.success || evidence.event.action.kind !== "intervention.apply" ||
        canonicalResponseJson(stored.data.assignments) !== canonicalResponseJson(response.assignments) ||
        canonicalResponseJson(evidence.event.action.assignments) !== canonicalResponseJson(response.assignments)) return unresolved("The input assignments changed after this observation. Apply the edited intervention before checking it.");
    if (activity!.session.events.filter((event) => event.action.kind === "intervention.apply").length > task.config.actionBudget) return unresolved("The intervention history exceeds its authorized action budget.");
    const expected = evaluateCausalModel(task.config, response.assignments as Record<string, number>).find((value) => value.id === task.config.target.variableId)!;
    const observed = evidence.event.receipt.observation;
    const actual = observed?.kind === "values" ? observed.values.find((value) => value.id === expected.id) : null;
    if (!actual || !matchesQuantity(actual.quantity, expected.quantity, data.tolerance)) return unresolved("The saved observation disagrees with the structural equations. This task needs review.");
    const correct = matchesQuantity(expected.quantity, task.config.target.quantity, data.tolerance);
    return decision(correct, correct ? "The input intervention produces the target value in this structural model." : "The intervention produces a different value from the target. Recalculate the derived variables.", "target");
  },
};

export const estimationEvaluator: EvaluatorRegistration<EstimationConfig, EstimationResponse, EstimationPrivate> = {
  id: "estimation", version: 2, privateSchema: EstimationPrivateSchema,
  async evaluate({ task, response, privateData }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(estimationDescriptor, task, response); if (invalid) return invalid;
    const parsed = EstimationPrivateSchema.safeParse(privateData);
    if (!parsed.success) return unresolved("The reference quantity cannot support this relative-width estimate. This task needs review.");
    const data = parsed.data;
    let lower: number; let upper: number;
    try {
      lower = convertQuantity({ value: response.lower!, unit: response.unit! }, data.referenceQuantity.unit).value;
      upper = convertQuantity({ value: response.upper!, unit: response.unit! }, data.referenceQuantity.unit).value;
    } catch { return unresolved("The estimate and reference quantity use incompatible dimensions. This task needs review."); }
    const maxWidth = Math.abs(data.referenceQuantity.value) * task.config.maxRelativeIntervalWidth;
    if (!Number.isFinite(maxWidth)) return unresolved("The permitted interval is outside the finite numeric range. This task needs review.");
    const numeric = intervalResult(lower, upper, data.referenceQuantity.value, maxWidth, data.tolerance);
    if (!numeric) return decision(false, "The interval misses the reference scale or exceeds the permitted relative width. Check the unit conversion and calculation.", "quantity");
    const semantic = await assess(rubricRequest(task, response, data.basisRubric, [["basis"]], { referenceQuantity: data.referenceQuantity, normalizedLower: lower, normalizedUpper: upper }), context);
    return combine(decision(true, "The normalized interval covers the reference quantity within the allowed relative width.", "quantity"), semantic);
  },
};

export const strategySelectionEvaluator: EvaluatorRegistration<StrategySelectionConfig, StrategySelectionResponse, StrategySelectionPrivate> = {
  id: "strategy_selection", version: 2, privateSchema: StrategySelectionPrivateSchema,
  async evaluate({ task, response, privateData }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(strategySelectionDescriptor, task, response); if (invalid) return invalid;
    const data = StrategySelectionPrivateSchema.parse(privateData);
    if (!data.targetSpecified) return unresolved("The intended deployment or decision target is not specified well enough to choose one strategy. Clarify that target first.");
    if (data.admissibleStrategyIds.some((id) => !task.config.strategies.some((strategy) => strategy.id === id))) return unresolved("The assessment refers to a strategy absent from the task.");
    if (!data.admissibleStrategyIds.includes(response.strategyId!)) return decision(false, "The selected strategy does not meet every stated constraint for this target.", "admissibility");
    return assess(rubricRequest(task, response, data.rubric, [["strategyId"], ["assumptions"], ["justification"]], { admissibleStrategyIds: data.admissibleStrategyIds }), context);
  },
};

/** Readiness and evaluation use the same exact course research snapshot comparison. */
export function hasSourceProvenance(config: SourceInvestigationConfig, data: SourceInvestigationPrivate): boolean {
  return config.sources.every((source) => {
    const authoritative = data.sources.find((item) => item.id === source.id);
    return authoritative !== undefined && canonicalResponseJson(source) === canonicalResponseJson(authoritative);
  });
}
export const sourceInvestigationEvaluator: EvaluatorRegistration<SourceInvestigationConfig, SourceInvestigationResponse, SourceInvestigationPrivate> = {
  id: "source_investigation", version: 2, privateSchema: SourceInvestigationPrivateSchema,
  async evaluate({ task, response, privateData }, context) {
    context.signal.throwIfAborted();
    const invalid = formCheck(sourceInvestigationDescriptor, task, response); if (invalid) return invalid;
    const data = SourceInvestigationPrivateSchema.parse(privateData);
    if (!hasSourceProvenance(task.config, data)) return unresolved("The cited material does not match the course's versioned research. It cannot be assessed as verified source evidence.");
    const citedPassages = response.citations.map((citation) => {
      const source = data.sources.find((item) => item.id === citation.sourceId)!;
      const passage = source.passages.find((item) => item.id === citation.passageId)!;
      return { sourceId: source.id, url: source.url, contentDigest: source.contentDigest, passageId: passage.id,
        text: citation.span ? passage.text.slice(citation.span.start, citation.span.end) : passage.text };
    });
    return assess(rubricRequest(task, response, data.rubric, [["verdict"], ["citations"], ["explanation"]], { citedPassages }), context);
  },
};

export const evaluators = [stateTracingEvaluator, outcomePredictionEvaluator, causeDiagnosisEvaluator,
  experimentalInvestigationEvaluator, causalInterventionEvaluator, estimationEvaluator,
  strategySelectionEvaluator, sourceInvestigationEvaluator] as const;
