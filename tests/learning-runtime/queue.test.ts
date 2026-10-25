import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/server/progression", () => ({ lockLearnerCourseStableTaskTx: vi.fn() }));
vi.mock("@/server/runs/enqueue", () => ({ resumeLearningJobTx: vi.fn() }));
vi.mock("@/server/learning/repository", () => ({ requireEnrollment: vi.fn(), loadProgram: vi.fn(), notFound: () => { throw new Error("Not found"); }, invariant: () => { throw new Error("Invariant"); } }));
import { activateLearningJob } from "@/server/learning/queue";
import { resumeLearningJobTx } from "@/server/runs/enqueue";
import * as repository from "@/server/learning/repository";
import type { DbTransaction } from "@/server/db";
import { program } from "./fixtures";

const actor = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), email: null }, data = program();
const target = { kind: "evaluation" as const, evaluationId: crypto.randomUUID(), targetEvaluationRevision: 1 };
const retryReceiptId = crypto.randomUUID();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repository.requireEnrollment).mockResolvedValue({ id: data.enrollmentId, learnerId: actor.id, courseId: data.version.courseId, courseVersionId: data.version.id,
    status: "active", routeRevision: 1, currentLessonId: data.lessons[1]!.id, currentTaskId: data.tasks[0]!.task.id, createdAt: "2026-10-25T00:00:00Z", lastStudiedAt: null });
  vi.mocked(repository.loadProgram).mockResolvedValue(data);
  vi.mocked(resumeLearningJobTx).mockResolvedValue({ jobId: crypto.randomUUID(), retryEpoch: 1 });
});
function transaction(job: { retry_epoch: number; has_steps: boolean }) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM unfurl.execution_jobs") ? [{ id: crypto.randomUUID(), status: "waiting", ...job }] :
    sql.includes("JOIN unfurl.attempts") ? [{ enrollment_id: data.enrollmentId, task_id: data.tasks[0]!.task.id, task_version: 1, learner_id: actor.id }] : [], rowCount: 1 }));
  const tx = { query } as unknown as DbTransaction;
  return { run: <T>(work: (tx: DbTransaction) => Promise<T>) => work(tx) };
}
const admission = { assertAvailable: vi.fn(async () => undefined) };
describe("stable retry intent across lost responses", () => {
  it("does not turn replay of an initial activation into a new paid retry after work ran", async () => {
    expect(await activateLearningJob(transaction({ retry_epoch: 0, has_steps: true }), admission, actor, target,
      { retryReceiptId, expectedRetryEpoch: 0, hadEffects: false })).toBe(false);
    expect(resumeLearningJobTx).not.toHaveBeenCalled();
  });
  it("advances only an explicitly captured retry intent and refuses a later epoch replay", async () => {
    expect(await activateLearningJob(transaction({ retry_epoch: 0, has_steps: true }), admission, actor, target,
      { retryReceiptId, expectedRetryEpoch: 0, hadEffects: true })).toBe(true);
    expect(resumeLearningJobTx).toHaveBeenCalledWith(expect.anything(), target, { actorId: actor.id, expectedRetryEpoch: 0, explicitPaidRetry: true, retryReceiptId });
    vi.mocked(resumeLearningJobTx).mockClear();
    expect(await activateLearningJob(transaction({ retry_epoch: 1, has_steps: true }), admission, actor, target,
      { retryReceiptId, expectedRetryEpoch: 0, hadEffects: true })).toBe(false);
    expect(resumeLearningJobTx).not.toHaveBeenCalled();
  });
});
