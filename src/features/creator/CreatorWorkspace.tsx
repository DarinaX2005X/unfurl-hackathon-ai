"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Check, Clock3, FileText, Flag, Plus, Save } from "lucide-react";
import { AppShell } from "@/components/shell";
import { Button, LinkButton, Notice, Select, Tabs, Textarea } from "@/components/ui";
import { localApplication } from "@/application/local-adapter";
import type { ApplicationPort } from "@/application/ports";
import type { DraftStore, LocalDraft } from "@/domain/drafts";
import type { RunSnapshot } from "@/domain/generation";
import { draftStore } from "@/lib/drafts";
import { routes } from "@/lib/routes";
import { appendQuickAction, DraftEditor, quickActions, REQUEST_LIMIT, storageMessage } from "./draft-editor";
import { languageOptions } from "./languages";
import { tabRequestBuffer } from "./request-buffer";
import { Conversation } from "./Conversation";
import { CurriculumPanel, type ApproveCurriculum } from "./CurriculumPanel";
import { canApproveCurriculum, creatorStreamReducer, createStreamState, type CreatorStreamState } from "./stream";
import "./creator.css";

function subscribeToWidth(listener: () => void) {
  const query = window.matchMedia("(max-width: 1279px)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export interface CreatorWorkspaceProps {
  draftId?: string | null;
  services?: ApplicationPort;
  store?: DraftStore;
  initialSnapshot?: RunSnapshot;
  onApprove?: ApproveCurriculum;
}

export function CreatorWorkspace({ draftId = null, services = localApplication, store = draftStore, initialSnapshot, onApprove }: CreatorWorkspaceProps) {
  const router = useRouter();
  const [editor] = useState(() => new DraftEditor(store, draftId, undefined, undefined, tabRequestBuffer));
  const draft = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const [history, setHistory] = useState<LocalDraft[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stream, setStream] = useState<CreatorStreamState | null>(() => initialSnapshot
    ? creatorStreamReducer(createStreamState(initialSnapshot.run), { type: "snapshot", snapshot: initialSnapshot }) : null);
  const [mobilePanel, setMobilePanel] = useState("conversation");
  const narrow = useSyncExternalStore(subscribeToWidth, () => window.matchMedia("(max-width: 1279px)").matches, () => false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  const requestController = useRef<AbortController | null>(null);
  const lastRequest = useRef<{ key: string; id: string } | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      const records = await store.list();
      if (mounted.current) { setHistory(records); setHistoryError(false); }
    } catch { if (mounted.current) setHistoryError(true); }
    finally { if (mounted.current) setHistoryLoading(false); }
  }, [store]);

  useEffect(() => {
    mounted.current = true;
    void editor.open();
    void Promise.resolve().then(refreshHistory);
    const onFocus = () => void refreshHistory();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      requestController.current?.abort();
      window.removeEventListener("focus", onFocus);
      const state = editor.getSnapshot();
      if (state.savedDraft && state.saveStatus === "unsaved") void editor.save();
    };
  }, [editor, refreshHistory]);

  useEffect(() => {
    if (draft.savedDraft && draft.saveStatus === "unsaved") {
      void editor.save().then((saved) => { if (saved) void refreshHistory(); });
    }
  }, [draft.saveStatus, draft.savedDraft, editor, refreshHistory]);

  // Tab recovery never creates a library record. Saving is an explicit action.
  async function saveDraft() {
    const saved = await editor.save();
    if (!saved || !mounted.current) return;
    await refreshHistory();
    if (draftId !== saved.id) router.replace(routes.create(saved.id), { scroll: false });
  }

  async function sendRequest() {
    const current = editor.getSnapshot();
    if (sending.current || stream?.pending || current.loadStatus !== "ready" || !current.text.trim()) return;
    const text = current.text;
    const key = `${current.savedDraft?.id ?? "new"}\n${current.contentLanguage}\n${text}`;
    if (lastRequest.current?.key !== key) lastRequest.current = { key, id: crypto.randomUUID() };
    const controller = new AbortController();
    requestController.current = controller;
    sending.current = true;
    setSendPending(true);
    setSendError(null);
    try {
      const result = await services.startGeneration({
        requestId: lastRequest.current.id,
        draftId: current.savedDraft?.id ?? null,
        text, contentLanguage: current.contentLanguage,
      }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (!result.ok) {
        setSendError(result.error.error.code === "invalid_input"
          ? "Check your request and course language, then try again. Your text is still here."
          : "Course creation is unavailable right now. Your request has not been sent. You can try again or save it as a draft.");
        return;
      }
      setStream(createStreamState(result.data.run, [result.data.message]));
      // Clear only the submitted buffer. A concurrent edit remains available.
      if (editor.getSnapshot().text === text) editor.edit({ text: "" });
    } catch {
      if (mounted.current && !controller.signal.aborted) setSendError("Your request could not be sent. Your text is still here. Check your connection and try again.");
    } finally {
      sending.current = false;
      if (mounted.current) setSendPending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
      event.preventDefault();
      void sendRequest();
    }
  }

  const hasConversation = (stream?.messages.length ?? 0) > 0;
  const pending = sendPending || Boolean(stream?.pending);
  const program = stream?.draft ? <CurriculumPanel
    draft={stream.draft}
    currentRevision={Math.max(stream.requiredDraft?.revision ?? 0, stream.draft.revision)}
    awaitingApproval={canApproveCurriculum(stream, stream.draft.id, stream.draft.revision)}
    {...(onApprove ? { onApprove } : {})}
  /> : null;

  const composer = <div className="creator-writing">
    <form className="creator-composer" onSubmit={(event) => { event.preventDefault(); void sendRequest(); }}>
      <Textarea ref={inputRef} id="course-request" label={hasConversation ? "Message" : "Your learning goal"}
        className="creator-composer__field" rows={4} maxLength={REQUEST_LIMIT} value={draft.text}
        placeholder="I want to learn about…"
        onChange={(event) => { editor.edit({ text: event.target.value }); setSendError(null); }}
        onKeyDown={handleKeyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        aria-describedby="composer-keyboard composer-limit" />
      <div className="creator-composer__toolbar">
        <Select id="course-language" label="Course language" className="creator-composer__language"
          value={draft.contentLanguage} options={languageOptions(draft.contentLanguage)}
          onChange={(event) => editor.edit({ contentLanguage: event.target.value })} />
        <Button type="submit" pending={pending} disabled={!draft.text.trim()}>{sendError ? "Try again" : "Send request"}</Button>
      </div>
    </form>
    <div className="creator-composer__help"><span id="composer-keyboard">Enter to send. Shift + Enter for a new line.</span><span id="composer-limit" className={draft.text.length === REQUEST_LIMIT ? "creator-composer__limit" : ""}>{draft.text.length >= REQUEST_LIMIT - 1000 ? `${draft.text.length.toLocaleString("en")} / 20,000` : ""}</span></div>
    <div className="creator-feedback" aria-live="polite">
      {sendError && <Notice tone="error" title="Request not sent">{sendError}</Notice>}
      {draft.saveStatus === "error" && <Notice tone="error" title="Draft not saved" action={<Button variant="secondary" size="compact" onClick={() => void saveDraft()}>Try saving again</Button>}>{storageMessage(draft.error)}</Notice>}
    </div>
    {!hasConversation && <div className="creator-quick-actions" aria-label="Build your request">
      {quickActions.map((action, index) => <Button key={action.id} variant="quiet" size="compact" disabled={draft.text.length >= REQUEST_LIMIT} onClick={() => {
        editor.edit({ text: appendQuickAction(draft.text, action.text) });
        const input = inputRef.current;
        input?.focus();
        requestAnimationFrame(() => { if (input) input.setSelectionRange(input.value.length, input.value.length); });
      }}>{index === 0 ? <Plus size={17} aria-hidden="true" /> : index === 1 ? <Flag size={17} aria-hidden="true" /> : <Clock3 size={17} aria-hidden="true" />}{action.label}</Button>)}
    </div>}
  </div>;

  const conversation = <div className={`creator-chat${hasConversation ? " creator-chat--conversation" : ""}`}>
    {hasConversation && stream ? <Conversation messages={stream.messages} actionEvents={stream.actionEvents} pending={stream.pending} interrupted={stream.run.status === "failed" || stream.run.status === "cancelled"} active={!program || !narrow || mobilePanel === "conversation"} /> : <div className="creator-introduction">
      <h1>What would you<br className="creator-introduction__break" /> like to learn?</h1>
      <p>Start with a subject, a question, or something<br className="creator-introduction__break" /> you want to be able to do.</p>
    </div>}
    {composer}
    {!hasConversation && <p className="creator-expectation">Shape the goal together, then review your course program.</p>}
  </div>;

  return <AppShell active="create" sidebarContent={<DraftHistory drafts={history} selectedId={draft.savedDraft?.id ?? draftId} loading={historyLoading} error={historyError} onRetry={() => void refreshHistory()} />}>
    <div className={`creator${program ? " creator--with-program" : ""}`}>
      <header className="creator-header">
        <div className="creator-header__title">{hasConversation ? <h1>{draft.savedDraft?.title ?? "Create a course"}</h1> : <p>{draft.savedDraft?.title ?? "Create a course"}</p>}<SaveStatus status={draft.saveStatus} saved={Boolean(draft.savedDraft)} /></div>
        {draft.loadStatus === "ready" && <Button variant="secondary" size="compact" pending={draft.saveStatus === "saving"} disabled={!draft.text.trim() || draft.saveStatus === "saved"} onClick={() => void saveDraft()}><Save size={17} aria-hidden="true" />Save draft</Button>}
      </header>
      {draft.loadStatus === "loading" ? <div className="creator-recovery" role="status"><h1>Opening your draft</h1><p>Reading the request saved on this device.</p></div>
        : draft.loadStatus !== "ready" ? <div className="creator-recovery"><h1>{draft.loadStatus === "invalid" ? "This draft link isn’t valid" : draft.loadStatus === "missing" ? "This draft isn’t on this device" : "This draft couldn’t be opened"}</h1>
          <p>{draft.loadStatus === "invalid" ? "Open a draft from your library, or start with a new learning goal." : draft.loadStatus === "missing" ? "It may have been removed or saved in a different browser. Your other drafts are in your library." : storageMessage(draft.error, "open")}</p>
          <div>{draft.loadStatus === "error" && <Button onClick={() => void editor.open()}>Try again</Button>}<LinkButton href={routes.library} variant="secondary">Open library</LinkButton><LinkButton href={routes.create()} variant="quiet">Start a new request</LinkButton></div>
        </div>
          : <div className="creator-workspace">
            {program && narrow ? <Tabs className="creator-mobile-panels" value={mobilePanel} onValueChange={setMobilePanel} label="Course workspace" items={[
              { id: "conversation", label: "Conversation", panel: conversation }, { id: "program", label: "Program", panel: program },
            ]} /> : <><div className="creator-desktop-chat">{conversation}</div>{program && <div className="creator-desktop-program">{program}</div>}</>}
          </div>}
    </div>
  </AppShell>;
}

function SaveStatus({ status, saved }: { status: "unsaved" | "saving" | "saved" | "error"; saved: boolean }) {
  return <span className={`creator-save-status creator-save-status--${status}`} role="status">
    {status === "saved" && <Check size={14} aria-hidden="true" />}
    {status === "saved" ? "Saved on this device" : status === "saving" ? "Saving on this device…" : status === "error" ? "Not saved" : saved ? "Unsaved changes" : "Not saved yet"}
  </span>;
}

function DraftHistory({ drafts, selectedId, loading, error, onRetry }: { drafts: LocalDraft[]; selectedId: string | null; loading: boolean; error: boolean; onRetry: () => void }) {
  return <section className="creator-history" aria-label="Draft history"><h2>Your drafts</h2>
    {drafts.length > 0 && <ul>{drafts.map((draft) => <li key={draft.id}><Link href={routes.create(draft.id)} aria-current={selectedId === draft.id ? "page" : undefined}><FileText size={17} aria-hidden="true" /><span>{draft.title}</span></Link></li>)}</ul>}
    {error ? <div className="creator-history__empty"><p>Your drafts couldn’t be loaded.</p><Button variant="quiet" size="compact" onClick={onRetry}>Try again</Button></div>
      : loading ? <p className="creator-history__empty" role="status">Loading drafts…</p>
        : drafts.length === 0 ? <p className="creator-history__empty">Saved requests will be here when you’re ready to return.</p> : <p className="creator-history__device">On this device</p>}
  </section>;
}
