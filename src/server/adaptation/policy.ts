import "server-only";
import { createHash } from "node:crypto";
import type { Id } from "@/domain/common";
import type { SupportOffer } from "@/domain/learning";
import { isCurrentConfirmedEvidence, type ConfirmableEvidence } from "@/server/learning/evidence";

export type GapBasis = { outcomeId: Id; dimensionId: string; basisEvidenceIds: Id[] };
const independent = (entry: ConfirmableEvidence) => isCurrentConfirmedEvidence(entry) && entry.assistance === "independent";
const distinct = (left: ConfirmableEvidence, right: ConfirmableEvidence) => left.taskId !== right.taskId && left.evidenceGroupId !== right.evidenceGroupId;

/** Conservative product guardrail: no inference from time, one error, or repeated variants. */
export function findSupportGapBasis(input: {
  enrollmentId: Id; courseVersionId: Id; outcomeId: Id; dimensionId: string; evidence: readonly ConfirmableEvidence[];
}): GapBasis | null {
  const relevant = input.evidence.filter((entry) => entry.enrollmentId === input.enrollmentId && entry.courseVersionId === input.courseVersionId &&
    entry.outcomeId === input.outcomeId && Object.hasOwn(entry.dimensionStatuses, input.dimensionId) &&
    entry.evaluationRevision === entry.currentEvaluationRevision && entry.reviewState !== "superseded")
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.id.localeCompare(b.id)).slice(-6);
  for (let laterIndex = relevant.length - 1; laterIndex >= 0; laterIndex--) {
    const later = relevant[laterIndex]!;
    if (!independent(later) || later.dimensionStatuses[input.dimensionId] !== "not_met") continue;
    for (let earlierIndex = laterIndex - 1; earlierIndex >= 0; earlierIndex--) {
      const earlier = relevant[earlierIndex]!;
      if (!independent(earlier) || earlier.dimensionStatuses[input.dimensionId] !== "not_met" || !distinct(earlier, later) ||
        earlier.feedbackAcknowledgedAt === null || Date.parse(later.submittedAt) <= Date.parse(earlier.feedbackAcknowledgedAt)) continue;
      // A fresh independent success after either failure interrupts this gap hypothesis.
      const cleared = relevant.slice(earlierIndex + 1).some((entry) => independent(entry) && entry.dimensionStatuses[input.dimensionId] === "met" &&
        distinct(entry, earlier) && distinct(entry, later));
      if (cleared) continue;
      return { outcomeId: input.outcomeId, dimensionId: input.dimensionId, basisEvidenceIds: [earlier.id, later.id] };
    }
  }
  return null;
}

/** Cosmetic edits, new offer IDs and route revisions cannot wash a declined automatic basis. */
export function supportBasisDigest(offer: Pick<SupportOffer, "target" | "basisEvidenceIds" | "reasonCode" | "tasks" | "explanationBlock">): string {
  const value = {
    outcomeId: offer.target.outcomeId, dimensionIds: [...new Set(offer.target.dimensionIds)].sort(),
    evidenceIds: [...new Set(offer.basisEvidenceIds)].sort(), reasonCode: offer.reasonCode,
    tasks: offer.tasks.map(({ lessonId, taskId, taskVersion }) => ({ lessonId, taskId, taskVersion })),
    explanationBlock: offer.explanationBlock === null ? null : { lessonId: offer.explanationBlock.lessonId, blockId: offer.explanationBlock.blockId },
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
