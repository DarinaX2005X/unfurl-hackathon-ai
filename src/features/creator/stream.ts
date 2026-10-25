import { validateCurriculum } from "@/domain/course";
import type { CourseArtifactRef } from "@/domain/chat";
import type { ActionEvent, AgentTurnRun, ChatEvent, ChatMessage, RunSnapshot } from "@/domain/generation";

interface DraftRevision { id: string; revision: number }
export interface CreatorStreamState {
  run: AgentTurnRun;
  messages: ChatMessage[];
  artifacts: CourseArtifactRef[];
  actionEvents: ActionEvent[];
  lastAppliedSeq: number;
  bufferedEvents: ChatEvent[];
  appliedEventIds: string[];
  replayAfterSeq: number | null;
  needsSnapshot: boolean;
  pendingSnapshotCourseIds: string[];
  requiredArtifacts: Record<string, number>;
  requiredDrafts: Record<string, DraftRevision>;
  approvalRequired: Record<string, DraftRevision>;
  pending: boolean;
}
export type CreatorStreamAction = { type: "event"; event: ChatEvent } | { type: "snapshot"; snapshot: RunSnapshot };
const terminal = (run: AgentTurnRun) => run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
const pending = (run: AgentTurnRun) => run.status === "queued" || run.status === "running";
const inScope = (event: ChatEvent, run: AgentTurnRun) => event.runId === run.id && event.branchId === run.branchId;
const isAction = (event: ChatEvent): event is ActionEvent => event.type === "action.started" || event.type === "action.completed" || event.type === "action.failed";

export function createStreamState(run: AgentTurnRun, messages: ChatMessage[] = [], artifacts: CourseArtifactRef[] = []): CreatorStreamState {
  return { run, messages: messages.filter((message) => message.conversationId === run.conversationId && message.branchId === run.branchId), artifacts,
    actionEvents: [], lastAppliedSeq: run.lastSeq, bufferedEvents: [], appliedEventIds: [], replayAfterSeq: null,
    needsSnapshot: run.lastSeq > 0, pendingSnapshotCourseIds: [], requiredArtifacts: {}, requiredDrafts: {}, approvalRequired: {}, pending: pending(run) };
}

function finishMessages(messages: ChatMessage[], status: ChatMessage["status"]) {
  return messages.map((message) => message.status === "streaming" ? { ...message, status } : message);
}

function applyEvent(state: CreatorStreamState, event: ChatEvent): CreatorStreamState {
  const next: CreatorStreamState = { ...state, lastAppliedSeq: event.seq, appliedEventIds: [...state.appliedEventIds, event.id], run: { ...state.run, lastSeq: event.seq, updatedAt: event.at } };
  switch (event.type) {
    case "run.accepted": next.run = { ...next.run, status: "queued" }; break;
    case "message.started":
      next.run = { ...next.run, status: "running" };
      if (!next.messages.some((message) => message.id === event.messageId)) next.messages = [...next.messages, {
        id: event.messageId, conversationId: next.run.conversationId, branchId: event.branchId,
        parentMessageId: next.run.inputMessageId, role: "assistant", status: "streaming", parts: [], clientRequestId: null, createdAt: event.at,
      }];
      break;
    case "message.delta": {
      const message = next.messages.find((item) => item.id === event.messageId);
      if (!message || message.role !== "assistant") { next.needsSnapshot = true; break; }
      if (message.status !== "streaming") break;
      const parts = [...message.parts];
      const last = parts.at(-1);
      if (last?.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + event.text };
      else parts.push({ type: "text", text: event.text });
      next.messages = next.messages.map((item) => item.id === message.id ? { ...item, parts } : item);
      break;
    }
    case "message.completed":
      if (!next.messages.some((message) => message.id === event.messageId)) next.needsSnapshot = true;
      next.messages = next.messages.map((message) => message.id === event.messageId ? { ...message, status: "complete" } : message);
      break;
    case "action.started": next.run = { ...next.run, status: "running" }; next.actionEvents = [...next.actionEvents, event]; break;
    case "action.completed": case "action.failed": next.actionEvents = [...next.actionEvents, event]; break;
    case "artifact.updated": {
      const existing = next.artifacts.find((artifact) => artifact.courseId === event.courseId);
      if (event.revision < Math.max(existing?.revision ?? 0, next.requiredArtifacts[event.courseId] ?? 0)) break;
      next.requiredArtifacts = { ...next.requiredArtifacts, [event.courseId]: event.revision };
      next.pendingSnapshotCourseIds = [...new Set([...next.pendingSnapshotCourseIds, event.courseId])];
      next.needsSnapshot = true;
      break;
    }
    case "outline.updated": case "approval.required": {
      const draft = next.artifacts.find((artifact) => artifact.courseId === event.courseId)?.curriculum;
      if (event.revision < Math.max(draft?.revision ?? 0, next.requiredDrafts[event.courseId]?.revision ?? 0)) break;
      const reference = { id: event.draftId, revision: event.revision };
      next.requiredDrafts = { ...next.requiredDrafts, [event.courseId]: reference };
      next.pendingSnapshotCourseIds = [...new Set([...next.pendingSnapshotCourseIds, event.courseId])];
      next.needsSnapshot = true;
      if (event.type === "approval.required") next.approvalRequired = { ...next.approvalRequired, [event.courseId]: reference };
      else {
        const previous = next.approvalRequired[event.courseId];
        if (previous?.id !== reference.id || previous.revision !== reference.revision) {
          next.approvalRequired = { ...next.approvalRequired };
          delete next.approvalRequired[event.courseId];
        }
      }
      break;
    }
    case "run.awaiting_user": next.run = { ...next.run, status: "awaiting_user" }; break;
    case "run.completed": next.run = { ...next.run, status: "succeeded", error: null }; next.messages = finishMessages(next.messages, "complete"); break;
    case "run.failed": next.run = { ...next.run, status: "failed", error: event.error }; next.messages = finishMessages(next.messages, "failed"); break;
    case "run.cancelled": next.run = { ...next.run, status: "cancelled", error: null }; next.messages = finishMessages(next.messages, "interrupted"); break;
  }
  next.pending = pending(next.run);
  return next;
}

function drain(state: CreatorStreamState): CreatorStreamState {
  let next = state;
  while (!terminal(next.run)) {
    const event = next.bufferedEvents.find((item) => item.seq === next.lastAppliedSeq + 1);
    if (!event) break;
    next = applyEvent({ ...next, bufferedEvents: next.bufferedEvents.filter((item) => item.seq !== event.seq) }, event);
  }
  return terminal(next.run) ? { ...next, bufferedEvents: [], replayAfterSeq: null, pending: false }
    : { ...next, replayAfterSeq: next.bufferedEvents.length ? next.lastAppliedSeq : null };
}

function applySnapshot(state: CreatorStreamState, snapshot: RunSnapshot): CreatorStreamState {
  const incoming = snapshot.run;
  const resumed = terminal(state.run) && snapshot.lastSeq > state.lastAppliedSeq;
  if (incoming.id !== state.run.id || incoming.branchId !== state.run.branchId || incoming.conversationId !== state.run.conversationId
    || snapshot.lastSeq < state.lastAppliedSeq || (terminal(state.run) && incoming.status !== state.run.status && !resumed)) return state;
  const artifacts = [...state.artifacts];
  for (const candidate of snapshot.artifacts) {
    if (candidate.curriculum && candidate.curriculum.conversationId !== incoming.conversationId) continue;
    const index = artifacts.findIndex((artifact) => artifact.courseId === candidate.courseId);
    const previous = artifacts[index];
    if (previous && (candidate.revision < previous.revision || (candidate.curriculum?.revision ?? 0) < (previous.curriculum?.revision ?? 0))) continue;
    if (index === -1) artifacts.push(candidate); else artifacts[index] = candidate;
  }
  const pendingSnapshotCourseIds = state.pendingSnapshotCourseIds.filter((courseId) => {
    const actual = snapshot.artifacts.find((artifact) => artifact.courseId === courseId);
    const requiredDraft = state.requiredDrafts[courseId];
    return !actual || actual.revision < (state.requiredArtifacts[courseId] ?? 0)
      || Boolean(requiredDraft && (actual.curriculum?.id !== requiredDraft.id || actual.curriculum.revision < requiredDraft.revision));
  });
  const approvalRequired = { ...state.approvalRequired };
  for (const artifact of artifacts) {
    if (pendingSnapshotCourseIds.includes(artifact.courseId)) continue;
    if (artifact.curriculum && artifact.approvalRequestedRevision === artifact.curriculum.revision) {
      approvalRequired[artifact.courseId] = { id: artifact.curriculum.id, revision: artifact.curriculum.revision };
    } else delete approvalRequired[artifact.courseId];
  }
  const actionEvents = [...state.actionEvents, ...snapshot.retainedActionEvents].filter((event): event is ActionEvent => isAction(event) && inScope(event, incoming) && event.seq <= snapshot.lastSeq)
    .sort((a, b) => a.seq - b.seq).filter((event, index, events) => events.findIndex((item) => item.seq === event.seq || item.id === event.id) === index);
  let messages = snapshot.messages.filter((message) => message.conversationId === incoming.conversationId && message.branchId === incoming.branchId);
  if (terminal(incoming)) messages = finishMessages(messages, incoming.status === "succeeded" ? "complete" : incoming.status === "cancelled" ? "interrupted" : "failed");
  return drain({ ...state, run: { ...incoming, lastSeq: snapshot.lastSeq }, messages, artifacts, actionEvents, lastAppliedSeq: snapshot.lastSeq,
    bufferedEvents: state.bufferedEvents.filter((event) => event.seq > snapshot.lastSeq), replayAfterSeq: null,
    appliedEventIds: [...new Set([...state.appliedEventIds, ...actionEvents.map((event) => event.id)])],
    needsSnapshot: pendingSnapshotCourseIds.length > 0, pendingSnapshotCourseIds, approvalRequired, pending: pending(incoming) });
}

export function creatorStreamReducer(state: CreatorStreamState, action: CreatorStreamAction): CreatorStreamState {
  if (action.type === "snapshot") return applySnapshot(state, action.snapshot);
  const event = action.event;
  if (!inScope(event, state.run) || terminal(state.run) || event.seq <= state.lastAppliedSeq || state.appliedEventIds.includes(event.id)
    || state.bufferedEvents.some((item) => item.seq === event.seq || item.id === event.id)) return state;
  return drain({ ...state, bufferedEvents: [...state.bufferedEvents, event].sort((a, b) => a.seq - b.seq) });
}

export function canApproveCurriculum(state: CreatorStreamState, courseId: string, draftId: string, revision: number): boolean {
  const artifact = state.artifacts.find((item) => item.courseId === courseId);
  const draft = artifact?.curriculum;
  const required = state.approvalRequired[courseId];
  return Boolean(draft && draft.id === draftId && draft.revision === revision && required?.id === draftId && required.revision === revision
    && artifact?.approvalRequestedRevision === revision && !(artifact.approval?.draftId === draftId && artifact.approval.draftRevision === revision)
    && !state.pendingSnapshotCourseIds.includes(courseId) && !draft.unresolvedQuestions.some((question) => question.blocking) && validateCurriculum(draft).length === 0);
}
