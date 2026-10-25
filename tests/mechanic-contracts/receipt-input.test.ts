import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isCurrentObservation, responseDigest, validateInputSnapshot, type InputSnapshot } from "../../src/domain/activity";
import { receiptInputFor, type AuthoritativeActivity } from "../../src/server/evaluation/contracts";

async function recordedActivity(): Promise<{ activity: AuthoritativeActivity; receiptId: string }> {
  const sessionId = crypto.randomUUID();
  const receiptId = crypto.randomUUID();
  const runResponse = { kind: "constrained_optimization", configuration: { x: 2 }, observationReceiptId: null };
  const runInput = await validateInputSnapshot({
    activitySessionId: sessionId, inputRevision: 1, response: runResponse, responseDigest: await responseDigest(runResponse),
  });
  const submitResponse = { ...runResponse, observationReceiptId: receiptId };
  const submitInput = await validateInputSnapshot({
    activitySessionId: sessionId, inputRevision: 2, response: submitResponse, responseDigest: await responseDigest(submitResponse),
  });
  const activity: AuthoritativeActivity = {
    session: {
      id: sessionId, enrollmentId: crypto.randomUUID(), taskId: crypto.randomUUID(), taskVersion: 1,
      revision: 3, inputRevision: 2, status: "active", remainingActions: 5, events: [],
    },
    input: submitInput,
    receipts: [{
      id: receiptId, clientActionId: crypto.randomUUID(), input: {
        activitySessionId: sessionId, inputRevision: 1, responseDigest: runInput.responseDigest,
      },
      sessionRevision: 2, status: "completed",
      observation: { kind: "values", values: [{ id: "benefit", quantity: { value: 4, unit: "unitless" } }] },
    }],
    receiptInputs: [runInput], assistance: "independent", revealedFactIds: [],
    committedPredictionReceiptId: null, predictionBeforeObservation: false,
  };
  return { activity, receiptId };
}

describe("receipt historical input association", () => {
  it("resolves the Run snapshot after the final response appends the receipt without weakening its full hash", async () => {
    const { activity, receiptId } = await recordedActivity();
    const historical = receiptInputFor(activity, receiptId);
    expect(historical).toBe(activity.receiptInputs[0]);
    expect(historical?.inputRevision).toBe(1);
    expect(historical?.responseDigest).not.toBe(activity.input.responseDigest);
    expect(isCurrentObservation(activity.receipts[0]!, activity.input)).toBe(false);
    expect(historical?.response).toMatchObject({ configuration: { x: 2 }, observationReceiptId: null });
    expect(activity.input.response).toMatchObject({ configuration: { x: 2 }, observationReceiptId: receiptId });
  });

  it("keeps the original authored values available for the evaluator to reject a changed configuration", async () => {
    const { activity, receiptId } = await recordedActivity();
    const changed = { kind: "constrained_optimization", configuration: { x: 3 }, observationReceiptId: receiptId };
    activity.input = await validateInputSnapshot({ ...activity.input, response: changed, responseDigest: await responseDigest(changed) });
    expect(receiptInputFor(activity, receiptId)?.response).toMatchObject({ configuration: { x: 2 } });
    expect(activity.input.response).toMatchObject({ configuration: { x: 3 } });
    // The family compares these authored fields; a mere existing receipt never proves this new configuration ran.
    expect(isCurrentObservation(activity.receipts[0]!, activity.input)).toBe(false);
  });

  it("rejects missing, ambiguous, and digest-mismatched historical inputs without falling back to the current input", async () => {
    const { activity, receiptId } = await recordedActivity();
    const historical = activity.receiptInputs[0]!;
    expect(receiptInputFor(null, receiptId)).toBeNull();
    expect(receiptInputFor(activity, crypto.randomUUID())).toBeNull();
    expect(receiptInputFor({ ...activity, input: historical, receiptInputs: [] }, receiptId)).toBeNull();
    expect(receiptInputFor({ ...activity, receiptInputs: [historical, historical] }, receiptId)).toBeNull();
    expect(receiptInputFor({ ...activity, receipts: [...activity.receipts, ...activity.receipts] }, receiptId)).toBeNull();
    const otherResponse = { kind: "constrained_optimization", configuration: { x: 4 }, observationReceiptId: null };
    const otherInput: InputSnapshot = await validateInputSnapshot({
      ...historical, response: otherResponse, responseDigest: await responseDigest(otherResponse),
    });
    expect(receiptInputFor({ ...activity, receiptInputs: [otherInput] }, receiptId)).toBeNull();
  });

  it("rejects cross-session and future-revision associations even when receipt and snapshot agree with each other", async () => {
    const { activity, receiptId } = await recordedActivity();
    const receipt = activity.receipts[0]!;
    const historical = activity.receiptInputs[0]!;
    const anotherSessionId = crypto.randomUUID();
    expect(receiptInputFor({
      ...activity,
      receipts: [{ ...receipt, input: { ...receipt.input, activitySessionId: anotherSessionId } }],
      receiptInputs: [{ ...historical, activitySessionId: anotherSessionId }],
    }, receiptId)).toBeNull();
    expect(receiptInputFor({
      ...activity,
      receipts: [{ ...receipt, input: { ...receipt.input, inputRevision: 3 } }],
      receiptInputs: [{ ...historical, inputRevision: 3 }],
    }, receiptId)).toBeNull();
    expect(receiptInputFor({ ...activity, receipts: [{ ...receipt, sessionRevision: 4 }] }, receiptId)).toBeNull();
  });

  it("does not interpret association as completed observation or bypass the service's digest validation", async () => {
    const { activity, receiptId } = await recordedActivity();
    const receipt = activity.receipts[0]!;
    const pending = { ...receipt, status: "pending" as const, observation: null };
    expect(receiptInputFor({ ...activity, receipts: [pending] }, receiptId)).not.toBeNull();
    expect(isCurrentObservation(pending, activity.receiptInputs[0]!)).toBe(false);
    await expect(validateInputSnapshot({ ...activity.receiptInputs[0], response: { altered: true } })).rejects.toThrow("digest");
  });
});
