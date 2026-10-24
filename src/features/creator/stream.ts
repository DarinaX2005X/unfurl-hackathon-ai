import { validateCurriculum, type CurriculumDraft } from "@/domain/course";
import type { ActionEvent, ChatEvent, ChatMessage, GenerationRun, RunSnapshot } from "@/domain/generation";

export interface DraftRevision {
  id: string;
  revision: number;
}

/** Transport-independent state. A replay starts after the last contiguous event. */
export interface CreatorStreamState {
  run: GenerationRun;
  messages: ChatMessage[];
  draft: CurriculumDraft | null;
  actionEvents: ActionEvent[];
  lastAppliedSeq: number;
  bufferedEvents: ChatEvent[];
  appliedEventIds: string[];
  replayAfterSeq: number | null;
  needsSnapshot: boolean;
  requiredDraft: DraftRevision | null;
  approvalRequired: DraftRevision | null;
  pending: boolean;
}

export type CreatorStreamAction =
  | { type: "event"; event: ChatEvent }
  | { type: "snapshot"; snapshot: RunSnapshot };

function terminal(run: GenerationRun): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

function pending(run: GenerationRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function inScope(event: ChatEvent, run: GenerationRun): boolean {
  return event.runId === run.id && event.branchId === run.branchId;
}

function isActionEvent(event: ChatEvent): event is ActionEvent {
  return event.type === "action.started" || event.type === "action.completed" || event.type === "action.failed";
}

export function createStreamState(run: GenerationRun, messages: ChatMessage[] = []): CreatorStreamState {
  return {
    run,
    messages: messages.filter((message) => message.conversationId === run.conversationId && message.branchId === run.branchId),
    draft: null,
    actionEvents: [],
    lastAppliedSeq: run.lastSeq,
    bufferedEvents: [],
    appliedEventIds: [],
    replayAfterSeq: null,
    needsSnapshot: run.lastSeq > 0,
    requiredDraft: null,
    approvalRequired: null,
    pending: pending(run),
  };
}

function finishMessages(messages: ChatMessage[], status: ChatMessage["status"]): ChatMessage[] {
  return messages.map((message) => message.status === "streaming" ? { ...message, status } : message);
}

function applyEvent(state: CreatorStreamState, event: ChatEvent): CreatorStreamState {
  let next: CreatorStreamState = {
    ...state,
    lastAppliedSeq: event.seq,
    appliedEventIds: [...state.appliedEventIds, event.id],
    run: { ...state.run, lastSeq: event.seq, updatedAt: event.at },
  };

  switch (event.type) {
    case "run.accepted":
      next.run = { ...next.run, status: "queued" };
      break;
    case "message.started":
      next.run = { ...next.run, status: "running" };
      if (!next.messages.some((message) => message.id === event.messageId)) {
        next.messages = [...next.messages, {
          id: event.messageId,
          conversationId: next.run.conversationId,
          branchId: event.branchId,
          parentMessageId: next.run.inputMessageId,
          role: "assistant",
          status: "streaming",
          parts: [],
          clientRequestId: null,
          createdAt: event.at,
        }];
      }
      break;
    case "message.delta": {
      const message = next.messages.find((item) => item.id === event.messageId);
      if (!message || message.role !== "assistant") {
        next.needsSnapshot = true;
        break;
      }
      // A completed message is immutable even if a malformed producer emits a later delta.
      if (message.status !== "streaming") break;
      const parts = [...message.parts];
      const lastPart = parts.at(-1);
      if (lastPart?.type === "text") parts[parts.length - 1] = { type: "text", text: lastPart.text + event.text };
      else parts.push({ type: "text", text: event.text });
      next.messages = next.messages.map((item) => item.id === event.messageId ? { ...item, parts } : item);
      break;
    }
    case "message.completed":
      if (!next.messages.some((message) => message.id === event.messageId)) next.needsSnapshot = true;
      next.messages = next.messages.map((message) => message.id === event.messageId ? { ...message, status: "complete" } : message);
      break;
    case "action.started":
      next.run = { ...next.run, status: "running" };
      next.actionEvents = [...next.actionEvents, event];
      break;
    case "action.completed":
    case "action.failed":
      next.actionEvents = [...next.actionEvents, event];
      break;
    case "outline.updated":
    case "approval.required": {
      const knownRevision = Math.max(next.draft?.revision ?? 0, next.requiredDraft?.revision ?? 0);
      if (event.revision < knownRevision) break;
      const reference = { id: event.draftId, revision: event.revision };
      next.requiredDraft = reference;
      // Metadata events never stand in for the curriculum object.
      next.needsSnapshot = true;
      if (event.type === "approval.required") {
        next.approvalRequired = reference;
        next.run = { ...next.run, status: "awaiting_user", phase: "awaiting_approval" };
      } else if (next.approvalRequired?.id !== event.draftId || next.approvalRequired.revision !== event.revision) {
        next.approvalRequired = null;
      }
      break;
    }
    case "phase.changed":
      next.run = { ...next.run, phase: event.phase, status: event.phase === "awaiting_approval" ? "awaiting_user" : "running" };
      if (event.phase !== "awaiting_approval") next.approvalRequired = null;
      break;
    case "run.completed":
      next.run = { ...next.run, status: "succeeded", outputVersionId: event.courseVersionId, error: null };
      next.messages = finishMessages(next.messages, "complete");
      next.approvalRequired = null;
      break;
    case "run.failed":
      next.run = { ...next.run, status: "failed", outputVersionId: null, error: event.error };
      next.messages = finishMessages(next.messages, "failed");
      next.approvalRequired = null;
      break;
    case "run.cancelled":
      next.run = { ...next.run, status: "cancelled", outputVersionId: null, error: null };
      next.messages = finishMessages(next.messages, "interrupted");
      next.approvalRequired = null;
      break;
  }
  next = { ...next, pending: pending(next.run) };
  return next;
}

function drain(state: CreatorStreamState): CreatorStreamState {
  let next = state;
  while (!terminal(next.run)) {
    const event = next.bufferedEvents.find((item) => item.seq === next.lastAppliedSeq + 1);
    if (!event) break;
    next = applyEvent({ ...next, bufferedEvents: next.bufferedEvents.filter((item) => item.seq !== event.seq) }, event);
  }
  if (terminal(next.run)) return { ...next, bufferedEvents: [], replayAfterSeq: null, pending: false };
  return { ...next, replayAfterSeq: next.bufferedEvents.length > 0 ? next.lastAppliedSeq : null };
}

function applySnapshot(state: CreatorStreamState, snapshot: RunSnapshot): CreatorStreamState {
  const incoming = snapshot.run;
  if (incoming.id !== state.run.id || incoming.branchId !== state.run.branchId ||
    incoming.conversationId !== state.run.conversationId || incoming.courseId !== state.run.courseId ||
    snapshot.lastSeq < state.lastAppliedSeq ||
    (terminal(state.run) && incoming.status !== state.run.status)) return state;

  const candidate = snapshot.draft;
  const validDraft = candidate !== null && candidate.courseId === incoming.courseId && candidate.conversationId === incoming.conversationId;
  const draft = validDraft && candidate.revision >= (state.draft?.revision ?? 0) ? candidate : state.draft;
  const requiredDraft = state.requiredDraft;
  const draftSatisfied = requiredDraft === null || (draft?.id === requiredDraft.id && draft.revision >= requiredDraft.revision);
  // A snapshot claiming to await approval must contain the actual displayed revision.
  const approvalRequired = incoming.status === "awaiting_user" && draft !== null && draftSatisfied
    ? { id: draft.id, revision: draft.revision }
    : null;
  const actionEvents = [...state.actionEvents, ...snapshot.retainedActionEvents]
    .filter((event): event is ActionEvent => isActionEvent(event) && inScope(event, incoming) && event.seq <= snapshot.lastSeq)
    .sort((a, b) => a.seq - b.seq)
    .filter((event, index, events) => events.findIndex((item) => item.seq === event.seq || item.id === event.id) === index);
  const messages = snapshot.messages.filter((message) => message.conversationId === incoming.conversationId && message.branchId === incoming.branchId);
  const settledMessages = terminal(incoming)
    ? finishMessages(messages, incoming.status === "succeeded" ? "complete" : incoming.status === "cancelled" ? "interrupted" : "failed")
    : messages;

  return drain({
    ...state,
    run: { ...incoming, lastSeq: snapshot.lastSeq },
    messages: settledMessages,
    draft,
    actionEvents,
    lastAppliedSeq: snapshot.lastSeq,
    bufferedEvents: state.bufferedEvents.filter((event) => event.seq > snapshot.lastSeq),
    appliedEventIds: [...new Set([...state.appliedEventIds, ...actionEvents.map((event) => event.id)])],
    replayAfterSeq: null,
    needsSnapshot: !draftSatisfied || (incoming.status === "awaiting_user" && draft === null),
    requiredDraft,
    approvalRequired,
    pending: pending(incoming),
  });
}

export function creatorStreamReducer(state: CreatorStreamState, action: CreatorStreamAction): CreatorStreamState {
  if (action.type === "snapshot") return applySnapshot(state, action.snapshot);
  const event = action.event;
  if (!inScope(event, state.run) || terminal(state.run) || event.seq <= state.lastAppliedSeq ||
    state.appliedEventIds.includes(event.id) ||
    state.bufferedEvents.some((item) => item.seq === event.seq || item.id === event.id)) return state;
  return drain({ ...state, bufferedEvents: [...state.bufferedEvents, event].sort((a, b) => a.seq - b.seq) });
}

/** Guard the exact revision shown to the user before dispatching an approval. */
export function canApproveCurriculum(state: CreatorStreamState, draftId: string, revision: number): boolean {
  return !state.needsSnapshot && !state.pending && state.run.status === "awaiting_user" &&
    state.draft?.id === draftId && state.draft.revision === revision &&
    state.approvalRequired?.id === draftId && state.approvalRequired.revision === revision &&
    !state.draft.unresolvedQuestions.some((question) => question.blocking) && validateCurriculum(state.draft).length === 0;
}
