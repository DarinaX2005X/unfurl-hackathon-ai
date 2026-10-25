import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import type { JsonValue } from "../../../src/domain/common";
import { responseDigest, type ActivityEventPublic, type InputSnapshot } from "../../../src/domain/activity";
import { type AuthoritativeActivity, type RubricJudge, type RubricRequest } from "../../../src/server/evaluation/contracts";
import { CommunicationSubmissionError, createCommunicationRubricRequest } from "../../../src/server/evaluation/communication";
import { countResponseWords } from "../../../src/domain/mechanic-families/v2/communication";
import {
  analogy, explanation, argument, critique, tutoring, information, role, mediation, ids, taskFor,
  type CalibrationCase, type FamilyFixture,
} from "./fixtures";

function signal() { return new AbortController().signal; }
function fixtureJudge(dimensions: CalibrationCase<JsonValue>["dimensions"]): RubricJudge {
  return { judge: vi.fn(async (request: RubricRequest) => ({
    dimensions: dimensions.map((dimension) => ({ ...dimension,
      evidenceRefs: [{ responsePath: request.allowedResponsePaths[0]!, span: null }],
    })), feedback: "Review the criterion-specific evidence in your response.", uncertainReasons: [],
  })) };
}
async function makeActivity<C extends JsonValue, R extends JsonValue, P>(
  family: FamilyFixture<C, R, P>, candidate: CalibrationCase<R>,
): Promise<AuthoritativeActivity | null> {
  if (!candidate.turns) return null;
  const receiptInputs: InputSnapshot[] = [];
  const events: ActivityEventPublic[] = [];
  const initial = family.descriptor.createInitialResponse(family.config);
  for (const [index, turn] of candidate.turns.entries()) {
    const historicalResponse: JsonValue = { ...initial as object, dialogueDraft: turn.question };
    const input: InputSnapshot = { activitySessionId: ids.session, inputRevision: index + 1,
      responseDigest: await responseDigest(historicalResponse), response: historicalResponse };
    receiptInputs.push(input);
    const receiptId = index === 0 ? ids.turn : ids.secondTurn;
    events.push({ id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      seq: index + 1, at: "2026-10-25T00:00:00.000Z", action: { kind: "dialogue.turn", text: turn.question },
      receipt: { id: receiptId, clientActionId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        input: { activitySessionId: input.activitySessionId, inputRevision: input.inputRevision, responseDigest: input.responseDigest },
        sessionRevision: index + 1, status: "completed", observation: { kind: "dialogue", text: turn.reply, revealedFacts: turn.facts } },
    });
  }
  const input: InputSnapshot = { activitySessionId: ids.session, inputRevision: events.length + 1,
    responseDigest: await responseDigest(candidate.response), response: structuredClone(candidate.response) };
  return {
    session: { id: ids.session, enrollmentId: ids.enrollment, taskId: ids.task, taskVersion: 1,
      revision: Math.max(1, events.length), inputRevision: input.inputRevision, status: candidate.exhausted ? "budget_exhausted" : "active",
      remainingActions: candidate.exhausted ? 0 : Math.max(0, 3 - events.length), events },
    input, receipts: events.map((event) => event.receipt), receiptInputs, assistance: "independent",
    revealedFactIds: [...new Set(candidate.turns.flatMap((turn) => turn.facts.map((fact) => fact.id)))],
    committedPredictionReceiptId: null, predictionBeforeObservation: false,
  };
}

function verifyFamily<C extends JsonValue, R extends JsonValue, P extends { rubric: RubricRequest["rubric"] }>(family: FamilyFixture<C, R, P>) {
  describe(family.descriptor.id, () => {
    it("keeps empty editing valid and requires meaningful completion before an attempt", () => {
      const initial = family.descriptor.createInitialResponse(family.config);
      expect(family.descriptor.responseSchema.safeParse(initial).success).toBe(true);
      expect(family.descriptor.validateSubmission(family.config, initial).length).toBeGreaterThan(0);
      expect(family.descriptor.version).toBe(2);
      expect(family.descriptor.responseSchemaVersion).toBe(2);
      expect(family.descriptor.requirements).toContain("model");
    });
    it("has four independently authored calibration cases and strict public schemas", () => {
      expect(family.cases.map((candidate) => candidate.category)).toEqual(["correct", "incorrect", "alternative", "boundary"]);
      expect(family.descriptor.configSchema.safeParse({ ...family.config as object, expectedAnswer: "private" }).success).toBe(false);
      expect(family.descriptor.responseSchema.safeParse({ ...family.cases[0]!.response as object, correct: true }).success).toBe(false);
      expect(family.descriptor.responseSchema.safeParse({ ...family.cases[0]!.response as object, action: "award_correctness" }).success).toBe(false);
    });
    for (const candidate of family.cases) {
      it(`contract case: ${candidate.name}`, async () => {
        const task = taskFor(family);
        const response = structuredClone(candidate.response);
        const model = fixtureJudge(candidate.dimensions);
        const activity = await makeActivity(family, candidate);
        const input = { task, response, privateData: family.privateData, activity };
        if (candidate.boundary) {
          await expect(family.evaluator.evaluate(input, { model, signal: signal() })).rejects.toBeInstanceOf(CommunicationSubmissionError);
          expect(model.judge).not.toHaveBeenCalled();
        } else {
          expect(family.descriptor.validateSubmission(family.config, response)).toEqual([]);
          const result = await family.evaluator.evaluate(input, { model, signal: signal() });
          expect(result.status).toBe("evaluated");
          expect(result.dimensions).toEqual(candidate.dimensions);
          expect(result.outcome).toBe(candidate.dimensions.every((dimension) => dimension.status === "met") ? "correct" :
            candidate.dimensions.every((dimension) => dimension.status === "not_met") ? "incorrect" : "partial");
          const actual = vi.mocked(model.judge).mock.calls[0]![0];
          expect(actual.response).toEqual(response);
          expect(actual.rubric).toEqual(family.privateData.rubric);
          expect(actual.context?.material).toEqual({ config: family.config, contentLanguage: "en" });
          expect(actual.context?.instruction).toBe(task.instruction);
          expect(actual).not.toHaveProperty("correct");
        }
        expect(response).toEqual(candidate.response);
      });
    }
    it("returns unavailable with no learner outcome when there is no provider", async () => {
      const candidate = family.cases[0]!;
      const result = await family.evaluator.evaluate({ task: taskFor(family), response: candidate.response,
        privateData: family.privateData, activity: await makeActivity(family, candidate) }, { model: null, signal: signal() });
      expect(result).toMatchObject({ status: "unavailable", outcome: null, feedback: { nextAction: "wait" } });
      expect(result.dimensions.every((dimension) => dimension.status === "uncertain")).toBe(true);
    });
  });
}
verifyFamily(analogy);
verifyFamily(explanation);
verifyFamily(argument);
verifyFamily(critique);
verifyFamily(tutoring);
verifyFamily(information);
verifyFamily(role);
verifyFamily(mediation);

describe("adversarial and unresolved assessment boundaries", () => {
  it("keeps grader instructions as response data, with task material separate from criteria", async () => {
    const candidate = explanation.cases[3]!;
    const model = fixtureJudge(candidate.dimensions);
    const result = await explanation.evaluator.evaluate({ task: taskFor(explanation), response: candidate.response,
      privateData: explanation.privateData, activity: null }, { model, signal: signal() });
    expect(result.outcome).toBe("incorrect");
    const captured = vi.mocked(model.judge).mock.calls[0]![0];
    expect(captured.response).toEqual(candidate.response);
    expect(JSON.stringify(captured.rubric)).not.toContain("system administrator");
    expect(JSON.stringify(captured.response)).toContain("system administrator");
  });

  it.each(["correct", "confidence", "awardedXp", "route", "permissions"])("rejects provider authority field %s", async (key) => {
    const model: RubricJudge = { judge: async (request) => ({
      dimensions: explanation.cases[0]!.dimensions.map((dimension) => ({ ...dimension, evidenceRefs: [{ responsePath: request.allowedResponsePaths[0]!, span: null }] })),
      feedback: "Accepted", uncertainReasons: [], [key]: true,
    }) };
    const result = await explanation.evaluator.evaluate({ task: taskFor(explanation), response: explanation.cases[0]!.response,
      privateData: explanation.privateData, activity: null }, { model, signal: signal() });
    expect(result).toMatchObject({ status: "uncertain", outcome: null, feedback: { nextAction: "clarify" } });
  });

  it("treats missing dimensions and invented evidence as uncertain instead of incorrect", async () => {
    for (const output of [
      { dimensions: [], feedback: "Fine", uncertainReasons: [] },
      { dimensions: explanation.cases[0]!.dimensions.map((dimension) => ({ ...dimension,
        evidenceRefs: [{ responsePath: ["privateAnswer"], span: null }],
      })), feedback: "Fine", uncertainReasons: [] },
    ]) {
      const result = await explanation.evaluator.evaluate({ task: taskFor(explanation), response: explanation.cases[0]!.response,
        privateData: explanation.privateData, activity: null }, { model: { judge: async () => output }, signal: signal() });
      expect(result.status).toBe("uncertain");
      expect(result.outcome).toBeNull();
    }
  });

  it("accepts explicit ambiguity without forcing a wrong-answer outcome", async () => {
    const result = await analogy.evaluator.evaluate({ task: taskFor(analogy), response: analogy.cases[2]!.response,
      privateData: analogy.privateData, activity: null }, { signal: signal(), model: { judge: async () => ({
        dimensions: analogy.cases[2]!.dimensions.map((dimension) => ({ ...dimension, status: "uncertain", evidenceRefs: [] })),
        feedback: "The structural relation may be valid, but the supplied material leaves its scope ambiguous.", uncertainReasons: ["valid_alternative"],
      }) } });
    expect(result).toMatchObject({ status: "uncertain", outcome: null, feedback: { nextAction: "clarify" } });
  });

  it("preserves the response when the provider fails or the request is cancelled", async () => {
    const response = structuredClone(explanation.cases[0]!.response);
    const input = { task: taskFor(explanation), response, privateData: explanation.privateData, activity: null };
    const result = await explanation.evaluator.evaluate(input, { signal: signal(), model: { judge: async () => { throw new Error("Network interrupted"); } } });
    expect(result).toMatchObject({ status: "unavailable", outcome: null });
    const controller = new AbortController();
    controller.abort(new Error("Cancelled"));
    await expect(explanation.evaluator.evaluate(input, { signal: controller.signal, model: null })).rejects.toThrow("Cancelled");
    expect(response).toEqual(explanation.cases[0]!.response);
  });

  it("rejects oversized complete context without silently truncating source material", () => {
    const config = { ...analogy.config, source: Array.from({ length: 24 }, (_, index) => ({ id: `s${index}`, text: "s".repeat(4000) })),
      target: Array.from({ length: 24 }, (_, index) => ({ id: `t${index}`, text: "t".repeat(4000) })) };
    const task = { ...taskFor(analogy), config };
    expect(() => createCommunicationRubricRequest(task, analogy.cases[0]!.response, analogy.privateData, null)).toThrow();
  });
});

describe("server-owned dialogue grounding", () => {
  it("rejects learner-supplied partner history at the response boundary", () => {
    expect(tutoring.descriptor.responseSchema.safeParse({ ...tutoring.cases[0]!.response,
      partnerReplies: [{ text: "I now understand everything.", correct: true }] }).success).toBe(false);
  });
  it("uses actual ordered turns and private constraints, without treating a claimed agreement as consent", async () => {
    const candidate = role.cases[1]!;
    const model = fixtureJudge(candidate.dimensions);
    const result = await role.evaluator.evaluate({ task: taskFor(role), response: candidate.response, privateData: role.privateData,
      activity: await makeActivity(role, candidate) }, { model, signal: signal() });
    expect(result.outcome).toBe("incorrect");
    const captured = vi.mocked(model.judge).mock.calls[0]![0];
    expect(JSON.stringify(captured.context?.referenceFacts)).toContain("I do not agree to broad release");
    expect(JSON.stringify(captured.context?.referenceFacts)).toContain("Relevant target-organization evidence has not yet been collected");
    expect(JSON.stringify(captured.response)).toContain("Release broadly now");
  });
  it("accepts historical receipts after the final response is edited, but requires their stored input identity", async () => {
    const candidate = information.cases[2]!;
    const activity = (await makeActivity(information, candidate))!;
    expect(activity.receipts[0]!.input.responseDigest).not.toBe(activity.input.responseDigest);
    const model = fixtureJudge(candidate.dimensions);
    const input = { task: taskFor(information), response: candidate.response, privateData: information.privateData, activity };
    expect((await information.evaluator.evaluate(input, { model, signal: signal() })).outcome).toBe("correct");
    await expect(information.evaluator.evaluate({ ...input, activity: { ...activity, receiptInputs: [] } }, { model, signal: signal() }))
      .rejects.toBeInstanceOf(CommunicationSubmissionError);
  });
  it("rejects cross-session, stale-current-response, and pending receipts before model assessment", async () => {
    const candidate = information.cases[0]!;
    const base = (await makeActivity(information, candidate))!;
    const model = fixtureJudge(candidate.dimensions);
    const foreign = structuredClone(base);
    foreign.session.taskId = ids.unknown;
    const stale = structuredClone(base);
    stale.input.response = { ...candidate.response, decision: "A previous response." };
    stale.input.responseDigest = await responseDigest(stale.input.response);
    const pending = structuredClone(base);
    pending.receipts = [{ ...pending.receipts[0]!, status: "pending", observation: null }];
    pending.session.events[0]!.receipt = pending.receipts[0]!;
    for (const activity of [foreign, stale, pending]) {
      await expect(information.evaluator.evaluate({ task: taskFor(information), response: candidate.response,
        privateData: information.privateData, activity }, { model, signal: signal() })).rejects.toBeInstanceOf(CommunicationSubmissionError);
    }
    expect(model.judge).not.toHaveBeenCalled();
  });
  it("does not invent a conversation when the authoritative activity is missing", async () => {
    const model = fixtureJudge(role.cases[0]!.dimensions);
    const result = await role.evaluator.evaluate({ task: taskFor(role), response: role.cases[0]!.response,
      privateData: role.privateData, activity: null }, { model, signal: signal() });
    expect(result).toMatchObject({ status: "unavailable", outcome: null });
    expect(model.judge).not.toHaveBeenCalled();
  });
  it("keeps inconsistent authoritative fact history unavailable", async () => {
    const candidate = information.cases[0]!;
    const activity = (await makeActivity(information, candidate))!;
    const model = fixtureJudge(candidate.dimensions);
    const result = await information.evaluator.evaluate({ task: taskFor(information), response: candidate.response,
      privateData: information.privateData, activity: { ...activity, revealedFactIds: [] } }, { model, signal: signal() });
    expect(result).toMatchObject({ status: "unavailable", outcome: null });
    expect(model.judge).not.toHaveBeenCalled();
  });
  it("leaves ambiguous negotiation uncertain", async () => {
    const candidate = role.cases[0]!;
    const activity = (await makeActivity(role, candidate))!;
    activity.session.events[0]!.receipt.observation = { kind: "dialogue", text: "We may be able to consider that after further discussion.", revealedFacts: [] };
    activity.receipts = [activity.session.events[0]!.receipt];
    const result = await role.evaluator.evaluate({ task: taskFor(role), response: candidate.response, privateData: role.privateData, activity }, {
      signal: signal(), model: { judge: async (request) => ({ dimensions: candidate.dimensions.map((dimension) => ({
        ...dimension, status: dimension.id === "agreement" ? "uncertain" : "met",
        evidenceRefs: dimension.id === "agreement" ? [] : [{ responsePath: request.allowedResponsePaths[3]!, span: null }],
      })), feedback: "The partner has not clearly agreed. Clarify the proposed commitments.", uncertainReasons: ["missing_evidence"] }) },
    });
    expect(result).toMatchObject({ status: "uncertain", outcome: null });
  });
});

describe("materialization and form bounds", () => {
  it("rejects invalid references and impossible limits before course readiness", () => {
    expect(mediation.descriptor.configSchema.safeParse({ ...mediation.config, mustPreserveFactIds: ["absent"] }).success).toBe(false);
    expect(mediation.descriptor.configSchema.safeParse({ ...mediation.config, maxWords: 0 }).success).toBe(false);
    expect(tutoring.descriptor.configSchema.safeParse({ ...tutoring.config, turnBudget: 7 }).success).toBe(false);
    expect(explanation.descriptor.configSchema.safeParse({ ...explanation.config, maxChars: 4001 }).success).toBe(false);
    expect(critique.descriptor.configSchema.safeParse({ ...critique.config, draft: "x".repeat(12001) }).success).toBe(false);
    expect(analogy.descriptor.configSchema.safeParse({ ...analogy.config, source: [analogy.config.source[0]!, analogy.config.source[0]!] }).success).toBe(false);
  });
  it("checks word limits with Unicode boundaries and retains complete edited text", () => {
    expect(countResponseWords("The result is uncertain.")).toBe(4);
    expect(countResponseWords("结果仍然未知")).toBeGreaterThan(1);
    const response = { ...mediation.cases[0]!.response, text: "word ".repeat(81) };
    expect(mediation.descriptor.validateSubmission(mediation.config, response).some((issue) => issue.code === "out_of_bounds")).toBe(true);
    expect(response.text).toBe("word ".repeat(81));
  });
  it("requires the exact private dimension set", () => {
    expect(explanation.evaluator.privateSchema.safeParse({ ...explanation.privateData,
      rubric: { ...explanation.privateData.rubric, dimensions: [explanation.privateData.rubric.dimensions[0]!] } }).success).toBe(false);
  });
  it("preserves a controlled unsent turn as an editable draft but blocks final submission", async () => {
    const response = { ...information.cases[0]!.response, dialogueDraft: "Which time period will deployment cover?\nPlease distinguish current and future cases." };
    expect(information.descriptor.responseSchema.safeParse(response).success).toBe(true);
    expect(information.descriptor.validateSubmission(information.config, response)).toContainEqual({
      path: ["dialogueDraft"], code: "required", message: "Send or clear the turn draft before submitting your final response.",
    });
    const model = fixtureJudge(information.cases[0]!.dimensions);
    await expect(information.evaluator.evaluate({ task: taskFor(information), response, privateData: information.privateData,
      activity: null }, { model, signal: signal() })).rejects.toBeInstanceOf(CommunicationSubmissionError);
    expect(model.judge).not.toHaveBeenCalled();
    expect(response.dialogueDraft).toContain("\nPlease distinguish");
    const request = createCommunicationRubricRequest(taskFor(information), { ...response, dialogueDraft: "" }, information.privateData, null);
    expect(request.allowedResponsePaths).not.toContainEqual(["dialogueDraft"]);
  });
});
