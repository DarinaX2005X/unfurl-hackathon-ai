import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createRubricJudge } from "../../src/server/ai/rubric-judge";
import type { ModelPort } from "../../src/server/ai/ports";
import { ProviderFailure } from "../../src/server/ai/failure";
import {
  InvalidRubricEvidenceError, evaluateRubric, type RubricRequest,
} from "../../src/server/evaluation/contracts";

const request: RubricRequest = {
  rubric: { id: "00000000-0000-4000-8000-000000000001", dimensions: [{
    id: "scope", criterion: "State what the observation establishes.",
    met: "The claim stays within the observed setting.", partial: "The limit is incompletely stated.",
    notMet: "The answer asserts an unsupported universal guarantee.",
  }] },
  response: { text: "The score describes the evaluated population." },
  allowedResponsePaths: [["text"]],
};
const judgement = {
  dimensions: [{ id: "scope", status: "met", explanation: "The claim names its evaluated population.",
    evidenceRefs: [{ responsePath: ["text"], span: { start: 0, end: 43 } }] }],
  feedback: "The claim preserves its scope.", uncertainReasons: [],
};

function adapter(output: unknown = judgement) {
  // Only the ModelPort boundary is stubbed; no transport, budget, or database is contacted.
  const generateStructured = vi.fn().mockResolvedValue({ data: output });
  const judge = createRubricJudge({ generateStructured } as unknown as ModelPort, {
    budget: {
      logicalOperationId: "00000000-0000-4000-8000-000000000002",
      reservationId: "00000000-0000-4000-8000-000000000003",
      attempt: 1, runStepId: null, probe: false,
    },
    deadlineAt: Date.now() + 1_000,
  });
  return { judge, generateStructured };
}

describe("rubric adapter and assessment composition", () => {
  it.each([
    ["an out-of-range evidence span", { ...judgement, dimensions: [{ ...judgement.dimensions[0],
      evidenceRefs: [{ responsePath: ["text"], span: { start: 0, end: 999 } }] }] }],
    ["a mismatched dimension", { ...judgement, dimensions: [{ ...judgement.dimensions[0], id: "invented" }] }],
    ["a returned malformed judgement", { ...judgement, awardedXp: 999 }],
  ])("makes %s uncertain without awarding credit", async (_label, output) => {
    const { judge, generateStructured } = adapter(output);
    const decision = await evaluateRubric(request, { model: judge, signal: new AbortController().signal });
    expect(decision).toMatchObject({ status: "uncertain", outcome: null,
      dimensions: [{ id: "scope", status: "uncertain" }], feedback: { nextAction: "clarify" } });
    expect(decision).not.toHaveProperty("awardedXp");
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("still rejects unverifiable judgements before generation wrappers can capture them", async () => {
    const { judge } = adapter({ ...judgement, dimensions: [{ ...judgement.dimensions[0], id: "invented" }] });
    await expect(judge.judge(request, new AbortController().signal)).rejects.toBeInstanceOf(InvalidRubricEvidenceError);
  });

  it("preserves valid evidence through the actual adapter", async () => {
    const { judge, generateStructured } = adapter();
    expect(await evaluateRubric(request, { model: judge, signal: new AbortController().signal }))
      .toMatchObject({ status: "evaluated", outcome: "correct", feedback: { nextAction: "continue" } });
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("keeps genuine provider rejection unavailable", async () => {
    const { judge, generateStructured } = adapter();
    generateStructured.mockRejectedValue(new ProviderFailure("unavailable"));
    expect(await evaluateRubric(request, { model: judge, signal: new AbortController().signal }))
      .toMatchObject({ status: "unavailable", outcome: null, feedback: { nextAction: "wait" } });
  });

  it("preserves cancellation even when the adapter rejects evidence", async () => {
    const { judge, generateStructured } = adapter();
    const controller = new AbortController();
    generateStructured.mockImplementation(async () => {
      controller.abort();
      return { data: { ...judgement, dimensions: [] } };
    });
    await expect(evaluateRubric(request, { model: judge, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
