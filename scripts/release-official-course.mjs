#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function releaseOptions(args, env) {
  const allowed = new Set(["--project-ref", "--run-id", "--owner-id", "--completed-step-id", "--apply", "--world"]);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key) || key in options || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("invalid_release_arguments");
    options[key] = args[++index];
  }
  const projectRef = options["--project-ref"], world = options["--world"] ?? "vercel";
  if (!/^[a-z]{20}$/.test(projectRef ?? "") || !["local", "vercel"].includes(world)
    || ["--run-id", "--owner-id", "--completed-step-id"].some((key) => !uuid.test(options[key] ?? ""))
    || options["--apply"] !== undefined && !/^[a-f0-9]{64}$/.test(options["--apply"])) throw new Error("explicit_release_identity_required");
  let database, api;
  try { database = new URL(env.DIRECT_DATABASE_URL); api = new URL(env.NEXT_PUBLIC_SUPABASE_URL); }
  catch { throw new Error("release_database_configuration_required"); }
  if (env.SUPABASE_PROJECT_REF !== projectRef || api.hostname !== `${projectRef}.supabase.co`
    || !["postgres:", "postgresql:"].includes(database.protocol)
    || !(decodeURIComponent(database.username).endsWith(`.${projectRef}`) || database.hostname === `db.${projectRef}.supabase.co`)
    || database.port === "6543") throw new Error("release_target_project_mismatch");
  return { projectRef, world, runId: options["--run-id"], ownerId: options["--owner-id"],
    completedStepId: options["--completed-step-id"], applyDigest: options["--apply"] };
}

export function releaseEnvironment(env, options) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (/^(RUN_|REPLAY_|WRITE_|BUDGET_LEDGER_|COVERAGE_|MODEL_POLICY_|PROVIDER_PORTABILITY_|OFFICIAL_COURSE_RELEASE_)/.test(key) || key.endsWith("_OPERATOR")) delete clean[key];
  if (options.world === "vercel") clean.VERCEL = "1"; else delete clean.VERCEL;
  if (!clean.VERCEL_PROJECT_ID) {
    try { const project = JSON.parse(readFileSync(resolve(root, ".vercel/project.json"), "utf8"));
      if (/^prj_[A-Za-z0-9]+$/.test(project.projectId)) clean.VERCEL_PROJECT_ID = project.projectId;
    } catch { /* Absence leaves the real sandbox capability unavailable. */ }
  }
  return { ...clean, DATABASE_URL: env.DIRECT_DATABASE_URL, OFFICIAL_COURSE_RELEASE_OPERATOR: "1",
    OFFICIAL_COURSE_RELEASE_INPUT: JSON.stringify({ runId: options.runId, ownerId: options.ownerId,
      completedStepId: options.completedStepId, ...(options.applyDigest ? { applyDigest: options.applyDigest } : {}) }) };
}

export function runOfficialRelease(args, env = process.env, spawn = spawnSync) {
  const options = releaseOptions(args, env);
  const result = spawn(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "tests/partial-release/release.operator.test.ts", "--disableConsoleIntercept"], {
    cwd: root, env: releaseEnvironment(env, options), stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true,
    timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
  });
  const reports = String(result.stdout ?? "").split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const report = reports.find((value) => value.kind === "official-course-release");
  if (result.error || result.status !== 0 || !report || report.runId !== options.runId || report.inferenceCalls !== 0
    || report.applied !== Boolean(options.applyDigest)) {
    const failure = reports.find((value) => value.kind === "official-course-release-error");
    throw new Error(`release_rejected${failure && /^[a-z_]+$/.test(failure.stage) ? `_at_${failure.stage}` : ""}`);
  }
  return { ok: true, projectRef: options.projectRef, world: options.world, ...report };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(runOfficialRelease(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "release_rejected" })); process.exitCode = 1; }
}
