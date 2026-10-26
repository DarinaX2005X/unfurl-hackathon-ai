import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DbTransaction } from "@/server/db";
import type { StepEffectContext } from "@/server/runs/ports";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { TaskValidationRepository } from "@/server/course-validation/receipts";
import { GenerationEvidenceRepository } from "@/server/course-generation/repository";
import { prepareTaskCasesCheckpoint, COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { CONTENT_REVIEW_CATEGORIES, createContentReviewInput } from "@/server/course-validation/content-review";
import { evaluateResponseCase } from "@/server/course-validation/case-evaluation";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { modelPolicy, type ModelPolicyId } from "@/server/ai/model-policy";
import { jsonDigest } from "@/server/ai/json";
import { preparedFixture, id, digest } from "./fixtures";

/** Synthetic storage exercises the real receipt assembler/evaluators; never used as paid production evidence. */
async function receiptFixture(policyId: ModelPolicyId) {
  const data = preparedFixture(), candidate = data.modules[0]!.tasks[0]!.candidate, authored = data.authored[0]!.tasks[0]!;
  const refs = { candidateStepId: id(700), casePlanStepId: id(701), reviewStepId: id(702), caseStepIds: [id(703), id(704), id(705)], specializedReviewStepIds: [] };
  const correct = { kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: 2, intercept: 1 }, probeValues: [7] };
  const proposal = { cases: [
    { key: "valid", category: "valid", response: correct },
    { key: "alternative", category: "alternative", response: { ...correct, rule: { form: "expression", expression: { op: "add",
      left: { op: "multiply", left: { op: "constant", value: 2 }, right: { op: "variable", name: "x" } }, right: { op: "constant", value: 1 } } } } },
    { key: "wrong", category: "invalid", response: { ...correct, probeValues: [9] } },
  ], alternativeSpaceProof: null };
  const planned = prepareTaskCasesCheckpoint({ candidateStepId: refs.candidateStepId, candidateDigest: candidate.candidateDigest, operationId: id(710), proposal });
  const material = createContentReviewInput({ candidate, criteria: data.knowledge[0]!.outcomes[0]!.criteria,
    learnerAction: data.knowledge[0]!.outcomes[0]!.learnerAction, claims: data.claims, passages: [data.passage] });
  const review = { candidateDigest: candidate.candidateDigest, checks: CONTENT_REVIEW_CATEGORIES.map(category => ({ category, status: "passed", explanation: "Synthetic contract review." })), findings: [] };
  const steps = new Map<string, unknown>([[refs.casePlanStepId, planned], [refs.reviewStepId,
    { kind: "course.task.review", candidateStepId: refs.candidateStepId, operationId: id(711), material, review }]]);
  const effect = { signal: new AbortController().signal, budgetOperation() { throw new Error("No paid call is allowed in this contract test"); } } as unknown as StepEffectContext;
  for (const [index, test] of planned.cases.entries()) steps.set(refs.caseStepIds[index]!, await evaluateResponseCase({ candidate, test, context: effect, model: null, deadlineAt: Date.now() + 10000 }));
  const policy = modelPolicy(policyId), rate_card = { model: policy.model, provider: policy.provider, policyVersion: policy.id };
  const providers = new Map([[id(710), { stepId: refs.casePlanStepId, content: proposal }], [id(711), { stepId: refs.reviewStepId, content: review }]]);
  const tx = { query: vi.fn(async (sql: string, values: unknown[]) => {
    const key = String(values[0]);
    if (sql.includes("FROM unfurl.ai_provider_operations")) {
      const operation = providers.get(key);
      if (!operation || operation.stepId !== values[1]) return { rows: [] };
      return { rows: [{ operation_id: key, run_step_id: operation.stepId, input_digest: digest, request_digest: digest, response_digest: digest,
        provider_request_id: "synthetic-receipt-contract", state: "settled", usage: {}, model_id: policy.model, provider_tag: policy.provider,
        rate_card, rate_card_digest: jsonDigest(rate_card), result: { model: policy.model, provider: policy.providerName, failure: null,
          finishReason: "stop", content: JSON.stringify(operation.content) } }] };
    }
    const result = steps.get(key);
    return { rows: result ? [{ id: key, input_digest: digest, result_reference: result, schema_digest: COURSE_GENERATION_SCHEMA_DIGEST,
      validation_policy_digest: COURSE_VALIDATION_POLICY_DIGEST, capability_digest: getCapabilityCatalogDigest(), approval_digest: digest }] : [] };
  }) } as unknown as DbTransaction;
  const binding = { run: { id: id(720) }, course: { id: data.draft.courseId, ownerId: id(6) }, approval: { id: id(721), draftRevision: 1, contentDigest: digest }, draft: data.draft } as ApprovedBuildBinding;
  const evidence = new GenerationEvidenceRepository();
  vi.spyOn(evidence, "loadTaskCandidate").mockResolvedValue({ candidate, design: authored.design, knowledge: data.knowledge[0]!, facts: data.context,
    step: { id: refs.candidateStepId, inputDigest: digest, result: { kind: "course.task.candidate", moduleId: data.draft.modules[0]!.id,
      knowledgeStepId: id(722), candidate, authored, authoringOperationId: id(709) } },
    knowledgeStep: { id: id(722), inputDigest: digest, result: { kind: "course.module.knowledge", knowledge: data.knowledge[0]!, operationId: id(723), sourceReadStepIds: [id(724)] } } });
  return { repository: new TaskValidationRepository(evidence), tx, binding, refs, steps };
}

describe("truthful content review receipt identity", () => {
  it.each(["kimi-digitalocean-v1", "gemini-flash-google-schema-v2"] as const)("records the verified %s model and actual local case evidence", async (policy) => {
    const test = await receiptFixture(policy), proof = await test.repository.validateStoredTask(test.tx, test.binding, test.refs);
    expect(proof.receipt.verdict).toBe("passed");
    const review = proof.receipt.checks.find(check => check.id === "content_review")!.evidence.find(item => item.kind === "model_review")!;
    expect(review.modelId).toBe(modelPolicy(policy).model);
    expect(proof.receipt.checks.find(check => check.id === "answer_cases")!.evidence.filter(item => item.kind === "response_case")).toHaveLength(3);
  });
  it("does not allow a model review to replace the actual evaluator result", async () => {
    const test = await receiptFixture("gemini-flash-google-schema-v2"), result = test.steps.get(test.refs.caseStepIds[2]!) as { decision: { outcome: string } };
    result.decision.outcome = "correct";
    await expect(test.repository.validateStoredTask(test.tx, test.binding, test.refs)).rejects.toThrow("provider.invalid_output");
  });
});
