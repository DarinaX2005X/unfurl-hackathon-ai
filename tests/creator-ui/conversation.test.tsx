import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation } from "../../src/features/creator/Conversation";
import { conversationTimeline, mergeActionEvents, sourceLink, type ActionFacts } from "../../src/features/creator/conversation-timeline";
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
const render = (messages: LocalMessage[], events: ActionEvent[], pending = false, interrupted = false, currentRunId: string | null = ids.request) => renderToStaticMarkup(
  <Conversation messages={messages} actionEvents={events} currentRunId={currentRunId} pending={pending} interrupted={interrupted} transmittingId={null} onRetry={vi.fn()} onEdit={vi.fn()} />,
);

describe("natural conversation presentation", () => {
  it("renders assistant responses and streaming commentary as Markdown while keeping user text literal", () => {
    const messages = [message("user", "### Keep **my input** literal", "user"),
      message("answer", "### Curriculum\n\n**A complete learning route.**"),
      { ...message("commentary", "I’m checking **primary sources**."), status: "streaming" as const }];
    const html = render(messages, [], true);
    expect(html).toContain("### Keep **my input** literal");
    expect(html).toContain("<h3>Curriculum</h3>");
    expect(html).toContain("<strong>A complete learning route.</strong>");
    expect(html).toContain("<strong>primary sources</strong>");
    expect(html).toContain("creator-message--streaming");
  });
  it("interleaves commentary and anchored action groups even with identical timestamps and replayed events", () => {
    const messages = [message("user", "Teach me", "user"), message("intro", "I’ll find sources."), message("finding", "Here is what I found.")];
    const events = [completed(2, "search"), started(1, "search", "intro"), started(3, "read", "finding")];
    const timeline = conversationTimeline(messages, events);
    expect(timeline.map((item) => item.kind === "message" ? item.message.id : item.id)).toEqual(["user", "intro", `${ids.request}:search`, "finding", `${ids.request}:read`]);
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
    expect(stopped).toContain("Work interrupted");
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
    expect(working).toContain("Work not completed");
    const responding = render(messages, [...events, completed(3, "new-step")], true);
    expect(responding).toContain("Unfurl is responding");
    expect(responding.match(/class="creator-responding"/g)).toHaveLength(1);
  });
  it("deduplicates history by event identity and orders different runs by chronology, then per-run sequence", () => {
    const later = new Date(Date.parse(timestamp) + 1_000).toISOString();
    const old = started(2, "old");
    const first = { ...started(1, "new"), id: "new-1", runId: ids.attempt, at: later };
    const second = { ...completed(2, "new"), id: "new-2", runId: ids.attempt, at: later };
    const merged = mergeActionEvents(ids.sample, [second], [old, first, old]);
    expect(merged.map((event) => event.id)).toEqual([old.id, first.id, second.id]);
    const html = render([message("old", "Earlier"), message("new", "Continuing", "assistant", later)], merged, true, false, ids.attempt);
    expect(html).toContain("Work not completed");
    expect(html.match(/class="creator-responding"/g)).toHaveLength(1);
  });
  it("rejects executable and credential-bearing source links", () => {
    expect(sourceLink("javascript:alert(1)")).toBeUndefined();
    expect(sourceLink("https://name:secret@example.org")).toBeUndefined();
    expect(sourceLink("https://example.org/book")).toBe("https://example.org/book");
  });
  it("keeps a course parent in progress while its child shows the actual planning phase", () => {
    const parent = { ...started(1, "course"), action: "build_outline", labelKey: "generation.createCourse" } as ActionEvent;
    const roadmap = { ...started(2, "roadmap"), action: "build_outline", labelKey: "generation.planCourse" } as ActionEvent;
    const done = { ...completed(3, "roadmap"), resultSummary: "Planned the learning route and its foundations." } as ActionEvent;
    const outline = { ...started(4, "outline"), action: "build_outline", labelKey: "generation.planCourse.outline" } as ActionEvent;
    const html = render([], [parent, roadmap, done, outline], true);
    expect(html).toContain("Creating the course program</strong><span>In progress");
    expect(html).toContain("Outlining topics and outcomes");
    expect(html).toContain("Planned the learning route and its foundations.");
    expect(html).not.toMatch(/Paused|Work paused|Course planned/);
    expect(html.match(/class="creator-responding"/g)).toHaveLength(1);
    const betweenParts = render([], [parent, roadmap, done], true);
    expect(betweenParts).toContain("Creating the course program</strong><span>In progress");
    expect(betweenParts).not.toContain("Unfurl is responding");
  });
  it("restores distinct saved topics and results for legacy planning events", () => {
    const first = { ...started(1, "outline"), action: "build_outline", labelKey: "generation.planCourse" } as ActionEvent;
    const firstDone = { ...completed(2, "outline"), resultSummary: "Outlined the next part of “Model evaluation and generalization”." } as ActionEvent;
    const second = { ...started(3, "research"), action: "build_outline", labelKey: "generation.planCourse" } as ActionEvent;
    const secondDone = { ...completed(4, "research"), resultSummary: "Checked sources and study estimates for “Compare validation methods”." } as ActionEvent;
    const html = render([], [first, firstDone, second, secondDone]);
    expect(html).toContain("Topics and learning outcomes");
    expect(html).toContain("Model evaluation and generalization");
    expect(html).toContain("Sources and study estimates");
    expect(html).toContain("Compare validation methods");
    expect(html).not.toContain("Course planned");
  });
  it("does not expose internal identifiers hidden inside a curriculum summary", () => {
    const start = { ...started(1, "outline"), action: "build_outline", labelKey: "generation.planCourse.outline" } as ActionEvent;
    const done = { ...completed(2, "outline"), resultSummary: "Outlined the next part of sourceId=private-source digest=private-hash." } as ActionEvent;
    expect(render([], [start, done])).not.toMatch(/private-source|private-hash|sourceId=|digest=/);
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

