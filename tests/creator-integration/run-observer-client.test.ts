import { describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "../../src/domain/generation";
import { cancelRun, getRunSnapshot, readRunEvents, retryRun } from "../../src/features/creator/run-observer-client";
import { ids, timestamp } from "../domain/fixtures";

const runId = "80000000-0000-4000-8000-000000000001";
const nextRunId = "80000000-0000-4000-8000-000000000002";
const branchId = "80000000-0000-4000-8000-000000000003";
function snapshot(id = runId): RunSnapshot { return { run: { id, ownerId: ids.actor, conversationId: ids.conversation, branchId,
  inputMessageId: ids.request, status: "running", lastSeq: 1, error: null, createdAt: timestamp, updatedAt: timestamp },
  messages: [], artifacts: [], lastSeq: 1, retainedActionEvents: [] }; }

describe("agent run observer transport", () => {
  it("loads and cancels only the requested authoritative run", async () => {
    const get = vi.fn(async () => new Response(JSON.stringify({ data: snapshot() }), { status: 200 })) as unknown as typeof fetch;
    await expect(getRunSnapshot(runId, new AbortController().signal, get)).resolves.toEqual(snapshot());
    const cancel = vi.fn(async (_url, init) => { expect(init).toMatchObject({ method: "POST", body: "{}" }); return new Response(JSON.stringify({ data: snapshot() }), { status: 200 }); }) as unknown as typeof fetch;
    await expect(cancelRun(runId, new AbortController().signal, cancel)).resolves.toEqual(snapshot());
  });

  it.each([runId, nextRunId])("retries with a stable command identity and accepts an authoritative same-run or successor receipt", async (returnedRunId) => {
    const fetcher = vi.fn(async (_url, init) => { expect(init).toMatchObject({ headers: expect.objectContaining({ "Idempotency-Key": ids.request }), body: "{}" }); return new Response(JSON.stringify({ data: snapshot(returnedRunId) }), { status: 202 }); }) as unknown as typeof fetch;
    await expect(retryRun(runId, ids.request, new AbortController().signal, fetcher)).resolves.toMatchObject({ run: { id: returnedRunId } });
  });

  it("parses fragmented events and turns a mismatched SSE id into snapshot repair", async () => {
    const event = { id: "80000000-0000-4000-8000-000000000004", runId, branchId, seq: 2, at: timestamp, type: "run.completed" };
    const payload = new TextEncoder().encode(`id: 2\nevent: run.event\ndata: ${JSON.stringify(event)}\n\nid: 9\nevent: run.event\ndata: ${JSON.stringify({ ...event, id: ids.missing, seq: 3 })}\n\n`);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload.slice(0, 21)); controller.enqueue(payload.slice(21)); controller.close(); } });
    const events: unknown[] = []; let repair = false;
    const cursor = await readRunEvents(runId, 1, new AbortController().signal, { onEvent: (value) => events.push(value), onSnapshotRequired: () => { repair = true; } }, async () => new Response(body));
    expect(cursor).toBe(2); expect(events).toEqual([event]); expect(repair).toBe(true);
  });
});
