import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(`${directory}/${name}`, "utf8"));
const sql = migrations.join("\n");

describe("migration static guardrails (live PostgreSQL proof still required)", () => {
  it("keeps the application schema outside anonymous grants and protects all tables with RLS", () => {
    const tables = [...sql.matchAll(/create table unfurl\.([a-z_][a-z0-9_]*)\b/g)].map((match) => match[1]!);
    const directRls = [...sql.matchAll(/alter table unfurl\.([a-z_][a-z0-9_]*) enable row level security/g)].map((match) => match[1]!);
    const loopRls = [...sql.matchAll(/foreach table_name in array array\[([\s\S]*?)\] loop/g)]
      .flatMap((match) => [...match[1]!.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((item) => item[1]!));
    expect(tables.length).toBeGreaterThan(25);
    expect(new Set([...directRls, ...loopRls])).toEqual(new Set(tables));
    expect(sql).not.toMatch(/grant[^;]+to anon/i);
    const config = readFileSync(fileURLToPath(new URL("../../supabase/config.toml", import.meta.url)), "utf8");
    expect(config).toContain('schemas = ["public", "graphql_public"]');
  });

  it("withholds hidden assessments and execution state from authenticated table grants", () => {
    const grants = [...sql.matchAll(/grant[^;]+to authenticated;/gi)].map((match) => match[0]);
    for (const grant of grants) {
      expect(grant).not.toMatch(/tasks_private|task_validation_receipts|version_validation_receipts|activity_sessions|activity_turns|outbox|run_steps|execution_jobs|share_grants/);
    }
  });

  it("keeps chat turns and course jobs distinct and imposes durable uniqueness", () => {
    const turns = sql.match(/create table unfurl\.agent_turn_runs \(([\s\S]*?)\n\);/)?.[1];
    expect(turns).toBeDefined();
    expect(turns).not.toMatch(/course_id|output_version_id|approval_id/);
    expect(sql).toContain("unique (learner_id, qualifying_evidence_id)");
    expect(sql).toContain("unique (learner_id, course_version_id)");
    expect(sql).toContain("primary key (actor_id, operation, key)");
    expect(sql).toContain("unique (run_id, seq)");
    expect(sql).toContain("Ready course versions are immutable");
    expect(sql).toContain("Completed generation requires its saved ready version");
  });

  it("keeps one fixed campaign and immutable provider/accounting receipts", () => {
    expect(sql).toContain("one_ai_budget_campaign on unfurl.ai_budgets ((true))");
    expect(sql).toContain("check (hard_limit_micro_usd = 10000000)");
    expect(sql).toContain("check (spendable_limit_micro_usd = 9500000)");
    expect(sql).toContain("model_id = 'moonshotai/kimi-k2.6'");
    expect(sql).toContain("provider_tag = 'digitalocean'");
    expect(sql).toContain("unique (logical_operation_id, attempt)");
    expect(sql).toContain("ai_response_immutable before update or delete");
    expect(sql).toContain("ai_budget_entry_immutable before update or delete");
    expect(sql).toContain("ai_budget_no_delete before delete");
    expect(sql).toContain("old.state = 'unknown' and new.state = 'settled'");
    expect(sql).not.toContain("old.state = 'unknown' and new.state = 'released'");
  });

  it("raises the same campaign to USD 20 without resetting accounting", () => {
    const increase = readFileSync(`${directory}/202610250026_total_campaign_budget.sql`, "utf8");
    expect(increase).toContain("alter column hard_limit_micro_usd set default 20000000");
    expect(increase).toContain("alter column spendable_limit_micro_usd set default 19500000");
    expect(increase).toContain("check (hard_limit_micro_usd = 20000000)");
    expect(increase).toContain("check (spendable_limit_micro_usd = 19500000)");
    const updates = [...increase.matchAll(/update unfurl\.ai_budgets\s+set\s+([\s\S]*?);/gi)];
    expect(updates).toHaveLength(1);
    const columns = updates[0]![1]!.split(",").map(assignment => assignment.trim().split(/\s*=\s*/)[0]);
    expect(columns).toEqual(["hard_limit_micro_usd", "spendable_limit_micro_usd", "revision", "updated_at"]);
    expect(increase).not.toMatch(/drop (table|trigger|index)|delete from|truncate|insert into|ai_provider_operations|ai_provider_responses|ai_budget_entries/i);
  });

  it("removes artificial provider and step result sizes without rewriting historical evidence", () => {
    const output = readFileSync(`${directory}/202610250027_provider_max_output.sql`, "utf8");
    expect(output).toContain("alter table unfurl.ai_provider_responses drop constraint ai_provider_responses_result_check");
    expect(output).toContain("alter table unfurl.run_steps drop constraint run_step_result_bound");
    expect(output).not.toMatch(/\b(update|delete|truncate|insert)\b|drop (table|trigger)|add constraint/i);
  });

  it("pins publication and learning authority to immutable versions and saved identities", () => {
    expect(sql).toContain("add column published_version_id uuid");
    expect(sql).toContain("rename column key_version to token_key_version");
    expect(sql).toContain("share_grant_token_key_version");
    expect(sql).toContain("course_publication_pointer_iff_public");
    expect(sql).toContain("activity_session_task_unique unique (enrollment_id, task_id, task_version)");
    expect(sql).toContain("primary key (activity_session_id, input_revision)");
    expect(sql).toContain("unique (activity_session_id, client_action_id)");
    expect(sql).toContain("completed_session_revision integer");
    expect(sql).toContain("activity_snapshot jsonb not null");
    expect(sql).toContain("create table unfurl.evaluation_revisions");
    expect(sql).toContain("unique (attempt_id, evaluation_revision, outcome_id)");
    expect(sql).toContain("xp_award_stable_task unique (learner_id, course_id, task_id)");
    expect(sql).toContain("feedback_acknowledgements");
    expect(sql).toContain("one_live_support");
    expect(sql).toContain("num_nonnulls(agent_turn_run_id, generation_run_id, evaluation_id, activity_action_id) = 1");
  });

  it("keeps research retrievals, passages and curriculum evidence immutable and private", () => {
    expect(sql).toContain("create table unfurl.research_source_documents");
    expect(sql).toContain("create table unfurl.research_passages");
    expect(sql).toContain("create table unfurl.research_searches");
    expect(sql).toContain("create table unfurl.source_claims");
    expect(sql).toContain("create table unfurl.curriculum_revision_evidence");
    expect(sql).toContain("create table unfurl.course_language_revision_intents");
    expect(sql).toContain("one_initial_generation_per_approval");
    expect(sql).toContain("one_staging_version_per_approval");
    expect(sql).not.toContain("unique (content_digest)");
  });

  it("makes Python execution independently admitted, fenced, cleanup proven and retry explicit", () => {
    expect(sql).toContain("create table unfurl.code_execution_runs");
    expect(sql).toContain("job_fencing_token bigint not null");
    expect(sql).toContain("Live execution job claim does not authorize Python mutation");
    const admission = readFileSync(`${directory}/202610250025_python_independent_admission.sql`, "utf8");
    expect(admission).toContain("drop index unfurl.code_execution_one_global_active");
    expect(admission).toContain("drop index unfurl.code_execution_one_learner_active");
    expect(admission).toContain("drop constraint python_execution_global_daily_quotas_reserved_count_check");
    expect(admission).toContain("drop constraint python_execution_learner_daily_quotas_reserved_count_check");
    expect(admission.match(/check \(reserved_count >= 1\)/g)).toHaveLength(2);
    expect(admission).not.toMatch(/drop (table|trigger)|delete from|truncate|reserved_count\s*(<|between)/i);
    expect(sql).toContain("'ambiguous', 'cleanup_pending', 'completed', 'unavailable'");
    expect(sql).toContain("status = 'completed' and disposition = 'deleted'");
    expect(sql).toContain("prior.status <> 'unavailable' or prior.disposition not in ('not_created', 'deleted')");
    expect(sql).toContain("code_execution_no_delete before delete");
    expect(sql).toContain("runtime_profile = 'python_stdlib_v1'");
    expect(sql).toContain("provider_session_id text");
    expect(sql).toContain("vercel/sandbox/python@sha256:3bc79de820271c18e2506c132ce20cc15c6215c0ae5725575b1d8e37ecca0218");
    expect(sql).toContain("sandbox_plan is null or sandbox_plan = 'hobby'");
    expect(sql).toContain("sandbox_project_owner_id = sandbox_team_id and sandbox_team_blocked = false");
    expect(sql).toContain("create table unfurl.python_execution_admissions");
    expect(sql).toContain("Python admission outcome is immutable");
    expect(sql).toContain("python_capability_short_lived");
  });

  it("records uncertain validation without weakening passed-only readiness and keeps receipts immutable", () => {
    expect(sql).toContain("verdict in ('passed', 'failed', 'uncertain')");
    expect(sql).toContain("version_validation_receipt_immutable before update or delete");
    expect(sql).toContain("task_validation_receipt_immutable before update or delete");
    expect(sql).toContain("v.verdict = 'passed'");
    const materialization = readFileSync(fileURLToPath(new URL("../../src/server/mechanics/materialization.ts", import.meta.url)), "utf8");
    expect(materialization).toContain('receipt.verdict !== "passed"');
  });

  it("separates explicit semantic retry epochs from lease recovery", () => {
    expect(sql).toContain("add column retry_epoch integer not null default 0");
    expect(sql).toContain("create table unfurl.execution_job_retry_receipts");
    expect(sql).toContain("Execution retry epoch requires an explicit receipt");
    expect(sql).toContain("o.state in ('dispatched','unknown')");
    expect(sql).toContain("advance_execution_job_retry(uuid,uuid,uuid,integer,jsonb)");
  });

  it("binds pre-ready Python authoring checks to generation-owned checkpoints", () => {
    expect(sql).toContain("create table unfurl.python_authoring_validations");
    expect(sql).toContain("course.task.candidate");
    expect(sql).toContain("course.task.cases");
    expect(sql).toContain("Python authoring authority is stale");
    expect(sql).toContain("item#>>'{response,source}'=new.source");
    expect(sql).toContain("item->>'role' not in ('public','hidden')");
    expect(sql).toContain("Python authoring fences are stale");
    expect(sql).toContain("o.state in ('reserved','dispatched','unknown')");
  });
});
