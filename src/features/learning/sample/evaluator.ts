import { SampleAttemptSchema, SampleEvaluationSchema, type Evaluation, type SampleAttempt } from "@/domain";
import { CapacityResponseSchema, SAMPLE_TASK_ID } from "./content";
import { fitPolynomial } from "./numerics";

export interface SampleReceipt { attempt: SampleAttempt; evaluation: Evaluation }

export class SampleConflictError extends Error {
  constructor() { super("This submission key already belongs to a different answer. Edit your answer and check it again."); }
}

export function sampleAttemptBody(attempt: SampleAttempt): string {
  const parsed = SampleAttemptSchema.parse(attempt);
  // Schema parsing gives the fields a fixed order, including the concrete response.
  return JSON.stringify({ ...parsed, response: CapacityResponseSchema.parse(parsed.response) });
}

/** This deterministic evaluator is deliberately limited to the public practice sample. */
export function evaluateSampleAttempt(input: SampleAttempt, receipts: ReadonlyArray<SampleReceipt>): SampleReceipt {
  const attempt = SampleAttemptSchema.parse(input);
  if (attempt.taskId !== SAMPLE_TASK_ID || attempt.taskVersion !== 1) throw new Error("This practice task is not supported.");
  const response = CapacityResponseSchema.parse(attempt.response);
  const existing = receipts.find((receipt) => receipt.attempt.idempotencyKey === attempt.idempotencyKey);
  if (existing) {
    if (sampleAttemptBody(existing.attempt) !== sampleAttemptBody(attempt)) throw new SampleConflictError();
    return existing;
  }
  const fit = fitPolynomial(response.degree, response.lambda);
  const modelMet = fit.validationRmse < 0.21;
  const reasonMet = response.explanation === "noise";
  const correct = modelMet && reasonMet;
  const modelExplanation = modelMet
    ? `Your validation error is ${fit.validationRmse.toFixed(3)}, below the 0.210 target.`
    : `Your validation error is ${fit.validationRmse.toFixed(3)}. Try a less flexible model or a small regularization penalty to get below 0.210.`;
  const reasonExplanation = reasonMet
    ? "A model can memorize noise in training data. The separate validation points help reveal that mismatch."
    : response.explanation === null
      ? "Choose an explanation for why zero training error is not enough."
      : "Zero training error describes only the points the model saw. It cannot guarantee predictions on new points.";
  const evaluation = SampleEvaluationSchema.parse({
    id: crypto.randomUUID(), attemptId: attempt.id, status: "evaluated",
    outcome: correct ? "correct" : modelMet || reasonMet ? "partial" : "incorrect",
    dimensions: [
      { id: "validation-error", status: modelMet ? "met" : "not_met", explanation: modelExplanation },
      { id: "generalization", status: reasonMet ? "met" : "not_met", explanation: reasonExplanation },
    ],
    feedback: {
      explanation: correct
        ? "You found a better balance. Because you used validation data to choose this model, a fresh test set is still needed for an independent estimate of performance. No finite test guarantees every future prediction."
        : `${modelExplanation} ${reasonExplanation}`,
      nextAction: correct ? "continue" : "revise",
    },
    awardedXp: 0,
  });
  return { attempt, evaluation };
}
