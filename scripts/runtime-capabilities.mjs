#!/usr/bin/env node
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const workflowIdPattern = /^[A-Za-z0-9_.:-]{1,256}$/;
const projectPattern = /^prj_[A-Za-z0-9]{1,124}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export class OperatorInputError extends Error {}
export function requireOperator(condition, message) {
  if (!condition) throw new OperatorInputError(message);
}
export function safeOperatorError(error) {
  return error instanceof OperatorInputError ? error.message : "Operator failed; details suppressed to protect credentials. No automatic retry was attempted.";
}

/** Parsing never imports application code, connects to a database, or sends a request. */
export function parseOperatorOptions(argv, modes, defaultWorld = "local") {
  const options = { mode: "--plan", world: defaultWorld, explicitWorld: false };
  const seen = new Set();
  const fields = { "--env-file": "envFile", "--world": "world", "--origin": "origin", "--report": "report" };
  let selectedMode = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--plan" || flag === "--status" || Object.hasOwn(modes, flag)) {
      requireOperator(!selectedMode, "Select exactly one operator mode.");
      selectedMode = true;
      options.mode = flag;
      if (modes[flag]) {
        const value = argv[++index];
        requireOperator(Boolean(value) && !value.startsWith("--"), "This mode requires an explicit identifier.");
        options.identifier = value;
      }
    } else {
      requireOperator(Object.hasOwn(fields, flag) && !seen.has(flag), "Unknown or duplicate option.");
      seen.add(flag);
      const value = argv[++index];
      requireOperator(Boolean(value) && !value.startsWith("--"), "An option value is missing.");
      options[fields[flag]] = value;
      if (flag === "--world") options.explicitWorld = true;
    }
  }
  requireOperator(["local", "vercel"].includes(options.world), "World must be local or vercel.");
  if (options.report) requireOperator(options.report.endsWith(".json"), "A report must use a new .json file.");
  return options;
}

export async function operatorEnvironment(options, inherited = process.env) {
  // As with Node's --env-file, already-set process variables take precedence.
  const fileValues = options.envFile ? parseEnv(await readFile(resolve(options.envFile), "utf8")) : {};
  return { ...fileValues, ...inherited };
}

export function validatedOrigin(value, world) {
  let url;
  try { url = new URL(value); } catch { throw new OperatorInputError("Provide an exact origin without credentials, path, query, or fragment."); }
  requireOperator(!url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
    "Provide an exact origin without credentials, path, query, or fragment.");
  requireOperator(world === "vercel" ? url.protocol === "https:" :
    ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Use HTTPS for vercel, or a loopback origin for local.");
  return url.origin;
}

export function operatorTarget(options, environment, required = false) {
  const configured = environment.APP_ORIGIN ? validatedOrigin(environment.APP_ORIGIN, options.world) : null;
  const requested = options.origin ? validatedOrigin(options.origin, options.world) : configured;
  if (required) requireOperator(options.explicitWorld && Boolean(configured) && Boolean(requested),
    "Live modes require explicit --world and configured APP_ORIGIN.");
  if (configured && requested) requireOperator(configured === requested, "Requested origin does not match APP_ORIGIN; no credentials were sent.");
  return requested;
}

/** Reserve a new report before effects. An existing report never causes a repeated start. */
export async function withOperatorReport(report, work) {
  let handle;
  if (report) {
    const path = resolve(report);
    await mkdir(dirname(path), { recursive: true });
    try { handle = await open(path, "wx", 0o600); }
    catch { throw new OperatorInputError("Report could not be created exclusively; choose a new report path. No operation was attempted."); }
    await handle.writeFile(JSON.stringify({ status: "pending", message: "Inspect runtime state before retrying an interrupted operation." }) + "\n");
    await handle.sync();
  }
  async function save(result) {
    if (!handle) return;
    await handle.truncate(0);
    await handle.write(JSON.stringify(result, null, 2) + "\n", 0, "utf8");
    await handle.sync();
  }
  try {
    const result = await work();
    await save(result);
    return result;
  } catch (error) {
    await save({ ok: false, error: safeOperatorError(error) });
    throw error;
  } finally { await handle?.close(); }
}

export function configurationPresence(environment, names) {
  return Object.fromEntries(names.map(name => [name, typeof environment[name] === "string" && environment[name].length > 0]));
}

const runtimeModes = { "--recovery-start": false, "--recovery-inspect": true, "--python-inspect": false };

export async function runRuntimeOperator(argv, dependencies = {}) {
  const options = parseOperatorOptions(argv, runtimeModes);
  const environment = await operatorEnvironment(options, dependencies.environment ?? process.env);
  const planning = options.mode === "--plan" || options.mode === "--status";
  const origin = operatorTarget(options, environment, !planning);
  if (!planning) {
    requireOperator(typeof environment.INTERNAL_DISPATCH_SECRET === "string" && environment.INTERNAL_DISPATCH_SECRET.length >= 32,
      "A configured INTERNAL_DISPATCH_SECRET of at least 32 characters is required.");
    if (options.mode === "--recovery-inspect") requireOperator(workflowIdPattern.test(options.identifier), "Invalid Workflow run identifier.");
    if (options.world === "vercel" || options.mode === "--python-inspect") requireOperator(projectPattern.test(environment.VERCEL_PROJECT_ID ?? ""),
      "Configure the intended VERCEL_PROJECT_ID before this operation.");
  }
  return withOperatorReport(options.report, async () => {
    if (planning) return {
      ok: true, mode: options.mode.slice(2), inspection: "configuration-only", world: options.world, origin,
      networkCalls: 0, databaseConnected: false, inferenceCalls: 0, sandboxCreated: false,
      completeFreshBootstrap: false, providerInitialization: "not-packaged",
      configured: configurationPresence(environment, ["APP_ORIGIN", "INTERNAL_DISPATCH_SECRET", "VERCEL_PROJECT_ID", "AI_BUDGET_ID"]),
      actions: {
        "--recovery-start": "Starts one real Workflow recovery probe and saves its marker; no AI request.",
        "--recovery-inspect <workflowRunId>": "Checks that exact workflow and records recovery evidence only after a verified replay.",
        "--python-inspect": "Inspects signed runtime OIDC capability; creates no sandbox and proves no Python execution.",
      },
      readiness: "Not inspected. Existing provider proofs and a separately verified ledger are still required.",
    };
    const action = options.mode === "--recovery-start" ? "start_recovery_proof" : options.mode === "--recovery-inspect" ? "inspect_recovery_proof" : "inspect_python_capability";
    const response = await (dependencies.fetcher ?? fetch)(`${origin}/api/internal/dispatch`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(55_000),
      headers: { Authorization: `Bearer ${environment.INTERNAL_DISPATCH_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(options.identifier ? { workflowRunId: options.identifier } : {}) }),
    });
    requireOperator(response.ok, "The runtime action was rejected or unavailable; no automatic retry was attempted.");
    const data = await response.json();
    const result = { ok: true, mode: options.mode.slice(2), world: options.world, origin, httpStatus: response.status, inferenceCalls: 0, sandboxCreated: false };
    if (options.mode === "--recovery-start") {
      requireOperator(uuidPattern.test(data?.probeId ?? "") && workflowIdPattern.test(data?.workflowRunId ?? ""), "Runtime returned an invalid recovery identity.");
      return { ...result, status: "started", probeId: data.probeId, workflowRunId: data.workflowRunId };
    }
    if (options.mode === "--recovery-inspect") {
      requireOperator(["pending", "running", "completed", "failed", "cancelled"].includes(data?.status), "Runtime returned an unknown workflow state.");
      if (data.status !== "completed") return { ...result, ok: !["failed", "cancelled"].includes(data.status), status: data.status, workflowRunId: options.identifier, recoveryVerified: false };
      const proof = data.proof;
      requireOperator(proof?.workflowRunId === options.identifier && uuidPattern.test(proof?.probeId ?? "") && workflowIdPattern.test(proof?.stepId ?? "") &&
        Number.isSafeInteger(proof?.firstAttempt) && proof.firstAttempt >= 0 && Number.isSafeInteger(proof?.attempt) && proof.attempt > proof.firstAttempt && proof.replayed === true,
      "Runtime returned an invalid recovery proof.");
      return { ...result, status: "completed", recoveryVerified: true, proof: {
        probeId: proof.probeId, workflowRunId: proof.workflowRunId, stepId: proof.stepId,
        firstAttempt: proof.firstAttempt, attempt: proof.attempt, replayed: true,
      } };
    }
    if (data?.status === "unavailable") {
      const reason = ["project", "plan", "auth"].includes(data.reason) ? data.reason : "unavailable";
      return { ...result, ok: false, status: "unavailable", reason };
    }
    const evidence = data?.evidence;
    requireOperator(data?.status === "available" && evidence?.source === "vercel_oidc_signed_claim_v1" &&
      evidence.projectId === environment.VERCEL_PROJECT_ID && evidence.plan === "hobby" &&
      ["production", "preview", "development"].includes(evidence.environment) &&
      (!environment.VERCEL_ENV || evidence.environment === environment.VERCEL_ENV) &&
      (options.world !== "vercel" || evidence.environment !== "development") &&
      typeof evidence.runtimeProfile === "string" && /^[\w.-]{1,128}$/.test(evidence.runtimeProfile) &&
      [evidence.imageDigest, evidence.runnerDigest, evidence.runtimeDigest].every(value => digestPattern.test(value ?? "")) &&
      Number.isFinite(Date.parse(evidence.issuedAt)) && Date.parse(evidence.issuedAt) <= Date.now() && Date.parse(evidence.expiresAt) > Date.now(),
    "Python capability does not match the configured project, runtime, or current validity window.");
    return { ...result, status: "available", executionVerified: false, evidence: {
      source: evidence.source, projectId: evidence.projectId, environment: evidence.environment,
      runtimeProfile: evidence.runtimeProfile, imageDigest: evidence.imageDigest, runnerDigest: evidence.runnerDigest,
      runtimeDigest: evidence.runtimeDigest, issuedAt: evidence.issuedAt, expiresAt: evidence.expiresAt,
    } };
  });
}

export async function operatorMain(run, argv = process.argv.slice(2)) {
  try {
    const result = await run(argv);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: safeOperatorError(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await operatorMain(runRuntimeOperator);
