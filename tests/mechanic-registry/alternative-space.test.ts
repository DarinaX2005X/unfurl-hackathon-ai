import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { JsonObjectSchema, type JsonValue } from "@/domain/common";
import { prepareTaskCandidate, validateTaskReadiness } from "@/server/mechanics/materialization";
import { verifyAlternativeSpaceEvidence } from "@/server/mechanics/alternative-space";
import {
  authoritativeStoredTaskValidationReceipt, type AlternativeSpaceEvidence, type AlternativeSpaceProof,
  type PreparedTaskCandidate, type StoredTaskValidationReceipt, type TaskValidationEvidence,
} from "@/server/mechanics/contracts";
import { getServerMechanic } from "@/server/mechanics/registry";
import { authored, approvalDigest, registryFixtures, runtime } from "./fixtures";
import { validOrder } from "../mechanics/foundations/fixtures";

function proofEvidence(candidate: PreparedTaskCandidate, proof: AlternativeSpaceProof): AlternativeSpaceEvidence {
  return { kind: "alternative_space", candidateDigest: candidate.candidateDigest, approvalDigest: candidate.approvalDigest,
    capabilityCatalogDigest: candidate.capabilityCatalogDigest, analysis: { method: "deterministic", proof } };
}
async function singleton(id: "state_tracing" | "outcome_prediction" | "procedure_reconstruction" | "representation_translation" | "example_construction" | "relational_mapping") {
  const fixture = registryFixtures.find((item) => item.id === id)!, input = await fixture.make();
  const draft = authored(input, fixture.dimensions), response = JsonObjectSchema.parse(input.response);
  let proof: AlternativeSpaceProof;
  if (id === "state_tracing") {
    draft.privateTask.evaluatorData.tolerance = { absTol: 0, relTol: 0 };
    proof = { kind: "exact_state_trace", states: response.states as Array<Record<string, number>> };
  } else if (id === "outcome_prediction") {
    draft.privateTask.evaluatorData.tolerance = { absTol: 0, relTol: 0 };
    draft.task.config.maxIntervalWidth = 0;
    response.interval = { lower: 7, upper: 7, unit: "unitless" };
    proof = { kind: "single_prediction_interval", quantity: { value: 7, unit: "unitless" } };
  } else if (id === "procedure_reconstruction") {
    draft.privateTask.evaluatorData.prerequisites = validOrder.slice(1).map((after, index) => ({ before: validOrder[index]!, after }));
    proof = { kind: "unique_procedure_order", stepIds: validOrder };
  } else if (id === "representation_translation") {
    draft.privateTask.evaluatorData.tolerance = { absTol: 0, relTol: 0 };
    draft.task.config.allowedUnits = ["ratio"];
    proof = { kind: "exact_metric_quantity", quantity: { value: 2 / 3, unit: "ratio" } };
  } else if (id === "example_construction") {
    draft.task.config.constraints = { total: 2, falsePositive: 0, minTruePositive: 1, minFalseNegative: 1 };
    response.matrix = { tp: 1, fp: 0, tn: 0, fn: 1 };
    proof = { kind: "single_confusion_matrix", matrix: { tp: 1, fp: 0, tn: 0, fn: 1 } };
  } else proof = { kind: "single_accepted_graph", canonicalEdges: response.edges as Array<{ from: string; relation: string; to: string }> };
  const candidate = prepareTaskCandidate(draft, { approvalDigest });
  return { candidate, proof, response, draft };
}

describe("a verified answer space instead of an invented alternative", () => {
  it.each(["state_tracing", "outcome_prediction", "procedure_reconstruction", "representation_translation", "example_construction", "relational_mapping"] as const)(
    "%s: replays a deterministic uniqueness proof from actual public/private data", async (id) => {
      const { candidate, proof, response } = await singleton(id);
      expect(verifyAlternativeSpaceEvidence(candidate, proofEvidence(candidate, proof), [response], [])).toBe(true);
      const otherCandidate = { ...candidate, approvalDigest: "b".repeat(64) };
      expect(verifyAlternativeSpaceEvidence(otherCandidate, proofEvidence(candidate, proof), [response], [])).toBe(false);
    });
  it("rejects pretend exactness, nonunique ordering, extra matrix freedom and multiple accepted graphs", async () => {
    for (const id of ["state_tracing", "procedure_reconstruction", "example_construction", "relational_mapping"] as const) {
      const original = await singleton(id), changed = structuredClone(original.draft);
      if (id === "state_tracing") changed.privateTask.evaluatorData.tolerance = { absTol: 0.01, relTol: 0 };
      if (id === "procedure_reconstruction") changed.privateTask.evaluatorData.prerequisites = [{ before: "split", after: "fit_scaler" }];
      if (id === "example_construction") changed.task.config.constraints = { total: 3, falsePositive: 0, minTruePositive: 1, minFalseNegative: 1 };
      if (id === "relational_mapping") changed.privateTask.evaluatorData.acceptedGraphs = [original.proof.kind === "single_accepted_graph" ? original.proof.canonicalEdges : [], [{ from: "loss", relation: "updates", to: "parameters" }]];
      const candidate = prepareTaskCandidate(changed, { approvalDigest });
      expect(verifyAlternativeSpaceEvidence(candidate, proofEvidence(candidate, original.proof), [original.response], [])).toBe(false);
    }
  });
  it("can make an exact trace ready with valid+invalid cases and a replayed proof, without an alternative model call", async () => {
    const { candidate, response, proof } = await singleton("state_tracing");
    const decision = await getServerMechanic("state_tracing", 2)!.evaluate({ task: candidate.task, response, privateData: candidate.privateTask.evaluatorData, activity: null }, { model: null, signal: new AbortController().signal });
    const validId = crypto.randomUUID(), invalidId = crypto.randomUUID(), reviewId = crypto.randomUUID();
    const receipt: StoredTaskValidationReceipt = { id: crypto.randomUUID(), taskId: candidate.task.id, taskVersion: candidate.task.taskVersion,
      candidateDigest: candidate.candidateDigest, approvalDigest, capabilityCatalogDigest: candidate.capabilityCatalogDigest, validatorVersion: "mechanic-readiness-v1", verdict: "passed",
      createdAt: "2026-10-25T00:00:00.000Z", testEvidenceRefs: [validId, invalidId], reviewCallRef: reviewId, checks: [
        { id: "structure", status: "passed", reason: "Pure candidate checks passed.", evidence: [{ kind: "pure", validatorVersion: "mechanic-readiness-v1" }] },
        { id: "content_review", status: "passed", reason: "Synthetic external content review fixture only.", evidence: [{ kind: "model_review", callId: reviewId, modelId: "moonshotai/kimi-k2.6", validator: "content_review", candidateDigest: candidate.candidateDigest, decision: { status: "evaluated", outcome: "correct", dimensions: [{ id: "content", status: "met", explanation: "Synthetic content review." }], feedback: { explanation: "Fixture only.", nextAction: "continue" } } }] },
        { id: "answer_cases", status: "passed", reason: "Real numeric trace and malformed case, plus computed uniqueness.", evidence: [
          { kind: "response_case", caseId: validId, category: "valid", response, decision, rejectedAsInvalid: false, modelCallId: null, activityEvidenceRef: null },
          { kind: "response_case", caseId: invalidId, category: "invalid", response: {}, decision: null, rejectedAsInvalid: true, modelCallId: null, activityEvidenceRef: null },
          proofEvidence(candidate, proof),
        ] },
      ] };
    expect(validateTaskReadiness(candidate, { runtime, receipt: authoritativeStoredTaskValidationReceipt(receipt) }).status).toBe("ready");
    receipt.checks[2]!.evidence.pop();
    expect(validateTaskReadiness(candidate, { runtime, receipt: authoritativeStoredTaskValidationReceipt(receipt) }).status).toBe("unreviewed");
  });
  it("requires semantic space analysis and two distinct graded trap cases, not an author flag or a uniqueness phrase", async () => {
    const { candidate, response } = await singleton("state_tracing");
    const trapIds = [crypto.randomUUID(), crypto.randomUUID()];
    const wrong = (states: JsonValue): TaskValidationEvidence => ({ kind: "response_case", caseId: trapIds.shift()!, category: "invalid", response: { ...response, states },
      decision: { status: "evaluated", outcome: "incorrect", dimensions: [{ id: "step.1", status: "not_met", explanation: "Recorded trap result." }], feedback: { explanation: "A computed state is wrong.", nextAction: "revise" } },
      rejectedAsInvalid: false, modelCallId: crypto.randomUUID(), activityEvidenceRef: null });
    const traps = [wrong([{ w: 1 }, { w: 2 }]), wrong([{ w: 2 }, { w: 3 }])];
    const evidence: AlternativeSpaceEvidence = { kind: "alternative_space", candidateDigest: candidate.candidateDigest, approvalDigest, capabilityCatalogDigest: candidate.capabilityCatalogDigest,
      analysis: { method: "semantic", modelId: "moonshotai/kimi-k2.6", callId: crypto.randomUUID(), rationale: "Synthetic stored explanation of a bounded answer space, supported by two independently recorded wrong cases.",
        decision: { status: "evaluated", outcome: "correct", dimensions: ["response_space", "trap_discrimination"].map((id) => ({ id, status: "met", explanation: "Synthetic external analysis, not actual semantic acceptance." })), feedback: { explanation: "Fixture boundary result.", nextAction: "continue" } },
        trapCaseIds: traps.map((trap) => trap.kind === "response_case" ? trap.caseId : ""),
      } };
    expect(verifyAlternativeSpaceEvidence(candidate, evidence, [response], traps)).toBe(true);
    if (traps[0]!.kind === "response_case") traps[0]!.rejectedAsInvalid = true;
    expect(verifyAlternativeSpaceEvidence(candidate, evidence, [response], traps)).toBe(false);
    if (evidence.analysis.method === "semantic") evidence.analysis.decision.dimensions = [{ id: "unique", status: "met", explanation: "It is unique." }];
    expect(verifyAlternativeSpaceEvidence(candidate, evidence, [response], traps)).toBe(false);
  });
});
