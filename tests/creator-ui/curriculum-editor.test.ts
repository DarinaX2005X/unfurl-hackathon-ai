import { describe, expect, it } from "vitest";
import {
  createCurriculumEditBuffer,
  curriculumPatchForBuffer,
  CurriculumEditError,
  rebaseCurriculumPatch,
} from "../../src/features/creator/curriculum-editor";
import { curriculum, ids } from "../domain/fixtures";

const newOutcomeId = "70000000-0000-4000-8000-000000000001";
const newModuleId = "70000000-0000-4000-8000-000000000002";

describe("typed programme edit buffer", () => {
  it("emits details, additions, prerequisites, removals and a complete module reorder", () => {
    const buffer = createCurriculumEditBuffer(curriculum());
    buffer.working.goal = "Understand a model, then test how it behaves in a small system.";
    buffer.working.assumedKnowledge = ["Basic algebra", "A little Python"];
    buffer.working.outcomes[0] = { ...buffer.working.outcomes[0]!, demonstration: "Compare two fitted models using held-out evidence." };
    buffer.working.outcomes.push({ id: newOutcomeId, title: "Inspect a deployed system", demonstration: "Trace a prediction through a service boundary.",
      prerequisiteOutcomeIds: [ids.outcomeA], requirement: "specialization" });
    buffer.working.modules.push({ id: newModuleId, title: "From model to service", summary: "Connect model behavior to its serving system.",
      outcomeIds: [newOutcomeId], prerequisiteModuleIds: [ids.moduleA], estimatedStudyMinutes: 45 });
    buffer.working.modules = [buffer.working.modules[0]!, buffer.working.modules[2]!, buffer.working.modules[1]!];
    const patch = curriculumPatchForBuffer(buffer);
    expect(patch.expectedRevision).toBe(1);
    expect(patch.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "set_details", goal: buffer.working.goal, assumedKnowledge: buffer.working.assumedKnowledge }),
      { op: "add_outcome", outcome: buffer.working.outcomes[2] },
      { op: "add_module", module: buffer.working.modules[1], afterModuleId: ids.moduleA },
      { op: "reorder_modules", moduleIds: [ids.moduleA, newModuleId, ids.moduleB] },
    ]));
  });

  it("allows an explicit atomic reference repair instead of cascading a removal", () => {
    const buffer = createCurriculumEditBuffer(curriculum());
    buffer.working.outcomes = buffer.working.outcomes.filter((item) => item.id !== ids.outcomeB);
    buffer.working.modules = buffer.working.modules.filter((item) => item.id !== ids.moduleB);
    expect(curriculumPatchForBuffer(buffer).changes).toEqual(expect.arrayContaining([
      { op: "remove_outcome", id: ids.outcomeB },
      { op: "remove_module", id: ids.moduleB },
      { op: "reorder_modules", moduleIds: [ids.moduleA] },
    ]));
  });

  it("rejects a dangling reference rather than silently deleting or repairing it", () => {
    const buffer = createCurriculumEditBuffer(curriculum());
    buffer.working.outcomes = buffer.working.outcomes.filter((item) => item.id !== ids.outcomeB);
    expect(() => curriculumPatchForBuffer(buffer)).toThrow(CurriculumEditError);
  });

  it("never turns language, sources, questions or identities into browser-authored patches", () => {
    for (const mutate of [
      (buffer: ReturnType<typeof createCurriculumEditBuffer>) => { buffer.working.contentLanguage = "ja"; },
      (buffer: ReturnType<typeof createCurriculumEditBuffer>) => { buffer.working.sourceIds = []; },
      (buffer: ReturnType<typeof createCurriculumEditBuffer>) => { buffer.working.unresolvedQuestions = []; },
      (buffer: ReturnType<typeof createCurriculumEditBuffer>) => { buffer.working.courseId = ids.missing; },
    ]) {
      const buffer = createCurriculumEditBuffer(curriculum());
      mutate(buffer);
      expect(() => curriculumPatchForBuffer(buffer)).toThrow(CurriculumEditError);
    }
  });

  it("keeps question answers as an explicit verified operation", () => {
    const draft = curriculum();
    draft.unresolvedQuestions = [{ id: ids.question, text: "Which project should anchor the course?", blocking: true }];
    const buffer = createCurriculumEditBuffer(draft);
    buffer.answers[ids.question] = "A small image classifier.";
    expect(curriculumPatchForBuffer(buffer).changes).toContainEqual({ op: "answer_question", id: ids.question, answer: "A small image classifier." });
    expect(buffer.working.unresolvedQuestions).toEqual(draft.unresolvedQuestions);
  });

  it("revalidates the same user operations against the explicit canonical revision after a 409", () => {
    const buffer = createCurriculumEditBuffer(curriculum());
    buffer.working.audience = "Engineers moving from scripts to deployed systems.";
    const latest = { ...curriculum(), revision: 4, goal: "A concurrently revised goal." };
    const rebased = rebaseCurriculumPatch(buffer, latest);
    expect(rebased).toEqual({ expectedRevision: 4, changes: [{ op: "set_details", audience: buffer.working.audience }] });
    expect(buffer.working.goal).toBe(curriculum().goal);
  });

  it("rejects an empty save rather than manufacturing a revision", () => {
    expect(() => curriculumPatchForBuffer(createCurriculumEditBuffer(curriculum()))).toThrow("no_changes");
  });
});
