import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { BoundedModulePlanPageSchema, projectPlanPageIdentities, ServerIdentityPlanPageSchema } from "@/server/course-generation/plan-stages";
import { CourseGenerationPolicyCheckpointSchema } from "@/server/course-generation/checkpoints";
import { id } from "./fixtures";

function page() {
  return ServerIdentityPlanPageSchema.parse({ moduleId: id(1), outcomeId: id(2), part: 0, complete: false, publicCommentary: null,
    lessons: [{ id: "lesson-one", title: "Array memory", outcomeIds: [id(2)], blocks: [
      { id: "17ad29a6-e24b-48d9-c26d-8af6753ec709", kind: "explanation", outcomeIds: [id(2)], claimIds: [id(3)], title: null, teachingPurpose: "Explain shared storage." },
      { id: "28be3ab7-f35c-49ea-d37e-9ba7864fd81a", kind: "task", taskId: "task-one" },
    ] }],
    tasks: [{ id: "task-one", lessonId: "lesson-one", outcomeIds: [id(2)], mechanicId: "artifact_construction", mechanicVersion: 3,
      assessmentRole: "required", criteria: [{ outcomeId: id(2), criterionIds: ["memory"] }],
      design: { taskId: "task-one", purpose: "practice", learnerAction: "Inspect memory layout.", mechanicRationale: "Construct a working calculation.", affordances: ["python_source_editor"], transfer: null } }],
    coverage: { outcomeId: id(2), introducedAt: [{ lessonId: "lesson-one", blockId: "17ad29a6-e24b-48d9-c26d-8af6753ec709" }], practicedTaskIds: ["task-one"], demonstratedTaskIds: [] },
  });
}
describe("server-assigned plan identities", () => {
  it("repairs the observed invalid UUID variants while preserving teaching content and all references", () => {
    const raw = page(), before = structuredClone(raw), result = projectPlanPageIdentities(raw, id(20));
    expect(BoundedModulePlanPageSchema.safeParse(raw).success).toBe(false);
    expect(BoundedModulePlanPageSchema.safeParse(result).success).toBe(true);
    expect(raw).toEqual(before);
    expect(result.lessons[0]!.blocks.map(block => IdSchema.safeParse(block.id).success)).toEqual([true, true]);
    expect(result.lessons[0]!.blocks[0]).toMatchObject({ teachingPurpose: "Explain shared storage.", claimIds: [id(3)], outcomeIds: [id(2)] });
    expect(result.tasks[0]!.lessonId).toBe(result.lessons[0]!.id);
    expect(result.tasks[0]!.design.taskId).toBe(result.tasks[0]!.id);
    expect(result.lessons[0]!.blocks[1]).toMatchObject({ taskId: result.tasks[0]!.id });
    expect(result.coverage.introducedAt[0]).toEqual({ lessonId: result.lessons[0]!.id, blockId: result.lessons[0]!.blocks[0]!.id });
    expect(result.coverage.practicedTaskIds).toEqual([result.tasks[0]!.id]);
    expect(projectPlanPageIdentities(raw, id(20))).toEqual(result);
    expect(projectPlanPageIdentities(raw, id(21)).lessons[0]!.id).not.toBe(result.lessons[0]!.id);
  });
  it("preserves valid references to earlier pages and rejects unresolved local labels", () => {
    const raw = page();
    raw.tasks[0]!.design.transfer = { fromTaskIds: [id(30)], changedContext: "A different array shape.", independentDemand: "Infer the new layout." };
    expect(projectPlanPageIdentities(raw, id(20)).tasks[0]!.design.transfer?.fromTaskIds).toEqual([id(30)]);
    raw.tasks[0]!.design.transfer.fromTaskIds = ["missing-earlier-task"];
    expect(() => projectPlanPageIdentities(raw, id(20))).toThrow();
  });
  it("rejects duplicate local identities and never repairs source or approved scope identities", () => {
    const raw = page(); raw.lessons[0]!.blocks[1]!.id = raw.lessons[0]!.blocks[0]!.id;
    expect(() => projectPlanPageIdentities(raw, id(20))).toThrow();
    expect(ServerIdentityPlanPageSchema.safeParse({ ...page(), outcomeId: "bad-outcome" }).success).toBe(false);
    const badSource = page(); const reading = badSource.lessons[0]!.blocks[0]!;
    if (reading.kind !== "task") reading.claimIds = ["bad-source"];
    expect(ServerIdentityPlanPageSchema.safeParse(badSource).success).toBe(false);
  });
  it("exports a plain wire schema and retains the historical policy option", () => {
    expect(() => z.toJSONSchema(ServerIdentityPlanPageSchema)).not.toThrow();
    const common = { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384, approvalDigest: "a".repeat(64) };
    expect(CourseGenerationPolicyCheckpointSchema.parse({ ...common, planPagePolicy: "bounded-plan-pages-v1" }).planPagePolicy).toBe("bounded-plan-pages-v1");
    expect(CourseGenerationPolicyCheckpointSchema.parse({ ...common, planPagePolicy: "server-plan-identities-v2" }).planPagePolicy).toBe("server-plan-identities-v2");
  });
});
