import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import { IdSchema } from "../../src/domain/common";
import { AgentDecisionReceiptSchema, type AgentDecisionReceipt, type AgentToolAuthority } from "../../src/server/agent-tools/contracts";
import { agentToolStepInput, prepareAgentDecision } from "../../src/server/agent-tools/executor";
import { composeDurableCurriculum, type DurableCompositionInput } from "../../src/server/curriculum-research/durable-composer";
import { materializeOutlineProposal, OutlineProposalSchema, type OutlineProposal } from "../../src/server/curriculum-research/outline-proposal";
import { ContentPageSchema } from "../../src/server/curriculum-research/part-contracts";
import * as parts from "../../src/server/curriculum-research/part-runtime";
import { jsonDigest } from "../../src/server/ai/json";
import type { DbTransaction } from "../../src/server/db";
import type { RunContext } from "../../src/server/runs/ports";
import type { ModelPort } from "../../src/server/ai/ports";
import { ids, now, researchFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
const badUuid = "c4d3e2f1-7a8b-4c9d-0e1f-2a3b4c5d6e7f";
const local = (key: string) => ({ kind: "local" as const, key });
const existing = (id: string) => ({ kind: "existing" as const, id });
const proposal = (): OutlineProposal => ({ outcomes: [
  { key: badUuid, title: "Foundations", demonstration: "Explain the foundations", prerequisiteOutcomeRefs: [], requirement: "core" },
  { key: "practice", title: "Practice", demonstration: "Apply the foundations", prerequisiteOutcomeRefs: [local(badUuid)], requirement: "core" },
], modules: [
  { key: "foundation_module", title: "Foundations", summary: "Learn the foundations", outcomeRefs: [local(badUuid)], prerequisiteModuleRefs: [], estimatedStudyMinutes: 30 },
  { key: "practice_module", title: "Practice", summary: "Apply the foundations", outcomeRefs: [local("practice")], prerequisiteModuleRefs: [local("foundation_module")], estimatedStudyMinutes: 45 },
], complete: true, nextFocus: null });
const materialize = (page = proposal(), options: Partial<Parameters<typeof materializeOutlineProposal>[0]> = {}) => materializeOutlineProposal({
  invocationId: ids.task, sectionKey: "foundations", pageIndex: 0, proposal: page,
  existingOutcomeIds: [], existingModuleIds: [], occupiedIds: [], ...options,
});

it("assigns valid deterministic identities and preserves every graph edge without modifying the paid proposal", () => {
  const raw = proposal(), before = JSON.stringify(raw), result = materialize(raw);
  expect(IdSchema.safeParse(badUuid).success).toBe(false);
  expect(ContentPageSchema.safeParse(result).success).toBe(true);
  expect(result.outcomes[0]!.id).not.toBe(badUuid);
  expect(result.outcomes[1]!.prerequisiteOutcomeIds).toEqual([result.outcomes[0]!.id]);
  expect(result.modules.map(item => item.outcomeIds)).toEqual(result.outcomes.map(item => [item.id]));
  expect(result.modules[1]!.prerequisiteModuleIds).toEqual([result.modules[0]!.id]);
  expect(materialize(structuredClone(raw))).toEqual(result);
  expect(JSON.stringify(raw)).toBe(before);
  for (const options of [{ invocationId: ids.sample }, { sectionKey: "next" }, { pageIndex: 1 }]) {
    expect(materialize(raw, options).outcomes[0]!.id).not.toBe(result.outcomes[0]!.id);
  }
});

it("keeps canonical cross-page references and allows page-local keys to be reused", () => {
  const first = materialize(), next = proposal();
  next.outcomes[0]!.prerequisiteOutcomeRefs = [existing(first.outcomes[1]!.id)];
  next.modules[0]!.prerequisiteModuleRefs = [existing(first.modules[1]!.id)];
  next.modules[0]!.outcomeRefs.push(existing(first.outcomes[0]!.id));
  const second = materialize(next, { pageIndex: 1, existingOutcomeIds: first.outcomes.map(item => item.id),
    existingModuleIds: first.modules.map(item => item.id), occupiedIds: [...first.outcomes, ...first.modules].map(item => item.id) });
  expect(second.outcomes[0]!.prerequisiteOutcomeIds).toEqual([first.outcomes[1]!.id]);
  expect(second.modules[0]!.prerequisiteModuleIds).toEqual([first.modules[1]!.id]);
  expect(second.modules[0]!.outcomeIds).toEqual([second.outcomes[0]!.id, first.outcomes[0]!.id]);
  expect(second.outcomes[0]!.id).not.toBe(first.outcomes[0]!.id);
});

it.each([
  ["duplicate declaration", (page: OutlineProposal) => { page.outcomes[1]!.key = badUuid; }],
  ["cross-namespace declaration", (page: OutlineProposal) => { page.modules[0]!.key = badUuid; }],
  ["wrong local namespace", (page: OutlineProposal) => { page.modules[0]!.outcomeRefs = [local("foundation_module")]; }],
  ["unknown local reference", (page: OutlineProposal) => { page.outcomes[0]!.prerequisiteOutcomeRefs = [local("missing")]; }],
  ["unknown existing reference", (page: OutlineProposal) => { page.outcomes[0]!.prerequisiteOutcomeRefs = [existing(ids.missing)]; }],
  ["forward module reference", (page: OutlineProposal) => { page.modules[0]!.prerequisiteModuleRefs = [local("practice_module")]; }],
  ["duplicate graph edge", (page: OutlineProposal) => { page.modules[0]!.outcomeRefs.push(local(badUuid)); }],
] as const)("rejects %s instead of guessing an identity", (_name, change) => {
  const raw = proposal(); change(raw);
  expect(() => materialize(raw)).toThrow("provider.invalid_output");
});

it("rejects collisions, wrong existing namespaces and malformed existing IDs", () => {
  const raw = proposal(), prior = materialize();
  expect(() => materialize(raw, { occupiedIds: [prior.outcomes[0]!.id] })).toThrow("provider.invalid_output");
  raw.modules[0]!.outcomeRefs = [existing(ids.sample)];
  expect(() => materialize(raw, { existingModuleIds: [ids.sample] })).toThrow("provider.invalid_output");
  raw.modules[0]!.outcomeRefs = [existing(badUuid)];
  expect(OutlineProposalSchema.safeParse(raw).success).toBe(false);
});

it("opts in only newly prepared creation receipts while preserving the historical tool input digest", async () => {
  const data = await researchFixture();
  const decision: AgentDecisionReceipt["decision"] = { tool: "create_course", input: { goal: data.draft.goal, audience: data.draft.audience,
    assumedKnowledge: [], contentLanguage: "en", requiredCapabilities: ["Compare held-out error"], sources: [{ sourceId: data.source.id, blockIds: ["b1"] }] } };
  const old: AgentDecisionReceipt = { kind: "decision", index: 0, invocationId: ids.task, decision, capturedDraft: null,
    capturedCourseRevision: null, preparationError: null };
  expect(AgentDecisionReceiptSchema.parse(old)).toEqual(old);
  const historicalInput = { invocationId: ids.task, index: 0, decisionDigest: jsonDigest(decision, 2 * 1024 * 1024),
    capturedDraftDigest: null, capturedCourseRevision: null, preparationError: null };
  expect(agentToolStepInput(old)).toEqual(historicalInput);
  expect(jsonDigest(agentToolStepInput(old))).toBe(jsonDigest(historicalInput));
  const authority: AgentToolAuthority = { runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation,
    branchId: ids.sample, inputMessageId: ids.missing, sourceIds: new Set([ids.source]), artifactIds: new Set() };
  const fresh = await prepareAgentDecision({} as DbTransaction, authority, decision, 0);
  expect(fresh.outlineIdentityPolicy).toBe("server-assigned-v1");
  expect(agentToolStepInput(fresh)).toMatchObject({ outlineIdentityPolicy: "server-assigned-v1" });
  expect(AgentDecisionReceiptSchema.parse(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh);
  const read = await prepareAgentDecision({} as DbTransaction, authority, { tool: "respond", input: { text: "Ready", awaitingUser: false } }, 1);
  expect(read.outlineIdentityPolicy).toBeUndefined();
});

it("materializes pages before they become continuation and prerequisite-section context, retaining the legacy schema", async () => {
  const data = await researchFixture(), stop = new Error("Research boundary"), captured: Parameters<typeof parts.runCurriculumPart>[2][] = [];
  const selection = [{ sourceId: data.source.id, blockIds: ["b1"] }];
  const context = { claim: { target: { kind: "agent_turn", runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation,
    branchId: ids.sample, inputMessageId: ids.missing } } } as RunContext;
  const input: DurableCompositionInput = { invocationId: ids.task, capturedDraft: null, now, sources: [{ document: data.source, blockIds: ["b1"] }],
    outlineIdentityPolicy: "server-assigned-v1", decision: { tool: "create_course", input: { goal: data.draft.goal, audience: data.draft.audience,
      assumedKnowledge: [], contentLanguage: "en", requiredCapabilities: ["Compare"], sources: selection } } };
  vi.spyOn(parts, "readCurriculumParts").mockResolvedValue(new Map());
  const canonical: z.infer<typeof ContentPageSchema>[] = [];
  vi.spyOn(parts, "runCurriculumPart").mockImplementation(async (_context, _model, part) => {
    captured.push(part);
    if (part.phase === "research") throw stop;
    if (part.phase === "roadmap") return { header: { title: data.draft.title, goal: data.draft.goal, audience: data.draft.audience,
      assumedKnowledge: [], contentLanguage: "en", unresolvedQuestions: [], summary: "A programme", rationale: "Evidence", limitations: [] },
      sections: ["foundation", "advanced"].map((key, index) => ({ key, title: key, scope: key, prerequisiteKeys: index ? ["foundation"] : [],
        requiredCapabilities: ["Compare"], sources: selection })), complete: true, nextFocus: null } as never;
    const raw = proposal();
    if (canonical.length) {
      const prior = canonical.at(-1)!;
      raw.outcomes[0]!.prerequisiteOutcomeRefs = [existing(prior.outcomes.at(-1)!.id)];
      raw.modules[0]!.prerequisiteModuleRefs = [existing(prior.modules.at(-1)!.id)];
    }
    if (part.index === 0) { raw.complete = false; raw.nextFocus = "Continue practice"; }
    const result = await part.commit({} as DbTransaction, part.outputSchema.parse(raw), { stepId: ids.sample });
    canonical.push(ContentPageSchema.parse(result));
    return result;
  });
  await expect(composeDurableCurriculum(context, {} as ModelPort, input)).rejects.toBe(stop);
  const outline = captured.filter(part => part.phase === "outline");
  expect(outline).toHaveLength(3);
  expect(outline.every(part => part.outputSchema === OutlineProposalSchema && part.resultSchema === ContentPageSchema)).toBe(true);
  expect(outline[1]!.request).toMatchObject({ priorOutcomes: canonical[0]!.outcomes.map(({ id, title }) => ({ id, title })) });
  expect(outline[2]!.request).toMatchObject({ prerequisites: [{ key: "foundation", modules: [{ id: canonical[1]!.modules[1]!.id }] }] });
  expect(outline[0]!.instructionVersion).toBe("curriculum-parts-v2:outline-identity-v1");
  vi.mocked(parts.runCurriculumPart).mockImplementation(async (_context, _model, part) => {
    if (part.phase === "roadmap") return { header: { title: data.draft.title, goal: data.draft.goal, audience: data.draft.audience,
      assumedKnowledge: [], contentLanguage: "en", unresolvedQuestions: [], summary: "A programme", rationale: "Evidence", limitations: [] },
      sections: [{ key: "foundation", title: "foundation", scope: "foundation", prerequisiteKeys: [], requiredCapabilities: ["Compare"], sources: selection }], complete: true, nextFocus: null } as never;
    expect(part.outputSchema).toBe(ContentPageSchema);
    expect(part.instructionVersion).toBeUndefined();
    expect(part.instructions).toContain("using new distinct UUIDs for every new outcome and module");
    throw stop;
  });
  const legacyInput = { ...input }; delete legacyInput.outlineIdentityPolicy;
  await expect(composeDurableCurriculum(context, {} as ModelPort, legacyInput)).rejects.toBe(stop);
});

it("accepts an ancestor outcome exposed through a prerequisite section's frontier module", async () => {
  const data = await researchFixture(), stop = new Error("Research boundary"), canonical: z.infer<typeof ContentPageSchema>[] = [];
  const selection = [{ sourceId: data.source.id, blockIds: ["b1"] }];
  const context = { claim: { target: { kind: "agent_turn", runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation,
    branchId: ids.sample, inputMessageId: ids.missing } } } as RunContext;
  const input: DurableCompositionInput = { invocationId: ids.task, capturedDraft: null, now, sources: [{ document: data.source, blockIds: ["b1"] }],
    outlineIdentityPolicy: "server-assigned-v1", decision: { tool: "create_course", input: { goal: data.draft.goal, audience: data.draft.audience,
      assumedKnowledge: [], contentLanguage: "en", requiredCapabilities: ["Compare"], sources: selection } } };
  vi.spyOn(parts, "readCurriculumParts").mockResolvedValue(new Map());
  vi.spyOn(parts, "runCurriculumPart").mockImplementation(async (_context, _model, part) => {
    if (part.phase === "research") throw stop;
    if (part.phase === "roadmap") return { header: { title: data.draft.title, goal: data.draft.goal, audience: data.draft.audience,
      assumedKnowledge: [], contentLanguage: "en", unresolvedQuestions: [], summary: "A programme", rationale: "Evidence", limitations: [] },
      sections: ["A", "B", "C"].map((key, index, keys) => ({ key, title: key, scope: key, prerequisiteKeys: index ? [keys[index - 1]!] : [],
        requiredCapabilities: ["Compare"], sources: selection })), complete: true, nextFocus: null } as never;
    const raw = proposal(); raw.outcomes.splice(1); raw.modules.splice(1);
    if (canonical.length) {
      raw.outcomes[0]!.prerequisiteOutcomeRefs = [existing(canonical.at(-1)!.outcomes[0]!.id)];
      raw.modules[0]!.prerequisiteModuleRefs = [existing(canonical.at(-1)!.modules[0]!.id)];
      raw.modules[0]!.outcomeRefs.push(existing(canonical[0]!.outcomes[0]!.id));
    }
    if (part.index === 2) {
      const request = part.request as { prerequisites: Array<{ key: string; outcomes: Array<{ id: string }>; modules: Array<{ outcomeIds: string[] }> }> };
      expect(request.prerequisites).toHaveLength(1);
      expect(request.prerequisites[0]!.key).toBe("B");
      expect(request.prerequisites[0]!.outcomes.map(item => item.id)).toEqual([canonical[1]!.outcomes[0]!.id]);
      expect(request.prerequisites[0]!.modules[0]!.outcomeIds).toEqual([canonical[1]!.outcomes[0]!.id, canonical[0]!.outcomes[0]!.id]);
    }
    const result = await part.commit({} as DbTransaction, part.outputSchema.parse(raw), { stepId: ids.sample });
    canonical.push(ContentPageSchema.parse(result));
    return result;
  });
  await expect(composeDurableCurriculum(context, {} as ModelPort, input)).rejects.toBe(stop);
  expect(canonical).toHaveLength(3);
  expect(canonical[2]!.modules[0]!.outcomeIds).toEqual([canonical[2]!.outcomes[0]!.id, canonical[0]!.outcomes[0]!.id]);
});

it("replays the saved canonical page without reissuing or rewriting its raw provider proposal", async () => {
  const raw = proposal(), rawBefore = JSON.stringify(raw), receipts = new Map<string, parts.SavedCurriculumPart>();
  const model = { generateStructured: vi.fn(async () => ({ data: raw })) } as unknown as ModelPort;
  const tx = {} as DbTransaction;
  const context = { claim: { target: { kind: "agent_turn", runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation,
    branchId: ids.sample, inputMessageId: ids.missing } }, emitChat: vi.fn(async () => ({})),
    async step(spec: Parameters<RunContext["step"]>[0]) {
      const output = spec.outputSchema.parse(await spec.effect({ stepId: ids.sample, deadlineAt: Date.now() + 10000,
        budgetOperation: () => ({ logicalOperationId: ids.sample }) } as never, spec.input));
      const result = spec.resultSchema.parse(await spec.commit(tx, output));
      receipts.set(spec.key, { step_key: spec.key, input_digest: jsonDigest(spec.input), schema_digest: spec.digests.schema,
        capability_digest: spec.digests.capability, validation_policy_digest: spec.digests.validationPolicy,
        approval_digest: spec.digests.approval, result_reference: result });
      return result;
    },
  } as unknown as RunContext;
  const input = { invocationId: ids.task, phase: "outline", index: 0, request: { section: "foundations" },
    instructions: "Use local keys", instructionVersion: "curriculum-parts-v2:outline-identity-v1" as const,
    outputSchema: OutlineProposalSchema, resultSchema: ContentPageSchema, saved: receipts, completedSummary: "Outlined foundations",
    commit: async (_tx: DbTransaction, page: OutlineProposal) => materialize(page) };
  const first = await parts.runCurriculumPart(context, model, input);
  expect(first).toEqual(materialize(raw));
  expect(await parts.runCurriculumPart(context, model, { ...input, saved: new Map(receipts) })).toEqual(first);
  expect(model.generateStructured).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(raw)).toBe(rawBefore);
  expect([...receipts.values()][0]!.result_reference).toEqual(first);
});
