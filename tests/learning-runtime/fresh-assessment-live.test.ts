import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { withLiveLearningFixture } from "./live-fixture";
import { outcomePredictionDescriptor } from "@/domain/mechanic-families/v2/investigation";
import { prediction } from "../mechanics/investigation/fixtures";
import { createLearningService } from "@/server/learning/service";

const key = () => crypto.randomUUID();
describe.skipIf(process.env.LEARNING_RUNTIME_DB_TESTS !== "1")("fresh assessment rollback proof", () => {
  it("recovers an unmet criterion after a frozen wrong prediction and completed traversal without resetting history or farming XP", async () => {
    await withLiveLearningFixture(async ({ actor, program, service, tx, transactions }) => {
      const initial = await service.loadSession(actor, program.enrollmentId);
      let session = (await service.advance(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: 1 } })).data;
      const predictionTask = session.task!;
      const activity = (await service.startActivity(actor, program.enrollmentId, { key: key(), body: { taskId: predictionTask.id, taskVersion: 1 } })).data.activity;
      const draft = { ...outcomePredictionDescriptor.createInitialResponse(prediction), interval: { lower: 0, upper: 0, unit: "unitless" as const } };
      let saved = (await service.saveInput(actor, activity.id, { key: key(), body: { expectedInputRevision: 0, response: draft } })).data;
      const commitment = (await service.dispatchAction(actor, activity.id, { key: key(), body: { expectedRevision: 1, clientActionId: key(), inputRevision: 1,
        responseDigest: saved.savedInput!.responseDigest, action: { kind: "prediction.commit" } } })).data;
      saved = (await service.saveInput(actor, activity.id, { key: key(), body: { expectedInputRevision: 1, response: { ...draft, commitReceiptId: commitment.receipt.id } } })).data;
      const observed = (await service.dispatchAction(actor, activity.id, { key: key(), body: { expectedRevision: commitment.activity.revision, clientActionId: key(), inputRevision: 2,
        responseDigest: saved.savedInput!.responseDigest, action: { kind: "run" } } })).data;
      saved = (await service.saveInput(actor, activity.id, { key: key(), body: { expectedInputRevision: 2, response: { ...draft, commitReceiptId: commitment.receipt.id, observationReceiptId: observed.receipt.id } } })).data;
      const failed = (await service.submitAttempt(actor, program.enrollmentId, { key: key(), body: { ...saved.savedInput!, taskId: predictionTask.id, taskVersion: 1, clientAttemptId: key() } })).data;
      expect(failed.evaluation.evaluation.outcome).toBe("incorrect");
      const original = await service.getActivity(actor, activity.id);
      session = (await service.advance(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: failed.route.revision } })).data;
      const lastRequired = session.task!;
      const lastActivity = (await service.startActivity(actor, program.enrollmentId, { key: key(), body: { taskId: lastRequired.id, taskVersion: 1 } })).data.activity;
      const lastInput = (await service.saveInput(actor, lastActivity.id, { key: key(), body: { expectedInputRevision: 0,
        response: { kind: "state_tracing", action: "trace", states: [{ w: 999 }, { w: 999 }] } } })).data.savedInput!;
      const lastFailure = (await service.submitAttempt(actor, program.enrollmentId, { key: key(), body: { ...lastInput, taskId: lastRequired.id, taskVersion: 1, clientAttemptId: key() } })).data;
      // Automatic support may be offered after two independent failures; explicitly decline it before recovery.
      if (lastFailure.support?.status === "offered") await service.respondToSupport(actor, program.enrollmentId, lastFailure.support.id,
        { key: key(), body: { expectedRouteRevision: lastFailure.route.revision, response: "decline" } });
      session = (await service.advance(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: lastFailure.route.revision } })).data;
      expect(session.route.next).toEqual([]);
      expect(session.enrollment.status).toBe("active");
      expect((await service.loadContext(actor, program.enrollmentId)).freshAssessment.availability).toBe("available");
      session = (await service.revisit(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: session.route.revision,
        lessonId: program.lessons[1]!.id, taskId: predictionTask.id } })).data;
      expect(session.activity?.id).toBe(activity.id);
      await expect(service.dispatchAction(actor, activity.id, { key: key(), body: { expectedRevision: original.activity.revision, clientActionId: key(),
        inputRevision: original.savedInput!.inputRevision, responseDigest: original.savedInput!.responseDigest, action: { kind: "prediction.commit" } } })).rejects.toMatchObject({ status: 409 });
      const request = { key: key(), body: { expectedRouteRevision: session.route.revision } };
      await tx.query("SAVEPOINT fresh_pending_review");
      const admitted = createLearningService({ transactions, admission: { async assertAvailable() { /* No runner/provider call: authority-only probe. */ } } });
      await admitted.requestReview(actor, failed.attemptId, { key: key(), body: { expectedEvaluationRevision: 1, reason: "other", comment: "Check this prediction assessment." } });
      expect((await service.loadContext(actor, program.enrollmentId)).freshAssessment).toMatchObject({ availability: "blocked", blockedReason: "review_active" });
      const blockedSession = await service.loadSession(actor, program.enrollmentId);
      await expect(service.requestFreshAssessment(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: blockedSession.route.revision } })).rejects.toMatchObject({ messageKey: "learning.freshAssessment.review_active" });
      await tx.query("ROLLBACK TO SAVEPOINT fresh_pending_review");
      await tx.query("RELEASE SAVEPOINT fresh_pending_review");
      await expect(service.requestFreshAssessment({ ...actor, id: key() }, program.enrollmentId, request)).rejects.toMatchObject({ status: 404 });
      session = (await service.requestFreshAssessment(actor, program.enrollmentId, request)).data;
      expect(session.task?.id).toBe(program.tasks[1]!.task.id);
      expect(session.activity?.id).not.toBe(activity.id);
      expect(session.route.next).toHaveLength(1);
      expect(session.route.next[0]?.reasonCode).toBe("scheduled_review");
      expect((await service.requestFreshAssessment(actor, program.enrollmentId, request)).data.activity?.id).toBe(session.activity?.id);
      expect((await service.loadContext(actor, program.enrollmentId)).freshAssessment.availability).toBe("no_unseen_assessment");
      await expect(service.requestFreshAssessment(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: session.route.revision } })).rejects.toMatchObject({ messageKey: "learning.freshAssessment.noUnseenAssessment" });
      expect(await service.getActivity(actor, activity.id)).toEqual(original);
      const response = (await service.saveInput(actor, session.activity!.id, { key: key(), body: { expectedInputRevision: 0,
        response: { kind: "state_tracing", action: "trace", states: [{ w: -0.2 }, { w: -0.1 }] } } })).data.savedInput!;
      const recovered = (await service.submitAttempt(actor, program.enrollmentId, { key: key(), body: { ...response, taskId: session.task!.id, taskVersion: 1, clientAttemptId: key() } })).data;
      expect(recovered.evaluation.evaluation).toMatchObject({ status: "evaluated", outcome: "correct", awardedXp: 25 });
      expect(recovered.progress.xpTotal).toBe(initial.progress.xpTotal + 25);
      expect(recovered.route.pendingOutcomeIds).toEqual([]);
      const ended = (await service.advance(actor, program.enrollmentId, { key: key(), body: { expectedRouteRevision: recovered.route.revision } })).data;
      expect(ended.enrollment.status).toBe("completed");
      expect((await service.loadContext(actor, program.enrollmentId)).freshAssessment.availability).toBe("not_needed");
      expect((await service.getEvaluation(actor, failed.attemptId)).evaluation.outcome).toBe("incorrect");
      expect((await tx.query("SELECT id FROM unfurl.activity_sessions WHERE enrollment_id=$1", [program.enrollmentId])).rowCount).toBe(3);
      expect((await tx.query("SELECT id FROM unfurl.attempts WHERE enrollment_id=$1", [program.enrollmentId])).rowCount).toBe(3);
    });
  }, 180_000);
});
