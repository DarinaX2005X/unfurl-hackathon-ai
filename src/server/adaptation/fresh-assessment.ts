import "server-only";
import type { CourseVersion } from "@/domain/course";
import type { Lesson, PersonalRoute } from "@/domain/learning";
import type { AssessedTask } from "@/server/learning/initial-route";
import { isCurrentConfirmedEvidence, uncoveredRequiredCriteria, type ConfirmableEvidence } from "@/server/learning/evidence";

/** Independence comes from the validated semantic group, never a reset or a changed number. */
export function selectFreshAssessment(input: {
  enrollmentId: string; version: CourseVersion; lessons: readonly Lesson[]; tasks: readonly AssessedTask[];
  evidence: readonly ConfirmableEvidence[]; exposedTaskIds: ReadonlySet<string>; exposedGroupIds: ReadonlySet<string>;
  targetCriteria?: ReadonlyMap<string, ReadonlySet<string>>;
}): { position: PersonalRoute["next"][number]; entry: AssessedTask; outcomeIds: string[] } | null {
  const missing = uncoveredRequiredCriteria(input);
  for (const lessonId of input.version.lessonIds) {
    const lesson = input.lessons.find(({ id }) => id === lessonId);
    if (!lesson || lesson.courseVersionId !== input.version.id) continue;
    for (const block of lesson.blocks) {
      if (block.kind !== "task") continue;
      const entry = input.tasks.find(({ task }) => task.id === block.taskId);
      if (!entry || entry.assessment.role === "required" || input.exposedTaskIds.has(entry.task.id) || input.exposedGroupIds.has(entry.assessment.evidenceGroupId)) continue;
      const outcomeIds = entry.assessment.outcomes.filter(({ outcomeId, dimensions }) => dimensions.some(({ dimensionId }) => missing.get(outcomeId)?.has(dimensionId) &&
        (!input.targetCriteria || input.targetCriteria.get(outcomeId)?.has(dimensionId)))).map(({ outcomeId }) => outcomeId);
      if (outcomeIds.length === 0) continue;
      const basisEvidenceIds = input.evidence.filter((evidence) => isCurrentConfirmedEvidence(evidence) && outcomeIds.includes(evidence.outcomeId) &&
        Object.entries(evidence.dimensionStatuses).some(([id, status]) => missing.get(evidence.outcomeId)?.has(id) && (status === "not_met" || status === "partial"))).slice(-6).map(({ id }) => id);
      return { entry, outcomeIds, position: { lessonId, taskId: entry.task.id, reasonCode: "scheduled_review", basisEvidenceIds } };
    }
  }
  return null;
}
