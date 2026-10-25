import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PostgresBudget, type BudgetTransactionRunner } from "../../src/server/budget/postgres";
import { jsonDigest } from "../../src/server/ai/json";
import type { ProviderResponseReceipt, ReserveRequest } from "../../src/server/budget/ports";

// Explicit opt-in, authenticated TLS, rollback-only. Never invokes an inference endpoint.
const live = process.env.RUN_LIVE_LEDGER === "1";
const ledgerTest = (name: string, test: () => Promise<void>) => it(name, test, 30_000);
describe.skipIf(!live)("actual migrated budget ledger (rollback fixtures)", () => {
  let client: Client;
  let peer: Client;
  let ledger: PostgresBudget;
  const budgetId = process.env.AI_BUDGET_ID ?? "";
  function connection() {
    const ref = process.env.SUPABASE_PROJECT_REF;
    const url = new URL(process.env.DIRECT_DATABASE_URL ?? "");
    if (!ref || (!decodeURIComponent(url.username).endsWith(`.${ref}`) && url.hostname !== `db.${ref}.supabase.co`) || url.port === "6543") throw new Error("Invalid test database target");
    for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
    return new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true,
      ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}) }, connectionTimeoutMillis: 5000 });
  }
  function runner(connection: Client): BudgetTransactionRunner {
    return async (work) => {
      await connection.query("SAVEPOINT ledger_operation");
      try { const result = await work(connection); await connection.query("RELEASE SAVEPOINT ledger_operation"); return result; }
      catch (error) { await connection.query("ROLLBACK TO SAVEPOINT ledger_operation"); throw error; }
    };
  }
  function input(amount = "10000", probe = false): ReserveRequest {
    const rateCard = { model: "moonshotai/kimi-k2.6", fixture: "rollback-only" };
    return { reservationId: randomUUID(), logicalOperationId: randomUUID(), attempt: 1, runStepId: null,
      probe, purpose: probe ? "capability_probe" : "curriculum", amountMicroUsd: amount,
      requestDigest: "a".repeat(64), rateCardDigest: jsonDigest(rateCard), rateCard };
  }
  function response(): ProviderResponseReceipt {
    return { providerRequestId: `rollback-${randomUUID()}`, responseDigest: "b".repeat(64), reportedCostUsd: "0.001", usage: { promptTokens: 10 }, result: { answer: "private stored output" } };
  }
  async function counters() {
    return (await client.query("SELECT settled_micro_usd::text AS spent,reserved_micro_usd::text AS held,halted FROM unfurl.ai_budgets WHERE id=$1", [budgetId])).rows[0];
  }
  beforeAll(async () => {
    client = connection(); peer = connection(); await client.connect(); await peer.connect();
    if (!budgetId) throw new Error("Missing fixed campaign");
    ledger = new PostgresBudget(budgetId, runner(client));
  });
  beforeEach(async () => {
    await client.query("BEGIN"); await client.query("SET LOCAL ROLE service_role");
    await client.query("SET LOCAL statement_timeout='10s'");
    const initial = await counters();
    // This proof is valid only before paid operations. It never resets real spend.
    expect(initial).toEqual({ spent: "0", held: "0", halted: false });
  });
  afterEach(async () => { await client.query("ROLLBACK"); await peer.query("ROLLBACK"); });
  afterAll(async () => { await client?.end(); await peer?.end(); });

  ledgerTest("replays reservation/receipt/settlement once and refuses changed attempt input", async () => {
    const request = input(); const first = await ledger.reserve(request);
    expect(await ledger.reserve(request)).toEqual(first);
    await expect(ledger.reserve({ ...request, requestDigest: "c".repeat(64) })).rejects.toThrow("provider.unavailable");
    expect(await ledger.claimDispatch(first)).toEqual({ kind: "dispatch" });
    await expect(ledger.claimDispatch(first)).rejects.toThrow("provider.unavailable");
    const receipt = response(); await ledger.recordResponse(first, receipt, "1000"); await ledger.recordResponse(first, receipt, "1000");
    expect(await ledger.recover(request, request.requestDigest)).toMatchObject({ receipt });
    expect(await ledger.claimDispatch(first)).toEqual({ kind: "replay", receipt });
    expect(await counters()).toEqual({ spent: "1000", held: "0", halted: false });
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.ai_budget_entries WHERE operation_id=$1", [first.id])).rows[0].n).toBe(2);
  });
  ledgerTest("retains unknown holds/slots, rejects third admission and reconciles with evidence once", async () => {
    const one = await ledger.reserve(input()); await ledger.claimDispatch(one); await ledger.markUnknown(one, "timeout");
    await expect(ledger.releaseUnsent(one)).rejects.toThrow("provider.unavailable");
    const request = input(); const two = await ledger.reserve(request); await ledger.claimDispatch(two);
    const receipt = response(); await ledger.recordResponse(two, receipt, null);
    await expect(ledger.reserve(input())).rejects.toThrow("provider.budget_exhausted");
    expect(await counters()).toEqual({ spent: "0", held: "20000", halted: false });
    const evidence = { providerRequestId: receipt.providerRequestId!, digest: "d".repeat(64), finalCostMicroUsd: "1200" };
    await ledger.reconcile(two, evidence); await ledger.reconcile(two, evidence);
    expect(await counters()).toEqual({ spent: "1200", held: "10000", halted: false });
    expect(await ledger.recover(request, request.requestDigest)).toMatchObject({ receipt });
  });
  ledgerTest("enforces campaign and probe limits inside one fixed campaign", async () => {
    await expect(ledger.reserve(input("1000001", true))).rejects.toThrow("provider.budget_exhausted");
    const one = await ledger.reserve(input("9400000"));
    await expect(ledger.reserve(input("100001"))).rejects.toThrow("provider.budget_exhausted");
    await ledger.releaseUnsent(one); await ledger.releaseUnsent(one);
    expect(await counters()).toEqual({ spent: "0", held: "0", halted: false });
  });
  ledgerTest("records overrun truthfully and halts instead of rolling the cost back", async () => {
    const one = await ledger.reserve(input("100")); await ledger.claimDispatch(one);
    await ledger.recordResponse(one, response(), "101");
    expect(await counters()).toEqual({ spent: "101", held: "0", halted: true });
    await expect(ledger.reserve(input())).rejects.toThrow("provider.budget_exhausted");
  });
  ledgerTest("serializes actual competing adapter reservations on the database campaign lock", async () => {
    await ledger.reserve(input()); // Outer rollback transaction holds campaign lock.
    await peer.query("BEGIN"); await peer.query("SET LOCAL ROLE service_role"); await peer.query("SET LOCAL lock_timeout='150ms'");
    const competing = new PostgresBudget(budgetId, runner(peer));
    await expect(competing.reserve(input())).rejects.toMatchObject({ code: "55P03" });
    await client.query("ROLLBACK");
    expect((await competing.reserve(input())).state).toBe("reserved");
    await peer.query("ROLLBACK");
    expect(await counters()).toEqual({ spent: "0", held: "0", halted: false });
  });
});
