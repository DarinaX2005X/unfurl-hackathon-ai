import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "../../src/features/creator/chat-session";
import { createChatRecovery } from "../../src/features/creator/chat-recovery";
import { ChatStoreError, type ChatStore, type CourseArtifactRef, type LocalConversation, type LocalMessage } from "../../src/domain/chat";
import type { ApplicationPort, SendMessageInput, SendMessageResult, ServiceResult } from "../../src/application/ports";
import type { RunSnapshot } from "../../src/domain/generation";
import { localApplication } from "../../src/application/local-adapter";
import { curriculumDigest } from "../../src/domain/course";
import { canApproveCurriculum } from "../../src/features/creator/stream";
import { curriculum, ids, timestamp } from "../domain/fixtures";

const branchId = "20000000-0000-4000-8000-000000000002";
const runId = "20000000-0000-4000-8000-000000000003";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function conversation(): LocalConversation {
  return { id: ids.conversation, schemaVersion: 1, title: "A learning question", titleSource: "user", composerText: "",
    messages: [], artifacts: [], selectedCourseId: null, revision: 1, createdAt: timestamp, updatedAt: timestamp, legacySource: null };
}
function userMessage(): LocalMessage {
  return { id: ids.question, conversationId: ids.conversation, role: "user", text: "Explain the difference.", delivery: "accepted", status: "complete",
    requestId: ids.request, runId, branchId, userLocale: "en", createdAt: timestamp, updatedAt: timestamp, error: null };
}
function artifact(courseId: string = ids.course): CourseArtifactRef {
  const draft = { ...curriculum(), courseId, id: courseId === ids.course ? ids.draft : ids.missing };
  return { courseId, title: draft.title, summary: draft.goal, contentLanguage: "en", revision: 1, curriculum: draft,
    approval: null, approvalRequestedRevision: 1, readyVersionId: null, updatedAt: timestamp };
}
function memoryStore(initial?: LocalConversation) {
  const records = new Map(initial ? [[initial.id, structuredClone(initial)]] : []);
  const deleted = new Set<string>();
  const store: ChatStore = {
    list: vi.fn(async () => [...records.values()]), get: vi.fn(async (id) => records.get(id) ?? null),
    put: vi.fn(async (value) => { if (deleted.has(value.id)) throw new ChatStoreError("deleted", "Deleted"); records.set(value.id, structuredClone(value)); }),
    remove: vi.fn(async (id) => { deleted.add(id); records.delete(id); }), wasDeleted: vi.fn(async (id) => deleted.has(id)),
    migrateLegacy: vi.fn(async () => ({ importedIds: [], issues: [] })),
  };
  return { store, records, deleted };
}
function sessionFor(store: ChatStore, services: ApplicationPort = localApplication, id: string | null = null) {
  let idCount = 0;
  return new ChatSession(store, services, id, { createId: () => idCount++ === 0 && id === null ? ids.conversation : crypto.randomUUID(), now: () => timestamp, userLocale: () => "en", recovery: createChatRecovery() });
}
function accepted(input: SendMessageInput, currentRunId = runId): ServiceResult<SendMessageResult> {
  return { ok: true, data: { message: { id: input.messageId, conversationId: input.conversationId, branchId, parentMessageId: null, role: "user", status: "complete",
    parts: [{ type: "text", text: input.text }], clientRequestId: input.requestId, createdAt: timestamp },
    run: { id: currentRunId, conversationId: input.conversationId, branchId, inputMessageId: input.messageId, ownerId: ids.actor,
      status: "queued", lastSeq: 0, error: null, createdAt: timestamp, updatedAt: timestamp } } };
}

describe("local chat autosave", () => {
  it("creates no record for a visit, then serializes edits and waits for the final transaction", async () => {
    const { store, records } = memoryStore();
    const writes: Array<{ value: LocalConversation; ack: ReturnType<typeof deferred<void>> }> = [];
    store.put = vi.fn((value) => { const ack = deferred<void>(); writes.push({ value: structuredClone(value), ack }); return ack.promise.then(() => { records.set(value.id, value); }); });
    const session = sessionFor(store);
    await session.open();
    expect(store.put).not.toHaveBeenCalled();
    session.setComposer("First");
    session.setComposer("First with a later edit");
    expect(writes).toHaveLength(1);
    expect(session.getSnapshot().saveStatus).toBe("saving");
    const navigating = session.flush();
    writes[0]!.ack.resolve();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(session.getSnapshot().saveStatus).toBe("saving");
    expect(writes[1]!.value.composerText).toBe("First with a later edit");
    writes[1]!.ack.resolve();
    expect(await navigating).toBe(true);
    expect(session.getSnapshot().saveStatus).toBe("saved");
    expect(records.get(ids.conversation)?.composerText).toBe("First with a later edit");
    const reopened = sessionFor(store, localApplication, ids.conversation);
    await reopened.open();
    expect(reopened.getSnapshot().conversation?.composerText).toBe("First with a later edit");
  });

  it("recovers the newest unacknowledged text on navigation without calling it saved", async () => {
    const { store } = memoryStore();
    const recovery = createChatRecovery();
    const pending = deferred<void>();
    store.put = vi.fn(() => pending.promise);
    const original = new ChatSession(store, localApplication, null, { createId: () => ids.conversation, recovery });
    original.setComposer("Keep this while storage is pending.");
    const reopened = new ChatSession(store, localApplication, ids.conversation, { recovery });
    await reopened.open();
    expect(reopened.getSnapshot().conversation?.composerText).toBe("Keep this while storage is pending.");
    expect(reopened.getSnapshot().saveStatus).toBe("saving");
    pending.resolve();
    await Promise.all([original.flush(), reopened.flush()]);
  });

  it("never claims a save or sends externally when storage fails", async () => {
    const { store } = memoryStore();
    store.put = vi.fn(async () => { throw new ChatStoreError("quota_exceeded", "Full"); });
    const services = { ...localApplication, sendMessage: vi.fn(localApplication.sendMessage) };
    const session = sessionFor(store, services);
    session.setComposer("Keep my question.");
    await session.send();
    expect(session.getSnapshot().saveStatus).toBe("error");
    expect(session.getSnapshot().conversation?.messages[0]).toMatchObject({ text: "Keep my question.", delivery: "not_sent" });
    expect(services.sendMessage).not.toHaveBeenCalled();
    store.put = vi.fn(async () => undefined);
    expect(await session.flush()).toBe(true);
    expect(session.getSnapshot().saveStatus).toBe("saved");
  });

  it("keeps a renamed chat name independent of later composer text", async () => {
    const { store } = memoryStore();
    const session = sessionFor(store);
    session.setComposer("Automatic title");
    expect(await session.rename("My research")).toBe(true);
    session.setComposer("A different question");
    await session.flush();
    expect(session.getSnapshot().conversation?.title).toBe("My research");
  });

  it("does not recover deleted conversations or silently replace invalid identities", async () => {
    const { store, deleted } = memoryStore();
    const recovery = createChatRecovery();
    recovery.write(conversation());
    deleted.add(ids.conversation);
    const missing = new ChatSession(store, localApplication, ids.conversation, { recovery });
    await missing.open();
    expect(missing.getSnapshot().loadStatus).toBe("missing");
    expect(recovery.read(ids.conversation)).toBeNull();
    const invalid = sessionFor(store, localApplication, "invalid");
    await invalid.open();
    expect(invalid.getSnapshot().loadStatus).toBe("invalid");
    expect(store.put).not.toHaveBeenCalled();
  });
});

describe("message delivery is distinct from a generation turn", () => {
  it("persists one failed user message and creates no assistant, run, or course; retries use the same identity", async () => {
    const { store, records } = memoryStore();
    const services = { ...localApplication, sendMessage: vi.fn(localApplication.sendMessage) };
    const session = sessionFor(store, services);
    session.setComposer("Teach me AI deeply.");
    await session.send();
    const state = session.getSnapshot();
    expect(state.conversation?.messages).toHaveLength(1);
    expect(state.conversation?.messages[0]).toMatchObject({ role: "user", delivery: "failed", text: "Teach me AI deeply.", runId: null });
    expect(state.run).toBeNull();
    expect(state.conversation?.artifacts).toEqual([]);
    expect(records.get(ids.conversation)?.messages).toEqual(state.conversation?.messages);
    await session.retry(state.conversation!.messages[0]!.id);
    expect(services.sendMessage).toHaveBeenCalledTimes(2);
    expect(services.sendMessage.mock.calls[1]![0]).toEqual(services.sendMessage.mock.calls[0]![0]);
    expect(session.getSnapshot().conversation?.messages).toHaveLength(1);
  });

  it("assigns new message and request identities to edited failed content", async () => {
    const { store } = memoryStore();
    const services = { ...localApplication, sendMessage: vi.fn(localApplication.sendMessage) };
    const session = sessionFor(store, services);
    session.setComposer("Original wording");
    await session.send();
    const old = session.getSnapshot().conversation!.messages[0]!;
    expect(session.editMessage(old.id)).toBe(true);
    session.setComposer("Revised wording");
    await session.send();
    const next = session.getSnapshot().conversation!.messages[0]!;
    expect(next.id).not.toBe(old.id);
    expect(next.requestId).not.toBe(old.requestId);
    expect(next.text).toBe("Revised wording");
    expect(session.getSnapshot().conversation?.messages).toHaveLength(1);
    session.setComposer("Unfinished later message");
    expect(session.editMessage(next.id)).toBe(false);
    expect(session.getSnapshot().conversation?.composerText).toBe("Unfinished later message");
  });

  it("retains concurrent composer input when an earlier send fails", async () => {
    const { store } = memoryStore();
    const reply = deferred<ServiceResult<SendMessageResult>>();
    const services = { ...localApplication, sendMessage: vi.fn(() => reply.promise) };
    const session = sessionFor(store, services);
    session.setComposer("First question");
    const sending = session.send();
    await vi.waitFor(() => expect(services.sendMessage).toHaveBeenCalledOnce());
    session.setComposer("A second thought");
    reply.reject(new Error("Connection dropped"));
    await sending;
    expect(session.getSnapshot().conversation?.composerText).toBe("A second thought");
    expect(session.getSnapshot().conversation?.messages[0]?.error?.messageKey).toBe("chat.deliveryUnknown");
  });

  it("rejects a delayed previous-turn snapshot after a newer message was accepted", async () => {
    const { store } = memoryStore();
    let count = 0;
    const services = { ...localApplication, sendMessage: vi.fn(async (input: SendMessageInput) => accepted(input, count++ === 0 ? runId : ids.attempt)) };
    const session = sessionFor(store, services);
    session.setComposer("First turn");
    await session.send();
    const first = session.getSnapshot().stream!;
    session.receiveEvent({ id: ids.evaluation, type: "run.completed", runId, branchId, seq: 1, at: timestamp });
    session.setComposer("Second turn");
    await session.send();
    const current = session.getSnapshot().stream!;
    const late: RunSnapshot = { run: { ...first.run, status: "succeeded", lastSeq: 1 }, messages: first.messages, artifacts: [artifact()], lastSeq: 1, retainedActionEvents: [] };
    session.receiveSnapshot(late);
    expect(session.getSnapshot().stream).toBe(current);
    expect(session.getSnapshot().run?.id).toBe(ids.attempt);
    expect(session.getSnapshot().conversation?.artifacts).toEqual([]);
    session.receiveSnapshot({ ...late, run: { ...current.run, branchId: ids.missing } });
    expect(session.getSnapshot().stream).toBe(current);
    session.setComposer("Queued while agent works");
    await session.send();
    expect(services.sendMessage).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().conversation?.composerText).toBe("Queued while agent works");
  });

  it("reload marks partial assistant text interrupted and preserves acceptance of the user message", async () => {
    const saved = conversation();
    const user = userMessage();
    saved.messages = [user, { ...user, id: ids.evaluation, role: "assistant", text: "Partial but useful", requestId: null, status: "streaming" }];
    const { store } = memoryStore(saved);
    const session = sessionFor(store, localApplication, saved.id);
    await session.open();
    expect(session.getSnapshot().conversation?.messages[0]?.delivery).toBe("accepted");
    expect(session.getSnapshot().conversation?.messages[1]).toMatchObject({ text: "Partial but useful", delivery: "accepted", status: "interrupted" });
    expect(session.getSnapshot().run).toBeNull();
    expect(session.getSnapshot().stream).toBeNull();
    const restored: RunSnapshot = { run: { id: runId, ownerId: ids.actor, conversationId: saved.id, branchId, inputMessageId: user.id, status: "succeeded", lastSeq: 1, error: null, createdAt: timestamp, updatedAt: timestamp }, messages: [], artifacts: [], lastSeq: 1, retainedActionEvents: [] };
    session.receiveSnapshot(restored);
    expect(session.getSnapshot().run).toBeNull();
    session.restoreSnapshot(restored);
    expect(session.getSnapshot().run?.id).toBe(runId);
    await session.flush();
  });

  it("a confirmed approval remains scoped to A when selection changes to B during the acknowledgement", async () => {
    const saved = conversation();
    saved.artifacts = [artifact(), artifact(ids.sample)];
    saved.selectedCourseId = ids.course;
    saved.messages = [userMessage()];
    const { store } = memoryStore(saved);
    const session = sessionFor(store, localApplication, saved.id);
    await session.open();
    const snapshot: RunSnapshot = { run: { id: runId, ownerId: ids.actor, conversationId: saved.id, branchId, inputMessageId: ids.question, status: "awaiting_user", lastSeq: 1, error: null, createdAt: timestamp, updatedAt: timestamp }, messages: [], artifacts: saved.artifacts, lastSeq: 1, retainedActionEvents: [] };
    session.restoreSnapshot(snapshot);
    const receipt = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(saved.artifacts[0]!.curriculum!), approvedBy: ids.actor, approvedAt: timestamp };
    const approving = session.acknowledgeApproval(ids.course, receipt);
    session.selectCourse(ids.sample);
    expect(await approving).toBe(true);
    expect(session.getSnapshot().conversation?.selectedCourseId).toBe(ids.sample);
    expect(session.getSnapshot().conversation?.artifacts[0]?.approval).toEqual(receipt);
    expect(session.getSnapshot().conversation?.artifacts[1]?.approval).toBeNull();
    expect(canApproveCurriculum(session.getSnapshot().stream!, ids.course, ids.draft, 1)).toBe(false);
    expect(canApproveCurriculum(session.getSnapshot().stream!, ids.sample, ids.missing, 1)).toBe(true);
  });
});
