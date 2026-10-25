import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { findSupportGapBasis, hasFreshSupportBasis, supportBasisDigest } from "@/server/adaptation/policy";
import type { ConfirmableEvidence } from "@/server/learning/evidence";

const enrollmentId = crypto.randomUUID(), courseVersionId = crypto.randomUUID(), outcomeId = crypto.randomUUID();
const observation = (minute: number, changes: Partial<ConfirmableEvidence> = {}): ConfirmableEvidence => ({
  id: crypto.randomUUID(), enrollmentId, courseVersionId, outcomeId, taskId: crypto.randomUUID(), taskVersion: 1, evidenceGroupId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(), evaluationId: crypto.randomUUID(), evaluationRevision: 1, currentEvaluationRevision: 1, evaluationStatus: "evaluated",
  assistance: "independent", reviewState: "confirmed", dimensionStatuses: { state: "not_met" },
  submittedAt: new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString(), feedbackAcknowledgedAt: new Date(Date.UTC(2026, 9, 25, 0, minute + 1)).toISOString(), ...changes,
});
const basis = (evidence: ConfirmableEvidence[]) => findSupportGapBasis({ enrollmentId, courseVersionId, outcomeId, dimensionId: "state", evidence });

describe("bounded conservative adaptation", () => {
  it("requires two distinct tasks and groups and a later submission after explicit acknowledgement", () => {
    const a = observation(0), b = observation(3);
    expect(basis([a])).toBeNull();
    expect(basis([a, { ...b, taskId: a.taskId }])).toBeNull();
    expect(basis([a, { ...b, evidenceGroupId: a.evidenceGroupId }])).toBeNull();
    expect(basis([{ ...a, feedbackAcknowledgedAt: null }, b])).toBeNull();
    expect(basis([{ ...a, feedbackAcknowledgedAt: b.submittedAt }, b])).toBeNull();
    expect(basis([b, a])?.basisEvidenceIds).toEqual([a.id, b.id]);
  });
  it("excludes uncertain, contested, assisted and foreign evidence and uses only six recent observations", () => {
    const a = observation(0), b = observation(3);
    for (const change of [{ evaluationStatus: "uncertain" as const }, { reviewState: "contested" as const },
      { assistance: "hinted" as const }, { courseVersionId: crypto.randomUUID() }, { currentEvaluationRevision: 2 }]) {
      expect(basis([a, { ...b, ...change }])).toBeNull();
    }
    const uncertain = Array.from({ length: 6 }, (_, index) => observation(index + 6, { evaluationStatus: "uncertain" }));
    expect(basis([a, b, ...uncertain])).toBeNull();
  });
  it("fresh independent success clears a gap while a replayed same-case success cannot", () => {
    const a = observation(0), b = observation(3), success = observation(5, { dimensionStatuses: { state: "met" } });
    expect(basis([a, b, success])).toBeNull();
    expect(basis([a, b, { ...success, taskId: a.taskId, evidenceGroupId: a.evidenceGroupId }])).not.toBeNull();
    expect(basis([a, success, observation(8)])).toBeNull();
  });
  it("automatic basis hashing ignores duplicate/order noise in evidence and criterion IDs", () => {
    const id = crypto.randomUUID();
    const offer = { target: { outcomeId, dimensionIds: ["b", "a"] }, basisEvidenceIds: [id, enrollmentId], reasonCode: "additional_practice" as const,
      tasks: [{ lessonId: crypto.randomUUID(), taskId: crypto.randomUUID(), taskVersion: 1 }], explanationBlock: null };
    expect(supportBasisDigest(offer)).toBe(supportBasisDigest({ ...offer, target: { outcomeId, dimensionIds: ["a", "b", "a"] }, basisEvidenceIds: [enrollmentId, id, id] }));
    expect(supportBasisDigest(offer)).not.toBe(supportBasisDigest({ ...offer, reasonCode: "challenge" }));
  });
  it("requires a fresh independent case after an earlier automatic proposal", () => {
    const a = observation(0), b = observation(3), c = observation(5);
    expect(hasFreshSupportBasis([a, b], [])).toBe(true);
    const repeated = [{ ...a, id: crypto.randomUUID() }, { ...b, id: crypto.randomUUID() }];
    expect(hasFreshSupportBasis(repeated, [a, b])).toBe(false);
    expect(hasFreshSupportBasis([a, { ...c, evidenceGroupId: b.evidenceGroupId }], [a, b])).toBe(false);
    expect(hasFreshSupportBasis([a, c], [a, b])).toBe(true);
  });
});
