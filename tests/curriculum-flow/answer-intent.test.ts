import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { advanceCurriculumPatch } from "../../src/server/agent-turns/curriculum-patch";
import * as repository from "../../src/server/curricula/repository";
import * as service from "../../src/server/curricula/service";
import { PostgresCurriculumResearchRepository } from "../../src/server/curriculum-research/repository";
import { applyCurriculumChanges } from "../../src/server/curricula/changes";
import { curriculumDigest } from "../../src/domain/course";
import type { ModelPort } from "../../src/server/ai/ports";
import type { DbTransaction } from "../../src/server/db";
import type { RunContext } from "../../src/server/runs/ports";
import { artifact, ids, now, researchFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

async function setup(extraAssessment = false) {
  const fixture = await researchFixture();
  fixture.draft.unresolvedQuestions = [{ id: ids.question, text: "What prior programming experience do you have?", blocking: true }];
  vi.spyOn(repository, "requireDraft").mockResolvedValue({ course: {} as never, draft: fixture.draft });
  vi.spyOn(PostgresCurriculumResearchRepository.prototype, "loadEvidence").mockResolvedValue({ evidence: fixture.evidence, facts: fixture.facts });
  const patch = vi.spyOn(service, "patchCurriculumInTransaction").mockImplementation(async (_tx, input) => {
    const draft = applyCurriculumChanges(fixture.draft, input.request, { now, verifiedAnswers: input.answers?.verifications ?? [] }).draft;
    return { draft, contentDigest: await curriculumDigest(draft), artifact: { ...artifact(), title: draft.title, curriculum: draft } };
  });
  const assessment = { questionId: ids.question, decision: "resolved", followUp: null, basis: "user_context", claimIds: [], rationale: "The answer states the learner's own experience." };
  const generateStructured = vi.fn(async () => ({ data: { assessments: [assessment, ...(extraAssessment ? [{ ...assessment, questionId: ids.missing }] : [])] } }));
  const model = { generateStructured } as unknown as ModelPort;
  const target = { kind: "agent_turn" as const, runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample, inputMessageId: ids.missing };
  const tx = {} as DbTransaction;
  const completeTurn = vi.fn();
  const context: RunContext = {
    claim: { jobId: ids.approval, leaseOwner: "test", fencingToken: "1", retryEpoch: 0, target }, signal: new AbortController().signal,
    read: (work) => work(tx, target),
    async step(spec) {
      const output = spec.outputSchema.parse(await spec.effect({ stepId: ids.task, deadlineAt: Date.now() + 10000, signal: context.signal,
        stepFence: { jobId: ids.approval, jobLeaseOwner: "test", jobFencingToken: "1", retryEpoch: 0, stepId: ids.task, stepLeaseOwner: "test", stepFencingToken: "1" },
        budgetOperation: () => ({ logicalOperationId: ids.request, reservationId: ids.sample, attempt: 1, runStepId: ids.task, probe: false }),
      }, spec.input));
      return spec.resultSchema.parse(await spec.commit(tx, output));
    },
    emitChat: async (_tx, payload) => ({ ...payload, id: ids.task, runId: target.runId, branchId: target.branchId, seq: 1, at: now }),
    emitGeneration: async () => { throw new Error("Unexpected generation event"); }, completeTurn,
    completeGeneration: async () => { throw new Error("Unexpected generation completion"); },
  };
  const intent = { draftId: fixture.draft.id, expectedRevision: fixture.draft.revision, changes: [
    { op: "set_details" as const, title: "Keep this exact requested title" },
    { op: "answer_question" as const, id: ids.question, answer: "I use Python daily." },
  ] };
  return { context, intent, model, patch, generateStructured, completeTurn };
}

it("uses a step-bound model assessment and applies the exact captured mixed batch", async () => {
  const test = await setup();
  expect(await advanceCurriculumPatch(test.context, test.intent, test.model)).toEqual({ status: "succeeded" });
  expect(test.patch.mock.calls[0]![1].request).toEqual({ expectedRevision: test.intent.expectedRevision, changes: test.intent.changes });
  expect(test.generateStructured).toHaveBeenCalledWith(expect.objectContaining({ budget: expect.objectContaining({ runStepId: ids.task, probe: false }) }), expect.any(AbortSignal));
  expect(test.completeTurn).toHaveBeenCalledOnce();
});

it("rejects an extra model-selected question before any batch mutation", async () => {
  const test = await setup(true);
  await expect(advanceCurriculumPatch(test.context, test.intent, test.model)).rejects.toMatchObject({ code: "invalid_output" });
  expect(test.patch).not.toHaveBeenCalled();
  expect(test.completeTurn).not.toHaveBeenCalled();
});

it("rejects a superseded captured revision before invoking the model", async () => {
  const test = await setup();
  await expect(advanceCurriculumPatch(test.context, { ...test.intent, expectedRevision: test.intent.expectedRevision + 1 }, test.model)).rejects.toMatchObject({ status: 409 });
  expect(test.generateStructured).not.toHaveBeenCalled();
  expect(test.patch).not.toHaveBeenCalled();
});
