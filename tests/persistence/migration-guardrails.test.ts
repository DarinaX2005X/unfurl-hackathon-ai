import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(`${directory}/${name}`, "utf8"));
const sql = migrations.join("\n");

describe("migration static guardrails (live PostgreSQL proof still required)", () => {
  it("keeps the application schema outside anonymous grants and protects all tables with RLS", () => {
    const tables = [...sql.matchAll(/create table unfurl\.([a-z_]+)/g)].map((match) => match[1]!);
    const directRls = [...sql.matchAll(/alter table unfurl\.([a-z_]+) enable row level security/g)].map((match) => match[1]!);
    const loopRls = [...sql.matchAll(/foreach table_name in array array\[([\s\S]*?)\] loop/g)]
      .flatMap((match) => [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((item) => item[1]!));
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
});
