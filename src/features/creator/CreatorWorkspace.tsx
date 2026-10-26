"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Check, MessageSquare, Square } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Button, Dialog, IconButton, LinkButton, Menu, Notice, Textarea, TextField } from "@/components/ui";
import { nextTabId } from "@/components/ui/tabs";
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
import { cancelRun, getRunSnapshot, readRunEvents, retryRun } from "./run-observer-client";
import { useConversationBuilds } from "./use-conversation-builds";
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
function observerPause(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, delay);
    function done() { window.clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}
function subscribeCompact(listener: () => void) {
  const query = window.matchMedia(compactQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function CreatorPanels({ compact, value, onValueChange, chat, courses, courseCount }: {
  compact: boolean; value: string; onValueChange: (value: string) => void;
  chat: ReactNode; courses: ReactNode; courseCount: number;
}) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef(new Map<string, HTMLDivElement>());
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousCompact = useRef(compact);
  const items = [{ id: "chat", label: "Conversation", content: chat }, { id: "courses", label: `Courses (${courseCount})`, content: courses }];

  useLayoutEffect(() => {
    if (previousCompact.current === compact) return;
    previousCompact.current = compact;
    const active = document.activeElement;
    if (compact) {
      for (const [panelId, panelElement] of panelRefs.current) {
        if (panelElement.contains(active)) { onValueChange(panelId); break; }
      }
    } else if (listRef.current?.contains(active)) {
      panelRefs.current.get(value)?.focus({ preventScroll: true });
    }
  }, [compact, onValueChange, value]);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, current: string) {
    const next = nextTabId(items, current, event.key);
    if (!next) return;
    event.preventDefault();
    onValueChange(next);
    buttonRefs.current.get(next)?.focus({ preventScroll: true });
  }

  return <div className="creator-panels uf-tabs">
    <div ref={listRef} className="uf-tabs__list" role="tablist" aria-label="Chat and courses" hidden={!compact}>
      {items.map((item) => <button key={item.id} ref={(node) => { if (node) buttonRefs.current.set(item.id, node); else buttonRefs.current.delete(item.id); }}
        id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`} className="uf-tabs__tab" role="tab" type="button"
        aria-selected={item.id === value} tabIndex={item.id === value ? 0 : -1}
        onClick={() => onValueChange(item.id)} onKeyDown={(event) => onTabKey(event, item.id)}>{item.label}</button>)}
    </div>
    {items.map((item) => <div key={item.id} ref={(node) => { if (node) panelRefs.current.set(item.id, node); else panelRefs.current.delete(item.id); }}
      id={`${id}-panel-${item.id}`} className="uf-tabs__panel" role={compact ? "tabpanel" : "region"}
      aria-labelledby={compact ? `${id}-tab-${item.id}` : undefined} aria-label={compact ? undefined : item.label}
      tabIndex={compact ? 0 : -1} hidden={compact && item.id !== value}>{item.content}</div>)}
  </div>;
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
  const [runConnectionError, setRunConnectionError] = useState(false);
  const [runCancelPending, setRunCancelPending] = useState(false);
  const [runCancelError, setRunCancelError] = useState(false);
  const [runRetryPending, setRunRetryPending] = useState(false);
  const [runRetryError, setRunRetryError] = useState(false);
  const runRetryKeys = useRef(new Map<string, string>());
  const terminalSnapshotSeq = useRef(new Map<string, number>());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restored = useRef(false);
  const conversation = state.conversation;
  const hasMessages = Boolean(conversation?.messages.length);
  const artifacts = conversation?.artifacts ?? [];
  const hasArtifacts = artifacts.length > 0;
  const pending = state.transmittingId !== null || Boolean(state.stream?.pending);
  const composerText = state.composerText;
  const observedRunId = state.stream?.run.id ?? null;
  const observedRunStatus = state.stream?.run.status ?? null;
  const builds = useConversationBuilds(actorId, conversation?.id, conversation?.activeBranchId, conversations, detail => {
    for (const artifact of detail.artifacts) {
      const current = session.getSnapshot().conversation?.artifacts.find(item => item.courseId === artifact.courseId);
      if (current && (artifact.revision < current.revision || (artifact.revision === current.revision
        && ((current.approval && artifact.approval?.id !== current.approval.id) || (current.readyVersionId && artifact.readyVersionId !== current.readyVersionId))))) continue;
      void session.updateArtifact(artifact);
    }
  });
  const approvedBuildsKey = artifacts.map(artifact => artifact.approval?.id ?? "").join(":");
  useEffect(() => { if (approvedBuildsKey) void builds.controller?.refresh(); }, [builds.controller, approvedBuildsKey]);

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

  useEffect(() => {
    if (!observedRunId) return;
    const runId = observedRunId;
    const initial = session.getSnapshot().stream;
    if (!initial || initial.run.id !== runId) return;
    if (!initial.pending && (terminalSnapshotSeq.current.get(runId) ?? -1) >= initial.lastAppliedSeq) return;
    const request = accountScope.request(actorId);
    const observe = async () => {
      let repair = true;
      let reconnectDelay = 750;
      while (request.isCurrent()) {
        const current = session.getSnapshot().stream;
        if (!current || current.run.id !== runId) return;
        try {
          if (!current.pending) {
            const snapshot = await getRunSnapshot(runId, request.signal);
            session.receiveSnapshot(snapshot);
            const hydrated = session.getSnapshot().stream;
            if (!hydrated || hydrated.run.id !== runId || hydrated.lastAppliedSeq < snapshot.lastSeq) throw new Error("run_snapshot_scope");
            if (!hydrated.pending) terminalSnapshotSeq.current.set(runId, hydrated.lastAppliedSeq);
            setRunConnectionError(false);
            return;
          }
          if (repair || current.needsSnapshot || current.replayAfterSeq !== null) {
            const snapshot = await getRunSnapshot(runId, request.signal);
            session.receiveSnapshot(snapshot);
            const repaired = session.getSnapshot().stream;
            if (!repaired || repaired.run.id !== runId || repaired.lastAppliedSeq < snapshot.lastSeq) throw new Error("run_snapshot_scope");
            repair = false;
          }
          const ready = session.getSnapshot().stream;
          if (!ready || ready.run.id !== runId) return;
          if (!ready.pending) {
            terminalSnapshotSeq.current.set(runId, ready.lastAppliedSeq);
            setRunConnectionError(false);
            return;
          }
          let snapshotRequired = false;
          await readRunEvents(runId, ready.lastAppliedSeq, request.signal, {
            onEvent(event) { session.receiveEvent(event); },
            onSnapshotRequired() { snapshotRequired = true; },
          });
          if (!request.isCurrent()) return;
          setRunConnectionError(false);
          reconnectDelay = 750;
          const updated = session.getSnapshot().stream;
          if (updated && updated.run.id === runId && !updated.pending) continue;
          repair = snapshotRequired || Boolean(updated?.needsSnapshot || updated?.replayAfterSeq !== null);
        } catch (error) {
          if (!request.isCurrent() || (error instanceof Error && error.name === "AbortError")) return;
          setRunConnectionError(true);
          await observerPause(request.signal, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 12_000);
          repair = true;
        }
      }
    };
    void observe().finally(request.release);
    return request.abort;
  }, [actorId, observedRunId, observedRunStatus, session]);

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

  async function retryFailedRun() {
    const run = session.getSnapshot().stream?.run;
    if (!run || !["failed", "cancelled"].includes(run.status) || runRetryPending) return;
    const key = runRetryKeys.current.get(run.id) ?? crypto.randomUUID();
    runRetryKeys.current.set(run.id, key);
    setRunRetryPending(true); setRunRetryError(false);
    const request = accountScope.request(actorId);
    try {
      const snapshot = await retryRun(run.id, key, request.signal);
      if (!request.isCurrent() || !session.resumeRun(run.id, snapshot)) throw new Error("run_retry_scope");
      runRetryKeys.current.delete(run.id);
      setRunConnectionError(false);
    } catch (error) {
      if (request.isCurrent() && !(error instanceof Error && error.name === "AbortError")) setRunRetryError(true);
    } finally {
      if (request.isCurrent()) setRunRetryPending(false);
      request.release();
    }
  }

  async function stopActiveRun() {
    const run = session.getSnapshot().stream?.run;
    if (!run || !["queued", "running"].includes(run.status) || runCancelPending) return;
    setRunCancelPending(true); setRunCancelError(false);
    const request = accountScope.request(actorId);
    const matches = (snapshot: RunSnapshot) => snapshot.run.id === run.id && snapshot.run.ownerId === actorId
      && snapshot.run.conversationId === run.conversationId && snapshot.run.branchId === run.branchId
      && snapshot.run.inputMessageId === run.inputMessageId;
    try {
      let snapshot: RunSnapshot;
      try { snapshot = await cancelRun(run.id, request.signal); }
      catch (error) {
        if (!request.isCurrent() || (error instanceof Error && error.name === "AbortError")) throw error;
        snapshot = await getRunSnapshot(run.id, request.signal);
      }
      if (!request.isCurrent() || !matches(snapshot)) throw new Error("run_cancel_scope");
      if (session.getSnapshot().stream?.run.id !== run.id) throw new Error("run_cancel_stale");
      session.receiveSnapshot(snapshot);
      const reconciled = session.getSnapshot().stream?.run;
      if (!reconciled || reconciled.id !== run.id || reconciled.status !== snapshot.run.status) throw new Error("run_cancel_unconfirmed");
      if (["queued", "running"].includes(reconciled.status)) setRunCancelError(true);
    } catch (error) {
      if (request.isCurrent() && !(error instanceof Error && error.name === "AbortError")) setRunCancelError(true);
    } finally {
      if (request.isCurrent()) setRunCancelPending(false);
      request.release();
    }
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
    {hasMessages && <Conversation messages={conversation?.messages ?? []} actionEvents={state.actionEvents} currentRunId={state.stream?.run.id ?? null} pending={pending} transmittingId={state.transmittingId}
      builds={builds.state.builds} buildInteraction={{ actorId,
        showCourseLabels: new Set(builds.state.builds.map(build => build.courseId)).size > 1,
        onCommand: (approvalId, kind) => { void builds.controller?.command(approvalId, kind); },
        onEarlier: runId => { void builds.controller?.earlier(runId); },
        onViewProgram: courseId => { session.selectCourse(courseId); setPanel("courses"); } }}
      hasEarlierActivity={state.actionHistoryNextCursor !== null} earlierActivityPending={state.actionHistoryStatus === "loading"} earlierActivityError={state.actionHistoryStatus === "error"} onLoadEarlierActivity={() => { void session.loadEarlierActivity(); }}
      interrupted={state.run?.status === "cancelled" || state.run?.status === "failed"} active={!compact || !hasArtifacts || panel === "chat"}
      onRetry={(id) => { void session.retry(id); }} onEdit={(id) => { if (session.editMessage(id)) { setEditNotice(false); inputRef.current?.focus(); } else setEditNotice(true); }} />}
    <div className="creator-writing">
      {state.editingMessageId && <div className="creator-editing"><span>Editing an unsent message</span><Button variant="quiet" size="compact" onClick={() => session.cancelEdit()}>Cancel edit</Button></div>}
      <form className="creator-composer" onSubmit={(event) => { event.preventDefault(); void session.send(); }}>
        <Textarea ref={inputRef} id="chat-message" className="creator-composer__field" label="Message" placeholder="Ask a question or describe what you want to learn…" value={composerText}
          maxLength={MESSAGE_LIMIT} rows={hasMessages ? 2 : 4} onChange={(event) => session.setComposer(event.target.value)} onKeyDown={onComposerKey} />
        <div className="creator-composer__toolbar"><span className="creator-composer__shortcut">Shift + Enter for a new line</span><div className="creator-composer__actions">{state.stream?.pending ? <IconButton type="button" variant="primary" className="creator-composer__send creator-composer__stop" label={runCancelPending ? "Stopping response" : "Stop response"} title="Stop response" icon={<Square fill="currentColor" strokeWidth={0} />} pending={runCancelPending} onClick={() => void stopActiveRun()} /> : <IconButton type="submit" variant="primary" className="creator-composer__send" label={state.editingMessageId ? "Send edited message" : "Send message"} icon={<ArrowUp size={22} strokeWidth={2} />} pending={state.transmittingId !== null} disabled={!composerText.trim() || pending || Boolean(state.composerConflict)} />}</div></div>
      </form>
      <div className="creator-feedback">
        {builds.state.error && <Notice tone="warning" action={<Button variant="quiet" size="compact" onClick={() => void builds.controller?.refresh()}>Reconnect</Button>}>Course build history couldn’t be loaded. Your saved program is still available.</Notice>}
        {composerText.length >= MESSAGE_LIMIT && <p className="creator-composer__limit" role="status">This message has reached the {MESSAGE_LIMIT.toLocaleString("en-US")} character limit.</p>}
        {state.saveStatus === "error" && <Notice tone="error"><p>{chatStorageMessage(state.storageError)}</p><Button variant="quiet" size="compact" onClick={() => { if (conversation) void session.flush(); else void session.send(); }}>{conversation ? "Retry saving" : "Retry sending"}</Button></Notice>}
        {state.composerConflict && <Notice tone="warning"><p>Your saved input changed in another session. Both versions have been kept.</p><Button variant="quiet" size="compact" onClick={() => setConflictOpen(true)}>Review both versions</Button></Notice>}
        {editNotice && <Notice tone="info">Finish your current message first. If delivery wasn’t confirmed, retry that message before editing it.</Notice>}
        {runConnectionError && state.stream?.pending && <Notice tone="warning">Live response updates were interrupted. Reconnecting…</Notice>}
        {runCancelError && state.stream?.pending && <Notice tone="warning">The stop wasn’t confirmed. Try again to check this same response.</Notice>}
        {state.run && ["failed", "cancelled"].includes(state.run.status) && <Notice tone="error" action={<Button variant="quiet" size="compact" pending={runRetryPending} onClick={() => void retryFailedRun()}>Retry response</Button>}><p>{state.run.status === "failed" ? "The response stopped before it was complete." : "The response was stopped."} Your message is already saved and won’t be sent again.</p>{runRetryError && <p>The retry wasn’t confirmed. Try again to check the same retry.</p>}</Notice>}
      </div>
      {!hasMessages && <div className="creator-scenarios" aria-label="Ideas to start with">{chatScenarios.map((scenario) => <button type="button" className="creator-scenario" key={scenario.id} onClick={() => applyScenario(scenario)}><strong>{scenario.title}</strong><span>{scenario.preview}</span></button>)}</div>}
    </div>
  </section>;

  const courses = <CourseArtifactsPanel actorId={actorId} artifacts={artifacts} selectedCourseId={conversation?.selectedCourseId ?? null} onSelect={(id) => session.selectCourse(id)}
    buildsInChat onViewBuild={() => setPanel("chat")} onBuildApproved={() => { setPanel("chat"); void builds.controller?.refreshAfterMutation(); }}
    getCurrentArtifact={(id) => session.getSnapshot().conversation?.artifacts.find((artifact) => artifact.courseId === id)} onArtifactChange={(artifact) => session.updateArtifact(artifact)}
    onApproval={(courseId, approval) => session.acknowledgeApproval(courseId, approval)} awaitingSnapshotCourseIds={state.stream?.pendingSnapshotCourseIds ?? []}
    conversationRun={state.stream?.run ?? state.run}
    {...(onApprove ? { onApprove } : {})} {...(onEditMetadata ? { onEditMetadata } : {})} />;

  const ready = state.loadStatus === "ready";
  return <AppShell active="chat" sidebarContent={historyPanel}>
    <div className={`creator${hasArtifacts ? " creator--with-artifacts" : ""}`}>
      {ready ? <><header className="creator-header"><div className="creator-header__title"><p>{conversation?.title ?? "New chat"}</p><div className={`creator-save-status creator-save-status--${state.saveStatus}`} role="status">{state.saveStatus === "saved" && <Check size={14} aria-hidden="true" />}{state.saveStatus === "saved" ? "Saved to your account" : state.saveStatus === "saving" ? "Saving…" : state.saveStatus === "error" ? "Couldn’t save" : state.saveStatus === "conflict" ? "Review saved input" : ""}</div></div>
        {conversation && <Menu label="Chat options" items={[{ id: "rename", label: "Rename chat", onSelect: () => { setRenamedTitle(conversation.title); setDialog("rename"); setDialogError(null); } }, { id: "delete", label: "Delete chat", danger: true, onSelect: () => { setDialog("delete"); setDialogError(null); } }]} />}
      </header><div className="creator-workspace">{hasArtifacts ? <CreatorPanels compact={compact} value={panel} onValueChange={setPanel} chat={chat} courses={courses} courseCount={artifacts.length} /> : chat}</div></> : <div className="creator-recovery">
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
