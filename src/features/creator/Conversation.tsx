"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, Check, Copy } from "lucide-react";
import { Button, IconButton } from "@/components/ui";
import type { ActionEvent, ChatMessage, ResearchAction } from "@/domain/generation";

export function Conversation({ messages, actionEvents, pending, interrupted = false, active = true }: { messages: ChatMessage[]; actionEvents: ActionEvent[]; pending: boolean; interrupted?: boolean; active?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [copyState, setCopyState] = useState<{ id: string; status: "copied" | "error" } | null>(null);
  const latest = messages.at(-1);
  const updateKey = `${latest?.id}:${latest?.parts.filter((part) => part.type === "text").map((part) => part.text).join("").length}:${actionEvents.length}`;

  useEffect(() => {
    const area = scrollRef.current;
    if (!area || !active) return;
    if (following.current) area.scrollTop = area.scrollHeight;
    else setHasNewContent(true);
  }, [updateKey, active]);

  async function copyMessage(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      setCopyState({ id: message.id, status: "copied" });
    } catch { setCopyState({ id: message.id, status: "error" }); }
  }

  return <div className="creator-conversation">
    <div className="creator-conversation__scroll" ref={scrollRef} tabIndex={0} aria-label="Conversation" onScroll={() => {
      const area = scrollRef.current;
      if (!area) return;
      following.current = area.scrollHeight - area.clientHeight - area.scrollTop < 88;
      if (following.current) setHasNewContent(false);
    }}>
      <div className="creator-conversation__content">
        {messages.map((message) => <article className={`creator-message creator-message--${message.role}`} key={message.id}>
          <h2>{message.role === "user" ? "You" : "Unfurl"}</h2>
          <div className="creator-message__text">{message.parts.map((part, index) => part.type === "text" ? <p key={index}>{part.text}</p> : null)}</div>
          {(message.status === "failed" || message.status === "interrupted") && <p className="creator-message__status">{message.status === "interrupted" ? "Stopped. This response is incomplete." : "This response could not be completed."}</p>}
          {message.status !== "streaming" && <div className="creator-message__tools">
            <IconButton label="Copy message" icon={copyState?.id === message.id && copyState.status === "copied" ? <Check /> : <Copy />} onClick={() => void copyMessage(message)} />
            {copyState?.id === message.id && <span role="status">{copyState.status === "copied" ? "Copied" : "Couldn’t copy. Select the text to copy it."}</span>}
          </div>}
        </article>)}
        {actionEvents.length > 0 && <ActionHistory events={actionEvents} interrupted={interrupted} />}
        {pending && <p className="creator-conversation__status" role="status">Your request is being processed.</p>}
      </div>
    </div>
    {hasNewContent && <Button className="creator-conversation__latest" variant="secondary" size="compact" onClick={() => {
      const area = scrollRef.current;
      if (area) area.scrollTo({ top: area.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      following.current = true;
      setHasNewContent(false);
    }}><ArrowDown size={16} aria-hidden="true" /> Jump to latest</Button>}
  </div>;
}

const actionLabels: Record<ResearchAction, string> = {
  search: "Finding sources", read_source: "Reading a source", compare_sources: "Comparing sources",
  build_outline: "Planning the course", research_module: "Researching a section",
  construct_tasks: "Preparing practice", validate_tasks: "Checking the practice",
};

export function ActionHistory({ events, interrupted = false }: { events: ActionEvent[]; interrupted?: boolean }) {
  const invocations = new Map<string, { label: string; status: "working" | "completed" | "failed"; summary?: string }>();
  for (const event of events) {
    if (event.type === "action.started") invocations.set(event.invocationId, { label: actionLabels[event.action], status: "working" });
    else {
      const current = invocations.get(event.invocationId) ?? { label: "Course preparation", status: "working" as const };
      invocations.set(event.invocationId, { ...current, status: event.type === "action.completed" ? "completed" : "failed", ...(event.type === "action.completed" ? { summary: event.resultSummary } : {}) });
    }
  }
  return <details className="creator-actions"><summary>Course activity <span>{invocations.size}</span></summary>
    <ul>{Array.from(invocations, ([id, action]) => <li key={id}><div><strong>{action.label}</strong><span>{action.status === "working" ? interrupted ? "Interrupted" : "In progress" : action.status === "completed" ? "Complete" : "Couldn’t finish"}</span></div>{action.summary && <p>{action.summary}</p>}</li>)}</ul>
  </details>;
}
