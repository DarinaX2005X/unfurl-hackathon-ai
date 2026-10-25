import "server-only";
import { IdSchema } from "../../domain/common";
import { EnrollmentInputSchema, type EnrollmentInput } from "../../domain/catalog";
import { EnrollmentReceiptSchema } from "../../domain/learning";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import { lockCourse } from "../catalog/access";
import { withSystemTransaction, type DbTransaction } from "../db";
import { executeIdempotentInTransaction } from "../idempotency";
import { createInitialLearningRoute } from "../learning/initial-route";
import * as repository from "./repository";

export interface EnrollmentTransactions { access<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> }

export function createEnrollmentService(options: { transactions?: EnrollmentTransactions; createId?: () => string } = {}) {
  const transactions: EnrollmentTransactions = options.transactions ?? {
    access: <T>(work: (tx: DbTransaction) => Promise<T>) => withSystemTransaction("course_access", work),
  };
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    async enroll(actor: Actor, courseId: string, value: EnrollmentInput, key: string) {
      const course = IdSchema.safeParse(courseId), requestKey = IdSchema.safeParse(key), body = EnrollmentInputSchema.safeParse(value);
      if (!course.success || !requestKey.success || !body.success) throw new ServiceFault(400, "invalid_input", "enrollment.invalidInput");
      return transactions.access(async (tx) => {
        const receipt = await executeIdempotentInTransaction(tx, actor, {
          operation: `course.enroll:${course.data}`, key: requestKey.data, body: body.data, parseResult: EnrollmentReceiptSchema,
        }, async (same) => {
          const locked = await lockCourse(same, course.data);
          const existing = await repository.findEnrollment(same, actor, course.data, body.data.courseVersionId, true);
          if (existing) {
            const enrollment = await repository.reactivateEnrollment(same, existing);
            return { status: 200, data: { enrollment, redirectTo: `/learn/${enrollment.id}` } };
          }
          if (body.data.shareToken !== undefined) {
            await repository.requireShareAccess(same, course.data, body.data.courseVersionId, body.data.shareToken);
          } else if (locked.owner_id !== actor.id
            && !(locked.visibility === "public" && locked.published_version_id === body.data.courseVersionId)) {
            throw new ServiceFault(404, "not_found", "catalog.notFound");
          }
          const material = await repository.loadLearningMaterial(same, course.data, body.data.courseVersionId);
          const enrollmentId = createId();
          const initial = createInitialLearningRoute({ enrollmentId, ...material });
          const enrollment = await repository.insertEnrollment(same, { id: enrollmentId, actor, courseId: course.data,
            versionId: body.data.courseVersionId, currentLessonId: initial.currentLessonId, currentTaskId: initial.currentTaskId });
          await same.query(
            "INSERT INTO unfurl.personal_routes (enrollment_id, revision, policy_version, document) VALUES ($1, 1, $2, $3::jsonb)",
            [enrollment.id, initial.route.policyVersion, JSON.stringify(initial.route)],
          );
          return { status: 201, data: { enrollment, redirectTo: `/learn/${enrollment.id}` } };
        });
        if (receipt.replayed && !(await repository.findEnrollment(tx, actor, course.data, body.data.courseVersionId))) {
          throw new ServiceFault(404, "not_found", "catalog.notFound");
        }
        return receipt;
      });
    },
  };
}

export const enrollmentService = createEnrollmentService();
