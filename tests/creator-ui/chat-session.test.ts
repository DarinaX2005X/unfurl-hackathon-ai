import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../../src/features/creator/chat-session";
import { createChatRecovery } from "../../src/features/creator/chat-recovery";
import { AccountScope } from "../../src/features/account/account-scope";
import type { ConversationPort } from "../../src/application/conversation-port";
import type { ApplicationPort, SendMessageInput, SendMessageResult, ServiceResult } from "../../src/application/ports";
import type { ConversationDetail } from "../../src/domain/conversations";
import type { CourseArtifactRef } from "../../src/domain/chat";
import type { ActionEvent, RunSnapshot } from "../../src/domain/generation";
import { localApplication } from "../../src/application/local-adapter";
import { curriculumDigest } from "../../src/domain/course";
import { canApproveCurriculum } from "../../src/features/creator/stream";
import { curriculum, ids, timestamp } from "../domain/fixtures";

const branchId = "20000000-0000-4000-8000-000000000002";
const runId = "20000000-0000-4000-8000-000000000003";
const allSessions: ChatSession[] = [];
afterEach(() => { for (const session of allSessions.splice(0)) session.dispose(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function detail(text = ""): ConversationDetail {
  return { conversation: { id: ids.conversation, ownerId: ids.actor, title: "A learning question", activeBranchId: branchId, revision: 1, createdAt: timestamp, updatedAt: timestamp },
    messages: [], artifacts: [], activeTurn: null, composerDraft: { conversationId: ids.conversation, revision: 1, text, pendingMessages: [], updatedAt: timestamp } };
}
const ok = <T,>(data: T): ServiceResult<T> => ({ ok: true, data: structuredClone(data) });
const conflict = (): Extract<ServiceResult<never>, { ok: false }> => ({ ok: false, error: { error: { code: "revision_conflict", messageKey: "chat.changed", retryable: false, requestId: ids.request } } });
function cloud(initial?: ConversationDetail) {
  const records = new Map(initial ? [[initial.conversation.id, structuredClone(initial)]] : []);
  const receipts = new Map<string, unknown>();
  const port: ConversationPort = {
    list: vi.fn(async () => ok({ items: [...records.values()].map((item) => item.conversation), nextCursor: null })),
    get: vi.fn<ConversationPort["get"]>(async (id) => records.has(id) ? ok(records.get(id)!) : { ok: false, error: { error: { code: "not_found", messageKey: "chat.notFound", retryable: false, requestId: ids.request } } }),
    getActions: vi.fn<ConversationPort["getActions"]>(async (id) => records.has(id) ? ok({ conversationId: id, branchId: records.get(id)!.conversation.activeBranchId, items: [], nextCursor: null })
      : { ok: false, error: { error: { code: "not_found", messageKey: "chat.notFound", retryable: false, requestId: ids.request } } }),
    create: vi.fn(async (input, key) => {
      if (receipts.has(key)) return ok(receipts.get(key) as ConversationDetail);
      const value = detail(input.composerText); records.set(ids.conversation, value); receipts.set(key, value); return ok(value);
    }),
    saveComposer: vi.fn(async (id, input, key) => {
      if (receipts.has(key)) return ok(receipts.get(key) as ConversationDetail["composerDraft"]);
      const value = records.get(id)!;
      if (input.expectedRevision !== value.composerDraft.revision) return conflict();
      value.composerDraft = { conversationId: id, revision: input.expectedRevision + 1, text: input.text, pendingMessages: structuredClone(input.pendingMessages), updatedAt: timestamp };
      receipts.set(key, structuredClone(value.composerDraft)); return ok(value.composerDraft);
    }),
    rename: vi.fn(async (id, input) => {
      const value = records.get(id)!;
      if (input.expectedRevision !== value.conversation.revision) return conflict();
      value.conversation = { ...value.conversation, revision: input.expectedRevision + 1, title: input.title }; return ok(value.conversation);
    }),
    remove: vi.fn(async (id) => { records.delete(id); return ok(null); }),
    importLocal: vi.fn(async () => { throw new Error("Import is not part of the session"); }),
  };
  return { port, records };
}
function sessionFor(port: ConversationPort, services: ApplicationPort = localApplication, id: string | null = null, recovery = createChatRecovery(), scope = new AccountScope()) {
  scope.replaceActor(ids.actor);
  const session = new ChatSession(port, services, id, { actorId: ids.actor, scope, now: () => timestamp, userLocale: () => "en", recovery, autosaveDelay: 60_000 });
  allSessions.push(session); return session;
}
function accepted(input: SendMessageInput, currentRunId = runId): SendMessageResult {
  return { message: { id: input.messageId, conversationId: input.conversationId, branchId: input.branchId, parentMessageId: input.parentMessageId, role: "user", status: "complete",
    parts: [{ type: "text", text: input.text }], clientRequestId: input.requestId, createdAt: timestamp },
    run: { id: currentRunId, conversationId: input.conversationId, branchId: input.branchId, inputMessageId: input.messageId, ownerId: ids.actor, status: "queued", lastSeq: 1, error: null, createdAt: timestamp, updatedAt: timestamp } };
}
function artifact(courseId: string = ids.course): CourseArtifactRef {
  const draft = { ...curriculum(), courseId, id: courseId === ids.course ? ids.draft : ids.missing };
  return { courseId, title: draft.title, summary: draft.goal, contentLanguage: "en", revision: 1, curriculum: draft, approval: null, approvalRequestedRevision: 1, readyVersionId: null, updatedAt: timestamp };
}
function action(run: string, seq: number, invocation: string, at = timestamp): ActionEvent {
  return { id: `90000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, runId: run, branchId, seq, at,
    type: "action.started", invocationId: invocation, action: "search", labelKey: "generation.search" };
}

describe("account-owned chat input", () => {
  it("keeps a newer new-chat recovery buffer when an older session finishes creating its chat", async () => {
    const { port } = cloud();
    const saved = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } });
    const recovery = createChatRecovery(storage);
    const create = port.create; const gate = deferred<void>();
    port.create = vi.fn<ConversationPort["create"]>(async (...args) => { await gate.promise; return create(...args); });
    const original = sessionFor(port, localApplication, null, recovery);
    original.setComposer("Submit this first question"); const sending = original.send();
    const newer = sessionFor(port, localApplication, null, recovery);
    await newer.open(); newer.setComposer("Keep this newer unsent draft");
    gate.resolve(); await sending;
    // A fresh recovery adapter reads persisted input, without a clean pagehide/unmount flush.
    const restored = sessionFor(port, localApplication, null, createChatRecovery(storage));
    await restored.open();
    expect(restored.getSnapshot()).toMatchObject({ composerText: "Keep this newer unsent draft", conversation: null });
    expect(port.create).toHaveBeenCalledOnce();
  });

  it("restores an unsent new draft locally without assigning a chat title or identity", async () => {
    const { port, records } = cloud();
    const saved = new Map<string, string>(); const recovery = createChatRecovery(() => ({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: (key) => { saved.delete(key); } }));
    const original = sessionFor(port, localApplication, null, recovery);
    original.setComposer("An unfinished question"); await original.flush(); original.dispose();
    const restored = sessionFor(port, localApplication, null, recovery); await restored.open(); await restored.flush();
    expect(restored.getSnapshot()).toMatchObject({ composerText: "An unfinished question", conversation: null, saveStatus: "idle" });
    expect(port.create).not.toHaveBeenCalled(); expect(port.saveComposer).not.toHaveBeenCalled(); expect(records.size).toBe(0);
  });

  it("continues debounced autosave for an existing chat without renaming or recreating it", async () => {
    vi.useFakeTimers();
    const { port, records } = cloud(detail()); const session = sessionFor(port, localApplication, ids.conversation);
    await session.open(); session.setComposer("A draft reply"); await vi.advanceTimersByTimeAsync(60_001);
    expect(records.get(ids.conversation)?.composerDraft.text).toBe("A draft reply");
    expect(records.get(ids.conversation)?.conversation.title).toBe("A learning question");
    expect(port.saveComposer).toHaveBeenCalledOnce(); expect(port.create).not.toHaveBeenCalled(); expect(port.rename).not.toHaveBeenCalled();
    expect(session.getSnapshot().saveStatus).toBe("saved");
  });

  it("keeps a new chat local through typing, debounce and navigation flush until Send", async () => {
    vi.useFakeTimers();
    const { port, records } = cloud();
    const services = { ...localApplication, sendMessage: vi.fn(localApplication.sendMessage) };
    const session = sessionFor(port, services);
    await session.open(); await session.flush();
    session.setComposer("   "); await session.flush();
    session.setComposer("First question");
    await vi.advanceTimersByTimeAsync(60_001); await session.flush();
    expect(port.create).not.toHaveBeenCalled();
    expect(port.saveComposer).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ conversation: null, composerText: "First question", saveStatus: "idle" });
    const create = port.create;
    const gate = deferred<void>();
    port.create = vi.fn<ConversationPort["create"]>(async (...args) => { await gate.promise; return create(...args); });
    const sending = session.send();
    session.setComposer("First question with a later edit");
    expect(session.getSnapshot().saveStatus).toBe("saving");
    gate.resolve(); await sending;
    expect(records.get(ids.conversation)?.composerDraft.text).toBe("First question with a later edit");
    expect(session.getSnapshot().saveStatus).toBe("saved");
    expect(port.create).toHaveBeenCalledOnce();
    expect(services.sendMessage.mock.calls[0]![0].text).toBe("First question");
  });

  it("replays a lost create acknowledgement only on Send with its original body after reload", async () => {
    const { port, records } = cloud();
    const saved = new Map<string, string>(); const recovery = createChatRecovery(() => ({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: (key) => { saved.delete(key); } }));
    const create = port.create; let lose = true;
    port.create = vi.fn<ConversationPort["create"]>(async (...args) => { const result = await create(...args); if (lose) { lose = false; throw new Error("lost response"); } return result; });
    const original = sessionFor(port, localApplication, null, recovery);
    original.setComposer("Original request"); await original.send();
    expect(original.getSnapshot().saveStatus).toBe("error");
    original.setComposer("Keep this later text too"); original.dispose();
    const restored = sessionFor(port, localApplication, null, recovery);
    await restored.open();
    await restored.flush();
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(restored.getSnapshot().composerText).toBe("Keep this later text too");
    await restored.send();
    expect(port.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(port.create).mock.calls[1]?.slice(0, 2)).toEqual(vi.mocked(port.create).mock.calls[0]?.slice(0, 2));
    expect(records.size).toBe(1); expect(restored.getSnapshot().pendingMessages[0]?.text).toBe("Keep this later text too");
    expect(restored.getSnapshot().saveStatus).toBe("saved");
  });

  it("preserves input across a failed save and reuses that command before saving later edits", async () => {
    const { port, records } = cloud(detail());
    const save = port.saveComposer; let lose = true;
    port.saveComposer = vi.fn<ConversationPort["saveComposer"]>(async (...args) => { const result = await save(...args); if (lose) { lose = false; throw new Error("lost"); } return result; });
    const session = sessionFor(port, localApplication, ids.conversation); await session.open();
    session.setComposer("First edit"); expect(await session.flush()).toBe(false);
    session.setComposer("A later edit"); expect(await session.flush()).toBe(true);
    const calls = vi.mocked(port.saveComposer).mock.calls;
    expect(calls[1]?.slice(0, 3)).toEqual(calls[0]?.slice(0, 3));
    expect(records.get(ids.conversation)?.composerDraft.text).toBe("A later edit");
  });

  it("keeps both conflicting versions and requires an explicit resolution even after reload", async () => {
    const { port, records } = cloud(detail());
    const saved = new Map<string, string>(); const recovery = createChatRecovery(() => ({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: (key) => { saved.delete(key); } }));
    const session = sessionFor(port, localApplication, ids.conversation, recovery); await session.open();
    session.setComposer("My unfinished paragraph");
    records.get(ids.conversation)!.composerDraft = { ...records.get(ids.conversation)!.composerDraft, revision: 2, text: "Another tab’s paragraph" };
    expect(await session.flush()).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ composerText: "My unfinished paragraph", composerConflict: { text: "Another tab’s paragraph" }, saveStatus: "conflict" });
    session.dispose();
    const restored = sessionFor(port, localApplication, ids.conversation, recovery); await restored.open();
    expect(restored.getSnapshot().saveStatus).toBe("conflict");
    expect(await restored.resolveComposerConflict("mine")).toBe(true);
    expect(records.get(ids.conversation)?.composerDraft.text).toBe("My unfinished paragraph");
  });

  it("invalidates in-flight work and clears rendered text on an account switch", async () => {
    const { port } = cloud(); const scope = new AccountScope(); const gate = deferred<ServiceResult<ConversationDetail>>();
    port.create = vi.fn(() => gate.promise);
    const session = sessionFor(port, localApplication, null, createChatRecovery(), scope);
    session.setComposer("Account A private input"); const saving = session.send();
    scope.replaceActor(ids.sample); gate.resolve(ok(detail("Account A private input"))); await saving;
    expect(session.getSnapshot()).toMatchObject({ conversation: null, composerText: "", pendingMessages: [] });
    expect(vi.mocked(port.create).mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(port.saveComposer).not.toHaveBeenCalled();
  });

  it("rejects an unexpected account projection and does not rewrite partial server messages on reload", async () => {
    const value = detail(); const receipt = accepted({ conversationId: ids.conversation, messageId: ids.question, requestId: ids.request, text: "A question", branchId, expectedRevision: 1, parentMessageId: null });
    value.messages = [receipt.message, { ...receipt.message, id: ids.evaluation, role: "assistant", clientRequestId: null, status: "streaming", parts: [{ type: "text", text: "Partial answer" }] }]; value.activeTurn = { ...receipt.run, status: "running" };
    const { port } = cloud(value); const session = sessionFor(port, localApplication, ids.conversation); await session.open();
    expect(session.getSnapshot().conversation?.messages[1]?.status).toBe("streaming");
    expect(session.getSnapshot().run?.status).toBe("running"); expect(port.saveComposer).not.toHaveBeenCalled();
    const foreign = detail(); foreign.conversation.ownerId = ids.sample;
    port.get = vi.fn(async () => ok(foreign));
    const wrong = sessionFor(port, localApplication, ids.conversation); await wrong.open();
    expect(wrong.getSnapshot().conversation).toBeNull(); expect(wrong.getSnapshot().loadStatus).toBe("error");
  });

  it("hydrates retained activity once when a reload opens directly on a terminal turn", async () => {
    const input = { conversationId: ids.conversation, messageId: ids.question, requestId: ids.request, text: "Research this topic", branchId, expectedRevision: 1, parentMessageId: null };
    const receipt = accepted(input);
    const failure = { code: "generation_failed" as const, messageKey: "generation.timeout", retryable: true, requestId: ids.request };
    const failedRun = { ...receipt.run, status: "failed" as const, lastSeq: 3, error: failure };
    const value = detail(); value.messages = [receipt.message]; value.activeTurn = failedRun;
    const { port } = cloud(value); const session = sessionFor(port, localApplication, ids.conversation); await session.open();
    expect(session.getSnapshot().stream?.actionEvents).toEqual([]);
    const retained: RunSnapshot["retainedActionEvents"] = [
      { id: "90000000-0000-4000-8000-000000000001", runId, branchId, seq: 1, at: timestamp, type: "action.started", invocationId: ids.evaluation, action: "search", labelKey: "actions.search" },
      { id: "90000000-0000-4000-8000-000000000002", runId, branchId, seq: 2, at: timestamp, type: "action.completed", invocationId: ids.evaluation, resultSummary: "Sources saved.", sourceIds: [ids.source] },
    ];
    const snapshot: RunSnapshot = { run: failedRun, messages: value.messages, artifacts: [], lastSeq: 3, retainedActionEvents: retained };
    session.receiveSnapshot(snapshot); session.receiveSnapshot(snapshot);
    const hydrated = session.getSnapshot();
    expect(hydrated.stream?.actionEvents).toEqual(retained);
    expect(hydrated.stream?.lastAppliedSeq).toBe(3);
    expect(hydrated.conversation?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(hydrated.run?.status).toBe("failed");
  });
});

describe("pending input and canonical delivery", () => {
  it("saves one intent before sending and never invents a message or run on unavailable generation", async () => {
    const { port, records } = cloud(); const services = { ...localApplication, sendMessage: vi.fn(localApplication.sendMessage) }; const session = sessionFor(port, services);
    session.setComposer("Teach me AI deeply."); await session.send();
    expect(records.get(ids.conversation)?.messages).toEqual([]);
    expect(records.get(ids.conversation)?.composerDraft.pendingMessages).toHaveLength(1);
    expect(session.getSnapshot().conversation?.messages[0]).toMatchObject({ delivery: "failed", text: "Teach me AI deeply." });
    expect(session.getSnapshot().run).toBeNull();
    const input = services.sendMessage.mock.calls[0]![0];
    expect(input).toMatchObject({ branchId, expectedRevision: 1, parentMessageId: null });
    await session.retry(input.messageId);
    expect(services.sendMessage.mock.calls[1]![0]).toEqual(input);
    expect(records.get(ids.conversation)?.composerDraft.pendingMessages).toHaveLength(1);
  });

  it("does not send if the pending intent cannot be saved", async () => {
    const { port } = cloud(detail()); port.saveComposer = vi.fn(async () => { throw new Error("offline"); });
    const services = { ...localApplication, sendMessage: vi.fn(localApplication.sendMessage) }; const session = sessionFor(port, services, ids.conversation);
    await session.open(); session.setComposer("Retain my input"); await session.send();
    expect(session.getSnapshot().composerText).toBe("Retain my input"); expect(services.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps later typing and exact retry identity after an unknown delivery", async () => {
    const { port } = cloud(); const gate = deferred<ServiceResult<SendMessageResult>>(); const services = { ...localApplication, sendMessage: vi.fn<ApplicationPort["sendMessage"]>(() => gate.promise) };
    const session = sessionFor(port, services); session.setComposer("First question"); const sending = session.send();
    await vi.waitFor(() => expect(services.sendMessage).toHaveBeenCalledOnce()); session.setComposer("A second thought");
    gate.reject(new Error("Connection dropped")); await sending;
    expect(session.getSnapshot().composerText).toBe("A second thought");
    expect(session.getSnapshot().conversation?.messages[0]?.error?.messageKey).toBe("chat.deliveryUnknown");
    const first = services.sendMessage.mock.calls[0]![0]; await session.retry(first.messageId);
    expect(services.sendMessage.mock.calls[1]![0]).toEqual(first);
    expect(session.editMessage(first.messageId)).toBe(false);
  });

  it("uses a new identity for edited rejected content and keeps course selection independent of approval", async () => {
    const saved = detail(); saved.artifacts = [artifact(), artifact(ids.sample)]; const { port } = cloud(saved);
    const session = sessionFor(port, localApplication, ids.conversation); await session.open();
    session.setComposer("Original wording"); await session.send(); const old = session.getSnapshot().pendingMessages[0]!;
    expect(session.editMessage(old.messageId)).toBe(true); session.setComposer("Revised wording"); await session.send();
    const next = session.getSnapshot().pendingMessages[0]!; expect(next.messageId).not.toBe(old.messageId); expect(next.requestId).not.toBe(old.requestId);
    const receipt = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(saved.artifacts[0]!.curriculum!), approvedBy: ids.actor, approvedAt: timestamp };
    const approving = session.acknowledgeApproval(ids.course, receipt); session.selectCourse(ids.sample); expect(await approving).toBe(true);
    expect(session.getSnapshot().conversation?.selectedCourseId).toBe(ids.sample); expect(session.getSnapshot().conversation?.artifacts[0]?.approval).toEqual(receipt);
    expect(session.getSnapshot().conversation?.artifacts[1]?.approval).toBeNull();
  });

  it("accepts server history without persisting stream projections and rejects a stale branch", async () => {
    const value = detail(); const receipt = accepted({ conversationId: ids.conversation, messageId: ids.question, requestId: ids.request, text: "A question", branchId, expectedRevision: 1, parentMessageId: null });
    value.messages = [receipt.message]; value.activeTurn = receipt.run; value.artifacts = [artifact(), artifact(ids.sample)];
    const { port } = cloud(value); const session = sessionFor(port, localApplication, ids.conversation); await session.open();
    const snapshot: RunSnapshot = { run: { ...receipt.run, status: "awaiting_user", lastSeq: 1 }, messages: [receipt.message], artifacts: value.artifacts, lastSeq: 1, retainedActionEvents: [] };
    session.restoreSnapshot(snapshot); const before = session.getSnapshot().stream;
    session.receiveSnapshot({ ...snapshot, run: { ...snapshot.run, branchId: ids.missing } });
    expect(session.getSnapshot().stream).toBe(before);
    const approval = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(value.artifacts[0]!.curriculum!), approvedBy: ids.actor, approvedAt: timestamp };
    await session.acknowledgeApproval(ids.course, approval);
    expect(canApproveCurriculum(session.getSnapshot().stream!, ids.course, ids.draft, 1)).toBe(false);
    expect(port.saveComposer).not.toHaveBeenCalled();
  });

  it("keeps one accepted user message while a failed turn resumes in place and completes", async () => {
    const { port, records } = cloud();
    const services = { ...localApplication, sendMessage: vi.fn<ApplicationPort["sendMessage"]>(async (input) => {
      const receipt = accepted(input);
      const value = records.get(input.conversationId)!;
      value.messages = [receipt.message]; value.activeTurn = receipt.run;
      value.conversation = { ...value.conversation, revision: value.conversation.revision + 1 };
      value.composerDraft = { ...value.composerDraft, revision: value.composerDraft.revision + 1, pendingMessages: [] };
      return ok(receipt);
    }) };
    const session = sessionFor(port, services);
    session.setComposer("Explain durable retries."); await session.send();
    const acceptedState = session.getSnapshot();
    expect(acceptedState.pendingMessages).toEqual([]);
    expect(acceptedState.conversation?.messages).toHaveLength(1);
    const run = acceptedState.stream!.run;
    session.receiveSnapshot({ run, messages: records.get(ids.conversation)!.messages, artifacts: [], lastSeq: 1, retainedActionEvents: [] });
    session.receiveEvent({ id: ids.missing, runId: run.id, branchId, seq: 2, at: timestamp, type: "run.failed",
      error: { code: "generation_failed", messageKey: "generation.timeout", retryable: true, requestId: ids.request } });
    expect(session.getSnapshot().run?.status).toBe("failed");
    expect(session.resumeRun(run.id, { run: { ...run, status: "queued", error: null, lastSeq: 3 }, messages: records.get(ids.conversation)!.messages,
      artifacts: [], lastSeq: 3, retainedActionEvents: [] })).toBe(true);
    session.receiveEvent({ id: "90000000-0000-4000-8000-000000000004", runId: run.id, branchId, seq: 4, at: timestamp, type: "message.started", messageId: ids.evaluation });
    session.receiveEvent({ id: "90000000-0000-4000-8000-000000000005", runId: run.id, branchId, seq: 5, at: timestamp, type: "message.delta", messageId: ids.evaluation, text: "A durable retry resumes saved work." });
    session.receiveEvent({ id: "90000000-0000-4000-8000-000000000006", runId: run.id, branchId, seq: 6, at: timestamp, type: "message.completed", messageId: ids.evaluation });
    session.receiveEvent({ id: "90000000-0000-4000-8000-000000000007", runId: run.id, branchId, seq: 7, at: timestamp, type: "run.completed" });
    const complete = session.getSnapshot();
    expect(complete.run?.status).toBe("succeeded");
    expect(complete.pendingMessages).toEqual([]);
    expect(complete.conversation?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(complete.conversation?.messages.at(-1)).toMatchObject({ role: "assistant", text: "A durable retry resumes saved work.", status: "complete" });
  });

  it("preserves earlier run activity when a continuation starts and lazily merges older pages", async () => {
    const first = accepted({ conversationId: ids.conversation, messageId: ids.question, requestId: ids.request, text: "Start", branchId, expectedRevision: 1, parentMessageId: null });
    const previous = action(first.run.id, 1, ids.source);
    const value = detail("Continue"); value.messages = [first.message]; value.activeTurn = { ...first.run, status: "succeeded" };
    value.retainedActionEvents = [previous]; value.actionHistoryNextCursor = "older-page";
    const { port, records } = cloud(value);
    const older = { ...action(ids.sample, 1, ids.task, new Date(Date.parse(timestamp) - 1_000).toISOString()), id: ids.approval };
    port.getActions = vi.fn(async () => ok({ conversationId: ids.conversation, branchId, items: [older, previous], nextCursor: null }));
    const services = { ...localApplication, sendMessage: vi.fn<ApplicationPort["sendMessage"]>(async (input) => {
      const receipt = accepted(input, ids.evaluation); const current = records.get(input.conversationId)!;
      current.messages = [...current.messages, receipt.message]; current.activeTurn = receipt.run;
      current.conversation = { ...current.conversation, revision: current.conversation.revision + 1 };
      current.composerDraft = { ...current.composerDraft, revision: current.composerDraft.revision + 1, text: "", pendingMessages: [] };
      return ok(receipt);
    }) };
    const session = sessionFor(port, services, ids.conversation); await session.open(); await session.send();
    session.receiveEvent({ id: ids.request, runId: ids.evaluation, branchId, seq: 1, at: timestamp, type: "run.accepted", status: "queued" });
    session.receiveEvent(action(ids.evaluation, 2, ids.attempt, new Date(Date.parse(timestamp) + 1_000).toISOString()));
    expect(session.getSnapshot().actionEvents.map((event) => event.runId)).toEqual([first.run.id, ids.evaluation]);
    expect(await session.loadEarlierActivity()).toBe(true);
    const history = session.getSnapshot();
    expect(history.actionEvents.map((event) => event.id)).toEqual([older.id, previous.id, "90000000-0000-4000-8000-000000000002"]);
    expect(history.actionHistoryNextCursor).toBeNull();
    expect(port.getActions).toHaveBeenCalledWith(ids.conversation, { cursor: "older-page", limit: 50 }, expect.any(AbortSignal));
  });

  it("drops an older-activity response when the conversation revision changes in flight", async () => {
    const value = detail(); value.actionHistoryNextCursor = "older-page";
    const { port } = cloud(value); const gate = deferred<Awaited<ReturnType<ConversationPort["getActions"]>>>();
    port.getActions = vi.fn(() => gate.promise);
    const session = sessionFor(port, localApplication, ids.conversation); await session.open();
    const loading = session.loadEarlierActivity();
    expect(await session.rename("Changed while loading")).toBe(true);
    gate.resolve(ok({ conversationId: ids.conversation, branchId, items: [action(ids.request, 1, ids.source)], nextCursor: null }));
    expect(await loading).toBe(false);
    expect(session.getSnapshot().actionEvents).toEqual([]);
  });
});
