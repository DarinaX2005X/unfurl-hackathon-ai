import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { appendGenerationEvent } from "../../src/server/runs/events";
import { generationResultFacts, recordGenerationStepCompleted, recordGenerationStepStarted } from "../../src/server/runs/generation-timeline";
import type { GenerationEventPayload, JobClaim } from "../../src/server/runs/ports";
import { ids, timestamp } from "../domain/fixtures";

const runId = "70000000-0000-4000-8000-000000000001", stepId = "70000000-0000-4000-8000-000000000002";
const branchId = "70000000-0000-4000-8000-000000000003", digest = "a".repeat(64);
const target = { kind: "generation" as const, runId, ownerId: ids.actor, conversationId: ids.conversation, branchId,
  inputMessageId: ids.request, courseId: ids.course, approvalId: ids.approval, approvalDigest: digest, courseVersionId: ids.sample };
const claim = { jobId: ids.request, leaseOwner: ids.request, fencingToken: "1", retryEpoch: 1, target } satisfies JobClaim;
function harness() {
  const events: unknown[] = [];
  const state = { producer: true, modules: [ids.moduleA], seq: 0 };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("SELECT ARRAY")) return { rows: [{ module_ids: state.modules }] };
    if (sql.startsWith("SELECT s.id")) return { rows: state.producer ? [{ id: stepId }] : [] };
    if (sql.startsWith("SELECT event")) {
      const found = events.filter(item => {
        const event = item as Record<string, unknown>;
        return sql.includes("COALESCE") ? event.type === values[1] && (event.stepId ?? event.invocationId) === values[2]
          : event.type === "generation.action.started" && event.invocationId === values[1];
      });
      return { rows: found.map(event => ({ event })) };
    }
    if (sql.startsWith("UPDATE unfurl.generation_runs")) return { rows: [{ last_seq: ++state.seq, updated_at: timestamp }] };
    if (sql.startsWith("INSERT INTO unfurl.generation_events")) { events.push(JSON.parse(String(values[5]))); return { rows: [], rowCount: 1 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { state, events, query, tx: { query } as never };
}

describe("durable course conversation activity", () => {
  it("emits a real claimed stage once, then completes the same invocation with safe facts", async () => {
    const h = harness();
    await recordGenerationStepStarted(h.tx, claim, `course/${ids.moduleA}/research/read/source-private-id`, stepId);
    await recordGenerationStepStarted(h.tx, claim, `course/${ids.moduleA}/research/read/source-private-id`, stepId);
    await recordGenerationStepCompleted(h.tx, claim, stepId, { kind: "course.source.read", sourceId: ids.request, privateAnswer: "secret" });
    await recordGenerationStepCompleted(h.tx, claim, stepId, { kind: "course.source.read", sourceId: ids.request });
    expect(h.events).toHaveLength(2);
    expect(h.events[0]).toMatchObject({ type: "generation.action.started", invocationId: stepId, stage: "reading_sources", moduleId: ids.moduleA });
    expect(h.events[1]).toMatchObject({ type: "generation.action.completed", invocationId: stepId, result: { sourceCount: 1 } });
    expect(JSON.stringify(h.events)).not.toMatch(/privateAnswer|source-private-id|secret/);
  });
  it("cannot attach commentary to another run's producer or change a committed commentary", async () => {
    const h = harness(), payload: GenerationEventPayload = { type: "generation.commentary", text: "The sources cover arrays; I will now plan the exercises.", stepId };
    h.state.producer = false;
    await expect(appendGenerationEvent(h.tx, target, payload)).rejects.toThrow();
    expect(h.events).toEqual([]);
    h.state.producer = true;
    const first = await appendGenerationEvent(h.tx, target, payload);
    expect(await appendGenerationEvent(h.tx, target, payload)).toEqual(first);
    await expect(appendGenerationEvent(h.tx, target, { ...payload, text: "Changed text" })).rejects.toThrow();
    expect(h.events).toHaveLength(1);
  });
  it("does not invent activity for unknown modules, skipped policy steps or other execution kinds", async () => {
    const h = harness();
    await recordGenerationStepStarted(h.tx, claim, `course/${ids.missing}/research/read/hit`, stepId);
    await recordGenerationStepStarted(h.tx, claim, "course/generation-policy", stepId);
    await recordGenerationStepStarted(h.tx, { ...claim, target: { kind: "agent_turn", runId, ownerId: ids.actor, conversationId: ids.conversation,
      branchId, inputMessageId: ids.request } }, `course/${ids.moduleA}/research/read/hit`, stepId);
    expect(h.events).toEqual([]);
    expect(h.query.mock.calls).toHaveLength(1);
  });
  it("does not manufacture a past start when resuming an old operation", async () => {
    const h = harness();
    await recordGenerationStepCompleted(h.tx, claim, stepId, { kind: "course.source.read" });
    expect(h.events).toEqual([]);
  });
  it("projects counts only for explicit result kinds and never claims skipped reads or rejected tasks", () => {
    expect(generationResultFacts({ kind: "course.source.read.skipped", sourceId: ids.request })).toEqual({});
    expect(generationResultFacts({ kind: "course.source.unavailable", reason: "too_large" })).toEqual({ outcome: "unavailable" });
    expect(generationResultFacts({ kind: "course.task.rejected", tasks: ["private"] })).toEqual({ outcome: "needs_revision" });
    expect(generationResultFacts({ kind: "course.module.plan.page.bounded.v1", proposal: { lessons: [{ title: "private" }], tasks: [{ answer: 7 }, { answer: 8 }] } }))
      .toEqual({ lessonCount: 1, taskCount: 2 });
  });
  it("shows actual search queries and public hits without exposing snippets or operation metadata", async () => {
    const h = harness(), input = { query: "NumPy matrix multiplication", language: "en", limit: 5 };
    await recordGenerationStepStarted(h.tx, claim, `course/${ids.moduleA}/research/search/numpy`, stepId, input);
    await recordGenerationStepCompleted(h.tx, claim, stepId, { id: ids.sample, operationId: ids.request,
      provider: "openrouter:parallel", providerRequestId: "private-provider-id", requestedQuery: input.query, executedQuery: null,
      contentLanguage: "en", retrievedAt: timestamp, hits: [{ id: ids.source, title: "NumPy matmul", url: "https://numpy.org/doc/matmul",
        snippet: "private discovery text", publishedAt: null }], limitations: [], requestDigest: digest }, input);
    expect(h.events[0]).toMatchObject({ action: "search", details: { query: input.query } });
    expect(h.events[1]).toMatchObject({ action: "search", details: { candidateCount: 1, sources: [{ title: "NumPy matmul", url: "https://numpy.org/doc/matmul" }] } });
    expect(JSON.stringify(h.events)).not.toMatch(/private-provider-id|private discovery text|requestDigest/);
  });
  it("uses the actually read source title and URL while keeping its body private", async () => {
    const h = harness(), input = { url: "https://numpy.org/doc/matmul" };
    await recordGenerationStepStarted(h.tx, claim, `course/${ids.moduleA}/research/read/hit`, stepId, input);
    await recordGenerationStepCompleted(h.tx, claim, stepId, { kind: "course.source.read" }, input, { status: "success", document: {
      id: ids.source, requestedUrl: input.url, finalUrl: input.url, title: "numpy.matmul", retrievedAt: timestamp, publishedAt: null,
      mediaType: "text/html", rawDigest: digest, contentDigest: digest, extractorVersion: "test-v1", extractionState: "complete",
      blocks: [{ id: "source-block", text: "Private full source body" }],
    } });
    expect(h.events[1]).toMatchObject({ action: "read_source", details: { source: { title: "numpy.matmul", url: input.url }, sourceCount: 1 } });
    expect(JSON.stringify(h.events)).not.toMatch(/source-block|Private full source body|extractorVersion/);
  });
});
