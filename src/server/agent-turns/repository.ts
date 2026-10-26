import "server-only";
import { z } from "zod";
import type { DbTransaction } from "../db";
import { IdSchema, JsonValueSchema, type JsonValue } from "../../domain/common";
import { ChatMessageSchema } from "../../domain/generation";
import { CurriculumDraftSchema } from "../../domain/course";
import { ServiceFault } from "../auth/errors";
import {readActiveModelPolicy} from "../ai/active-policy";
import {ModelPolicySchema} from "../ai/model-policy";
import { canonicalJson } from "../ai/json";
import type { ExecutionTarget } from "../runs/ports";
import { requireCourseDraft } from "../curricula/repository";
import { PostgresResearchRepository } from "../research/repository";
import { currentReaderCapabilities, ReaderCapabilitiesSchema } from "../research/reader-capabilities";
import { attachSearchMemory, CompactSearchSchema, SearchMemorySchema } from "./search-memory";
import { compactSourceMemory, ReadMemoryReceiptSchema, SourceMemorySchema } from "./source-memory";
import { researchHistoryOrder, visibleResearchStepsCte } from "./research-visibility";
import { ToolObservationSchema, type AgentToolAuthority } from "../agent-tools/contracts";
import { ArtifactMemorySchema, compactArtifactMemory } from "./artifact-memory";
import { GenerationMemorySchema, readGenerationMemory } from "./generation-memory";

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
  sourceMemory: SourceMemorySchema.optional(),
  artifactMemory: ArtifactMemorySchema.optional(),
  generationMemory: GenerationMemorySchema.optional(),
  agentProtocol: z.literal("conversational-v3").optional(),
  readerCapabilities: ReaderCapabilitiesSchema.optional(),
  modelPolicy:ModelPolicySchema.optional(),
  lastAssistantMessageId: IdSchema.nullable().optional(),
  currentTurnCommentary: z.object({ messages: z.array(z.object({ messageId: IdSchema, text: z.string().min(1).max(20000) }).strict()).max(8),
    omittedCount: z.number().int().nonnegative() }).strict().optional(),
  planningPolicy: z.union([
    z.object({ version: z.literal("planner-8192-v1"), maxOutputTokens: z.literal(8192) }).strict(),
    z.object({ version: z.literal("planner-headroom-v1"), maxOutputTokens: z.literal(32768) }).strict(),
  ]).optional(),
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
  const receipts = (await tx.query<{ result_reference: unknown }>(`${visibleResearchStepsCte}
    SELECT result_reference FROM visible_research_steps WHERE result_reference->>'tool'='read_source'`, [jobId])).rows;
  for (const row of receipts) {
    const receipt = ToolObservationSchema.parse(row.result_reference);
    if (receipt.ok) receipt.sourceIds.forEach((id) => sourceIds.add(id));
  }
  return { ...agent, artifactIds, sourceIds };
}

/** A saved search is readable only through this turn's visible, owned research receipts. */
export async function readSavedSearch(tx: DbTransaction, jobId: string, searchId: string) {
  const allowed = (await tx.query(`${visibleResearchStepsCte} SELECT id FROM visible_research_steps
    WHERE result_reference->>'tool'='search' AND result_reference->>'ok'='true'
    AND result_reference->'data'->>'id'=$2 LIMIT 1`, [jobId, searchId])).rows[0];
  if (!allowed) throw new ServiceFault(404, "not_found", "curriculum.notFound");
  const result = await new PostgresResearchRepository().getSearch(tx, searchId);
  if (!result) throw new ServiceFault(404, "not_found", "curriculum.notFound");
  return result;
}

/** Overflow references use the same visibility boundary as source grants and memory. */
export async function readSavedSourceResult(tx: DbTransaction, jobId: string, stepId: string) {
  const row = (await tx.query<{ result_reference: unknown }>(`${visibleResearchStepsCte}
    SELECT result_reference FROM visible_research_steps WHERE id=$2 AND result_reference->>'tool'='read_source'`, [jobId, stepId])).rows[0];
  if (!row) throw new ServiceFault(404, "not_found", "curriculum.notFound");
  return ToolObservationSchema.parse(row.result_reference);
}

export const ReadHistoryPageSchema = z.object({ category: z.enum(["searches", "source_reads"]), offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  entries: z.array(z.object({ stepId: IdSchema, tool: z.enum(["search", "read_source"]), ok: z.boolean(),
    searchId: IdSchema.nullable(), sourceId: IdSchema.nullable(), query: z.string().max(2000).nullable(),
    title: z.string().max(1000).nullable(), url: z.string().max(4096).nullable(), status: z.string().max(80).nullable(),
    blockCount: z.number().int().nonnegative().nullable(), candidateCount: z.number().int().nonnegative().nullable(),
    fullyReadBlockIds: z.array(z.string().min(1).max(80)).max(64) }).strict()).max(5),
}).strict();
export async function readSourceHistory(tx: DbTransaction, jobId: string, selection: { category: "searches" | "source_reads"; offset: number; limit: number }) {
  const row = (await tx.query<{ total: number; entries: unknown }>(`${visibleResearchStepsCte}, eligible AS (
    SELECT * FROM visible_research_steps WHERE (($2='searches' AND result_reference->>'tool'='search' AND result_reference->>'ok'='true')
        OR ($2='source_reads' AND result_reference->>'tool'='read_source'
          AND (result_reference->'data' ? 'sourceId' OR result_reference->'data' ? 'requestedUrl')))
    ), page AS (SELECT * FROM eligible ORDER BY ${researchHistoryOrder()} LIMIT $3 OFFSET $4)
    SELECT (SELECT count(*)::int FROM eligible) AS total,COALESCE(jsonb_agg(jsonb_build_object(
      'stepId',id,'tool',result_reference->'tool','ok',result_reference->'ok',
      'searchId',CASE WHEN result_reference->>'tool'='search' THEN result_reference->'data'->'id' ELSE NULL END,
      'sourceId',result_reference->'data'->'sourceId','query',result_reference->'data'->'requestedQuery',
      'title',result_reference->'data'->'title','url',COALESCE(result_reference->'data'->'url',result_reference->'data'->'requestedUrl'),
      'status',result_reference->'data'->'status',
      'blockCount',CASE WHEN jsonb_typeof(result_reference->'data'->'blocks')='array' THEN jsonb_array_length(result_reference->'data'->'blocks')
        WHEN jsonb_typeof(result_reference->'data'->'blockIndex')='array' THEN jsonb_array_length(result_reference->'data'->'blockIndex') ELSE NULL END,
      'candidateCount',CASE WHEN result_reference->>'tool'='search' THEN jsonb_array_length(result_reference->'data'->'hits') ELSE NULL END,
      'fullyReadBlockIds',CASE WHEN result_reference->'data'->>'overview'='false' THEN COALESCE((SELECT jsonb_agg(block.value->'id' ORDER BY block.ordinality)
        FROM jsonb_array_elements(result_reference->'data'->'blocks') WITH ORDINALITY AS block(value,ordinality)), '[]'::jsonb) ELSE '[]'::jsonb END)
      ORDER BY ${researchHistoryOrder()}),'[]'::jsonb) AS entries FROM page`, [jobId, selection.category, selection.limit, selection.offset])).rows[0];
  if (!row) throw new ServiceFault(503, "service_unavailable", "generation.recoveryUnavailable");
  return ReadHistoryPageSchema.parse({ category: selection.category, offset: selection.offset, total: row.total,
    nextOffset: selection.offset + selection.limit < row.total ? selection.offset + selection.limit : null, entries: row.entries });
}

/** Commentary and the final reply share deterministic durable inserts and strict display order. */
export async function saveAssistantMessage(tx: DbTransaction, target: ExecutionTarget, messageId: string, text: string): Promise<void> {
  const agent = asAgentTarget(target);
  await tx.query(`INSERT INTO unfurl.messages(id,conversation_id,branch_id,parent_message_id,role,status,parts,client_request_id,created_at)
    VALUES($1,$2,$3,$4,'assistant','complete',$5,NULL,GREATEST(clock_timestamp(),
      COALESCE((SELECT max(created_at)+interval '1 microsecond' FROM unfurl.messages WHERE conversation_id=$2 AND branch_id=$3),clock_timestamp())))`,
  [messageId, agent.conversationId, agent.branchId, agent.inputMessageId, JSON.stringify([{ type: "text", text }])]);
}

export async function captureContext(tx: DbTransaction, target: ExecutionTarget, jobId: string, index: number, now: string): Promise<ContextSnapshot> {
  const agent = asAgentTarget(target);
  const input = (await tx.query<{ parts: unknown }>("SELECT parts FROM unfurl.messages WHERE id=$1 AND conversation_id=$2 AND branch_id=$3 AND role='user'", [agent.inputMessageId, agent.conversationId, agent.branchId])).rows[0];
  const partsSchema = ChatMessageSchema.shape.parts;
  if (!input) throw new ServiceFault(404, "not_found", "chat.notFound");
  const currentMessage = partsSchema.parse(input.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const commentaryRows = (await tx.query<{ id: string; parts: unknown; total_count: string }>(`SELECT id,parts,count(*) OVER()::text AS total_count
    FROM unfurl.messages WHERE conversation_id=$1 AND branch_id=$2 AND parent_message_id=$3 AND role='assistant'
    ORDER BY created_at DESC,id DESC LIMIT 8`, [agent.conversationId, agent.branchId, agent.inputMessageId])).rows;
  const currentTurnCommentary = { messages: commentaryRows.map((row) => ({ messageId: row.id,
    text: partsSchema.parse(row.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n") })).reverse(),
  omittedCount: Math.max(0, Number(commentaryRows[0]?.total_count ?? 0) - commentaryRows.length) };
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
  const artifactRecords = [];
  for (const id of authority.artifactIds) {
    const { course, draft } = await requireCourseDraft(tx, agent.ownerId, id);
    artifactRecords.push({ draft, courseRevision: course.revision });
    artifacts.push({ courseId: id, draftId: draft.id, courseRevision: course.revision, draftRevision: draft.revision,
      title: draft.title, goal: draft.goal, language: draft.contentLanguage, readyVersionId: course.currentReadyVersionId });
  }
  const documents = await new PostgresResearchRepository().getSources(tx, Array.from(authority.sourceIds));
  const sources = documents.map((source) => ({ sourceId: source.id, title: source.title, url: source.finalUrl }));
  const readRows = (await tx.query<{ receipt: unknown }>(`${visibleResearchStepsCte} SELECT jsonb_build_object('stepId',id,
    'sourceId',CASE WHEN result_reference->>'ok'='true' THEN result_reference->'data'->'sourceId' ELSE NULL END,
    'fullyReadBlockIds',CASE WHEN result_reference->>'ok'='true' AND result_reference->'data'->>'overview'='false'
      THEN COALESCE((SELECT jsonb_agg(block.value->'id' ORDER BY block.ordinality)
        FROM jsonb_array_elements(result_reference->'data'->'blocks') WITH ORDINALITY AS block(value,ordinality)), '[]'::jsonb) ELSE '[]'::jsonb END,
    'failedUrl',CASE WHEN result_reference->>'ok'='false' THEN result_reference->'data'->'requestedUrl' ELSE NULL END,
    'failureStatus',CASE WHEN result_reference->>'ok'='false' THEN result_reference->'data'->'status' ELSE NULL END) AS receipt
    FROM visible_research_steps WHERE result_reference->>'tool'='read_source'
      AND (result_reference->'data' ? 'sourceId' OR result_reference->'data' ? 'requestedUrl') ORDER BY ${researchHistoryOrder()}`, [jobId])).rows;
  const sourceMemory = compactSourceMemory(documents, readRows.map((row) => ReadMemoryReceiptSchema.parse(row.receipt)));
  const observations = (await tx.query<{ result_reference: unknown }>(`${visibleResearchStepsCte}
    SELECT result_reference FROM visible_research_steps ORDER BY ${researchHistoryOrder("DESC")} LIMIT 8`, [jobId])).rows;
  const recentTools = observations.map((row, order) => {
    const observation = ToolObservationSchema.parse(row.result_reference);
    return { tool: observation.tool, ok: observation.ok, summary: observation.summary, data: order === 0 ? observation.data : null };
  }).reverse();
  const searchRows = (await tx.query<{ search: unknown }>(`${visibleResearchStepsCte} SELECT jsonb_build_object(
    'id',result_reference->'data'->'id', 'requestedQuery',result_reference->'data'->'requestedQuery',
    'executedQuery',result_reference->'data'->'executedQuery',
    'hits',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hit.value->'id','url',hit.value->'url','title',hit.value->'title') ORDER BY hit.ordinality)
      FROM jsonb_array_elements(result_reference->'data'->'hits') WITH ORDINALITY AS hit(value,ordinality)), '[]'::jsonb)) AS search
    FROM visible_research_steps WHERE result_reference->>'tool'='search' AND result_reference->>'ok'='true' ORDER BY ${researchHistoryOrder()}`, [jobId])).rows;
  const searches = searchRows.map((row) => CompactSearchSchema.parse(row.search));
  const intent = (await tx.query<{ course_id: string; expected_course_revision: number; draft_id: string; expected_draft_revision: number; target_language: string }>(`SELECT * FROM unfurl.course_language_revision_intents WHERE run_id=$1 AND owner_id=$2`, [agent.runId, agent.ownerId])).rows[0];
  const generationMemory = await readGenerationMemory(tx, agent, artifactRecords.map(record => record.draft));
  const snapshot = ContextSnapshotSchema.parse(attachSearchMemory({ kind: "context", index, now, currentMessage, recentMessages, artifacts, sources, recentTools,
    artifactMemory: await compactArtifactMemory(artifactRecords),
    ...(generationMemory.builds.length ? { generationMemory } : {}),
    modelPolicy:await readActiveModelPolicy(tx),planningPolicy: { version: "planner-headroom-v1", maxOutputTokens: 32768 }, sourceMemory, agentProtocol: "conversational-v3", readerCapabilities: currentReaderCapabilities(),
    lastAssistantMessageId: commentaryRows[0]?.id ?? null, currentTurnCommentary,
    languageIntent: intent ? { courseId: intent.course_id, expectedCourseRevision: intent.expected_course_revision, draftId: intent.draft_id,
      expectedDraftRevision: intent.expected_draft_revision, targetLanguage: intent.target_language } : null }, searches));
  canonicalJson(snapshot, 220 * 1024);
  return snapshot;
}
