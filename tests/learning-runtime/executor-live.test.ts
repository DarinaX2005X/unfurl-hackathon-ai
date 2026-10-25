import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { withLiveLearningFixture } from "./live-fixture";
import { createLearningService } from "@/server/learning/service";
import { createLearningRunHandlers } from "@/server/learning/handlers";
import { getServerMechanic } from "@/server/mechanics/registry";
import { DurableRunExecutor } from "@/server/runs/executor";
import { RunHandlerRegistry } from "@/server/runs/registry";
import type { ModelPort } from "@/server/ai/ports";
import type { GradeDecision } from "@/server/evaluation/contracts";

const key = () => crypto.randomUUID();
const unavailable: GradeDecision = { status: "unavailable", outcome: null, dimensions: [], feedback: { explanation: "Injected transport outage", nextAction: "wait" } };
describe.skipIf(process.env.LEARNING_RUNTIME_DB_TESTS !== "1")("sole executor learning rollback proof", () => {
  it("grades the frozen input after navigation, retries the same review job, preserves uncertain credit and applies one definite correction", async () => {
    await withLiveLearningFixture(async ({ actor, program, tx, transactions }) => {
      const service = createLearningService({ transactions, admission: { async assertAvailable() { /* Explicit test seam; no provider admission claim. */ } } });
      const generateStructured = vi.fn(() => { throw new Error("No paid provider call is allowed in this rollback proof"); });
      const model = { generateStructured } as unknown as ModelPort;
      const executor = new DurableRunExecutor(new RunHandlerRegistry(createLearningRunHandlers({ model })), (work) => transactions.run(work));
      const initial = await service.loadSession(actor, program.enrollmentId);
      const position = await service.advance(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: 1 } });
      const task = position.data.task!, handle = getServerMechanic(task.mechanicId, task.mechanicVersion)!;
      const started = await service.startActivity(actor, program.enrollmentId, { key: key(), body: { taskId: task.id, taskVersion: 1 } });
      const saved = await service.saveInput(actor, started.data.activity.id, { key: key(), body: { expectedInputRevision: 0,
        response: { kind: "state_tracing", action: "trace", states: [{ w: -0.2 }, { w: -0.1 }] } } });
      const failInitial = vi.spyOn(handle, "evaluate").mockResolvedValueOnce(unavailable);
      let submitted;
      try { submitted = await service.submitAttempt(actor, program.enrollmentId, { key: key(), body: { ...saved.data.savedInput!, taskId: task.id, taskVersion: 1, clientAttemptId: key() } }); }
      finally { failInitial.mockRestore(); }
      expect(submitted.data.evaluation.evaluation.status).toBe("pending");
      const attemptId = submitted.data.attemptId, evaluationId = submitted.data.evaluation.evaluation.id;
      const initialJob = (await tx.query("SELECT id,retry_epoch FROM unfurl.execution_jobs WHERE evaluation_id=$1 AND target_evaluation_revision=1", [evaluationId])).rows[0]!;
      await service.saveInput(actor, started.data.activity.id, { key: key(), body: { expectedInputRevision: 1,
        response: { kind: "state_tracing", action: "trace", states: [{ w: 999 }, { w: 999 }] } } });
      await service.revisit(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: position.data.route.revision, lessonId: program.lessons[0]!.id, taskId: null } });
      expect((await executor.advance(initialJob.id)).status).toBe("finished");
      const evaluated = await service.getEvaluation(actor, attemptId);
      expect(evaluated.evaluation).toMatchObject({ status: "evaluated", outcome: "correct", awardedXp: 25 });
      expect(evaluated.submittedInput.inputRevision).toBe(1);
      const afterGrade = await service.loadSession(actor, program.enrollmentId);
      expect(afterGrade.enrollment.currentLessonId).toBe(program.lessons[0]!.id);
      expect(afterGrade.progress.xpTotal).toBe(initial.progress.xpTotal + 25);
      expect((await service.getActivity(actor, started.data.activity.id)).savedInput!.inputRevision).toBe(2);
      expect((await executor.advance(initialJob.id)).status).toBe("finished");
      const review = await service.requestReview(actor, attemptId, { key: key(), body: { expectedEvaluationRevision: 1, reason: "valid_alternative", comment: "Please recheck the reasoning." } });
      expect(review.data.review.status).toBe("queued");
      expect(review.data.evaluation.evaluation.awardedXp).toBe(25);
      expect((await tx.query("SELECT review_state FROM unfurl.learner_evidence WHERE attempt_id=$1 AND evaluation_revision=1", [attemptId])).rows[0]!.review_state).toBe("contested");
      const reviewJob = (await tx.query("SELECT id,retry_epoch FROM unfurl.execution_jobs WHERE evaluation_id=$1 AND target_evaluation_revision=2", [evaluationId])).rows[0]!;
      const failReview = vi.spyOn(handle, "evaluate").mockResolvedValueOnce(unavailable);
      try { expect((await executor.advance(reviewJob.id)).status).toBe("finished"); } finally { failReview.mockRestore(); }
      expect((await service.getEvaluation(actor, attemptId)).review?.status).toBe("unavailable");
      const retryKey = key(), retryBody = { expectedEvaluationRevision: 1 };
      await service.retryReview(actor, attemptId, review.data.review.id, { key: retryKey, body: retryBody });
      await service.retryReview(actor, attemptId, review.data.review.id, { key: retryKey, body: retryBody });
      expect((await tx.query("SELECT retry_epoch FROM unfurl.execution_jobs WHERE id=$1", [reviewJob.id])).rows[0]!.retry_epoch).toBe(1);
      const uncertain: GradeDecision = { status: "uncertain", outcome: null, dimensions: ["step.1", "step.2"].map((id) => ({ id, status: "uncertain", explanation: "Injected unresolved review evidence" })), feedback: { explanation: "The review remains uncertain.", nextAction: "clarify" } };
      const uncertainReview = vi.spyOn(handle, "evaluate").mockResolvedValueOnce(uncertain);
      try { await executor.advance(reviewJob.id); } finally { uncertainReview.mockRestore(); }
      const uncertainReceipt = await service.getEvaluation(actor, attemptId);
      expect(uncertainReceipt).toMatchObject({ revision: 2, evaluation: { status: "uncertain", awardedXp: 0 }, review: { status: "resolved", resolution: "uncertain" } });
      expect((await service.loadSession(actor, program.enrollmentId)).progress.xpTotal).toBe(initial.progress.xpTotal + 25);
      const correction = await service.requestReview(actor, attemptId, { key: key(), body: { expectedEvaluationRevision: 2, reason: "other", comment: "Resolve the outstanding criterion." } });
      const correctionJob = (await tx.query("SELECT id FROM unfurl.execution_jobs WHERE evaluation_id=$1 AND target_evaluation_revision=3", [evaluationId])).rows[0]!;
      const incorrect: GradeDecision = { status: "evaluated", outcome: "incorrect", dimensions: ["step.1", "step.2"].map((id) => ({ id, status: "not_met", explanation: "Injected definite correction" })), feedback: { explanation: "The criterion is not met.", nextAction: "revise" } };
      const correctedReview = vi.spyOn(handle, "evaluate").mockResolvedValueOnce(incorrect);
      try { await executor.advance(correctionJob.id); } finally { correctedReview.mockRestore(); }
      const final = await service.getEvaluation(actor, attemptId);
      expect(final).toMatchObject({ revision: 3, review: { id: correction.data.review.id, resolution: "corrected" }, evaluation: { outcome: "incorrect", awardedXp: 0 } });
      expect((await service.loadSession(actor, program.enrollmentId)).progress.xpTotal).toBe(initial.progress.xpTotal);
      await executor.advance(correctionJob.id);
      expect((await tx.query("SELECT revision FROM unfurl.evaluation_revisions WHERE attempt_id=$1", [attemptId])).rowCount).toBe(3);
      expect((await tx.query("SELECT id FROM unfurl.attempts WHERE enrollment_id=$1", [program.enrollmentId])).rowCount).toBe(1);
      expect(generateStructured).not.toHaveBeenCalled();
    }, { predictionTask: false });
  }, 180_000);
});
