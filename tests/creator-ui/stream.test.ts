import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage, GenerationRun, RunSnapshot } from "../../src/domain/generation";
import { canApproveCurriculum, createStreamState, creatorStreamReducer, type CreatorStreamState } from "../../src/features/creator/stream";
import { curriculum, ids, timestamp } from "../domain/fixtures";

const runId = "20000000-0000-4000-8000-000000000001";
const branchId = "20000000-0000-4000-8000-000000000002";
const messageId = "20000000-0000-4000-8000-000000000003";
const inputMessageId = "20000000-0000-4000-8000-000000000004";
const invocationId = "20000000-0000-4000-8000-000000000005";

function run(): GenerationRun {
  return {
    id: runId, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation,
    branchId, inputMessageId, sourceDraftRevision: null, approvalId: null,
    phase: "briefing", status: "queued", lastSeq: 0, outputVersionId: null, error: null,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

function userMessage(): ChatMessage {
  return {
    id: inputMessageId, conversationId: ids.conversation, branchId, parentMessageId: null,
    role: "user", status: "complete", parts: [{ type: "text", text: "Teach me AI deeply." }],
    clientRequestId: ids.request, createdAt: timestamp,
  };
}

type EventDetail = ChatEvent extends infer Event ? Event extends ChatEvent
  ? Omit<Event, "id" | "runId" | "branchId" | "seq" | "at"> : never : never;

function event(seq: number, detail: EventDetail): ChatEvent {
  return { id: `30000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, runId, branchId, seq, at: timestamp, ...detail };
}

function apply(state: CreatorStreamState, ...events: ChatEvent[]): CreatorStreamState {
  return events.reduce((current, next) => creatorStreamReducer(current, { type: "event", event: next }), state);
}

function initial(): CreatorStreamState {
  return createStreamState(run(), [userMessage()]);
}

function snapshot(state: CreatorStreamState, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    run: state.run, messages: state.messages, draft: state.draft,
    lastSeq: state.lastAppliedSeq, retainedActionEvents: state.actionEvents, ...overrides,
  };
}

function text(state: CreatorStreamState): string {
  return state.messages.find((message) => message.id === messageId)?.parts
    .map((part) => part.type === "text" ? part.text : "").join("") ?? "";
}

const started = () => event(1, { type: "message.started", messageId });

describe("creator stream order and recovery", () => {
  it("keeps a delayed first event pending without inventing a message or action", () => {
    const state = initial();
    expect(state.pending).toBe(true);
    expect(state.lastAppliedSeq).toBe(0);
    expect(state.messages).toEqual([userMessage()]);
    expect(state.actionEvents).toEqual([]);
    expect(state.draft).toBeNull();
  });

  it("buffers a gap, requests replay after the contiguous event, and drains in order", () => {
    const first = apply(initial(), started());
    const gap = apply(first, event(3, { type: "message.delta", messageId, text: "second" }));
    expect(gap.lastAppliedSeq).toBe(1);
    expect(gap.run.lastSeq).toBe(1);
    expect(gap.replayAfterSeq).toBe(1);
    expect(text(gap)).toBe("");
    const restored = apply(gap, event(2, { type: "message.delta", messageId, text: "first " }));
    expect(text(restored)).toBe("first second");
    expect(restored.lastAppliedSeq).toBe(3);
    expect(restored.replayAfterSeq).toBeNull();
    expect(restored.bufferedEvents).toEqual([]);
  });

  it("can receive the entire start out of order without losing the delayed first event", () => {
    const waiting = apply(initial(), event(3, { type: "message.completed", messageId }), event(2, { type: "message.delta", messageId, text: "A real reply." }));
    expect(waiting.replayAfterSeq).toBe(0);
    expect(waiting.messages).toHaveLength(1);
    const restored = apply(waiting, started());
    expect(text(restored)).toBe("A real reply.");
    expect(restored.messages.at(-1)?.status).toBe("complete");
    expect(restored.lastAppliedSeq).toBe(3);
  });

  it("ignores duplicate buffered and applied events", () => {
    const delta = event(2, { type: "message.delta", messageId, text: "Once." });
    const buffered = apply(initial(), delta, delta);
    expect(buffered.bufferedEvents).toHaveLength(1);
    const applied = apply(buffered, started(), delta);
    expect(text(applied)).toBe("Once.");
    expect(apply(applied, delta)).toBe(applied);
  });

  it("ignores old branches and different runs before they can fill a gap", () => {
    const state = initial();
    expect(apply(state, { ...started(), branchId: ids.missing })).toBe(state);
    expect(apply(state, { ...started(), runId: ids.missing })).toBe(state);
    const current = apply(state, started());
    expect(apply(current, { ...event(2, { type: "message.delta", messageId, text: "Old branch" }), branchId: ids.missing })).toBe(current);
  });

  it("preserves partial text after failure and releases pending without a completion claim", () => {
    const failure = event(3, {
      type: "run.failed",
      error: { code: "generation_failed", messageKey: "generation.failed", retryable: true, requestId: ids.request },
    });
    const state = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "The useful partial answer" }), failure);
    expect(text(state)).toBe("The useful partial answer");
    expect(state.messages.at(-1)?.status).toBe("failed");
    expect(state.run.status).toBe("failed");
    expect(state.run.outputVersionId).toBeNull();
    expect(state.pending).toBe(false);
    expect(apply(state, event(4, { type: "run.completed", courseVersionId: ids.course }))).toBe(state);
  });

  it("stops only on confirmed cancellation, keeps partial text, and rejects late events", () => {
    const partial = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "Keep this" }));
    const cancelled = apply(partial, event(3, { type: "run.cancelled", reason: "user" }));
    expect(text(cancelled)).toBe("Keep this");
    expect(cancelled.messages.at(-1)?.status).toBe("interrupted");
    expect(cancelled.pending).toBe(false);
    expect(cancelled.run.status).toBe("cancelled");
    expect(apply(cancelled, event(4, { type: "message.delta", messageId, text: " unwanted" }))).toBe(cancelled);
  });

  it("waits for missing text before applying a buffered terminal event", () => {
    const waiting = apply(initial(), started(), event(3, { type: "run.cancelled", reason: "user" }));
    expect(waiting.pending).toBe(true);
    expect(waiting.lastAppliedSeq).toBe(1);
    const stopped = apply(waiting, event(2, { type: "message.delta", messageId, text: "Arrived before stop" }));
    expect(text(stopped)).toBe("Arrived before stop");
    expect(stopped.pending).toBe(false);
    expect(stopped.replayAfterSeq).toBeNull();
  });

  it("requests authoritative recovery instead of inventing a missing message", () => {
    const state = apply(initial(), event(1, { type: "message.delta", messageId, text: "Missing start" }));
    expect(state.needsSnapshot).toBe(true);
    expect(state.messages).toEqual([userMessage()]);
  });
});

describe("creator snapshots and curriculum approval", () => {
  it("restores retained action events and continues from the snapshot sequence on reopen", () => {
    const working = apply(initial(),
      event(1, { type: "action.started", invocationId, action: "read_source", labelKey: "actions.readSource" }),
      event(2, { type: "action.completed", invocationId, resultSummary: "Read the source.", sourceIds: [ids.source] }),
    );
    const foreign = { ...event(3, { type: "action.started", invocationId: ids.missing, action: "search", labelKey: "actions.search" }), branchId: ids.missing };
    const saved = snapshot(working, { retainedActionEvents: [...working.actionEvents, foreign, working.actionEvents[0]!] });
    const reopened = creatorStreamReducer(createStreamState(saved.run), { type: "snapshot", snapshot: saved });
    expect(reopened.actionEvents).toEqual(working.actionEvents);
    expect(reopened.lastAppliedSeq).toBe(2);
    expect(reopened.needsSnapshot).toBe(false);
    const continued = apply(reopened, event(3, { type: "message.started", messageId }));
    expect(continued.messages.at(-1)?.id).toBe(messageId);
  });

  it("hydrates from a snapshot then drains still-future buffered events", () => {
    const waiting = apply(initial(), event(3, { type: "message.delta", messageId, text: "after snapshot" }));
    const covered = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "Before and " }));
    const restored = creatorStreamReducer(waiting, { type: "snapshot", snapshot: snapshot(covered) });
    expect(text(restored)).toBe("Before and after snapshot");
    expect(restored.lastAppliedSeq).toBe(3);
    expect(restored.replayAfterSeq).toBeNull();
  });

  it("requires a snapshot for outline metadata and approval, never constructing a draft", () => {
    const outlined = apply(initial(), event(1, { type: "outline.updated", draftId: ids.draft, revision: 1 }));
    expect(outlined.draft).toBeNull();
    expect(outlined.needsSnapshot).toBe(true);
    const awaiting = apply(outlined, event(2, { type: "approval.required", draftId: ids.draft, revision: 1 }));
    expect(awaiting.pending).toBe(false);
    expect(canApproveCurriculum(awaiting, ids.draft, 1)).toBe(false);
    const restored = creatorStreamReducer(awaiting, { type: "snapshot", snapshot: snapshot(awaiting, { draft: curriculum() }) });
    expect(canApproveCurriculum(restored, ids.draft, 1)).toBe(true);
    expect(canApproveCurriculum(restored, ids.draft, 2)).toBe(false);
    expect(canApproveCurriculum(restored, ids.missing, 1)).toBe(false);
  });

  it("invalidates the shown approval when a newer revision arrives and resists an old snapshot", () => {
    const waiting = apply(initial(), event(1, { type: "approval.required", draftId: ids.draft, revision: 1 }));
    const v1 = creatorStreamReducer(waiting, { type: "snapshot", snapshot: snapshot(waiting, { draft: curriculum() }) });
    const updated = apply(v1, event(2, { type: "outline.updated", draftId: ids.draft, revision: 2 }));
    expect(canApproveCurriculum(updated, ids.draft, 1)).toBe(false);
    const stale = creatorStreamReducer(updated, { type: "snapshot", snapshot: snapshot(updated, { draft: curriculum() }) });
    expect(stale.needsSnapshot).toBe(true);
    expect(stale.approvalRequired).toBeNull();
    const v2 = creatorStreamReducer(stale, { type: "snapshot", snapshot: snapshot(stale, { draft: { ...curriculum(), revision: 2 } }) });
    expect(v2.draft?.revision).toBe(2);
    expect(canApproveCurriculum(v2, ids.draft, 1)).toBe(false);
    expect(canApproveCurriculum(v2, ids.draft, 2)).toBe(true);
    const outdatedDraft = creatorStreamReducer(v2, { type: "snapshot", snapshot: snapshot(v2, { draft: curriculum() }) });
    expect(outdatedDraft.draft?.revision).toBe(2);
  });

  it("does not allow an older approval event to approve the current newer draft", () => {
    const state = creatorStreamReducer(initial(), { type: "snapshot", snapshot: snapshot(initial(), { draft: { ...curriculum(), revision: 3 } }) });
    const olderApproval = apply(state, event(1, { type: "approval.required", draftId: ids.draft, revision: 2 }));
    expect(olderApproval.draft?.revision).toBe(3);
    expect(olderApproval.approvalRequired).toBeNull();
    expect(canApproveCurriculum(olderApproval, ids.draft, 2)).toBe(false);
  });

  it("rejects a snapshot from another branch or an older sequence", () => {
    const current = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "Keep current" }));
    expect(creatorStreamReducer(current, { type: "snapshot", snapshot: snapshot(initial()) })).toBe(current);
    expect(creatorStreamReducer(current, { type: "snapshot", snapshot: snapshot(current, { run: { ...current.run, branchId: ids.missing } }) })).toBe(current);
  });

  it("cannot reopen a terminal run from a delayed active snapshot", () => {
    const stopped = apply(initial(), event(1, { type: "run.cancelled", reason: "user" }));
    const delayed = snapshot(stopped, { run: { ...stopped.run, status: "running" } });
    expect(creatorStreamReducer(stopped, { type: "snapshot", snapshot: delayed })).toBe(stopped);
  });

  it("settles partial message state when reopening a cancelled run snapshot", () => {
    const partial = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "Saved partial text" }));
    const saved = snapshot(partial, { run: { ...partial.run, status: "cancelled" } });
    const reopened = creatorStreamReducer(createStreamState(saved.run), { type: "snapshot", snapshot: saved });
    expect(reopened.pending).toBe(false);
    expect(reopened.messages.at(-1)?.status).toBe("interrupted");
    expect(text(reopened)).toBe("Saved partial text");
  });

  it("does not approve a curriculum with a blocking question", () => {
    const awaiting = apply(initial(), event(1, { type: "approval.required", draftId: ids.draft, revision: 1 }));
    const draft = { ...curriculum(), unresolvedQuestions: [{ id: ids.question, text: "Which project will you build?", blocking: true }] };
    const state = creatorStreamReducer(awaiting, { type: "snapshot", snapshot: snapshot(awaiting, { draft }) });
    expect(canApproveCurriculum(state, ids.draft, 1)).toBe(false);
  });
});
