import { ContentLanguageSchema, IdSchema } from "@/domain/common";
import type { CourseArtifactRef, LocalMessage } from "@/domain/chat";
import type { ApplicationPort, SendMessageInput, SendMessageResult } from "@/application/ports";
import type { ConversationPort } from "@/application/conversation-port";
import type { ApiError } from "@/domain/errors";
import { SaveComposerInputSchema, unacceptedIntents, type ComposerDraft, type ConversationDetail, type PendingUserMessage } from "@/domain/conversations";
import type { ChatRecovery, ChatRecoveryBuffer } from "./chat-recovery";
import { creatorStreamReducer, createStreamState, type CreatorStreamState } from "./stream";
import type { ActionEvent, ChatEvent, ChatMessage, Conversation, RunSnapshot } from "@/domain/generation";
import { assertCurrentApproval, type CurriculumApproval } from "@/domain/course";
import { accountScope, type AccountScope } from "@/features/account/account-scope";
import { mergeActionEvents } from "./conversation-timeline";

export const MESSAGE_LIMIT = 20_000;
export type ChatLoadStatus = "loading" | "ready" | "invalid" | "missing" | "error";
/** A display projection, never a persistence command. */
export interface ChatView extends Conversation {
  messages: LocalMessage[];
  artifacts: CourseArtifactRef[];
  selectedCourseId: string | null;
}
export interface ChatSessionState {
  loadStatus: ChatLoadStatus;
  saveStatus: "idle" | "saving" | "saved" | "error" | "conflict";
  conversation: ChatView | null;
  composerText: string;
  pendingMessages: PendingUserMessage[];
  storageError: ApiError["error"] | null;
  composerConflict: ComposerDraft | null;
  transmittingId: string | null;
  editingMessageId: string | null;
  run: SendMessageResult["run"] | null;
  stream: CreatorStreamState | null;
  actionEvents: ActionEvent[];
  actionHistoryNextCursor: string | null;
  actionHistoryStatus: "idle" | "loading" | "error";
}
interface SessionOptions {
  actorId: string;
  scope?: AccountScope;
  createId?: () => string;
  now?: () => string;
  recovery?: ChatRecovery;
  userLocale?: () => string | undefined;
  autosaveDelay?: number;
  onIdentity?: (id: string, session: ChatSession) => void;
}
type RequestScope = ReturnType<AccountScope["request"]>;
const sameInput = (a: { text: string; pendingMessages: PendingUserMessage[] }, b: { text: string; pendingMessages: PendingUserMessage[] }) => a.text === b.text && JSON.stringify(a.pendingMessages) === JSON.stringify(b.pendingMessages);
const transientError = (requestId: string, messageKey = "chat.unavailable"): ApiError["error"] => ({ code: "service_unavailable", messageKey, retryable: true, requestId });

export class ChatSession {
  private state: ChatSessionState;
  private detail: ConversationDetail | null = null;
  private listeners = new Set<() => void>();
  private writing: Promise<boolean> | null = null;
  private opening: Promise<void> | null = null;
  private autosave: ReturnType<typeof setTimeout> | null = null;
  private requests = new Set<RequestScope>();
  private disposed = false;
  private deleting = false;
  private sending = false;
  private delivering = false;
  private mutation: { kind: "rename" | "remove"; key: string; revision: number; title?: string } | null = null;
  private createCommand: ChatRecoveryBuffer["createCommand"] = null;
  private saveCommand: ChatRecoveryBuffer["saveCommand"] = null;
  private sendCommand: SendMessageInput | null = null;
  private provisionalRecovery: ChatRecoveryBuffer | null = null;
  private actionHistoryPagingStarted = false;
  private deliveryErrors = new Map<string, ApiError["error"]>();
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly scope: AccountScope;
  private readonly stopAccountListener: () => void;

  constructor(private readonly conversations: ConversationPort, private readonly services: ApplicationPort, private readonly requestedId: string | null, private readonly options: SessionOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.scope = options.scope ?? accountScope;
    this.state = { loadStatus: requestedId ? "loading" : "ready", saveStatus: "idle", conversation: null, composerText: "", pendingMessages: [], storageError: null, composerConflict: null, transmittingId: null, editingMessageId: null, run: null, stream: null,
      actionEvents: [], actionHistoryNextCursor: null, actionHistoryStatus: "idle" };
    this.stopAccountListener = this.scope.onClear(options.actorId, () => this.dispose());
  }

  getSnapshot = (): ChatSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private current() { return !this.disposed && this.scope.actorId === this.options.actorId; }
  private publish(change: Partial<ChatSessionState>) {
    if (!this.current()) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private async request<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const request = this.scope.request(this.options.actorId);
    this.requests.add(request);
    try {
      request.signal.throwIfAborted();
      const result = await work(request.signal);
      if (!this.current() || !request.isCurrent()) throw new DOMException("Account changed", "AbortError");
      return result;
    } finally { request.release(); this.requests.delete(request); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.autosave) clearTimeout(this.autosave);
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.options.recovery?.forgetActor(this.options.actorId);
    this.detail = null;
    this.actionHistoryPagingStarted = false;
    this.createCommand = this.saveCommand = this.sendCommand = null;
    this.provisionalRecovery = null;
    this.deliveryErrors.clear();
    this.state = { ...this.state, conversation: null, composerText: "", pendingMessages: [], run: null, stream: null, composerConflict: null, storageError: null, transmittingId: null, editingMessageId: null, loadStatus: "loading", saveStatus: "idle",
      actionEvents: [], actionHistoryNextCursor: null, actionHistoryStatus: "idle" };
    for (const listener of this.listeners) listener();
    this.stopAccountListener?.();
  }

  private recovery() {
    if (!this.current()) return;
    const conversationId = this.detail?.conversation.id ?? this.requestedId;
    this.options.recovery?.write({ actorId: this.options.actorId, conversationId,
      text: this.state.composerText, pendingMessages: this.state.pendingMessages, baseComposerRevision: this.detail?.composerDraft.revision ?? null,
      conflicted: this.state.composerConflict !== null, createCommand: this.createCommand, saveCommand: this.saveCommand, sendCommand: this.sendCommand, updatedAt: this.now() });
    if (conversationId === null) this.provisionalRecovery = this.options.recovery?.read(this.options.actorId, null) ?? null;
  }
  private input() { return { text: this.state.composerText, pendingMessages: this.state.pendingMessages }; }
  private isSaved() { return this.detail !== null && sameInput(this.input(), this.detail.composerDraft); }
  private markInput() {
    const status = this.state.composerConflict ? "conflict" : this.isSaved() ? "saved" : this.detail || this.sending ? "saving" : "idle";
    this.publish({ saveStatus: status });
    if (status === "saved" && !this.sendCommand && !this.saveCommand) this.options.recovery?.clear(this.options.actorId, this.detail!.conversation.id);
    else this.recovery();
  }
  private project() {
    if (!this.detail) return;
    const current = this.state.conversation;
    const messages: LocalMessage[] = this.detail.messages.map((message) => ({
      id: message.id, conversationId: message.conversationId, role: message.role,
      text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      delivery: "accepted", status: message.status, requestId: message.clientRequestId,
      runId: message.id === this.detail?.activeTurn?.inputMessageId ? this.detail.activeTurn.id : null,
      branchId: message.branchId, userLocale: null, createdAt: message.createdAt, updatedAt: message.createdAt, error: null,
    }));
    for (const intent of unacceptedIntents(this.state.pendingMessages, this.detail.messages)) messages.push({
      id: intent.messageId, conversationId: this.detail.conversation.id, role: "user", text: intent.text,
      delivery: this.state.transmittingId === intent.messageId ? "sending" : this.deliveryErrors.has(intent.messageId) ? "failed" : "not_sent",
      status: "complete", requestId: intent.requestId, runId: null, branchId: null, userLocale: intent.userLocale ?? null,
      createdAt: this.detail.composerDraft.updatedAt, updatedAt: this.detail.composerDraft.updatedAt, error: this.deliveryErrors.get(intent.messageId) ?? null,
    });
    const selectedCourseId = this.detail.artifacts.some((item) => item.courseId === current?.selectedCourseId) ? current!.selectedCourseId : this.detail.artifacts[0]?.courseId ?? null;
    this.publish({ conversation: { ...this.detail.conversation, messages, artifacts: this.detail.artifacts, selectedCourseId } });
  }
  private adopt(detail: ConversationDetail, preserveInput: boolean) {
    if (detail.conversation.ownerId !== this.options.actorId || (this.detail && detail.conversation.id !== this.detail.conversation.id)) throw new Error("The chat belongs to a different account");
    const sameConversation = this.detail?.conversation.id === detail.conversation.id && this.detail.conversation.activeBranchId === detail.conversation.activeBranchId;
    if (!sameConversation) this.actionHistoryPagingStarted = false;
    this.detail = detail;
    if (!preserveInput) this.publish({ composerText: detail.composerDraft.text, pendingMessages: detail.composerDraft.pendingMessages });
    else this.publish({ pendingMessages: unacceptedIntents(this.state.pendingMessages, detail.messages) });
    if (this.sendCommand && detail.messages.some((message) => message.id === this.sendCommand!.messageId && message.clientRequestId === this.sendCommand!.requestId)) this.sendCommand = null;
    const run = detail.activeTurn;
    const stream = run && this.state.stream?.run.id === run.id && this.state.stream.run.branchId === run.branchId ? this.state.stream : run ? createStreamState({ ...run, lastSeq: 0 }, detail.messages, detail.artifacts) : null;
    const actionEvents = mergeActionEvents(detail.conversation.activeBranchId, sameConversation ? this.state.actionEvents : [], detail.retainedActionEvents ?? [], stream?.actionEvents ?? []);
    const actionHistoryNextCursor = sameConversation && this.actionHistoryPagingStarted ? this.state.actionHistoryNextCursor : detail.actionHistoryNextCursor ?? null;
    this.publish({ loadStatus: "ready", run, stream, actionEvents, actionHistoryNextCursor, actionHistoryStatus: "idle" });
    this.project();
    this.options.onIdentity?.(detail.conversation.id, this);
  }

  open(): Promise<void> {
    if (!this.current() || this.detail) return Promise.resolve();
    if (this.opening) return this.opening;
    if (this.requestedId !== null && !IdSchema.safeParse(this.requestedId).success) { this.publish({ loadStatus: "invalid" }); return Promise.resolve(); }
    this.opening = this.openStored().finally(() => { this.opening = null; });
    return this.opening;
  }
  private async openStored() {
    const buffer = this.options.recovery?.read(this.options.actorId, this.requestedId);
    if (buffer) {
      this.createCommand = buffer.createCommand; this.saveCommand = buffer.saveCommand; this.sendCommand = buffer.sendCommand;
      this.publish({ composerText: buffer.text, pendingMessages: buffer.pendingMessages });
      if (buffer.sendCommand) this.deliveryErrors.set(buffer.sendCommand.messageId, transientError(buffer.sendCommand.requestId, "chat.deliveryUnknown"));
    }
    if (this.requestedId === null) { if (buffer) this.markInput(); return; }
    this.publish({ loadStatus: "loading", storageError: null });
    try {
      const result = await this.request((signal) => this.conversations.get(this.requestedId!, signal));
      if (!result.ok) {
        this.publish({ loadStatus: result.error.error.code === "not_found" ? "missing" : "error", storageError: result.error.error });
        return;
      }
      this.adopt(result.data, Boolean(buffer));
      if (buffer && !this.isSaved() && (buffer.conflicted || buffer.baseComposerRevision !== result.data.composerDraft.revision)) {
        this.saveCommand = null;
        this.publish({ composerConflict: result.data.composerDraft, saveStatus: "conflict" });
        this.recovery();
      } else {
        if (this.isSaved()) this.saveCommand = null;
        this.markInput();
        if (buffer && !this.isSaved()) await this.flush();
      }
    } catch { if (this.current()) this.publish({ loadStatus: "error", storageError: transientError(this.createId()) }); }
  }

  setComposer(text: string): void {
    if (!this.current() || this.deleting || this.state.loadStatus !== "ready" || text === this.state.composerText) return;
    if (text.length > MESSAGE_LIMIT) { this.publish({ storageError: { code: "invalid_input", messageKey: "chat.inputTooLarge", retryable: false, requestId: this.createId() }, saveStatus: "error" }); return; }
    this.publish({ composerText: text, storageError: null });
    this.markInput();
    if (this.autosave) clearTimeout(this.autosave);
    this.autosave = this.detail ? setTimeout(() => { this.autosave = null; if (!this.sending) void this.flush(); }, this.options.autosaveDelay ?? 400) : null;
  }

  flush(createForSend = false): Promise<boolean> {
    if (this.autosave) { clearTimeout(this.autosave); this.autosave = null; }
    if (!this.current() || this.deleting || this.delivering || this.state.composerConflict || this.state.loadStatus !== "ready") return Promise.resolve(false);
    // Draft recovery, navigation, and autosave must never create a chat. Only Send may do so.
    if (!this.detail && !createForSend) { this.recovery(); return Promise.resolve(true); }
    if (this.writing) return this.writing;
    this.writing = this.writeLatest().finally(() => { this.writing = null; });
    return this.writing;
  }
  private async writeLatest(): Promise<boolean> {
    try {
      while (this.current() && !this.deleting) {
        if (!this.detail) {
          if (!this.createCommand && !this.state.composerText.trim()) { this.publish({ saveStatus: "idle" }); return true; }
          this.createCommand ??= { key: this.createId(), input: { composerText: this.state.composerText } };
          const command = this.createCommand;
          this.publish({ saveStatus: "saving", storageError: null }); this.recovery();
          const result = await this.request((signal) => this.conversations.create(command.input, command.key, signal));
          if (!result.ok) return this.writeFailure(result.error.error);
          this.adopt(result.data, true);
          this.createCommand = null;
          // Only migrate this session's last buffer; a later new-chat session may own the slot now.
          if (this.provisionalRecovery && this.options.recovery?.read(this.options.actorId, null) === this.provisionalRecovery) {
            this.options.recovery.clear(this.options.actorId, null);
          }
          this.provisionalRecovery = null;
          this.recovery();
          continue;
        }
        if (!this.saveCommand && this.isSaved()) { this.markInput(); return true; }
        this.saveCommand ??= { key: this.createId(), input: { expectedRevision: this.detail.composerDraft.revision, ...this.input() } };
        const command = this.saveCommand;
        if (!SaveComposerInputSchema.safeParse(command.input).success) return this.writeFailure({ code: "invalid_input", messageKey: "chat.inputTooLarge", retryable: false, requestId: command.key });
        const id = this.detail.conversation.id;
        this.publish({ saveStatus: "saving", storageError: null }); this.recovery();
        const result = await this.request((signal) => this.conversations.saveComposer(id, command.input, command.key, signal));
        if (!result.ok) return this.writeFailure(result.error.error);
        if (result.data.conversationId !== id || result.data.revision <= command.input.expectedRevision) throw new Error("Input acknowledgement did not match");
        this.detail = { ...this.detail, composerDraft: result.data };
        const removed = new Set(command.input.pendingMessages.filter((intent) => !result.data.pendingMessages.some((item) => item.messageId === intent.messageId)).map((intent) => intent.messageId));
        this.publish({ pendingMessages: this.state.pendingMessages.filter((intent) => !removed.has(intent.messageId)) });
        this.saveCommand = null; this.project(); this.markInput();
      }
    } catch { if (this.current()) this.publish({ saveStatus: "error", storageError: transientError(this.saveCommand?.key ?? this.createCommand?.key ?? this.createId()) }); }
    return false;
  }
  private async writeFailure(error: ApiError["error"]): Promise<false> {
    this.publish({ storageError: error, saveStatus: "error" });
    if (error.code === "revision_conflict" && this.detail) {
      this.saveCommand = null;
      try {
        const result = await this.request((signal) => this.conversations.get(this.detail!.conversation.id, signal));
        if (result.ok) { this.adopt(result.data, true); this.publish({ composerConflict: result.data.composerDraft, saveStatus: "conflict" }); }
      } catch { /* Both versions remain intact until the next explicit retry. */ }
    }
    this.recovery();
    return false;
  }
  async resolveComposerConflict(choice: "server" | "mine"): Promise<boolean> {
    const server = this.state.composerConflict;
    if (!server || !this.current() || !this.detail) return false;
    this.saveCommand = null;
    this.detail = { ...this.detail, composerDraft: server };
    this.publish({ composerConflict: null, storageError: null, ...(choice === "server" ? { composerText: server.text, pendingMessages: server.pendingMessages, editingMessageId: null } : {}) });
    this.project(); this.markInput();
    return choice === "server" ? true : this.flush();
  }

  async send(): Promise<void> {
    if (!this.current() || this.sending || this.deleting || this.state.stream?.pending || this.state.composerConflict || !this.state.composerText.trim()) return;
    this.sending = true;
    const submittedText = this.state.composerText;
    try {
      // A new chat and the pending intent both need acknowledgement before delivery.
      if (!await this.flush(true) || !this.detail) return;
      const locale = this.options.userLocale?.();
      const intent: PendingUserMessage = { messageId: this.createId(), requestId: this.createId(), text: submittedText,
        ...(locale && ContentLanguageSchema.safeParse(locale).success ? { userLocale: locale } : {}) };
      const editing = this.state.editingMessageId;
      const pendingMessages = editing ? this.state.pendingMessages.map((item) => item.messageId === editing ? intent : item) : [...this.state.pendingMessages, intent];
      const remainingText = this.state.composerText === submittedText ? "" : this.state.composerText;
      if (!SaveComposerInputSchema.safeParse({ expectedRevision: this.detail.composerDraft.revision, text: remainingText, pendingMessages }).success) {
        this.publish({ storageError: { code: "invalid_input", messageKey: "chat.inputTooLarge", retryable: false, requestId: intent.requestId }, saveStatus: "error" }); return;
      }
      this.publish({ composerText: remainingText, pendingMessages, editingMessageId: null }); this.project(); this.markInput();
      if (!await this.flush()) return;
      await this.deliver(intent.messageId);
    } finally { this.sending = false; if (this.current() && !this.state.composerConflict && this.state.saveStatus !== "error") await this.flush(); }
  }
  async retry(messageId: string): Promise<void> {
    if (!this.current() || this.sending || this.state.stream?.pending || this.state.composerConflict) return;
    if (!this.state.pendingMessages.some((item) => item.messageId === messageId)) return;
    this.sending = true;
    try { if (await this.flush()) await this.deliver(messageId); }
    finally { this.sending = false; if (this.current() && !this.state.composerConflict && this.state.saveStatus !== "error") await this.flush(); }
  }
  editMessage(messageId: string): boolean {
    const message = this.state.pendingMessages.find((item) => item.messageId === messageId);
    if (!this.current() || !message || this.sending || this.state.composerText.trim() || this.sendCommand?.messageId === messageId) return false;
    this.publish({ editingMessageId: messageId }); this.setComposer(message.text); return true;
  }
  cancelEdit(): void { this.publish({ editingMessageId: null }); }

  private async deliver(messageId: string): Promise<void> {
    const intent = this.state.pendingMessages.find((item) => item.messageId === messageId);
    if (!this.detail || !intent || !this.current()) return;
    this.sendCommand = this.sendCommand?.messageId === messageId ? this.sendCommand : {
      ...intent, conversationId: this.detail.conversation.id, expectedRevision: this.detail.conversation.revision,
      branchId: this.detail.conversation.activeBranchId, parentMessageId: this.detail.messages.at(-1)?.id ?? null,
    };
    const command = this.sendCommand;
    this.delivering = true;
    this.deliveryErrors.delete(messageId);
    this.publish({ transmittingId: messageId }); this.project(); this.recovery();
    try {
      const result = await this.request((signal) => this.services.sendMessage(command, signal));
      if (!result.ok) {
        this.deliveryErrors.set(messageId, result.error.error);
        // A definite rejection permits a fresh context. Unknown delivery retains the complete command.
        if (result.error.error.code !== "service_unavailable" || result.error.error.messageKey === "generation.unavailable") this.sendCommand = null;
        if (result.error.error.code === "revision_conflict") await this.refreshAfterSend(false);
        return;
      }
      const { message, run } = result.data;
      if (message.id !== intent.messageId || message.clientRequestId !== intent.requestId || message.conversationId !== command.conversationId
        || message.branchId !== command.branchId || message.role !== "user" || run.ownerId !== this.options.actorId || run.inputMessageId !== message.id || run.conversationId !== command.conversationId || run.branchId !== command.branchId) throw new Error("Delivery acknowledgement did not match");
      this.sendCommand = null;
      this.detail = { ...this.detail, messages: this.detail.messages.some((item) => item.id === message.id) ? this.detail.messages : [...this.detail.messages, message], activeTurn: run };
      this.publish({ pendingMessages: this.state.pendingMessages.filter((item) => item.messageId !== messageId), run, stream: createStreamState({ ...run, lastSeq: 0 }, [message], this.detail.artifacts) });
      this.project();
      await this.refreshAfterSend(true);
    } catch { if (this.current()) this.deliveryErrors.set(messageId, transientError(command.requestId, "chat.deliveryUnknown")); }
    finally { this.delivering = false; if (this.current()) { this.publish({ transmittingId: null }); this.project(); this.recovery(); } }
  }
  private async refreshAfterSend(accepted: boolean) {
    if (!this.detail) return;
    const result = await this.request((signal) => this.conversations.get(this.detail!.conversation.id, signal));
    if (!result.ok) { this.publish({ saveStatus: "error", storageError: result.error.error }); return; }
    const old = this.detail.composerDraft;
    this.adopt(result.data, true);
    const knownPending = unacceptedIntents(old.pendingMessages, result.data.messages);
    // The accepted send removes its intent but never changes text. Other edits require a choice.
    if (!sameInput({ text: old.text, pendingMessages: knownPending }, result.data.composerDraft) && !this.isSaved()) {
      this.publish({ composerConflict: result.data.composerDraft, saveStatus: "conflict" });
    } else if (!accepted && this.sendCommand && result.data.messages.some((item) => item.id === this.sendCommand!.messageId)) this.sendCommand = null;
    this.markInput();
  }

  async rename(title: string): Promise<boolean> {
    title = title.trim();
    if (!this.current() || !title || title.length > 120 || this.sending || this.deleting || !await this.flush() || !this.detail) return false;
    const id = this.detail.conversation.id;
    if (this.mutation?.kind !== "rename" || this.mutation.title !== title) this.mutation = { kind: "rename", title, key: this.createId(), revision: this.detail.conversation.revision };
    const command = this.mutation;
    try {
      const result = await this.request((signal) => this.conversations.rename(id, { title, expectedRevision: command.revision }, command.key, signal));
      if (!result.ok) { this.publish({ storageError: result.error.error }); if (result.error.error.code === "revision_conflict") { this.mutation = null; await this.refreshAfterSend(false); } return false; }
      if (result.data.id !== id || result.data.ownerId !== this.options.actorId) throw new Error("Rename acknowledgement did not match");
      this.detail = { ...this.detail, conversation: result.data }; this.mutation = null; this.project(); return true;
    } catch { if (this.current()) this.publish({ storageError: transientError(command.key) }); return false; }
  }
  async remove(): Promise<boolean> {
    if (!this.current() || !this.detail || this.sending || this.deleting) return false;
    if (this.writing) await this.writing;
    if (!this.current() || !this.detail) return false;
    this.deleting = true;
    const id = this.detail.conversation.id;
    if (this.mutation?.kind !== "remove") this.mutation = { kind: "remove", key: this.createId(), revision: this.detail.conversation.revision };
    const command = this.mutation;
    try {
      const result = await this.request((signal) => this.conversations.remove(id, { expectedRevision: command.revision }, command.key, signal));
      if (!result.ok) { this.publish({ storageError: result.error.error }); if (result.error.error.code === "revision_conflict") { this.mutation = null; await this.refreshAfterSend(false); } return false; }
      this.options.recovery?.clear(this.options.actorId, id);
      this.detail = null; this.mutation = null;
      this.actionHistoryPagingStarted = false;
      this.publish({ conversation: null, composerText: "", pendingMessages: [], loadStatus: "missing", saveStatus: "idle", storageError: null, run: null, stream: null,
        actionEvents: [], actionHistoryNextCursor: null, actionHistoryStatus: "idle" });
      return true;
    } catch { if (this.current()) this.publish({ storageError: transientError(command.key) }); return false; }
    finally { this.deleting = false; }
  }

  selectCourse(courseId: string): void {
    const conversation = this.state.conversation;
    if (!conversation?.artifacts.some((item) => item.courseId === courseId)) return;
    this.publish({ conversation: { ...conversation, selectedCourseId: courseId } });
  }
  async loadEarlierActivity(): Promise<boolean> {
    const cursor = this.state.actionHistoryNextCursor;
    if (!this.current() || !this.detail || !cursor || this.state.actionHistoryStatus === "loading") return false;
    const conversationId = this.detail.conversation.id;
    const branchId = this.detail.conversation.activeBranchId;
    const revision = this.detail.conversation.revision;
    this.actionHistoryPagingStarted = true;
    this.publish({ actionHistoryStatus: "loading" });
    try {
      const result = await this.request((signal) => this.conversations.getActions(conversationId, { cursor, limit: 50 }, signal));
      if (!result.ok) { this.publish({ actionHistoryStatus: "error" }); return false; }
      const current = this.detail?.conversation;
      if (!current || current.id !== conversationId || current.ownerId !== this.options.actorId || current.activeBranchId !== branchId || current.revision !== revision) {
        this.publish({ actionHistoryStatus: "idle" }); return false;
      }
      if (result.data.conversationId !== conversationId || result.data.branchId !== branchId) {
        this.publish({ actionHistoryStatus: "error" }); return false;
      }
      this.publish({ actionEvents: mergeActionEvents(branchId, result.data.items, this.state.actionEvents),
        actionHistoryNextCursor: result.data.nextCursor, actionHistoryStatus: "idle" });
      return true;
    } catch (error) {
      if (this.current() && !(error instanceof Error && error.name === "AbortError")) this.publish({ actionHistoryStatus: "error" });
      return false;
    }
  }
  async updateArtifact(artifact: CourseArtifactRef): Promise<boolean> {
    const existing = this.detail?.artifacts.find((item) => item.courseId === artifact.courseId);
    if (!this.current() || !this.detail || !existing || artifact.revision < existing.revision) return false;
    this.detail = { ...this.detail, artifacts: this.detail.artifacts.map((item) => item.courseId === artifact.courseId ? artifact : item) };
    if (this.state.stream) {
      const approvalRequired = { ...this.state.stream.approvalRequired };
      if (artifact.curriculum && artifact.approvalRequestedRevision === artifact.curriculum.revision && !artifact.approval) approvalRequired[artifact.courseId] = { id: artifact.curriculum.id, revision: artifact.curriculum.revision };
      else delete approvalRequired[artifact.courseId];
      this.publish({ stream: { ...this.state.stream, artifacts: this.detail.artifacts, approvalRequired } });
    }
    this.project(); return true;
  }
  async acknowledgeApproval(courseId: string, approval: CurriculumApproval): Promise<boolean> {
    const artifact = this.detail?.artifacts.find((item) => item.courseId === courseId);
    if (!artifact?.curriculum) return false;
    await assertCurrentApproval(artifact.curriculum, approval);
    const current = this.detail?.artifacts.find((item) => item.courseId === courseId);
    if (!this.current() || !current?.curriculum || current.curriculum.id !== approval.draftId || current.curriculum.revision !== approval.draftRevision) return false;
    return this.updateArtifact({ ...current, approval, approvalRequestedRevision: null });
  }
  receiveSnapshot(snapshot: RunSnapshot): void {
    const current = this.state.stream;
    if (!this.current() || !this.detail || !current || snapshot.run.ownerId !== this.options.actorId || snapshot.run.conversationId !== this.detail.conversation.id
      || snapshot.run.id !== current.run.id || snapshot.run.branchId !== current.run.branchId) return;
    this.applyStream(creatorStreamReducer(current, { type: "snapshot", snapshot }));
  }
  resumeRun(previousRunId: string, snapshot: RunSnapshot): boolean {
    const current = this.state.stream;
    if (!this.current() || !this.detail || !current || current.run.id !== previousRunId || current.pending
      || !["failed", "cancelled"].includes(current.run.status) || snapshot.run.ownerId !== this.options.actorId
      || snapshot.run.conversationId !== this.detail.conversation.id || snapshot.run.branchId !== current.run.branchId
      || snapshot.run.inputMessageId !== current.run.inputMessageId
      || (snapshot.run.id === previousRunId && snapshot.lastSeq <= current.lastAppliedSeq)) return false;
    const base = snapshot.run.id === previousRunId ? current : createStreamState({ ...snapshot.run, lastSeq: 0 }, [], current.artifacts);
    const resumed = creatorStreamReducer(base, { type: "snapshot", snapshot });
    if (resumed === current) return false;
    this.applyStream(resumed);
    return true;
  }
  restoreSnapshot(snapshot: RunSnapshot): void {
    if (!this.current() || !this.detail || this.sending || snapshot.run.id !== this.detail.activeTurn?.id
      || snapshot.run.ownerId !== this.options.actorId || snapshot.run.conversationId !== this.detail.conversation.id || snapshot.run.branchId !== this.detail.conversation.activeBranchId) return;
    this.applyStream(creatorStreamReducer(createStreamState({ ...snapshot.run, lastSeq: 0 }, [], this.detail.artifacts), { type: "snapshot", snapshot }));
  }
  receiveEvent(event: ChatEvent): void {
    if (this.current() && this.state.stream) this.applyStream(creatorStreamReducer(this.state.stream, { type: "event", event }));
  }
  private applyStream(stream: CreatorStreamState): void {
    if (!this.detail || this.state.stream === stream) return;
    const messages: ChatMessage[] = [...this.detail.messages];
    for (const incoming of stream.messages) {
      const index = messages.findIndex((item) => item.id === incoming.id);
      if (index < 0) messages.push(incoming); else messages[index] = incoming;
    }
    this.detail = { ...this.detail, messages, artifacts: stream.artifacts, activeTurn: stream.run };
    this.publish({ stream, run: stream.run, pendingMessages: unacceptedIntents(this.state.pendingMessages, messages),
      actionEvents: mergeActionEvents(this.detail.conversation.activeBranchId, this.state.actionEvents, stream.actionEvents) }); this.project();
  }
}

export function chatStorageMessage(error: ApiError["error"] | null): string {
  if (error?.code === "not_found") return "This chat is no longer available. Your unsaved text is still here.";
  if (error?.code === "unauthenticated") return "Sign in again to save your changes. Your text is still here.";
  if (error?.messageKey === "chat.inputTooLarge" || error?.code === "invalid_input") return "This chat can hold up to 100 unsent messages and 2 MB of saved input. Your existing text has been kept.";
  if (error?.code === "revision_conflict") return "This chat changed in another session. Your text has been kept.";
  return "Your changes haven’t reached your account yet. Keep this page open and retry saving.";
}
