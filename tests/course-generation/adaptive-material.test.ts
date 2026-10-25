import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { validateAdaptiveMaterial } from "@/server/course-validation/adaptive-material";
import { validateCourseCoverage } from "@/server/course-validation/coverage";
import { createNormalProgramEntries } from "@/server/learning/initial-route";
import { CourseVersionSchema } from "@/domain/course";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { authored, registryFixtures } from "../mechanic-registry/fixtures";
import { adaptiveFixture, preparedFixture, id, now, digest } from "./fixtures";

describe("generated adaptive assessment reserves", () => {
  it("requires genuine optional roles instead of treating required tasks as support material", () => {
    const ordinary = preparedFixture();
    expect(validateAdaptiveMaterial(ordinary.modules).filter((issue) => issue.code === "criterion_mismatch")).toHaveLength(3);
    expect(validateAdaptiveMaterial(adaptiveFixture().modules)).toEqual([]);
  });
  it("keeps optional tasks out of the normal route while preserving required criterion coverage", () => {
    const data = adaptiveFixture(), section = data.modules[0]!;
    expect(validateCourseCoverage({ ...data.context, modules: data.modules, coverage: data.coverage })).toEqual([]);
    const version = CourseVersionSchema.parse({ id: data.context.courseVersionId, courseId: data.draft.courseId, number: 1, approvalId: id(990), sourceRunId: id(991), contentDigest: digest,
      state: "building", title: data.draft.title, summary: data.draft.goal, contentLanguage: data.draft.contentLanguage, assumedKnowledge: data.draft.assumedKnowledge,
      outcomes: data.draft.outcomes, modules: data.draft.modules, lessonIds: section.lessons.map((lesson) => lesson.id), validationReceiptId: null, cover: null, createdAt: now, readyAt: null });
    const route = createNormalProgramEntries({ version, lessons: section.lessons, tasks: section.tasks.map(({ candidate }) => ({ task: candidate.task, assessment: candidate.privateTask.assessment })) });
    expect(route.next.map((entry) => entry.taskId)).toEqual(section.tasks.filter(({ candidate }) => candidate.privateTask.assessment.role === "required").map(({ candidate }) => candidate.task.id));
  });
  it("does not count renamed clones or reused evidence groups as independent reserve material", () => {
    const sameGroup = adaptiveFixture(); sameGroup.modules[0]!.tasks[2]!.candidate.privateTask.assessment.evidenceGroupId = sameGroup.modules[0]!.tasks[0]!.candidate.privateTask.assessment.evidenceGroupId;
    expect(validateAdaptiveMaterial(sameGroup.modules).some((issue) => issue.code === "invalid_transfer")).toBe(true);
    const copied = adaptiveFixture(); copied.modules[0]!.tasks[2]!.candidate.task.config = structuredClone(copied.modules[0]!.tasks[0]!.candidate.task.config); copied.modules[0]!.tasks[2]!.candidate.task.instruction = copied.modules[0]!.tasks[0]!.candidate.task.instruction;
    expect(validateAdaptiveMaterial(copied.modules).some((issue) => issue.code === "invalid_transfer")).toBe(true);
  });
  it("requires a fresh canonical-criterion reserve for actual irreversible prediction mechanics", async () => {
    const data = adaptiveFixture(), section = data.modules[0]!, prediction = registryFixtures.find((entry) => entry.id === "outcome_prediction")!, sample = await prediction.make();
    sample.task.id = section.tasks[0]!.candidate.task.id; sample.task.outcomeIds = section.tasks[0]!.candidate.task.outcomeIds;
    const input = authored(sample, prediction.dimensions); input.privateTask.sourceClaimIds = [data.claims[0]!.id];
    input.privateTask.assessment.outcomes[0]!.dimensions[0]!.dimensionId = "affine_rule";
    section.tasks[0]!.candidate = prepareTaskCandidate(input, { approvalDigest: digest });
    expect(validateAdaptiveMaterial(data.modules)).toEqual([]);
    for (const { candidate } of section.tasks.filter((entry) => entry.candidate.privateTask.assessment.role !== "required")) candidate.privateTask.assessment.evidenceGroupId = input.privateTask.assessment.evidenceGroupId;
    expect(validateAdaptiveMaterial(data.modules).some((issue) => issue.message.includes("Locked prediction criterion"))).toBe(true);
  });
});
