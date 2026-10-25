import { describe, expect, it, vi } from "vitest";
import { createHttpLearning } from "@/application/http-learning";
import type { ActivityState } from "@/application/learning-port";

const state = (): ActivityState => ({ activity: { id: crypto.randomUUID(), enrollmentId: crypto.randomUUID(), taskId: crypto.randomUUID(), taskVersion: 1,
  revision: 1, inputRevision: 0, status: "active", remainingActions: 6, events: [] }, savedInput: null });

describe("learning transport", () => {
  it("uses stable caller idempotency and no-store same-origin requests across retries", async () => {
    const value = state(), key = crypto.randomUUID();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("failure", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: value }));
    const http = createHttpLearning(fetcher);
    const body = { taskId: value.activity.taskId, taskVersion: 1 };
    expect((await http.startActivity(value.activity.enrollmentId, body, { idempotencyKey: key })).ok).toBe(false);
    expect((await http.startActivity(value.activity.enrollmentId, body, { idempotencyKey: key })).ok).toBe(true);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) });
    }
  });
  it("rejects forged identity, foreign response scope, stale input joins and unexpected private fields", async () => {
    const value = state();
    const fetcher = vi.fn<typeof fetch>();
    const http = createHttpLearning(fetcher);
    expect((await http.getActivity("../other")).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    for (const data of [
      { ...value, activity: { ...value.activity, id: crypto.randomUUID() } },
      { ...value, activity: { ...value.activity, inputRevision: 1 } },
      { ...value, privateData: { answer: 42 } },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json({ data }));
      expect((await http.getActivity(value.activity.id)).ok).toBe(false);
    }
  });
  it("never converts account cancellation into an ordinary unavailable result", async () => {
    const abort = new AbortController();
    const value = state();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { abort.abort(); return Response.json({ data: value }); });
    await expect(createHttpLearning(fetcher).getActivity(value.activity.id, abort.signal)).rejects.toThrow();
  });
  it("GET has no idempotency mutation body, feedback acknowledgement is an explicit POST", async () => {
    const value = state(), attemptId = crypto.randomUUID();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: value }))
      .mockResolvedValueOnce(Response.json({ data: { attemptId, evaluationRevision: 2, acknowledgedAt: "2026-10-25T00:00:00Z" } }));
    const http = createHttpLearning(fetcher);
    await http.getActivity(value.activity.id);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET" });
    expect(fetcher.mock.calls[0]![1]?.body).toBeUndefined();
    const result = await http.acknowledgeFeedback(attemptId, { expectedEvaluationRevision: 2 }, { idempotencyKey: crypto.randomUUID() });
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[1]![0]).toBe(`/api/v1/attempts/${attemptId}/feedback-acknowledgements`);
    expect(fetcher.mock.calls[1]![1]?.method).toBe("POST");
  });
});
