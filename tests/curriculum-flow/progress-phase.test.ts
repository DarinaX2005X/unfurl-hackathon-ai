import { expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/runs/events", () => ({ appendChatEvent: vi.fn() }));
import { appendChatEvent } from "../../src/server/runs/events";
import { runCurriculumPart } from "../../src/server/curriculum-research/part-runtime";
import type { RunContext, StepEffectContext } from "../../src/server/runs/ports";
import type { DbTransaction } from "../../src/server/db";
import type { ModelPort } from "../../src/server/ai/ports";
import { ids } from "./fixtures";

it("publishes the real curriculum phase before executing its paid part", async () => {
  const target = { kind: "agent_turn", runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample, inputMessageId: ids.missing };
  const tx = { query: vi.fn(async () => ({ rows: [] })) } as unknown as DbTransaction;
  const model = { generateStructured: vi.fn() } as unknown as ModelPort;
  const context = { claim: { target }, async step(spec: Parameters<RunContext["step"]>[0]) {
    await spec.prepare?.(tx, {} as StepEffectContext, spec.input);
    return { value: "saved" };
  } } as unknown as RunContext;
  const schema = z.object({ value: z.string() });
  await runCurriculumPart(context, model, { invocationId: ids.request, phase: "outline", index: 0,
    request: {}, instructions: "Unchanged instructions", outputSchema: schema, resultSchema: schema, saved: new Map(),
    completedSummary: "Outlined the next part of “Model evaluation”.", commit: async (_tx, value) => value });
  expect(appendChatEvent).toHaveBeenCalledWith(tx, target, expect.objectContaining({ type: "action.started", action: "build_outline", labelKey: "generation.planCourse.outline" }));
  expect(model.generateStructured).not.toHaveBeenCalled();
});
