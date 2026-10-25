import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createEnrollmentService, type EnrollmentTransactions } from "../../src/server/enrollments/service";
import type { DbTransaction } from "../../src/server/db";
import { program } from "../learning-runtime/fixtures";

const actor = { id: "10000000-0000-4000-8000-000000000001", sessionId: "10000000-0000-4000-8000-000000000002", email: null };
const requestId = "10000000-0000-4000-8000-000000000003";
const enrollmentId = "10000000-0000-4000-8000-000000000004";
const at = "2026-10-25T00:00:00.000Z";
const rows = (items: unknown[] = []) => ({ rows: items, rowCount: items.length });
const transactions = (tx: DbTransaction): EnrollmentTransactions => ({ access: async (work) => work(tx) });

function versionRow(value: ReturnType<typeof program>["version"]) {
  return {
    id: value.id, course_id: value.courseId, number: value.number, approval_id: value.approvalId,
    source_run_id: value.sourceRunId, content_digest: value.contentDigest, state: value.state, title: value.title,
    summary: value.summary, content_language: value.contentLanguage, assumed_knowledge: value.assumedKnowledge,
    outcomes: value.outcomes, modules: value.modules, lesson_ids: value.lessonIds,
    validation_receipt_id: value.validationReceiptId, cover: value.cover, created_at: value.createdAt, ready_at: value.readyAt,
  };
}
function enrollmentRow(courseId: string, versionId: string, status = "active") {
  return { id: enrollmentId, learner_id: actor.id, course_id: courseId, course_version_id: versionId, status,
    route_revision: 1, current_lesson_id: "10000000-0000-4000-8000-000000000010", current_task_id: null,
    created_at: at, last_studied_at: null };
}

describe("atomic enrollment", () => {
  it("creates the pinned enrollment and initial route together after the course lock", async () => {
    const material = program();
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      calls.push(sql);
      if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows([{ key: requestId }]);
      if (sql.includes("FROM unfurl.courses WHERE id")) return rows([{ id: material.version.courseId, owner_id: actor.id,
        visibility: "private", revision: 2, current_ready_version_id: material.version.id, published_version_id: null }]);
      if (sql.startsWith("SELECT * FROM unfurl.enrollments")) return rows();
      if (sql.includes("FROM unfurl.course_versions v")) return rows([versionRow(material.version)]);
      if (sql.includes("FROM unfurl.lessons")) return rows(material.lessons.map((lesson) => ({ id: lesson.id,
        course_version_id: lesson.courseVersionId, module_id: lesson.moduleId, title: lesson.title,
        outcome_ids: lesson.outcomeIds, blocks: lesson.blocks, task_ids: lesson.taskIds })));
      if (sql.includes("FROM unfurl.tasks_public")) return rows(material.tasks.map(({ task, assessment }) => ({
        id: task.id, task_version: task.taskVersion, mechanic_id: task.mechanicId, mechanic_version: task.mechanicVersion,
        outcome_ids: task.outcomeIds, instruction: task.instruction, content_language: task.contentLanguage,
        config: task.config, available_hints: task.availableHints, response_schema_version: task.responseSchemaVersion, assessment,
      })));
      if (sql.startsWith("INSERT INTO unfurl.enrollments")) return rows([{ ...enrollmentRow(material.version.courseId, material.version.id),
        current_lesson_id: material.version.lessonIds[0] }]);
      return rows();
    });
    const service = createEnrollmentService({ transactions: transactions({ query } as unknown as DbTransaction), createId: () => enrollmentId });
    const result = await service.enroll(actor, material.version.courseId, { courseVersionId: material.version.id }, requestId);
    expect(result.status).toBe(201);
    expect(result.data.redirectTo).toBe(`/learn/${enrollmentId}`);
    expect(calls.findIndex((sql) => sql.includes("FROM unfurl.courses WHERE id")))
      .toBeLessThan(calls.findIndex((sql) => sql.startsWith("INSERT INTO unfurl.enrollments")));
    expect(calls.findIndex((sql) => sql.startsWith("INSERT INTO unfurl.enrollments")))
      .toBeLessThan(calls.findIndex((sql) => sql.startsWith("INSERT INTO unfurl.personal_routes")));
    const routeInsert = query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO unfurl.personal_routes"));
    const route = JSON.parse(routeInsert?.[1]?.[2] as unknown as string);
    expect(route.enrollmentId).toBe(enrollmentId);
    expect(route.next.map((item: { taskId: string | null }) => item.taskId)).toEqual([null, material.tasks[2]!.task.id, material.tasks[0]!.task.id]);
  });

  it("reactivates an archived enrollment without replacing its route or position", async () => {
    const material = program();
    const archived = enrollmentRow(material.version.courseId, material.version.id, "archived");
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows([{ key: requestId }]);
      if (sql.includes("FROM unfurl.courses WHERE id")) return rows([{ id: material.version.courseId, owner_id: crypto.randomUUID(),
        visibility: "private", revision: 2, current_ready_version_id: null, published_version_id: null }]);
      if (sql.startsWith("SELECT * FROM unfurl.enrollments")) return rows([archived]);
      if (sql.startsWith("UPDATE unfurl.enrollments SET status")) return rows([{ ...archived, status: "active" }]);
      return rows();
    });
    const result = await createEnrollmentService({ transactions: transactions({ query } as unknown as DbTransaction) })
      .enroll(actor, material.version.courseId, { courseVersionId: material.version.id, shareToken: "A".repeat(43) }, requestId);
    expect(result.status).toBe(200);
    expect(result.data.enrollment.status).toBe("active");
    expect(result.data.enrollment.currentLessonId).toBe(archived.current_lesson_id);
    expect(query.mock.calls.some(([sql]) => sql.includes("FROM unfurl.share_grants"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO unfurl.personal_routes"))).toBe(false);
  });
});
