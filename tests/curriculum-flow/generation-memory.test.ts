import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { curriculumDigest, type CurriculumDraft } from "../../src/domain/course";
import type { DbTransaction } from "../../src/server/db";
import { readGenerationMemory, GenerationMemorySchema } from "../../src/server/agent-turns/generation-memory";
import { captureContext, ContextSnapshotSchema } from "../../src/server/agent-turns/repository";
import { buildAgentDecisionRequest } from "../../src/server/agent-turns/handler";
import { compactArtifactMemory } from "../../src/server/agent-turns/artifact-memory";
import { currentReaderCapabilities } from "../../src/server/research/reader-capabilities";
import * as curricula from "../../src/server/curricula/repository";
import { curriculum, ids, timestamp } from "../domain/fixtures";

afterEach(() => vi.restoreAllMocks());
const scope = { ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample };
async function buildRow(draft = curriculum()) {
  return { owner_id: ids.actor, conversation_id: ids.conversation, branch_id: ids.sample,
    course_id: draft.courseId, draft_id: draft.id, approval_id: ids.approval,
    approved_draft_revision: draft.revision, approval_digest: await curriculumDigest(draft),
    run_id: ids.request, status: "running", phase: "building_tasks", ready_version_id: null as string | null,
    error_message_key: null as unknown, updated_at: timestamp };
}
function transaction(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { query, tx: { query } as unknown as DbTransaction };
}

describe("captured generation status", () => {
  it("distinguishes the already approved plan from a later edited draft", async () => {
    const original = curriculum(), row = await buildRow(original), h = transaction([row]);
    expect((await readGenerationMemory(h.tx, scope, [original])).builds[0]).toMatchObject({
      courseId: ids.course, approvalId: ids.approval, approvedDraftRevision: 1, currentDraftRevision: 1,
      approvalMatchesCurrentDraft: true, runId: ids.request, status: "running", phase: "building_tasks", readyVersionId: null,
    });
    const edited = { ...original, revision: 2, goal: "Study an explicitly revised goal." };
    expect((await readGenerationMemory(h.tx, scope, [edited])).builds[0]).toMatchObject({
      approvedDraftRevision: 1, currentDraftRevision: 2, approvalMatchesCurrentDraft: false, runId: ids.request,
    });
    expect((await readGenerationMemory(h.tx, scope, [{ ...edited, revision: 1 }])).builds[0]!.approvalMatchesCurrentDraft).toBe(false);
  });

  it("queries all authorized artifacts once with owner, branch, approval and exact ready-version binding", async () => {
    const first = curriculum(), second: CurriculumDraft = { ...first, id: ids.missing, courseId: ids.question };
    const h = transaction([await buildRow(first), await buildRow(second)]);
    expect((await readGenerationMemory(h.tx, scope, [first, second])).builds).toHaveLength(2);
    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, values] = h.query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(values).toEqual([ids.actor, ids.conversation, ids.sample, [ids.course, ids.question].sort()]);
    expect(sql).toContain("conversation.active_branch_id=r.branch_id AND conversation.deleted_at IS NULL");
    expect(sql).toContain("ref.conversation_id=r.conversation_id AND ref.course_id=r.course_id");
    expect(sql).toContain("a.approved_by=r.owner_id");
    expect(sql).toContain("r.branch_id=$3 AND r.course_id=ANY($4::uuid[])");
    expect(sql).toContain("v.id=r.output_version_id AND v.course_id=r.course_id");
    expect(sql).toContain("v.approval_id=a.id AND v.content_digest=a.content_digest AND v.source_run_id=r.id AND v.state='ready'");
    expect(sql).not.toContain("current_ready_version_id");
  });

  it("does not claim a ready course from a succeeded run without its exact saved version", async () => {
    const row = { ...await buildRow(), status: "succeeded", ready_version_id: ids.evaluation };
    expect((await readGenerationMemory(transaction([row]).tx, scope, [curriculum()])).builds[0]!.readyVersionId).toBe(ids.evaluation);
    await expect(readGenerationMemory(transaction([{ ...row, ready_version_id: null }]).tx, scope, [curriculum()])).rejects.toThrow();
    await expect(readGenerationMemory(transaction([{ ...row, status: "running" }]).tx, scope, [curriculum()])).rejects.toThrow();
  });

  it("retains only allowlisted public failure reasons and never a provider message", async () => {
    const row = { ...await buildRow(), status: "failed", error_message_key: "generation.invalidResponse" };
    expect((await readGenerationMemory(transaction([row]).tx, scope, [curriculum()])).builds[0]).toMatchObject({
      status: "failed", errorMessageKey: "generation.invalidResponse", readyVersionId: null,
    });
    const privateText = "upstream provider diagnostic and credential=private";
    const memory = await readGenerationMemory(transaction([{ ...row, error_message_key: privateText }]).tx, scope, [curriculum()]);
    expect(memory.builds[0]!.errorMessageKey).toBeNull();
    expect(JSON.stringify(memory)).not.toContain(privateText);
    expect((await readGenerationMemory(transaction([{ ...row, status: "running" }]).tx, scope, [curriculum()])).builds[0]!.errorMessageKey).toBeNull();
  });

  it.each(["owner_id", "conversation_id", "branch_id", "course_id", "draft_id"] as const)("rejects a foreign %s even if a storage result is misbound", async field => {
    const row = { ...await buildRow(), [field]: ids.missing };
    await expect(readGenerationMemory(transaction([row]).tx, scope, [curriculum()])).rejects.toThrow();
  });

  it("rejects duplicate course projections and avoids querying when there are no artifacts", async () => {
    const row = await buildRow();
    await expect(readGenerationMemory(transaction([row, row]).tx, scope, [curriculum()])).rejects.toThrow();
    const h = transaction([]);
    expect(await readGenerationMemory(h.tx, scope, [])).toEqual({ version: "generation-status-v1", builds: [] });
    expect(h.query).not.toHaveBeenCalled();
  });

  it("adds actual persisted approval status to a newly constructed capture", async () => {
    const draft = { ...curriculum(), sourceIds: [] }, row = await buildRow(draft);
    vi.spyOn(curricula, "requireCourseDraft").mockResolvedValue({ draft,
      course: { id: draft.courseId, ownerId: ids.actor, slug: "test-course", title: draft.title, summary: draft.goal,
        contentLanguage: draft.contentLanguage, visibility: "private", revision: 1, currentReadyVersionId: null,
        publishedVersionId: null, createdAt: timestamp, updatedAt: timestamp } });
    const query = vi.fn(async (sql: string) => ({ rows:
      sql.startsWith("SELECT parts FROM unfurl.messages") ? [{ parts: [{ type: "text", text: "How is the course build going?" }] }]
        : sql.startsWith("SELECT ref.course_id") ? [{ course_id: draft.courseId, document: draft }]
          : sql.startsWith("SELECT DISTINCT ON (r.course_id)") ? [row] : [], rowCount: 0 }));
    const snapshot = await captureContext({ query } as unknown as DbTransaction,
      { kind: "agent_turn", ...scope, runId: ids.request, inputMessageId: ids.missing }, ids.task, 0, timestamp);
    expect(snapshot.generationMemory?.builds[0]).toMatchObject({ approvalId: ids.approval, approvalMatchesCurrentDraft: true,
      status: "running", phase: "building_tasks", readyVersionId: null });
    expect(snapshot.currentMessage).toBe("How is the course build going?");
  });

  it("changes only marked requests and preserves existing schemas, inputs and instruction prefixes", async () => {
    const old = ContextSnapshotSchema.parse({ kind: "context", index: 0, now: timestamp, currentMessage: "How is the course build going?",
      recentMessages: [], artifacts: [], sources: [], recentTools: [], agentProtocol: "conversational-v3",
      readerCapabilities: currentReaderCapabilities(), artifactMemory: await compactArtifactMemory([]), languageIntent: null });
    const before = JSON.stringify(old), budget = { reservationId: ids.request, logicalOperationId: ids.request, attempt: 1, runStepId: ids.task, probe: false };
    const legacy = buildAgentDecisionRequest(old, budget, 1234);
    const generationMemory = await readGenerationMemory(transaction([await buildRow()]).tx, scope, [curriculum()]);
    const fresh = buildAgentDecisionRequest(ContextSnapshotSchema.parse({ ...old, generationMemory }), budget, 1234);
    expect(legacy.instructionVersion).toBe("adaptive-course-agent-v3:text-sources-v1:saved-artifact-v1");
    expect(legacy.trustedInstructions).not.toContain("generationMemory");
    expect(fresh.instructionVersion).toBe(`${legacy.instructionVersion}:generation-status-v1`);
    expect(fresh.trustedInstructions.startsWith(`${legacy.trustedInstructions}\n`)).toBe(true);
    expect(fresh.trustedInstructions).toContain("a status question does not authorize rewriting the curriculum");
    expect(fresh.trustedInstructions).toContain("Explicit user requests to edit remain allowed");
    expect(fresh.schema).toBe(legacy.schema);
    expect(fresh.schemaVersion).toBe(legacy.schemaVersion);
    expect(fresh.untrustedInput).toEqual({ ...legacy.untrustedInput as object, generationMemory });
    expect(JSON.stringify(old)).toBe(before);
    expect(ContextSnapshotSchema.parse(old)).not.toHaveProperty("generationMemory");
    expect(GenerationMemorySchema.safeParse({ version: "future", builds: [] }).success).toBe(false);
  });
});
