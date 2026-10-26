import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readySourceSql } from "../../src/server/course-materialization/ready-source";

const modulePath = process.env.BUDGET_LOCAL_PG_MODULE;
interface Sql { exec(sql: string): Promise<unknown>; query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; close(): Promise<void> }
const id = (n: number) => `40000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = "a".repeat(64), releaseDigest = "b".repeat(64), moduleDigest = "c".repeat(64);
const outline = [0, 1].map((n) => ({ id: id(20 + n), title: `Section ${n + 1}`, summary: "A planned section",
  outcomeIds: [id(30 + n)], prerequisiteModuleIds: n ? [id(20)] : [], estimatedStudyMinutes: 30 }));
const outcomes = [0, 1].map((n) => ({ id: id(30 + n), title: `Outcome ${n + 1}`, demonstration: "Apply the skill",
  prerequisiteOutcomeIds: n ? [id(30)] : [], requirement: "core" }));
const document = { modules: outline, outcomes };
const metadata = { kind: "official-section-preview-v1", publisher: "Unfurl", sourceRunId: id(2), courseVersionId: id(3),
  approvalId: id(4), approvalDigest: hash, completedStepId: id(7), moduleDigest, releaseDigest,
  presentation: { kind: "preview", availableModuleIds: [id(20)], plannedModules: outline } };
const receipt = { validatorVersion: "official-section-preview-v1", approvalDigest: hash, sourceRunId: id(2), completedStepId: id(7),
  contentDigest: releaseDigest, scope: { availableModuleIds: [id(20)] }, normalRouteValidated: true, adaptiveMaterialValidated: true };

describe.skipIf(!modulePath)("section preview database guard on isolated PostgreSQL", () => {
  let sql: Sql;
  beforeAll(async () => {
    const runtime = await import(/* @vite-ignore */ pathToFileURL(modulePath!).href) as { PGlite: new () => Sql };
    sql = new runtime.PGlite();
    await sql.exec(`CREATE SCHEMA unfurl;
      CREATE TABLE unfurl.courses(id uuid primary key,owner_id uuid);
      CREATE TABLE unfurl.generation_runs(id uuid primary key,owner_id uuid,course_id uuid,approval_id uuid,source_draft_revision integer,status text,output_version_id uuid);
      CREATE TABLE unfurl.curriculum_approvals(id uuid primary key,approved_by uuid,draft_id uuid,draft_revision integer,content_digest text);
      CREATE TABLE unfurl.curriculum_revisions(draft_id uuid,revision integer,content_digest text,document jsonb);
      CREATE TABLE unfurl.execution_jobs(id uuid primary key,generation_run_id uuid,status text);
      CREATE TABLE unfurl.run_steps(id uuid primary key,job_id uuid,status text,approval_digest text,result_reference jsonb);
      CREATE TABLE unfurl.lessons(id uuid primary key,course_version_id uuid);
      CREATE TABLE unfurl.version_validation_receipts(id uuid primary key,course_version_id uuid,verdict text,document jsonb);
      CREATE TABLE unfurl.course_versions(id uuid primary key,course_id uuid,source_run_id uuid,approval_id uuid,content_digest text,
        state text,modules jsonb,outcomes jsonb,lesson_ids uuid[],validation_receipt_id uuid);`);
    await sql.exec(await readFile("supabase/migrations/202610260030_official_section_preview.sql", "utf8"));
    const original = await readFile("supabase/migrations/202610250002_courses_and_runs.sql", "utf8");
    await sql.exec(original.slice(original.indexOf("create function unfurl.reject_ready_version_changes()"), original.indexOf("create function unfurl.check_ready_course_and_run()")));
    await sql.exec(`CREATE CONSTRAINT TRIGGER ready_version_validated AFTER INSERT OR UPDATE ON unfurl.course_versions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION unfurl.validate_ready_version();`);
    await sql.query("INSERT INTO unfurl.courses VALUES($1,$2)", [id(1), id(9)]);
    await sql.query("INSERT INTO unfurl.generation_runs VALUES($1,$2,$3,$4,1,'cancelled',NULL)", [id(2), id(9), id(1), id(4)]);
    await sql.query("INSERT INTO unfurl.curriculum_approvals VALUES($1,$2,$3,1,$4)", [id(4), id(9), id(5), hash]);
    await sql.query("INSERT INTO unfurl.curriculum_revisions VALUES($1,1,$2,$3)", [id(5), hash, JSON.stringify(document)]);
    await sql.query("INSERT INTO unfurl.execution_jobs VALUES($1,$2,'cancelled')", [id(6), id(2)]);
    await sql.query("INSERT INTO unfurl.run_steps VALUES($1,$2,'succeeded',$3,$4)", [id(7), id(6), hash,
      JSON.stringify({ kind: "course.module.completed", module: { moduleId: id(20), moduleDigest } })]);
    await sql.query("INSERT INTO unfurl.lessons VALUES($1,$2)", [id(8), id(3)]);
    await sql.query("INSERT INTO unfurl.version_validation_receipts VALUES($1,$2,'passed',$3)", [id(10), id(3), JSON.stringify(receipt)]);
    await sql.query("INSERT INTO unfurl.course_versions(id,course_id,source_run_id,approval_id,content_digest,state,modules,outcomes,lesson_ids,validation_receipt_id) VALUES($1,$2,$3,$4,$5,'failed',$6,$7,$8,$9)",
      [id(3), id(1), id(2), id(4), hash, JSON.stringify(outline), JSON.stringify(outcomes), [id(8)], id(10)]);
  });
  beforeEach(async () => { await sql.exec("BEGIN"); });
  afterEach(async () => { await sql.exec("ROLLBACK"); });
  afterAll(async () => { await sql?.close(); });
  async function release(value: unknown = metadata) {
    await sql.query("UPDATE unfurl.course_versions SET state='ready',modules=$2,outcomes=$3,release_metadata=$4 WHERE id=$1", [id(3), JSON.stringify([outline[0]]), JSON.stringify([outcomes[0]]), JSON.stringify(value)]);
    await sql.exec("SET CONSTRAINTS ALL IMMEDIATE");
  }
  async function readable() {
    return (await sql.query(`SELECT v.id FROM unfurl.course_versions v
      JOIN unfurl.version_validation_receipts receipt ON receipt.id=v.validation_receipt_id AND receipt.course_version_id=v.id AND receipt.verdict='passed'
      JOIN unfurl.generation_runs run ON run.id=v.source_run_id AND run.course_id=v.course_id AND ${readySourceSql("v", "run", "receipt")}
      WHERE v.state='ready'`)).rows;
  }
  it("accepts only the explicit section release and preserves the stopped full build", async () => {
    await release();
    expect((await sql.query("SELECT status,output_version_id FROM unfurl.generation_runs WHERE id=$1", [id(2)])).rows[0]).toEqual({ status: "cancelled", output_version_id: null });
    expect((await sql.query("SELECT document FROM unfurl.curriculum_revisions")).rows[0]!.document).toEqual(document);
    expect(await readable()).toEqual([{ id: id(3) }]);
    await expect(sql.query("UPDATE unfurl.course_versions SET outcomes='[]' WHERE id=$1", [id(3)])).rejects.toThrow("immutable");
  });
  it("keeps ordinary ready versions dependent on a completed full generation", async () => {
    await sql.query("UPDATE unfurl.course_versions SET state='ready' WHERE id=$1", [id(3)]);
    await expect(sql.exec("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow("completed generation");
  });
  it("continues to accept an ordinary completed full generation", async () => {
    await sql.query("UPDATE unfurl.generation_runs SET status='succeeded',output_version_id=$2 WHERE id=$1", [id(2), id(3)]);
    await sql.query("UPDATE unfurl.course_versions SET state='ready' WHERE id=$1", [id(3)]);
    await sql.exec("SET CONSTRAINTS ALL IMMEDIATE");
    expect(await readable()).toEqual([{ id: id(3) }]);
  });
  it.each(["running", "queued"])("rejects a %s source job", async (state) => {
    await sql.query("UPDATE unfurl.execution_jobs SET status=$1", [state]);
    await expect(release()).rejects.toThrow("stopped source");
  });
  it("rejects an incomplete or altered source checkpoint", async () => {
    await sql.query("UPDATE unfurl.run_steps SET status='failed'");
    await expect(release()).rejects.toThrow("original completed section");
  });
  it("rejects an edited planned outline", async () => {
    await expect(release({ ...metadata, presentation: { ...metadata.presentation, plannedModules: [outline[0]] } })).rejects.toThrow("original completed section");
  });
  it("rejects metadata claiming another available section", async () => {
    await expect(release({ ...metadata, presentation: { ...metadata.presentation, availableModuleIds: [id(21)] } })).rejects.toThrow("original completed section");
  });
  it("rejects a receipt that belongs to another release digest", async () => {
    await sql.query("UPDATE unfurl.version_validation_receipts SET document=$1", [JSON.stringify({ ...receipt, contentDigest: "d".repeat(64) })]);
    await expect(release()).rejects.toThrow("original completed section");
  });
  it("rejects an available scope containing outcomes from ungenerated sections", async () => {
    await sql.query("UPDATE unfurl.course_versions SET state='ready',modules=$2,release_metadata=$3 WHERE id=$1", [id(3), JSON.stringify([outline[0]]), JSON.stringify(metadata)]);
    await expect(sql.exec("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow("original completed section");
  });
});
