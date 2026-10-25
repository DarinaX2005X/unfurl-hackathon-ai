import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { prepareActivityAction, prepareCandidateActivityAction, validateLearningSubmission } from "@/server/learning/actions";
import { responseDigest, type ActivityAction, type ActivityActionRequest, type ActivitySessionPublic, type InputSnapshot } from "@/domain/activity";
import type { JsonValue } from "@/domain/common";
import type { TaskPrivate, TaskPublic } from "@/domain/mechanics";
import type { AuthoritativeActivity } from "@/server/evaluation/contracts";
import { outcomePredictionDescriptor, causalInterventionDescriptor } from "@/domain/mechanic-families/v2/investigation";
import { task, prediction, intervention, tracing } from "../mechanics/investigation/fixtures";

async function setup(currentTask: TaskPublic<JsonValue>, response: JsonValue, action: ActivityAction) {
  const snapshot: InputSnapshot = { activitySessionId: crypto.randomUUID(), inputRevision: 1, responseDigest: await responseDigest(response), response };
  const session: ActivitySessionPublic = { id: snapshot.activitySessionId, enrollmentId: crypto.randomUUID(), taskId: currentTask.id,
    taskVersion: currentTask.taskVersion, revision: 1, inputRevision: 1, status: "active", remainingActions: 6, events: [] };
  const activity: AuthoritativeActivity = { session,
    input: snapshot, receipts: [], receiptInputs: [], assistance: "independent", revealedFactIds: [], committedPredictionReceiptId: null, predictionBeforeObservation: false };
  const privateTask: TaskPrivate = { taskId: currentTask.id, taskVersion: currentTask.taskVersion,
    evaluationSpec: { kind: "deterministic", evaluatorId: currentTask.mechanicId, evaluatorVersion: 2, secretConfig: null },
    evaluatorData: { tolerance: { absTol: 1e-8, relTol: 1e-9 } }, hints: [], workedExample: null, sourceClaimIds: [], validationReceiptId: crypto.randomUUID(),
    assessment: { evidenceGroupId: crypto.randomUUID(), role: "required", outcomes: currentTask.outcomeIds.map((outcomeId) => ({ outcomeId, dimensions: [{ dimensionId: "criterion", evaluationDimensionIds: ["prediction"] }] })) } };
  const request: ActivityActionRequest = { expectedRevision: 1, clientActionId: crypto.randomUUID(), inputRevision: 1, responseDigest: snapshot.responseDigest, action };
  return { task: currentTask as TaskPublic, activity, privateTask, request };
}

describe("activity acceptance before reservation", () => {
  it("uses identical action rules for an unvalidated candidate while ready task entry requires the validation receipt", async () => {
    const answer = { ...outcomePredictionDescriptor.createInitialResponse(prediction), interval: { lower: 7, upper: 7, unit: "unitless" as const } };
    const input = await setup(task(prediction), answer, { kind: "prediction.commit" });
    const { validationReceiptId: _receipt, ...candidate } = input.privateTask;
    void _receipt;
    const { enrollmentId: _enrollment, ...session } = input.activity.session as typeof input.activity.session & { enrollmentId: string };
    void _enrollment;
    const candidateInput = { ...input, privateTask: candidate, activity: { ...input.activity, session }, validationBinding: {
      generationRunId: crypto.randomUUID(), runStepId: crypto.randomUUID(), candidateDigest: "a".repeat(64), approvalDigest: "b".repeat(64), caseId: "prediction-1" } };
    expect(await prepareCandidateActivityAction(candidateInput)).toEqual(await prepareActivityAction(input));
    await expect(prepareActivityAction({ ...input, privateTask: candidate as TaskPrivate })).rejects.toThrow();
    await expect(prepareCandidateActivityAction({ ...candidateInput, privateTask: { ...candidate, taskId: crypto.randomUUID() } })).rejects.toMatchObject({ status: 503 });
  });
  it("prediction commits cost zero and require a real interval without requiring finished receipts", async () => {
    const currentTask = task(prediction);
    const draft = outcomePredictionDescriptor.createInitialResponse(prediction);
    const incomplete = await setup(currentTask, draft, { kind: "prediction.commit" });
    await expect(prepareActivityAction(incomplete)).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    expect(incomplete.activity.session.remainingActions).toBe(6);
    const answer = { ...draft, interval: { lower: 7, upper: 7, unit: "unitless" as const } };
    const prepared = await prepareActivityAction(await setup(currentTask, answer, { kind: "prediction.commit" }));
    expect(prepared).toMatchObject({ cost: 0, execution: { kind: "deterministic", observation: null } });
  });
  it("observation cannot race ahead of commitment or retrofit a changed interval", async () => {
    const currentTask = task(prediction);
    const answer = { ...outcomePredictionDescriptor.createInitialResponse(prediction), interval: { lower: 7, upper: 7, unit: "unitless" as const } };
    const input = await setup(currentTask, answer, { kind: "run" });
    await expect(prepareActivityAction(input)).rejects.toMatchObject({ status: 400 });
    const commitId = crypto.randomUUID();
    const receipt = { id: commitId, clientActionId: crypto.randomUUID(), input: { activitySessionId: input.activity.input.activitySessionId,
      inputRevision: 1, responseDigest: input.activity.input.responseDigest }, sessionRevision: 2, status: "completed" as const, observation: null };
    input.activity.receiptInputs = [input.activity.input];
    input.activity.session.events = [{ id: crypto.randomUUID(), seq: 2, at: "2026-10-25T00:00:00Z", action: { kind: "prediction.commit" }, receipt }];
    input.activity.session.revision = 3;
    input.activity.session.inputRevision = 2;
    const runAnswer = { ...answer, commitReceiptId: commitId };
    input.activity.input = { ...input.activity.input, inputRevision: 2, response: runAnswer, responseDigest: await responseDigest(runAnswer) };
    input.request = { ...input.request, expectedRevision: 3, inputRevision: 2, responseDigest: input.activity.input.responseDigest };
    expect(await prepareActivityAction(input)).toMatchObject({ cost: 1, execution: { observation: { kind: "values", values: [{ id: "y", quantity: { value: 7 } }] } } });
    const changed = { ...runAnswer, interval: { ...runAnswer.interval, lower: 6 } };
    input.activity.input.response = changed;
    input.activity.input.responseDigest = await responseDigest(changed);
    input.request.responseDigest = input.activity.input.responseDigest;
    await expect(prepareActivityAction(input)).rejects.toMatchObject({ status: 400, details: { fieldErrors: { "/interval": expect.any(String) } } });
  });
  it("intervention uses the saved assignments, bounds family budget and requires no final receipt", async () => {
    const currentTask = task(intervention), draft = causalInterventionDescriptor.createInitialResponse(intervention);
    const answer = { ...draft, assignments: { x: 2, z: 0 } };
    const input = await setup(currentTask, answer, { kind: "intervention.apply", assignments: answer.assignments });
    expect(await prepareActivityAction(input)).toMatchObject({ cost: 1, budgetLimit: 3, execution: { kind: "deterministic" } });
    input.request.action = { kind: "intervention.apply", assignments: { x: 1, z: 0 } };
    await expect(prepareActivityAction(input)).rejects.toMatchObject({ status: 400 });
    input.request.action = { kind: "intervention.apply", assignments: answer.assignments };
    input.activity.session.remainingActions = 0;
    await expect(prepareActivityAction(input)).rejects.toMatchObject({ status: 409, messageKey: "learning.actionBudgetExhausted" });
  });
  it("rejects stale input/action revision and field-invalid attempts without grading wrong knowledge", async () => {
    const currentTask = task(intervention), answer = { ...causalInterventionDescriptor.createInitialResponse(intervention), assignments: { x: 2, z: 0 } };
    const input = await setup(currentTask, answer, { kind: "intervention.apply", assignments: answer.assignments });
    input.request.expectedRevision = 2;
    await expect(prepareActivityAction(input)).rejects.toMatchObject({ status: 409 });
    input.request.expectedRevision = 1; input.request.responseDigest = "a".repeat(64);
    await expect(prepareActivityAction(input)).rejects.toMatchObject({ status: 409 });
    const stateTask = task(tracing);
    expect(() => validateLearningSubmission(stateTask, { kind: "state_tracing", action: "trace", states: [{ w: null }, { w: 0 }] })).toThrow();
    expect(validateLearningSubmission(stateTask, { kind: "state_tracing", action: "trace", states: [{ w: 999 }, { w: 999 }] })).toBeDefined();
  });
});
