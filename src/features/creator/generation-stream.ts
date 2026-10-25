import type {
  GenerationEvent,
  GenerationSnapshot,
  SafeValidationSummary,
} from "@/domain/generation-observer";
import type { GenerationRun } from "@/domain/generation";

export interface GenerationStreamState {
  run: GenerationRun;
  approvedDraftRevision: number;
  approvalDigest: string;
  modules: GenerationSnapshot["modules"];
  work: GenerationSnapshot["work"];
  validation: SafeValidationSummary | null;
  readyVersionId: string | null;
  lastAppliedSeq: number;
  bufferedEvents: GenerationEvent[];
  appliedEventIds: string[];
  replayAfterSeq: number | null;
  needsSnapshot: boolean;
  pending: boolean;
}

export type GenerationStreamAction =
  | { type: "event"; event: GenerationEvent }
  | { type: "snapshot"; snapshot: GenerationSnapshot };

const terminal = (run: GenerationRun) => ["succeeded", "failed", "cancelled"].includes(run.status);
const pending = (run: GenerationRun) => run.status === "queued" || run.status === "running";
const inScope = (event: GenerationEvent, run: GenerationRun) => event.runId === run.id
  && event.courseId === run.courseId && event.branchId === run.branchId;

export function createGenerationStreamState(snapshot: GenerationSnapshot): GenerationStreamState {
  return {
    run: snapshot.run,
    approvedDraftRevision: snapshot.approvedDraftRevision,
    approvalDigest: snapshot.approvalDigest,
    modules: snapshot.modules,
    work: snapshot.work,
    validation: snapshot.validation,
    readyVersionId: snapshot.readyVersionId,
    lastAppliedSeq: snapshot.lastSeq,
    bufferedEvents: [],
    appliedEventIds: [],
    replayAfterSeq: null,
    needsSnapshot: false,
    pending: pending(snapshot.run),
  };
}

function applyEvent(state: GenerationStreamState, event: GenerationEvent): GenerationStreamState {
  const next: GenerationStreamState = {
    ...state,
    lastAppliedSeq: event.seq,
    appliedEventIds: [...state.appliedEventIds, event.id],
    run: { ...state.run, lastSeq: event.seq, updatedAt: event.at },
  };
  switch (event.type) {
    case "generation.accepted":
      next.run = { ...next.run, status: "queued", error: null };
      break;
    case "generation.phase.changed":
      next.run = { ...next.run, phase: event.phase, status: "running", error: null };
      break;
    case "generation.module.completed": {
      const moduleState = next.modules.find((item) => item.moduleId === event.moduleId);
      if (!moduleState) {
        next.needsSnapshot = true;
        break;
      }
      next.modules = next.modules.map((item) => item.moduleId === event.moduleId
        ? { ...item, status: "complete", completedTasks: event.completedTasks }
        : item);
      // The event does not define the work-unit denominator or increment. Refresh it authoritatively.
      next.needsSnapshot = true;
      break;
    }
    case "generation.validation.summary":
      next.validation = event.summary;
      break;
    case "generation.succeeded":
      next.run = { ...next.run, status: "succeeded", outputVersionId: event.courseVersionId, error: null };
      next.readyVersionId = event.courseVersionId;
      break;
    case "generation.failed":
      next.run = { ...next.run, status: "failed", outputVersionId: null, error: event.error };
      next.readyVersionId = null;
      break;
    case "generation.cancelled":
      next.run = { ...next.run, status: "cancelled", outputVersionId: null, error: null };
      next.readyVersionId = null;
      break;
  }
  next.pending = pending(next.run);
  return next;
}

function drain(state: GenerationStreamState): GenerationStreamState {
  let next = state;
  while (!terminal(next.run)) {
    const event = next.bufferedEvents.find((item) => item.seq === next.lastAppliedSeq + 1);
    if (!event) break;
    next = applyEvent({ ...next, bufferedEvents: next.bufferedEvents.filter((item) => item.seq !== event.seq) }, event);
  }
  return terminal(next.run)
    ? { ...next, bufferedEvents: [], replayAfterSeq: null, pending: false }
    : { ...next, replayAfterSeq: next.bufferedEvents.length > 0 ? next.lastAppliedSeq : null };
}

function applySnapshot(state: GenerationStreamState, snapshot: GenerationSnapshot): GenerationStreamState {
  const incoming = snapshot.run;
  if (incoming.id !== state.run.id || incoming.ownerId !== state.run.ownerId
    || incoming.courseId !== state.run.courseId || incoming.conversationId !== state.run.conversationId
    || incoming.branchId !== state.run.branchId || snapshot.lastSeq < state.lastAppliedSeq
    || (terminal(state.run) && incoming.status !== state.run.status)
    || (state.readyVersionId !== null && snapshot.readyVersionId !== state.readyVersionId)) return state;
  return drain({
    ...state,
    run: incoming,
    approvedDraftRevision: snapshot.approvedDraftRevision,
    approvalDigest: snapshot.approvalDigest,
    modules: snapshot.modules,
    work: snapshot.work,
    validation: snapshot.validation,
    readyVersionId: snapshot.readyVersionId,
    lastAppliedSeq: snapshot.lastSeq,
    bufferedEvents: state.bufferedEvents.filter((event) => event.seq > snapshot.lastSeq),
    replayAfterSeq: null,
    needsSnapshot: false,
    pending: pending(incoming),
  });
}

export function generationStreamReducer(state: GenerationStreamState, action: GenerationStreamAction): GenerationStreamState {
  if (action.type === "snapshot") return applySnapshot(state, action.snapshot);
  const event = action.event;
  if (!inScope(event, state.run) || terminal(state.run) || event.seq <= state.lastAppliedSeq
    || state.appliedEventIds.includes(event.id)
    || state.bufferedEvents.some((item) => item.seq === event.seq || item.id === event.id)) return state;
  return drain({ ...state, bufferedEvents: [...state.bufferedEvents, event].sort((a, b) => a.seq - b.seq) });
}
