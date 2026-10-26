import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DbTransaction } from "../../src/server/db";
import { captureNewJobOutputPolicy, effectStepSql, readJobOutputPolicy, readStepOutputPolicy, type OutputPolicyTarget } from "../../src/server/runs/output-policy";
import { OUTPUT_POLICY_STEP_KEY, resolveProviderOutput } from "../../src/server/ai/output-policy";
import { stableExecutionId } from "../../src/server/runs/identity";
import { PostgresBudget } from "../../src/server/budget/postgres";
import { approveEndpoint } from "../../src/server/ai/rate-card";
import { loadProviderResponseEvidence } from "../../src/server/ai/receipts";
import { jsonDigest } from "../../src/server/ai/json";
import { captureProviderOutputRateCard } from "../../src/server/ai/openrouter";

const modulePath = process.env.BUDGET_LOCAL_PG_MODULE;
interface LocalSql { exec(sql: string): Promise<unknown>; query(sql: string, values?: unknown[]): Promise<unknown>; close(): Promise<void> }

describe.skipIf(!modulePath)("new job output captures and stored responses (isolated PostgreSQL)", () => {
  let sql: LocalSql, tx: DbTransaction, budget: PostgresBudget;
  const budgetId = randomUUID();
  beforeAll(async () => {
    const runtime = await import(/* @vite-ignore */ pathToFileURL(modulePath!).href) as { PGlite: new (options: { parsers: Record<number, (value: string) => string> }) => LocalSql };
    sql = new runtime.PGlite({ parsers: { 20: value => value } });
    const migration = await readFile("supabase/migrations/202610250004_execution_and_budget.sql", "utf8");
    const tables = migration.slice(migration.indexOf("create table unfurl.ai_budgets"), migration.indexOf("create table unfurl.execution_capability_receipts"));
    await sql.exec(`CREATE ROLE service_role SUPERUSER; CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA unfurl;
      CREATE FUNCTION unfurl.reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable receipt'; END $$;
      CREATE TABLE unfurl.execution_jobs(id uuid PRIMARY KEY,agent_turn_run_id uuid,generation_run_id uuid,evaluation_id uuid,target_evaluation_revision integer,activity_action_id uuid);
      CREATE TABLE unfurl.run_steps(id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES unfurl.execution_jobs(id),step_key text NOT NULL,
        status text NOT NULL,input_digest text NOT NULL,schema_digest text NOT NULL,capability_digest text NOT NULL,validation_policy_digest text NOT NULL,
        result_reference jsonb,CONSTRAINT run_step_result_bound CHECK(result_reference IS NULL OR octet_length(result_reference::text)<=2097152),UNIQUE(job_id,step_key));
      ${tables}
      CREATE TABLE unfurl.ai_provider_response_normalizations(operation_id uuid,normalizer_version text,response_digest text,evidence_digest text,native_usage jsonb,source_evidence jsonb);`);
    await sql.query("INSERT INTO unfurl.ai_budgets(id,campaign_key) VALUES($1,'isolated-output-policy')", [budgetId]);
    await sql.exec(await readFile("supabase/migrations/202610250026_total_campaign_budget.sql", "utf8"));
    await sql.exec(await readFile("supabase/migrations/202610250027_provider_max_output.sql", "utf8"));
    await sql.exec(await readFile("supabase/migrations/202610250029_execution_funding.sql", "utf8"));
    tx = { query: (query: string, values?: unknown[]) => sql.query(query, values) } as DbTransaction;
    budget = new PostgresBudget(budgetId, async work => {
      await sql.exec("SAVEPOINT adapter");
      try { const result = await work(tx); await sql.exec("RELEASE SAVEPOINT adapter"); return result; }
      catch (error) { await sql.exec("ROLLBACK TO SAVEPOINT adapter; RELEASE SAVEPOINT adapter"); throw error; }
    });
  });
  afterAll(async () => { await sql?.close(); });

  async function job(target: OutputPolicyTarget, capture = true) {
    const jobId = randomUUID();
    const column = target.kind === "agent_turn" ? "agent_turn_run_id" : target.kind === "generation" ? "generation_run_id"
      : target.kind === "evaluation" ? "evaluation_id" : "activity_action_id";
    const targetId = "runId" in target ? target.runId : "evaluationId" in target ? target.evaluationId : target.activityActionId;
    await tx.query(`INSERT INTO unfurl.execution_jobs(id,${column},target_evaluation_revision) VALUES($1,$2,$3)`,
      [jobId, targetId, target.kind === "evaluation" ? target.targetEvaluationRevision : null]);
    if (capture) await captureNewJobOutputPolicy(tx, jobId, target);
    return jobId;
  }

  it.each(["agent_turn", "generation", "evaluation", "activity_action"] as const)("binds %s once and does not mistake configuration for executed work", async kind => {
    await sql.exec("BEGIN");
    try {
      const id = randomUUID(), target: OutputPolicyTarget = kind === "evaluation" ? { kind, evaluationId: id, targetEvaluationRevision: 1 }
        : kind === "activity_action" ? { kind, activityActionId: id } : { kind, runId: id };
      const jobId = await job(target), capture = await readJobOutputPolicy(tx, jobId);
      expect(capture).toMatchObject({ jobId, receiptId: stableExecutionId(jobId, OUTPUT_POLICY_STEP_KEY), version: "provider-max-output-v1" });
      expect((await tx.query(`SELECT EXISTS(SELECT 1 FROM unfurl.run_steps WHERE job_id=$1 AND ${effectStepSql()}) AS actual_effect`, [jobId])).rows[0]).toEqual({ actual_effect: false });
      await expect(captureNewJobOutputPolicy(tx, jobId, target)).rejects.toThrow();
    } finally { await sql.exec("ROLLBACK"); }
  });

  it("never adopts an existing unmarked job while reading or resuming its policy", async () => {
    await sql.exec("BEGIN");
    try {
      const jobId = await job({ kind: "agent_turn", runId: randomUUID() }, false);
      expect(await readJobOutputPolicy(tx, jobId)).toBeUndefined();
      expect((await tx.query("SELECT count(*)::int AS count FROM unfurl.run_steps WHERE job_id=$1", [jobId])).rows[0]).toEqual({ count: 0 });
    } finally { await sql.exec("ROLLBACK"); }
  });

  it("binds the same complete allowance to the immutable operation and all central receipt readers", async () => {
    await sql.exec("BEGIN");
    try {
      const jobId = await job({ kind: "generation", runId: randomUUID() }), outputPolicy = (await readJobOutputPolicy(tx, jobId))!;
      const stepId = randomUUID(), inputDigest = jsonDigest({ completeInput: true });
      await tx.query(`INSERT INTO unfurl.run_steps(id,job_id,step_key,status,input_digest,schema_digest,capability_digest,validation_policy_digest)
        VALUES($1,$2,'course/test','running',$3,$3,$3,$3)`, [stepId, jobId, inputDigest]);
      expect(await readStepOutputPolicy(tx, stepId)).toEqual(outputPolicy);
      const rawRate = approveEndpoint({ data: { endpoints: [{ name: "DigitalOcean | moonshotai/kimi-k2.6-20260420", model_id: "moonshotai/kimi-k2.6",
        provider_name: "DigitalOcean", tag: "digitalocean", context_length: 262144, max_completion_tokens: 235929,
        supported_parameters: ["max_tokens", "tools", "tool_choice"], status: 0, pricing: { prompt: "0.00000060", completion: "0.00000260" } }] } });
      const logicalOperationId = stableExecutionId(stepId, "model"), context = { reservationId: stableExecutionId(logicalOperationId, "attempt:1"),
        logicalOperationId, attempt: 1, runStepId: stepId, probe: false, outputPolicy };
      const rate = captureProviderOutputRateCard({operationId:logicalOperationId,purpose:"module_knowledge",instructionVersion:"test-v1",
        trustedInstructions:"Return full data.",untrustedInput:{completeInput:true},model:"moonshotai/kimi-k2.6",maxOutputTokens:1,
        deadlineAt:Date.now()+60000,budget:context},rawRate);
      const requestDigest = "b".repeat(64);
      const request = { ...context, requestDigest, purpose: "module_knowledge" as const, amountMicroUsd: "770703", rateCardDigest: rate.digest, rateCard: rate.snapshot };
      await expect(budget.reserve({ ...request, amountMicroUsd: "1" })).rejects.toMatchObject({ code: "unavailable" });
      const reserved = await budget.reserve(request);
      expect((await budget.existingAllocation(context))?.rateCard).toEqual(rate.snapshot);
      await expect(budget.existingAllocation({ ...context, runStepId: randomUUID() })).rejects.toThrow();
      await budget.claimDispatch(reserved);
      const content = JSON.stringify({ completeAnswer: "x".repeat(2 * 1024 * 1024 + 64) });
      const result = { model: "moonshotai/kimi-k2.6", provider: "DigitalOcean", content, failure: null, finishReason: "stop",
        outputResolution: { ...resolveProviderOutput(outputPolicy, rate.snapshot, rate.digest), requestDigest } };
      await budget.recordResponse(reserved, { providerRequestId: "gen-isolated-output-proof", responseDigest: "c".repeat(64), reportedCostUsd: "0.000001", usage: {}, result }, "1");
      const loaded = await loadProviderResponseEvidence(tx, { operationId: reserved.id, runStepId: stepId, inputDigest, requestDigest });
      expect(loaded.result).toEqual(result);
      await tx.query("UPDATE unfurl.run_steps SET result_reference=$2::jsonb WHERE id=$1", [stepId, JSON.stringify({ complete: content })]);
      expect((await tx.query("SELECT octet_length(result_reference::text)>2097152 AS complete FROM unfurl.run_steps WHERE id=$1", [stepId])).rows[0]).toEqual({ complete: true });
      await tx.query("UPDATE unfurl.ai_provider_responses SET result=jsonb_set(result,'{outputResolution,maxOutputTokens}','16384') WHERE operation_id=$1", [reserved.id]);
      await expect(loadProviderResponseEvidence(tx, { operationId: reserved.id, runStepId: stepId, inputDigest })).rejects.toMatchObject({ code: "invalid_output" });
    } finally { await sql.exec("ROLLBACK"); }
  }, 30_000);
});
