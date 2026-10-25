import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { prepareTaskCandidate, validateTaskReadiness, materializeValidatedTask, serializeProductionTask } from "@/server/mechanics/materialization";
import { authoritativeStoredTaskValidationReceipt, type PreparedTaskCandidate, type StoredTaskValidationReceipt, type MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import { getAssessmentDimensionIds } from "@/server/mechanics/catalog";
import { getServerMechanic } from "@/server/mechanics/registry";
import type { JsonValue } from "@/domain/common";
import { induction, task, tolerance, counterexample, counterexamplePrivate } from "../mechanics/foundations/fixtures";

const approvalDigest = "a".repeat(64);
const runtime: MechanicRuntimeCapabilities = { model: { modelId: "moonshotai/kimi-k2.6", available: true },
  activity: { durable: true, supportedActions: ["run", "prediction.commit", "experiment.query", "intervention.apply", "dialogue.turn"], dialogue: true },
  sandbox: { available: false, profiles: [] }, budget: { available: true } };

function input(config = induction, evaluatorData: unknown = { tolerance }) {
  const publicTask = task(config);
  const dimensions = getAssessmentDimensionIds(publicTask, evaluatorData);
  return { task: publicTask, privateTask: {
    taskId: publicTask.id, taskVersion: publicTask.taskVersion,
    evaluationSpec: { kind: "deterministic", evaluatorId: publicTask.mechanicId, evaluatorVersion: 2, secretConfig: null },
    evaluatorData, assessment: { evidenceGroupId: crypto.randomUUID(), role: "required",
      outcomes: [{ outcomeId: publicTask.outcomeIds[0], dimensions: [{ dimensionId: "affine_rule", evaluationDimensionIds: dimensions }] }] },
    sourceClaimIds: [], hints: ["Compare the changes in x and y."], workedExample: null,
  } };
}
const valid: JsonValue = { kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: 2, intercept: 1 }, probeValues: [7] };
const alternate: JsonValue = { kind: "rule_induction", action: "infer_rule", rule: { form: "expression", expression: {
  op: "add", left: { op: "constant", value: 1 }, right: { op: "multiply", left: { op: "variable", name: "x" }, right: { op: "constant", value: 2 } },
} }, probeValues: [7] };
const wrong: JsonValue = { ...valid as Record<string, JsonValue>, rule: { form: "coefficients", slope: 3, intercept: 1 }, probeValues: [10] };

/** Synthetic external content-review fixture. Numeric case results below use the real family evaluator. */
async function receipt(candidate: PreparedTaskCandidate): Promise<StoredTaskValidationReceipt> {
  const handle = getServerMechanic(candidate.task.mechanicId, 2)!;
  const cases = await Promise.all((["valid", "alternative", "invalid"] as const).map(async (category, index) => ({
    kind: "response_case" as const, caseId: crypto.randomUUID(), category, response: [valid, alternate, wrong][index]!,
    decision: await handle.evaluate({ task: candidate.task, response: [valid, alternate, wrong][index]!, privateData: candidate.privateTask.evaluatorData, activity: null }, { model: null, signal: new AbortController().signal }),
    rejectedAsInvalid: false, modelCallId: null, activityEvidenceRef: null,
  })));
  const callId = crypto.randomUUID();
  return { id: crypto.randomUUID(), taskId: candidate.task.id, taskVersion: candidate.task.taskVersion,
    approvalDigest: candidate.approvalDigest, candidateDigest: candidate.candidateDigest, capabilityCatalogDigest: candidate.capabilityCatalogDigest,
    validatorVersion: "mechanic-readiness-v1", checks: [
      { id: "structure", status: "passed", evidence: [{ kind: "pure", validatorVersion: "mechanic-readiness-v1" }], reason: "Real pure candidate checks passed." },
      { id: "content_review", status: "passed", reason: "Synthetic external review for receipt-boundary testing only.", evidence: [{
        kind: "model_review", callId, modelId: "moonshotai/kimi-k2.6", validator: "content_review", candidateDigest: candidate.candidateDigest,
        decision: { status: "evaluated", outcome: "correct", dimensions: [{ id: "content", status: "met", explanation: "Synthetic content-review fixture." }], feedback: { explanation: "Synthetic review.", nextAction: "continue" } },
      }] },
      { id: "answer_cases", status: "passed", evidence: cases, reason: "Actual deterministic intended, alternative and wrong cases evaluated." },
    ], testEvidenceRefs: cases.map((item) => item.caseId), reviewCallRef: callId, verdict: "passed", createdAt: "2026-10-25T00:00:00.000Z" };
}

describe("two-phase task readiness", () => {
  it("preparation does not imply readiness and caller-authored receipt JSON is rejected", async () => {
    const candidate = prepareTaskCandidate(input(), { approvalDigest });
    expect(validateTaskReadiness(candidate, { runtime, receipt: null }).status).toBe("unreviewed");
    expect(validateTaskReadiness(candidate, { runtime, receipt: await receipt(candidate) }).status).toBe("unreviewed");
  });
  it("materializes only a matching authoritative receipt and projects a public DTO", async () => {
    const candidate = prepareTaskCandidate(input(), { approvalDigest });
    const stored = authoritativeStoredTaskValidationReceipt(await receipt(candidate));
    expect(validateTaskReadiness(candidate, { runtime, receipt: stored })).toEqual({ status: "ready", reasons: [] });
    const result = materializeValidatedTask(candidate, { runtime, receipt: stored });
    expect(result.privateTask.validationReceiptId).toBe(stored.id);
    expect(serializeProductionTask({ ...result.task, ...result.privateTask, secretConfig: { answer: "private" } })).toEqual(result.task);
    expect(Object.keys(result.task)).not.toContain("evaluatorData");
  });
  it("invalidates stored review when public, private, assistance, assessment or source fields change", async () => {
    const candidate = prepareTaskCandidate(input(), { approvalDigest });
    const stored = authoritativeStoredTaskValidationReceipt(await receipt(candidate));
    const mutations = [
      (draft: PreparedTaskCandidate) => { draft.task.instruction += " Changed."; },
      (draft: PreparedTaskCandidate) => { draft.privateTask.evaluatorData.tolerance = { absTol: 0.1, relTol: 0 }; },
      (draft: PreparedTaskCandidate) => { draft.privateTask.hints[0] += " Changed."; },
      (draft: PreparedTaskCandidate) => { draft.privateTask.workedExample = "A newly authored worked example."; },
      (draft: PreparedTaskCandidate) => { draft.privateTask.assessment.outcomes[0]!.dimensions[0]!.dimensionId = "different_criterion"; },
      (draft: PreparedTaskCandidate) => { draft.privateTask.sourceClaimIds.push(crypto.randomUUID()); },
      (draft: PreparedTaskCandidate) => { draft.approvalDigest = "b".repeat(64); },
    ];
    for (const mutate of mutations) {
      const draft = structuredClone(candidate); mutate(draft);
      expect(validateTaskReadiness(draft, { runtime, receipt: stored }).status).toBe("unreviewed");
    }
  });
  it("requires every named external check and meaningful distinct valid alternatives", async () => {
    const candidate = prepareTaskCandidate(input(), { approvalDigest });
    const missing = await receipt(candidate); missing.checks = missing.checks.filter((check) => check.id !== "content_review");
    expect(validateTaskReadiness(candidate, { runtime, receipt: authoritativeStoredTaskValidationReceipt(missing) }).status).toBe("unreviewed");
    const duplicate = await receipt(candidate);
    const cases = duplicate.checks.find((check) => check.id === "answer_cases")!.evidence;
    const alternative = cases.find((item) => item.kind === "response_case" && item.category === "alternative")!;
    if (alternative.kind === "response_case") alternative.response = valid;
    expect(validateTaskReadiness(candidate, { runtime, receipt: authoritativeStoredTaskValidationReceipt(duplicate) }).status).toBe("unreviewed");
  });
  it("rejects a wrong private kind, omitted real dimension, hint mismatch and duplicated deterministic payload", () => {
    const kind = input(); kind.privateTask.evaluatorData = { kind: "rule_induction", tolerance };
    expect(() => prepareTaskCandidate(kind, { approvalDigest })).toThrow();
    const dimensions = input(); dimensions.privateTask.assessment.outcomes[0]!.dimensions[0]!.evaluationDimensionIds = ["slope"];
    expect(() => prepareTaskCandidate(dimensions, { approvalDigest })).toThrow(/dimensions/);
    const hints = input(); hints.privateTask.hints = [];
    expect(() => prepareTaskCandidate(hints, { approvalDigest })).toThrow(/hints/);
    const secret = input(); Object.assign(secret.privateTask.evaluationSpec, { secretConfig: { tolerance } });
    expect(() => prepareTaskCandidate(secret, { approvalDigest })).toThrow(/secretConfig/);
  });
  it("does not accept a copied reviewedClaim as a counterexample semantic review", () => {
    const source = input(); const publicTask = task(counterexample);
    const candidate = prepareTaskCandidate({ task: publicTask, privateTask: { ...source.privateTask,
      evaluationSpec: { kind: "deterministic", evaluatorId: "counterexample_construction", evaluatorVersion: 2, secretConfig: null },
      evaluatorData: counterexamplePrivate, assessment: { ...source.privateTask.assessment, outcomes: [{ outcomeId: publicTask.outcomeIds[0],
        dimensions: [{ dimensionId: "refutation", evaluationDimensionIds: ["antecedent", "refutation"] }] }] },
    } }, { approvalDigest });
    expect(candidate.requiredChecks).toContainEqual({ id: "counterexample_claim", method: "external" });
    expect(validateTaskReadiness(candidate, { runtime, receipt: null }).status).toBe("unreviewed");
  });
  it("reports unknown production versions and execution-without-adapter as unsupported", () => {
    const unknown = input(); unknown.task.mechanicVersion = 3;
    expect(() => prepareTaskCandidate(unknown, { approvalDigest })).toThrow(/Unknown production/);
    const execution = input(); Object.assign(execution.privateTask, { evaluationSpec: { kind: "execution", executorId: "python", dialect: "python3", testSetId: crypto.randomUUID(), resourceLimits: { timeoutMs: 1000, memoryMb: 64 } } });
    expect(() => prepareTaskCandidate(execution, { approvalDigest })).toThrow(/execution adapter/);
  });
});
