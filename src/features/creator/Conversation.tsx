"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, Check, ChevronRight, Copy, Pencil, RotateCcw, CircleAlert } from "lucide-react";
import { Button, IconButton } from "@/components/ui";
import type { ActionEvent } from "@/domain/generation";
import type { LocalMessage } from "@/domain/chat";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { ConversationBuild, type BuildInteraction } from "./ConversationBuild";
import { buildTimeline } from "./build-timeline";
import type { ConversationBuildView } from "./conversation-builds";
import { actionFactLines, actionLabel, actionResultSummary, collectActions, conversationTimeline, isCourseProgramAction, sourceLink, type ConversationAction } from "./conversation-timeline";

export interface ConversationProps {
  messages: LocalMessage[];
  actionEvents?: ActionEvent[];
  currentRunId?: string | null;
  pending: boolean;
  transmittingId: string | null;
  interrupted?: boolean;
  active?: boolean;
  hasEarlierActivity?: boolean;
  earlierActivityPending?: boolean;
  earlierActivityError?: boolean;
  onLoadEarlierActivity?: () => void;
  onRetry: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  builds?: ConversationBuildView[];
  buildsLoading?: boolean;
  buildInteraction?: BuildInteraction;
}

export function Conversation({ messages, actionEvents = [], currentRunId = null, pending, transmittingId, interrupted = false, active = true,
  hasEarlierActivity = false, earlierActivityPending = false, earlierActivityError = false, onLoadEarlierActivity, onRetry, onEdit, builds = [], buildsLoading = false, buildInteraction }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [copyState, setCopyState] = useState<{ id: string; status: "copied" | "error" } | null>(null);
  const latest = messages.at(-1);
  const timeline = [...conversationTimeline(messages, actionEvents), ...buildTimeline(builds)].sort((a, b) => {
    const time = (item: typeof a) => "build" in item ? item.at : item.kind === "message" ? item.message.createdAt : item.actions[0]!.at;
    return time(a).localeCompare(time(b));
  });
  const runActions = collectActions(actionEvents).filter((action) => action.runId === currentRunId);
  const lastAction = runActions.at(-1);
  const activeAction = lastAction?.status === "working" ? lastAction : [...runActions].reverse().find((action) => action.status === "working" && isCourseProgramAction(action));
  const activeActionId = pending && !interrupted ? activeAction?.id ?? null : null;
  const showBuildLoading = buildsLoading && builds.length === 0;
  const updateKey = `${latest?.id}:${latest?.text.length}:${latest?.delivery}:${actionEvents.length}:${pending}:${showBuildLoading}:${builds.map(build => build.runs.map(run => `${run.stream.run.id}:${run.stream.lastAppliedSeq}:${run.events.length}:${run.stream.progress?.updatedAt}:${run.connectionError}`).join(",")).join("|")}`;
  useEffect(() => {
    const area = scrollRef.current;
    if (!area || !active) return;
    if (following.current) area.scrollTop = area.scrollHeight;
    else setHasNewContent(true);
  }, [updateKey, active]);

  async function copyMessage(message: LocalMessage) {
    try { await navigator.clipboard.writeText(message.text); setCopyState({ id: message.id, status: "copied" }); }
    catch { setCopyState({ id: message.id, status: "error" }); }
  }

  return <div className="creator-conversation">
    <div className="creator-conversation__scroll" ref={scrollRef} tabIndex={0} aria-label="Conversation" onScroll={() => {
      const area = scrollRef.current;
      if (!area) return;
      following.current = area.scrollHeight - area.clientHeight - area.scrollTop < 88;
      if (following.current) setHasNewContent(false);
    }}><div className="creator-conversation__content">
      {(hasEarlierActivity || earlierActivityError) && <div className="creator-conversation__earlier"><Button type="button" variant="quiet" size="compact" pending={earlierActivityPending} disabled={!hasEarlierActivity} onClick={onLoadEarlierActivity}>Earlier activity</Button>{earlierActivityError && <span role="status">Earlier activity couldn’t be loaded.</span>}</div>}
      {timeline.map((item) => {
        if ("build" in item) return buildInteraction ? <ConversationBuild key={item.id} item={item} interaction={buildInteraction} /> : null;
        if (item.kind === "actions") return <ActionGroup key={item.id} actions={item.actions} activeActionId={activeActionId} currentRunId={currentRunId} pending={pending} interrupted={interrupted} />;
        const message = item.message;
        return <article className={`creator-message creator-message--${message.role}${message.status === "streaming" ? " creator-message--streaming" : ""}`} key={message.id}>
        <h2>{message.role === "user" ? "You" : "Unfurl"}</h2>
        <div className="creator-message__text">{message.role === "assistant" ? <AssistantMarkdown text={message.text} /> : <p>{message.text}</p>}</div>
        {message.role === "user" && message.delivery !== "accepted" && <div className="creator-message__delivery">
          <p>{message.delivery === "sending" ? "Sending…" : message.error?.messageKey === "chat.deliveryUnknown" ? "Delivery wasn’t confirmed" : "Not sent"}</p>
          {(message.delivery === "failed" || message.delivery === "not_sent") && <>
            <p className="creator-message__failure-detail">{message.error?.messageKey === "chat.deliveryUnknown" ? "Retry to check this same message." : message.error?.messageKey === "generation.unavailable" ? "The AI agent is unavailable right now. You can retry this message later." : "Unfurl couldn’t receive this message. Please try again."}</p>
            <div className="creator-message__delivery-actions"><Button variant="quiet" size="compact" onClick={() => onRetry(message.id)} pending={transmittingId === message.id} disabled={pending}><RotateCcw size={16} aria-hidden="true" />Retry</Button><Button variant="quiet" size="compact" onClick={() => onEdit(message.id)} disabled={pending}><Pencil size={16} aria-hidden="true" />Edit</Button></div>
          </>}
        </div>}
        {message.role === "assistant" && (message.status === "failed" || message.status === "interrupted") && <p className="creator-message__status">{message.status === "interrupted" ? "Stopped. This response is incomplete." : "This response could not be completed."}</p>}
        {message.status !== "streaming" && <div className="creator-message__tools"><IconButton label="Copy message" icon={copyState?.id === message.id && copyState.status === "copied" ? <Check /> : <Copy />} onClick={() => void copyMessage(message)} />{copyState?.id === message.id && <span role="status">{copyState.status === "copied" ? "Copied" : "Select the message text to copy it."}</span>}</div>}
      </article>; })}
      {showBuildLoading && <div className="creator-conversation__status" role="status">Loading course activity…</div>}
      {pending && !transmittingId && !activeActionId && <div className="creator-conversation__status" role="status"><RespondingMark /><span>Unfurl is responding</span></div>}
    </div></div>
    {hasNewContent && <Button className="creator-conversation__latest" variant="secondary" size="compact" onClick={() => {
      const area = scrollRef.current;
      if (area) area.scrollTo({ top: area.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      following.current = true;
      setHasNewContent(false);
    }}><ArrowDown size={16} aria-hidden="true" />Jump to latest</Button>}
  </div>;
}

export function ActionHistory({ events, interrupted = false }: { events: ActionEvent[]; interrupted?: boolean }) {
  const actions = collectActions(events);
  const last = actions.at(-1);
  return <ActionGroup actions={actions} activeActionId={!interrupted && last?.status === "working" ? last.id : null} currentRunId={last?.runId ?? null} pending={!interrupted} interrupted={interrupted} />;
}

function RespondingMark() {
  return <span className="creator-responding" aria-hidden="true"><span /><span /><span /></span>;
}

function ActionGroup({ actions, activeActionId, currentRunId, pending, interrupted }: { actions: ConversationAction[]; activeActionId: string | null; currentRunId: string | null; pending: boolean; interrupted: boolean }) {
  const current = actions.find((action) => action.id === activeActionId);
  const ongoing = actions.find((action) => action.status === "working" && action.runId === currentRunId && pending && !interrupted && isCourseProgramAction(action));
  const working = Boolean(current || ongoing);
  const failed = actions.some((action) => action.status === "failed");
  const stopped = !working && actions.some((action) => action.status === "working");
  const last = actions.at(-1);
  if (!last) return null;
  const wasInterrupted = interrupted && actions.some((action) => action.runId === currentRunId);
  const title = working ? actionLabel(current ?? ongoing!) : stopped ? wasInterrupted ? "Work interrupted" : "Work not completed" : failed ? "Some work couldn’t finish" : actions.length === 1 ? actionLabel(last) : "Completed activity";
  return <details className={`creator-actions${working ? " creator-actions--working" : ""}`}>
    <summary><span className="creator-actions__state" aria-hidden="true">{current ? <RespondingMark /> : ongoing ? "…" : failed || stopped ? <CircleAlert size={16} /> : <Check size={16} />}</span><span className="creator-actions__label" role={working ? "status" : undefined}>{title}</span><ChevronRight className="creator-actions__chevron" size={16} aria-hidden="true" /><span className="creator-actions__hint">Details</span></summary>
    <ol>{actions.map((action) => {
      const facts = actionFactLines(action.facts);
      const sources = [...(action.facts.source ? [action.facts.source] : []), ...(action.facts.sources ?? [])];
      const summary = actionResultSummary(action);
      const inProgress = action.id === activeActionId || (pending && !interrupted && action.runId === currentRunId && isCourseProgramAction(action));
      const status = action.status === "working" ? inProgress ? "In progress" : interrupted && action.runId === currentRunId ? "Interrupted" : "No completion recorded" : action.status === "completed" ? "Complete" : "Couldn’t finish";
      return <li key={action.id}><div className="creator-actions__heading"><strong>{actionLabel(action)}</strong><span>{status}</span></div>
        {summary && <p>{summary}</p>}
        {action.facts.query && <p className="creator-actions__query">{action.facts.query}</p>}
        {facts.length > 0 && <p>{facts.join(" · ")}</p>}
        {sources.length > 0 && <ul className="creator-actions__sources">{sources.map((source, index) => {
          const url = sourceLink(source.url);
          return <li key={`${source.title}-${index}`}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}</a> : source.title}</li>;
        })}</ul>}
        {action.status === "failed" && <p>This step didn’t finish. Any completed work is still available.</p>}
      </li>;
    })}</ol>
  </details>;
}
