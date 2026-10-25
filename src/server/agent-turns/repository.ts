import "server-only";
import { z } from "zod";
import type { DbTransaction } from "../db";
import { IdSchema, JsonValueSchema, type JsonValue } from "../../domain/common";
import { ChatMessageSchema } from "../../domain/generation";
import { CurriculumDraftSchema } from "../../domain/course";
import { ServiceFault } from "../auth/errors";
import { canonicalJson } from "../ai/json";
import type { ExecutionTarget } from "../runs/ports";
import { requireCourseDraft } from "../curricula/repository";
import { PostgresResearchRepository } from "../research/repository";
import { attachSearchMemory, CompactSearchSchema, SearchMemorySchema } from "./search-memory";
import { ToolObservationSchema, type AgentToolAuthority } from "../agent-tools/contracts";

export function jsonValue(value: unknown): JsonValue { return JsonValueSchema.parse(JSON.parse(JSON.stringify(value))); }
export function jsonSchema<T>(schema: z.ZodType<T>): z.ZodType<JsonValue> { return schema.transform(jsonValue); }
export const ContextSnapshotSchema = z.object({
  kind: z.literal("context"), index: z.number().int().nonnegative(), now: z.iso.datetime(),
  currentMessage: z.string().min(1).max(20000),
  recentMessages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }).strict()),
  artifacts: z.array(z.object({ courseId: IdSchema, draftId: IdSchema, courseRevision: z.number().int(), draftRevision: z.number().int(),
    title: z.string(), goal: z.string(), language: z.string(), readyVersionId: IdSchema.nullable() }).strict()),
  sources: z.array(z.object({ sourceId: IdSchema, title: z.string(), url: z.string() }).strict()),
  recentTools: z.array(z.object({ tool: z.string(), ok: z.boolean(), summary: z.string(), data: JsonValueSchema }).strict()),
  searchMemory: SearchMemorySchema.optional(),
  omittedRecentMessages: z.number().int().positive().optional(),
  languageIntent: z.object({ courseId: IdSchema, expectedCourseRevision: z.number().int(), draftId: IdSchema,
    expectedDraftRevision: z.number().int(), targetLanguage: z.string() }).strict().nullable(),
}).strict();
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export const journalKey = (index: number, stage: "capture" | "decision" | "tool") => `agent.v1:${String(index).padStart(6, "0")}:${stage}`;
export function asAgentTarget(target: ExecutionTarget) {
  if (target.kind !== "agent_turn") throw new ServiceFault(404, "not_found", "generation.notFound");
  return target;
}
export async function assertAgentAuthority(tx: DbTransaction, target: ExecutionTarget): Promise<void> {
  const agent = asAgentTarget(target);
  const row = (await tx.query<{ id: string }>(`SELECT r.id FROM unfurl.agent_turn_runs r JOIN unfurl.conversations c ON c.id=r.conversation_id
    WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3 AND r.branch_id=$4 AND r.input_message_id=$5
    AND c.owner_id=r.owner_id AND c.active_branch_id=r.branch_id AND c.deleted_at IS NULL AND r.status IN ('queued','running')`,
  [agent.runId, agent.ownerId, agent.conversationId, agent.branchId, agent.inputMessageId])).rows[0];
  if (!row) throw new ServiceFault(404, "not_found", "generation.notFound");
}
export async function nextJournalPosition(tx: DbTransaction, jobId: string): Promise<{ index: number; stage: "capture" | "decision" | "tool" }> {
  const row = (await tx.query<{ step_key: string }>(`SELECT step_key FROM unfurl.run_steps WHERE job_id=$1 AND status='succeeded'
    AND step_key LIKE 'agent.v1:%' ORDER BY step_key DESC LIMIT 1`, [jobId])).rows[0];
  if (!row) return { index: 0, stage: "capture" };
  const match = /^agent\.v1:(\d{6}):(capture|decision|tool)$/.exec(row.step_key);
  if (!match) throw new ServiceFault(503, "service_unavailable", "generation.recoveryUnavailable");
  const index = Number(match[1]);
  return match[2] === "tool" ? { index: index + 1, stage: "capture" }
    : { index, stage: match[2] === "capture" ? "decision" : "tool" };
}
export async function journalReceipt<T>(tx: DbTransaction, jobId: string, index: number, stage: "capture" | "decision" | "tool", schema: z.ZodType<T>): Promise<T> {
  const row = (await tx.query<{ result_reference: unknown }>("SELECT result_reference FROM unfurl.run_steps WHERE job_id=$1 AND step_key=$2 AND status='succeeded'", [jobId, journalKey(index, stage)])).rows[0];
  if (!row) throw new ServiceFault(503, "service_unavailable", "generation.recoveryUnavailable");
  return schema.parse(row.result_reference);
}

export async function loadToolAuthority(tx: DbTransaction, target: ExecutionTarget, jobId: string): Promise<AgentToolAuthority> {
  const agent = asAgentTarget(target);
  const linked = (await tx.query<{ course_id: string; document: unknown }>(`SELECT ref.course_id,revision.document FROM unfurl.conversation_artifacts ref
    JOIN unfurl.courses c ON c.id=ref.course_id AND c.owner_id=$2 JOIN unfurl.curriculum_drafts d ON d.course_id=c.id
    JOIN unfurl.curriculum_revisions revision ON revision.draft_id=d.id AND revision.revision=d.revision
    WHERE ref.conversation_id=$1 AND d.conversation_id=$1`, [agent.conversationId, agent.ownerId])).rows;
  const sourceIds = new Set<string>();
  const artifactIds = new Set<string>();
  for (const row of linked) {
    const draft = CurriculumDraftSchema.parse(row.document);
    if (draft.courseId !== row.course_id || draft.conversationId !== agent.conversationId) throw new ServiceFault(503, "service_unavailable", "generation.recoveryUnavailable");
    artifactIds.add(row.course_id);
    draft.sourceIds.forEach((id) => sourceIds.add(id));
  }
  const receipts = (await tx.query<{ result_reference: unknown }>(`SELECT result_reference FROM unfurl.run_steps
    WHERE job_id=$1 AND status='succeeded' AND step_key LIKE 'agent.v1:%:tool'`, [jobId])).rows;
  for (const row of receipts) {
    const receipt = ToolObservationSchema.parse(row.result_reference);
    if (receipt.ok) receipt.sourceIds.forEach((id) => sourceIds.add(id));
  }
  return { ...agent, artifactIds, sourceIds };
}

/** A saved search is readable only through a successful tool receipt in this authorized job. */
export async function readSavedSearch(tx: DbTransaction, jobId: string, searchId: string) {
  const allowed = (await tx.query(`SELECT id FROM unfurl.run_steps WHERE job_id=$1 AND status='succeeded'
    AND step_key LIKE 'agent.v1:%:tool' AND result_reference->>'tool'='search' AND result_reference->>'ok'='true'
    AND result_reference->'data'->>'id'=$2 LIMIT 1`, [jobId, searchId])).rows[0];
  if (!allowed) throw new ServiceFault(404, "not_found", "curriculum.notFound");
  const result = await new PostgresResearchRepository().getSearch(tx, searchId);
  if (!result) throw new ServiceFault(404, "not_found", "curriculum.notFound");
  return result;
}

export async function captureContext(tx: DbTransaction, target: ExecutionTarget, jobId: string, index: number, now: string): Promise<ContextSnapshot> {
  const agent = asAgentTarget(target);
  const input = (await tx.query<{ parts: unknown }>("SELECT parts FROM unfurl.messages WHERE id=$1 AND conversation_id=$2 AND branch_id=$3 AND role='user'", [agent.inputMessageId, agent.conversationId, agent.branchId])).rows[0];
  const partsSchema = ChatMessageSchema.shape.parts;
  if (!input) throw new ServiceFault(404, "not_found", "chat.notFound");
  const currentMessage = partsSchema.parse(input.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const rows = (await tx.query<{ role: "user" | "assistant"; parts: unknown }>(`SELECT role,parts FROM unfurl.messages WHERE conversation_id=$1 AND branch_id=$2
    AND created_at <= (SELECT created_at FROM unfurl.messages WHERE id=$3) ORDER BY created_at DESC,id DESC LIMIT 20`, [agent.conversationId, agent.branchId, agent.inputMessageId])).rows;
  let historyCharacters = 0;
  const recentMessages = rows.flatMap((row) => {
    const text = partsSchema.parse(row.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (historyCharacters + text.length > 30000) return [];
    historyCharacters += text.length;
    return [{ role: row.role, text }];
  }).reverse();
  const authority = await loadToolAuthority(tx, target, jobId);
  const artifacts = [];
  for (const id of authority.artifactIds) {
    const { course, draft } = await requireCourseDraft(tx, agent.ownerId, id);
    artifacts.push({ courseId: id, draftId: draft.id, courseRevision: course.revision, draftRevision: draft.revision,
      title: draft.title, goal: draft.goal, language: draft.contentLanguage, readyVersionId: course.currentReadyVersionId });
  }
  const sources = (await new PostgresResearchRepository().getSources(tx, Array.from(authority.sourceIds)))
    .map((source) => ({ sourceId: source.id, title: source.title, url: source.finalUrl }));
  const observations = (await tx.query<{ result_reference: unknown }>(`SELECT result_reference FROM unfurl.run_steps
    WHERE job_id=$1 AND status='succeeded' AND step_key LIKE 'agent.v1:%:tool' ORDER BY step_key DESC LIMIT 8`, [jobId])).rows;
  const recentTools = observations.map((row, order) => {
    const observation = ToolObservationSchema.parse(row.result_reference);
    return { tool: observation.tool, ok: observation.ok, summary: observation.summary, data: order === 0 ? observation.data : null };
  }).reverse();
  const searchRows = (await tx.query<{ search: unknown }>(`SELECT jsonb_build_object(
    'id',result_reference->'data'->'id', 'requestedQuery',result_reference->'data'->'requestedQuery',
    'executedQuery',result_reference->'data'->'executedQuery',
    'hits',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hit.value->'id','url',hit.value->'url','title',hit.value->'title') ORDER BY hit.ordinality)
      FROM jsonb_array_elements(result_reference->'data'->'hits') WITH ORDINALITY AS hit(value,ordinality)), '[]'::jsonb)) AS search
    FROM unfurl.run_steps WHERE job_id=$1 AND status='succeeded' AND step_key LIKE 'agent.v1:%:tool'
      AND result_reference->>'tool'='search' AND result_reference->>'ok'='true' ORDER BY step_key`, [jobId])).rows;
  const searches = searchRows.map((row) => CompactSearchSchema.parse(row.search));
  const intent = (await tx.query<{ course_id: string; expected_course_revision: number; draft_id: string; expected_draft_revision: number; target_language: string }>(`SELECT * FROM unfurl.course_language_revision_intents WHERE run_id=$1 AND owner_id=$2`, [agent.runId, agent.ownerId])).rows[0];
  const snapshot = ContextSnapshotSchema.parse(attachSearchMemory({ kind: "context", index, now, currentMessage, recentMessages, artifacts, sources, recentTools,
    languageIntent: intent ? { courseId: intent.course_id, expectedCourseRevision: intent.expected_course_revision, draftId: intent.draft_id,
      expectedDraftRevision: intent.expected_draft_revision, targetLanguage: intent.target_language } : null }, searches));
  canonicalJson(snapshot, 220 * 1024);
  return snapshot;
}
