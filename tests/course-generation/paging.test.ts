import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { assembleLessonReading, loadVerifiedLessonReading, type ReadingPiece } from "@/server/course-generation/reading-stages";
import { loadVerifiedModuleReview } from "@/server/course-generation/module-review-stages";
import { COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { getCapabilityCatalogDigest, getGenerationMechanicCatalog } from "@/server/mechanics/catalog";
import { MODULE_REVIEW_CATEGORIES } from "@/server/course-validation/module-review";
import { taskDigest } from "@/server/mechanics/digest";
import { jsonDigest } from "@/server/ai/json";
import { validateModulePlan, type ModulePlan } from "@/server/course-generation/planning";
import { assembleModulePlanPages, loadVerifiedModulePlan, type ModulePlanPage } from "@/server/course-generation/plan-stages";
import { runtime } from "../mechanic-registry/fixtures";
import { adaptiveFixture, fixture, id, digest } from "./fixtures";

// Synthetic rows exercise actual checkpoint/provider verification; they are not product or paid-call evidence.
function evidenceStore() {
  const steps = new Map<string, unknown>(), providers = new Map<string, { stepId: string; data: unknown }>(), inputDigests = new Map<string, string>();
  const binding = { run: { id: id(800) }, course: { id: id(801), ownerId: id(802) }, approval: { id: id(803), draftRevision: 1, contentDigest: digest }, draft: { contentLanguage: "en" } } as ApprovedBuildBinding;
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    let row: unknown;
    if (sql.includes("FROM unfurl.ai_provider_operations")) {
      const provider = providers.get(String(params[0]));
      if (provider && provider.stepId === params[1]) row = { operation_id: params[0], run_step_id: provider.stepId, input_digest: inputDigests.get(provider.stepId) ?? digest, request_digest: digest, response_digest: digest,
        provider_request_id: "synthetic-paging-contract", rate_card_digest: digest, state: "settled", usage: {}, result: { model: "moonshotai/kimi-k2.6", failure: null, finishReason: "stop", content: JSON.stringify(provider.data) } };
    } else if (steps.has(String(params[0]))) row = { id: params[0], input_digest: inputDigests.get(String(params[0])) ?? digest, result_reference: steps.get(String(params[0])),
      schema_digest: COURSE_GENERATION_SCHEMA_DIGEST, capability_digest: getCapabilityCatalogDigest(), validation_policy_digest: COURSE_VALIDATION_POLICY_DIGEST, approval_digest: digest };
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  return { binding, steps, providers, inputDigests, tx: { query } as unknown as DbTransaction };
}
function readingFixture() {
  const data = fixture(), sourceLesson = data.authored[0]!.lessons[0]!, block = sourceLesson.blocks[0]!;
  const lesson: ModulePlan["lessons"][number] = { id: sourceLesson.id, title: sourceLesson.title, outcomeIds: sourceLesson.outcomeIds,
    blocks: [{ id: block.id, kind: "explanation", outcomeIds: sourceLesson.outcomeIds, claimIds: [data.claims[0]!.id], teachingPurpose: "Teach the complete reasoning.", title: null }] };
  const pieces: ReadingPiece[] = [
    { lessonId: lesson.id, blockId: block.id, part: 0, text: "First complete teaching section. ".repeat(700).trim(), complete: false },
    { lessonId: lesson.id, blockId: block.id, part: 1, text: "Further worked reasoning and examples. ".repeat(700).trim(), complete: true },
  ];
  return { data, lesson, pieces };
}
describe("saved reading block continuations", () => {
  it("assembles all pieces without a lesson-length truncation and derives exact grounded citations", () => {
    const { data, lesson, pieces } = readingFixture(), reading = assembleLessonReading(lesson, pieces, data.context);
    expect(reading.blocks[0]).toEqual({ id: pieces[0]!.blockId, kind: "explanation", markdown: pieces.map((piece) => piece.text).join("\n\n"), sourceIds: [data.source.id] });
    expect(reading.readingEvidence[0]!.claimIds).toEqual([data.claims[0]!.id]);
  });
  it("rejects missing continuations, duplicate parts and another block's text", () => {
    const { data, lesson, pieces } = readingFixture();
    expect(() => assembleLessonReading(lesson, pieces.slice(0, 1), data.context)).toThrow();
    expect(() => assembleLessonReading(lesson, [pieces[0]!, { ...pieces[1]!, part: 0 }], data.context)).toThrow();
    expect(() => assembleLessonReading(lesson, [{ ...pieces[0]!, blockId: id(999) }, pieces[1]!], data.context)).toThrow();
  });
  it("requires every saved piece to match its own actual provider response", async () => {
    const store = evidenceStore(), { data, lesson, pieces } = readingFixture(), reading = assembleLessonReading(lesson, pieces, data.context);
    pieces.forEach((piece, index) => {
      store.steps.set(id(810 + index), { kind: "course.model", operationId: id(820 + index), data: piece }); store.providers.set(id(820 + index), { stepId: id(810 + index), data: piece });
      store.inputDigests.set(id(810 + index), jsonDigest({ lesson: { id: lesson.id, title: lesson.title, outcomeIds: lesson.outcomeIds }, block: lesson.blocks[0], part: index,
        continuation: { previousParts: index, previousPartTail: index ? pieces[index - 1]!.text.slice(-8000) : null }, contentLanguage: "en", knowledge: data.knowledge[0], claims: data.context.claims, passages: data.context.passages }));
    });
    store.steps.set(id(830), { kind: "course.lesson.reading", planStepId: id(840), reading, pieceStepIds: [id(810), id(811)] });
    await expect(loadVerifiedLessonReading(store.tx, store.binding, id(830), id(840), lesson, data.context, data.knowledge[0]!)).resolves.toEqual(reading);
    store.providers.delete(id(821));
    await expect(loadVerifiedLessonReading(store.tx, store.binding, id(830), id(840), lesson, data.context, data.knowledge[0]!)).rejects.toThrow("provider.invalid_output");
  });
});
describe("outcome review pages", () => {
  function reviewFixture() {
    const store = evidenceStore(), material = { moduleDigest: digest, approvedOutcomes: [{ id: id(900) }, { id: id(901) }], lessons: [{ title: "Actual full-module context" }] };
    const pages = material.approvedOutcomes.map((outcome, index) => {
      const review = { moduleDigest: digest, checks: MODULE_REVIEW_CATEGORIES.map((category) => ({ outcomeId: outcome.id, category, status: "passed", explanation: "Synthetic review-page contract.", correction: null, evidence: [{ path: ["lessons", 0, "title"], value: material.lessons[0]!.title }] })) };
      store.steps.set(id(910 + index), { kind: "course.model", operationId: id(920 + index), data: review }); store.providers.set(id(920 + index), { stepId: id(910 + index), data: review });
      store.inputDigests.set(id(910 + index), jsonDigest(material));
      return { outcomeId: outcome.id, stepId: id(910 + index), review };
    });
    const checkpoint = { kind: "course.module.review", moduleDigest: digest, materialDigest: taskDigest(material), pages: pages.map(({ review: _review, ...page }) => { void _review; return page; }), review: { moduleDigest: digest, checks: pages.flatMap((page) => page.review.checks) } };
    store.steps.set(id(930), checkpoint);
    return { ...store, material, checkpoint, pages };
  }
  it("verifies every outcome's seven categories against separate provider records", async () => {
    const data = reviewFixture();
    const result = await loadVerifiedModuleReview(data.tx, data.binding, id(930), data.material);
    expect(result.review.checks).toHaveLength(14); expect(result.passed).toBe(true);
    data.providers.delete(id(921));
    await expect(loadVerifiedModuleReview(data.tx, data.binding, id(930), data.material)).rejects.toThrow("provider.invalid_output");
  });
  it("cannot reuse one outcome's page to satisfy another outcome or invent aggregate findings", async () => {
    const wrongScope = reviewFixture(); wrongScope.checkpoint.pages[1]!.outcomeId = id(900);
    await expect(loadVerifiedModuleReview(wrongScope.tx, wrongScope.binding, id(930), wrongScope.material)).rejects.toThrow();
    const tampered = reviewFixture(); tampered.checkpoint.review.checks = structuredClone(tampered.checkpoint.review.checks); tampered.checkpoint.review.checks[0]!.explanation = "Invented aggregate verdict";
    await expect(loadVerifiedModuleReview(tampered.tx, tampered.binding, id(930), tampered.material)).rejects.toThrow();
    const wrongInput = reviewFixture(); wrongInput.inputDigests.set(id(910), "f".repeat(64));
    await expect(loadVerifiedModuleReview(wrongInput.tx, wrongInput.binding, id(930), wrongInput.material)).rejects.toThrow();
  });
});

describe("saved metadata planning continuations", () => {
  function planFixture() {
    const store = evidenceStore(), data = adaptiveFixture(), section = data.authored[0]!, originalLesson = section.lessons[0]!, outcomeId = data.draft.outcomes[0]!.id;
    store.binding.draft = data.draft;
    const reading = { id: originalLesson.blocks[0]!.id, kind: "explanation" as const, outcomeIds: [outcomeId], claimIds: [data.claims[0]!.id], teachingPurpose: "Teach the grounded reasoning.", title: null };
    const slots: ModulePlan["tasks"] = section.tasks.map((entry) => ({ id: entry.task.id, lessonId: originalLesson.id, outcomeIds: entry.task.outcomeIds,
      mechanicId: entry.task.mechanicId, mechanicVersion: entry.task.mechanicVersion, assessmentRole: entry.privateTask.assessment.role, design: entry.design,
      criteria: [{ outcomeId, criterionIds: ["affine_rule"] }] }));
    const nextLessonId = id(970), nextReadingId = id(971);
    const pages: ModulePlanPage[] = [
      { moduleId: section.moduleId, outcomeId, part: 0, complete: false, tasks: slots.slice(0, 2), coverage: data.coverage[0]!,
        lessons: [{ id: originalLesson.id, title: originalLesson.title, outcomeIds: [outcomeId], blocks: [reading, ...originalLesson.blocks.flatMap((block) => block.kind === "task" && slots.slice(0, 2).some((slot) => slot.id === block.taskId) ? [block] : [])] }] },
      { moduleId: section.moduleId, outcomeId, part: 1, complete: true, tasks: slots.slice(2).map((slot) => ({ ...slot, lessonId: nextLessonId })),
        coverage: { outcomeId, introducedAt: [{ lessonId: nextLessonId, blockId: nextReadingId }], practicedTaskIds: [], demonstratedTaskIds: [] },
        lessons: [{ id: nextLessonId, title: "Optional adaptive extensions", outcomeIds: [outcomeId], blocks: [{ ...reading, id: nextReadingId }, ...originalLesson.blocks.flatMap((block) => block.kind === "task" && slots.slice(2).some((slot) => slot.id === block.taskId) ? [block] : [])] }] },
    ];
    const pageStepIds = pages.map((page, index) => {
      const stepId = id(980 + index), operationId = id(985 + index), material = { module: data.draft.modules[0], approvedOutcomes: data.draft.outcomes, knowledge: data.knowledge[0],
        catalog: getGenerationMechanicCatalog(runtime), scope: { outcomeId, part: index }, previousPlan: assembleModulePlanPages(section.moduleId, pages.slice(0, index)) };
      store.steps.set(stepId, { kind: "course.module.plan.page", operationId, material, proposal: page }); store.providers.set(operationId, { stepId, data: page }); store.inputDigests.set(stepId, jsonDigest(material));
      return stepId;
    });
    const checkpoint = { kind: "course.module.plan", moduleId: section.moduleId, pageStepIds, plan: assembleModulePlanPages(section.moduleId, pages) };
    store.steps.set(id(990), checkpoint);
    return { ...store, data, pages, checkpoint };
  }
  it("retains required coverage, optional roles, lesson order and all task IDs across pages", async () => {
    const data = planFixture(), result = await loadVerifiedModulePlan(data.tx, data.binding, id(990), data.data.knowledge[0]!);
    expect(result.plan.tasks.map((task) => task.assessmentRole)).toEqual(["required", "required", "practice", "diagnostic", "challenge"]);
    expect(result.plan.lessons).toHaveLength(2);
    expect(validateModulePlan(result.plan, { draft: data.data.draft, knowledge: data.data.knowledge[0]!, runtime })).toEqual([]);
  });
  it("rejects an unfinished metadata sequence or a missing original page response", async () => {
    const unfinished = planFixture(); unfinished.checkpoint.pageStepIds.pop();
    await expect(loadVerifiedModulePlan(unfinished.tx, unfinished.binding, id(990), unfinished.data.knowledge[0]!)).rejects.toThrow();
    const missing = planFixture(); missing.providers.delete(id(986));
    await expect(loadVerifiedModulePlan(missing.tx, missing.binding, id(990), missing.data.knowledge[0]!)).rejects.toThrow();
  });
});
