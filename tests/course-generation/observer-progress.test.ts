import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { GenerationSnapshotSchema } from "../../src/domain/generation-observer";
import { readRunSnapshot } from "../../src/server/runs/observer";
import { classifyGenerationStep } from "../../src/server/runs/generation-progress";
import type { DbTransaction } from "../../src/server/db";
import { curriculum, ids, timestamp } from "../domain/fixtures";

const runId = "70000000-0000-4000-8000-000000000001";
const jobId = "70000000-0000-4000-8000-000000000002";
const branchId = "70000000-0000-4000-8000-000000000003";
const digest = "a".repeat(64);
const now = "2026-10-26T10:00:00.000Z";
const actor = { id: ids.actor, sessionId: ids.request, email: null };
function fixture() {
  const state = {
    run: { id: runId, owner_id: ids.actor, course_id: ids.course, conversation_id: ids.conversation, branch_id: branchId,
      input_message_id: ids.request, source_draft_revision: 1, approval_id: ids.approval, phase: "module_research", status: "running",
      last_seq: 1, output_version_id: null, error: null as unknown, created_at: timestamp, updated_at: now },
    draft: curriculum(),
    stored: { job_id: jobId, generation_run_id: runId, owner_id: ids.actor as string, approval_id: ids.approval as string,
      approval_digest: digest, job_status: "running", job_live: true, job_updated_at: now,
      step_key: `course/${ids.moduleA}/research-v2/approved-knowledge`, step_status: "running", step_live: true, step_updated_at: now },
    sourceCount: 2, completedEvents: [] as unknown[], validationEvent: null as unknown, activityModuleIds: [ids.moduleA] as string[],
    hasJob: true,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[];
    if (sql.includes("SELECT r.* FROM unfurl.generation_runs")) {
      expect(values).toEqual([runId, actor.id]);
      rows = [state.run];
    } else if (sql.includes("SELECT revision.document")) rows = [{ document: state.draft, content_digest: digest }];
    else if (sql.includes("SELECT DISTINCT ON")) rows = state.completedEvents.map(event => ({ event }));
    else if (sql.includes("type='generation.validation.summary'")) rows = state.validationEvent ? [{ event: state.validationEvent }] : [];
    else if (sql.includes("SELECT j.id AS job_id")) {
      expect(values).toEqual([runId, ids.actor, ids.approval, digest]);
      expect(sql).toContain("r.id=j.generation_run_id");
      expect(sql).toContain("r.owner_id=$2");
      expect(sql).toContain("WHERE job_id=j.id AND approval_digest=$4");
      expect(sql).toContain("a.content_digest=$4");
      expect(sql).not.toContain("result_reference");
      rows = state.hasJob ? [state.stored] : [];
    } else if (sql.includes("count(DISTINCT result_reference->>'sourceId')")) {
      expect(values).toEqual([jobId, digest, `course/${ids.moduleA}/research/read/%`, ids.moduleA]);
      expect(sql).toContain("status='succeeded'");
      expect(sql).toContain("result_reference->>'approvalDigest'=$2");
      rows = [{ completed_sources: state.sourceCount }];
    } else if (sql.includes("SELECT DISTINCT candidate.result_reference")) {
      expect(values).toEqual([jobId, digest, JSON.stringify([{ caseId: ids.task }]), [ids.moduleA, ids.moduleB]]);
      expect(sql).toContain("candidate.job_id=cases.job_id");
      expect(sql).toContain("cases.approval_digest=$2 AND candidate.approval_digest=$2");
      rows = state.activityModuleIds.map(module_id => ({ module_id }));
    } else throw new Error(`Unexpected SQL: ${sql}`);
    return { rows, rowCount: rows.length, command: "SELECT", fields: [], oid: 0 };
  });
  return { state, query, read: async () => GenerationSnapshotSchema.parse(await readRunSnapshot({ query } as unknown as DbTransaction, actor, runId, "generation")) };
}

describe("safe generation progress from existing execution records", () => {
  it("does not claim research before a job and actual step have started", async () => {
    const h = fixture(); h.state.run.status = "queued"; h.state.hasJob = false;
    const snapshot = await h.read();
    expect(snapshot.progress).toEqual({ stage: "preparing", activity: "waiting", updatedAt: now });
    expect(snapshot.modules.every(module => module.status === "pending")).toBe(true);
    expect(snapshot.lastSeq).toBe(1);
  });
  it("shows the first live research call even before any phase event has committed", async () => {
    const h = fixture(); h.state.sourceCount = 0;
    const snapshot = await h.read();
    expect(snapshot.progress).toEqual({ stage: "researching", activity: "running", moduleId: ids.moduleA, completedSources: 0, updatedAt: now });
    expect(snapshot.run.status).toBe("running");
    expect(snapshot.modules[0]?.status).toBe("researching");
    expect(snapshot.lastSeq).toBe(1);
  });
  it("reports confirmed source reads without exposing step keys or checkpoint data", async () => {
    const h = fixture(); h.state.stored.step_key = `course/${ids.moduleA}/research/read/private-hit-id`;
    const snapshot = await h.read();
    expect(snapshot.progress).toMatchObject({ stage: "reading_sources", moduleId: ids.moduleA, completedSources: 2 });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-hit-id|step_key|result_reference|job_id/);
  });
  it("preserves the confirmed section while waiting between durable steps", async () => {
    const h = fixture(); h.state.stored.job_status = "queued"; h.state.stored.job_live = false;
    h.state.stored.step_status = "succeeded"; h.state.stored.step_live = false;
    const snapshot = await h.read();
    expect(snapshot.progress).toMatchObject({ stage: "preparing", activity: "waiting", moduleId: ids.moduleA, completedSources: 2 });
    expect(snapshot.modules[0]?.status).toBe("pending");
  });
  it.each(["job_live", "step_live"] as const)("does not present expired %s authority as active work", async (field) => {
    const h = fixture(); h.state.stored[field] = false;
    expect((await h.read()).progress).toMatchObject({ stage: "preparing", activity: "waiting" });
  });
  it.each(["generation_run_id", "owner_id", "approval_id", "approval_digest"] as const)("rejects foreign %s progress metadata", async (field) => {
    const h = fixture(); h.state.stored[field] = field === "approval_digest" ? "b".repeat(64) : ids.missing;
    expect((await h.read()).progress).toEqual({ stage: "preparing", activity: "waiting", updatedAt: now });
    expect(h.query.mock.calls.some(([sql]) => sql.includes("count(DISTINCT"))).toBe(false);
  });
  it("does not expose an unknown module or infer a stage from a private arbitrary key", async () => {
    const h = fixture(); h.state.stored.step_key = `course/${ids.missing}/research/read/private-source`;
    expect((await h.read()).progress).toEqual({ stage: "preparing", activity: "running", updatedAt: now });
    h.state.stored.step_key = `course/${ids.moduleA}/unknown-private-stage`;
    expect((await h.read()).progress).toEqual({ stage: "preparing", activity: "running", updatedAt: now });
  });
  it("binds activity validation to its saved case plan and approved module", async () => {
    const h = fixture(); h.state.stored.step_key = `course/case/${ids.task}/activity/0/audit`;
    expect((await h.read()).progress).toMatchObject({ stage: "validating_practice", moduleId: ids.moduleA });
    h.state.activityModuleIds = [ids.missing];
    expect((await h.read()).progress?.moduleId).toBeUndefined();
  });
  it("omits progress for a terminal run without consulting stale execution steps", async () => {
    const h = fixture(); h.state.run.status = "failed";
    h.state.run.error = { code: "generation_failed", messageKey: "generation.invalidResponse", retryable: false, requestId: ids.request };
    expect((await h.read()).progress).toBeUndefined();
    expect(h.query.mock.calls.some(([sql]) => sql.includes("SELECT j.id AS job_id"))).toBe(false);
  });
  it("does not count a foreign event as a completed section", async () => {
    const h = fixture();
    h.state.completedEvents = [{ id: ids.request, runId: ids.missing, courseId: ids.course, branchId, seq: 1, at: now,
      type: "generation.module.completed", moduleId: ids.moduleA, completedTasks: 20 }];
    expect((await h.read()).work.completed).toBe(0);
  });
  it("rejects an approved document from a different course or conversation", async () => {
    const h = fixture(); h.state.draft = { ...h.state.draft, conversationId: ids.missing };
    await expect(h.read()).rejects.toMatchObject({ status: 404 });
  });
});

describe("generation progress vocabulary and backward compatibility", () => {
  it.each([
    [`research/plan`, "researching"], [`research/search/query-1`, "researching"], [`research/claims/hit-1`, "researching"],
    [`round/0/plan/${ids.outcomeA}/0`, "planning_lessons"], [`round/0/reading/${ids.sample}/${ids.request}/0`, "writing_lessons"],
    [`round/0/task/${ids.task}/0/candidate`, "creating_practice"], [`round/0/batch/v2/${ids.task}/0/candidate`, "creating_practice"],
    [`round/0/batch/v2/repair/${ids.task}/1/review`, "validating_practice"], [`round/0/task/${ids.task}/0/case/valid/execute`, "validating_practice"],
    [`round/0/review/${ids.outcomeA}`, "reviewing_section"], [`complete`, "saving_section"],
  ])("maps the stored %s shape to %s", (suffix, stage) => {
    expect(classifyGenerationStep(`course/${ids.moduleA}/${suffix}`, new Set([ids.moduleA]))).toEqual({ stage, moduleId: ids.moduleA });
  });
  it("supports final materialization without inventing a module", () => {
    expect(classifyGenerationStep("course/materialize", new Set())).toEqual({ stage: "finalizing_course" });
  });
  it("accepts old snapshots but rejects foreign modules, raw material and unknown stages", async () => {
    const snapshot = await fixture().read();
    const legacy = { ...snapshot }; delete legacy.progress;
    expect(GenerationSnapshotSchema.safeParse(legacy).success).toBe(true);
    for (const progress of [{ ...snapshot.progress, moduleId: ids.missing }, { ...snapshot.progress, stepKey: "private" },
      { ...snapshot.progress, stage: "private-stage" }]) {
      expect(GenerationSnapshotSchema.safeParse({ ...snapshot, progress }).success).toBe(false);
    }
  });
});
