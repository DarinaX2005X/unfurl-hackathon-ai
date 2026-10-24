import { ContentLanguageSchema, IdSchema } from "@/domain/common";
import { ChatStoreError, type ChatStore, type CourseArtifactRef, type LocalConversation, type LocalMessage } from "@/domain/chat";
import type { ApplicationPort, SendMessageResult } from "@/application/ports";
import type { ApiError } from "@/domain/errors";
import type { ChatRecovery } from "./chat-recovery";
import { creatorStreamReducer, createStreamState, type CreatorStreamState } from "./stream";
import type { ChatEvent, RunSnapshot } from "@/domain/generation";
import { assertCurrentApproval, type CurriculumApproval } from "@/domain/course";

export const MESSAGE_LIMIT = 20_000;
export type ChatLoadStatus = "loading" | "ready" | "invalid" | "missing" | "error";
export interface ChatSessionState {
  loadStatus: ChatLoadStatus;
  saveStatus: "idle" | "saving" | "saved" | "error";
  conversation: LocalConversation | null;
  storageError: ChatStoreError | null;
  transmittingId: string | null;
  editingMessageId: string | null;
  run: SendMessageResult["run"] | null;
  stream: CreatorStreamState | null;
}

interface SessionOptions {
  createId?: () => string;
  now?: () => string;
  recovery?: ChatRecovery;
  userLocale?: () => string | undefined;
  onIdentity?: (id: string, session: ChatSession) => void;
}

export function conversationTitle(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim().replace(/\s+/g, " ") ?? "New chat";
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
}

function storageError(error: unknown): ChatStoreError {
  return error instanceof ChatStoreError ? error : new ChatStoreError("unavailable", "The chat could not be saved", undefined, { cause: error });
}

export class ChatSession {
  private state: ChatSessionState;
  private listeners = new Set<() => void>();
  private writing: Promise<boolean> | null = null;
  private opening: Promise<void> | null = null;
  private savedRevision = 0;
  private deleted = false;
  private sending = false;
  private sendController: AbortController | null = null;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(private readonly store: ChatStore, private readonly services: ApplicationPort, private readonly requestedId: string | null, private readonly options: SessionOptions = {}) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.state = { loadStatus: requestedId ? "loading" : "ready", saveStatus: "idle", conversation: null, storageError: null, transmittingId: null, editingMessageId: null, run: null, stream: null };
  }

  getSnapshot = (): ChatSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(change: Partial<ChatSessionState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  open(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.state.conversation || this.requestedId === null) return Promise.resolve();
    if (!IdSchema.safeParse(this.requestedId).success) { this.publish({ loadStatus: "invalid" }); return Promise.resolve(); }
    this.publish({ loadStatus: "loading", storageError: null });
    this.opening = Promise.all([this.store.get(this.requestedId), this.store.wasDeleted(this.requestedId)]).then(([stored, deleted]) => {
      if (deleted) {
        this.deleted = true;
        this.options.recovery?.clear(this.requestedId!);
        this.publish({ loadStatus: "missing" });
        return;
      }
      if (stored && stored.id !== this.requestedId) throw new ChatStoreError("corrupt_record", "The chat does not match this link");
      const recovered = this.options.recovery?.read(this.requestedId!);
      let conversation = recovered && recovered.revision > (stored?.revision ?? 0) ? recovered : stored;
      if (!conversation) { this.publish({ loadStatus: "missing" }); return; }
      this.savedRevision = stored?.revision ?? 0;
      const interrupted = conversation.messages.some((message) => message.delivery === "sending" || message.status === "streaming");
      if (interrupted) conversation = { ...conversation, revision: conversation.revision + 1, messages: conversation.messages.map((message) => ({ ...message,
        ...(message.delivery === "sending" ? { delivery: "failed" as const, error: deliveryError(message.requestId!, "chat.deliveryUnknown") } : {}),
        ...(message.status === "streaming" ? { status: "interrupted" as const } : {}),
      })) };
      this.publish({ loadStatus: "ready", conversation, saveStatus: conversation.revision === this.savedRevision ? "saved" : "saving" });
      this.options.onIdentity?.(conversation.id, this);
      if (conversation.revision !== this.savedRevision) void this.flush();
    }).catch((error: unknown) => { this.publish({ loadStatus: "error", storageError: storageError(error) }); }).finally(() => { this.opening = null; });
    return this.opening;
  }

  private newConversation(text: string): LocalConversation {
    const at = this.now();
    return { id: this.createId(), schemaVersion: 1, title: conversationTitle(text), titleSource: "initial_text", composerText: text,
      messages: [], artifacts: [], selectedCourseId: null, revision: 1, createdAt: at, updatedAt: at, legacySource: null };
  }

  private commit(conversation: LocalConversation): void {
    if (this.deleted) return;
    this.options.recovery?.write(conversation);
    this.publish({ conversation, saveStatus: "saving", storageError: null });
    this.options.onIdentity?.(conversation.id, this);
    void this.flush();
  }

  setComposer(text: string): void {
    if (this.deleted || this.state.loadStatus !== "ready") return;
    text = text.slice(0, MESSAGE_LIMIT);
    const conversation = this.state.conversation;
    if (!conversation) { if (text.length) this.commit(this.newConversation(text)); return; }
    if (text === conversation.composerText) return;
    this.commit({ ...conversation, composerText: text, revision: conversation.revision + 1, updatedAt: this.now(),
      title: conversation.titleSource === "initial_text" && conversation.messages.length === 0 ? conversationTitle(text) : conversation.title });
  }

  async rename(title: string): Promise<boolean> {
    const conversation = this.state.conversation;
    title = title.trim();
    if (!conversation || this.deleted || !title || title.length > 120) return false;
    this.commit({ ...conversation, title, titleSource: "user", revision: conversation.revision + 1, updatedAt: this.now() });
    return this.flush();
  }

  flush(): Promise<boolean> {
    if (this.writing) return this.writing.then((saved) => {
      if (!saved || this.deleted) return false;
      return this.state.conversation && this.state.conversation.revision !== this.savedRevision ? this.flush() : true;
    });
    const conversation = this.state.conversation;
    if (!conversation || this.deleted) return Promise.resolve(!this.deleted);
    if (conversation.revision === this.savedRevision) return Promise.resolve(true);
    this.publish({ saveStatus: "saving", storageError: null });
    this.writing = this.writeLatest().finally(() => { this.writing = null; });
    return this.writing;
  }

  private async writeLatest(): Promise<boolean> {
    try {
      while (!this.deleted && this.state.conversation && this.state.conversation.revision !== this.savedRevision) {
        const snapshot = this.state.conversation;
        await this.store.put(snapshot);
        if (this.deleted) return false;
        this.savedRevision = snapshot.revision;
        const finished = this.state.conversation.revision === this.savedRevision;
        if (finished) this.options.recovery?.clear(snapshot.id);
        this.publish({ saveStatus: finished ? "saved" : "saving" });
      }
      return !this.deleted;
    } catch (error) { this.publish({ saveStatus: "error", storageError: storageError(error) }); return false; }
  }

  async send(): Promise<void> {
    const conversation = this.state.conversation;
    if (!conversation || this.deleted || this.sending || this.state.stream?.pending || !conversation.composerText.trim()) return;
    const at = this.now();
    const locale = this.options.userLocale?.();
    const message: LocalMessage = {
      id: this.createId(), conversationId: conversation.id, role: "user", text: conversation.composerText,
      delivery: "not_sent", status: "complete", requestId: this.createId(), runId: null, branchId: null,
      userLocale: locale && ContentLanguageSchema.safeParse(locale).success ? locale : null,
      createdAt: at, updatedAt: at, error: null,
    };
    const editing = this.state.editingMessageId;
    const messages = editing ? conversation.messages.map((item) => item.id === editing ? message : item) : [...conversation.messages, message];
    this.publish({ editingMessageId: null });
    this.commit({ ...conversation, messages, composerText: "", revision: conversation.revision + 1, updatedAt: at,
      title: conversation.titleSource === "initial_text" && conversation.messages.length === 0 ? conversationTitle(message.text) : conversation.title });
    await this.deliver(message.id);
  }

  async retry(messageId: string): Promise<void> {
    const message = this.state.conversation?.messages.find((item) => item.id === messageId);
    if (message?.role !== "user" || (message.delivery !== "failed" && message.delivery !== "not_sent")) return;
    await this.deliver(messageId);
  }

  editMessage(messageId: string): boolean {
    const conversation = this.state.conversation;
    const message = conversation?.messages.find((item) => item.id === messageId);
    if (!conversation || !message || message.role !== "user" || message.delivery === "accepted" || this.sending) return false;
    if (conversation.composerText.trim()) return false;
    this.publish({ editingMessageId: message.id });
    this.setComposer(message.text);
    return true;
  }

  cancelEdit(): void { this.publish({ editingMessageId: null }); }

  private updateMessage(id: string, change: Partial<LocalMessage>): void {
    const conversation = this.state.conversation;
    if (!conversation || this.deleted) return;
    this.commit({ ...conversation, messages: conversation.messages.map((message) => message.id === id ? { ...message, ...change, updatedAt: this.now() } : message), revision: conversation.revision + 1, updatedAt: this.now() });
  }

  private async deliver(messageId: string): Promise<void> {
    if (this.sending || this.deleted || this.state.stream?.pending) return;
    this.sending = true;
    this.publish({ transmittingId: messageId });
    try {
      if (!await this.flush()) return;
      const message = this.state.conversation?.messages.find((item) => item.id === messageId);
      if (!message || !message.requestId || this.deleted) return;
      const controller = new AbortController();
      this.sendController = controller;
      this.updateMessage(messageId, { delivery: "sending", error: null });
      const result = await this.services.sendMessage({
        requestId: message.requestId, conversationId: message.conversationId, messageId: message.id, text: message.text,
        ...(message.userLocale ? { userLocale: message.userLocale } : {}),
      }, controller.signal);
      if (this.deleted || controller.signal.aborted) return;
      if (!result.ok) { this.updateMessage(messageId, { delivery: "failed", error: result.error.error }); return; }
      const accepted = result.data.message;
      if (accepted.id !== message.id || accepted.conversationId !== message.conversationId || accepted.role !== "user"
        || accepted.clientRequestId !== message.requestId || accepted.branchId !== result.data.run.branchId || result.data.run.conversationId !== message.conversationId
        || result.data.run.inputMessageId !== message.id) throw new Error("The acknowledgement did not match this message");
      this.updateMessage(messageId, { delivery: "accepted", error: null, runId: result.data.run.id, branchId: accepted.branchId });
      this.publish({ run: result.data.run, stream: createStreamState(result.data.run, [accepted], this.state.conversation?.artifacts ?? []) });
    } catch {
      const message = this.state.conversation?.messages.find((item) => item.id === messageId);
      if (!this.deleted && message?.requestId) this.updateMessage(messageId, { delivery: "failed", error: deliveryError(message.requestId, "chat.deliveryUnknown") });
    } finally {
      this.sending = false;
      this.sendController = null;
      this.publish({ transmittingId: null });
      if (this.state.saveStatus !== "error") await this.flush();
    }
  }

  selectCourse(courseId: string): void {
    const conversation = this.state.conversation;
    if (!conversation || !conversation.artifacts.some((artifact) => artifact.courseId === courseId) || conversation.selectedCourseId === courseId) return;
    this.commit({ ...conversation, selectedCourseId: courseId, revision: conversation.revision + 1, updatedAt: this.now() });
  }

  async updateArtifact(artifact: CourseArtifactRef): Promise<boolean> {
    const conversation = this.state.conversation;
    const existing = conversation?.artifacts.find((item) => item.courseId === artifact.courseId);
    if (!conversation || !existing || artifact.revision < existing.revision) return false;
    const artifacts = conversation.artifacts.map((item) => item.courseId === artifact.courseId ? artifact : item);
    if (this.state.stream) {
      const approvalRequired = { ...this.state.stream.approvalRequired };
      if (artifact.curriculum && artifact.approvalRequestedRevision === artifact.curriculum.revision && !artifact.approval) {
        approvalRequired[artifact.courseId] = { id: artifact.curriculum.id, revision: artifact.curriculum.revision };
      } else delete approvalRequired[artifact.courseId];
      this.publish({ stream: { ...this.state.stream, artifacts, approvalRequired } });
    }
    this.commit({ ...conversation, artifacts, revision: conversation.revision + 1, updatedAt: this.now() });
    return this.flush();
  }

  async acknowledgeApproval(courseId: string, approval: CurriculumApproval): Promise<boolean> {
    const artifact = this.state.conversation?.artifacts.find((item) => item.courseId === courseId);
    if (!artifact?.curriculum) return false;
    await assertCurrentApproval(artifact.curriculum, approval);
    const current = this.state.conversation?.artifacts.find((item) => item.courseId === courseId);
    if (!current?.curriculum || current.curriculum.id !== approval.draftId || current.curriculum.revision !== approval.draftRevision) return false;
    return this.updateArtifact({ ...current, approval, approvalRequestedRevision: null });
  }

  receiveSnapshot(snapshot: RunSnapshot): void {
    const conversation = this.state.conversation;
    const current = this.state.stream;
    if (!conversation || this.deleted || !current || snapshot.run.conversationId !== conversation.id
      || snapshot.run.id !== current.run.id || snapshot.run.branchId !== current.run.branchId) return;
    this.applyStream(creatorStreamReducer(current, { type: "snapshot", snapshot }));
  }

  /** A transport explicitly restores the known last accepted turn, before accepting live snapshots. */
  restoreSnapshot(snapshot: RunSnapshot): void {
    const conversation = this.state.conversation;
    if (!conversation || this.deleted || this.sending || this.state.run || snapshot.run.conversationId !== conversation.id) return;
    const latestAccepted = [...conversation.messages].reverse().find((message) => message.role === "user" && message.delivery === "accepted");
    if (!latestAccepted || latestAccepted.id !== snapshot.run.inputMessageId || latestAccepted.runId !== snapshot.run.id || latestAccepted.branchId !== snapshot.run.branchId) return;
    this.applyStream(creatorStreamReducer(createStreamState({ ...snapshot.run, lastSeq: 0 }, [], conversation.artifacts), { type: "snapshot", snapshot }));
  }

  receiveEvent(event: ChatEvent): void {
    if (!this.state.stream || this.deleted) return;
    this.applyStream(creatorStreamReducer(this.state.stream, { type: "event", event }));
  }

  private applyStream(stream: CreatorStreamState): void {
    const conversation = this.state.conversation;
    if (!conversation || this.state.stream === stream) return;
    const messages = [...conversation.messages];
    for (const incoming of stream.messages) {
      const existing = messages.findIndex((message) => message.id === incoming.id);
      const previous = messages[existing];
      const local: LocalMessage = {
        id: incoming.id, conversationId: incoming.conversationId, role: incoming.role,
        text: incoming.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        delivery: "accepted", status: incoming.status, requestId: incoming.clientRequestId, runId: stream.run.id, branchId: incoming.branchId,
        userLocale: previous?.userLocale ?? null, createdAt: incoming.createdAt, updatedAt: this.now(), error: null,
      };
      if (existing === -1) messages.push(local); else messages[existing] = local;
    }
    this.publish({ stream, run: stream.run });
    this.commit({ ...conversation, messages, artifacts: stream.artifacts,
      selectedCourseId: conversation.selectedCourseId ?? stream.artifacts[0]?.courseId ?? null,
      revision: conversation.revision + 1, updatedAt: this.now() });
  }

  async remove(): Promise<boolean> {
    const conversation = this.state.conversation;
    if (!conversation) return false;
    this.deleted = true;
    this.sendController?.abort();
    try {
      await this.store.remove(conversation.id);
      this.options.recovery?.clear(conversation.id);
      this.publish({ conversation: null, loadStatus: "missing", saveStatus: "idle", storageError: null });
      return true;
    } catch (error) {
      this.deleted = false;
      this.publish({ storageError: storageError(error), saveStatus: "error" });
      return false;
    }
  }
}

function deliveryError(requestId: string, messageKey: string): ApiError["error"] {
  return { code: "service_unavailable", messageKey, retryable: true, requestId };
}

export function chatStorageMessage(error: ChatStoreError | null): string {
  if (error?.code === "quota_exceeded") return "This browser is out of space. Your changes are still here. Free some site storage and retry.";
  if (error?.code === "deleted") return "This chat was deleted in another tab. Your current text is still here.";
  if (error?.code === "corrupt_record") return "This chat could not be read. The original data is still on this device.";
  if (error?.code === "version_unsupported") return "This chat uses a newer format. Try an updated browser session.";
  return "This chat couldn’t be saved on this device. Your changes are still here. Allow site storage and retry.";
}
