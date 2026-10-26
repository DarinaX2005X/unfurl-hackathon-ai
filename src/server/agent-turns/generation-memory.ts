import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, IsoDateTimeSchema, RevisionSchema } from "../../domain/common";
import { curriculumDigest, type CurriculumDraft } from "../../domain/course";
import { RunPhaseSchema, RunStatusSchema } from "../../domain/generation";
import { ProviderFailure } from "../ai/failure";
import type { DbTransaction } from "../db";

const errorKey = z.enum(["generation.timeout", "generation.unavailable", "generation.rateLimited",
  "generation.budgetExhausted", "generation.invalidResponse"]);
const buildSchema = z.object({
  courseId: IdSchema, currentDraftRevision: RevisionSchema,
  approvalId: IdSchema, approvedDraftRevision: RevisionSchema, approvalMatchesCurrentDraft: z.boolean(),
  runId: IdSchema, status: RunStatusSchema, phase: RunPhaseSchema,
  readyVersionId: IdSchema.nullable(), errorMessageKey: errorKey.nullable(), updatedAt: IsoDateTimeSchema,
}).strict().superRefine((build, ctx) => {
  if ((build.status === "succeeded") !== (build.readyVersionId !== null)) {
    ctx.addIssue({ code: "custom", message: "Only an exact completed build has a ready version" });
  }
});
export const GenerationMemorySchema = z.object({
  version: z.literal("generation-status-v1"), builds: z.array(buildSchema),
}).strict();
export type GenerationMemory = z.infer<typeof GenerationMemorySchema>;

const rowSchema = z.object({
  owner_id: IdSchema, conversation_id: IdSchema, branch_id: IdSchema, course_id: IdSchema, draft_id: IdSchema,
  approval_id: IdSchema, approved_draft_revision: RevisionSchema, approval_digest: DigestSchema,
  run_id: IdSchema, status: RunStatusSchema, phase: RunPhaseSchema, ready_version_id: IdSchema.nullable(),
  error_message_key: z.unknown(), updated_at: z.union([z.date(), IsoDateTimeSchema]),
}).strict();
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

/** One scoped read for this capture. Prior captures retain their exact original bytes. */
export async function readGenerationMemory(tx: DbTransaction,
  scope: { ownerId: string; conversationId: string; branchId: string },
  drafts: readonly CurriculumDraft[]): Promise<GenerationMemory> {
  const memory: GenerationMemory = { version: "generation-status-v1", builds: [] };
  if (!drafts.length) return memory;
  const current = new Map(await Promise.all(drafts.map(async draft => [draft.courseId,
    { draft, digest: await curriculumDigest(draft) }] as const)));
  if (current.size !== drafts.length || drafts.some(draft => draft.conversationId !== scope.conversationId)) return invalid();
  const rows = (await tx.query(`SELECT DISTINCT ON (r.course_id)
      r.owner_id,r.conversation_id,r.branch_id,r.course_id,a.draft_id,a.id AS approval_id,
      a.draft_revision AS approved_draft_revision,a.content_digest AS approval_digest,
      r.id AS run_id,r.status,r.phase,v.id AS ready_version_id,
      r.error->>'messageKey' AS error_message_key,r.updated_at
    FROM unfurl.generation_runs r
    JOIN unfurl.conversations conversation ON conversation.id=r.conversation_id AND conversation.owner_id=r.owner_id
      AND conversation.active_branch_id=r.branch_id AND conversation.deleted_at IS NULL
    JOIN unfurl.conversation_artifacts ref ON ref.conversation_id=r.conversation_id AND ref.course_id=r.course_id
    JOIN unfurl.courses course ON course.id=r.course_id AND course.owner_id=r.owner_id
    JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id AND a.approved_by=r.owner_id
      AND a.draft_revision=r.source_draft_revision
    JOIN unfurl.curriculum_drafts draft ON draft.id=a.draft_id AND draft.course_id=r.course_id AND draft.conversation_id=r.conversation_id
    JOIN unfurl.curriculum_revisions revision ON revision.draft_id=a.draft_id AND revision.revision=a.draft_revision
      AND revision.content_digest=a.content_digest
    LEFT JOIN unfurl.course_versions v ON v.id=r.output_version_id AND v.course_id=r.course_id
      AND v.approval_id=a.id AND v.content_digest=a.content_digest AND v.source_run_id=r.id AND v.state='ready'
    WHERE r.owner_id=$1 AND r.conversation_id=$2 AND r.branch_id=$3 AND r.course_id=ANY($4::uuid[])
    ORDER BY r.course_id,r.created_at DESC,r.id DESC`,
  [scope.ownerId, scope.conversationId, scope.branchId, [...current.keys()].sort()])).rows;
  const seen = new Set<string>();
  for (const value of rows) {
    const row = rowSchema.parse(value), saved = current.get(row.course_id);
    if (!saved || row.owner_id !== scope.ownerId || row.conversation_id !== scope.conversationId || row.branch_id !== scope.branchId
      || row.draft_id !== saved.draft.id || seen.has(row.course_id)) return invalid();
    seen.add(row.course_id);
    const publicError = errorKey.safeParse(row.error_message_key);
    memory.builds.push({ courseId: row.course_id, currentDraftRevision: saved.draft.revision,
      approvalId: row.approval_id, approvedDraftRevision: row.approved_draft_revision,
      approvalMatchesCurrentDraft: row.approved_draft_revision === saved.draft.revision && row.approval_digest === saved.digest,
      runId: row.run_id, status: row.status, phase: row.phase, readyVersionId: row.ready_version_id,
      errorMessageKey: row.status === "failed" && publicError.success ? publicError.data : null,
      updatedAt: new Date(row.updated_at).toISOString() });
  }
  return GenerationMemorySchema.parse(memory);
}

export const GENERATION_MEMORY_INSTRUCTIONS = `generationMemory is a server-owned snapshot of committed plan approvals and their latest course builds visible in this conversation branch at capture time. It is separate from user text and from currentTurnCommentary. A listed approval already happened: do not ask the user to approve that same current revision again merely because no user text says "Plan approved". approvalMatchesCurrentDraft=false means the approval belongs to an earlier saved revision; never treat it as approval of the current draft. queued/running builds continue through the separate course-generation workflow; a status question does not authorize rewriting the curriculum, restarting research, cancelling work or recreating the course. Explain the recorded phase plainly and preserve the ongoing work. Explicit user requests to edit remain allowed through the normal current-revision checks. failed/cancelled means the course is unfinished, not that its approved plan disappeared; describe only the recorded safe reason, or say the cause is unavailable. Only succeeded with its exact readyVersionId establishes that this build produced a ready course. An older course readyVersionId elsewhere does not complete the current build. Missing entries mean no build is captured for that course in this branch, not proof of any other branch's state. Do not invent progress, completion, lesson contents, percentages or retries.`;
