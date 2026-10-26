import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityState, AttemptReceipt, MutationOptions } from "@/application/learning-port";
import type { ServiceResult } from "@/application/ports";
import { responseDigest, type ActivityActionRequest, type SaveActivityInput, type SubmitActivityAttempt } from "@/domain/activity";
import type { LearningSession, EvaluationReceipt } from "@/domain/learning";
import type { JsonValue } from "@/domain/common";
import { getProductionMechanic } from "@/features/learning/registry";
import { LearningSessionController, type LearningControllerPort } from "@/features/learning/session/controller";
import type { RecoveryStorage } from "@/features/learning/session/recovery";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (text: string): JsonValue => ({ kind: "recall_reconstruction", action: "recall", text });
const copy = <T,>(value: T): T => structuredClone(value);
const fail = <T = never,>(): ServiceResult<T> => ({ ok: false, error: { error: { code: "service_unavailable", messageKey: "learning.unavailable", retryable: true, requestId: id(90) } } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class MemoryStorage implements RecoveryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
function session(): LearningSession {
  return {
    enrollment: { id: id(1), learnerId: id(2), courseId: id(3), courseVersionId: id(4), status: "active", routeRevision: 1,
      currentLessonId: id(5), currentTaskId: id(6), createdAt: "2026-10-25T00:00:00.000Z", lastStudiedAt: null },
    route: { enrollmentId: id(1), revision: 1, policyVersion: "adaptation-v1", targetOutcomeIds: [id(7)],
      next: [{ lessonId: id(5), taskId: id(6), reasonCode: "course_sequence", basisEvidenceIds: [] }], coveredOutcomeIds: [], pendingOutcomeIds: [id(7)] },
    lesson: { id: id(5), courseVersionId: id(4), moduleId: id(8), title: "Learning from evidence", outcomeIds: [id(7)],
      blocks: [{ id: id(9), kind: "task", taskId: id(6) }], taskIds: [id(6)] },
    task: { id: id(6), taskVersion: 1, mechanicId: "recall_reconstruction", mechanicVersion: 2, outcomeIds: [id(7)],
      instruction: "Explain what an untouched test set measures.", contentLanguage: "en", config: { kind: "recall_reconstruction", cue: "State the purpose and limit of the estimate.", maxChars: 4000 }, availableHints: 1, responseSchemaVersion: 2 },
    progress: { xpTotal: 0, level: 1, xpToNextLevel: 100, completedRequiredOutcomes: 0, totalRequiredOutcomes: 1,
      publication: { eligible: false, requiredLevel: 3, reasons: [] } },
    activity: null, savedInput: null, evaluation: null, support: null,
  };
}
function harness(storage = new MemoryStorage()) {
  const data = session();
  const saved = new Map<string, ActivityState>();
  const submissions = new Map<string, AttemptReceipt>();
  let sequence = 100;
  const currentActivity = () => ({ activity: copy(data.activity!), savedInput: copy(data.savedInput) });
  const port: LearningControllerPort = {
    loadContext: vi.fn<LearningControllerPort["loadContext"]>(async () => ({ ok: true, data: { enrollmentId: id(1), routeRevision: data.route.revision,
      course: { id: id(3), versionId: id(4), versionNumber: 1, title: "Evidence", contentLanguage: "en" }, outcomes: [{ id: id(7), title: "Interpret held-out evidence" }], outline: [], outlineNextCursor: null, citations: [], assistance: null, revisitBlockedReason: null,
      freshAssessment: { availability: "available", blockedReason: null, outcomeIds: [id(7)] } } })),
    requestFreshAssessment: vi.fn<LearningControllerPort["requestFreshAssessment"]>(async () => fail()),
    requestHint: vi.fn<LearningControllerPort["requestHint"]>(async () => fail()), revealAnswer: vi.fn<LearningControllerPort["revealAnswer"]>(async () => fail()),
    revisit: vi.fn<LearningControllerPort["revisit"]>(async () => fail()), requestSupport: vi.fn<LearningControllerPort["requestSupport"]>(async () => fail()),
    respondToSupport: vi.fn<LearningControllerPort["respondToSupport"]>(async () => fail()), returnFromSupport: vi.fn<LearningControllerPort["returnFromSupport"]>(async () => fail()),
    requestReview: vi.fn<LearningControllerPort["requestReview"]>(async () => fail()), retryReview: vi.fn<LearningControllerPort["retryReview"]>(async () => fail()),
    loadSession: vi.fn<LearningControllerPort["loadSession"]>(async () => ({ ok: true, data: copy(data) })),
    startActivity: vi.fn<LearningControllerPort["startActivity"]>(async () => {
      data.activity ??= { id: id(10), enrollmentId: id(1), taskId: id(6), taskVersion: 1, revision: 1, inputRevision: 0, status: "active", remainingActions: 6, events: [] };
      return { ok: true, data: currentActivity() };
    }),
    getActivity: vi.fn<LearningControllerPort["getActivity"]>(async () => ({ ok: true, data: currentActivity() })),
    saveInput: vi.fn<LearningControllerPort["saveInput"]>(async (_activity: string, body: SaveActivityInput, options: MutationOptions): Promise<ServiceResult<ActivityState>> => {
      const old = saved.get(options.idempotencyKey);
      if (old) return { ok: true, data: copy(old) };
      if (body.expectedInputRevision !== data.activity!.inputRevision) return { ok: false, error: { error: { code: "revision_conflict", messageKey: "learning.inputChanged", retryable: false, requestId: id(90) } } };
      data.activity!.inputRevision += 1;
      data.savedInput = { activitySessionId: data.activity!.id, inputRevision: data.activity!.inputRevision, responseDigest: await responseDigest(body.response), response: copy(body.response) };
      const result = currentActivity(); saved.set(options.idempotencyKey, result); return { ok: true, data: copy(result) };
    }),
    dispatchAction: vi.fn<LearningControllerPort["dispatchAction"]>(async (_activity: string, body: ActivityActionRequest) => {
      const receipt = { id: id(11), clientActionId: body.clientActionId,
        input: { activitySessionId: id(10), inputRevision: body.inputRevision, responseDigest: body.responseDigest },
        sessionRevision: ++data.activity!.revision, status: "completed" as const, observation: { kind: "values" as const, values: [{ id: "result", quantity: { value: 4, unit: "unitless" as const } }] } };
      data.activity!.events.push({ id: id(12), seq: receipt.sessionRevision, at: "2026-10-25T00:00:00.000Z", action: body.action, receipt });
      return { ok: true, data: { ...currentActivity(), receipt } };
    }),
    retryAction: vi.fn<LearningControllerPort["retryAction"]>(async () => fail()),
    submitAttempt: vi.fn<LearningControllerPort["submitAttempt"]>(async (_enrollment: string, body: SubmitActivityAttempt, options: MutationOptions): Promise<ServiceResult<AttemptReceipt>> => {
      const old = submissions.get(options.idempotencyKey);
      if (old) return { ok: true, data: copy(old) };
      const evaluation: EvaluationReceipt = { revision: 1, review: null,
        submittedInput: { activitySessionId: body.activitySessionId, inputRevision: body.inputRevision, responseDigest: body.responseDigest },
        evaluation: { id: id(13), attemptId: id(14), status: "evaluated", outcome: "correct", dimensions: [],
          feedback: { explanation: "The estimate is limited to the sampled setting.", nextAction: "continue" }, awardedXp: 25 } };
      data.evaluation = evaluation;
      const result = { attemptId: id(14), evaluation, route: data.route, progress: data.progress, support: null };
      submissions.set(options.idempotencyKey, result); return { ok: true, data: copy(result) };
    }),
    getEvaluation: vi.fn<LearningControllerPort["getEvaluation"]>(async () => data.evaluation ? { ok: true, data: copy(data.evaluation) } : fail()),
    retryEvaluation: vi.fn<LearningControllerPort["retryEvaluation"]>(async () => fail()),
    acknowledgeFeedback: vi.fn<LearningControllerPort["acknowledgeFeedback"]>(async (attemptId, input) => ({ ok: true, data: { attemptId, evaluationRevision: input.expectedEvaluationRevision, acknowledgedAt: "2026-10-25T00:00:00.000Z" } })),
    advance: vi.fn<LearningControllerPort["advance"]>(async () => ({ ok: true, data: copy(data) })),
  };
  const make = (actorId = id(2)) => new LearningSessionController(actorId, id(1), port, getProductionMechanic, storage, () => id(sequence++));
  return { data, port, storage, make, submissions };
}
const controllers: LearningSessionController[] = [];
const track = (controller: LearningSessionController) => { controllers.push(controller); return controller; };
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.useRealTimers(); });

describe("production learning continuity", () => {
  it("replays a fresh-assessment request after a lost response and double click without changing the old answer", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("Earlier submitted answer")); await controller.submit(); await controller.loadContext();
    const prior = copy({ activity: h.data.activity, savedInput: h.data.savedInput, evaluation: h.data.evaluation });
    const saveCount = vi.mocked(h.port.saveInput).mock.calls.length;
    await Promise.all([controller.requestFreshAssessment(), controller.requestFreshAssessment()]);
    expect(h.port.requestFreshAssessment).toHaveBeenCalledTimes(1);
    const original = vi.mocked(h.port.requestFreshAssessment).mock.calls[0]!;
    expect(original[1]).toEqual({ expectedRouteRevision: 1 });
    expect(controller.getSnapshot().commandUnconfirmed).toBe(true);
    controller.dispose();
    const next: LearningSession = { ...copy(h.data), route: { ...copy(h.data.route), revision: 2, next: [{ lessonId: id(55), taskId: id(56), reasonCode: "scheduled_review", basisEvidenceIds: [] }] },
      enrollment: { ...copy(h.data.enrollment), routeRevision: 2, currentLessonId: id(55), currentTaskId: id(56) },
      lesson: { ...copy(h.data.lesson!), id: id(55), taskIds: [id(56)], blocks: [{ id: id(57), kind: "task", taskId: id(56) }] }, task: { ...copy(h.data.task!), id: id(56) },
      activity: { ...copy(h.data.activity!), id: id(58), taskId: id(56), revision: 1, inputRevision: 0, events: [] }, savedInput: null, evaluation: null };
    vi.mocked(h.port.requestFreshAssessment).mockResolvedValue({ ok: true, data: next });
    const resumed = track(h.make()); await resumed.load(); await resumed.requestFreshAssessment();
    const replay = vi.mocked(h.port.requestFreshAssessment).mock.calls[1]!;
    expect(replay[1]).toEqual(original[1]); expect(replay[2].idempotencyKey).toBe(original[2].idempotencyKey);
    expect(resumed.getSnapshot().session?.task?.id).toBe(id(56)); expect(resumed.getSnapshot().session?.activity?.id).toBe(id(58));
    expect(resumed.getSnapshot().session?.savedInput).toBeNull(); expect(resumed.getSnapshot().commandUnconfirmed).toBe(false);
    expect(vi.mocked(h.port.saveInput).mock.calls.length).toBe(saveCount);
    expect({ activity: h.data.activity, savedInput: h.data.savedInput, evaluation: h.data.evaluation }).toEqual(prior);
  });

  it("does not request a fresh assessment when the server reports exhaustion or a stale availability revision", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.loadContext();
    const context = controller.getSnapshot().context!;
    vi.mocked(h.port.loadContext).mockResolvedValue({ ok: true, data: { ...context, freshAssessment: { availability: "no_unseen_assessment", blockedReason: null, outcomeIds: [id(7)] } } });
    await controller.loadContext(); await controller.requestFreshAssessment();
    expect(h.port.requestFreshAssessment).not.toHaveBeenCalled();
    h.data.route.revision = 2; h.data.enrollment.routeRevision = 2; await controller.load(); await controller.loadContext();
    expect(controller.getSnapshot().contextError).toBe(true);
    await controller.requestFreshAssessment(); expect(h.port.requestFreshAssessment).not.toHaveBeenCalled();
  });

  it("does not replace a newer route with a late fresh-assessment response", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.loadContext();
    const result = deferred<ServiceResult<LearningSession>>();
    vi.mocked(h.port.requestFreshAssessment).mockReturnValue(result.promise);
    const pending = controller.requestFreshAssessment();
    await vi.waitFor(() => expect(h.port.requestFreshAssessment).toHaveBeenCalledTimes(1));
    h.data.route.revision = 3; h.data.enrollment.routeRevision = 3; await controller.load();
    result.resolve({ ok: true, data: { ...copy(h.data), route: { ...copy(h.data.route), revision: 2, next: [] },
      enrollment: { ...copy(h.data.enrollment), routeRevision: 2, currentLessonId: null, currentTaskId: null }, lesson: null, task: null } });
    await pending;
    expect(controller.getSnapshot().session?.route.revision).toBe(3);
    expect(controller.getSnapshot().session?.task?.id).toBe(id(6));
  });

  it("replays an unconfirmed hint after reload with the exact original request and blocks unrelated submission", async () => {
    const h = harness(), first = track(h.make()); await first.load(); await first.start(); await first.loadContext();
    first.setResponse(response("My explanation"));
    await first.hint();
    const original = vi.mocked(h.port.requestHint).mock.calls[0]!;
    expect(first.getSnapshot().commandUnconfirmed).toBe(true);
    await first.submit(); expect(h.port.submitAttempt).not.toHaveBeenCalled();
    first.dispose();
    const resumed = track(h.make()); await resumed.load();
    expect(resumed.getSnapshot().commandUnconfirmed).toBe(true);
    vi.mocked(h.port.requestHint).mockResolvedValue({ ok: true, data: { hintId: id(50), content: "Consider what was held out.", assistance: "hinted" } });
    await resumed.retryCommand();
    const replay = vi.mocked(h.port.requestHint).mock.calls[1]!;
    expect(replay.slice(0, 2)).toEqual(original.slice(0, 2));
    expect(replay[2].idempotencyKey).toBe(original[2].idempotencyKey);
    expect(resumed.getSnapshot().commandUnconfirmed).toBe(false);
    expect(resumed.getSnapshot().response).toEqual(response("My explanation"));
  });

  it("rejects an outline page from a different route revision without replacing the current outline", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.loadContext();
    const context = controller.getSnapshot().context!;
    vi.mocked(h.port.loadContext).mockResolvedValueOnce({ ok: true, data: { ...context, outlineNextCursor: "next-page", outline: [{ lessonId: id(5), title: "Current", outcomeIds: [id(7)], availability: "current", positions: [] }] } });
    await controller.loadContext();
    vi.mocked(h.port.loadContext).mockResolvedValueOnce({ ok: true, data: { ...context, routeRevision: 2, outline: [{ lessonId: id(55), title: "Other revision", outcomeIds: [], availability: "upcoming", positions: [] }] } });
    await controller.loadContext(true);
    expect(controller.getSnapshot().contextError).toBe(true);
    expect(controller.getSnapshot().context?.outline.map((lesson) => lesson.title)).toEqual(["Current"]);
  });

  it("retains edited work while requesting a review of the immutable submitted answer", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("Submitted answer")); await controller.submit();
    controller.setResponse(response("A later revision"));
    const receipt = h.data.evaluation!;
    vi.mocked(h.port.requestReview).mockImplementation(async (attemptId, input) => {
      const review = { id: id(60), attemptId, evaluationId: receipt.evaluation.id, expectedEvaluationRevision: input.expectedEvaluationRevision,
        reason: input.reason, comment: input.comment, status: "queued" as const, resolution: null, resolvedEvaluationRevision: null,
        createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z", resolvedAt: null };
      h.data.evaluation = { ...receipt, review };
      return { ok: true, data: { review, evaluation: h.data.evaluation } };
    });
    await controller.review("valid_alternative", "This answer uses an equivalent formulation.");
    expect(vi.mocked(h.port.requestReview).mock.calls[0]?.[0]).toBe(receipt.evaluation.attemptId);
    expect(controller.getSnapshot().response).toEqual(response("A later revision"));
    expect(controller.getSnapshot().session?.evaluation?.review?.status).toBe("queued");
    expect(controller.hasCurrentEvaluation()).toBe(false);
  });

  it("does not offer support without a normal route position to return to", async () => {
    const h = harness(); h.data.lesson = null; h.data.task = null; h.data.enrollment.currentLessonId = null; h.data.enrollment.currentTaskId = null; h.data.route.next = [];
    const controller = track(h.make()); await controller.load(); await controller.requestSupport(id(7), "additional_practice");
    expect(h.port.requestSupport).not.toHaveBeenCalled();
  });

  it("loads the authoritative return position after a support result instead of advancing past it", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("Completed support answer"));
    const submit = h.port.submitAttempt;
    h.port.submitAttempt = vi.fn<LearningControllerPort["submitAttempt"]>(async (...args) => {
      const result = await submit(...args); if (!result.ok) return result;
      h.data.route = { ...h.data.route, revision: 2, next: [{ lessonId: id(55), taskId: id(56), reasonCode: "course_sequence", basisEvidenceIds: [] }] };
      h.data.enrollment = { ...h.data.enrollment, currentLessonId: id(55), currentTaskId: id(56), routeRevision: 2 };
      h.data.lesson = { ...h.data.lesson!, id: id(55), taskIds: [id(56)], blocks: [{ id: id(57), kind: "task", taskId: id(56) }] };
      h.data.task = { ...h.data.task!, id: id(56) }; h.data.activity = null; h.data.savedInput = null; h.data.evaluation = null;
      return { ok: true, data: { ...result.data, route: copy(h.data.route) } };
    });
    await controller.submit();
    expect(controller.getSnapshot().routeMoved).toBe(true);
    expect(controller.getSnapshot().session?.task?.id).toBe(id(6));
    await controller.advance();
    expect(h.port.acknowledgeFeedback).toHaveBeenCalledTimes(1); expect(h.port.advance).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session?.task?.id).toBe(id(56)); expect(controller.getSnapshot().routeMoved).toBe(false);
  });

  it("clears a definitively unavailable support request so a different choice remains possible", async () => {
    const h = harness(), controller = track(h.make()); await controller.load();
    vi.mocked(h.port.requestSupport).mockResolvedValue({ ok: false, error: { error: { code: "service_unavailable", messageKey: "support.unavailable", retryable: false, requestId: id(90) } } });
    await controller.requestSupport(id(7), "challenge");
    expect(controller.getSnapshot().commandUnconfirmed).toBe(false);
    await controller.requestSupport(id(7), "explanation");
    expect(h.port.requestSupport).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.port.requestSupport).mock.calls[0]![2].idempotencyKey).not.toBe(vi.mocked(h.port.requestSupport).mock.calls[1]![2].idempotencyKey);
  });

  it("saves offline edits after reconnecting without replacing the draft", async () => {
    vi.useFakeTimers();
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    await controller.save(); vi.mocked(h.port.saveInput).mockClear();
    controller.setOnline(false); controller.setResponse(response("Written offline"));
    await vi.advanceTimersByTimeAsync(1000); expect(h.port.saveInput).not.toHaveBeenCalled();
    controller.setOnline(true); await vi.advanceTimersByTimeAsync(700);
    expect(h.port.saveInput).toHaveBeenCalledTimes(1);
    await controller.save(); // Wait for the queued save's native digest validation.
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(controller.getSnapshot().response).toEqual(response("Written offline"));
  });

  it("loads without creating an activity and starts only on an explicit action", async () => {
    const h = harness(), controller = track(h.make()); await controller.load();
    expect(h.port.startActivity).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session?.activity).toBeNull();
    await controller.start(); expect(h.port.startActivity).toHaveBeenCalledTimes(1);
    await controller.start(); expect(h.port.startActivity).toHaveBeenCalledTimes(1);
  });
  it("keeps newer editing when an older save returns", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    const original = h.port.saveInput, gate = deferred<ServiceResult<ActivityState>>();
    h.port.saveInput = vi.fn<LearningControllerPort["saveInput"]>(async (...args) => { const result = await original(...args); await gate.promise; return result; });
    controller.setResponse(response("first answer")); const saving = controller.save();
    await vi.waitFor(() => expect(h.data.savedInput?.response).toEqual(response("first answer")));
    controller.setResponse(response("newer answer")); gate.resolve(fail()); await saving;
    expect(controller.getSnapshot().response).toEqual(response("newer answer"));
    expect(controller.getSnapshot().dirty).toBe(true);
    await controller.save(); expect(h.data.savedInput?.response).toEqual(response("newer answer"));
  });
  it("replays a lost save with its original key and body across reload", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    const original = h.port.saveInput;
    h.port.saveInput = vi.fn<LearningControllerPort["saveInput"]>(async (...args) => { await original(...args); return fail(); });
    controller.setResponse(response("preserved")); await controller.save();
    const first = vi.mocked(h.port.saveInput).mock.calls[0]!; controller.dispose();
    h.port.saveInput = vi.fn<LearningControllerPort["saveInput"]>((...args) => original(...args));
    const resumed = track(h.make()); await resumed.load(); await resumed.save();
    const retry = vi.mocked(h.port.saveInput).mock.calls[0]!;
    expect(retry[1]).toEqual(first[1]); expect(retry[2].idempotencyKey).toBe(first[2].idempotencyKey);
    expect(h.data.activity?.inputRevision).toBe(1); expect(resumed.getSnapshot().dirty).toBe(false);
  });
  it("merges a late same-route read with a newer saved answer while still detecting later competing saves", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("first saved answer")); await controller.save();
    const earlier = copy(h.data), reply = deferred<ServiceResult<LearningSession>>();
    // The read also contains an account-progress update from another completed task.
    earlier.progress = { ...earlier.progress, xpTotal: 25, xpToNextLevel: 225 };
    vi.mocked(h.port.loadSession).mockReturnValueOnce(reply.promise);
    const loading = controller.load();
    controller.setResponse(response("newer saved answer")); await controller.save();
    expect(controller.getSnapshot().session?.savedInput?.inputRevision).toBe(2);
    reply.resolve({ ok: true, data: earlier }); await loading;
    expect(controller.getSnapshot().session?.activity?.inputRevision).toBe(2);
    expect(controller.getSnapshot().session?.savedInput).toEqual(h.data.savedInput);
    expect(controller.getSnapshot().response).toEqual(response("newer saved answer"));
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, conflict: false, failure: null });
    expect(controller.getSnapshot().session?.progress.xpTotal).toBe(25);
    // A genuinely newer saved answer from another tab must still require a choice.
    await h.port.saveInput(id(10), { expectedInputRevision: 2, response: response("another tab's answer") }, { idempotencyKey: id(88) });
    await controller.load();
    expect(controller.getSnapshot().session?.savedInput?.inputRevision).toBe(3);
    expect(controller.getSnapshot().conflict).toBe(true);
    expect(controller.getSnapshot().response).toEqual(response("newer saved answer"));
  });
  it("does not attach a late run result to a newer editor response", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    const original = h.port.dispatchAction, gate = deferred<void>();
    h.port.dispatchAction = vi.fn<LearningControllerPort["dispatchAction"]>(async (...args) => { const result = await original(...args); await gate.promise; return result; });
    controller.setResponse(response("run this")); const running = controller.dispatch({ kind: "run" });
    await vi.waitFor(() => expect(h.port.dispatchAction).toHaveBeenCalled());
    controller.setResponse(response("edited during run")); gate.resolve(); const result = await running;
    expect(result.ok).toBe(true); expect(controller.getSnapshot().response).toEqual(response("edited during run"));
    expect(result.ok && result.data.input.responseDigest).toBe(await responseDigest(response("run this")));
  });
  it("reuses one submission identity after a lost response, double click and reload", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    const original = h.port.submitAttempt;
    h.port.submitAttempt = vi.fn<LearningControllerPort["submitAttempt"]>(async (...args) => { await original(...args); return fail(); });
    controller.setResponse(response("valid answer")); await Promise.all([controller.submit(), controller.submit()]);
    expect(h.port.submitAttempt).toHaveBeenCalledTimes(1);
    const first = vi.mocked(h.port.submitAttempt).mock.calls[0]!;
    controller.dispose(); h.port.submitAttempt = vi.fn<LearningControllerPort["submitAttempt"]>((...args) => original(...args));
    const resumed = track(h.make()); await resumed.load(); await resumed.submit();
    const retry = vi.mocked(h.port.submitAttempt).mock.calls[0]!;
    expect(retry[1]).toEqual(first[1]); expect(retry[2].idempotencyKey).toBe(first[2].idempotencyKey);
    expect(h.submissions.size).toBe(1); expect(resumed.getSnapshot().submissionUnconfirmed).toBe(false);
    expect(resumed.hasCurrentEvaluation()).toBe(true);
    expect(JSON.parse([...h.storage.data.values()][0]!).attempt.accepted).toBe(true);
    await resumed.submit(); expect(h.port.submitAttempt).toHaveBeenCalledTimes(1);
  });
  it("validates incomplete work before creating an attempt", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start(); await controller.submit();
    expect(h.port.submitAttempt).not.toHaveBeenCalled(); expect(controller.getSnapshot().issues).toHaveLength(1);
  });
  it("requires an explicit choice after a competing saved response", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("my answer"));
    await h.port.saveInput(id(10), { expectedInputRevision: 0, response: response("another tab") }, { idempotencyKey: id(88) });
    await controller.save(); expect(controller.getSnapshot().conflict).toBe(true);
    expect(controller.getSnapshot().response).toEqual(response("my answer"));
    await controller.resolveConflict("mine");
    expect(h.data.savedInput?.response).toEqual(response("my answer")); expect(h.data.activity?.inputRevision).toBe(2);
  });
  it("does not mistake an earlier assessment for the edited answer or advance it", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("assessed")); await controller.submit(); expect(controller.hasCurrentEvaluation()).toBe(true);
    controller.setResponse(response("changed")); await controller.save();
    expect(controller.hasCurrentEvaluation()).toBe(false); await controller.advance(); expect(h.port.advance).not.toHaveBeenCalled();
  });
  it("refreshes a rejected advance and creates a new intent after late coverage changes", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("assessed")); await controller.submit();
    h.data.route.revision = 2; h.data.enrollment.routeRevision = 2;
    vi.mocked(h.port.advance).mockImplementation(async (_id, body) => body.expectedRouteRevision === h.data.route.revision ?
      { ok: true, data: copy(h.data) } : { ok: false, error: { error: {
        code: "revision_conflict", messageKey: "learning.routeChanged", retryable: false, requestId: id(90),
      } } });
    await controller.advance();
    expect(h.port.advance).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().session?.route.revision).toBe(2);
    expect(controller.getSnapshot().response).toEqual(response("assessed"));
    const rejected = vi.mocked(h.port.advance).mock.calls[0]!;
    controller.dispose();
    const resumed = track(h.make()); await resumed.load(); await resumed.advance();
    const fresh = vi.mocked(h.port.advance).mock.calls[1]!;
    expect(fresh[1]).toEqual({ expectedRouteRevision: 2 });
    expect(fresh[2].idempotencyKey).not.toBe(rejected[2].idempotencyKey);
    expect(resumed.getSnapshot().failure).toBeNull();
  });
  it("loads another tab's advanced position without advancing that new task again", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("assessed")); await controller.submit();
    h.data.route = { ...h.data.route, revision: 2, next: [{ lessonId: id(55), taskId: id(56), reasonCode: "course_sequence", basisEvidenceIds: [] }] };
    h.data.enrollment = { ...h.data.enrollment, routeRevision: 2, currentLessonId: id(55), currentTaskId: id(56) };
    h.data.lesson = { ...h.data.lesson!, id: id(55), taskIds: [id(56)], blocks: [{ id: id(57), kind: "task", taskId: id(56) }] };
    h.data.task = { ...h.data.task!, id: id(56) }; h.data.activity = null; h.data.savedInput = null; h.data.evaluation = null;
    vi.mocked(h.port.advance).mockResolvedValue({ ok: false, error: { error: {
      code: "revision_conflict", messageKey: "learning.routeChanged", retryable: false, requestId: id(90),
    } } });
    await controller.advance();
    expect(h.port.advance).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().session?.task?.id).toBe(id(56));
    expect(controller.getSnapshot().session?.route.revision).toBe(2);
    expect(controller.getSnapshot().response).toEqual(response(""));
  });
  it("retains an ambiguous advance identity across reload even if the route revision changes", async () => {
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("assessed")); await controller.submit();
    vi.mocked(h.port.advance).mockResolvedValueOnce(fail());
    await controller.advance();
    const original = vi.mocked(h.port.advance).mock.calls[0]!;
    expect(controller.getSnapshot().failure?.scope).toBe("advance");
    controller.dispose();
    h.data.route.revision = 2; h.data.enrollment.routeRevision = 2;
    const resumed = track(h.make()); await resumed.load(); await resumed.advance();
    const replay = vi.mocked(h.port.advance).mock.calls[1]!;
    expect(replay[1]).toEqual(original[1]);
    expect(replay[2].idempotencyKey).toBe(original[2].idempotencyKey);
    expect(h.port.acknowledgeFeedback).toHaveBeenCalledTimes(1);
  });
  it("resumes pending assessment polling after a slow autosave without overlapping reads or losing edits", async () => {
    vi.useFakeTimers();
    const h = harness(), controller = track(h.make()); await controller.load(); await controller.start();
    controller.setResponse(response("submitted")); await controller.submit();
    const completed = copy(h.data.evaluation!);
    h.data.evaluation = { ...completed, evaluation: { ...completed.evaluation, status: "pending", outcome: null, awardedXp: 0,
      feedback: { explanation: "Assessment in progress.", nextAction: "wait" } } };
    await controller.load();
    const originalSave = vi.mocked(h.port.saveInput).getMockImplementation()!, savedReply = deferred<void>();
    vi.mocked(h.port.saveInput).mockImplementation(async (...args) => {
      const result = await originalSave(...args); await savedReply.promise; return result;
    });
    const assessmentReply = deferred<ServiceResult<EvaluationReceipt>>();
    vi.mocked(h.port.getEvaluation).mockReturnValue(assessmentReply.promise);
    controller.setResponse(response("edited while assessment runs"));
    await vi.advanceTimersByTimeAsync(1800);
    expect(controller.getSnapshot().saving).toBe(true);
    expect(h.port.getEvaluation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3600);
    expect(h.port.getEvaluation).not.toHaveBeenCalled();
    savedReply.resolve(); await controller.save();
    expect(controller.getSnapshot().saving).toBe(false);
    await vi.advanceTimersByTimeAsync(1800);
    expect(h.port.getEvaluation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600); await controller.poll();
    expect(h.port.getEvaluation).toHaveBeenCalledTimes(1);
    h.data.evaluation = completed; assessmentReply.resolve({ ok: true, data: completed });
    await vi.waitFor(() => expect(controller.getSnapshot().session?.evaluation?.evaluation.status).toBe("evaluated"));
    expect(controller.getSnapshot().response).toEqual(response("edited while assessment runs"));
    expect(controller.hasCurrentEvaluation()).toBe(false);
    await vi.advanceTimersByTimeAsync(3600);
    expect(h.port.getEvaluation).toHaveBeenCalledTimes(1);
  });
  it("never reveals another actor's session or recovered response", async () => {
    const h = harness(), owner = track(h.make()); await owner.load(); await owner.start(); owner.setResponse(response("private draft"));
    const other = track(h.make(id(44))); await other.load();
    expect(other.getSnapshot().session).toBeNull(); expect(other.getSnapshot().response).toBeNull();
    expect(other.getSnapshot().failure?.error.error.code).toBe("forbidden");
  });
});
