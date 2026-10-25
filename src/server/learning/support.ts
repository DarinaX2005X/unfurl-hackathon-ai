import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { PersonalRouteSchema, SupportOfferSchema, type Enrollment, type PersonalRoute, type SupportOffer } from "@/domain/learning";
import { RouteRevisionInputSchema, SupportRequestSchema, SupportResponseInputSchema, SupportProposalSchema, SupportResultSchema } from "@/application/learning-port";
import type { Actor } from "@/server/auth/actor";
import type { DbTransaction } from "@/server/db";
import { ServiceFault } from "@/server/auth/errors";
import { executeIdempotentInTransaction } from "@/server/idempotency";
import { selectSupportMaterial } from "@/server/adaptation/material";
import { findSupportGapBasis, hasFreshSupportBasis, supportBasisDigest } from "@/server/adaptation/policy";
import type { LearningCommand, LearningTransactions } from "./service";
import { invalidLearningFields } from "./actions";
import * as repository from "./repository";

const supportReference = z.object({ offerId: IdSchema }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidLearningFields(result.error.issues);
  return result.data;
}
export function supportPositions(offer: SupportOffer): PersonalRoute["next"] {
  return [
    ...(offer.explanationBlock ? [{ lessonId: offer.explanationBlock.lessonId, taskId: null }] : []),
    ...offer.tasks.map(({ lessonId, taskId }) => ({ lessonId, taskId })),
  ].map((position) => ({ ...position, reasonCode: offer.reasonCode, basisEvidenceIds: offer.basisEvidenceIds }));
}
async function persistRoute(tx: DbTransaction, enrollment: Enrollment, route: PersonalRoute) {
  await tx.query("UPDATE unfurl.personal_routes SET revision=$2,document=$3::jsonb,updated_at=now() WHERE enrollment_id=$1", [enrollment.id, route.revision, JSON.stringify(route)]);
  await tx.query("UPDATE unfurl.enrollments SET route_revision=$2,current_lesson_id=$3,current_task_id=$4,last_studied_at=now() WHERE id=$1", [enrollment.id, route.revision, route.next[0]?.lessonId ?? null, route.next[0]?.taskId ?? null]);
}

/** Removes only this accepted offer's remaining prefix; it cannot restore a stale unrelated route. */
export async function returnSupportTx(tx: DbTransaction, enrollment: Enrollment, offer: SupportOffer, status: "returned" | "completed") {
  const route = await repository.requireRoute(tx, enrollment);
  const positions = supportPositions(offer);
  let cut = 0;
  while (cut < route.next.length && route.next[cut]?.reasonCode === offer.reasonCode) {
    const position = route.next[cut]!;
    if (!positions.some((entry) => entry.lessonId === position.lessonId && entry.taskId === position.taskId)) repository.invariant();
    cut++;
  }
  if (offer.status !== "accepted" || cut === 0 || route.next[cut]?.lessonId !== offer.returnPoint.lessonId || route.next[cut]?.taskId !== offer.returnPoint.taskId) repository.revisionConflict(route.revision, "learning.supportChanged");
  await tx.query("UPDATE unfurl.support_offers SET status=$2,updated_at=now() WHERE id=$1 AND status='accepted'", [offer.id, status]);
  await persistRoute(tx, enrollment, PersonalRouteSchema.parse({ ...route, revision: route.revision + 1, next: route.next.slice(cut) }));
}

export function createSupportOperations(transactions: LearningTransactions, createId: () => string) {
  async function result(tx: DbTransaction, actor: Actor, enrollmentId: string, offerId: string) {
    const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId);
    return SupportResultSchema.parse({ enrollment, offer: await repository.requireSupport(tx, enrollment, offerId), route: await repository.requireRoute(tx, enrollment) });
  }
  return {
    requestSupport(actor: Actor, enrollmentId: string, command: LearningCommand<z.infer<typeof SupportRequestSchema>>) {
      parse(IdSchema, enrollmentId); parse(IdSchema, command.key); const body = parse(SupportRequestSchema, command.body);
      return transactions.run(async (tx) => {
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        const reference = await executeIdempotentInTransaction(tx, actor, { operation: "learning.support.request", key: command.key, body: { enrollmentId, ...body }, parseResult: supportReference }, async () => {
          if (enrollment.routeRevision !== body.expectedRouteRevision) repository.revisionConflict(enrollment.routeRevision);
          const active = await repository.readSupport(tx, enrollment);
          if (active) return { status: 200, data: { offerId: active.id } };
          const route = await repository.requireRoute(tx, enrollment);
          if (enrollment.status !== "active" || !route.next[0] || route.next[0].reasonCode !== "course_sequence") repository.revisionConflict(route.revision, "learning.supportUnavailableHere");
          const program = await repository.loadProgram(tx, enrollment);
          if (!program.version.outcomes.some(({ id }) => id === body.targetOutcomeId)) throw invalidLearningFields([{ path: ["targetOutcomeId"], message: "Choose an outcome from this course." }]);
          const evidence = await repository.readEvidence(tx, enrollment);
          if (evidence.some((entry) => entry.outcomeId === body.targetOutcomeId && entry.reviewState === "contested")) throw new ServiceFault(409, "revision_conflict", "learning.reviewBeforeSupport", false);
          const material = selectSupportMaterial({ ...program, evidence, targetOutcomeId: body.targetOutcomeId, reasonCode: body.kind, currentTaskId: enrollment.currentTaskId });
          if (!material) throw new ServiceFault(503, "service_unavailable", "support.unavailable", false);
          const now = new Date().toISOString();
          const offer = SupportOfferSchema.parse({ id: createId(), enrollmentId, courseVersionId: enrollment.courseVersionId, policyVersion: "adaptation-v1",
            basedOnRouteRevision: route.revision, ...material, triggerKind: "user_request", reasonCode: body.kind, basisEvidenceIds: [],
            explanation: body.message ? `Requested help: ${body.message}` : "You requested a short optional activity for this course outcome.",
            returnPoint: { lessonId: route.next[0].lessonId, taskId: route.next[0].taskId }, status: "offered", createdAt: now, updatedAt: now });
          await insertSupportTx(tx, offer);
          return { status: 201, data: { offerId: offer.id } };
        });
        return { status: reference.status, data: SupportProposalSchema.parse({ offer: await repository.requireSupport(tx, enrollment, reference.data.offerId), route: await repository.requireRoute(tx, enrollment) }) };
      });
    },
    async respondToSupport(actor: Actor, enrollmentId: string, offerId: string, command: LearningCommand<z.infer<typeof SupportResponseInputSchema>>) {
      parse(IdSchema, enrollmentId); parse(IdSchema, offerId); parse(IdSchema, command.key); const body = parse(SupportResponseInputSchema, command.body);
      const outcome = await transactions.run(async (tx) => {
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        const offer = await repository.requireSupport(tx, enrollment, offerId);
        if (offer.status === "offered" && offer.basedOnRouteRevision !== enrollment.routeRevision) {
          await tx.query("UPDATE unfurl.support_offers SET status='superseded',updated_at=now() WHERE id=$1 AND status='offered'", [offer.id]);
          return { conflict: enrollment.routeRevision };
        }
        await executeIdempotentInTransaction(tx, actor, { operation: "learning.support.respond", key: command.key, body: { enrollmentId, offerId, ...body }, parseResult: supportReference }, async () => {
          if (enrollment.routeRevision !== body.expectedRouteRevision) repository.revisionConflict(enrollment.routeRevision);
          if (enrollment.status === "archived" || offer.status !== "offered") repository.revisionConflict(enrollment.routeRevision, "learning.supportChanged");
          const route = await repository.requireRoute(tx, enrollment);
          if (route.next[0]?.lessonId !== offer.returnPoint.lessonId || route.next[0]?.taskId !== offer.returnPoint.taskId) repository.invariant();
          await tx.query("UPDATE unfurl.support_offers SET status=$2,updated_at=now() WHERE id=$1", [offer.id, body.response === "accept" ? "accepted" : "declined"]);
          if (body.response === "accept") await persistRoute(tx, enrollment, PersonalRouteSchema.parse({ ...route, revision: route.revision + 1, next: [...supportPositions(offer), ...route.next] }));
          return { status: 200, data: { offerId } };
        });
        return { data: await result(tx, actor, enrollmentId, offerId) };
      });
      if ("conflict" in outcome) repository.revisionConflict(outcome.conflict!, "learning.supportSuperseded");
      return { status: 200 as const, data: outcome.data! };
    },
    returnFromSupport(actor: Actor, enrollmentId: string, offerId: string, command: LearningCommand<z.infer<typeof RouteRevisionInputSchema>>) {
      parse(IdSchema, enrollmentId); parse(IdSchema, offerId); parse(IdSchema, command.key); const body = parse(RouteRevisionInputSchema, command.body);
      return transactions.run(async (tx) => {
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        await executeIdempotentInTransaction(tx, actor, { operation: "learning.support.return", key: command.key, body: { enrollmentId, offerId, ...body }, parseResult: supportReference }, async () => {
          if (enrollment.routeRevision !== body.expectedRouteRevision || enrollment.status === "archived") repository.revisionConflict(enrollment.routeRevision);
          await returnSupportTx(tx, enrollment, await repository.requireSupport(tx, enrollment, offerId), "returned");
          return { status: 200, data: { offerId } };
        });
        return { status: 200 as const, data: await result(tx, actor, enrollmentId, offerId) };
      });
    },
  };
}

export async function insertSupportTx(tx: DbTransaction, offer: SupportOffer) {
  const digest = supportBasisDigest(offer);
  await tx.query(`INSERT INTO unfurl.support_offers(id,enrollment_id,course_version_id,policy_version,based_on_route_revision,target_outcome_id,target_dimension_ids,
    trigger_kind,reason_code,basis_evidence_ids,basis_digest,auto_basis_key,explanation,explanation_lesson_id,explanation_block_id,estimated_study_minutes,
    return_lesson_id,return_task_id,completion_task_id,completion_dimension_ids,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
  [offer.id, offer.enrollmentId, offer.courseVersionId, offer.policyVersion, offer.basedOnRouteRevision, offer.target.outcomeId, offer.target.dimensionIds,
    offer.triggerKind, offer.reasonCode, offer.basisEvidenceIds, digest, offer.triggerKind === "auto" ? digest : null, offer.explanation,
    offer.explanationBlock?.lessonId ?? null, offer.explanationBlock?.blockId ?? null, offer.estimatedStudyMinutes, offer.returnPoint.lessonId, offer.returnPoint.taskId,
    offer.completionCheck?.taskId ?? null, offer.completionCheck?.dimensionIds ?? [], offer.status, offer.createdAt, offer.updatedAt]);
  for (const [slot, task] of offer.tasks.entries()) await tx.query("INSERT INTO unfurl.support_offer_tasks(offer_id,slot,course_version_id,lesson_id,task_id,task_version) VALUES($1,$2,$3,$4,$5,$6)",
    [offer.id, slot, offer.courseVersionId, task.lessonId, task.taskId, task.taskVersion]);
}

/** Called only after confirmed new evidence; refusal, uncertainty and return do not manufacture gaps. */
export async function maybeOfferAutomaticSupportTx(tx: DbTransaction, enrollment: Enrollment, createId: () => string) {
  if (enrollment.status !== "active" || await repository.readSupport(tx, enrollment)) return;
  const route = await repository.requireRoute(tx, enrollment);
  if (!route.next[0] || route.next[0].reasonCode !== "course_sequence") return;
  const program = await repository.loadProgram(tx, enrollment);
  const evidence = await repository.readEvidence(tx, enrollment);
  for (const outcomeId of route.pendingOutcomeIds) {
    if (evidence.some((entry) => entry.outcomeId === outcomeId && entry.reviewState === "contested")) continue;
    const dimensions = [...new Set(program.tasks.flatMap(({ assessment }) => assessment.outcomes.filter((mapping) => mapping.outcomeId === outcomeId).flatMap((mapping) => mapping.dimensions.map(({ dimensionId }) => dimensionId))))];
    for (const dimensionId of dimensions) {
      const gap = findSupportGapBasis({ enrollmentId: enrollment.id, courseVersionId: enrollment.courseVersionId, outcomeId, dimensionId, evidence });
      if (!gap) continue;
      const previous = (await tx.query<{ task_id: string; evidence_group_id: string }>(`SELECT DISTINCT e.task_id,e.evidence_group_id FROM unfurl.support_offers s
        JOIN unfurl.learner_evidence e ON e.id=ANY(s.basis_evidence_ids) AND e.enrollment_id=s.enrollment_id
        WHERE s.enrollment_id=$1 AND s.target_outcome_id=$2 AND $3=ANY(s.target_dimension_ids) AND s.trigger_kind='auto'`, [enrollment.id, outcomeId, dimensionId])).rows;
      if (!hasFreshSupportBasis(evidence.filter((entry) => gap.basisEvidenceIds.includes(entry.id)), previous.map((row) => ({ taskId: row.task_id, evidenceGroupId: row.evidence_group_id })))) continue;
      const material = selectSupportMaterial({ ...program, evidence, targetOutcomeId: outcomeId, dimensionIds: [dimensionId], reasonCode: "additional_practice", currentTaskId: enrollment.currentTaskId });
      if (!material) continue;
      const now = new Date().toISOString();
      const offer = SupportOfferSchema.parse({ id: createId(), enrollmentId: enrollment.id, courseVersionId: enrollment.courseVersionId, policyVersion: "adaptation-v1",
        basedOnRouteRevision: route.revision, ...material, triggerKind: "auto", reasonCode: "additional_practice", basisEvidenceIds: gap.basisEvidenceIds,
        explanation: "Two different tasks still show a difficulty with this criterion, including one attempted after earlier feedback was acknowledged. This optional practice gives another way to work on it.",
        returnPoint: { lessonId: route.next[0].lessonId, taskId: route.next[0].taskId }, status: "offered", createdAt: now, updatedAt: now });
      const digest = supportBasisDigest(offer);
      if ((await tx.query("SELECT id FROM unfurl.support_offers WHERE enrollment_id=$1 AND auto_basis_key=$2", [enrollment.id, digest])).rowCount) continue;
      await insertSupportTx(tx, offer);
      return;
    }
  }
}
