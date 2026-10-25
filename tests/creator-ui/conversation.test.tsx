import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation } from "../../src/features/creator/Conversation";
import { conversationTimeline, sourceLink, type ActionFacts } from "../../src/features/creator/conversation-timeline";
import { createStreamState, creatorStreamReducer } from "../../src/features/creator/stream";
import type { LocalMessage } from "../../src/domain/chat";
import type { ActionEvent, AgentTurnRun, ChatEvent } from "../../src/domain/generation";
import { ids, timestamp } from "../domain/fixtures";

const message = (id: string, text: string, role: "user" | "assistant" = "assistant", at = timestamp): LocalMessage => ({
  id, text, role, conversationId: ids.conversation, delivery: "accepted", status: "complete", requestId: null,
  runId: null, branchId: ids.sample, userLocale: null, createdAt: at, updatedAt: at, error: null,
});
function started(seq: number, invocationId: string, afterMessageId?: string): ActionEvent {
  return { id: `event-${seq}`, runId: ids.request, branchId: ids.sample, at: timestamp, seq,
    type: "action.started", invocationId, action: "search", labelKey: "generation.search",
    ...(afterMessageId ? { afterMessageId } : {}) } as ActionEvent;
}
function completed(seq: number, invocationId: string, details?: ActionFacts): ActionEvent {
  return { id: `event-${seq}`, runId: ids.request, branchId: ids.sample, at: timestamp, seq,
    type: "action.completed", invocationId, resultSummary: "read_artifact sourceId=secret-id digest=deadbeef revision=47", sourceIds: [ids.source],
    ...(details ? { details } : {}) } as ActionEvent;
}
const render = (messages: LocalMessage[], events: ActionEvent[], pending = false, interrupted = false) => renderToStaticMarkup(
  <Conversation messages={messages} actionEvents={events} pending={pending} interrupted={interrupted} transmittingId={null} onRetry={vi.fn()} onEdit={vi.fn()} />,
);

describe("natural conversation presentation", () => {
  it("interleaves commentary and anchored action groups even with identical timestamps and replayed events", () => {
    const messages = [message("user", "Teach me", "user"), message("intro", "I’ll find sources."), message("finding", "Here is what I found.")];
    const events = [completed(2, "search"), started(1, "search", "intro"), started(3, "read", "finding")];
    const timeline = conversationTimeline(messages, events);
    expect(timeline.map((item) => item.kind === "message" ? item.message.id : item.id)).toEqual(["user", "intro", "search", "finding", "read"]);
    const html = render(messages, events, true);
    expect(html.indexOf("I’ll find sources.")).toBeLessThan(html.indexOf("Searched the web"));
    expect(html.indexOf("Searched the web")).toBeLessThan(html.indexOf("Here is what I found."));
  });
  it("uses timestamps for saved activity that predates explicit message anchors", () => {
    const later = new Date(Date.parse(timestamp) + 1_000).toISOString();
    const timeline = conversationTimeline([message("intro", "Beginning"), message("answer", "Finished", "assistant", later)], [started(1, "search")]);
    expect(timeline.map((item) => item.kind)).toEqual(["message", "actions", "message"]);
  });
  it("renders only useful facts and never raw tool summaries, IDs, parameters or codes", () => {
    const html = render([message("intro", "I’ll check the references.")], [started(1, "search", "intro"), completed(2, "search", {
      query: "introductory astronomy curriculum", candidateCount: 4, sources: [{ title: "Open astronomy textbook", url: "https://example.org/textbook" }],
    })]);
    expect(html).toContain("introductory astronomy curriculum");
    expect(html).toContain("4 search results");
    expect(html).toContain("Open astronomy textbook");
    expect(html).toContain('href="https://example.org/textbook"');
    expect(html).not.toMatch(/read_artifact|secret-id|deadbeef|revision=|generation.search/);
    expect(html).not.toContain(ids.source);
  });
  it("keeps one current action indicator and stops animation on interruption", () => {
    const events = [started(1, "search", "intro")];
    const active = render([message("intro", "I’ll look into it.")], events, true);
    expect(active.match(/class="creator-responding"/g)).toHaveLength(1);
    expect(active).not.toContain("Unfurl is responding");
    const stopped = render([message("intro", "I’ll look into it.")], events, false, true);
    expect(stopped).toContain("Work paused");
    expect(stopped).not.toContain('class="creator-responding"');
    expect(stopped).not.toContain("In progress");
  });
  it("shows responding before actual text arrives without inventing an assistant reply", () => {
    const html = render([message("empty", "")], [], true);
    expect(html).toContain("Unfurl is responding");
    expect(html).not.toContain("creator-message--assistant");
    expect(html).not.toContain("I’ll");
  });
  it("does not animate an unfinished older step when a resumed run has moved on", () => {
    const messages = [message("old", "Earlier work"), message("new", "Continuing")];
    const events = [started(1, "old-step", "old"), started(2, "new-step", "new")];
    const working = render(messages, events, true);
    expect(working.match(/class="creator-responding"/g)).toHaveLength(1);
    expect(working).toContain("Work paused");
    const responding = render(messages, [...events, completed(3, "new-step")], true);
    expect(responding).toContain("Unfurl is responding");
    expect(responding.match(/class="creator-responding"/g)).toHaveLength(1);
  });
  it("rejects executable and credential-bearing source links", () => {
    expect(sourceLink("javascript:alert(1)")).toBeUndefined();
    expect(sourceLink("https://name:secret@example.org")).toBeUndefined();
    expect(sourceLink("https://example.org/book")).toBe("https://example.org/book");
  });
  it("keeps the run active after commentary completes and preserves it through reload", () => {
    const run: AgentTurnRun = { id: ids.request, ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample,
      inputMessageId: ids.task, status: "running", lastSeq: 0, error: null, createdAt: timestamp, updatedAt: timestamp };
    let state = createStreamState(run);
    const events: ChatEvent[] = [
      { id: "start", runId: run.id, branchId: run.branchId, seq: 1, at: timestamp, type: "message.started", messageId: ids.attempt },
      { id: "delta", runId: run.id, branchId: run.branchId, seq: 2, at: timestamp, type: "message.delta", messageId: ids.attempt, text: "I’ll check the sources first." },
      { id: "end", runId: run.id, branchId: run.branchId, seq: 3, at: timestamp, type: "message.completed", messageId: ids.attempt },
      started(4, "search", ids.attempt),
    ];
    for (const event of events) state = creatorStreamReducer(state, { type: "event", event });
    expect(state.pending).toBe(true);
    expect(state.messages[0]?.status).toBe("complete");
    const restored = creatorStreamReducer(createStreamState(run), { type: "snapshot", snapshot: { run: state.run, messages: state.messages,
      artifacts: [], lastSeq: state.lastAppliedSeq, retainedActionEvents: state.actionEvents } });
    expect(restored.pending).toBe(true);
    expect(restored.messages).toEqual(state.messages);
    expect(restored.actionEvents).toEqual(state.actionEvents);
  });
});

