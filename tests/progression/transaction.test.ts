import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DbTransaction } from "../../src/server/db";
import {
  applyEvaluationProgressTx,
  lockLearnerCourseStableTaskTx,
  readAccountProgressTx,
} from "../../src/server/progression";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const evaluationId = id("1");
const learnerId = id("2");
const enrollmentId = id("3");
const activityId = id("4");
const courseId = id("5");
const taskId = id("6");
const attemptId = id("7");
const evidenceId = id("8");
const awardId = id("9");

type Scenario = {
  currentRevision?: number;
  semanticStatus?: "evaluated" | "uncertain";
  semanticOutcome?: "correct" | "partial" | "incorrect" | null;
  assistance?: "independent" | "hinted" | "worked_example";
  reviewState?: "confirmed" | "contested" | "superseded";
  award?: { amount: 10 | 25; evaluationId: string };
  adjustmentTotal?: number;
};

function transaction(scenario: Scenario = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const identity = {
    evaluation_id: evaluationId,
    current_revision: scenario.currentRevision ?? 1,
    attempt_id: attemptId,
    learner_id: learnerId,
    enrollment_id: enrollmentId,
    activity_session_id: activityId,
    course_id: courseId,
    task_id: taskId,
    assistance: scenario.assistance ?? "independent",
    semantic_status: scenario.semanticStatus ?? "evaluated",
    semantic_outcome: scenario.semanticOutcome === undefined ? "correct" : scenario.semanticOutcome,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("FROM unfurl.evaluations evaluation")) return { rows: [identity], rowCount: 1 };
    if (sql.includes("FROM unfurl.enrollments") && sql.includes("FOR UPDATE")) return { rows: [{ id: enrollmentId }], rowCount: 1 };
    if (sql.includes("FROM unfurl.activity_sessions")) return { rows: [{ id: activityId }], rowCount: 1 };
    if (sql.includes("FROM unfurl.learner_evidence") && !sql.includes("original_evidence")) {
      return { rows: [{ id: evidenceId, assistance: identity.assistance, review_state: scenario.reviewState ?? "confirmed" }], rowCount: 1 };
    }
    if (sql.includes("FROM unfurl.xp_awards award")) {
      return { rows: scenario.award ? [{
        id: awardId,
        amount: scenario.award.amount,
        qualifying_evidence_id: evidenceId,
        original_evaluation_id: scenario.award.evaluationId,
      }] : [], rowCount: scenario.award ? 1 : 0 };
    }
    if (sql.includes("sum(delta)")) return { rows: [{ delta_total: String(scenario.adjustmentTotal ?? 0) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { statements, tx: { query } as unknown as DbTransaction };
}

describe("progression transaction boundary", () => {
  it("derives one deterministic domain-separated advisory key", async () => {
    const first = transaction();
    const second = transaction();
    await lockLearnerCourseStableTaskTx(first.tx, { learnerId, courseId, taskId });
    await lockLearnerCourseStableTaskTx(second.tx, { learnerId, courseId, taskId });
    expect(first.statements[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(first.statements[0]?.values).toEqual(second.statements[0]?.values);
    expect(first.statements[0]?.values[0]).toMatch(/^-?\d+$/);
  });

  it("locks authority in order and inserts one independent award from stored joins", async () => {
    const state = transaction();
    await applyEvaluationProgressTx(state.tx, { evaluationId, evaluationRevision: 1 });
    const sql = state.statements.map((item) => item.sql);
    const advisory = sql.findIndex((item) => item.includes("pg_advisory_xact_lock"));
    const enrollment = sql.findIndex((item) => item.includes("FROM unfurl.enrollments") && item.includes("FOR UPDATE"));
    const activity = sql.findIndex((item) => item.includes("FROM unfurl.activity_sessions"));
    const evaluation = sql.findIndex((item) => item.includes("FOR UPDATE OF evaluation"));
    const award = sql.findIndex((item) => item.includes("INSERT INTO unfurl.xp_awards"));
    expect([advisory, enrollment, activity, evaluation, award]).toEqual([...([advisory, enrollment, activity, evaluation, award])].sort((a, b) => a - b));
    expect(state.statements[award]?.values.slice(1)).toEqual([learnerId, courseId, taskId, evidenceId, "xp-v1", 25]);
  });

  it("does not consume the award identity for a zero-XP result", async () => {
    const state = transaction({ assistance: "worked_example" });
    await applyEvaluationProgressTx(state.tx, { evaluationId, evaluationRevision: 1 });
    expect(state.statements.some((item) => item.sql.includes("INSERT INTO unfurl.xp_awards"))).toBe(false);
  });

  it("does not top up or revoke a stable-task award earned by another evaluation", async () => {
    const state = transaction({ assistance: "independent", award: { amount: 10, evaluationId: id("40") } });
    await applyEvaluationProgressTx(state.tx, { evaluationId, evaluationRevision: 1 });
    expect(state.statements.some((item) => item.sql.includes("xp_award_adjustments"))).toBe(false);
  });

  it("keeps contested or uncertain review results from reversing confirmed XP", async () => {
    const contested = transaction({ reviewState: "contested", award: { amount: 25, evaluationId } });
    await applyEvaluationProgressTx(contested.tx, { evaluationId, evaluationRevision: 1 });
    expect(contested.statements.some((item) => item.sql.includes("INSERT INTO unfurl.xp_award_adjustments"))).toBe(false);

    const uncertain = transaction({ semanticStatus: "uncertain", semanticOutcome: null, award: { amount: 25, evaluationId } });
    await applyEvaluationProgressTx(uncertain.tx, { evaluationId, evaluationRevision: 1 });
    expect(uncertain.statements.some((item) => item.sql.includes("INSERT INTO unfurl.xp_award_adjustments"))).toBe(false);
  });

  it("appends a bounded correction only to the award's original evaluation", async () => {
    const state = transaction({ currentRevision: 2, semanticOutcome: "incorrect", award: { amount: 25, evaluationId } });
    await applyEvaluationProgressTx(state.tx, { evaluationId, evaluationRevision: 2 });
    const insert = state.statements.find((item) => item.sql.includes("INSERT INTO unfurl.xp_award_adjustments"));
    expect(insert?.values.slice(1)).toEqual([awardId, evaluationId, 2, -25]);
  });

  it("ignores a stale semantic completion before taking locks", async () => {
    const state = transaction({ currentRevision: 2 });
    await applyEvaluationProgressTx(state.tx, { evaluationId, evaluationRevision: 1 });
    expect(state.statements).toHaveLength(1);
  });

  it("derives account progress from award contributions rather than a stored total", async () => {
    const query = vi.fn(async () => ({ rows: [{ xp_total: "500" }], rowCount: 1 }));
    const progress = await readAccountProgressTx({ query } as unknown as DbTransaction, learnerId);
    expect(progress).toEqual({
      xpTotal: 500,
      level: 3,
      xpToNextLevel: 250,
      publication: { eligible: true, requiredLevel: 3, reasons: [] },
    });
    expect((query.mock.calls as unknown[][])[0]?.[0]).toContain("LEFT JOIN LATERAL");
  });
});
