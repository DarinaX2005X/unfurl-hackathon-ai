import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
vi.mock("server-only", () => ({}));
import { createTransactionRunner } from "../../src/server/db/transaction";

const actor = { id: "550e8400-e29b-41d4-a716-446655440000", sessionId: "550e8400-e29b-41d4-a716-446655440001", email: "a@example.com" };
const actorSetup = "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'";

function connection(failAt?: string) {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    statements.push({ text, ...(values ? { values } : {}) });
    if (text === failAt) throw new Error("database unavailable");
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query: query as unknown as PoolClient["query"], release })) };
  return { statements, query, release, runner: createTransactionRunner(pool) };
}

describe("PostgreSQL transaction protocol (no database emulation)", () => {
  it("keeps the verified actor role and claims local to one checked-out transaction", async () => {
    const state = connection();
    await state.runner.withActorTransaction(actor, async (tx) => {
      await tx.query("SELECT private_record WHERE owner_id = $1", [actor.id]);
      return "saved";
    });
    expect(state.statements[0]?.text).toBe(actorSetup);
    expect(state.statements.find((entry) => entry.text.includes("set_config"))?.values).toEqual([
      JSON.stringify({ sub: actor.id, role: "authenticated", session_id: actor.sessionId }),
    ]);
    expect(state.statements.at(-1)?.text).toBe("COMMIT");
    expect(state.statements).toHaveLength(4);
    expect(state.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("rolls back all related effects on failure and never commits", async () => {
    const state = connection("write_attempt");
    await expect(state.runner.withActorTransaction(actor, async (tx) => {
      await tx.query("write_attempt");
    })).rejects.toThrow("database unavailable");
    expect(state.statements.at(-1)?.text).toBe("ROLLBACK");
    expect(state.statements.map((entry) => entry.text)).not.toContain("COMMIT");
    expect(state.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("destroys a connection that could not begin or roll back", async () => {
    const beginning = connection(actorSetup);
    await expect(beginning.runner.withActorTransaction(actor, async () => null)).rejects.toThrow();
    expect(beginning.statements.at(-1)?.text).toBe("ROLLBACK");
    expect(beginning.release).toHaveBeenCalledExactlyOnceWith(true);
    const rollback = connection("ROLLBACK");
    await expect(rollback.runner.withActorTransaction(actor, async () => { throw new Error("original"); })).rejects.toThrow("original");
    expect(rollback.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("uses an explicit service role only at the separate system boundary", async () => {
    const state = connection();
    await state.runner.withSystemTransaction("evaluation", async () => null);
    expect(state.statements[0]?.text).toBe("BEGIN; SET LOCAL ROLE service_role; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'");
    expect(state.statements.some((entry) => entry.text.includes("request.jwt.claims"))).toBe(false);
  });

  it("never executes private work when parameterized actor claims fail", async () => {
    const state = connection("SELECT set_config('request.jwt.claims', $1, true)");
    const work = vi.fn();
    await expect(state.runner.withActorTransaction(actor, work)).rejects.toThrow("database unavailable");
    expect(work).not.toHaveBeenCalled();
    expect(state.statements.at(-1)?.text).toBe("ROLLBACK");
    expect(state.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps all actor values out of the fixed setup SQL", async () => {
    const state = connection();
    const supplied = { ...actor, sessionId: "'; SET ROLE service_role; --" };
    await state.runner.withActorTransaction(supplied, async () => null);
    expect(state.statements[0]).toEqual({ text: actorSetup });
    expect(state.statements[1]?.values).toEqual([
      JSON.stringify({ sub: supplied.id, role: "authenticated", session_id: supplied.sessionId }),
    ]);
    expect(state.statements.every((entry) => !entry.text.includes(supplied.sessionId))).toBe(true);
  });
});
