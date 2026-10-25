import "server-only";
import type { CourseVersion } from "@/domain/course";
import type { Lesson, SupportOffer } from "@/domain/learning";
import type { AssessedTask } from "@/server/learning/initial-route";
import type { ConfirmableEvidence } from "@/server/learning/evidence";
import { isCurrentConfirmedEvidence } from "@/server/learning/evidence";

/** Selects existing validated material only; a missing match is not permission to invent a detour. */
export function selectSupportMaterial(input: {
  version: CourseVersion; lessons: Lesson[]; tasks: AssessedTask[]; evidence: ConfirmableEvidence[];
  targetOutcomeId: string; reasonCode: SupportOffer["reasonCode"]; currentTaskId: string | null;
  dimensionIds?: string[];
}): Pick<SupportOffer, "target" | "tasks" | "explanationBlock" | "completionCheck" | "estimatedStudyMinutes"> | null {
  const outcome = input.version.outcomes.find(({ id }) => id === input.targetOutcomeId);
  if (!outcome) return null;
  if (input.reasonCode === "prerequisite_support" && (!input.version.outcomes.some((candidate) => candidate.prerequisiteOutcomeIds.includes(outcome.id)) ||
    !input.evidence.some((entry) => entry.outcomeId === outcome.id && entry.assistance === "independent" && isCurrentConfirmedEvidence(entry) && Object.values(entry.dimensionStatuses).includes("not_met")))) return null;
  const knownDimensions = [...new Set(input.tasks.flatMap(({ assessment }) => assessment.outcomes.filter(({ outcomeId }) => outcomeId === outcome.id).flatMap(({ dimensions }) => dimensions.map(({ dimensionId }) => dimensionId))))];
  const met = new Set(input.evidence.filter((entry) => entry.courseVersionId === input.version.id && entry.outcomeId === outcome.id && isCurrentConfirmedEvidence(entry) &&
    input.tasks.some(({ task, assessment }) => task.id === entry.taskId && task.taskVersion === entry.taskVersion && assessment.evidenceGroupId === entry.evidenceGroupId))
    .flatMap((entry) => Object.entries(entry.dimensionStatuses).filter(([, status]) => status === "met").map(([id]) => id)));
  const relevantDimensions = knownDimensions.filter((id) => !met.has(id));
  const desiredRole = input.reasonCode === "challenge" ? "challenge" : input.reasonCode === "diagnostic_clarification" ? "diagnostic" : "practice";
  const candidates = input.tasks.filter(({ task, assessment }) => task.id !== input.currentTaskId && assessment.role === desiredRole);
  const eligibleDimensions = relevantDimensions.length ? relevantDimensions : knownDimensions;
  const firstMapping = candidates.map(({ assessment }) => assessment.outcomes.find(({ outcomeId }) => outcomeId === outcome.id))
    .find((mapping) => mapping?.dimensions.some(({ dimensionId }) => eligibleDimensions.includes(dimensionId)));
  const dimensions = input.dimensionIds ?? (input.reasonCode === "explanation" ? eligibleDimensions :
    firstMapping?.dimensions.map(({ dimensionId }) => dimensionId).filter((id) => eligibleDimensions.includes(id)) ?? []);
  if (dimensions.length === 0 || dimensions.some((id) => !knownDimensions.includes(id))) return null;
  const explanation = input.reasonCode === "challenge" ? null : input.lessons.flatMap((lesson) => lesson.outcomeIds.includes(outcome.id)
    ? lesson.blocks.filter((block) => block.kind === "explanation").map((block) => ({ lessonId: lesson.id, blockId: block.id })) : [])[0] ?? null;
  const selected = input.reasonCode === "explanation" ? [] : candidates.filter(({ assessment }) =>
    assessment.outcomes.some((mapping) => mapping.outcomeId === outcome.id && dimensions.every((id) => mapping.dimensions.some(({ dimensionId }) => dimensionId === id))))
    .slice(0, 2).map(({ task }) => {
      const lesson = input.lessons.find((lesson) => lesson.taskIds.includes(task.id));
      return lesson ? { lessonId: lesson.id, taskId: task.id, taskVersion: task.taskVersion } : null;
    }).filter((item): item is NonNullable<typeof item> => item !== null);
  // Practice, diagnostic and challenge requests need their actual matching task; a generic reading is insufficient.
  if ((input.reasonCode !== "explanation" && selected.length === 0) || (selected.length === 0 && explanation === null)) return null;
  return { target: { outcomeId: outcome.id, dimensionIds: dimensions }, tasks: selected, explanationBlock: explanation,
    completionCheck: selected.length ? { taskId: selected.at(-1)!.taskId, dimensionIds: dimensions } : null,
    estimatedStudyMinutes: selected.length * 3 + (explanation ? 2 : 0) };
}
