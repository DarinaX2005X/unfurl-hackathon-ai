import "server-only";
import { ActionDetailsSchema, type ActionDetails } from "../../domain/generation";
import type { ContextSnapshot } from "../agent-turns/repository";
import type { AgentDecision } from "./contracts";

export function agentActionLabelKey(decision: AgentDecision): string {
  const labels: Record<AgentDecision["tool"], string> = { search: "generation.search", read_source: "generation.readSource",
    read_artifact: "generation.readArtifact", create_course: "generation.createCourse", revise_curriculum: "generation.reviseCurriculum",
    update_metadata: "generation.updateMetadata", revise_language: "generation.reviseLanguage", respond: "generation.planCourse" };
  return labels[decision.tool];
}

export function sourceActionDetails(snapshot: ContextSnapshot, sourceId: string): ActionDetails {
  const source = snapshot.sources.find((item) => item.sourceId === sourceId);
  return source ? { source: { title: source.title, url: source.url } } : {};
}

/** Public details are facts from typed inputs, never model rationale or private journal data. */
export function agentActionDetails(decision: AgentDecision, snapshot: ContextSnapshot): ActionDetails | undefined {
  let details: ActionDetails = {};
  if (decision.tool === "search") details = { query: decision.input.query };
  else if (decision.tool === "read_source") {
    if (decision.input.kind === "url") {
      const url = decision.input.url;
      const source = snapshot.sources.find((item) => item.url === url);
      details = { source: { title: source?.title ?? new URL(url).hostname, url } };
    } else if (decision.input.kind === "continue") {
      details = sourceActionDetails(snapshot, decision.input.sourceId);
    } else if (decision.input.kind === "blocks") {
      const sourceId = decision.input.sourceId;
      const known = snapshot.sourceMemory?.sources.find((item) => item.sourceId === sourceId);
      details = { ...sourceActionDetails(snapshot, sourceId),
        ...(decision.input.blockIds.length ? { sectionCount: decision.input.blockIds.length } : known ? { sectionCount: known.blockCount } : {}) };
    }
  } else if ("sources" in decision.input) {
    details = { sourceCount: decision.input.sources.length,
      ...(decision.tool === "revise_curriculum" ? { changeCount: decision.input.changes.length } : {}) };
  }
  return Object.keys(details).length ? ActionDetailsSchema.parse(details) : undefined;
}
