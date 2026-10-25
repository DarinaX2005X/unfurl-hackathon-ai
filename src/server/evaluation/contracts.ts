import "server-only";
import { z } from "zod";
import { IdSchema, JsonValueSchema, type JsonValue } from "../../domain/common";
import {
  ActivityResponseSchema, ActivitySessionPublicSchema, canonicalResponseJson, sameInputIdentity,
  type ActionReceipt, type ActivitySessionPublic, type InputSnapshot,
} from "../../domain/activity";
import type { Evaluation } from "../../domain/learning";
import type { MechanicId, TaskPublic } from "../../domain/mechanics";
import { LocalIdSchema, NonemptyTextSchema } from "../../domain/mechanic-families/v2/shared";
import type { PythonEvaluationPort } from "../execution/python/contracts";

export type GradeDecision =
  | { status: "evaluated"; outcome: "correct" | "partial" | "incorrect";
      dimensions: Evaluation["dimensions"]; feedback: Evaluation["feedback"] }
  | { status: "uncertain" | "unavailable"; outcome: null;
      dimensions: Evaluation["dimensions"]; feedback: Evaluation["feedback"] };

const DimensionStatusSchema = z.enum(["met", "partial", "not_met", "uncertain"]);
const dimensionsSchema = z.array(z.object({
  id: LocalIdSchema, status: DimensionStatusSchema, explanation: NonemptyTextSchema,
}).strict()).max(24);
const feedbackSchema = z.object({
  explanation: NonemptyTextSchema, nextAction: z.enum(["continue", "revise", "clarify", "wait"]),
}).strict();
export const GradeDecisionSchema: z.ZodType<GradeDecision> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("evaluated"), outcome: z.enum(["correct", "partial", "incorrect"]),
    dimensions: dimensionsSchema, feedback: feedbackSchema }).strict(),
  z.object({ status: z.enum(["uncertain", "unavailable"]), outcome: z.null(),
    dimensions: dimensionsSchema, feedback: feedbackSchema }).strict(),
]).superRefine((decision, context) => {
  if (new Set(decision.dimensions.map((dimension) => dimension.id)).size !== decision.dimensions.length) {
    context.addIssue({ code: "custom", path: ["dimensions"], message: "Dimensions must be unique" });
  }
  if (decision.status === "evaluated" && decision.dimensions.some((dimension) => dimension.status === "uncertain")) {
    context.addIssue({ code: "custom", path: ["dimensions"], message: "Unresolved dimensions cannot establish an outcome" });
  }
});

/**
 * Bounded evaluator view only. Learner services must still parse the full public
 * session and authorize enrollment; validation repositories bind a generation run,
 * step, candidate, approval and case before constructing this view.
 */
export const ActivityContextSessionSchema = z.object(ActivitySessionPublicSchema.shape).omit({ enrollmentId: true }).strict().superRefine((session, context) => {
  if (session.status === "budget_exhausted" && session.remainingActions !== 0) {
    context.addIssue({ code: "custom", path: ["remainingActions"], message: "An exhausted session has no remaining actions" });
  }
  const eventIds = new Set<string>();
  let previousSequence = 0;
  session.events.forEach((event, index) => {
    if (eventIds.has(event.id) || event.seq <= previousSequence || event.seq > session.revision) {
      context.addIssue({ code: "custom", path: ["events", index], message: "Events must be unique and in committed revision order" });
    }
    if (event.receipt.input.activitySessionId !== session.id || event.receipt.input.inputRevision > session.inputRevision) {
      context.addIssue({ code: "custom", path: ["events", index], message: "Receipt belongs to another session or a future input" });
    }
    previousSequence = event.seq;
    eventIds.add(event.id);
  });
});
export type ActivityContextSession = z.infer<typeof ActivityContextSessionSchema>;

/** Constructed by an authorized learner or generation-validation service from stored records, never browser history. */
export interface AuthoritativeActivity {
  session: ActivityContextSession | ActivitySessionPublic;
  input: InputSnapshot;
  receipts: readonly ActionReceipt[];
  /** Only stored historical inputs referenced by these receipts; content digests are verified by the service. */
  receiptInputs: readonly InputSnapshot[];
  assistance: "independent" | "hinted" | "worked_example";
  revealedFactIds: readonly string[];
  committedPredictionReceiptId: string | null;
  predictionBeforeObservation: boolean;
}

/**
 * Resolve a receipt's historical input, not the later submission that includes its ID.
 * The authorized service must verify stored snapshot digests before constructing activity.
 * This checks association only: evaluators still check receipt success and relevant authored fields.
 */
export function receiptInputFor(activity: AuthoritativeActivity | null, receiptId: string): InputSnapshot | null {
  if (activity === null) return null;
  const receipts = activity.receipts.filter((receipt) => receipt.id === receiptId);
  if (receipts.length !== 1) return null;
  const receipt = receipts[0]!;
  if (receipt.input.activitySessionId !== activity.session.id ||
      receipt.input.inputRevision > activity.session.inputRevision ||
      receipt.sessionRevision > activity.session.revision) return null;
  const inputs = activity.receiptInputs.filter((input) => sameInputIdentity(input, receipt.input));
  return inputs.length === 1 ? inputs[0]! : null;
}

export interface EvaluationContext {
  model: RubricJudge | null;
  signal: AbortSignal;
  /** A learning job binds this port to its trusted immutable input and execution claim. */
  python?: PythonEvaluationPort | null;
}
export interface EvaluatorRegistration<C extends JsonValue, R extends JsonValue, P, V extends 2 | 3 = 2> {
  id: MechanicId;
  version: V;
  privateSchema: z.ZodType<P>;
  evaluate(input: {
    task: TaskPublic<C>; response: R; privateData: P; activity: AuthoritativeActivity | null;
  }, context: EvaluationContext): Promise<GradeDecision>;
}

export const ResponsePathSchema = z.array(z.union([
  z.string().min(1).max(128).refine((key) => !["__proto__", "prototype", "constructor"].includes(key), "Reserved path segment"),
  z.number().int().nonnegative(),
])).max(12);
export type ResponsePath = z.infer<typeof ResponsePathSchema>;

/** Task material and reference facts are bounded data, never additions to trusted grading instructions. */
export const RubricContextSchema = z.object({
  instruction: z.string().min(1).max(20_000).refine((instruction) => instruction.trim().length > 0, "Instruction must be nonempty"),
  material: ActivityResponseSchema,
  referenceFacts: ActivityResponseSchema.optional(),
}).strict().superRefine((context, validation) => {
  const boundedContext: JsonValue = {
    instruction: context.instruction,
    material: context.material,
    ...(context.referenceFacts === undefined ? {} : { referenceFacts: context.referenceFacts }),
  };
  try { canonicalResponseJson(boundedContext); }
  catch {
    validation.addIssue({ code: "custom", message: "Combined rubric context must fit within 128 KiB of bounded, finite JSON" });
  }
});
export type RubricContext = z.infer<typeof RubricContextSchema>;

export const RubricRequestSchema = z.object({
  rubric: z.object({
    id: IdSchema,
    dimensions: z.array(z.object({
      id: LocalIdSchema, criterion: NonemptyTextSchema,
      met: NonemptyTextSchema, partial: NonemptyTextSchema, notMet: NonemptyTextSchema,
    }).strict()).min(1).max(24),
  }).strict(),
  response: JsonValueSchema,
  allowedResponsePaths: z.array(ResponsePathSchema).min(1).max(64),
  context: RubricContextSchema.optional(),
}).strict().superRefine((request, context) => {
  if (new Set(request.rubric.dimensions.map((dimension) => dimension.id)).size !== request.rubric.dimensions.length) {
    context.addIssue({ code: "custom", path: ["rubric", "dimensions"], message: "Rubric dimension IDs must be unique" });
  }
  const keys = request.allowedResponsePaths.map((path) => JSON.stringify(path));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["allowedResponsePaths"], message: "Allowed paths must be unique" });
  }
  request.allowedResponsePaths.forEach((path, index) => {
    if (!resolveResponsePath(request.response, path).found) {
      context.addIssue({ code: "custom", path: ["allowedResponsePaths", index], message: "Allowed path must exist in the actual response" });
    }
  });
});
export type RubricRequest = z.infer<typeof RubricRequestSchema>;

export const RubricUncertaintyReasonSchema = z.enum([
  "ambiguous_prompt", "valid_alternative", "missing_evidence", "unsupported_claim",
  "conflicting_criteria", "unavailable_modality",
]);
export const RubricEvidenceRefSchema = z.object({
  responsePath: ResponsePathSchema,
  span: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
    .refine((span) => span.end > span.start, "Evidence span must be nonempty").nullable(),
}).strict();
export const RubricJudgementSchema = z.object({
  dimensions: z.array(z.object({
    id: LocalIdSchema, status: DimensionStatusSchema,
    evidenceRefs: z.array(RubricEvidenceRefSchema).max(24), explanation: NonemptyTextSchema,
  }).strict()).min(1).max(24),
  feedback: NonemptyTextSchema,
  uncertainReasons: z.array(RubricUncertaintyReasonSchema).max(6),
}).strict();
export type RubricJudgement = z.infer<typeof RubricJudgementSchema>;

/** The later ModelPort adapter treats response text as data; its output is still untrusted. */
export interface RubricJudge {
  judge(request: RubricRequest, signal: AbortSignal): Promise<unknown>;
}

export function resolveResponsePath(response: JsonValue, path: ResponsePath):
  { found: true; value: JsonValue } | { found: false } {
  let current: JsonValue = response;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return { found: false };
    if (Array.isArray(current)) {
      if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0 || !Object.hasOwn(current, segment)) return { found: false };
      current = current[segment]!;
    } else {
      if (typeof segment !== "string" || ["__proto__", "prototype", "constructor"].includes(segment) || !Object.hasOwn(current, segment)) return { found: false };
      current = current[segment]!;
    }
  }
  return { found: true, value: current };
}

export function validateRubricJudgement(value: unknown, input: RubricRequest): RubricJudgement {
  const request = RubricRequestSchema.parse(input);
  const judgement = RubricJudgementSchema.parse(value);
  const required = new Set(request.rubric.dimensions.map((dimension) => dimension.id));
  const ids = judgement.dimensions.map((dimension) => dimension.id);
  if (new Set(ids).size !== ids.length || ids.length !== required.size || ids.some((id) => !required.has(id))) {
    throw new Error("Every required rubric dimension must occur exactly once");
  }
  if (new Set(judgement.uncertainReasons).size !== judgement.uncertainReasons.length) throw new Error("Uncertainty reasons must be unique");
  const hasUncertain = judgement.dimensions.some((dimension) => dimension.status === "uncertain");
  if (hasUncertain && judgement.uncertainReasons.length === 0) throw new Error("Uncertain judgement requires an explicit reason");
  const allowedPaths = new Set(request.allowedResponsePaths.map((path) => JSON.stringify(path)));
  for (const dimension of judgement.dimensions) {
    if (dimension.status !== "uncertain" && dimension.evidenceRefs.length === 0) throw new Error("A definite judgement needs response evidence");
    for (const evidence of dimension.evidenceRefs) {
      if (!allowedPaths.has(JSON.stringify(evidence.responsePath))) throw new Error("Evidence path is not allowed");
      const resolved = resolveResponsePath(request.response, evidence.responsePath);
      if (!resolved.found) throw new Error("Evidence path does not exist");
      if (evidence.span !== null && (typeof resolved.value !== "string" || evidence.span.end > resolved.value.length)) {
        throw new Error("Evidence span must exist in the actual response text");
      }
    }
  }
  return judgement;
}

function unresolvedDecision(request: RubricRequest, status: "uncertain" | "unavailable", explanation: string): GradeDecision {
  return {
    status, outcome: null,
    dimensions: request.rubric.dimensions.map((dimension) => ({ id: dimension.id, status: "uncertain", explanation })),
    feedback: { explanation, nextAction: status === "unavailable" ? "wait" : "clarify" },
  };
}

/** No provider or unverifiable output can turn into a wrong answer or account credit. */
export async function evaluateRubric(input: RubricRequest, context: EvaluationContext): Promise<GradeDecision> {
  const request = RubricRequestSchema.parse(input);
  context.signal.throwIfAborted();
  if (context.model === null) return unresolvedDecision(request, "unavailable", "This answer needs an assessment service that is not connected yet.");
  let output: unknown;
  try {
    output = await context.model.judge(request, context.signal);
    context.signal.throwIfAborted();
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    if (error instanceof Error && error.name === "AbortError") throw error;
    return unresolvedDecision(request, "unavailable", "The assessment service could not finish. Your response is retained for retry.");
  }
  let judgement: RubricJudgement;
  try { judgement = validateRubricJudgement(output, request); }
  catch { return unresolvedDecision(request, "uncertain", "The assessment evidence could not be verified. This answer needs another review."); }
  const dimensions = judgement.dimensions.map(({ id, status, explanation }) => ({ id, status, explanation }));
  if (judgement.uncertainReasons.length > 0 || dimensions.some((dimension) => dimension.status === "uncertain")) {
    return GradeDecisionSchema.parse({ status: "uncertain", outcome: null, dimensions,
      feedback: { explanation: judgement.feedback, nextAction: "clarify" } });
  }
  const outcome = dimensions.every((dimension) => dimension.status === "met") ? "correct" :
    dimensions.every((dimension) => dimension.status === "not_met") ? "incorrect" : "partial";
  return GradeDecisionSchema.parse({ status: "evaluated", outcome, dimensions,
    feedback: { explanation: judgement.feedback, nextAction: outcome === "correct" ? "continue" : "revise" } });
}
