import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { JsonValue } from "@/domain/common";
import type { GradeDecision } from "@/server/evaluation/contracts";
import { validateCounterexampleClaim } from "@/server/evaluation/foundations";
import { CounterexampleConstructionConfigSchema } from "@/domain/mechanic-families/v2/foundations";
import { getAssessmentDimensionIds } from "@/server/mechanics/catalog";
import { prepareTaskCandidate, validateTaskReadiness } from "@/server/mechanics/materialization";
import { authoritativeStoredTaskValidationReceipt, type PreparedTaskCandidate, type StoredTaskValidationReceipt, type TaskValidationEvidence } from "@/server/mechanics/contracts";
import { authored, approvalDigest, modelContext, registryFixtures, runtime } from "./fixtures";
import { source } from "../mechanics/investigation/fixtures";
import { information } from "../mechanics/communication/fixtures";

function met(dimensions: string[]): GradeDecision {
  return { status: "evaluated", outcome: "correct", dimensions: dimensions.map((id) => ({ id, status: "met", explanation: "Synthetic stored evidence for boundary testing only." })),
    feedback: { explanation: "Synthetic recorded check; not live grading.", nextAction: "continue" } };
}
/** Simulates immutable records returned by an authorized store. Does not execute research or a model. */
function externalReceipt(candidate: PreparedTaskCandidate, response: JsonValue, alternate: JsonValue): StoredTaskValidationReceipt {
  const reviewCallRef = crypto.randomUUID(), dimensions = getAssessmentDimensionIds(candidate.task, candidate.privateTask.evaluatorData);
  const caseIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const checks: StoredTaskValidationReceipt["checks"] = [
    { id: "structure", status: "passed", reason: "Pure preparation completed.", evidence: [{ kind: "pure", validatorVersion: "mechanic-readiness-v1" }] },
    { id: "content_review", status: "passed", reason: "Simulated external content review.", evidence: [{
      kind: "model_review", callId: reviewCallRef, modelId: "moonshotai/kimi-k2.6", validator: "content_review", candidateDigest: candidate.candidateDigest, decision: met(["content"]),
    }] },
    { id: "answer_cases", status: "passed", reason: "Simulated stored valid, alternative and malformed cases.", evidence: [
      { kind: "response_case", caseId: caseIds[0]!, category: "valid", response, decision: met(dimensions), rejectedAsInvalid: false, modelCallId: crypto.randomUUID(), activityEvidenceRef: crypto.randomUUID() },
      { kind: "response_case", caseId: caseIds[1]!, category: "alternative", response: alternate, decision: met(dimensions), rejectedAsInvalid: false, modelCallId: crypto.randomUUID(), activityEvidenceRef: crypto.randomUUID() },
      { kind: "response_case", caseId: caseIds[2]!, category: "invalid", response: {}, decision: null, rejectedAsInvalid: true, modelCallId: null, activityEvidenceRef: null },
    ] },
  ];
  return { id: crypto.randomUUID(), taskId: candidate.task.id, taskVersion: candidate.task.taskVersion,
    approvalDigest: candidate.approvalDigest, candidateDigest: candidate.candidateDigest, capabilityCatalogDigest: candidate.capabilityCatalogDigest,
    validatorVersion: "mechanic-readiness-v1", checks, testEvidenceRefs: caseIds, reviewCallRef, verdict: "passed", createdAt: "2026-10-25T00:00:00.000Z" };
}
function readiness(candidate: PreparedTaskCandidate, receipt: StoredTaskValidationReceipt, currentRuntime = runtime) {
  return validateTaskReadiness(candidate, { runtime: currentRuntime, receipt: authoritativeStoredTaskValidationReceipt(receipt) });
}
async function sourceCase() {
  const fixture = registryFixtures.find((item) => item.id === "source_investigation")!;
  const input = await fixture.make(), draft = authored(input, fixture.dimensions), claimId = crypto.randomUUID();
  draft.privateTask.sourceClaimIds = [claimId];
  const candidate = prepareTaskCandidate(draft, { approvalDigest });
  const receipt = externalReceipt(candidate, input.response, { ...input.response as object, explanation: "Fitting on training data prevents one leakage path; it does not demonstrate accuracy in a different deployment population." });
  receipt.checks.push({ id: "source_grounding", status: "passed", reason: "Independent fixture research snapshot.", evidence: [{
    kind: "research", researchSnapshotId: crypto.randomUUID(), approvalDigest, claims: [{ claimId, sourceIds: ["synthetic"] }], sources: structuredClone(source.sources),
  }] });
  return { candidate, receipt, input, draft };
}
async function dialogueCase() {
  const fixture = registryFixtures.find((item) => item.id === "information_gap")!;
  const input = await fixture.make(), candidate = prepareTaskCandidate(authored(input, fixture.dimensions), { approvalDigest });
  const receipt = externalReceipt(candidate, input.response, information.cases[2]!.response);
  receipt.checks.push(
    { id: "dialogue_compatibility", status: "passed", reason: "Simulated goal/private-world/disclosure compatibility check.", evidence: [{
      kind: "model_review", callId: crypto.randomUUID(), modelId: "moonshotai/kimi-k2.6", validator: "dialogue_compatibility", candidateDigest: candidate.candidateDigest, decision: met(["compatibility"]),
    }] },
    { id: "reachability", status: "passed", reason: "Simulated persisted dialogue witness.", evidence: [{
      kind: "witness", response: input.response, decision: met(fixture.dimensions), executionEvidenceRef: crypto.randomUUID(),
    }] },
  );
  return { candidate, receipt, input, fixture };
}

describe("external validation evidence", () => {
  it("compares public and private source snapshots with independent stored research", async () => {
    const { candidate, receipt } = await sourceCase();
    expect(readiness(candidate, receipt).status).toBe("ready");
    const fake = structuredClone(candidate);
    const publicSources = fake.task.config.sources as Array<{ passages: Array<{ text: string }> }>;
    publicSources[0]!.passages[0]!.text = "Invented proof of universal robustness.";
    fake.privateTask.evaluatorData.sources = structuredClone(fake.task.config.sources!);
    const changed = prepareTaskCandidate({ task: fake.task, privateTask: fake.privateTask }, { approvalDigest });
    const copiedReview = externalReceipt(changed, { ...information.cases[0]!.response }, {});
    // Other checks remain structurally valid for the source family; only the independent research differs.
    copiedReview.checks = structuredClone(receipt.checks);
    for (const check of copiedReview.checks) for (const evidence of check.evidence) if (evidence.kind === "model_review") evidence.candidateDigest = changed.candidateDigest;
    copiedReview.testEvidenceRefs = receipt.testEvidenceRefs;
    copiedReview.reviewCallRef = receipt.reviewCallRef;
    expect(readiness(changed, copiedReview)).toMatchObject({ status: "unreviewed", reasons: expect.arrayContaining(["Missing or unverifiable external evidence: source_grounding"]) });
  });
  it("rejects unknown source claims, foreign approvals and ungrounded private-only source additions", async () => {
    const { candidate, receipt, draft } = await sourceCase();
    const check = receipt.checks.find((item) => item.id === "source_grounding")!;
    const research = check.evidence[0]!;
    if (research.kind !== "research") throw new Error("Expected research fixture");
    research.claims = [];
    expect(readiness(candidate, receipt).status).toBe("unreviewed");
    research.approvalDigest = "b".repeat(64);
    expect(readiness(candidate, receipt).status).toBe("unreviewed");
    const extraSource = { ...source.sources[0]!, id: "unretrieved", title: "Invented private source" };
    draft.privateTask.evaluatorData.sources = [...source.sources, extraSource];
    const modified = prepareTaskCandidate(draft, { approvalDigest });
    const matching = await sourceCase();
    matching.receipt.taskId = modified.task.id;
    matching.receipt.candidateDigest = modified.candidateDigest;
    for (const item of matching.receipt.checks) for (const proof of item.evidence) {
      if (proof.kind === "model_review") proof.candidateDigest = modified.candidateDigest;
      if (proof.kind === "research") proof.claims = [{ claimId: modified.privateTask.sourceClaimIds[0]!, sourceIds: ["synthetic"] }];
    }
    expect(readiness(modified, matching.receipt).status).toBe("unreviewed");
  });
  it("requires both a compatible dialogue world and an actual persisted successful witness", async () => {
    const { candidate, receipt } = await dialogueCase();
    expect(readiness(candidate, receipt).status).toBe("ready");
    const noHistory = structuredClone(receipt);
    const witness = noHistory.checks.find((check) => check.id === "reachability")!.evidence[0]!;
    if (witness.kind === "witness") witness.executionEvidenceRef = null;
    expect(readiness(candidate, noHistory)).toMatchObject({ status: "unreviewed", reasons: expect.arrayContaining(["Missing or unverifiable external evidence: reachability"]) });
    const noCompatibility = structuredClone(receipt); noCompatibility.checks = noCompatibility.checks.filter((check) => check.id !== "dialogue_compatibility");
    expect(readiness(candidate, noCompatibility).status).toBe("unreviewed");
    const impossible = structuredClone(receipt); impossible.checks.find((check) => check.id === "dialogue_compatibility")!.status = "failed";
    expect(readiness(candidate, impossible).status).toBe("invalid");
  });
  it("keeps uncertain or unavailable model evidence unreviewed even if the enclosing check says passed", async () => {
    const { candidate, receipt } = await dialogueCase();
    for (const status of ["uncertain", "unavailable"] as const) {
      const copy = structuredClone(receipt);
      const proof = copy.checks.find((check) => check.id === "dialogue_compatibility")!.evidence[0]!;
      if (proof.kind === "model_review") proof.decision = { status, outcome: null, dimensions: [{ id: "compatibility", status: "uncertain", explanation: "The actual review did not resolve the scenario." }], feedback: { explanation: "Unresolved review.", nextAction: "clarify" } };
      expect(readiness(candidate, copy).status).toBe("unreviewed");
    }
  });
  it("binds counterexample evidence to validateCounterexampleClaim's actual dimension and candidate", async () => {
    const fixture = registryFixtures.find((item) => item.id === "counterexample_construction")!;
    const input = await fixture.make(), candidate = prepareTaskCandidate(authored(input, fixture.dimensions), { approvalDigest });
    const receipt = externalReceipt(candidate, input.response, { kind: "counterexample_construction", action: "refute", model: { constant: 2 }, train: [{ x: 0, y: 2 }], validation: [{ x: 1, y: 4 }] });
    expect(readiness(candidate, receipt).status).toBe("unreviewed");
    const proof: TaskValidationEvidence = { kind: "model_review", callId: crypto.randomUUID(), modelId: "moonshotai/kimi-k2.6", validator: "validateCounterexampleClaim", candidateDigest: candidate.candidateDigest,
      decision: await validateCounterexampleClaim(CounterexampleConstructionConfigSchema.parse(candidate.task.config), modelContext()) };
    receipt.checks.push({ id: "counterexample_claim", status: "passed", reason: "Real validator wiring with an explicit synthetic model double.", evidence: [proof] });
    expect(readiness(candidate, receipt).status).toBe("ready");
    proof.decision = met(["refutation"]);
    expect(readiness(candidate, receipt).status).toBe("unreviewed");
    proof.decision = met(["coded_implication"]); proof.candidateDigest = "c".repeat(64);
    expect(readiness(candidate, receipt).status).toBe("unreviewed");
  });
  it("blocks missing model, shared budget, durable history and actual dialogue action support", async () => {
    const { candidate, receipt } = await dialogueCase();
    const unavailableModel = structuredClone(runtime); unavailableModel.model.available = false;
    expect(readiness(candidate, receipt, unavailableModel).reasons).toContain("model_unavailable");
    const unavailableBudget = structuredClone(runtime); unavailableBudget.budget.available = false;
    expect(readiness(candidate, receipt, unavailableBudget).reasons).toContain("model_budget_unavailable");
    const unavailableActivity = structuredClone(runtime); unavailableActivity.activity.durable = false;
    expect(readiness(candidate, receipt, unavailableActivity).reasons).toContain("durable_activity_unavailable");
    const missingAction = structuredClone(runtime); missingAction.activity.supportedActions = ["run"];
    expect(readiness(candidate, receipt, missingAction).reasons).toContain("activity_action_unavailable:dialogue.turn");
  });
  it("does not allow re-normalization to hide a whitespace-only edit after review", async () => {
    const { candidate, receipt } = await sourceCase();
    const instruction = structuredClone(candidate); instruction.task.instruction = ` ${instruction.task.instruction} `;
    expect(readiness(instruction, receipt).status).toBe("unreviewed");
    const hint = structuredClone(candidate); hint.privateTask.hints[0] = ` ${hint.privateTask.hints[0]} `;
    expect(readiness(hint, receipt).status).toBe("unreviewed");
    const privateText = structuredClone(candidate);
    const sourceData = privateText.privateTask.evaluatorData.sources as Array<{ title: string }>;
    sourceData[0]!.title = ` ${sourceData[0]!.title} `;
    expect(readiness(privateText, receipt).status).toBe("unreviewed");
  });
});
