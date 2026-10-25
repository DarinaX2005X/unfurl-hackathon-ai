import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { executeIdempotentInTransaction, requestDigest } from "../../src/server/idempotency";
import type { DbTransaction } from "../../src/server/db";

const actor = { id: "550e8400-e29b-41d4-a716-446655440000", sessionId: "550e8400-e29b-41d4-a716-446655440001", email: null };
const key = "550e8400-e29b-41d4-a716-446655440002";
const schema = z.object({ id: z.string() }).strict();
const command = { operation: "profile.update", key, body: { name: "Learner", expectedRevision: 2 }, parseResult: schema };

describe("durable idempotency command protocol", () => {
  it("uses a canonical digest independent of object insertion order", () => {
    expect(requestDigest({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(requestDigest({ b: { d: [3, 4], c: 2 }, a: 1 }));
    expect(requestDigest({ a: [1, 2] })).not.toBe(requestDigest({ a: [2, 1] }));
    expect(() => requestDigest({ value: Number.NaN })).toThrow();
  });

  it("records the committed response in the same transaction as its mutation", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      return { rows: text.startsWith("INSERT") ? [{ key }] : [], rowCount: 1 };
    });
    const tx = { query } as unknown as DbTransaction;
    const result = await executeIdempotentInTransaction(tx, actor, command, async (sameTx) => {
      expect(sameTx).toBe(tx);
      calls.push("business mutation");
      return { status: 200, data: { id: "saved" } };
    });
    expect(result).toEqual({ status: 200, data: { id: "saved" }, replayed: false });
    expect(calls[0]).toContain("ON CONFLICT (actor_id, operation, key) DO NOTHING");
    expect(calls[1]).toBe("business mutation");
    expect(calls[2]).toContain("UPDATE unfurl.idempotency");
  });

  it("replays the original result without invoking a second mutation", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      request_digest: requestDigest(command.body), response_status: 201, response_data: { id: "original" },
    }] });
    const mutation = vi.fn();
    const result = await executeIdempotentInTransaction({ query } as DbTransaction, actor, command, mutation);
    expect(result).toEqual({ status: 201, data: { id: "original" }, replayed: true });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects reuse of the same identity for a different body", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      request_digest: requestDigest({ different: true }), response_status: 200, response_data: { id: "original" },
    }] });
    const mutation = vi.fn();
    await expect(executeIdempotentInTransaction({ query } as DbTransaction, actor, command, mutation)).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(mutation).not.toHaveBeenCalled();
  });
});
