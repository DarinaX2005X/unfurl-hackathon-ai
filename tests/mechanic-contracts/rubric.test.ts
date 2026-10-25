import { describe, expect, it, vi } from "vitest";

// This removes only Next's import guard in the test process; no provider is simulated in production.
vi.mock("server-only", () => ({}));

import {
  GradeDecisionSchema, RubricRequestSchema, evaluateRubric, resolveResponsePath, validateRubricJudgement,
  type RubricRequest,
} from "../../src/server/evaluation/contracts";

const request: RubricRequest = {
  rubric: {
    id: crypto.randomUUID(), dimensions: [{
      id: "scope", criterion: "State what the observation establishes.",
      met: "The claim stays within the observed setting.", partial: "The limit is incompletely stated.",
      notMet: "The answer asserts an unsupported universal guarantee.",
    }],
  },
  response: { text: "The score describes the evaluated population.", notes: ["Different settings need further evidence."] },
  allowedResponsePaths: [["text"], ["notes", 0]],
};
const judgement = {
  dimensions: [{ id: "scope", status: "met", explanation: "The claim names its evaluated population.",
    evidenceRefs: [{ responsePath: ["text"], span: { start: 0, end: 43 } }] }],
  feedback: "The claim preserves its scope.", uncertainReasons: [],
};

describe("server-only rubric boundary", () => {
  it("requires every rubric dimension exactly once and verifies real response evidence", () => {
    expect(validateRubricJudgement(judgement, request)).toEqual(judgement);
    expect(() => validateRubricJudgement({ ...judgement, dimensions: [] }, request)).toThrow();
    expect(() => validateRubricJudgement({ ...judgement, dimensions: [...judgement.dimensions, ...judgement.dimensions] }, request)).toThrow();
    expect(() => validateRubricJudgement({ ...judgement, dimensions: [{ ...judgement.dimensions[0], id: "invented" }] }, request)).toThrow();
    for (const evidenceRefs of [
      [],
      [{ responsePath: ["privateAnswer"], span: null }],
      [{ responsePath: ["notes"], span: null }],
      [{ responsePath: ["text"], span: { start: 0, end: 999 } }],
    ]) {
      expect(() => validateRubricJudgement({ ...judgement, dimensions: [{ ...judgement.dimensions[0], evidenceRefs }] }, request)).toThrow();
    }
  });

  it("rejects model authority fields and requires an explicit reason for uncertainty", () => {
    for (const key of ["awardedXp", "attemptId", "correct", "confidence", "route"]) {
      expect(() => validateRubricJudgement({ ...judgement, [key]: 1 }, request)).toThrow();
    }
    const uncertain = { ...judgement, dimensions: [{ ...judgement.dimensions[0], status: "uncertain", evidenceRefs: [] }] };
    expect(() => validateRubricJudgement(uncertain, request)).toThrow();
    expect(validateRubricJudgement({ ...uncertain, uncertainReasons: ["valid_alternative"] }, request).uncertainReasons)
      .toEqual(["valid_alternative"]);
    expect(GradeDecisionSchema.safeParse({ status: "evaluated", outcome: "correct",
      dimensions: [{ id: "scope", status: "uncertain", explanation: "Unresolved" }],
      feedback: { explanation: "Unresolved", nextAction: "continue" } }).success).toBe(false);
  });

  it("does not traverse prototypes or accept invented allowable response paths", () => {
    expect(resolveResponsePath(request.response, ["notes", 0])).toEqual({ found: true, value: "Different settings need further evidence." });
    expect(resolveResponsePath(request.response, ["notes", "0"])).toEqual({ found: false });
    expect(resolveResponsePath(request.response, ["constructor"])).toEqual({ found: false });
    expect(RubricRequestSchema.safeParse({ ...request, allowedResponsePaths: [["missing"]] }).success).toBe(false);
  });

  it("returns unavailable with no provider and propagates cancellation", async () => {
    const result = await evaluateRubric(request, { model: null, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "unavailable", outcome: null, feedback: { nextAction: "wait" } });
    expect(result).not.toHaveProperty("awardedXp");
    const abort = new AbortController();
    abort.abort();
    await expect(evaluateRubric(request, { model: null, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("treats injected or unverifiable adapter output as uncertain, never a learner error", async () => {
    const adapterOutput = { ...judgement, awardedXp: 999 };
    const boundaryStub = { judge: vi.fn().mockResolvedValue(adapterOutput) };
    expect(await evaluateRubric(request, { model: boundaryStub, signal: new AbortController().signal }))
      .toMatchObject({ status: "uncertain", outcome: null });
    expect(boundaryStub.judge).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    const rejectedAdapter = { judge: vi.fn().mockRejectedValue(new Error("Provider unavailable")) };
    expect(await evaluateRubric(request, { model: rejectedAdapter, signal: new AbortController().signal }))
      .toMatchObject({ status: "unavailable", outcome: null });
  });
});
