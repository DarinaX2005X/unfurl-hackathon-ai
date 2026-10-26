import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/idempotency", () => ({ executeIdempotentInTransaction: vi.fn(async () => ({ replayed: true, status: 202, data: {} })) }));
import type { DbTransaction } from "../../src/server/db";
import { approveInTransaction, requireIdleAuthoringConversation } from "../../src/server/curricula/repository";
import { createCurriculumService } from "../../src/server/curricula/service";
import { curriculumDigest } from "../../src/domain/course";
import { curriculum, ids, timestamp } from "./fixtures";

function fixture(options: { active?: boolean; locked?: boolean } = {}) {
  const draft = curriculum();
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[];
    if (sql.includes("SELECT d.course_id")) rows = [{ course_id: draft.courseId }];
    else if (sql.includes("SELECT * FROM unfurl.courses")) rows = [{ id: draft.courseId, owner_id: ids.actor, slug: "test-course",
      title: draft.title, summary: draft.goal, content_language: "en", visibility: "private", current_ready_version_id: null,
      published_version_id: null, revision: 1, created_at: timestamp, updated_at: timestamp }];
    else if (sql.includes("SELECT document,revision")) rows = [{ document: draft, revision: draft.revision }];
    else if (sql.includes("FROM unfurl.conversations c")) {
      expect(values).toEqual([draft.conversationId, ids.actor]);
      if (options.locked) throw Object.assign(new Error("lock unavailable"), { code: "55P03" });
      rows = [{ active_branch_id: ids.sample, input_message_id: ids.task }];
    } else if (sql.includes("FROM unfurl.agent_turn_runs")) {
      expect(values).toEqual([ids.actor, draft.conversationId]);
      expect(sql).toContain("status IN ('queued','running')");
      expect(sql).not.toMatch(/branch_id|draft_id|course_id|FOR UPDATE/);
      rows = options.active ? [{ id: ids.request }] : [];
    } else if (sql.includes("FROM unfurl.curriculum_patch_intents")) rows = [];
    else throw new Error(`Unexpected query: ${sql}`);
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  });
  return { draft, query, tx: { query } as unknown as DbTransaction };
}

describe("approval waits for all conversation authoring", () => {
  it("takes a nonblocking conversation gate and checks every branch and course", async () => {
    const { tx, draft, query } = fixture({ active: true });
    await expect(requireIdleAuthoringConversation(tx, ids.actor, draft)).rejects.toMatchObject({ status: 409, messageKey: "curriculum.authoringInProgress" });
    expect(query.mock.calls[0]![0]).toContain("FOR SHARE OF c NOWAIT");
    expect(query.mock.calls).toHaveLength(2);
  });
  it("rejects a concurrent turn acceptance without waiting on its conversation lock", async () => {
    const { tx, draft, query } = fixture({ locked: true });
    await expect(requireIdleAuthoringConversation(tx, ids.actor, draft)).rejects.toMatchObject({ status: 409, messageKey: "curriculum.authoringInProgress" });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("allows an idle conversation after the same gate", async () => {
    const { tx, draft, query } = fixture();
    await expect(requireIdleAuthoringConversation(tx, ids.actor, draft)).resolves.toEqual({ branchId: ids.sample, inputMessageId: ids.task });
    expect(query.mock.calls[0]![0]).toContain("FOR SHARE OF c NOWAIT");
  });
  it("rejects ordinary active authoring before any approval, build, or job write", async () => {
    const { tx, draft, query } = fixture({ active: true });
    await expect(approveInTransaction(tx, { ownerId: ids.actor, draftId: draft.id, expectedRevision: draft.revision,
      contentDigest: await curriculumDigest(draft) })).rejects.toMatchObject({ status: 409, messageKey: "curriculum.authoringInProgress" });
    expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE unfurl/.test(sql))).toBe(false);
    expect(query.mock.calls[1]![0]).toContain("FOR UPDATE");
    expect(query.mock.calls[2]![0]).toContain("FOR UPDATE");
  });
  it("does not let an old idempotency receipt bypass the current authoring guard", async () => {
    const { tx, draft } = fixture({ active: true });
    const service = createCurriculumService({ transaction: (work) => work(tx), admission: { assertAvailable: async () => undefined } });
    await expect(service.approve({ id: ids.actor, sessionId: ids.request, email: null }, draft.id,
      { expectedRevision: 1, contentDigest: await curriculumDigest(draft) }, ids.request)).rejects.toMatchObject({ status: 409, messageKey: "curriculum.authoringInProgress" });
  });
  it("still enforces the revision compare-and-swap on an idle idempotency replay", async () => {
    const { tx, draft } = fixture();
    const service = createCurriculumService({ transaction: (work) => work(tx), admission: { assertAvailable: async () => undefined } });
    await expect(service.approve({ id: ids.actor, sessionId: ids.request, email: null }, draft.id,
      { expectedRevision: 2, contentDigest: await curriculumDigest(draft) }, ids.request)).rejects.toMatchObject({ status: 409, messageKey: "curriculum.changed" });
  });
});
