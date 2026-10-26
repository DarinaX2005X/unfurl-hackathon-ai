import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationBuild, ConversationDetail } from "../../src/domain/conversations";
import type { GenerationSnapshot, GenerationTimelineEvent } from "../../src/domain/generation-observer";
import { ConversationBuilds, type BuildTransport } from "../../src/features/creator/conversation-builds";
import { buildTimeline } from "../../src/features/creator/build-timeline";
import type { GenerationEventHandlers } from "../../src/features/creator/generation-observer-client";
import { ids, timestamp } from "../domain/fixtures";

const later = (n: number) => new Date(Date.parse(timestamp) + n * 1000).toISOString();
function saved(runId = ids.request as string, courseId = ids.course as string, approvalId = ids.approval as string): GenerationSnapshot {
  return { run: { id: runId, ownerId: ids.actor, courseId, conversationId: ids.conversation, branchId: ids.sample,
    inputMessageId: ids.task, sourceDraftRevision: 1, approvalId, phase: "module_research", status: "running", lastSeq: 1,
    outputVersionId: null, error: null, createdAt: timestamp, updatedAt: timestamp }, approvedDraftRevision: 1, approvalDigest: "a".repeat(64),
  modules: [{ moduleId: ids.moduleA, title: "Core concepts", status: "researching", completedTasks: 0 }],
  work: { completed: 0, total: 20 }, validation: null, readyVersionId: null, lastSeq: 1,
  retainedTimelineEvents: [], timelineBeforeSeq: null, readyCourse: null };
}
function build(snapshot = saved()): ConversationBuild {
  return { approvalId: snapshot.run.approvalId!, draftId: ids.draft, draftRevision: 1, approvalDigest: snapshot.approvalDigest,
    approvedAt: timestamp, courseId: snapshot.run.courseId!, branchId: ids.sample, title: "Understanding AI", summary: "Build models and AI systems.",
    contentLanguage: "en", initialRunId: snapshot.run.id, runs: [{ retryOfRunId: null, snapshot }] };
}
function detail(builds: ConversationBuild[]): ConversationDetail {
  return { conversation: { id: ids.conversation, ownerId: ids.actor, title: "AI course", activeBranchId: ids.sample,
    revision: 1, createdAt: timestamp, updatedAt: timestamp }, messages: [], activeTurn: null, artifacts: [],
  composerDraft: { conversationId: ids.conversation, revision: 1, text: "", pendingMessages: [], updatedAt: timestamp }, builds };
}
function commentary(seq: number, runId = ids.request as string): GenerationTimelineEvent {
  return { type: "generation.commentary", id: crypto.randomUUID(), runId, courseId: ids.course, branchId: ids.sample,
    seq, at: later(seq), stepId: crypto.randomUUID(), text: "The section now connects the core concepts to practical work." };
}
function terminal(snapshot: GenerationSnapshot, status: "failed" | "cancelled" = "failed"): GenerationSnapshot {
  return { ...snapshot, run: { ...snapshot.run, status, lastSeq: 3, updatedAt: later(3),
    error: status === "failed" ? { code: "generation_failed", messageKey: "generation.invalidResponse", retryable: false, requestId: ids.request } : null }, lastSeq: 3 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const controllers: ConversationBuilds[] = [];
function harness(values = [build()]) {
  let current = detail(values);
  const connections = new Map<string, { signal: AbortSignal; handlers: GenerationEventHandlers }>();
  const transport: BuildTransport = {
    detail: vi.fn(async () => ({ ok: true as const, data: structuredClone(current) })),
    snapshot: vi.fn(async (id) => current.builds!.flatMap(build => build.runs).find(run => run.snapshot.run.id === id)!.snapshot),
    events: vi.fn((id, _after, signal, handlers) => { connections.set(id, { signal, handlers }); return new Promise<number>(resolve => signal.addEventListener("abort", () => resolve(0), { once: true })); }),
    cancel: vi.fn(async (id) => terminal(current.builds!.flatMap(build => build.runs).find(run => run.snapshot.run.id === id)!.snapshot, "cancelled")),
    retry: vi.fn(), history: vi.fn(),
  };
  const controller = new ConversationBuilds({ actorId: ids.actor, conversationId: ids.conversation, branchId: ids.sample }, transport);
  controllers.push(controller);
  return { controller, transport, connections, get current() { return current; }, set current(value) { current = value; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()); vi.useRealTimers(); });

describe("conversation-owned course builds", () => {
  it("observes two active courses independently and never needs panel selection", async () => {
    const second = saved(ids.evaluation, ids.missing, ids.question);
    const h = harness([build(), build(second)]); await h.controller.start();
    expect([...h.connections.keys()]).toEqual([ids.request, ids.evaluation]);
    h.connections.get(ids.request)!.handlers.onEvent(commentary(2));
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.events).toHaveLength(1);
    expect(h.controller.getSnapshot().builds[1]!.runs[0]!.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.transport.snapshot).toHaveBeenCalledTimes(2);
  });
  it("keeps cancellation terminal after a delayed active poll and stops polling", async () => {
    const h = harness(), pending = deferred<GenerationSnapshot>();
    vi.mocked(h.transport.snapshot).mockImplementationOnce(() => pending.promise);
    await h.controller.start(); await vi.advanceTimersByTimeAsync(8000);
    await h.controller.command(ids.approval, "cancel");
    pending.resolve(saved()); await Promise.resolve();
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.stream.run.status).toBe("cancelled");
    expect(h.connections.get(ids.request)!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(32000);
    expect(h.transport.snapshot).toHaveBeenCalledTimes(1);
  });
  it("keeps one approval across retry and ignores old callbacks and stale detail", async () => {
    const first = terminal(saved()); first.retainedTimelineEvents = [commentary(2)];
    const h = harness([build(first)]); await h.controller.start();
    const next = saved(ids.evaluation); next.run.createdAt = later(10); next.run.updatedAt = later(10);
    vi.mocked(h.transport.retry).mockResolvedValue(next);
    await h.controller.command(ids.approval, "retry"); await h.controller.refresh();
    const current = h.controller.getSnapshot().builds[0]!;
    expect(current.runs.map(run => run.stream.run.id)).toEqual([ids.request, ids.evaluation]);
    expect(current.runs[0]!.events).toHaveLength(1);
    expect(buildTimeline([current]).filter(item => item.kind === "build_approval")).toHaveLength(1);
    expect(h.connections.has(ids.evaluation)).toBe(true);
    const wrong = { ...commentary(2), courseId: ids.missing };
    h.connections.get(ids.evaluation)!.handlers.onEvent(wrong);
    expect(h.controller.getSnapshot().builds[0]!.runs[1]!.events).toHaveLength(0);
  });
  it("starts a fresh detail read after approval commits instead of reusing the pre-approval response", async () => {
    const h = harness([]), old = deferred<Awaited<ReturnType<BuildTransport["detail"]>>>();
    vi.mocked(h.transport.detail).mockImplementationOnce(() => old.promise);
    const opening = h.controller.start();
    h.current = detail([build()]);
    const afterApproval = h.controller.refreshAfterMutation();
    old.resolve({ ok: true, data: detail([]) });
    await Promise.all([opening, afterApproval]);
    expect(h.transport.detail).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot().builds[0]!.approvalId).toBe(ids.approval);
    expect(h.connections.has(ids.request)).toBe(true);
  });
  it("reuses the same retry identity after an unconfirmed request", async () => {
    const h = harness([build(terminal(saved()))]); await h.controller.start();
    vi.mocked(h.transport.retry).mockRejectedValue(new Error("offline"));
    await h.controller.command(ids.approval, "retry"); await h.controller.command(ids.approval, "retry");
    expect(vi.mocked(h.transport.retry).mock.calls[0]![1]).toBe(vi.mocked(h.transport.retry).mock.calls[1]![1]);
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.commandError).toBe(true);
  });
  it("retains earlier paged events when a newer snapshot refreshes the recent window", async () => {
    const snapshot = terminal(saved()); snapshot.lastSeq = 20; snapshot.run.lastSeq = 20;
    snapshot.retainedTimelineEvents = [commentary(18)]; snapshot.timelineBeforeSeq = 18;
    const h = harness([build(snapshot)]); await h.controller.start();
    vi.mocked(h.transport.history).mockResolvedValue({ runId: ids.request, courseId: ids.course, branchId: ids.sample, items: [commentary(2)], beforeSeq: null });
    await h.controller.earlier(ids.request); await h.controller.refresh();
    const run = h.controller.getSnapshot().builds[0]!.runs[0]!;
    expect(run.events.map(event => event.seq)).toEqual([2, 18]); expect(run.beforeSeq).toBeNull();
  });
  it("does not publish a late response after account/branch disposal, and can restart cleanly in StrictMode", async () => {
    const h = harness(), old = deferred<Awaited<ReturnType<BuildTransport["detail"]>>>();
    vi.mocked(h.transport.detail).mockImplementationOnce(() => old.promise);
    const opening = h.controller.start(); h.controller.stop(); await h.controller.start();
    expect(h.controller.getSnapshot().builds).toHaveLength(1);
    old.resolve({ ok: true, data: detail([build(saved(ids.evaluation))]) }); await opening;
    expect(h.controller.getSnapshot().builds[0]!.initialRunId).toBe(ids.request);
  });
  it("reopens paging for a missing middle after a long disconnect even when old history was exhausted", async () => {
    const snapshot = saved(); snapshot.lastSeq = 20; snapshot.run.lastSeq = 20;
    snapshot.retainedTimelineEvents = [commentary(18)]; snapshot.timelineBeforeSeq = 18;
    const h = harness([build(snapshot)]); await h.controller.start();
    vi.mocked(h.transport.history).mockResolvedValue({ runId: ids.request, courseId: ids.course, branchId: ids.sample, items: [commentary(2)], beforeSeq: null });
    await h.controller.earlier(ids.request);
    const advanced = { ...snapshot, run: { ...snapshot.run, lastSeq: 150, updatedAt: later(150) }, lastSeq: 150,
      retainedTimelineEvents: [commentary(140)], timelineBeforeSeq: 140 };
    h.current = detail([build(advanced)]); await h.controller.refresh();
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.beforeSeq).toBe(140);
    vi.mocked(h.transport.history).mockResolvedValue({ runId: ids.request, courseId: ids.course, branchId: ids.sample, items: [commentary(30), commentary(100)], beforeSeq: 30 });
    await h.controller.earlier(ids.request);
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.events.map(event => event.seq)).toEqual([2, 18, 30, 100, 140]);
  });
  it("hydrates the exact ready metadata after the terminal SSE event at the same sequence", async () => {
    const h = harness(); await h.controller.start();
    const ready = saved(); ready.run = { ...ready.run, status: "succeeded", outputVersionId: ids.question, lastSeq: 2, updatedAt: later(2) };
    ready.lastSeq = 2; ready.readyVersionId = ids.question;
    ready.readyCourse = { courseId: ids.course, courseVersionId: ids.question, title: "Understanding AI", summary: "A real saved course", contentLanguage: "en", moduleCount: 2, lessonCount: 6 };
    h.current = detail([build(ready)]);
    h.connections.get(ids.request)!.handlers.onEvent({ id: crypto.randomUUID(), runId: ids.request, courseId: ids.course, branchId: ids.sample,
      seq: 2, at: later(2), type: "generation.succeeded", courseVersionId: ids.question });
    await h.controller.refresh();
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.readyCourse).toEqual(ready.readyCourse);
    expect(h.connections.get(ids.request)!.signal.aborted).toBe(true);
  });
  it("does not let an older in-flight history page erase a newly detected reconnect gap", async () => {
    const snapshot = saved(); snapshot.lastSeq = 20; snapshot.run.lastSeq = 20;
    snapshot.retainedTimelineEvents = [commentary(18)]; snapshot.timelineBeforeSeq = 18;
    const h = harness([build(snapshot)]); await h.controller.start();
    const oldPage = deferred<Awaited<ReturnType<BuildTransport["history"]>>>();
    vi.mocked(h.transport.history).mockImplementationOnce(() => oldPage.promise);
    const loading = h.controller.earlier(ids.request);
    h.current = detail([build({ ...snapshot, run: { ...snapshot.run, lastSeq: 150, updatedAt: later(150) }, lastSeq: 150,
      retainedTimelineEvents: [commentary(140)], timelineBeforeSeq: 140 })]);
    await h.controller.refresh();
    oldPage.resolve({ runId: ids.request, courseId: ids.course, branchId: ids.sample, items: [commentary(2)], beforeSeq: null });
    await loading;
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.beforeSeq).toBe(140);
    expect(h.controller.getSnapshot().builds[0]!.runs[0]!.events.map(event => event.seq)).toEqual([2, 18, 140]);
  });
  it("keeps the historical approval when the current draft is edited", async () => {
    const h = harness([build(terminal(saved()))]); await h.controller.start();
    h.current = { ...h.current, builds: [] }; await h.controller.refresh();
    expect(h.controller.getSnapshot().builds[0]!.approvalId).toBe(ids.approval);
  });
  it("interleaves real commentary between action groups rather than presenting a synthetic assistant reply", async () => {
    const snapshot = terminal(saved()), first = commentary(2), second = commentary(5);
    const action = { id: ids.source, runId: ids.request, courseId: ids.course, branchId: ids.sample, at: later(3), seq: 3,
      type: "generation.action.started" as const, invocationId: ids.attempt, stage: "planning_lessons" as const };
    snapshot.retainedTimelineEvents = [first, action, { ...action, id: ids.outcomeA, seq: 4, at: later(4), type: "generation.action.completed", result: {} }, second];
    snapshot.lastSeq = 6; snapshot.run.lastSeq = 6; snapshot.run.updatedAt = later(6);
    const h = harness([build(snapshot)]); await h.controller.start();
    const items = buildTimeline(h.controller.getSnapshot().builds);
    expect(items.map(item => item.kind)).toEqual(["build_approval", "build_commentary", "build_actions", "build_commentary", "build_status"]);
  });
});
