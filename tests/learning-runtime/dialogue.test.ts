import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { auditDialogueDraft, generateDialogueDraft, verifiedDialogueObservation, type DialogueAudit, type DialogueMaterial } from "@/server/learning/dialogue";
import type { ModelPort } from "@/server/ai/ports";

const material: DialogueMaterial = { taskId: crypto.randomUUID(), taskVersion: 1, mechanicId: "information_gap", instruction: "Select a feasible delivery.", contentLanguage: "en", config: {},
  currentText: "What is the delivery window?", transcript: [], hiddenFacts: [{ id: "window", text: "Delivery is available Tuesday." }],
  disclosureRules: [{ id: "ask_window", text: "Give the delivery window only if asked about its timing." }], scenarioConstraints: [], permittedOutcomes: [], misconception: null };
const draft = { text: "The delivery window is Tuesday.", revealedFactIds: ["window"] };
const audit: DialogueAudit = { verdict: "allowed", inspectedEntirePartnerText: true, noForbiddenDisclosure: true, noGoalAnswerDisclosure: true,
  compliesWithScenarioConstraints: true, noUnsupportedCommitment: true, factDecisions: [{ factId: "window", allowed: true, ruleIds: ["ask_window"], rationale: "The current question explicitly asks about delivery timing." }], explanation: "The full text only gives the permitted fact." };

describe("bounded dialogue draft and disclosure audit", () => {
  it("resolves fact text solely from stored material after every audit check passes", () => {
    expect(verifiedDialogueObservation(material, draft, audit)).toEqual({ kind: "dialogue", text: draft.text, revealedFacts: material.hiddenFacts });
    for (const change of [{ verdict: "uncertain" as const }, { noForbiddenDisclosure: false }, { noGoalAnswerDisclosure: false },
      { compliesWithScenarioConstraints: false }, { noUnsupportedCommitment: false }, { factDecisions: [] },
      { factDecisions: [{ ...audit.factDecisions[0]!, ruleIds: ["invented"] }] }]) expect(() => verifiedDialogueObservation(material, draft, { ...audit, ...change })).toThrow();
    expect(() => verifiedDialogueObservation(material, { ...draft, revealedFactIds: ["invented"] }, audit)).toThrow();
  });
  it("uses two distinct caller-bound operations and audits the free partner text with no repair call", async () => {
    const generateStructured = vi.fn().mockResolvedValueOnce({ data: draft }).mockResolvedValueOnce({ data: { ...audit, verdict: "rejected", noGoalAnswerDisclosure: false } });
    const model = { generateStructured } as unknown as ModelPort;
    const first = { budget: { logicalOperationId: crypto.randomUUID(), reservationId: crypto.randomUUID(), attempt: 1, runStepId: crypto.randomUUID(), probe: false }, deadlineAt: Date.now() + 10_000 };
    const second = { ...first, budget: { ...first.budget, logicalOperationId: crypto.randomUUID(), reservationId: crypto.randomUUID(), runStepId: crypto.randomUUID() } };
    const output = await generateDialogueDraft(model, first, material, new AbortController().signal);
    const checked = await auditDialogueDraft(model, second, material, output, new AbortController().signal);
    expect(() => verifiedDialogueObservation(material, output, checked)).toThrow();
    expect(generateStructured).toHaveBeenCalledTimes(2);
    expect(generateStructured.mock.calls[0]![0]).toMatchObject({ operationId: first.budget.logicalOperationId, purpose: "activity_dialogue", model: "moonshotai/kimi-k2.6" });
    expect(generateStructured.mock.calls[1]![0]).toMatchObject({ operationId: second.budget.logicalOperationId, untrustedInput: { material, draft } });
    expect(generateStructured.mock.calls[1]![0].trustedInstructions).toContain("free partner text");
  });
});
