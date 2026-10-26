import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Live, rollback-only proof for execution accounting and the current campaign limits.
// node --env-file=.env.local supabase/verify-execution-schema.mjs --project-ref <ref>
const args = process.argv.slice(2);
const expectedRef = args[args.indexOf("--project-ref") + 1];
const checks = [];
let client;
let database;
let phase = "configuration";

function check(name, condition) {
  assert.ok(condition, `check_failed:${name}`);
  checks.push(name);
  console.log(JSON.stringify({ check: name, ok: true }));
}

async function rejected(name, sql, values, expectedCodes) {
  await client.query(`SAVEPOINT ${name}`);
  let code;
  try {
    await client.query(sql, values);
  } catch (error) {
    code = error.code;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  check(name, expectedCodes.includes(code));
}

try {
  if (!args.includes("--project-ref") || !/^[a-z]{20}$/.test(expectedRef ?? "")) {
    throw new Error("explicit_project_ref_required");
  }
  const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  database = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  if (process.env.SUPABASE_PROJECT_REF !== expectedRef
    || api.hostname !== `${expectedRef}.supabase.co`
    || !(decodeURIComponent(database.username).endsWith(`.${expectedRef}`) || database.hostname === `db.${expectedRef}.supabase.co`)
    || database.port === "6543") {
    throw new Error("target_project_mismatch_or_transaction_pooler");
  }
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) database.searchParams.delete(name);
  client = new pg.Client({
    connectionString: database.toString(),
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n") },
    application_name: "unfurl-execution-schema-proof",
  });
  await client.connect();

  phase = "migration_receipt";
  const receipt = await client.query(
    "SELECT count(*)::int AS count FROM unfurl_meta.schema_migrations WHERE version = '202610250004_execution_and_budget.sql'",
  );
  check("migration_004_receipt", receipt.rows[0]?.count === 1);

  phase = "rollback_constraints";
  const campaigns = await client.query("SELECT id FROM unfurl.ai_budgets ORDER BY id");
  if (campaigns.rowCount > 1) throw new Error("multiple_budget_campaigns");
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const budgetId = campaigns.rows[0]?.id ?? randomUUID();
  const operationId = randomUUID();
  const logicalOperationId = randomUUID();
  const digest = "a".repeat(64);
  if (campaigns.rowCount === 0) {
    await client.query(
      `INSERT INTO unfurl.ai_budgets (id, campaign_key)
        VALUES ($1, $2)`,
      [budgetId, `rollback-proof-${randomUUID()}`],
    );
  }
  const campaign = (await client.query(
    "SELECT hard_limit_micro_usd::text, spendable_limit_micro_usd::text FROM unfurl.ai_budgets WHERE id=$1",
    [budgetId],
  )).rows[0];
  check("fixed_campaign_limits", campaign?.hard_limit_micro_usd === "20000000"
    && campaign?.spendable_limit_micro_usd === "19500000");
  await rejected(
    "singleton_campaign_unique",
    "INSERT INTO unfurl.ai_budgets (id, campaign_key) VALUES ($1, $2)",
    [randomUUID(), `rollback-proof-${randomUUID()}`],
    ["23505"],
  );
  await rejected(
    "provider_operation_budget_fk",
    `INSERT INTO unfurl.ai_provider_operations
      (id,budget_id,logical_operation_id,attempt,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card)
      VALUES ($1,$2,$3,1,$4,'curriculum','reserved',1000,'moonshotai/kimi-k2.6','digitalocean',$4,'{}')`,
    [randomUUID(), randomUUID(), randomUUID(), digest],
    ["23503"],
  );
  await rejected(
    "provider_model_is_frozen",
    `INSERT INTO unfurl.ai_provider_operations
      (id,budget_id,logical_operation_id,attempt,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card)
      VALUES ($1,$2,$3,1,$4,'curriculum','reserved',1000,'another/model','digitalocean',$4,'{}')`,
    [randomUUID(), budgetId, randomUUID(), digest],
    ["23514"],
  );
  await client.query(
    `INSERT INTO unfurl.ai_provider_operations
      (id,budget_id,logical_operation_id,attempt,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card)
      VALUES ($1,$2,$3,1,$4,'curriculum','reserved',1000,'moonshotai/kimi-k2.6','digitalocean',$4,'{}')`,
    [operationId, budgetId, logicalOperationId, digest],
  );
  await rejected(
    "logical_attempt_unique",
    `INSERT INTO unfurl.ai_provider_operations
      (id,budget_id,logical_operation_id,attempt,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card)
      VALUES ($1,$2,$3,1,$4,'curriculum','reserved',1000,'moonshotai/kimi-k2.6','digitalocean',$4,'{}')`,
    [randomUUID(), budgetId, logicalOperationId, digest],
    ["23505"],
  );
  await client.query(
    "UPDATE unfurl.ai_provider_operations SET state='dispatched', dispatched_at=now(), provider_request_id=$2 WHERE id=$1",
    [operationId, `rollback-request-${randomUUID()}`],
  );
  await client.query("UPDATE unfurl.ai_provider_operations SET state='unknown', safe_failure_code='timeout' WHERE id=$1", [operationId]);
  check("unknown_charge_retains_reservation", (await client.query(
    "SELECT state,reserved_micro_usd::text,actual_micro_usd FROM unfurl.ai_provider_operations WHERE id=$1",
    [operationId],
  )).rows[0]?.state === "unknown");
  await rejected(
    "unknown_charge_cannot_release",
    "UPDATE unfurl.ai_provider_operations SET state='released' WHERE id=$1",
    [operationId],
    ["23514"],
  );
  await client.query(
    `INSERT INTO unfurl.ai_provider_responses
      (operation_id,provider_request_id,response_digest,reported_cost_usd,usage,result)
      VALUES ($1,(SELECT provider_request_id FROM unfurl.ai_provider_operations WHERE id=$1),$2,'0.001','{}','{}')`,
    [operationId, digest],
  );
  await client.query(
    `INSERT INTO unfurl.ai_budget_entries
      (id,budget_id,operation_id,effect_key,kind,reserved_delta_micro_usd,settled_delta_micro_usd)
      VALUES ($1,$2,$3,$4,'reserve',1000,0)`,
    [randomUUID(), budgetId, operationId, `${operationId}:reserve`],
  );
  await rejected(
    "provider_response_immutable",
    "UPDATE unfurl.ai_provider_responses SET usage='{\"changed\":true}' WHERE operation_id=$1",
    [operationId],
    ["23514"],
  );
  await rejected(
    "budget_ledger_immutable",
    "DELETE FROM unfurl.ai_budget_entries WHERE operation_id=$1",
    [operationId],
    ["23514"],
  );
  await rejected(
    "provider_identity_immutable",
    "UPDATE unfurl.ai_provider_operations SET reserved_micro_usd=1001 WHERE id=$1",
    [operationId],
    ["23514"],
  );

  const protection = await client.query(
    `SELECT bool_and(c.relrowsecurity) AS rls, bool_and(c.relforcerowsecurity) AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='unfurl' AND c.relname = ANY($1::text[])`,
    [["ai_budgets", "ai_provider_operations", "ai_provider_responses", "ai_budget_entries", "execution_capability_receipts"]],
  );
  check("execution_tables_force_rls", protection.rows[0]?.rls === true && protection.rows[0]?.forced === true);
  await client.query("SET LOCAL ROLE authenticated");
  await rejected("authenticated_budget_read_denied", "SELECT * FROM unfurl.ai_budgets", [], ["42501"]);
  await client.query("RESET ROLE");
  await client.query("ROLLBACK");

  phase = "rollback_confirmed";
  const leaked = await client.query("SELECT count(*)::int AS count FROM unfurl.ai_budgets WHERE campaign_key LIKE 'rollback-proof-%'");
  check("fixtures_rolled_back", leaked.rows[0]?.count === 0);

  if (campaigns.rowCount === 1) {
    phase = "campaign_locking";
    const contender = new pg.Client({
      connectionString: database.toString(),
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n") },
      application_name: "unfurl-execution-lock-contender",
    });
    await contender.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM unfurl.ai_budgets WHERE id=$1 FOR UPDATE", [budgetId]);
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout = '250ms'");
      let lockCode;
      try {
        await contender.query("SELECT id FROM unfurl.ai_budgets WHERE id=$1 FOR UPDATE", [budgetId]);
      } catch (error) {
        lockCode = error.code;
      }
      check("campaign_lock_serializes_reservations", lockCode === "55P03");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      await contender.end();
    }
  }
  console.log(JSON.stringify({ ok: true, checks: checks.length, paidCalls: 0, fixturesCommitted: 0 }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const code = error instanceof assert.AssertionError ? error.message : (error.code ?? error.message ?? "live_check_failed");
  console.error(JSON.stringify({ ok: false, phase, code }));
  process.exitCode = 1;
} finally {
  await client?.end();
}
