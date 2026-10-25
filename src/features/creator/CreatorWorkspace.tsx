"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ArrowUp, Check, MessageSquare } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Button, Dialog, IconButton, LinkButton, Menu, Notice, Tabs, Textarea, TextField } from "@/components/ui";
import type { ApplicationPort } from "@/application/ports";
import { httpApplication } from "@/application/http-application";
import { httpConversations } from "@/application/http-conversations";
import type { ConversationPort } from "@/application/conversation-port";
import type { ChatStore, EditCourseMetadata } from "@/domain/chat";
import type { Conversation as SavedConversation, RunSnapshot } from "@/domain/generation";
import { useAccountSession, refreshAccount } from "@/features/account/account-session";
import { accountScope } from "@/features/account/account-scope";
import { chatStore } from "@/lib/chats";
import { routes } from "@/lib/routes";
import { ChatSession, chatStorageMessage, MESSAGE_LIMIT } from "./chat-session";
import { tabChatRecovery } from "./chat-recovery";
import { Conversation } from "./Conversation";
import { CourseArtifactsPanel } from "./CourseArtifactsPanel";
import type { ApproveCurriculum } from "./CurriculumPanel";
import { chatScenarios } from "./scenarios";
import { LegacyChatImport } from "./LegacyChatImport";
import "./creator.css";

const sessions = new Map<string, WeakMap<ConversationPort, WeakMap<ApplicationPort, Map<string, ChatSession>>>>();
function sessionFor(actorId: string, conversations: ConversationPort, services: ApplicationPort, id: string | null): ChatSession {
  let byPort = sessions.get(actorId);
  if (!byPort) {
    byPort = new WeakMap(); sessions.set(actorId, byPort);
    accountScope.onClear(actorId, () => { sessions.delete(actorId); });
  }
  let byService = byPort.get(conversations);
  if (!byService) { byService = new WeakMap(); byPort.set(conversations, byService); }
  let byId = byService.get(services);
  if (!byId) { byId = new Map(); byService.set(services, byId); }
  const existing = id ? byId.get(id) : undefined;
  if (existing) return existing;
  const registry = byId;
  const session = new ChatSession(conversations, services, id, { actorId, recovery: tabChatRecovery,
    userLocale: () => typeof navigator === "undefined" ? undefined : navigator.language,
    onIdentity: (conversationId, current) => { registry.set(conversationId, current); },
  });
  if (id) registry.set(id, session);
  return session;
}

const compactQuery = "(max-width: 1279px)";
function subscribeCompact(listener: () => void) {
  const query = window.matchMedia(compactQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export interface CreatorWorkspaceProps {
  conversationId?: string | null;
  store?: ChatStore;
  conversations?: ConversationPort;
  services?: ApplicationPort;
  initialSnapshot?: RunSnapshot;
  onApprove?: ApproveCurriculum;
  onEditMetadata?: EditCourseMetadata;
}

export function CreatorWorkspace(props: CreatorWorkspaceProps) {
  const account = useAccountSession();
  const searchParams = useSearchParams();
  if (account.status !== "ready" || !account.session) {
    const returnTo = `/chat${searchParams?.size ? `?${searchParams}` : ""}`;
    return <AppShell active="chat"><div className="creator-recovery">
      <h1>{account.status === "loading" ? "Opening your workspace…" : account.status === "error" ? "Your account couldn’t be checked" : "Keep your learning conversations together"}</h1>
      {account.status === "error" ? <><p>Try again to open your saved chats.</p><Button onClick={() => void refreshAccount()}>Try again</Button></> : account.status === "ready" ? <><p>Sign in to save your chats and continue them on another device. Older browser chats can be imported after you sign in.</p><div><LinkButton href={routes.login(returnTo)}>Sign in</LinkButton><LinkButton variant="secondary" href={routes.signup(returnTo)}>Create account</LinkButton></div></> : null}
    </div></AppShell>;
  }
  return <AccountCreator key={account.session.identity.id} {...props} actorId={account.session.identity.id} />;
}

function AccountCreator({ actorId, conversationId = null, store = chatStore, conversations = httpConversations, services = httpApplication, initialSnapshot, onApprove, onEditMetadata }: CreatorWorkspaceProps & { actorId: string }) {
  const searchParams = useSearchParams();
  const routeId = searchParams?.getAll("conversation").length > 1 ? "invalid" : searchParams?.get("conversation") ?? conversationId;
  const [previousRouteId, setPreviousRouteId] = useState(routeId);
  const [session, setSession] = useState(() => sessionFor(actorId, conversations, services, routeId));
  // Native URL canonicalization keeps this composer mounted. A later New chat navigation creates a fresh session.
  if (previousRouteId !== routeId) {
    setPreviousRouteId(routeId);
    if (routeId !== session.getSnapshot().conversation?.id) setSession(sessionFor(actorId, conversations, services, routeId));
  }
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const compact = useSyncExternalStore(subscribeCompact, () => window.matchMedia(compactQuery).matches, () => false);
  const [history, setHistory] = useState<SavedConversation[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyPending, setHistoryPending] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [panel, setPanel] = useState("chat");
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [renamedTitle, setRenamedTitle] = useState("");
  const [dialogPending, setDialogPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [replaceScenario, setReplaceScenario] = useState<(typeof chatScenarios)[number] | null>(null);
  const [editNotice, setEditNotice] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restored = useRef(false);
  const conversation = state.conversation;
  const hasMessages = Boolean(conversation?.messages.length);
  const artifacts = conversation?.artifacts ?? [];
  const hasArtifacts = artifacts.length > 0;
  const pending = state.transmittingId !== null || Boolean(state.stream?.pending);
  const composerText = state.composerText;

  useEffect(() => {
    void session.open();
    const flush = () => { void session.flush(); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [session]);

  useEffect(() => {
    if (!conversation?.id || window.location.pathname !== "/chat") return;
    const current = new URL(window.location.href).searchParams.get("conversation");
    if (current === null) window.history.replaceState(null, "", routes.chat(conversation.id));
  }, [conversation?.id]);

  useEffect(() => {
    if (state.saveStatus === "saving") return;
    const request = accountScope.request(actorId);
    void conversations.list({}, request.signal).then((result) => {
      if (!request.isCurrent()) return;
      if (result.ok && result.data.items.every((item) => item.ownerId === actorId)) { setHistory(result.data.items); setHistoryCursor(result.data.nextCursor); setHistoryError(false); }
      else setHistoryError(true);
    }).catch(() => { if (request.isCurrent()) setHistoryError(true); }).finally(request.release);
    return request.abort;
  }, [actorId, conversations, state.saveStatus, conversation?.id, conversation?.title]);

  async function loadMoreHistory() {
    if (!historyCursor || historyPending) return;
    const request = accountScope.request(actorId);
    setHistoryPending(true);
    try {
      const result = await conversations.list({ cursor: historyCursor }, request.signal);
      if (!request.isCurrent()) return;
      if (result.ok && result.data.items.every((item) => item.ownerId === actorId)) {
        setHistory((current) => [...current, ...result.data.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
        setHistoryCursor(result.data.nextCursor); setHistoryError(false);
      } else setHistoryError(true);
    } catch { if (request.isCurrent()) setHistoryError(true); }
    finally { if (request.isCurrent()) setHistoryPending(false); request.release(); }
  }

  useEffect(() => {
    if (!initialSnapshot || !conversation || restored.current || state.loadStatus !== "ready") return;
    restored.current = true;
    session.restoreSnapshot(initialSnapshot);
  }, [session, initialSnapshot, conversation, state.loadStatus]);

  function applyScenario(scenario: (typeof chatScenarios)[number]) {
    if (composerText.trim()) { setReplaceScenario(scenario); return; }
    session.setComposer(scenario.text);
    inputRef.current?.focus();
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!pending) void session.send();
    }
  }

  async function confirmDialog() {
    if (dialogPending) return;
    setDialogPending(true);
    setDialogError(null);
    const success = dialog === "rename" ? await session.rename(renamedTitle) : await session.remove();
    setDialogPending(false);
    if (!success) { setDialogError("The change couldn’t be saved. Try again."); return; }
    if (dialog === "delete") window.location.assign(routes.chat());
    else setDialog(null);
  }

  const visibleHistory = conversation ? [conversation, ...history.filter((item) => item.id !== conversation.id)] : history;
  const historyPanel = <section className="creator-history" aria-label="Chat history"><h2>Your chats</h2>
    {visibleHistory.length > 0 ? <ul>{visibleHistory.map((item) => <li key={item.id}><Link href={routes.chat(item.id)} aria-current={conversation?.id === item.id ? "page" : undefined} title={item.title} onClick={() => { void session.flush(); }}><MessageSquare size={16} aria-hidden="true" /><span>{item.title}</span></Link></li>)}</ul> : <p className="creator-history__empty">{historyError ? "Chat history couldn’t be loaded." : "Your conversations will appear here."}</p>}
    {historyError && visibleHistory.length > 0 && <p className="creator-history__issue" role="status">The rest of your chat history couldn’t be loaded. Your current conversation is still here.</p>}
    {historyCursor && <Button variant="quiet" size="compact" pending={historyPending} onClick={() => void loadMoreHistory()}>Load more chats</Button>}
    <LegacyChatImport actorId={actorId} store={store} conversations={conversations} initialSourceId={searchParams?.get("import") ?? null} onImported={(id) => { void session.flush().finally(() => window.location.assign(routes.chat(id))); }} />
  </section>;

  const chat = <section className={`creator-chat${hasMessages ? " creator-chat--conversation" : ""}`} aria-label="Chat">
    {!hasMessages && <div className="creator-introduction"><h1>What would you like to learn?</h1></div>}
    {hasMessages && <Conversation messages={conversation?.messages ?? []} actionEvents={state.stream?.actionEvents ?? []} pending={pending} transmittingId={state.transmittingId}
      interrupted={state.run?.status === "cancelled" || state.run?.status === "failed"} active={!compact || !hasArtifacts || panel === "chat"}
      onRetry={(id) => { void session.retry(id); }} onEdit={(id) => { if (session.editMessage(id)) { setEditNotice(false); inputRef.current?.focus(); } else setEditNotice(true); }} />}
    <div className="creator-writing">
      {state.editingMessageId && <div className="creator-editing"><span>Editing an unsent message</span><Button variant="quiet" size="compact" onClick={() => session.cancelEdit()}>Cancel edit</Button></div>}
      <form className="creator-composer" onSubmit={(event) => { event.preventDefault(); void session.send(); }}>
        <Textarea ref={inputRef} id="chat-message" className="creator-composer__field" label="Message" placeholder="Ask a question or describe what you want to learn…" value={composerText}
          maxLength={MESSAGE_LIMIT} rows={hasMessages ? 2 : 4} onChange={(event) => session.setComposer(event.target.value)} onKeyDown={onComposerKey} />
        <div className="creator-composer__toolbar"><span className="creator-composer__shortcut">Shift + Enter for a new line</span><IconButton type="submit" variant="primary" className="creator-composer__send" label={state.editingMessageId ? "Send edited message" : "Send message"} icon={<ArrowUp size={22} strokeWidth={2} />} pending={state.transmittingId !== null} disabled={!composerText.trim() || pending || Boolean(state.composerConflict)} /></div>
      </form>
      <div className="creator-feedback">
        {composerText.length >= MESSAGE_LIMIT && <p className="creator-composer__limit" role="status">This message has reached the {MESSAGE_LIMIT.toLocaleString("en-US")} character limit.</p>}
        {state.saveStatus === "error" && <Notice tone="error"><p>{chatStorageMessage(state.storageError)}</p><Button variant="quiet" size="compact" onClick={() => void session.flush()}>Retry saving</Button></Notice>}
        {state.composerConflict && <Notice tone="warning"><p>Your saved input changed in another session. Both versions have been kept.</p><Button variant="quiet" size="compact" onClick={() => setConflictOpen(true)}>Review both versions</Button></Notice>}
        {editNotice && <Notice tone="info">Finish your current message first. If delivery wasn’t confirmed, retry that message before editing it.</Notice>}
      </div>
      {!hasMessages && <div className="creator-scenarios" aria-label="Ideas to start with">{chatScenarios.map((scenario) => <button type="button" className="creator-scenario" key={scenario.id} onClick={() => applyScenario(scenario)}><strong>{scenario.title}</strong><span>{scenario.preview}</span></button>)}</div>}
    </div>
  </section>;

  const courses = <CourseArtifactsPanel artifacts={artifacts} selectedCourseId={conversation?.selectedCourseId ?? null} onSelect={(id) => session.selectCourse(id)}
    getCurrentArtifact={(id) => session.getSnapshot().conversation?.artifacts.find((artifact) => artifact.courseId === id)} onArtifactChange={(artifact) => session.updateArtifact(artifact)}
    onApproval={(courseId, approval) => session.acknowledgeApproval(courseId, approval)} awaitingSnapshotCourseIds={state.stream?.pendingSnapshotCourseIds ?? []}
    {...(onApprove ? { onApprove } : {})} {...(onEditMetadata ? { onEditMetadata } : {})} />;

  const ready = state.loadStatus === "ready";
  return <AppShell active="chat" sidebarContent={historyPanel}>
    <div className={`creator${hasArtifacts ? " creator--with-artifacts" : ""}`}>
      {ready ? <><header className="creator-header"><div className="creator-header__title"><p>{conversation?.title ?? "New chat"}</p><div className={`creator-save-status creator-save-status--${state.saveStatus}`} role="status">{state.saveStatus === "saved" && <Check size={14} aria-hidden="true" />}{state.saveStatus === "saved" ? "Saved to your account" : state.saveStatus === "saving" ? "Saving…" : state.saveStatus === "error" ? "Couldn’t save" : state.saveStatus === "conflict" ? "Review saved input" : ""}</div></div>
        {conversation && <Menu label="Chat options" items={[{ id: "rename", label: "Rename chat", onSelect: () => { setRenamedTitle(conversation.title); setDialog("rename"); setDialogError(null); } }, { id: "delete", label: "Delete chat", danger: true, onSelect: () => { setDialog("delete"); setDialogError(null); } }]} />}
      </header><div className="creator-workspace">{hasArtifacts ? <Tabs className="creator-panels" label="Chat and courses" value={panel} onValueChange={setPanel} items={[{ id: "chat", label: "Conversation", panel: chat }, { id: "courses", label: `Courses (${artifacts.length})`, panel: courses }]} /> : chat}</div></> : <div className="creator-recovery">
        <h1>{state.loadStatus === "loading" ? "Opening your chat…" : state.loadStatus === "invalid" ? "This chat link isn’t valid" : state.loadStatus === "missing" ? "This chat isn’t available" : "This chat couldn’t be opened"}</h1>
        {state.loadStatus !== "loading" && <><p>{state.loadStatus === "missing" ? "It may have been deleted or belong to another account." : state.loadStatus === "invalid" ? "Open a chat from your history or start a new one." : chatStorageMessage(state.storageError)}</p>
          {(composerText || state.pendingMessages.length > 0) && <div className="creator-recovered-input"><strong>Your recovered input</strong><pre>{[...state.pendingMessages.map((item) => item.text), composerText].filter(Boolean).join("\n\n")}</pre></div>}
          <div><LinkButton href={routes.chat()}>New chat</LinkButton>{state.loadStatus === "error" && <Button variant="secondary" onClick={() => void session.open()}>Try again</Button>}</div></>}
      </div>}
    </div>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !dialogPending) setDialog(null); }} title={dialog === "delete" ? "Delete this chat?" : "Rename chat"}
      footer={<><Button variant="quiet" onClick={() => setDialog(null)} disabled={dialogPending}>Cancel</Button><Button variant={dialog === "delete" ? "danger" : "primary"} pending={dialogPending} disabled={dialog === "rename" && !renamedTitle.trim()} onClick={() => void confirmDialog()}>{dialog === "delete" ? "Delete chat" : "Rename"}</Button></>}>
      {dialog === "delete" ? <p>This removes this conversation from your account. Courses created in it stay in your library.</p> : <TextField id="chat-title" label="Chat name" value={renamedTitle} maxLength={120} onChange={(event) => setRenamedTitle(event.target.value)} />}{dialogError && <Notice tone="error">{dialogError}</Notice>}
    </Dialog>
    <Dialog open={replaceScenario !== null} onOpenChange={(open) => { if (!open) setReplaceScenario(null); }} title="Replace your current message?" footer={<><Button variant="quiet" onClick={() => setReplaceScenario(null)}>Keep my message</Button><Button onClick={() => { if (replaceScenario) session.setComposer(replaceScenario.text); setReplaceScenario(null); inputRef.current?.focus(); }}>Use this idea</Button></>}><p>Your current message hasn’t been sent. This will replace it with an idea you can edit.</p></Dialog>
    <Dialog open={conflictOpen && state.composerConflict !== null} onOpenChange={setConflictOpen} title="Choose which input to keep"
      footer={<><Button variant="secondary" onClick={() => { void session.resolveComposerConflict("server").then(() => setConflictOpen(false)); }}>Use saved input</Button><Button onClick={() => { void session.resolveComposerConflict("mine").then(() => setConflictOpen(false)); }}>Save my input instead</Button></>}>
      <div className="creator-conflict"><p>This choice replaces the other version of the unfinished input and unsent messages.</p>
        <section><h3>Saved in your account</h3><pre>{[...(state.composerConflict?.pendingMessages.map((item) => item.text) ?? []), state.composerConflict?.text].filter(Boolean).join("\n\n") || "No unfinished input"}</pre></section>
        <section><h3>Your input on this page</h3><pre>{[...state.pendingMessages.map((item) => item.text), composerText].filter(Boolean).join("\n\n") || "No unfinished input"}</pre></section>
      </div>
    </Dialog>
  </AppShell>;
}
