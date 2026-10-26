#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function editorialOptions(args, env) {
  const options = {}, allowed = new Set(["--project-ref", "--run-id", "--owner-id", "--content", "--apply"]);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key) || key in options || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("invalid_editorial_arguments");
    options[key] = args[++index];
  }
  const projectRef = options["--project-ref"];
  if (!/^[a-z]{20}$/.test(projectRef ?? "") || !uuid.test(options["--run-id"] ?? "") || !uuid.test(options["--owner-id"] ?? "")
    || !options["--content"] || options["--apply"] !== undefined && !/^[a-f0-9]{64}$/.test(options["--apply"])) throw new Error("explicit_editorial_identity_required");
  let database, api;
  try { database = new URL(env.DIRECT_DATABASE_URL); api = new URL(env.NEXT_PUBLIC_SUPABASE_URL); } catch { throw new Error("editorial_database_configuration_required"); }
  if (env.SUPABASE_PROJECT_REF !== projectRef || api.hostname !== `${projectRef}.supabase.co` || !["postgres:", "postgresql:"].includes(database.protocol)
    || !(decodeURIComponent(database.username).endsWith(`.${projectRef}`) || database.hostname === `db.${projectRef}.supabase.co`) || database.port === "6543") throw new Error("editorial_target_project_mismatch");
  const contentPath = resolve(root, options["--content"]);
  if (readFileSync(contentPath).byteLength > 2 * 1024 * 1024) throw new Error("editorial_content_too_large");
  return { projectRef, contentPath, runId: options["--run-id"], ownerId: options["--owner-id"], applyDigest: options["--apply"] };
}
export function runEditorialRelease(args, env = process.env, spawn = spawnSync) {
  const options = editorialOptions(args, env), clean = { ...env };
  for (const key of Object.keys(clean)) if (/^(RUN_|REPLAY_|WRITE_|BUDGET_LEDGER_|COVERAGE_|MODEL_POLICY_|PROVIDER_PORTABILITY_|OFFICIAL_COURSE_RELEASE_|EDITORIAL_COURSE_RELEASE_)/.test(key) || key.endsWith("_OPERATOR")) delete clean[key];
  const result = spawn(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "tests/partial-release/editorial.operator.test.ts", "--disableConsoleIntercept"], {
    cwd: root, env: { ...clean, DATABASE_URL: env.DIRECT_DATABASE_URL, EDITORIAL_COURSE_RELEASE_OPERATOR: "1",
      EDITORIAL_COURSE_RELEASE_INPUT: JSON.stringify({ runId: options.runId, ownerId: options.ownerId, ...(options.applyDigest ? { applyDigest: options.applyDigest } : {}) }),
      EDITORIAL_COURSE_RELEASE_CONTENT: options.contentPath }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
  });
  const reports = String(result.stdout ?? "").split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const report = reports.find(({ kind }) => kind === "official-editorial-course-release");
  if (result.error || result.status !== 0 || !report || report.runId !== options.runId || report.inferenceCalls !== 0 || report.applied !== Boolean(options.applyDigest)) {
    const failure = reports.find(({ kind }) => kind === "editorial-course-release-error");
    if (failure) console.error(JSON.stringify(failure));
    throw new Error("editorial_release_rejected");
  }
  return { ok: true, projectRef: options.projectRef, ...report };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(runEditorialRelease(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "editorial_release_rejected" })); process.exitCode = 1; }
}
