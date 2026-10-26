import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { firstSectionScope } from "../../src/server/course-materialization/official-preview";
import { previewFromVersion } from "../../src/server/course-materialization/preview-metadata";
import { detailFromVersion, summaryFromVersion } from "../../src/server/catalog/projections";
import { createInitialLearningRoute } from "../../src/server/learning/initial-route";
import { validateCourseCoverage } from "../../src/server/course-validation/coverage";
import { validateAdaptiveMaterial } from "../../src/server/course-validation/adaptive-material";
import { taskDigest } from "../../src/server/mechanics/digest";
import type { CompletedModuleCheckpoint } from "../../src/server/course-generation/completion";
import { adaptiveFixture, digest, id, now, privateMarker } from "../course-generation/fixtures";

export function previewFixture() {
  const data = adaptiveFixture(2), section = data.modules[0]!;
  const checkpoint: CompletedModuleCheckpoint = { kind: "course.module.completed", module: section, coverage: [data.coverage[0]!],
    knowledgeStepId: id(40), planStepId: id(41), readingStepIds: [id(42)], taskReferences: [], reviewStepId: id(43) };
  const scope = firstSectionScope(data.draft, checkpoint);
  const version = { id: id(8), courseId: data.draft.courseId, number: 1, approvalId: id(44), sourceRunId: id(45),
    contentDigest: digest, state: "ready" as const, title: data.draft.title, summary: scope.modules[0]!.summary,
    contentLanguage: data.draft.contentLanguage, assumedKnowledge: data.draft.assumedKnowledge,
    outcomes: scope.outcomes, modules: scope.modules, lessonIds: section.lessons.map(({ id }) => id),
    validationReceiptId: id(46), cover: { motifId: "learning-path", alt: data.draft.title }, createdAt: now, readyAt: now };
  const body = { kind: "official-section-preview-v1" as const, publisher: "Unfurl" as const, sourceRunId: version.sourceRunId,
    approvalId: version.approvalId, approvalDigest: digest, courseVersionId: version.id, completedStepId: id(47), moduleDigest: section.moduleDigest,
    presentation: { kind: "preview" as const, availableModuleIds: [section.moduleId], plannedModules: data.draft.modules,
      notice: "The first generated section is available. The rest of the program is planned.",
      lessons: section.lessons.map((lesson) => ({ id: lesson.id, moduleId: lesson.moduleId, title: lesson.title,
        tasks: lesson.taskIds.map((id) => { const task = section.tasks.find(({ candidate }) => candidate.task.id === id)!.candidate.task;
          return { id: task.id, instruction: task.instruction, mechanicId: task.mechanicId }; }) })) } };
  const metadata = { ...body, releaseDigest: taskDigest(body) };
  const row = { id: version.id, course_id: version.courseId, number: version.number, approval_id: version.approvalId,
    source_run_id: version.sourceRunId, content_digest: version.contentDigest, state: version.state, title: version.title,
    summary: version.summary, content_language: version.contentLanguage, assumed_knowledge: version.assumedKnowledge,
    outcomes: version.outcomes, modules: version.modules, lesson_ids: version.lessonIds, validation_receipt_id: version.validationReceiptId,
    cover: version.cover, created_at: now, ready_at: now, release_metadata: metadata, slug: "contract-preview", visibility: "public", owner_id: id(6) };
  return { data, checkpoint, scope, version, metadata, row };
}

describe("first section release scope", () => {
  it("keeps the full approval unchanged and produces a complete independent learning route only for the section", () => {
    const { data, checkpoint, scope, version } = previewFixture();
    expect(data.draft.modules).toHaveLength(2);
    expect(scope.modules).toHaveLength(1);
    expect(scope.outcomes).toHaveLength(1);
    expect(validateCourseCoverage({ draft: scope, approvalDigest: digest, courseVersionId: version.id,
      modules: [checkpoint.module], coverage: checkpoint.coverage })).toEqual([]);
    expect(validateAdaptiveMaterial([checkpoint.module])).toEqual([]);
    const initial = createInitialLearningRoute({ enrollmentId: id(80), version, lessons: checkpoint.module.lessons,
      tasks: checkpoint.module.tasks.map(({ candidate }) => ({ task: candidate.task, assessment: candidate.privateTask.assessment })) });
    expect(initial.route.targetOutcomeIds).toEqual(scope.outcomes.map(({ id }) => id));
    expect(initial.route.targetOutcomeIds).not.toContain(data.draft.outcomes[1]!.id);
    expect(initial.route.next.every(({ lessonId }) => version.lessonIds.includes(lessonId))).toBe(true);
    expect(validateCourseCoverage({ ...data.context, modules: [checkpoint.module], coverage: checkpoint.coverage }).length).toBeGreaterThan(0);
  });
  it("rejects a later section and unavailable prerequisite outcomes", () => {
    const { data, checkpoint } = previewFixture();
    expect(() => firstSectionScope(data.draft, { ...checkpoint, module: data.modules[1]! })).toThrow("first section");
    data.draft.outcomes[0]!.prerequisiteOutcomeIds = [data.draft.outcomes[1]!.id];
    expect(() => firstSectionScope(data.draft, checkpoint)).toThrow("unavailable prerequisites");
  });
  it("projects actual available content and the separate planned outline without private solutions", () => {
    const { row } = previewFixture();
    const detail = detailFromVersion(row), summary = summaryFromVersion(row);
    expect(summary).toMatchObject({ publisher: "Unfurl", moduleCount: 1, lessonCount: 1, estimatedStudyMinutes: 40 });
    expect(detail.modules).toHaveLength(1);
    expect(detail.release?.plannedModules).toHaveLength(2);
    expect(detail.release?.lessons[0]?.tasks).toHaveLength(5);
    expect(JSON.stringify(detail)).not.toContain(privateMarker);
    expect(JSON.stringify(detail)).not.toContain("candidateDigest");
  });
  it("does not silently accept altered release metadata or an available scope mismatch", () => {
    const { metadata, version } = previewFixture();
    expect(previewFromVersion(metadata, version)).toEqual(metadata);
    expect(() => previewFromVersion({ ...metadata, presentation: { ...metadata.presentation, notice: "Altered" } }, version)).toThrow();
    expect(() => previewFromVersion(metadata, { ...version, modules: [...version.modules, metadata.presentation.plannedModules[1]!] })).toThrow();
  });
  it("leaves ordinary complete course projections unchanged", () => {
    const { row } = previewFixture();
    const detail = detailFromVersion({ ...row, release_metadata: null });
    expect(detail.publisher).toBeUndefined();
    expect(detail.release).toBeUndefined();
  });
});
