import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { CreateShareInputSchema, ShareCreatedSchema, type CreateShareInput } from "../../domain/catalog";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import { withSystemTransaction, type DbTransaction } from "../db";
import { executeIdempotentInTransaction } from "../idempotency";
import { lockOwnedCourse } from "../catalog/access";
import { deriveShareToken, hashShareToken, sharePath } from "./crypto";
import { requireShareTokenConfiguration, type ShareTokenConfiguration } from "./config";
import * as repository from "./repository";

const StoredShareReceiptSchema = z.object({
  grantId: IdSchema, keyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/), courseRevision: z.number().int().positive(),
}).strict();
export interface SharingTransactions { access<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> }

export function createSharingService(options: {
  transactions?: SharingTransactions; configuration?: () => ShareTokenConfiguration; createId?: () => string;
} = {}) {
  const transactions: SharingTransactions = options.transactions ?? {
    access: <T>(work: (tx: DbTransaction) => Promise<T>) => withSystemTransaction("course_access", work),
  };
  const configuration = options.configuration ?? requireShareTokenConfiguration;
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    list(actor: Actor, courseId: string) { return transactions.access((tx) => repository.listShares(tx, actor, courseId)); },
    resolve(actor: Actor | null, token: string) { return transactions.access((tx) => repository.resolveShare(tx, actor, token)); },
    async create(actor: Actor, courseId: string, value: CreateShareInput, key: string) {
      const id = IdSchema.safeParse(courseId), requestKey = IdSchema.safeParse(key), body = CreateShareInputSchema.safeParse(value);
      if (!id.success || !requestKey.success || !body.success) throw new ServiceFault(400, "invalid_input", "sharing.invalidInput");
      const config = configuration();
      const proposedGrantId = createId();
      const proposedToken = deriveShareToken(proposedGrantId, config.activeVersion, config);
      const receipt = await transactions.access(async (tx) => {
        const result = await executeIdempotentInTransaction(tx, actor, {
          operation: `course.share.create:${id.data}`, key: requestKey.data, body: body.data, parseResult: StoredShareReceiptSchema,
        }, async (same) => {
          const course = await lockOwnedCourse(same, actor, id.data);
          if (course.revision !== body.data.expectedCourseRevision) {
            throw new ServiceFault(409, "revision_conflict", "course.revisionConflict", false, { currentRevision: course.revision });
          }
          await repository.requireReadyVersion(same, course.id, body.data.courseVersionId);
          const updated = await same.query<{ revision: number }>(
            `UPDATE unfurl.courses SET visibility = CASE WHEN visibility = 'private' THEN 'unlisted' ELSE visibility END,
               revision = revision + 1, updated_at = now()
             WHERE id = $1 AND revision = $2 RETURNING revision`, [course.id, course.revision],
          );
          const revision = updated.rows[0]?.revision;
          if (!revision) throw new ServiceFault(409, "revision_conflict", "course.revisionConflict", false, { currentRevision: course.revision });
          await same.query(
            `INSERT INTO unfurl.share_grants
             (id, course_id, course_version_id, created_by, token_hash, token_key_version)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [proposedGrantId, course.id, body.data.courseVersionId, actor.id, hashShareToken(proposedToken), config.activeVersion],
          );
          return { status: 201, data: { grantId: proposedGrantId, keyVersion: config.activeVersion, courseRevision: revision } };
        });
        if (result.replayed) {
          await lockOwnedCourse(tx, actor, id.data);
          const grant = await repository.requireActiveGrant(tx, actor, id.data, result.data.grantId);
          if (grant.token_key_version !== result.data.keyVersion) throw new ServiceFault(409, "revision_conflict", "sharing.changed");
        }
        return result;
      });
      const token = deriveShareToken(receipt.data.grantId, receipt.data.keyVersion, config);
      return { status: receipt.status, replayed: receipt.replayed, data: ShareCreatedSchema.parse({
        shareId: receipt.data.grantId, shareUrl: sharePath(token), courseRevision: receipt.data.courseRevision,
      }) };
    },
    async revoke(actor: Actor, courseId: string, shareId: string) {
      const course = IdSchema.safeParse(courseId), grant = IdSchema.safeParse(shareId);
      if (!course.success || !grant.success) throw new ServiceFault(400, "invalid_input", "sharing.invalidInput");
      return transactions.access(async (tx) => {
        const lockedCourse = await lockOwnedCourse(tx, actor, course.data);
        const result = await tx.query<{ revoked_at: Date | string | null }>(
          "SELECT revoked_at FROM unfurl.share_grants WHERE id = $1 AND course_id = $2 AND created_by = $3 FOR UPDATE",
          [grant.data, course.data, actor.id],
        );
        const row = result.rows[0];
        if (!row) throw new ServiceFault(404, "not_found", "catalog.notFound");
        if (row.revoked_at === null) {
          await tx.query("UPDATE unfurl.share_grants SET revoked_at = now() WHERE id = $1", [grant.data]);
          await tx.query("UPDATE unfurl.courses SET revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2",
            [course.data, lockedCourse.revision]);
        }
      });
    },
  };
}

export const sharingService = createSharingService();
