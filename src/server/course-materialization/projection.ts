import "server-only";
import { LessonSchema } from "@/domain/learning";
import { PreparedModuleSchema } from "@/server/course-generation/contracts";
import { serializeProductionTask } from "@/server/mechanics/materialization";

/** Internal learning projection; caller must enforce stored ready-version access before exposing it. */
export function projectModuleLearningContent(value: unknown) {
  const section = PreparedModuleSchema.parse(value);
  return { lessons: section.lessons.map((lesson) => LessonSchema.parse(lesson)),
    tasks: section.tasks.map(({ candidate }) => serializeProductionTask(candidate.task)) };
}

/** Generation observers receive only completed work facts, never lesson/task material or answers. */
export function projectCompletedModuleProgress(value: unknown) {
  const section = PreparedModuleSchema.parse(value);
  return { moduleId: section.moduleId, completedTasks: section.tasks.length };
}
