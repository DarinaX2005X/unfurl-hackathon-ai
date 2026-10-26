import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { OpenRouterModel, bindProviderOutput, buildProviderRequestBody, captureProviderOutputRateCard, providerRequestDigest } from "../../src/server/ai/openrouter";
import { boundKimiApplicationPrompt, type ApplicationPromptMessages } from "../../src/server/ai/kimi-context";
import { approveEndpoint } from "../../src/server/ai/rate-card";
import { modelPolicy, type ModelPolicyId } from "../../src/server/ai/model-policy";
import { PROVIDER_MAX_OUTPUT_POLICY, verifyProviderOutputEvidence } from "../../src/server/ai/output-policy";
import type { ModelRequestBase, ProviderCapabilityGate } from "../../src/server/ai/ports";
import type { BudgetAllocation, BudgetPort, BudgetReservation, ProviderResponseReceipt, ReserveRequest } from "../../src/server/budget/ports";
import { ProviderFailure } from "../../src/server/ai/failure";
import { canonicalJson, digestBytes, jsonDigest } from "../../src/server/ai/json";

function harness(policyId: ModelPolicyId = "kimi-digitalocean-v1", options: { content?: string; completionTokens?: number; search?: boolean; framing?: boolean; httpError?: boolean } = {}) {
  const policy = modelPolicy(policyId), gemini = policy.provider === "google-ai-studio";
  const rate = approveEndpoint({ data: { endpoints: [{ name: `${policy.providerName} | ${policy.model}`, model_id: policy.model,
    provider_name: policy.providerName, tag: policy.provider, context_length: gemini ? 1048576 : 262144,
    max_completion_tokens: gemini ? 65536 : 235929, supported_parameters: ["max_tokens", "response_format", "reasoning", "tools", "tool_choice"],
    status: 0, pricing: { prompt: policy.priceCaps.prompt, completion: policy.priceCaps.completion } }] } }, Date.now(), policyId);
  const capture = { version: PROVIDER_MAX_OUTPUT_POLICY, jobId: randomUUID(), receiptId: randomUUID(), receiptDigest: "a".repeat(64) };
  const operationId = randomUUID();
  const request: ModelRequestBase = { operationId, purpose: options.search ? "source_extraction" : "curriculum",
    instructionVersion: "provider-max-contract-v1", trustedInstructions: "Return the requested data.", untrustedInput: { example: true },
    model: policy.model, modelPolicy: policyId, maxOutputTokens: 1800, deadlineAt: Date.now() + 60000,
    ...(options.search ? { searchPolicy: "bounded-search-headroom-v2" as const } : {}),
    budget: { logicalOperationId: operationId, reservationId: randomUUID(), attempt: 1, runStepId: randomUUID(), probe: false, outputPolicy: capture } };
  let allocation: BudgetAllocation | null = null, saved: ProviderResponseReceipt | null = null;
  let reservation: BudgetReservation;
  const budget: BudgetPort = {
    assertAvailable: vi.fn(async () => undefined),
    existingAllocation: vi.fn(async () => allocation),
    recover: vi.fn(async (_context, digest) => {
      if (!allocation) return null;
      if (digest !== allocation.reservation.requestDigest) throw new ProviderFailure("unavailable");
      if (saved) return { reservation: allocation.reservation, receipt: saved };
      if (allocation.reservation.state !== "reserved") throw new ProviderFailure("unavailable");
      return null;
    }),
    reserve: vi.fn(async (input: ReserveRequest) => {
      reservation = { id: input.reservationId, budgetId: randomUUID(), requestDigest: input.requestDigest,
        amountMicroUsd: input.amountMicroUsd, state: "reserved", ...(input.outputPolicy ? { outputPolicy: input.outputPolicy } : {}) };
      allocation = { reservation, rateCard: input.rateCard, rateCardDigest: input.rateCardDigest }; return reservation;
    }),
    claimDispatch: vi.fn(async () => ({ kind: "dispatch" as const })),
    recordProviderIdentity: vi.fn(async () => undefined),
    recordResponse: vi.fn(async (_reserved, receipt, cost) => { saved = receipt; reservation.state = cost === null ? "unknown" : "settled"; }),
    markUnknown: vi.fn(async () => { reservation.state = "unknown"; }),
    releaseUnsent: vi.fn(async () => undefined), halt: vi.fn(async () => undefined),
  };
  const gate: ProviderCapabilityGate = { snapshot: () => ({ model: policy.model, provider: policy.provider,
    structured: true, text: true, rubric: true, search: true, limitations: [] }), assertAvailable: vi.fn(async () => undefined) };
  const completionTokens = options.completionTokens ?? 10, content = options.content ?? '{"answer":"ok"}';
  const usage = { prompt_tokens: 20, completion_tokens: completionTokens, total_tokens: 20 + completionTokens, cost: "0.0000354" };
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (options.httpError) return new Response(JSON.stringify({ error: { code: 400, message: "Context length exceeded" } }), { status: 400 });
    if (!gemini) return new Response(JSON.stringify({ id: "gen-output-policy-test", model: policy.model, provider: policy.providerName,
      choices: [{ finish_reason: "stop", message: { content } }], usage }));
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    return new Response(`${options.framing ? `:${" ".repeat(2 * 1024 * 1024)}\n\n` : ""}${frame({ id: "gen-output-policy-test", model: policy.model,
      provider: policy.providerName, choices: [{ index: 0, finish_reason: null, delta: { content } }] })}${frame({ id: "gen-output-policy-test", model: policy.model,
      provider: policy.providerName, choices: [{ index: 0, finish_reason: "stop", delta: {} }], usage })}data: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream", "x-generation-id": "gen-output-policy-test" } });
  });
  const rateCards = { current: vi.fn(async () => rate) };
  const model = new OpenRouterModel({ apiKey: () => "offline-output-contract-key", budget, gate, rateCards, fetcher });
  return { model, request, rate, budget, fetcher, rateCards, saved: () => saved!, allocation: () => allocation!,
    seedReserved() {
      const frozenRate = captureProviderOutputRateCard(request, rate);
      const resolved = bindProviderOutput(request, frozenRate);
      reservation = { id: request.budget.reservationId, budgetId: randomUUID(), state: "reserved", outputPolicy: capture,
        requestDigest: providerRequestDigest(resolved), amountMicroUsd: gemini ? "1032192" : "770703" };
      allocation = { reservation, rateCard: frozenRate.snapshot, rateCardDigest: frozenRate.digest };
    } };
}

describe("captured provider completion allowance", () => {
  it.each([["kimi-digitalocean-v1", 235929, "770703"], ["gemini-flash-google-schema-v4", 65536, "1032192"]] as const)(
    "uses %s endpoint maximum in wire bytes, digest, reservation and saved proof", async (policy, maxTokens, amount) => {
      const h = harness(policy);
      await h.model.complete(h.request, new AbortController().signal);
      const body = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
      expect(body.max_tokens).toBe(maxTokens);
      if (policy !== "kimi-digitalocean-v1") expect(body.reasoning).toEqual({ exclude: true });
      const frozenRate = h.allocation();
      expect(h.budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountMicroUsd: amount, rateCardDigest: frozenRate.rateCardDigest }));
      expect(h.saved().result).toMatchObject({ outputResolution: { maxOutputTokens: maxTokens,
        endpointMaxOutputTokens: maxTokens, requestDigest: frozenRate.reservation.requestDigest,
        rateCardDigest: frozenRate.rateCardDigest, capture: h.request.budget.outputPolicy } });
      expect(body.plugins).toEqual([{ id: "context-compression", enabled: false }]);
      expect(frozenRate.rateCard).toMatchObject(h.rate.snapshot);
      expect(frozenRate.rateCard.promptAllowance).toMatchObject({ assessment: policy === "kimi-digitalocean-v1"
        ? { kind: "model-template-utf8-upper-bound", providerFraming: "unverified", serverToolContext: "not-requested" }
        : { kind: "unchecked-prompt-boundary", reason: "no-verified-local-tokenizer" } });
      expect(() => verifyProviderOutputEvidence({ capture: h.request.budget.outputPolicy, rateCard: frozenRate.rateCard,
        rateCardDigest: frozenRate.rateCardDigest, requestDigest: frozenRate.reservation.requestDigest, result: h.saved().result })).not.toThrow();
    });
  it("reserves two complete search inferences and the tool fee instead of the old 8192 allowance", async () => {
    const h = harness("kimi-digitalocean-v1", { search: true });
    await expect(h.model.complete(h.request, new AbortController().signal, { search: true })).rejects.toThrow();
    expect(JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body)).max_tokens).toBe(235929);
    expect(h.budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountMicroUsd: "1546406" }));
    expect(h.allocation().rateCard.promptAllowance).toMatchObject({ assessment: {
      countedScope: "application-messages", providerFraming: "unverified", serverToolContext: "unverified",
    } });
  });
  it("replays a saved completion without metadata and rejects changed resolution evidence", async () => {
    const h = harness(); await h.model.complete(h.request, new AbortController().signal);
    h.rateCards.current.mockRejectedValue(new Error("Metadata must not be read for replay"));
    expect((await h.model.complete(h.request, new AbortController().signal)).evidence.replayed).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.rateCards.current).toHaveBeenCalledTimes(1);
    const result = h.saved().result as { outputResolution: { maxOutputTokens: number } }; result.outputResolution.maxOutputTokens--;
    await expect(h.model.complete(h.request, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_output" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("resumes an undispatched reservation with its frozen allowance and snapshot", async () => {
    const h = harness(); h.seedReserved();
    h.rateCards.current.mockRejectedValue(new Error("Do not reprice an existing attempt"));
    await h.model.complete(h.request, new AbortController().signal);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body)).max_tokens).toBe(235929);
    expect(h.rateCards.current).not.toHaveBeenCalled();
  });
  it("preserves a context error and hold without trying a smaller output or another POST", async () => {
    const h = harness("kimi-digitalocean-v1", { httpError: true });
    await expect(h.model.complete(h.request, new AbortController().signal)).rejects.toThrow();
    await expect(h.model.complete(h.request, new AbortController().signal)).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.budget.releaseUnsent).not.toHaveBeenCalled();
    expect(h.allocation().reservation.state).toBe("unknown");
  });
  it("accepts the frozen usage allowance and halts on an actual overrun", async () => {
    const exact = harness("kimi-digitalocean-v1", { completionTokens: 235929 });
    await expect(exact.model.complete(exact.request, new AbortController().signal)).resolves.toBeDefined();
    const over = harness("kimi-digitalocean-v1", { completionTokens: 235930 });
    await expect(over.model.complete(over.request, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_output" });
    expect(over.budget.halt).toHaveBeenCalledWith("usage_bound_exceeded");
  });
  it("does not mistake SSE framing bytes for generated tokens", async () => {
    const h = harness("gemini-flash-google-schema-v4", { framing: true });
    await expect(h.model.complete(h.request, new AbortController().signal)).resolves.toMatchObject({ content: '{"answer":"ok"}' });
  });
  it("keeps complete input and output beyond the old JSON byte thresholds", async () => {
    const answer = "x".repeat(2 * 1024 * 1024 + 32), h = harness("gemini-flash-google-schema-v4", { content: JSON.stringify({ answer }) });
    h.request.untrustedInput = { completeMaterial: "y".repeat(300 * 1024) };
    const result = await h.model.generateStructured({ ...h.request, schema: z.object({ answer: z.string() }), schemaId: "answer", schemaVersion: 1 }, new AbortController().signal);
    expect(result.data.answer).toBe(answer);
    expect(JSON.parse(JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body)).messages[1].content).untrustedInput).toEqual(h.request.untrustedInput);
  });
  it("hashes complete structured replies beyond the old node/depth guards without changing legacy canonical bytes", async () => {
    const ordinary = { z: [2, 1], a: { message: "unchanged" } };
    expect(jsonDigest(ordinary)).toBe(digestBytes('{"a":{"message":"unchanged"},"z":[2,1]}'));
    let deep: unknown = "complete";
    for (let index = 0; index < 40; index++) deep = { child: deep };
    const reply = { items: Array.from({ length: 50010 }, (_, index) => index), deep };
    expect(() => canonicalJson(reply)).toThrow();
    expect(jsonDigest(reply)).toBe(digestBytes(canonicalJson(reply, Infinity)));
    expect(() => jsonDigest(reply, 256 * 1024)).toThrow();
    const h = harness("gemini-flash-google-schema-v4"); h.request.untrustedInput = JSON.parse(JSON.stringify(reply));
    await expect(h.model.complete(h.request, new AbortController().signal)).resolves.toBeDefined();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => jsonDigest(cyclic)).toThrow();
    expect(() => jsonDigest({ unsupported: undefined })).toThrow();
  });
  it("uses remaining Kimi model-template capacity while preserving the full input and endpoint funding bound", async () => {
    const h = harness(); h.request.untrustedInput = { completeMaterial: "Ж🧪".repeat(12000) };
    await h.model.complete(h.request, new AbortController().signal);
    const body = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
    const assessment = boundKimiApplicationPrompt(body.messages as ApplicationPromptMessages, false);
    expect(body.max_tokens).toBe(262144 - assessment.promptTokensUpperBound);
    expect(body.max_tokens).toBeLessThan(235929);
    expect(JSON.parse(body.messages[1].content).untrustedInput).toEqual(h.request.untrustedInput);
    expect(h.budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountMicroUsd: "770703" }));
    expect(h.allocation().rateCard.maxOutputTokens).toBe(235929);
    expect(h.allocation().rateCard.promptAllowance).toMatchObject({ assessment });
    h.rateCards.current.mockRejectedValue(new Error("Replay must use frozen endpoint metadata"));
    expect((await h.model.complete(h.request, new AbortController().signal)).evidence.replayed).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.request.untrustedInput = { completeMaterial: "changed" };
    await expect(h.model.complete(h.request, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_output" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("counts the complete canonical schema before Kimi dispatch and rejects changed schema on replay", async () => {
    const h = harness(), options = { schema: { type: "object", description: "schema".repeat(10000) }, schemaName: "example" };
    await h.model.complete(h.request, new AbortController().signal, options);
    const body = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
    expect(body.messages[0].content).toContain(canonicalJson(options.schema));
    expect(body.max_tokens).toBe(262144 - boundKimiApplicationPrompt(body.messages, false).promptTokensUpperBound);
    await expect(h.model.complete(h.request, new AbortController().signal,
      { ...options, schema: { type: "object", description: "changed" } })).rejects.toMatchObject({ code: "invalid_output" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a Kimi prompt without positive local capacity before reservation or inference without altering input", async () => {
    const h = harness(); h.request.untrustedInput = { completeMaterial: "x".repeat(262144) };
    const before = canonicalJson(h.request.untrustedInput, Infinity);
    await expect(h.model.complete(h.request, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_output" });
    expect(canonicalJson(h.request.untrustedInput, Infinity)).toBe(before);
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.budget.reserve).not.toHaveBeenCalled();
    expect(h.budget.claimDispatch).not.toHaveBeenCalled();
  });
  it("rejects altered prompt evidence against the frozen operation snapshot", async () => {
    const h = harness(); await h.model.complete(h.request, new AbortController().signal);
    const result = structuredClone(h.saved().result) as { outputResolution: { promptAllowance: { applicationPromptDigest: string } } };
    result.outputResolution.promptAllowance.applicationPromptDigest = "d".repeat(64);
    const frozen = h.allocation();
    expect(() => verifyProviderOutputEvidence({ capture: h.request.budget.outputPolicy, rateCard: frozen.rateCard,
      rateCardDigest: frozen.rateCardDigest, requestDigest: frozen.reservation.requestDigest, result })).toThrow("provider.invalid_output");
  });
  it("leaves unmarked paid requests and their replay bytes unchanged", async () => {
    const h = harness(); delete h.request.budget.outputPolicy;
    const originalBody = canonicalJson(buildProviderRequestBody(h.request));
    const originalDigest = providerRequestDigest(h.request);
    expect(buildProviderRequestBody(h.request)).not.toHaveProperty("plugins");
    expect(captureProviderOutputRateCard(h.request, h.rate)).toBe(h.rate);
    expect(bindProviderOutput(h.request, h.rate)).toBe(h.request);
    await h.model.complete(h.request, new AbortController().signal);
    expect(String(h.fetcher.mock.calls[0]![1]!.body)).toBe(originalBody);
    expect(h.allocation().reservation.requestDigest).toBe(originalDigest);
    expect(h.allocation().rateCard).toEqual(h.rate.snapshot);
    expect(h.saved().result).not.toHaveProperty("outputResolution");
    h.rateCards.current.mockRejectedValue(new Error("No metadata on legacy replay"));
    expect((await h.model.complete(h.request, new AbortController().signal)).evidence.replayed).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
});
