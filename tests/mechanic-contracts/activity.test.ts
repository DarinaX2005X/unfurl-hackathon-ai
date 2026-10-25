import { describe, expect, it } from "vitest";
import {
  ActionReceiptSchema, ActivityActionRequestSchema, ActivityEventPublicSchema, ActivitySessionPublicSchema,
  PublicObservationSchema, SaveActivityInputSchema, SubmitActivityAttemptSchema, activityActionCost,
  canonicalResponseJson, isCurrentObservation, responseDigest, validateInputSnapshot,
  type ActionReceipt, type InputIdentity,
} from "../../src/domain/activity";
import type { JsonValue } from "../../src/domain/common";

const sessionId = crypto.randomUUID();
const input: InputIdentity = { activitySessionId: sessionId, inputRevision: 2, responseDigest: "a".repeat(64) };
const receipt: ActionReceipt = {
  id: crypto.randomUUID(), clientActionId: crypto.randomUUID(), input, sessionRevision: 3,
  status: "completed", observation: { kind: "values", values: [{ id: "result", quantity: { value: 4, unit: "unitless" } }] },
};

describe("immutable response identities", () => {
  it("hashes object order consistently while preserving array order and response content", async () => {
    const first = { kind: "state_tracing", states: [{ x: 1, y: 2 }, { x: 3 }] };
    const reordered = { states: [{ y: 2, x: 1 }, { x: 3 }], kind: "state_tracing" };
    expect(await responseDigest(first)).toBe(await responseDigest(reordered));
    expect(await responseDigest(first)).not.toBe(await responseDigest({ ...first, states: [...first.states].reverse() }));
    const snapshot = { ...input, response: first, responseDigest: await responseDigest(first) };
    expect(await validateInputSnapshot(snapshot)).toEqual(snapshot);
    await expect(validateInputSnapshot({ ...snapshot, response: { ...first, kind: "different" } })).rejects.toThrow("digest");
  });

  it("rejects cyclic, nonfinite, oversized and non-JSON input before hashing or persistence", () => {
    const cycle: JsonValue = {};
    cycle.self = cycle;
    expect(() => canonicalResponseJson(cycle)).toThrow();
    for (const response of [NaN, undefined, new Date(), { text: "a".repeat(131_073) }, { x: undefined }]) {
      expect(SaveActivityInputSchema.safeParse({ expectedInputRevision: 0, response }).success).toBe(false);
    }
    let deep: JsonValue = 1;
    for (let index = 0; index < 40; index++) deep = [deep];
    expect(() => canonicalResponseJson(deep)).toThrow();
  });

  it("keeps late observations historical after an edit, session change, or content conflict", () => {
    expect(isCurrentObservation(receipt, input)).toBe(true);
    expect(isCurrentObservation(receipt, { ...input, inputRevision: 3 })).toBe(false);
    expect(isCurrentObservation(receipt, { ...input, responseDigest: "b".repeat(64) })).toBe(false);
    expect(isCurrentObservation(receipt, { ...input, activitySessionId: crypto.randomUUID() })).toBe(false);
    expect(isCurrentObservation({ ...receipt, status: "pending", observation: null }, input)).toBe(false);
  });

  it("requires complete identity and forbids learner-authored assistance/credit on submit", () => {
    const submit = { ...input, taskId: crypto.randomUUID(), taskVersion: 1,
      response: { kind: "state_tracing", states: [] }, clientAttemptId: crypto.randomUUID() };
    expect(SubmitActivityAttemptSchema.safeParse(submit).success).toBe(true);
    expect(SubmitActivityAttemptSchema.safeParse({ ...submit, responseDigest: "not-a-digest" }).success).toBe(false);
    expect(SubmitActivityAttemptSchema.safeParse({ ...submit, assistance: "independent", awardedXp: 25 }).success).toBe(false);
    expect(SubmitActivityAttemptSchema.safeParse({ ...submit, clientAttemptId: "reused-human-label" }).success).toBe(false);
  });
});

describe("public action protocol", () => {
  it("accepts learner dialogue text but rejects supplied partner transcripts and invented run results", () => {
    const request = { expectedRevision: 2, clientActionId: crypto.randomUUID(), inputRevision: 2,
      responseDigest: input.responseDigest, action: { kind: "dialogue.turn", text: "Which population will receive this model?" } };
    expect(ActivityActionRequestSchema.safeParse(request).success).toBe(true);
    expect(ActivityActionRequestSchema.safeParse({ ...request, action: { ...request.action, partnerReply: "Approved" } }).success).toBe(false);
    expect(ActivityActionRequestSchema.safeParse({ ...request, action: { kind: "run", output: 42 } }).success).toBe(false);
    expect(ActivityActionRequestSchema.safeParse({ ...request, clientActionId: "not-a-uuid" }).success).toBe(false);
    expect(activityActionCost({ kind: "prediction.commit" })).toBe(0);
    expect(activityActionCost({ kind: "dialogue.turn", text: "Question" })).toBe(1);
  });

  it("has strict observation variants and never accepts private graders or expected test outputs", () => {
    expect(PublicObservationSchema.safeParse({ kind: "case_results", cases: [
      { caseId: "learner-case", input: { x: 2 }, output: 4, error: null },
    ] }).success).toBe(true);
    for (const extra of ["expectedAnswer", "secretConfig", "hiddenTests", "privateWorld"]) {
      expect(PublicObservationSchema.safeParse({ ...receipt.observation, [extra]: "private" }).success).toBe(false);
    }
    expect(PublicObservationSchema.safeParse({ kind: "case_results", cases: [
      { caseId: "learner-case", input: { x: 2 }, output: 4, expected: 4, error: null },
    ] }).success).toBe(false);
    expect(PublicObservationSchema.safeParse({ kind: "dialogue", text: "Information revealed.", revealedFacts: [], hiddenFacts: [] }).success).toBe(false);
    expect(ActionReceiptSchema.safeParse({ ...receipt, status: "pending" }).success).toBe(false);
    expect(ActionReceiptSchema.safeParse({ ...receipt, awardedXp: 1 }).success).toBe(false);
  });

  it("rejects mismatched event actions, session identities and future revisions", () => {
    const event = { id: crypto.randomUUID(), seq: 3, at: "2026-10-25T00:00:00Z", action: { kind: "run" }, receipt };
    const session = { id: sessionId, enrollmentId: crypto.randomUUID(), taskId: crypto.randomUUID(), taskVersion: 1,
      revision: 3, inputRevision: 2, status: "active", remainingActions: 5, events: [event] };
    expect(ActivitySessionPublicSchema.safeParse(session).success).toBe(true);
    expect(ActivityEventPublicSchema.safeParse({ ...event, action: { kind: "dialogue.turn", text: "Question" } }).success).toBe(false);
    expect(ActivitySessionPublicSchema.safeParse({ ...session, id: crypto.randomUUID() }).success).toBe(false);
    expect(ActivitySessionPublicSchema.safeParse({ ...session, inputRevision: 1 }).success).toBe(false);
    expect(ActivitySessionPublicSchema.safeParse({ ...session, revision: 2 }).success).toBe(false);
    expect(ActivitySessionPublicSchema.safeParse({ ...session, status: "budget_exhausted" }).success).toBe(false);
    expect(ActivitySessionPublicSchema.safeParse({ ...session, events: [event, event] }).success).toBe(false);
    expect(ActivityEventPublicSchema.safeParse({ ...event, action: { kind: "prediction.commit" }, receipt: { ...receipt, observation: null } }).success).toBe(true);
  });
});
