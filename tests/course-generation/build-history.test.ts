import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readConversationBuilds } from "../../src/server/conversations/build-history";
import { readGenerationHistory, readGenerationSnapshots } from "../../src/server/runs/observer";
import { ConversationBuildSchema } from "../../src/domain/conversations";
import { GenerationSnapshotSchema } from "../../src/domain/generation-observer";
import { curriculum, ids, timestamp } from "../domain/fixtures";

const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { id: ids.actor, sessionId: ids.request, email: null }, branchId = id(90), digest = "a".repeat(64);
const conversation = { id: ids.conversation, ownerId: ids.actor, title: "Saved conversation", activeBranchId: branchId,
  revision: 8, createdAt: timestamp, updatedAt: timestamp };
const fault = { code: "generation_failed", messageKey: "generation.invalidResponse", retryable: false, requestId: ids.request };
function savedRun(n: number, parent: string | null = null) {
  return { id: id(n), retry_of_run_id: parent, owner_id: ids.actor, course_id: ids.course, conversation_id: ids.conversation,
    branch_id: branchId, input_message_id: ids.request, source_draft_revision: 1, approval_id: ids.approval,
    phase: "building_tasks", status: "failed", last_seq: 150, output_version_id: null as string | null, error: fault as unknown,
    created_at: timestamp, updated_at: timestamp, document: curriculum(), content_digest: digest, completed: [], validation: null,
    timeline: [] as unknown[], ready_course: null as unknown };
}
function commentary(runId: string, seq: number) {
  return { id: id(1000 + seq), runId, branchId, courseId: ids.course, seq, at: timestamp,
    type: "generation.commentary", stepId: id(2000 + seq), text: `Research milestone ${seq}.` };
}
function harness() {
  const state = { runs: [savedRun(1), savedRun(2, id(1))], foreign: false };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("SELECT r.id,r.retry_of_run_id")) {
      expect(values).toEqual([ids.conversation, ids.actor, branchId]);
      expect(sql).toContain("revision.revision=a.draft_revision");
      return { rows: state.runs.map(run => ({ ...run, draft_id: ids.draft, draft_revision: 1, approved_at: timestamp, summary: "A saved course summary." })) };
    }
    if (sql.startsWith("SELECT r.*,revision.document")) {
      expect(values[1]).toBe(ids.actor);
      expect(sql).toContain("receipt.verdict='passed'");
      expect(sql).toContain("v.source_run_id=r.id");
      expect(sql).toContain("r.owner_id=$2");
      return { rows: state.runs.filter(run => (values[0] as string[]).includes(run.id)).map(run => state.foreign ? { ...run, owner_id: ids.missing } : run) };
    }
    if (sql.startsWith("SELECT r.* FROM")) return { rows: [state.runs.find(run => run.id === values[0])] };
    if (sql.startsWith("SELECT event FROM")) {
      const run = state.runs.find(run => run.id === values[0])!;
      const events = run.timeline as Array<{ seq: number }>;
      return { rows: events.filter(event => values[3] === null || event.seq < Number(values[3])).slice(0, Number(values[5])).map(event => ({ event })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { state, query, tx: { query } as never };
}

describe("chat build history from committed approval and execution evidence", () => {
  it("hydrates historical approval and exact retry order in two queries after a draft changed", async () => {
    const h = harness();
    // Equal timestamps and reversed DB ordering must not change explicit retry ancestry.
    h.state.runs.reverse();
    const builds = await readConversationBuilds(h.tx, actor, conversation);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ approvalId: ids.approval, draftRevision: 1, title: curriculum().title,
      initialRunId: id(1), runs: [{ retryOfRunId: null }, { retryOfRunId: id(1) }] });
    expect(builds[0]!.runs.map(entry => entry.snapshot.run.id)).toEqual([id(1), id(2)]);
    expect(ConversationBuildSchema.safeParse(builds[0]).success).toBe(true);
  });
  it("keeps terminal history bounded, sorted and recoverable with a strict before cursor", async () => {
    const h = harness(); h.state.runs[0]!.timeline = Array.from({ length: 21 }, (_, index) => commentary(id(1), 100 - index));
    const [snapshot] = await readGenerationSnapshots(h.tx, actor, [id(1)]);
    expect(snapshot!.retainedTimelineEvents).toHaveLength(20);
    expect(snapshot!.retainedTimelineEvents?.map(event => event.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 81 + i));
    expect(snapshot!.timelineBeforeSeq).toBe(81);
    const page = await readGenerationHistory(h.tx, actor, id(1), { before: 81, limit: 50 });
    expect(page.items.map(event => event.seq)).toEqual([80]);
    expect(page.beforeSeq).toBeNull();
  });
  it("rejects foreign owner, event scope and broken retry lineage", async () => {
    const foreign = harness(); foreign.state.foreign = true;
    await expect(readConversationBuilds(foreign.tx, actor, conversation)).rejects.toMatchObject({ status: 404 });
    const badEvent = harness(); badEvent.state.runs[0]!.timeline = [{ ...commentary(id(1), 1), branchId: ids.missing }];
    await expect(readGenerationSnapshots(badEvent.tx, actor, [id(1)])).rejects.toThrow();
    const broken = harness(); broken.state.runs[1]!.retry_of_run_id = ids.missing;
    await expect(readConversationBuilds(broken.tx, actor, conversation)).rejects.toMatchObject({ status: 404 });
  });
  it("requires the exact ready output and passed stored receipt before exposing a course card", async () => {
    const h = harness(), run = h.state.runs[0]!;
    run.status = "succeeded"; run.error = null; run.output_version_id = ids.sample;
    await expect(readGenerationSnapshots(h.tx, actor, [id(1)])).rejects.toMatchObject({ status: 404 });
    run.ready_course = { courseId: ids.course, courseVersionId: ids.sample, title: curriculum().title,
      summary: "Ready course.", contentLanguage: "en", moduleCount: 2, lessonCount: 4 };
    const [snapshot] = await readGenerationSnapshots(h.tx, actor, [id(1)]);
    expect(snapshot!.readyCourse?.courseVersionId).toBe(ids.sample);
    expect(GenerationSnapshotSchema.safeParse({ ...snapshot, readyCourse: { ...snapshot!.readyCourse, courseVersionId: ids.missing } }).success).toBe(false);
  });
  it("rejects raw fields and private result material at the public timeline boundary", async () => {
    const h = harness(), [snapshot] = await readGenerationSnapshots(h.tx, actor, [id(1)]);
    const event = { ...commentary(id(1), 1), privateAnswer: "hidden" };
    expect(GenerationSnapshotSchema.safeParse({ ...snapshot, retainedTimelineEvents: [event] }).success).toBe(false);
  });
});
