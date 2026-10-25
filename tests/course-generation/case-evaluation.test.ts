import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { evaluateResponseCase } from "@/server/course-validation/case-evaluation";
import type { StepEffectContext } from "@/server/runs/ports";
import { preparedFixture, id } from "./fixtures";
import { authored, registryFixtures } from "../mechanic-registry/fixtures";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";

function context(): StepEffectContext {
  return { stepId: id(500), deadlineAt: Date.now() + 1000,
    stepFence: { jobId: id(502), jobLeaseOwner: "test", jobFencingToken: "1", retryEpoch: 0,
      stepId: id(500), stepLeaseOwner: "test", stepFencingToken: "1" },
    signal: new AbortController().signal, budgetOperation: vi.fn(() => { throw new Error("A pure evaluator must not need a budget operation"); }) };
}
describe("real local answer-case evaluation", () => {
  it("evaluates a valid answer and a field-valid wrong answer with the registered evaluator", async () => {
    const candidate = preparedFixture().modules[0]!.tasks[0]!.candidate;
    const correct = { kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: 2, intercept: 1 }, probeValues: [7] };
    const valid = await evaluateResponseCase({ candidate, test: { caseId: id(501), key: "valid", category: "valid", response: correct }, context: context(), model: null, deadlineAt: Date.now() + 1000 });
    const invalid = await evaluateResponseCase({ candidate, test: { caseId: id(501), key: "invalid", category: "invalid", response: { ...correct, probeValues: [9] } }, context: context(), model: null, deadlineAt: Date.now() + 1000 });
    expect(valid.decision?.outcome).toBe("correct"); expect(valid.modelCallId).toBeNull();
    expect(invalid.rejectedAsInvalid).toBe(false); expect(invalid.decision?.outcome).not.toBe("correct");
  });
  it("separates a malformed form from a wrong knowledge response", async () => {
    const candidate = preparedFixture().modules[0]!.tasks[0]!.candidate;
    const result = await evaluateResponseCase({ candidate, test: { caseId: id(501), key: "malformed", category: "invalid", response: {} }, context: context(), model: null, deadlineAt: Date.now() + 1000 });
    expect(result.rejectedAsInvalid).toBe(true); expect(result.decision).toBeNull();
  });
  it("does not turn an author's valid label into a passing evaluation", async () => {
    const candidate = preparedFixture().modules[0]!.tasks[0]!.candidate;
    const result = await evaluateResponseCase({ candidate, test: { caseId: id(501), key: "false_claim", category: "valid", response: { kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: 99, intercept: 12 }, probeValues: [309] } }, context: context(), model: null, deadlineAt: Date.now() + 1000 });
    expect(result.decision?.outcome).not.toBe("correct");
  });
  it("rejects altered candidates before evaluating them", async () => {
    const candidate = preparedFixture().modules[0]!.tasks[0]!.candidate;
    candidate.task.instruction += " Altered.";
    await expect(evaluateResponseCase({ candidate, test: { caseId: id(501), key: "valid", category: "valid", response: {} }, context: context(), model: null, deadlineAt: Date.now() + 1000 })).rejects.toThrow("provider.invalid_output");
  });
  it("does not execute a case after cancellation", async () => {
    const candidate = preparedFixture().modules[0]!.tasks[0]!.candidate, aborted = context();
    aborted.signal = AbortSignal.abort();
    await expect(evaluateResponseCase({ candidate, test: { caseId: id(501), key: "valid", category: "valid", response: {} }, context: aborted, model: null, deadlineAt: Date.now() + 1000 })).rejects.toThrow("provider.cancelled");
  });
  it("keeps a missing rubric judge unavailable instead of treating it as incorrect or passed", async () => {
    const entry = registryFixtures.find((item) => item.id === "recall_reconstruction")!, sample = await entry.make();
    const candidate = prepareTaskCandidate(authored(sample, entry.dimensions), { approvalDigest: "a".repeat(64) });
    const result = await evaluateResponseCase({ candidate, test: { caseId: id(501), key: "valid", category: "valid", response: sample.response }, context: context(), model: null, deadlineAt: Date.now() + 1000 });
    expect(result.decision?.status).toBe("unavailable"); expect(result.decision?.outcome).toBeNull(); expect(result.modelCallId).toBeNull();
  });
});
