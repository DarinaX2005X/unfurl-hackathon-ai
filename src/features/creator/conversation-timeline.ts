import type { LocalMessage } from "@/domain/chat";
import type { ActionDetails, ActionEvent, ResearchAction } from "@/domain/generation";

export type ActionFacts = ActionDetails;
export interface ConversationAction {
  id: string;
  runId: string;
  at: string;
  afterMessageId: string | undefined;
  action: ResearchAction | undefined;
  labelKey: string | undefined;
  status: "working" | "completed" | "failed";
  facts: ActionFacts;
}
export type ConversationItem = { kind: "message"; message: LocalMessage } | { kind: "actions"; id: string; actions: ConversationAction[] };

function compareEvents(a: ActionEvent, b: ActionEvent): number {
  if (a.runId === b.runId) return a.seq - b.seq;
  const chronology = a.at.localeCompare(b.at);
  return chronology || a.runId.localeCompare(b.runId) || a.seq - b.seq;
}

/** Event ids are immutable server identities; conflicting reuses never replace the first observed event. */
export function mergeActionEvents(branchId: string, ...groups: ActionEvent[][]): ActionEvent[] {
  const events = new Map<string, ActionEvent>();
  for (const event of groups.flat()) {
    if (event.branchId !== branchId) continue;
    const existing = events.get(event.id);
    if (!existing) events.set(event.id, event);
    else if (existing.runId === event.runId && existing.seq === event.seq && existing.type === event.type) events.set(event.id, event);
  }
  return [...events.values()].sort(compareEvents);
}

/** Raw observations, error messages, params and internal identifiers are never display copy. */
export function collectActions(events: ActionEvent[]): ConversationAction[] {
  const actions = new Map<string, ConversationAction>();
  for (const event of [...events].sort(compareEvents)) {
    const key = `${event.runId}:${event.invocationId}`;
    const previous = actions.get(key);
    actions.set(key, {
      id: key,
      runId: event.runId,
      at: previous?.at ?? event.at,
      afterMessageId: previous?.afterMessageId ?? (event.type === "action.started" ? event.afterMessageId : undefined),
      action: event.type === "action.started" ? event.action : previous?.action,
      labelKey: event.type === "action.started" ? event.labelKey : previous?.labelKey,
      status: event.type === "action.started" ? "working" : event.type === "action.completed" ? "completed" : "failed",
      facts: { ...previous?.facts, ...event.details },
    });
  }
  return [...actions.values()];
}

/** Explicit message anchors survive reload and avoid ambiguity in equal timestamps. */
export function conversationTimeline(messages: LocalMessage[], events: ActionEvent[]): ConversationItem[] {
  const slots: ConversationAction[][] = Array.from({ length: messages.length + 1 }, () => []);
  for (const action of collectActions(events)) {
    const anchor = action.afterMessageId ? messages.findIndex((message) => message.id === action.afterMessageId) : -1;
    const nextMessage = messages.findIndex((message) => message.createdAt > action.at);
    const slot = anchor >= 0 ? anchor + 1 : nextMessage >= 0 ? nextMessage : messages.length;
    slots[slot]!.push(action);
  }
  const timeline: ConversationItem[] = [];
  for (let index = 0; index <= messages.length; index++) {
    const actions = slots[index]!;
    const message = messages[index];
    if (actions.length) timeline.push({ kind: "actions", id: actions[0]!.id, actions });
    if (message && (message.text || message.role === "user")) timeline.push({ kind: "message", message });
  }
  return timeline;
}

const labels: Record<ResearchAction, [string, string]> = {
  search: ["Finding sources", "Searched the web"],
  read_source: ["Reading sources", "Sources read"],
  compare_sources: ["Comparing sources", "Sources compared"],
  build_outline: ["Working on the course", "Course updated"],
  research_module: ["Researching a section", "Section researched"],
  construct_tasks: ["Preparing practice", "Practice prepared"],
  validate_tasks: ["Checking practice", "Practice checked"],
};
export function actionLabel(action: ConversationAction): string {
  const specific: Record<string, [string, string]> = {
    "generation.readArtifact": ["Reviewing the course", "Course reviewed"],
    "generation.createCourse": ["Creating the course program", "Course program created"],
    "generation.reviseCurriculum": ["Revising the course program", "Course program revised"],
    "generation.updateMetadata": ["Updating course details", "Course details updated"],
    "generation.reviseLanguage": ["Changing the course language", "Course language changed"],
    "generation.planCourse": ["Planning the course", "Course planned"],
  };
  const specificLabel = action.labelKey ? specific[action.labelKey] : undefined;
  if (specificLabel) return specificLabel[action.status === "completed" ? 1 : 0];
  return action.action ? labels[action.action][action.status === "completed" ? 1 : 0] : "Course preparation";
}
export function actionFactLines(facts: ActionFacts): string[] {
  const counts: [number | undefined, string, string][] = [
    [facts.candidateCount, "search result", "search results"],
    [facts.sourceCount, "source", "sources"],
    [facts.sectionCount, "source section", "source sections"],
    [facts.outcomeCount, "learning outcome", "learning outcomes"],
    [facts.moduleCount, "course section", "course sections"],
    [facts.changeCount, "change", "changes"],
  ];
  return counts.flatMap(([count, one, many]) => typeof count === "number" && Number.isInteger(count) && count >= 0 ? [`${count} ${count === 1 ? one : many}`] : []);
}
export function sourceLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined; }
  catch { return undefined; }
}
