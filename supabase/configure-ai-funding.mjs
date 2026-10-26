import { pathToFileURL } from "node:url";
import pg from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function fundingOperatorInput(args, env) {
  const allowed = new Set(["--project-ref","--verification-budget-id","--site-budget-id","--verification-actor-id","--apply"]);
  const options = {};
  for (let index=0;index<args.length;index++) {
    const name=args[index];
    if (!allowed.has(name) || name in options) throw new Error("invalid_or_duplicate_argument");
    options[name]=name==="--apply"?true:args[++index];
  }
  const projectRef=options["--project-ref"], verificationBudgetId=options["--verification-budget-id"], siteBudgetId=options["--site-budget-id"], actorId=options["--verification-actor-id"];
  if (!/^[a-z]{20}$/.test(projectRef??"") || !uuid.test(verificationBudgetId??"") || !uuid.test(siteBudgetId??"") || verificationBudgetId===siteBudgetId ||
    verificationBudgetId!==env.AI_BUDGET_ID || !uuid.test(actorId??"")) throw new Error("explicit_funding_identity_required");
  const database=new URL(env.DIRECT_DATABASE_URL??""), api=new URL(env.NEXT_PUBLIC_SUPABASE_URL??"");
  if (env.SUPABASE_PROJECT_REF!==projectRef || api.hostname!==`${projectRef}.supabase.co` || !["postgres:","postgresql:"].includes(database.protocol) ||
    !(decodeURIComponent(database.username).endsWith(`.${projectRef}`)||database.hostname===`db.${projectRef}.supabase.co`) || database.port==="6543") throw new Error("target_project_mismatch_or_transaction_pooler");
  for (const key of ["sslmode","sslrootcert","sslcert","sslkey"]) database.searchParams.delete(key);
  return {projectRef,verificationBudgetId,siteBudgetId,actorId,apply:options["--apply"]===true,database};
}

/** Caller owns the transaction. This never changes existing budgets, operations or receipts. */
export async function configureFunding(client,input) {
  const actor=(await client.query("SELECT id FROM auth.users WHERE id=$1",[input.actorId])).rows[0];
  if(!actor)throw new Error("verification_actor_not_found");
  if(input.apply) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('unfurl-ai-funding-activation'))");
    await client.query("LOCK TABLE unfurl.execution_jobs IN SHARE ROW EXCLUSIVE MODE");
  }
  const verification=(await client.query(`SELECT id,kind,hard_limit_micro_usd::text,spendable_limit_micro_usd::text,settled_micro_usd::text,reserved_micro_usd::text,halted
    FROM unfurl.ai_budgets WHERE id=$1${input.apply?" FOR UPDATE":""}`,[input.verificationBudgetId])).rows[0];
  if(!verification || verification.kind!=="verification" || verification.hard_limit_micro_usd!=="20000000" || verification.spendable_limit_micro_usd!=="19500000") throw new Error("verification_budget_mismatch");
  const config=(await client.query("SELECT version,verification_budget_id,site_budget_id,verification_actor_id FROM unfurl.ai_funding_configuration WHERE singleton=true")).rows[0];
  if(config && (config.version!=="actor-funding-v1" || config.verification_budget_id!==input.verificationBudgetId || config.site_budget_id!==input.siteBudgetId || config.verification_actor_id!==input.actorId)) throw new Error("immutable_configuration_conflict");
  const site=(await client.query("SELECT id,kind,hard_limit_micro_usd,spendable_limit_micro_usd FROM unfurl.ai_budgets WHERE kind='site' OR id=$1",[input.siteBudgetId])).rows;
  if(site.length && (site.length!==1 || site[0].id!==input.siteBudgetId || site[0].kind!=="site" || site[0].hard_limit_micro_usd!==null || site[0].spendable_limit_micro_usd!==null)) throw new Error("site_budget_conflict");
  if(config && site.length!==1) throw new Error("missing_configured_site_budget");
  if(input.apply && !config) {
    if(!site.length) await client.query("INSERT INTO unfurl.ai_budgets(id,campaign_key,kind,hard_limit_micro_usd,spendable_limit_micro_usd) VALUES($1,'unfurl-site','site',NULL,NULL)",[input.siteBudgetId]);
    await client.query("INSERT INTO unfurl.ai_funding_configuration(singleton,version,verification_budget_id,site_budget_id,verification_actor_id) VALUES(true,'actor-funding-v1',$1,$2,$3)",[input.verificationBudgetId,input.siteBudgetId,input.actorId]);
  }
  return {mode:input.apply?"apply":"preview",alreadyConfigured:!!config,verification,siteBudgetId:input.siteBudgetId,verificationActorId:input.actorId,
    siteLimitMicroUsd:null,legacyJobs:"verification",newOrdinaryJobs:"site",paidCalls:0,historicalAccountingChanged:false};
}

async function main() {
  let client;
  try {
    const input=fundingOperatorInput(process.argv.slice(2),process.env);
    client=new pg.Client({connectionString:input.database.toString(),connectionTimeoutMillis:10000,
      ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA.replace(/\\n/g,"\n")}: {})},application_name:"unfurl-funding-activation"});
    await client.connect();
    await client.query(input.apply?"BEGIN":"BEGIN READ ONLY");
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='20s'");
    const result=await configureFunding(client,input);
    await client.query(input.apply?"COMMIT":"ROLLBACK");
    console.log(JSON.stringify({ok:true,target:input.projectRef,...result}));
  } catch(error) {
    await client?.query("ROLLBACK").catch(()=>undefined);
    const safe=error instanceof Error && /^[a-z_]+$/.test(error.message)?error.message:"funding_activation_failed";
    console.error(JSON.stringify({ok:false,code:safe}));process.exitCode=1;
  } finally {await client?.end();}
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) await main();
