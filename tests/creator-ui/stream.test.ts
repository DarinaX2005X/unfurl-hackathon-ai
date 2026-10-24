import { describe, expect, it } from "vitest";
import { AgentTurnRunSchema, GenerationRunSchema, type ChatEvent, type ChatMessage, type AgentTurnRun, type RunSnapshot } from "../../src/domain/generation";
import type { CourseArtifactRef } from "../../src/domain/chat";
import { canApproveCurriculum, createStreamState, creatorStreamReducer, type CreatorStreamState } from "../../src/features/creator/stream";
import { curriculum, ids, timestamp } from "../domain/fixtures";

const runId = "20000000-0000-4000-8000-000000000001";
const branchId = "20000000-0000-4000-8000-000000000002";
const messageId = "20000000-0000-4000-8000-000000000003";
const inputMessageId = "20000000-0000-4000-8000-000000000004";
const invocationId = "20000000-0000-4000-8000-000000000005";

function run(): AgentTurnRun {
  return {
    id: runId, ownerId: ids.actor, conversationId: ids.conversation,
    branchId, inputMessageId, status: "queued", lastSeq: 0, error: null,
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
    run: state.run, messages: state.messages, artifacts: state.artifacts,
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
    expect(state.artifacts).toEqual([]);
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
    expect(state.artifacts).toEqual([]);
    expect(state.pending).toBe(false);
    expect(apply(state, event(4, { type: "run.completed" }))).toBe(state);
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

function artifact(courseId: string = ids.course, revision = 1): CourseArtifactRef {
  const draft = { ...curriculum(), courseId, revision, id: courseId === ids.course ? ids.draft : ids.missing };
  return { courseId, title: draft.title, summary: draft.goal, contentLanguage: draft.contentLanguage, revision,
    curriculum: draft, approval: null, approvalRequestedRevision: revision, readyVersionId: null, updatedAt: timestamp };
}

function hydrate(state: CreatorStreamState, artifacts: CourseArtifactRef[]) {
  return creatorStreamReducer(state, { type: "snapshot", snapshot: snapshot(state, { artifacts }) });
}

describe("conversation turns and independently versioned course artifacts", () => {
  it("completes a text-only turn with zero courses", () => {
    const state = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "A useful answer." }), event(3, { type: "run.completed" }));
    expect(state.run.status).toBe("succeeded");
    expect(AgentTurnRunSchema.safeParse(state.run).success).toBe(true);
    expect(state.pending).toBe(false);
    expect(text(state)).toBe("A useful answer.");
    expect(state.artifacts).toEqual([]);
  });

  it("keeps generation job success strict even when chat turns need no course", () => {
    const job = { ...run(), status: "succeeded", courseId: null, outputVersionId: null, sourceDraftRevision: null, approvalId: null, phase: "validating" };
    expect(GenerationRunSchema.safeParse(job).success).toBe(false);
    expect(GenerationRunSchema.safeParse({ ...job, courseId: ids.course }).success).toBe(false);
    expect(GenerationRunSchema.safeParse({ ...job, outputVersionId: ids.source }).success).toBe(false);
    expect(GenerationRunSchema.safeParse({ ...job, courseId: ids.course, outputVersionId: ids.source }).success).toBe(true);
  });

  it("updates A at revision 5 and B at revision 1 within the same turn", () => {
    const courseB = ids.sample;
    const awaiting = apply(initial(), event(1, { type: "artifact.updated", courseId: ids.course, revision: 5 }), event(2, { type: "artifact.updated", courseId: courseB, revision: 1 }));
    expect(awaiting.artifacts).toEqual([]);
    expect(awaiting.pendingSnapshotCourseIds).toEqual([ids.course, courseB]);
    const resolved = hydrate(awaiting, [artifact(ids.course, 5), artifact(courseB, 1)]);
    expect(resolved.artifacts.map((item) => [item.courseId, item.revision])).toEqual([[ids.course, 5], [courseB, 1]]);
    expect(resolved.pendingSnapshotCourseIds).toEqual([]);
    const next = apply(resolved, event(3, { type: "outline.updated", courseId: courseB, draftId: ids.missing, revision: 2 }));
    const updated = hydrate(next, [artifact(courseB, 2), artifact(ids.course, 4)]);
    expect(updated.artifacts.map((item) => item.revision)).toEqual([5, 2]);
  });

  it("an approval request for A does not pause work on B or mark a course ready", () => {
    const courseB = ids.sample;
    const waiting = apply(initial(), event(1, { type: "approval.required", courseId: ids.course, draftId: ids.draft, revision: 1 }));
    expect(waiting.pending).toBe(true);
    const state = hydrate(waiting, [artifact(), artifact(courseB)]);
    const workingB = apply(state, event(2, { type: "outline.updated", courseId: courseB, draftId: ids.missing, revision: 2 }));
    expect(workingB.pending).toBe(true);
    expect(canApproveCurriculum(workingB, ids.course, ids.draft, 1)).toBe(true);
    const completed = apply(workingB, event(3, { type: "run.completed" }));
    expect(completed.artifacts.every((item) => item.readyVersionId === null)).toBe(true);
    expect(completed.pending).toBe(false);
  });

  it("pauses the turn only on an explicit awaiting-user event", () => {
    const paused = apply(initial(), event(1, { type: "run.awaiting_user" }));
    expect(paused.pending).toBe(false);
    expect(paused.run.status).toBe("awaiting_user");
  });

  it("requires actual current course data before approving and rejects stale snapshots", () => {
    const awaiting = apply(initial(), event(1, { type: "approval.required", courseId: ids.course, draftId: ids.draft, revision: 1 }));
    expect(canApproveCurriculum(awaiting, ids.course, ids.draft, 1)).toBe(false);
    const v1 = hydrate(awaiting, [artifact()]);
    expect(canApproveCurriculum(v1, ids.course, ids.draft, 1)).toBe(true);
    const change = apply(v1, event(2, { type: "outline.updated", courseId: ids.course, draftId: ids.draft, revision: 2 }));
    const stale = hydrate(change, [artifact()]);
    expect(stale.needsSnapshot).toBe(true);
    expect(canApproveCurriculum(stale, ids.course, ids.draft, 1)).toBe(false);
    const v2 = hydrate(stale, [artifact(ids.course, 2)]);
    expect(canApproveCurriculum(v2, ids.course, ids.draft, 2)).toBe(true);
    expect(hydrate(v2, [artifact()]).artifacts[0]?.revision).toBe(2);
    const acknowledged = hydrate(v2, [{ ...artifact(ids.course, 2), approvalRequestedRevision: null }]);
    expect(canApproveCurriculum(acknowledged, ids.course, ids.draft, 2)).toBe(false);
  });

  it("does not approve a program with a blocking question", () => {
    const item = artifact();
    item.curriculum = { ...item.curriculum!, unresolvedQuestions: [{ id: ids.question, text: "Which project?", blocking: true }] };
    const state = hydrate(initial(), [item]);
    expect(canApproveCurriculum(state, ids.course, ids.draft, 1)).toBe(false);
  });
});

describe("stream snapshot recovery", () => {
  it("restores only retained action events in the current scope and continues in order", () => {
    const working = apply(initial(), event(1, { type: "action.started", invocationId, action: "read_source", labelKey: "actions.readSource" }), event(2, { type: "action.completed", invocationId, resultSummary: "Read the source.", sourceIds: [ids.source] }));
    const foreign = { ...event(3, { type: "action.started", invocationId: ids.missing, action: "search", labelKey: "actions.search" }), branchId: ids.missing };
    const saved = snapshot(working, { retainedActionEvents: [...working.actionEvents, foreign, working.actionEvents[0]!] });
    const restored = creatorStreamReducer(createStreamState(saved.run), { type: "snapshot", snapshot: saved });
    expect(restored.actionEvents).toEqual(working.actionEvents);
    expect(restored.needsSnapshot).toBe(false);
    expect(apply(restored, event(3, { type: "message.started", messageId })).messages.at(-1)?.id).toBe(messageId);
  });

  it("hydrates a sequence gap and drains still-future buffered events", () => {
    const waiting = apply(initial(), event(3, { type: "message.delta", messageId, text: "after snapshot" }));
    const covered = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "Before and " }));
    const state = creatorStreamReducer(waiting, { type: "snapshot", snapshot: snapshot(covered) });
    expect(text(state)).toBe("Before and after snapshot");
    expect(state.replayAfterSeq).toBeNull();
  });

  it("rejects snapshots from other runs, branches and older sequences", () => {
    const current = apply(initial(), started());
    expect(creatorStreamReducer(current, { type: "snapshot", snapshot: snapshot(initial()) })).toBe(current);
    for (const run of [{ ...current.run, id: ids.missing }, { ...current.run, branchId: ids.missing }]) {
      expect(creatorStreamReducer(current, { type: "snapshot", snapshot: snapshot(current, { run }) })).toBe(current);
    }
  });

  it("keeps cancelled partial text and never reopens a terminal run from a late snapshot", () => {
    const partial = apply(initial(), started(), event(2, { type: "message.delta", messageId, text: "Saved partial text" }));
    const saved = snapshot(partial, { run: { ...partial.run, status: "cancelled" } });
    const reopened = creatorStreamReducer(createStreamState(saved.run), { type: "snapshot", snapshot: saved });
    expect(reopened.pending).toBe(false);
    expect(reopened.messages.at(-1)?.status).toBe("interrupted");
    expect(text(reopened)).toBe("Saved partial text");
    expect(creatorStreamReducer(reopened, { type: "snapshot", snapshot: { ...saved, run: { ...saved.run, status: "running" } } })).toBe(reopened);
  });
});
