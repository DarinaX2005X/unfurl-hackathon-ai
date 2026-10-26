import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { validateEditorialTask } from "../../src/server/course-materialization/editorial";
import { EditorialPreviewMetadataSchema, previewFromVersion } from "../../src/server/course-materialization/preview-metadata";
import { taskDigest } from "../../src/server/mechanics/digest";
import { preparedFixture, id } from "../course-generation/fixtures";
import { previewFixture } from "./scope.test";

function taskFixture() {
  const data = preparedFixture(), authored = data.authored[0]!.tasks[0]!, candidate = data.modules[0]!.tasks[0]!.candidate;
  const validResponse = { kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: 2, intercept: 1 }, probeValues: [7] };
  const wrongResponse = { ...validResponse, probeValues: [8] };
  return { candidate, input: { lessonId: data.authored[0]!.lessons[0]!.id, authored, validResponse, wrongResponse } };
}
describe("editorial release evidence", () => {
  it("records the actual correct and incorrect production evaluator decisions without model receipts", async () => {
    const { candidate, input } = taskFixture(), proof = await validateEditorialTask(candidate, input);
    expect(proof.validatorVersion).toBe("editorial-deterministic-v1");
    expect(proof.cases[0]!.decision).toMatchObject({ status: "evaluated", outcome: "correct" });
    expect(proof.cases[1]!.decision.outcome).not.toBe("correct");
    expect(proof).not.toHaveProperty("reviewCallRef");
  });
  it("rejects a correct answer mislabeled as a negative test", async () => {
    const { candidate, input } = taskFixture();
    await expect(validateEditorialTask(candidate, { ...input, wrongResponse: input.validResponse })).rejects.toThrow("invalid evaluator case failed");
  });
  it("rejects malformed negative responses and stale authored candidates", async () => {
    const { candidate, input } = taskFixture();
    await expect(validateEditorialTask(candidate, { ...input, wrongResponse: { ...input.wrongResponse, probeValues: [null] } })).rejects.toThrow();
    input.authored.task.instruction = "Changed content";
    await expect(validateEditorialTask(candidate, input)).rejects.toThrow("candidate changed");
  });
  it("binds editorial provenance to content and keeps it distinct from generated-module metadata", () => {
    const { metadata, version } = previewFixture();
    const { completedStepId: _step, releaseDigest: _digest, ...original } = metadata;
    void _step; void _digest;
    const body = { ...original, kind: "official-editorial-section-v1" as const, sourcePlanStepId: id(70), sourceKnowledgeStepId: id(71),
      sourceReadingStepIds: [id(72)], editorialContentDigest: "d".repeat(64) };
    const editorial = EditorialPreviewMetadataSchema.parse({ ...body, releaseDigest: taskDigest(body) });
    expect(previewFromVersion(editorial, version)).toEqual(editorial);
    expect(() => previewFromVersion({ ...editorial, editorialContentDigest: "e".repeat(64) }, version)).toThrow();
  });
});
