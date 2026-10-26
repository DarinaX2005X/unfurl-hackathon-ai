import "server-only";
import { IdSchema } from "../../domain/common";
import {
  CourseVisibilityInputSchema,
  CourseVisibilityReceiptSchema,
  CourseVisibilityStateSchema,
  type CourseVisibilityInput,
} from "../../domain/progression";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import { lockOwnedCourse as defaultLockOwnedCourse, type CourseLock } from "../catalog/access";
import { withSystemTransaction, type DbTransaction } from "../db";
import { executeIdempotentInTransaction, type MutationReceipt } from "../idempotency";
import { readAccountProgressTx } from "../progression";
import { revokeActiveShareGrants as defaultRevokeActiveShareGrants } from "../sharing/repository";
import { readySourceSql } from "../course-materialization/ready-source";

export interface PublicationTransactions {
  run<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T>;
}

export interface PublicationDependencies {
  transactions?: PublicationTransactions;
  lockOwnedCourse?: (tx: DbTransaction, actor: Actor, courseId: string) => Promise<CourseLock>;
  revokeActiveShareGrants?: (tx: DbTransaction, courseId: string) => Promise<number>;
  readAccountProgress?: typeof readAccountProgressTx;
}

function revisionConflict(currentRevision: number): ServiceFault {
  return new ServiceFault(409, "revision_conflict", "publication.revisionConflict", false, { currentRevision });
}

async function requirePublishableVersion(tx: DbTransaction, actor: Actor, courseId: string, versionId: string): Promise<void> {
  const result = await tx.query(
    `SELECT version.id
     FROM unfurl.course_versions version
     JOIN unfurl.version_validation_receipts validation
       ON validation.id = version.validation_receipt_id
       AND validation.course_version_id = version.id
       AND validation.verdict = 'passed'
     JOIN unfurl.generation_runs source_run
       ON source_run.id = version.source_run_id
       AND source_run.course_id = version.course_id
       AND source_run.owner_id = $3
       AND ${readySourceSql("version", "source_run", "validation")}
     WHERE version.id = $1 AND version.course_id = $2
       AND version.state = 'ready' AND version.cover IS NOT NULL`,
    [versionId, courseId, actor.id],
  );
  if (!result.rows[0]) throw new ServiceFault(403, "forbidden", "publication.versionNotEligible");
}

export function createPublicationService(dependencies: PublicationDependencies = {}) {
  const transactions = dependencies.transactions ?? {
    run: <T>(work: (tx: DbTransaction) => Promise<T>) => withSystemTransaction("publication", work),
  };
  const lockOwnedCourse = dependencies.lockOwnedCourse ?? defaultLockOwnedCourse;
  const revokeActiveShareGrants = dependencies.revokeActiveShareGrants ?? defaultRevokeActiveShareGrants;
  const readAccountProgress = dependencies.readAccountProgress ?? readAccountProgressTx;

  return {
    async getVisibility(actor: Actor, courseId: string) {
      const id = IdSchema.safeParse(courseId);
      if (!id.success) throw new ServiceFault(400, "invalid_input", "publication.invalidInput");
      return transactions.run(async (tx) => {
        const result = await tx.query<{
          id: string;
          visibility: "private" | "unlisted" | "public";
          current_ready_version_id: string | null;
          published_version_id: string | null;
          revision: number;
        }>(
          `SELECT id, visibility, current_ready_version_id, published_version_id, revision
           FROM unfurl.courses WHERE id = $1 AND owner_id = $2`,
          [id.data, actor.id],
        );
        const course = result.rows[0];
        if (!course) throw new ServiceFault(404, "not_found", "catalog.notFound");
        const progress = await readAccountProgress(tx, actor.id);
        return CourseVisibilityStateSchema.parse({
          courseId: course.id,
          visibility: course.visibility,
          currentReadyVersionId: course.current_ready_version_id,
          publishedVersionId: course.published_version_id,
          revision: course.revision,
          progress,
        });
      });
    },
    async setVisibility(actor: Actor, courseId: string, value: CourseVisibilityInput, key: string) {
      const id = IdSchema.safeParse(courseId);
      const body = CourseVisibilityInputSchema.safeParse(value);
      const idempotencyKey = IdSchema.safeParse(key);
      if (!id.success || !body.success || !idempotencyKey.success) {
        throw new ServiceFault(400, "invalid_input", "publication.invalidInput");
      }
      return transactions.run(async (tx) => {
        // Authorization and the aggregate course lock always precede idempotency replay.
        const course = await lockOwnedCourse(tx, actor, id.data);
        return executeIdempotentInTransaction(tx, actor, {
          operation: "course.visibility",
          key: idempotencyKey.data,
          body: { courseId: id.data, ...body.data },
          parseResult: CourseVisibilityReceiptSchema,
        }, async (): Promise<MutationReceipt<ReturnType<typeof CourseVisibilityReceiptSchema.parse>>> => {
          if (course.revision !== body.data.expectedRevision) throw revisionConflict(course.revision);

          const publishedVersionId = body.data.visibility === "public" ? body.data.courseVersionId : null;
          if (body.data.visibility === "public") {
            const progress = await readAccountProgress(tx, actor.id);
            if (!progress.publication.eligible) {
              throw new ServiceFault(403, "forbidden", "publication.levelRequired");
            }
            await requirePublishableVersion(tx, actor, course.id, body.data.courseVersionId);
          }

          const revokedGrantCount = body.data.visibility === "private"
            ? await revokeActiveShareGrants(tx, course.id)
            : 0;
          const unchanged = course.visibility === body.data.visibility
            && course.published_version_id === publishedVersionId
            && revokedGrantCount === 0;
          if (unchanged) {
            return { status: 200, data: {
              courseId: course.id,
              visibility: course.visibility,
              publishedVersionId: course.published_version_id,
              revision: course.revision,
            } };
          }

          const updated = await tx.query<{
            id: string; visibility: "private" | "unlisted" | "public"; published_version_id: string | null; revision: number;
          }>(
            `UPDATE unfurl.courses
             SET visibility = $2, published_version_id = $3, revision = revision + 1, updated_at = now()
             WHERE id = $1 AND owner_id = $4 AND revision = $5
             RETURNING id, visibility, published_version_id, revision`,
            [course.id, body.data.visibility, publishedVersionId, actor.id, course.revision],
          );
          const row = updated.rows[0];
          if (!row) throw revisionConflict(course.revision);
          return { status: 200, data: {
            courseId: row.id,
            visibility: row.visibility,
            publishedVersionId: row.published_version_id,
            revision: row.revision,
          } };
        });
      });
    },
  };
}

export const publicationService = createPublicationService();
export type PublicationService = ReturnType<typeof createPublicationService>;
