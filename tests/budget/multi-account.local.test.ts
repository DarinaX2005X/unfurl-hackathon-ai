import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PostgresBudget } from "../../src/server/budget/postgres";
import { jsonDigest } from "../../src/server/ai/json";
import type { DbTransaction } from "../../src/server/db";
import type { ReserveRequest } from "../../src/server/budget/ports";
import { runStateRelativeLedgerProof, assertCertifiableLedgerProof, LEDGER_PROOF_TEST_CASES } from "../../src/server/budget/ledger-proof";

// Optional isolated PostgreSQL/WASM engine; never reads credentials or connects to the application DB.
const modulePath = process.env.BUDGET_LOCAL_PG_MODULE;
interface LocalSql { exec(sql: string): Promise<unknown>; query(sql: string, values?: unknown[]): Promise<unknown>; close(): Promise<void> }
describe.skipIf(!modulePath)("actual budget adapter with many held operations (isolated local SQL)", () => {
  let sql: LocalSql;
  let ledger: PostgresBudget;
  let tx: DbTransaction;
  const budgetId = randomUUID();
  const rateCard = { model: "moonshotai/kimi-k2.6", provider: "digitalocean", policyVersion: "kimi-digitalocean-v1" };
  function request(amount = "1000"): ReserveRequest {
    return { reservationId: randomUUID(), logicalOperationId: randomUUID(), attempt: 1, runStepId: null,
      probe: false, purpose: "curriculum", amountMicroUsd: amount, requestDigest: "a".repeat(64), rateCardDigest: jsonDigest(rateCard), rateCard };
  }
  beforeAll(async () => {
    const runtime = await import(/* @vite-ignore */ pathToFileURL(modulePath!).href) as { PGlite: new (options: { parsers: Record<number, (value: string) => string> }) => LocalSql };
    // Match node-postgres's string representation of int8 money columns.
    sql = new runtime.PGlite({ parsers: { 20: value => value } });
    const migration = await readFile("supabase/migrations/202610250004_execution_and_budget.sql", "utf8");
    const tables = migration.slice(migration.indexOf("create table unfurl.ai_budgets"), migration.indexOf("create table unfurl.execution_capability_receipts"));
    await sql.exec(`CREATE ROLE service_role SUPERUSER; CREATE SCHEMA unfurl; CREATE TABLE unfurl.run_steps(id uuid PRIMARY KEY); ${tables}
      CREATE TABLE unfurl.ai_provider_terminal_http_400_receipts(operation_id uuid);
      CREATE TABLE unfurl.ai_provider_attempt_retirements(operation_id uuid,kind text,job_id uuid,from_epoch integer,actor_id uuid);
      CREATE TABLE unfurl.execution_job_retry_receipts(job_id uuid,from_epoch integer,actor_id uuid);
      CREATE TABLE unfurl.ai_provider_response_normalizations(operation_id uuid,normalizer_version text,response_digest text,evidence_digest text,native_usage jsonb,source_evidence jsonb);`);
    await sql.query("INSERT INTO unfurl.ai_budgets(id,campaign_key) VALUES($1,'isolated-test')", [budgetId]);
    tx = { query: async (text: string, values?: unknown[]) => !values && text.includes(";")
      ? (await sql.exec(text) as unknown[]).at(-1) : sql.query(text, values) } as DbTransaction;
    ledger = new PostgresBudget(budgetId, async work => {
      await sql.exec("SAVEPOINT adapter");
      try { const result = await work(tx); await sql.exec("RELEASE SAVEPOINT adapter"); return result; }
      catch (error) { await sql.exec("ROLLBACK TO SAVEPOINT adapter; RELEASE SAVEPOINT adapter"); throw error; }
    });
  });
  afterAll(async () => { await sql?.close(); });
  it("admits after 100 unknown requests, retains their cost, and still enforces the $10 campaign", async () => {
    await sql.exec("BEGIN");
    try {
      for (let index = 0; index < 100; index++) {
        const held = await ledger.reserve(request());
        await ledger.claimDispatch(held);
        await ledger.markUnknown(held, "timeout");
      }
      const heldRows = await sql.query("SELECT id,state,reserved_micro_usd FROM unfurl.ai_provider_operations ORDER BY id");
      await expect(ledger.assertAvailable({ probe: false })).resolves.toBeUndefined();
      const extra = await ledger.reserve(request());
      await ledger.releaseUnsent(extra);
      expect(await sql.query("SELECT id,state,reserved_micro_usd FROM unfurl.ai_provider_operations WHERE state='unknown' ORDER BY id")).toEqual(heldRows);
      const counter = await sql.query("SELECT reserved_micro_usd::text,settled_micro_usd::text FROM unfurl.ai_budgets WHERE id=$1", [budgetId]);
      expect(counter).toMatchObject({ rows: [{ reserved_micro_usd: "100000", settled_micro_usd: "0" }] });
      await expect(ledger.reserve(request("9400001"))).rejects.toMatchObject({ code: "budget_exhausted" });
      const exact = await ledger.reserve(request("9400000"));
      await expect(ledger.assertAvailable({ probe: false })).rejects.toMatchObject({ code: "budget_exhausted" });
      await ledger.releaseUnsent(exact);
      await expect(ledger.assertAvailable({ probe: false })).resolves.toBeUndefined();
      expect(await sql.query("SELECT reserved_micro_usd::text,settled_micro_usd::text FROM unfurl.ai_budgets WHERE id=$1", [budgetId])).toEqual(counter);
    } finally { await sql.exec("ROLLBACK"); }
  }, 30_000);

  it("executes the proof's rollback SQL and checks a simulated contended peer separately", async () => {
    // PGlite has one backend: real peer-lock evidence remains the separate explicit live proof.
    const peer = { query: vi.fn(async (text: string) => {
      if (text.includes("FROM unfurl.ai_budgets") && text.includes("FOR UPDATE")) throw Object.assign(new Error("simulated lock contention"), { code: "55P03" });
      return { rows: [], rowCount: 0 };
    }) } as unknown as DbTransaction;
    const report = await runStateRelativeLedgerProof({ budgetId, primary: tx, peer, sourceHash: "a".repeat(64) });
    expect(report.caseRollbacks.map(proof => proof.name)).toEqual([...LEDGER_PROOF_TEST_CASES]);
    expect(report.postProofState).toEqual(report.originalObservedState);
    expect(() => assertCertifiableLedgerProof(report, { sourceHash: "a".repeat(64), reportSha256: "b".repeat(64) })).not.toThrow();
  }, 30_000);
});
