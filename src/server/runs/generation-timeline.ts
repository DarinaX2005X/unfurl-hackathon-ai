import "server-only";
import { z } from "zod";
import { IdSchema, type JsonValue } from "../../domain/common";
import { GenerationTimelineEventSchema, type GenerationAction, type GenerationProgress } from "../../domain/generation-observer";
import type { ActionDetails } from "../../domain/generation";
import type { DbTransaction } from "../db";
import { ProviderFailure } from "../ai/failure";
import { appendGenerationEvent } from "./events";
import { classifyGenerationStep } from "./generation-progress";
import type { JobClaim } from "./ports";
import { SearchResultSchema, SourceDocumentSchema, SourceUrlSchema } from "../research/ports";

const object = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
function publicAction(key: string, stage: GenerationProgress["stage"]): GenerationAction | undefined {
  const suffix = key.replace(/^course\/[^/]+\//, "").replace(/^research\/coverage-v1\/round\/\d+\/revision\/\d+\//, "research/");
  if (suffix === "research/plan") return "research_plan";
  if (/^research\/search\//.test(suffix)) return "search";
  if (suffix === "research/selection") return "select_sources";
  if (/^research\/read\//.test(suffix)) return "read_source";
  if (/^research\/claims\//.test(suffix)) return "extract_claims";
  if (suffix === "research/knowledge") return "synthesize_knowledge";
  if (stage === "researching") return "review_knowledge";
  const byStage: Partial<Record<GenerationProgress["stage"], GenerationAction>> = {
    planning_lessons: "plan_lessons", writing_lessons: "write_lessons", creating_practice: "create_practice",
    validating_practice: "test_practice", reviewing_section: "review_section", saving_section: "save_section",
  };
  return byStage[stage];
}
function inputDetails(action: GenerationAction | undefined, input?: JsonValue): ActionDetails | undefined {
  const data = object(input);
  if (action === "search" && typeof data.query === "string" && data.query.trim().length && data.query.length <= 2000)
    return { query: data.query };
  if (action === "read_source" && SourceUrlSchema.safeParse(data.url).success) {
    const url = String(data.url); return { source: { title: new URL(url).hostname, url } };
  }
  if (action === "extract_claims") {
    const document = SourceDocumentSchema.safeParse(data.document);
    if (document.success) return { source: { title: document.data.title, url: document.data.finalUrl } };
  }
  return undefined;
}
function outputDetails(action: GenerationAction | undefined, result: JsonValue, input?: JsonValue, output?: JsonValue): ActionDetails | undefined {
  if (action === "search") {
    const search = SearchResultSchema.safeParse(result);
    if (search.success) return { query: search.data.requestedQuery, candidateCount: search.data.hits.length,
      sources: search.data.hits.map(({ title, url }) => ({ title, url })) };
  }
  if (action === "read_source" && object(result).kind === "course.source.read") {
    const document = SourceDocumentSchema.safeParse(object(output).document);
    if (document.success) return { source: { title: document.data.title, url: document.data.finalUrl }, sourceCount: 1 };
  }
  if (action === "select_sources") {
    const selected = object(object(result).data).selections, searches = object(input).searches;
    if (Array.isArray(selected) && Array.isArray(searches)) {
      const known = searches.flatMap(search => {
        const data = object(search), parsed = SearchResultSchema.safeParse(data.result);
        return parsed.success ? [{ stepId: data.stepId, result: parsed.data }] : [];
      });
      const sources = selected.flatMap(selection => {
        const item = object(selection), hit = known.find(search => search.stepId === item.searchStepId)?.result.hits.find(hit => hit.id === item.hitId);
        return hit ? [{ title: hit.title, url: hit.url }] : [];
      });
      if (sources.length === selected.length) return { sourceCount: sources.length, sources: sources.slice(0, 8) };
    }
  }
  return undefined;
}

/** Public activity derives from a claimed durable operation, never a requested/future step. */
export async function recordGenerationStepStarted(tx: DbTransaction, claim: JobClaim, key: string, stepId: string, input?: JsonValue): Promise<void> {
  if (claim.target.kind !== "generation" || key === "course/materialize" || key === "course/generation-policy") return;
  const target = claim.target;
  const row = (await tx.query<{ module_ids: string[] }>(`SELECT ARRAY(SELECT item->>'id' FROM jsonb_array_elements(revision.document->'modules') item) AS module_ids
    FROM unfurl.curriculum_approvals a JOIN unfurl.curriculum_revisions revision
      ON revision.draft_id=a.draft_id AND revision.revision=a.draft_revision AND revision.content_digest=a.content_digest
    WHERE a.id=$1 AND a.approved_by=$2 AND a.content_digest=$3`, [target.approvalId, target.ownerId, target.approvalDigest])).rows[0];
  if (!row) throw new ProviderFailure("invalid_output");
  const stage = classifyGenerationStep(key, new Set(z.array(IdSchema).parse(row.module_ids)));
  if (!stage) return;
  const action = publicAction(key, stage.stage), details = inputDetails(action, input);
  await appendGenerationEvent(tx, target, { type: "generation.action.started", invocationId: stepId,
    stage: stage.stage, ...(stage.moduleId ? { moduleId: stage.moduleId } : {}), ...(action ? { action } : {}), ...(details ? { details } : {}) });
}

/** Counts are taken only from known accepted result shapes; arbitrary private fields never become public copy. */
export function generationResultFacts(result: JsonValue): { sourceCount?: number; lessonCount?: number; taskCount?: number; outcome?: "unavailable" | "needs_revision" } {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return {};
  if (result.kind === "course.source.read") return { sourceCount: 1 };
  if (result.kind === "course.source.unavailable") return { outcome: "unavailable" };
  if (result.kind === "course.task.rejected" || result.kind === "course.module.approved_knowledge_gap") return { outcome: "needs_revision" };
  const content = result.kind === "course.module.completed" ? result.module
    : result.kind === "course.module.plan" ? result.plan
      : result.kind === "course.module.plan.page.bounded.v1" || result.kind === "course.module.plan.page" ? result.proposal : null;
  if (!content || typeof content !== "object" || Array.isArray(content)) return {};
  return { ...(Array.isArray(content.lessons) ? { lessonCount: content.lessons.length } : {}),
    ...(Array.isArray(content.tasks) ? { taskCount: content.tasks.length } : {}) };
}

export async function recordGenerationStepCompleted(tx: DbTransaction, claim: JobClaim, stepId: string, result: JsonValue, input?: JsonValue, output?: JsonValue): Promise<void> {
  if (claim.target.kind !== "generation") return;
  const row = (await tx.query<{ event: unknown }>(`SELECT event FROM unfurl.generation_events
    WHERE run_id=$1 AND type='generation.action.started' AND event->>'invocationId'=$2 ORDER BY seq LIMIT 1`,
  [claim.target.runId, stepId])).rows[0];
  // A resumed legacy operation may have no start event. Do not manufacture an earlier start.
  if (!row) return;
  const started = GenerationTimelineEventSchema.parse(row.event);
  if (started.type !== "generation.action.started" || started.runId !== claim.target.runId || started.courseId !== claim.target.courseId
    || started.branchId !== claim.target.branchId || started.invocationId !== stepId) throw new ProviderFailure("invalid_output");
  const details = outputDetails(started.action, result, input, output);
  await appendGenerationEvent(tx, claim.target, { type: "generation.action.completed", invocationId: stepId,
    stage: started.stage, ...(started.moduleId ? { moduleId: started.moduleId } : {}), ...(started.action ? { action: started.action } : {}),
    ...(details ? { details } : {}), result: generationResultFacts(result) });
}
