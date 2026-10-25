import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonValueSchema, type JsonValue } from "@/domain/common";
import { PreparedTaskCandidateSchema, type PreparedTaskCandidate } from "@/server/mechanics/contracts";
import { getServerMechanic } from "@/server/mechanics/registry";
import { GradeDecisionSchema, RubricJudgementSchema, RubricRequestSchema, type RubricJudge, type RubricRequest } from "@/server/evaluation/contracts";
import { createRubricJudge } from "@/server/ai/rubric-judge";
import type { ModelPort } from "@/server/ai/ports";
import type { StepEffectContext } from "@/server/runs/ports";
import { ProviderFailure } from "@/server/ai/failure";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { taskDigest } from "@/server/mechanics/digest";

export const ProposedResponseCaseSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  category: z.enum(["valid", "alternative", "invalid"]), response: JsonValueSchema,
}).strict();
export const ResponseCaseSchema = ProposedResponseCaseSchema.extend({ caseId: IdSchema }).strict();
export type ResponseCase = z.infer<typeof ResponseCaseSchema>;
export const CaseEvaluationInputSchema = z.object({ candidate: PreparedTaskCandidateSchema, test: ResponseCaseSchema }).strict();
export const CaseEvaluationResultSchema = z.object({
  kind: z.literal("course.response_case"), candidateDigest: DigestSchema, caseId: IdSchema,
  category: z.enum(["valid", "alternative", "invalid"]), response: JsonValueSchema,
  decision: GradeDecisionSchema.nullable(), rejectedAsInvalid: z.boolean(),
  modelCallId: IdSchema.nullable(), rubricRequest: RubricRequestSchema.nullable(), rubricJudgement: RubricJudgementSchema.nullable(),
  activityEvidenceRef: IdSchema.nullable(),
}).strict();
export type CaseEvaluationResult = z.infer<typeof CaseEvaluationResultSchema>;

/** One case per durable effect. Case labels never enter the grader's request. */
export async function evaluateResponseCase(input: {
  candidate: PreparedTaskCandidate; test: ResponseCase; context: StepEffectContext;
  model: ModelPort | null; deadlineAt: number;
}): Promise<CaseEvaluationResult> {
  const { candidate, test } = CaseEvaluationInputSchema.parse({ candidate: input.candidate, test: input.test });
  if (input.context.signal.aborted) throw new ProviderFailure("cancelled");
  const fresh = prepareTaskCandidate({ task: candidate.task, privateTask: candidate.privateTask }, { approvalDigest: candidate.approvalDigest });
  if (taskDigest(fresh) !== taskDigest(candidate)) throw new ProviderFailure("invalid_output");
  const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion);
  if (!handle) throw new ProviderFailure("unavailable");
  const base = { kind: "course.response_case" as const, candidateDigest: candidate.candidateDigest,
    caseId: test.caseId, category: test.category, response: test.response,
    modelCallId: null, rubricRequest: null, rubricJudgement: null, activityEvidenceRef: null };
  let response: JsonValue;
  try {
    response = handle.parseResponse(test.response);
    if (handle.descriptor.validateSubmission(candidate.task.config, response).length) throw new Error();
  } catch { return CaseEvaluationResultSchema.parse({ ...base, decision: null, rejectedAsInvalid: true }); }
  // Real validation activity/execution histories need their own persisted target and owner authority.
  // Until those producers are supplied, never synthesize an enrollment, observation or execution receipt.
  if (handle.descriptor.requirements.includes("activity") || handle.descriptor.requirements.includes("sandbox")) throw new ProviderFailure("unavailable");
  const captured: { request: RubricRequest | null; judgement: z.infer<typeof RubricJudgementSchema> | null; operationId: string | null } = { request: null, judgement: null, operationId: null };
  let judge: RubricJudge | null = null;
  if (input.model) {
    const budget = input.context.budgetOperation("case-rubric");
    const actual = createRubricJudge(input.model, { budget, deadlineAt: input.deadlineAt });
    judge = { async judge(request, signal) {
      if (captured.request !== null) throw new ProviderFailure("unavailable");
      captured.request = RubricRequestSchema.parse(request);
      const result = await actual.judge(captured.request, signal);
      captured.judgement = RubricJudgementSchema.parse(result);
      captured.operationId = budget.reservationId;
      return result;
    } };
  }
  const decision = await handle.evaluate({ task: candidate.task, privateData: candidate.privateTask.evaluatorData, response, activity: null }, { model: judge, signal: input.context.signal });
  return CaseEvaluationResultSchema.parse({ ...base, decision, rejectedAsInvalid: false,
    modelCallId: captured.operationId, rubricRequest: captured.judgement === null ? null : captured.request, rubricJudgement: captured.judgement });
}
