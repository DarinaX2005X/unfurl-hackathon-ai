import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

// One-time development provisioning. Refuses an existing campaign or populated env value.
// node --env-file=.env.local supabase/provision-ai-budget.mjs --project-ref <ref>
const args = process.argv.slice(2);
const expectedRef = args[args.indexOf("--project-ref") + 1];
const envPath = new URL("../.env.local", import.meta.url);
let client;
let phase = "configuration";

try {
  if (!args.includes("--project-ref") || !/^[a-z]{20}$/.test(expectedRef ?? "")) throw new Error("explicit_project_ref_required");
  const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const database = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  if (process.env.SUPABASE_PROJECT_REF !== expectedRef
    || api.hostname !== `${expectedRef}.supabase.co`
    || !(decodeURIComponent(database.username).endsWith(`.${expectedRef}`) || database.hostname === `db.${expectedRef}.supabase.co`)
    || database.port === "6543") throw new Error("target_project_mismatch_or_transaction_pooler");
  const env = await readFile(envPath, "utf8");
  const match = env.match(/^AI_BUDGET_ID=(.*)$/m);
  if (match?.[1].trim()) throw new Error("ai_budget_env_already_set");
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) database.searchParams.delete(name);
  client = new pg.Client({
    connectionString: database.toString(), connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n") },
    application_name: "unfurl-budget-provisioning",
  });
  await client.connect();
  phase = "database";
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('unfurl-ai-budget-provisioning'))");
  const existing = await client.query("SELECT count(*)::int AS count FROM unfurl.ai_budgets");
  if (existing.rows[0]?.count !== 0) throw new Error("existing_budget_refused");
  const budgetId = randomUUID();
  await client.query(
    "INSERT INTO unfurl.ai_budgets (id,campaign_key) VALUES ($1,'unfurl-global-campaign')",
    [budgetId],
  );
  await client.query("COMMIT");
  phase = "local_configuration";
  const updated = match
    ? env.replace(/^AI_BUDGET_ID=.*$/m, `AI_BUDGET_ID=${budgetId}`)
    : `${env.replace(/\s*$/, "")}\nAI_BUDGET_ID=${budgetId}\n`;
  await writeFile(envPath, updated, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, created: true, hardLimitMicroUsd: "20000000", spendableLimitMicroUsd: "19500000", paidCalls: 0, envConfigured: true }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  console.error(JSON.stringify({ ok: false, phase, code: error.code ?? error.message ?? "provision_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end();
}
