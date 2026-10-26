import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createConversationService, type ConversationTransactions } from "../../src/server/conversations/service";
import { requestDigest } from "../../src/server/idempotency";
import { curriculum, ids as courseIds } from "../domain/fixtures";
import { actor, at, composerRow, conversationRow, ids } from "./fixtures";

const runId = "70000000-0000-4000-8000-000000000001", digest = "a".repeat(64);
const draft = { ...curriculum(), conversationId: ids.conversation };
const run = { id: runId, retry_of_run_id: null, owner_id: actor.id, course_id: courseIds.course, conversation_id: ids.conversation,
  branch_id: ids.branch, input_message_id: ids.message, source_draft_revision: draft.revision, approval_id: courseIds.approval,
  phase: "building_tasks", status: "failed", last_seq: 1, output_version_id: null,
  error: { code: "generation_failed", messageKey: "generation.invalidResponse", retryable: false, requestId: ids.request },
  created_at: at, updated_at: at };
const importInput = { sourceId: ids.source, sourceRevision: 1, title: "Earlier work", composerText: "Keep", userMessages: [], sourceCreatedAt: at, sourceUpdatedAt: at };

function harness() {
  const state = { owner: actor.id as string, deleted: false };
  const calls: Array<{ role: "authenticated" | "service_role"; sql: string; values: unknown[] }> = [];
  const query = (role: "authenticated" | "service_role") => async (sql: string, values: unknown[] = []) => {
    calls.push({ role, sql, values });
    const rows = (items: unknown[] = []) => ({ rows: items, rowCount: items.length });
    if (sql.includes("curriculum_revisions") || sql.includes("version_validation_receipts")) {
      if (role === "authenticated") throw Object.assign(new Error("permission denied for table version_validation_receipts"), { code: "42501" });
      if (sql.startsWith("SELECT r.id,r.retry_of_run_id")) return rows([{ ...run, draft_id: draft.id, draft_revision: draft.revision,
        content_digest: digest, approved_at: at, document: draft, summary: "Saved course summary." }]);
      if (sql.startsWith("SELECT r.*,revision.document")) return rows([{ ...run, document: draft, content_digest: digest,
        completed: [], validation: null, timeline: [], ready_course: null }]);
    }
    if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows([{ key: ids.key }]);
    if (sql.includes("FROM unfurl.local_imports")) return rows([{ conversation_id: ids.conversation, source_digest: requestDigest(importInput), deleted_at: null }]);
    if (sql.includes("FROM unfurl.conversations WHERE")) return rows(state.deleted ? [] : [conversationRow(state.owner)]);
    if (sql.includes("FROM unfurl.composer_drafts")) return rows([composerRow()]);
    if (sql.includes("FROM unfurl.conversation_artifacts")) return rows([{ course_id: courseIds.course, title: draft.title, summary: "Saved course summary.",
      content_language: "en", revision: 2, ready_version_id: null, updated_at: at, document: draft,
      approval_requested_revision: null, approval_id: courseIds.approval, draft_id: draft.id, draft_revision: draft.revision,
      content_digest: digest, approved_by: actor.id, approved_at: at }]);
    return rows();
  };
  const actorQuery = query("authenticated"), systemQuery = query("service_role");
  const transactions: ConversationTransactions = {
    actor: async (_actor, work) => work({ query: actorQuery } as never),
    execution: async work => work({ query: systemQuery } as never),
  };
  return { state, calls, service: createConversationService({ transactions }) };
}

describe("private build projections use an authorized controlled read", () => {
  it("reads actual build history through service_role after freshly checking the requesting owner", async () => {
    const h = harness(), result = await h.service.get(actor, ids.conversation);
    expect(result.builds?.[0]?.approvalId).toBe(courseIds.approval);
    expect(result.builds?.[0]?.runs[0]?.snapshot.run.id).toBe(runId);
    expect(h.calls.every(call => call.role === "service_role")).toBe(true);
    expect(h.calls[0]).toMatchObject({ values: [ids.conversation, actor.id] });
    expect(h.calls[0]?.sql).toContain("owner_id = $2 AND deleted_at IS NULL");
    const history = h.calls.find(call => call.sql.startsWith("SELECT r.id,r.retry_of_run_id"));
    expect(history?.values).toEqual([ids.conversation, actor.id, ids.branch]);
  });
  it.each(["foreign", "deleted"] as const)("rejects a %s conversation before reading private build tables", async state => {
    const h = harness();
    if (state === "foreign") h.state.owner = ids.otherActor;
    else h.state.deleted = true;
    await expect(h.service.get(actor, ids.conversation)).rejects.toMatchObject({ status: 404 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.role).toBe("service_role");
  });
  it("reopens an existing import atomically through the controlled transaction and retains its build history", async () => {
    const h = harness(), result = await h.service.importLocal(actor, importInput, ids.key);
    expect(result.status).toBe(200);
    expect(result.data.conversation.builds?.[0]?.approvalId).toBe(courseIds.approval);
    expect(h.calls.every(call => call.role === "service_role")).toBe(true);
    const ownerIndex = h.calls.findIndex(call => call.sql.includes("FROM unfurl.conversations WHERE"));
    const privateIndex = h.calls.findIndex(call => call.sql.includes("curriculum_revisions"));
    expect(ownerIndex).toBeGreaterThan(-1);
    expect(privateIndex).toBeGreaterThan(ownerIndex);
    expect(h.calls.find(call => call.sql.includes("FROM unfurl.local_imports"))?.values).toEqual([actor.id, ids.source]);
  });
  it("does not read a foreign imported conversation even when its import row is returned", async () => {
    const h = harness(); h.state.owner = ids.otherActor;
    await expect(h.service.importLocal(actor, importInput, ids.key)).rejects.toMatchObject({ status: 404 });
    expect(h.calls.some(call => call.sql.includes("curriculum_revisions"))).toBe(false);
  });
});
