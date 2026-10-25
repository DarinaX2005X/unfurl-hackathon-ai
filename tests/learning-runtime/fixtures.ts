import type { CourseVersion } from '@/domain/course';
import type { Lesson } from '@/domain/learning';
import type { AssessedTask } from '@/server/learning/initial-route';

export function program() {
  const outcomeId = crypto.randomUUID(), moduleId = crypto.randomUUID(), versionId = crypto.randomUUID();
  const readingId = crypto.randomUUID(), practiceId = crypto.randomUUID();
  const tasks: AssessedTask[] = ["required", "practice", "required"].map((role) => ({
    task: { id: crypto.randomUUID(), taskVersion: 1, mechanicId: "state_tracing", mechanicVersion: 2,
      responseSchemaVersion: 2, outcomeIds: [outcomeId], instruction: "Trace the synthetic state.", contentLanguage: "en", availableHints: 0, config: { kind: "state_tracing" } },
    assessment: { role: role as AssessedTask["assessment"]["role"], evidenceGroupId: crypto.randomUUID(),
      outcomes: [{ outcomeId, dimensions: [{ dimensionId: "state", evaluationDimensionIds: ["step.1"] }] }] },
  }));
  const version: CourseVersion = { id: versionId, courseId: crypto.randomUUID(), number: 1, approvalId: crypto.randomUUID(), sourceRunId: crypto.randomUUID(),
    contentDigest: "a".repeat(64), state: "ready", title: "Synthetic route fixture", summary: "Not a learner course.", contentLanguage: "en", assumedKnowledge: [],
    outcomes: [{ id: outcomeId, title: "State", demonstration: "Trace state transitions", prerequisiteOutcomeIds: [], requirement: "specialization" }],
    modules: [{ id: moduleId, title: "State", summary: "A synthetic program", outcomeIds: [outcomeId], prerequisiteModuleIds: [], estimatedStudyMinutes: 5 }],
    lessonIds: [readingId, practiceId], validationReceiptId: crypto.randomUUID(), cover: { motifId: "test", alt: "Test" },
    createdAt: "2026-10-25T00:00:00Z", readyAt: "2026-10-25T00:00:00Z" };
  const reading = { id: crypto.randomUUID(), kind: "explanation" as const, markdown: "Synthetic explanation", sourceIds: [] };
  const lessons: Lesson[] = [
    { id: readingId, courseVersionId: versionId, moduleId, title: "Read", outcomeIds: [outcomeId], blocks: [reading], taskIds: [] },
    { id: practiceId, courseVersionId: versionId, moduleId, title: "Practice", outcomeIds: [outcomeId],
      blocks: [reading, ...[tasks[2]!, tasks[1]!, tasks[0]!].map(({ task }) => ({ id: crypto.randomUUID(), kind: "task" as const, taskId: task.id }))],
      taskIds: tasks.map(({ task }) => task.id) },
  ];
  return { enrollmentId: crypto.randomUUID(), version, lessons, tasks };
}

