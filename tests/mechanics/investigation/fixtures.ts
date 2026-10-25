import type { JsonValue } from "@/domain/common";
import type { TaskPublic, MechanicId } from "@/domain/mechanics";
import { responseDigest, type ActivityAction, type ActionReceipt, type InputSnapshot, type PublicObservation } from "@/domain/activity";
import {
  StateTracingConfigSchema, OutcomePredictionConfigSchema, CauseDiagnosisConfigSchema, ExperimentalInvestigationConfigSchema,
  CausalInterventionConfigSchema, EstimationConfigSchema, StrategySelectionConfigSchema, SourceInvestigationConfigSchema,
  type OutcomePredictionResponse, type CausalInterventionResponse, type ExperimentalInvestigationResponse,
} from "@/domain/mechanic-families/v2/investigation";
import type { Expr } from "@/domain/mechanic-families/v2/shared";
import type { AuthoritativeActivity, EvaluationContext, RubricRequest } from "@/server/evaluation/contracts";

export const constant = (value: number): Expr => ({ op: "constant", value });
export const variable = (name: string): Expr => ({ op: "variable", name });
export const multiply = (left: Expr, right: Expr): Expr => ({ op: "multiply", left, right });
export const add = (left: Expr, right: Expr): Expr => ({ op: "add", left, right });
export const tolerance = { absTol: 1e-8, relTol: 1e-9 };
export const rubric = { id: crypto.randomUUID(), dimensions: [{ id: "scope", criterion: "Use the supplied observations and respect the stated scope.", met: "Reasoning follows the evidence and names its limits.", partial: "Reasoning is partly supported but a limit is missing.", notMet: "The claim conflicts with the evidence or asserts an unsupported guarantee." }] };
export function context(status: "met" | "not_met" | "uncertain" = "met", inspect?: (request: RubricRequest) => void): EvaluationContext {
  return { signal: new AbortController().signal, model: { async judge(request) {
    inspect?.(request);
    return { dimensions: request.rubric.dimensions.map((dimension) => ({ id: dimension.id, status,
      explanation: status === "met" ? "Fixture assessment: reasoning respects the supplied evidence." : status === "not_met" ? "Fixture assessment: the guarantee exceeds the supplied evidence." : "Fixture assessment: the evidence remains ambiguous.",
      evidenceRefs: status === "uncertain" ? [] : [{ responsePath: request.allowedResponsePaths[0]!, span: null }],
    })), feedback: "Synthetic rubric boundary result for this test only.", uncertainReasons: status === "uncertain" ? ["missing_evidence"] : [] };
  } } };
}
export const unavailable = (): EvaluationContext => ({ model: null, signal: new AbortController().signal });
export function task<C extends JsonValue & { kind: MechanicId }>(config: C): TaskPublic<C> {
  return { id: crypto.randomUUID(), taskVersion: 1, mechanicId: config.kind, mechanicVersion: 2, responseSchemaVersion: 2,
    outcomeIds: [crypto.randomUUID()], instruction: "Synthetic mechanics acceptance fixture. Use the declared facts and model.", contentLanguage: "en", config, availableHints: 0 };
}
export const tracing = StateTracingConfigSchema.parse({ kind: "state_tracing", initial: { w: 0 }, inputs: [{ eta: .1, gradient: 2 }, { eta: .1, gradient: -1 }],
  updates: { w: { op: "subtract", left: variable("w"), right: multiply(variable("eta"), variable("gradient")) } }, units: { w: "unitless" } });
export const prediction = OutcomePredictionConfigSchema.parse({ kind: "outcome_prediction", model: {
  inputs: [{ id: "x", min: 0, max: 5, step: 1, unit: "unitless" }], outputs: [{ id: "y", unit: "unitless", expression: add(multiply(constant(2), variable("x")), constant(1)) }],
}, settings: { x: 3 }, targetOutputId: "y", allowedUnits: ["unitless"], maxIntervalWidth: .5 });
export const diagnosis = CauseDiagnosisConfigSchema.parse({ kind: "cause_diagnosis", observations: [
  { id: "shift", text: "Performance declined on a new organization compared with known organizations." },
  { id: "audit", text: "An audit confirms preprocessing was fitted only on training rows." },
], candidateCauses: [{ id: "covariate", text: "The input distribution changed." }, { id: "conditional", text: "The relationship between inputs and outcomes changed." }, { id: "leakage", text: "Preprocessing used validation rows during fitting." }] });
export const experiment = ExperimentalInvestigationConfigSchema.parse({ kind: "experimental_investigation", hypotheses: [{ id: "h1", expression: variable("x") }, { id: "h2", expression: multiply(constant(2), variable("x")) }], inputVariable: "x", allowedInputs: [0, 1, 2], queryBudget: 3 });
export const intervention = CausalInterventionConfigSchema.parse({ kind: "causal_intervention", variables: [
  { id: "x", min: -2, max: 2, step: 1, unit: "unitless" }, { id: "z", min: -2, max: 2, step: 1, unit: "unitless" },
], equations: { y: add(multiply(constant(2), variable("x")), variable("z")) }, target: { variableId: "y", quantity: { value: 4, unit: "unitless" } }, actionBudget: 3 });
export const estimation = EstimationConfigSchema.parse({ kind: "estimation", facts: [{ id: "parameters", text: "There are 1,000,000 parameters stored at 4 bytes each; exclude overhead." }], requestedQuantity: "Parameter storage excluding overhead", allowedUnits: ["byte", "KB", "MB"], maxRelativeIntervalWidth: .11 });
export const strategy = StrategySelectionConfigSchema.parse({ kind: "strategy_selection", situation: [{ id: "deployment", text: "Evaluate future observations at previously unseen organizations." }], strategies: [
  { id: "holdout", text: "Hold out organizations and later observations for final evaluation." },
  { id: "random", text: "Randomly split every row without respecting time or organization." },
  { id: "nested", text: "Use nested validation for selection and the same required final organization and time holdout." },
], constraints: [{ id: "unseen", text: "Final evaluation must represent unseen organizations." }, { id: "future", text: "Final evaluation must represent later observations." }] });
// Deliberately synthetic material with a reserved non-resolving domain; not an attributed real quotation.
export const source = SourceInvestigationConfigSchema.parse({ kind: "source_investigation", claim: "Train-fitted preprocessing guarantees robust predictions at every new organization.", sources: [{ id: "synthetic", url: "https://example.invalid/synthetic-preprocessing", title: "Synthetic preprocessing fixture", retrievedAt: "2026-10-25T00:00:00.000Z", contentDigest: "a".repeat(64), passages: [{ id: "scope", text: "Synthetic fixture: fitting preprocessing on training data avoids using held-out data to determine preprocessing parameters. This says nothing about robustness at new organizations." }] }] });

type Step = { id: string; action: ActivityAction; response: JsonValue; observation: PublicObservation | null };
export async function activity<C extends JsonValue, R extends JsonValue>(currentTask: TaskPublic<C>, finalResponse: R, steps: Step[]): Promise<AuthoritativeActivity> {
  const sessionId = crypto.randomUUID();
  const receiptInputs: InputSnapshot[] = [];
  const receipts: ActionReceipt[] = [];
  const events = [];
  for (const [index, step] of steps.entries()) {
    const input = { activitySessionId: sessionId, inputRevision: index + 1, responseDigest: await responseDigest(step.response), response: structuredClone(step.response) };
    receiptInputs.push(input);
    const identity = { activitySessionId: sessionId, inputRevision: input.inputRevision, responseDigest: input.responseDigest };
    const receipt: ActionReceipt = { id: step.id, clientActionId: crypto.randomUUID(), input: identity, sessionRevision: index + 1, status: "completed", observation: step.observation };
    receipts.push(receipt);
    events.push({ id: crypto.randomUUID(), seq: index + 1, at: "2026-10-25T00:00:00.000Z", action: step.action, receipt });
  }
  return { session: { id: sessionId, enrollmentId: crypto.randomUUID(), taskId: currentTask.id, taskVersion: currentTask.taskVersion, revision: Math.max(1, steps.length), inputRevision: steps.length + 1, status: "active", remainingActions: 3, events },
    input: { activitySessionId: sessionId, inputRevision: steps.length + 1, responseDigest: await responseDigest(finalResponse), response: finalResponse },
    receipts, receiptInputs, assistance: "independent", revealedFactIds: [],
    committedPredictionReceiptId: steps.find((step) => step.action.kind === "prediction.commit")?.id ?? null, predictionBeforeObservation: true };
}
export async function predictionCase(lower = 6.9, upper = 7.1) {
  const currentTask = task(prediction);
  const response: OutcomePredictionResponse = { kind: "outcome_prediction", action: "predict", interval: { lower, upper, unit: "unitless" }, commitReceiptId: crypto.randomUUID(), observationReceiptId: crypto.randomUUID() };
  const saved = await activity(currentTask, response, [
    { id: response.commitReceiptId!, action: { kind: "prediction.commit" }, response: { ...response, commitReceiptId: null, observationReceiptId: null }, observation: null },
    { id: response.observationReceiptId!, action: { kind: "run" }, response: { ...response, observationReceiptId: null }, observation: { kind: "values", values: [{ id: "y", quantity: { value: 7, unit: "unitless" } }] } },
  ]);
  return { task: currentTask, response, privateData: { tolerance }, activity: saved };
}
export async function interventionCase(x = 2, z = 0) {
  const currentTask = task(intervention);
  const response: CausalInterventionResponse = { kind: "causal_intervention", action: "intervene", assignments: { x, z }, observationReceiptId: crypto.randomUUID() };
  return { task: currentTask, response, privateData: { tolerance }, activity: await activity(currentTask, response, [{ id: response.observationReceiptId!, action: { kind: "intervention.apply", assignments: { x, z } }, response: { ...response, observationReceiptId: null }, observation: { kind: "values", values: [{ id: "y", quantity: { value: 2 * x + z, unit: "unitless" } }] } }]) };
}
export async function experimentCase(input = 1, conclusionHypothesisId: string | null = "h2") {
  const currentTask = task(experiment);
  const id = crypto.randomUUID();
  const response: ExperimentalInvestigationResponse = { kind: "experimental_investigation", action: "investigate", observationReceiptIds: [id], conclusionHypothesisId, rationale: `At x=${input}, the measured output is ${2 * input}. Compare the hypotheses at that input.` };
  return { task: currentTask, response, privateData: { hiddenHypothesisId: "h2", tolerance, rubric }, activity: await activity(currentTask, response, [{ id, action: { kind: "experiment.query", input }, response: { ...response, observationReceiptIds: [], conclusionHypothesisId: null, rationale: "" }, observation: { kind: "values", values: [{ id: "outcome", quantity: { value: 2 * input, unit: "unitless" } }] } }]) };
}
