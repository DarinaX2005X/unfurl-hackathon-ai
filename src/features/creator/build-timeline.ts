import type { GenerationTimelineEvent } from "@/domain/generation-observer";
import type { ActionDetails } from "@/domain/generation";
import type { ConversationBuildView, BuildRunView } from "./conversation-builds";

export interface BuildAction {
  id: string; stage: Extract<GenerationTimelineEvent, { type: "generation.action.started" }>["stage"];
  moduleId?: string; at: string; completed: boolean;
  result?: Extract<GenerationTimelineEvent, { type: "generation.action.completed" }>["result"];
  action?: Extract<GenerationTimelineEvent, { type: "generation.action.started" }>["action"];
  details?: ActionDetails;
}
type BuildItemBase = { id: string; at: string; build: ConversationBuildView; run: BuildRunView };
export type BuildTimelineItem = BuildItemBase & (
  | { kind: "build_approval" | "build_retry" | "build_history" | "build_status" | "build_ready" }
  | { kind: "build_commentary"; text: string }
  | { kind: "build_actions"; actions: BuildAction[] }
);

/** Approval identity stays stable across retries; each real call's public events keep their chronology. */
export function buildTimeline(builds: ConversationBuildView[]): BuildTimelineItem[] {
  const items: BuildTimelineItem[] = [];
  for (const build of builds) {
    items.push({ kind: "build_approval", id: `approval:${build.approvalId}`, at: build.approvedAt, build, run: build.runs[0]! });
    for (const [index, run] of build.runs.entries()) {
      const runId = run.stream.run.id;
      const base = { build, run };
      if (index > 0) items.push({ ...base, kind: "build_retry", id: `retry:${runId}`, at: run.stream.run.createdAt });
      if (run.beforeSeq !== null || run.historyError) items.push({ ...base, kind: "build_history", id: `history:${runId}`, at: run.stream.run.createdAt });
      const actions = new Map<string, BuildAction>();
      for (const event of run.events) {
        if (event.type === "generation.commentary") continue;
        const previous = actions.get(event.invocationId);
        actions.set(event.invocationId, { id: event.invocationId, stage: event.stage, ...(event.moduleId ? { moduleId: event.moduleId } : {}),
          at: previous?.at ?? event.at, completed: event.type === "generation.action.completed",
          action: event.action ?? previous?.action, details: { ...previous?.details, ...event.details },
          ...(event.type === "generation.action.completed" ? { result: event.result } : {}) });
      }
      const segments: Array<{ at: string; event: GenerationTimelineEvent } | { at: string; action: BuildAction }> = [
        ...run.events.filter(event => event.type === "generation.commentary").map(event => ({ at: event.at, event })),
        ...[...actions.values()].map(action => ({ at: action.at, action })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      let group: BuildAction[] = [];
      const flush = () => {
        if (group.length) items.push({ ...base, kind: "build_actions", id: `actions:${runId}:${group[0]!.id}`, at: group[0]!.at, actions: group });
        group = [];
      };
      for (const segment of segments) {
        if ("action" in segment) group.push(segment.action);
        else if (segment.event.type === "generation.commentary") {
          flush(); items.push({ ...base, kind: "build_commentary", id: segment.event.id, at: segment.at, text: segment.event.text });
        }
      }
      flush();
      const latest = index === build.runs.length - 1;
      if (run.stream.run.status === "succeeded") items.push({ ...base, kind: "build_ready", id: `ready:${runId}`, at: run.stream.run.updatedAt });
      else if (latest || ["failed", "cancelled"].includes(run.stream.run.status)) items.push({ ...base, kind: "build_status", id: `status:${runId}`, at: run.stream.run.updatedAt });
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
