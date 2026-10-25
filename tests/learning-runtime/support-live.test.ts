import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { withLiveLearningFixture } from "./live-fixture";
import { outcomePredictionDescriptor } from "@/domain/mechanic-families/v2/investigation";
import { prediction } from "../mechanics/investigation/fixtures";

const key = () => crypto.randomUUID();
describe.skipIf(process.env.LEARNING_RUNTIME_DB_TESTS !== "1")("persisted support rollback proof", () => {
  it("commits stale supersession, preserves a return response, completes optional work and permits immediate return", async () => {
    await withLiveLearningFixture(async ({ service, actor, program, tx }) => {
      const enrollmentId = program.enrollmentId, targetOutcomeId = program.version.outcomes[0]!.id;
      const stale = await service.requestSupport(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: 1, targetOutcomeId, kind: "explanation" } });
      await service.advance(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: 1 } });
      await expect(service.respondToSupport(actor, enrollmentId, stale.data.offer.id, { key: key(), body: { expectedRouteRevision: 1, response: "accept" } })).rejects.toMatchObject({ status: 409 });
      expect((await tx.query("SELECT status FROM unfurl.support_offers WHERE id=$1", [stale.data.offer.id])).rows[0]!.status).toBe("superseded");
      const session = await service.loadSession(actor, enrollmentId);
      const task = session.task!;
      const started = await service.startActivity(actor, enrollmentId, { key: key(), body: { taskId: task.id, taskVersion: 1 } });
      const saved = await service.saveInput(actor, started.data.activity.id, { key: key(), body: { expectedInputRevision: 0, response: outcomePredictionDescriptor.createInitialResponse(prediction) } });
      const proposed = await service.requestSupport(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: 2, targetOutcomeId, kind: "additional_practice", message: "Another example" } });
      expect(proposed.data.route.revision).toBe(2);
      expect(proposed.data.offer.tasks.map(({ taskId }) => taskId)).toEqual([program.tasks[1]!.task.id]);
      const acceptKey = key();
      const accepted = await service.respondToSupport(actor, enrollmentId, proposed.data.offer.id, { key: acceptKey, body: { expectedRouteRevision: 2, response: "accept" } });
      expect(accepted.data.route.revision).toBe(3);
      expect((await service.respondToSupport(actor, enrollmentId, proposed.data.offer.id, { key: acceptKey, body: { expectedRouteRevision: 2, response: "accept" } })).data.offer.status).toBe("accepted");
      const explanation = await service.loadSession(actor, enrollmentId);
      expect(explanation.task).toBeNull();
      expect(explanation.lesson?.blocks).toHaveLength(1);
      await expect(service.revisit(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: 3, lessonId: program.lessons[0]!.id, taskId: null } })).rejects.toMatchObject({ status: 409 });
      const optional = await service.advance(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: 3 } });
      expect(optional.data.task!.id).toBe(program.tasks[1]!.task.id);
      const optionalActivity = await service.startActivity(actor, enrollmentId, { key: key(), body: { taskId: optional.data.task!.id, taskVersion: 1 } });
      const optionalInput = await service.saveInput(actor, optionalActivity.data.activity.id, { key: key(), body: { expectedInputRevision: 0,
        response: { kind: "state_tracing", action: "trace", states: [{ w: -0.2 }, { w: -0.1 }] } } });
      const done = await service.submitAttempt(actor, enrollmentId, { key: key(), body: { ...optionalInput.data.savedInput!, taskId: optional.data.task!.id, taskVersion: 1, clientAttemptId: key() } });
      expect(done.data.evaluation.evaluation.status).toBe("evaluated");
      expect(done.data.support).toBeNull();
      expect((await tx.query("SELECT status FROM unfurl.support_offers WHERE id=$1", [proposed.data.offer.id])).rows[0]!.status).toBe("completed");
      const returned = await service.loadSession(actor, enrollmentId);
      expect(returned.task?.id).toBe(task.id);
      expect(returned.savedInput).toEqual(saved.data.savedInput);
      expect(returned.route.targetOutcomeIds).toEqual(session.route.targetOutcomeIds);
      const second = await service.requestSupport(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: returned.route.revision, targetOutcomeId, kind: "explanation" } });
      const next = await service.respondToSupport(actor, enrollmentId, second.data.offer.id, { key: key(), body: { expectedRouteRevision: returned.route.revision, response: "accept" } });
      const directReturn = await service.returnFromSupport(actor, enrollmentId, second.data.offer.id, { key: key(), body: { expectedRouteRevision: next.data.route.revision } });
      expect(directReturn.data.offer.status).toBe("returned");
      expect(directReturn.data.enrollment.currentTaskId).toBe(task.id);
      const third = await service.requestSupport(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: directReturn.data.route.revision, targetOutcomeId, kind: "explanation" } });
      const declined = await service.respondToSupport(actor, enrollmentId, third.data.offer.id, { key: key(), body: { expectedRouteRevision: directReturn.data.route.revision, response: "decline" } });
      expect(declined.data.offer.status).toBe("declined");
      expect(declined.data.route.revision).toBe(directReturn.data.route.revision);
      await expect(service.requestSupport(actor, enrollmentId, { key: key(), body: { expectedRouteRevision: declined.data.route.revision, targetOutcomeId, kind: "challenge" } })).rejects.toMatchObject({ status: 503, messageKey: "support.unavailable" });
    });
  }, 180_000);
});
