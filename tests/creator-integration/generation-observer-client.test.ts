import { describe, expect, it, vi } from "vitest";
import type { GenerationSnapshot } from "../../src/domain/generation-observer";
import { cancelGenerationRun, getGenerationSnapshot, readGenerationEvents, retryGenerationRun } from "../../src/features/creator/generation-observer-client";
import { ids, timestamp } from "../domain/fixtures";

const runId = "70000000-0000-4000-8000-000000000001";
const branchId = "70000000-0000-4000-8000-000000000002";
const digest = "a".repeat(64);
function snapshot(status: "running" | "cancelled" = "running"): GenerationSnapshot {
  return {
    run: { id: runId, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation, branchId,
      inputMessageId: ids.request, sourceDraftRevision: 1, approvalId: ids.approval, phase: "building_tasks",
      status, lastSeq: 1, outputVersionId: null, error: null, createdAt: timestamp, updatedAt: timestamp },
    approvedDraftRevision: 1, approvalDigest: digest,
    modules: [{ moduleId: ids.moduleA, title: "Foundations", status: "building", completedTasks: 0 }],
    work: { completed: 0, total: 1 }, validation: null, readyVersionId: null, lastSeq: 1,
  };
}

describe("generation observer transport", () => {
  it("reads only a wrapped authoritative snapshot for the requested run", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: snapshot() }), { status: 200 })) as unknown as typeof fetch;
    await expect(getGenerationSnapshot(runId, new AbortController().signal, fetcher)).resolves.toEqual(snapshot());
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/generation-runs/${runId}`, expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("parses fragmented SSE events, advances by exact sequence, and exposes snapshot repair", async () => {
    const event = { id: "70000000-0000-4000-8000-000000000003", runId, courseId: ids.course, branchId, seq: 2,
      at: timestamp, type: "generation.phase.changed", phase: "validating" };
    const bytes = new TextEncoder().encode(`id: 2\nevent: generation.event\ndata: ${JSON.stringify(event)}\n\nevent: snapshot.required\ndata: {}\n\n`);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 31)); controller.enqueue(bytes.slice(31)); controller.close(); } });
    const fetcher = vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
    const events: unknown[] = []; let repair = false;
    await expect(readGenerationEvents(runId, 1, new AbortController().signal, { onEvent: (value) => events.push(value), onSnapshotRequired: () => { repair = true; } }, fetcher)).resolves.toBe(2);
    expect(events).toEqual([event]);
    expect(repair).toBe(true);
  });

  it("cancels with an exact empty command and returns the persisted snapshot", async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(init).toMatchObject({ method: "POST", body: "{}", credentials: "same-origin" });
      return new Response(JSON.stringify({ data: snapshot("cancelled") }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(cancelGenerationRun(runId, new AbortController().signal, fetcher)).resolves.toMatchObject({ run: { status: "cancelled" } });
  });

  it("requests an authoritative snapshot when the SSE identity disagrees with its event", async () => {
    const event = { id: "70000000-0000-4000-8000-000000000004", runId, courseId: ids.course, branchId, seq: 2,
      at: timestamp, type: "generation.phase.changed", phase: "validating" };
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`id: 9\nevent: generation.event\ndata: ${JSON.stringify(event)}\n\n`)); controller.close(); } });
    const events: unknown[] = []; let repair = false;
    const cursor = await readGenerationEvents(runId, 1, new AbortController().signal, { onEvent: (value) => events.push(value), onSnapshotRequired: () => { repair = true; } }, async () => new Response(body));
    expect(cursor).toBe(1);
    expect(events).toEqual([]);
    expect(repair).toBe(true);
  });

  it("retries with a stable command identity and accepts only a new persisted run", async () => {
    const nextRunId = "70000000-0000-4000-8000-000000000005";
    const retried = { ...snapshot(), run: { ...snapshot().run, id: nextRunId } };
    const fetcher = vi.fn(async (_url, init) => {
      expect(init).toMatchObject({ method: "POST", body: "{}", headers: expect.objectContaining({ "Idempotency-Key": ids.request }) });
      return new Response(JSON.stringify({ data: retried }), { status: 202 });
    }) as unknown as typeof fetch;
    await expect(retryGenerationRun(runId, ids.request, new AbortController().signal, fetcher)).resolves.toMatchObject({ run: { id: nextRunId } });
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/generation-runs/${runId}/retry`, expect.anything());
  });
});
