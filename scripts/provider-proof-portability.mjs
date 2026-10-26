#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configurationPresence, operatorEnvironment, operatorMain, operatorTarget, parseOperatorOptions,
  repositoryRoot, requireOperator, uuidPattern, withOperatorReport,
} from "./runtime-capabilities.mjs";

const modes = { "--list": false, "--verify": true, "--apply-approved": true };
const capabilities = ["model_structured", "model_text", "research_search", "rubric"];
const identifier = value => typeof value === "string" && /^[a-z0-9-]{1,128}$/.test(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));

function validateDatabaseTarget(environment) {
  const ref = environment.SUPABASE_PROJECT_REF;
  requireOperator(typeof ref === "string" && /^[a-z0-9]{20}$/.test(ref), "Configure the intended SUPABASE_PROJECT_REF.");
  let database, api;
  try { database = new URL(environment.DATABASE_URL); api = new URL(environment.NEXT_PUBLIC_SUPABASE_URL); }
  catch { requireOperator(false, "Configure matching Supabase API and runtime database URLs."); }
  requireOperator(["postgres:", "postgresql:"].includes(database.protocol) &&
    (database.hostname === `db.${ref}.supabase.co` || database.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(database.username).endsWith(`.${ref}`)) &&
    api.origin === `https://${ref}.supabase.co` && api.pathname === "/" && !api.username && !api.password && !api.search && !api.hash,
  "Database and Supabase project identities do not match; no connection was attempted.");
  requireOperator(uuidPattern.test(environment.AI_BUDGET_ID ?? ""), "Configure a valid existing AI_BUDGET_ID.");
}

/** Never forward paid or unrelated operator switches from the invoking shell. */
export function portabilityEnvironment(environment, options) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (/^(RUN_|REPLAY_|WRITE_|BUDGET_LEDGER_|COVERAGE_|MODEL_POLICY_|PROVIDER_PORTABILITY_)/.test(key) || key.endsWith("_OPERATOR")) delete clean[key];
  }
  return { ...clean, PROVIDER_PORTABILITY_OPERATOR: { "--list": "list", "--verify": "verify", "--apply-approved": "apply" }[options.mode],
    PROVIDER_PORTABILITY_SOURCE_ID: options.identifier ?? "" };
}

/** The existing operator intentionally emits safe JSON; expose only validated fields. */
export function portabilityResult(stdout, options) {
  const lines = String(stdout).split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line.trim())]; } catch { return []; }
  });
  if (options.mode === "--list") {
    const reports = lines.filter(value => value?.inferenceCalls === 0 && Array.isArray(value.sources));
    requireOperator(reports.length === 1, "The existing verifier did not return one valid source inventory.");
    const sources = reports[0].sources.map(row => {
      requireOperator(uuidPattern.test(row.id ?? "") && capabilities.includes(row.capability) && identifier(row.model_policy) &&
        typeof row.passed === "boolean" && ["reserved", "dispatched", "unknown", "settled", "released"].includes(row.operation_state) && timestamp(row.observed_at),
      "The source inventory contains an invalid receipt.");
      return { receiptId: row.id, capability: row.capability, modelPolicy: row.model_policy,
        passed: row.passed, operationState: row.operation_state, observedAt: row.observed_at };
    });
    return { sources, inferenceCalls: 0 };
  }
  const reports = lines.filter(value => value?.inferenceCalls === 0 && typeof value.applied === "boolean");
  requireOperator(reports.length === 1, "The existing verifier did not return one valid portability result.");
  const value = reports[0];
  requireOperator(value.applied === (options.mode === "--apply-approved") && (!value.applied || uuidPattern.test(value.receiptId ?? "")) &&
    uuidPattern.test(value.sourceReceiptId ?? "") && capabilities.includes(value.capability) && identifier(value.modelPolicy) &&
    value.sourceWorld === "local" && value.targetWorld === "vercel" && timestamp(value.sourceObservedAt) && timestamp(value.checkedAt),
  "The returned proof does not match the requested portability operation.");
  return { applied: value.applied, receiptId: value.applied ? value.receiptId : null, requestedReceiptId: options.identifier,
    sourceReceiptId: value.sourceReceiptId, capability: value.capability, modelPolicy: value.modelPolicy,
    sourceWorld: value.sourceWorld, targetWorld: value.targetWorld, sourceObservedAt: value.sourceObservedAt, checkedAt: value.checkedAt,
    inferenceCalls: 0 };
}

export async function runPortabilityOperator(argv, dependencies = {}) {
  const options = parseOperatorOptions(argv, modes, "vercel");
  requireOperator(options.world === "vercel", "Existing portability supports local proofs targeting vercel only.");
  const environment = await operatorEnvironment(options, dependencies.environment ?? process.env);
  const planning = options.mode === "--plan" || options.mode === "--status";
  // A local proof's configuration can legitimately have a loopback APP_ORIGIN.
  // Portability itself never calls an app origin; validate only an explicit one.
  const origin = options.origin ? operatorTarget(options, environment) : null;
  if (!planning) {
    requireOperator(options.explicitWorld, "Live portability modes require explicit --world vercel.");
    validateDatabaseTarget(environment);
    if (options.mode !== "--list") {
      requireOperator(uuidPattern.test(options.identifier ?? ""), "Provide an existing source receipt UUID.");
      requireOperator(typeof environment.OPENROUTER_API_KEY === "string" && environment.OPENROUTER_API_KEY.length > 0,
        "The source proof's OPENROUTER_API_KEY is required for authenticated revalidation.");
    }
  }
  return withOperatorReport(options.report, async () => {
    if (planning) return {
      ok: true, mode: options.mode.slice(2), inspection: "configuration-only", world: "vercel", origin,
      networkCalls: 0, databaseConnected: false, inferenceCalls: 0, completeFreshBootstrap: false,
      configured: configurationPresence(environment, ["SUPABASE_PROJECT_REF", "NEXT_PUBLIC_SUPABASE_URL", "DATABASE_URL", "AI_BUDGET_ID", "OPENROUTER_API_KEY"]),
      actions: {
        "--list": "Reads existing local proof receipts from the selected database.",
        "--verify <sourceReceiptId>": "Revalidates an existing settled proof using database reads and allowlisted provider metadata GETs.",
        "--apply-approved <sourceReceiptId>": "Repeats verification and appends a derived vercel receipt; makes no inference request.",
      },
      readiness: "Not inspected. This operator cannot initialize missing provider proofs or verify a deployed site's configuration.",
    };
    const child = (dependencies.spawn ?? spawnSync)(process.execPath, [resolve(repositoryRoot, "node_modules/vitest/vitest.mjs"),
      "run", "tests/provider-integration/provider-portability.operator.test.ts", "--disableConsoleIntercept"], {
      cwd: repositoryRoot, env: portabilityEnvironment(environment, options), stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8", windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    });
    // Raw runner output can include database errors. Never print it, even on failure.
    requireOperator(!child.error && child.status === 0,
      "Provider portability was rejected or interrupted; raw output suppressed. Inspect existing receipts before retrying an apply.");
    return { ok: true, mode: options.mode.slice(2), world: "vercel", origin,
      ...portabilityResult(child.stdout, options) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await operatorMain(runPortabilityOperator);
