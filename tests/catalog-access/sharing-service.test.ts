import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharingService, type SharingTransactions } from "../../src/server/sharing/service";
import { hashShareToken } from "../../src/server/sharing/crypto";
import type { DbTransaction } from "../../src/server/db";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001", session: "10000000-0000-4000-8000-000000000002",
  course: "10000000-0000-4000-8000-000000000003", version: "10000000-0000-4000-8000-000000000004",
  grant: "10000000-0000-4000-8000-000000000005", request: "10000000-0000-4000-8000-000000000006",
};
const actor = { id: ids.actor, sessionId: ids.session, email: null };
const key = new Uint8Array(32).fill(9);
const config = { activeVersion: "v1", keys: new Map([["v1", key]]) };
const rows = (items: unknown[] = []) => ({ rows: items, rowCount: items.length });

function transactions(tx: DbTransaction): SharingTransactions {
  return { access: async (work) => work(tx) };
}

describe("share grant service", () => {
  it("stores only a token hash and nonsecret idempotency receipt after course lock", async () => {
    const operations: string[] = [];
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      operations.push(sql);
      if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows([{ key: ids.request }]);
      if (sql.includes("FROM unfurl.courses WHERE id") && sql.includes("FOR UPDATE")) return rows([{
        id: ids.course, owner_id: ids.actor, visibility: "private", revision: 3,
        current_ready_version_id: ids.version, published_version_id: null,
      }]);
      if (sql.startsWith("SELECT v.id FROM unfurl.course_versions")) return rows([{ id: ids.version }]);
      if (sql.startsWith("UPDATE unfurl.courses SET visibility")) return rows([{ revision: 4 }]);
      return rows();
    });
    const service = createSharingService({ transactions: transactions({ query } as unknown as DbTransaction), configuration: () => config, createId: () => ids.grant });
    const result = await service.create(actor, ids.course, { courseVersionId: ids.version, expectedCourseRevision: 3 }, ids.request);
    expect(result.status).toBe(201);
    expect(result.data.shareUrl).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/);
    const grantInsert = query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO unfurl.share_grants"));
    const token = result.data.shareUrl.slice(3);
    expect(grantInsert?.[1]).toEqual([ids.grant, ids.course, ids.version, ids.actor, hashShareToken(token), "v1"]);
    expect(JSON.stringify(grantInsert?.[1])).not.toContain(token);
    const receiptWrite = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE unfurl.idempotency"));
    expect(JSON.stringify(receiptWrite?.[1])).not.toContain(token);
    expect(operations.findIndex((sql) => sql.includes("FROM unfurl.courses WHERE id")))
      .toBeLessThan(operations.findIndex((sql) => sql.startsWith("INSERT INTO unfurl.share_grants")));
  });

  it("reconstructs an idempotent token only after locking course then active grant", async () => {
    const calls: string[] = [];
    const stored = { grantId: ids.grant, keyVersion: "v1", courseRevision: 4 };
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows();
      if (sql.includes("FROM unfurl.idempotency")) return rows([{
        request_digest: "9cd8e65ae1a1f7d5ff9e2ebf21af9ac2b373b455022b3b467e65a2848c0a91f9",
        response_status: 201, response_data: stored,
      }]);
      if (sql.includes("FROM unfurl.courses WHERE id")) return rows([{ id: ids.course, owner_id: ids.actor,
        visibility: "unlisted", revision: 7, current_ready_version_id: ids.version, published_version_id: null }]);
      if (sql.includes("FROM unfurl.share_grants")) return rows([{ id: ids.grant, course_version_id: ids.version, token_key_version: "v1", revoked_at: null }]);
      return rows();
    });
    const service = createSharingService({ transactions: transactions({ query } as unknown as DbTransaction), configuration: () => config, createId: () => crypto.randomUUID() });
    // Supply the actual digest expected by the generic idempotency helper.
    const { requestDigest } = await import("../../src/server/idempotency");
    vi.mocked(query).mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows();
      if (sql.includes("FROM unfurl.idempotency")) return rows([{ request_digest: requestDigest({ courseVersionId: ids.version, expectedCourseRevision: 3 }), response_status: 201, response_data: stored }]);
      if (sql.includes("FROM unfurl.courses WHERE id")) return rows([{ id: ids.course, owner_id: ids.actor, visibility: "unlisted", revision: 7, current_ready_version_id: ids.version, published_version_id: null }]);
      if (sql.includes("FROM unfurl.share_grants")) return rows([{ id: ids.grant, course_version_id: ids.version, token_key_version: "v1", revoked_at: null }]);
      return rows();
    });
    const result = await service.create(actor, ids.course, { courseVersionId: ids.version, expectedCourseRevision: 3 }, ids.request);
    expect(result.replayed).toBe(true);
    const courseLock = calls.findIndex((sql) => sql.includes("FROM unfurl.courses WHERE id"));
    const grantLock = calls.findIndex((sql) => sql.includes("FROM unfurl.share_grants"));
    expect(courseLock).toBeGreaterThan(-1);
    expect(courseLock).toBeLessThan(grantLock);
    expect(calls.some((sql) => sql.startsWith("INSERT INTO unfurl.share_grants"))).toBe(false);
  });
});
