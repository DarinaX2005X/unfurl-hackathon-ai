import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CurriculumChangeSchema, CurriculumMutationResultSchema, EditCourseMetadataInputSchema, PatchCurriculumInputSchema } from "../../src/domain/curriculum-authoring";
import { answerDigest, applyCurriculumChanges, CurriculumChangeError, questionDigest, validateCurriculumOrder } from "../../src/server/curricula/changes";
import { artifact, curriculum, ids, now } from "./fixtures";

describe("typed curriculum mutations", () => {
  it("applies a whole repair batch atomically without implicit cascade deletion", () => {
    const original = curriculum();
    expect(() => applyCurriculumChanges(original, { expectedRevision: 1, changes: [{ op: "remove_outcome", id: ids.outcomeB }] }, { now })).toThrow(CurriculumChangeError);
    const result = applyCurriculumChanges(original, { expectedRevision: 1, changes: [
      { op: "remove_outcome", id: ids.outcomeB }, { op: "remove_module", id: ids.moduleB },
    ] }, { now });
    expect(result.draft.outcomes.map((item) => item.id)).toEqual([ids.outcomeA]);
    expect(result.draft.revision).toBe(2);
    expect(result.researchImpact).toBe("structure");
    expect(original).toEqual(curriculum());
  });

  it("rejects stale revisions before applying changes and preserves the input", () => {
    const original = curriculum();
    try { applyCurriculumChanges(original, { expectedRevision: 7, changes: [{ op: "set_details", title: "Changed" }] }, { now }); }
    catch (error) { expect(error).toMatchObject({ code: "revision_conflict", currentRevision: 1 }); }
    expect(original.title).toBe(curriculum().title);
  });

  it("requires complete unique reorder identities and prerequisite order", () => {
    for (const moduleIds of [[ids.moduleA], [ids.moduleA, ids.moduleA], [ids.moduleA, ids.missing], [ids.moduleB, ids.moduleA]]) {
      expect(() => applyCurriculumChanges(curriculum(), { expectedRevision: 1, changes: [{ op: "reorder_modules", moduleIds }] }, { now })).toThrow(CurriculumChangeError);
    }
  });

  it("detects outcome order violations even without explicit module edges", () => {
    const draft = curriculum();
    draft.modules[1]!.prerequisiteModuleIds = [];
    draft.modules.reverse();
    expect(validateCurriculumOrder(draft).some((issue) => issue.message.includes("outcome cannot"))).toBe(true);
  });

  it("checks DAGs and duplicate identities after edits", () => {
    for (const changes of [
      [{ op: "update_outcome" as const, id: ids.outcomeA, changes: { prerequisiteOutcomeIds: [ids.outcomeB] } }],
      [{ op: "add_outcome" as const, outcome: curriculum().outcomes[0]! }],
      [{ op: "update_module" as const, id: ids.moduleA, changes: { estimatedStudyMinutes: -1 } }],
    ]) expect(() => applyCurriculumChanges(curriculum(), { expectedRevision: 1, changes }, { now })).toThrow(CurriculumChangeError);
  });

  it("does not cap course depth or silently omit specialization outcomes", () => {
    const draft = curriculum();
    for (let index = 3; index <= 40; index++) {
      const id = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const previous = draft.modules.at(-1)!;
      draft.modules.push({ ...previous, id, title: `Further application ${index}`, prerequisiteModuleIds: [previous.id] });
    }
    expect(validateCurriculumOrder(draft)).toEqual([]);
    draft.outcomes.push({ ...draft.outcomes[0]!, id: ids.missing, requirement: "specialization" });
    expect(validateCurriculumOrder(draft)).toContainEqual(expect.objectContaining({ code: "uncovered_outcome" }));
  });

  it("treats unchanged content as a no-op and title-only edits separately from educational changes", () => {
    const draft = curriculum();
    expect(applyCurriculumChanges(draft, { expectedRevision: 1, changes: [{ op: "set_details", title: draft.title }] }, { now }))
      .toMatchObject({ changed: false, researchImpact: "none", draft: { revision: 1, updatedAt: draft.updatedAt } });
    expect(applyCurriculumChanges(draft, { expectedRevision: 1, changes: [{ op: "set_details", title: "A new title" }] }, { now }))
      .toMatchObject({ changed: true, researchImpact: "none", draft: { revision: 2 } });
    expect(applyCurriculumChanges(draft, { expectedRevision: 1, changes: [{ op: "set_details", audience: "A learner without programming experience." }] }, { now }).researchImpact).toBe("content");
  });

  it("requires server verification bound to the exact question and answer", () => {
    const draft = curriculum();
    const question = { id: ids.question, text: "Which programming experience should the course assume?", blocking: true };
    draft.unresolvedQuestions = [question];
    const request = { expectedRevision: 1, changes: [{ op: "answer_question" as const, id: ids.question, answer: "Basic Python" }] };
    expect(() => applyCurriculumChanges(draft, request, { now })).toThrow("question_unverified");
    const verification = { questionId: ids.question, questionDigest: questionDigest(question), answerDigest: answerDigest("Advanced Python"), decision: "resolved" as const, followUp: null };
    expect(() => applyCurriculumChanges(draft, request, { now, verifiedAnswers: [verification] })).toThrow("question_unverified");
    verification.answerDigest = answerDigest("Basic Python");
    const result = applyCurriculumChanges(draft, request, { now, verifiedAnswers: [verification] });
    expect(result.draft.unresolvedQuestions).toEqual([]);
    expect(result.answeredQuestions).toEqual([{ questionId: ids.question, question: question.text, answer: "Basic Python", resolved: true }]);
  });

  it("retains a blocking follow-up when the answer is insufficient", () => {
    const draft = curriculum();
    const question = { id: ids.question, text: "What prior mathematics should be assumed?", blocking: true };
    draft.unresolvedQuestions = [question];
    const result = applyCurriculumChanges(draft, { expectedRevision: 1, changes: [{ op: "answer_question", id: ids.question, answer: "Some" }] }, {
      now, verifiedAnswers: [{ questionId: ids.question, questionDigest: questionDigest(question), answerDigest: answerDigest("Some"), decision: "needs_clarification", followUp: "Have you studied algebra or calculus?" }],
    });
    expect(result.draft.unresolvedQuestions[0]).toMatchObject({ blocking: true, text: "Have you studied algebra or calculus?" });
  });

  it("rejects hidden authority, source changes, forced approval and direct language relabelling", () => {
    for (const command of [
      { op: "approve" }, { op: "set_details", ownerId: ids.actor }, { op: "set_details", sourceIds: [ids.source] },
      { op: "set_details", contentLanguage: "ja" }, { op: "answer_question", id: ids.question, answer: "yes", blocking: false },
      { op: "update_outcome", id: ids.outcomeA, changes: { id: ids.missing } }, { op: "set_details" },
    ]) expect(CurriculumChangeSchema.safeParse(command).success).toBe(false);
    expect(EditCourseMetadataInputSchema.safeParse({ expectedRevision: 1, title: "Title", summary: "Summary", contentLanguage: "ja" }).success).toBe(false);
    expect(PatchCurriculumInputSchema.safeParse({ expectedRevision: 1, changes: [], contentDigest: "0".repeat(64) }).success).toBe(false);
  });

  it("rejects acknowledgements with mismatched content under the same revision", () => {
    const value = artifact();
    const draft = curriculum();
    value.curriculum!.title = "A stale or unrelated payload";
    expect(CurriculumMutationResultSchema.safeParse({ draft, contentDigest: "0".repeat(64), artifact: value }).success).toBe(false);
  });
});
