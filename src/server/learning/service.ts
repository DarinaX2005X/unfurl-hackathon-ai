import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { ActivityActionRequestSchema, SaveActivityInputSchema, canonicalResponseJson, responseDigest,
  type ActivityActionRequest, type SaveActivityInput } from "@/domain/activity";
import { PersonalRouteSchema, type Enrollment } from "@/domain/learning";
import { ActionRetryInputSchema, StartActivityInputSchema, RouteRevisionInputSchema, RevisitInputSchema,
  type ActivityActionResult, type ActivityState } from "@/application/learning-port";
import { LearningContextQuerySchema, type LearningContextQuery } from "@/application/learning-port";
import type { Actor } from "@/server/auth/actor";
import { ServiceFault } from "@/server/auth/errors";
import { withSystemTransaction, type DbTransaction } from "@/server/db";
import { executeIdempotentInTransaction, requestDigest, type MutationReceipt } from "@/server/idempotency";
import { getServerMechanic } from "@/server/mechanics/registry";
import { enqueueLearningJobTx } from "@/server/runs/enqueue";
import { prepareActivityAction, invalidLearningFields, activityBudgetLimit } from "./actions";
import { projectLearningSession } from "./projection";
import { createInitialLearningRoute } from "./initial-route";
import { createAssistanceOperations } from "./assistance";
import { projectLearningContext } from "./context";
import { createAttemptOperations } from "./attempts";
import { createSupportOperations } from "./support";
import { activateLearningJob, type LearningAdmission } from "./queue";
import { createReviewOperations } from "./reviews";
import * as repository from "./repository";

export interface LearningTransactions { run<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> }
export interface LearningServiceDependencies { transactions?: LearningTransactions; createId?: () => string; admission?: LearningAdmission }
export type LearningCommand<T> = { key: string; body: T };
const activityReference = z.object({ activitySessionId: IdSchema }).strict();
const actionReference = activityReference.extend({ receiptId: IdSchema }).strict();
const actionRetryReference = actionReference.extend({ retryEpoch: z.number().int().nonnegative().nullable() }).strict();
const enrollmentReference = z.object({ enrollmentId: IdSchema }).strict();
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw invalidLearningFields(result.error.issues);
  return result.data;
}
function writable(enrollment: Enrollment, review = false): void {
  if (enrollment.status === "archived" || (enrollment.status === "completed" && !review)) repository.revisionConflict(enrollment.routeRevision, "learning.enrollmentInactive");
}
async function currentTask(tx: DbTransaction, enrollment: Enrollment, taskId: string, taskVersion: number) {
  return repository.requireCurrentTask(tx, enrollment, taskId, taskVersion);
}

export function createLearningService(dependencies: LearningServiceDependencies = {}) {
  const transactions = dependencies.transactions ?? { run: <T>(work: (tx: DbTransaction) => Promise<T>) => withSystemTransaction("learning_activity", work) };
  const createId = dependencies.createId ?? (() => crypto.randomUUID());

  return {
    ...createAssistanceOperations(transactions, createId),
    ...createAttemptOperations(transactions, createId, dependencies.admission),
    ...createSupportOperations(transactions, createId),
    ...createReviewOperations(transactions, createId, dependencies.admission),
    loadContext(actor: Actor, enrollmentId: string, query: LearningContextQuery = {}) {
      parsed(IdSchema, enrollmentId);
      const value = parsed(LearningContextQuerySchema, query);
      return transactions.run(async (tx) => projectLearningContext(tx, await repository.requireEnrollment(tx, actor, enrollmentId), value));
    },
    loadSession(actor: Actor, enrollmentId: string) {
      parsed(IdSchema, enrollmentId);
      return transactions.run(async (tx) => projectLearningSession(tx, await repository.requireEnrollment(tx, actor, enrollmentId)));
    },
    getActivity(actor: Actor, activityId: string) {
      parsed(IdSchema, activityId);
      return transactions.run(async (tx) => {
        const enrollmentId = await repository.activityEnrollmentId(tx, actor, activityId);
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId);
        return repository.readActivity(tx, enrollment, activityId);
      });
    },
    startActivity(actor: Actor, enrollmentId: string, command: LearningCommand<z.infer<typeof StartActivityInputSchema>>) {
      parsed(IdSchema, enrollmentId); parsed(IdSchema, command.key);
      const body = parsed(StartActivityInputSchema, command.body);
      return transactions.run(async (tx): Promise<MutationReceipt<ActivityState>> => {
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        const receipt = await executeIdempotentInTransaction(tx, actor, { operation: "learning.activity.start", key: command.key,
          body: { enrollmentId, ...body }, parseResult: activityReference }, async () => {
          const task = await currentTask(tx, enrollment, body.taskId, body.taskVersion);
          const existing = await repository.findActivity(tx, enrollment, body.taskId, body.taskVersion);
          if (existing) return { status: 200, data: { activitySessionId: existing.activity.id } };
          const id = createId();
          await tx.query(`INSERT INTO unfurl.activity_sessions
            (id,enrollment_id,task_id,task_version,hidden_state,action_budget,actions_used,status,revision,input_revision)
            VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,0,'active',1,0)`, [id, enrollment.id, body.taskId, body.taskVersion, activityBudgetLimit(task)]);
          return { status: 201, data: { activitySessionId: id } };
        });
        return { status: receipt.status, data: await repository.readActivity(tx, enrollment, receipt.data.activitySessionId) };
      });
    },
    saveInput(actor: Actor, activityId: string, command: LearningCommand<SaveActivityInput>) {
      parsed(IdSchema, activityId); parsed(IdSchema, command.key);
      const body = parsed(SaveActivityInputSchema, command.body);
      return transactions.run(async (tx): Promise<MutationReceipt<ActivityState>> => {
        const enrollmentId = await repository.activityEnrollmentId(tx, actor, activityId);
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        const receipt = await executeIdempotentInTransaction(tx, actor, { operation: "learning.activity.save", key: command.key,
          body: { activityId, ...body }, parseResult: activityReference }, async () => {
          const state = await repository.readActivity(tx, enrollment, activityId, true);
          const task = await currentTask(tx, enrollment, state.activity.taskId, state.activity.taskVersion);
          if (state.activity.inputRevision !== body.expectedInputRevision) {
            throw new ServiceFault(409, "revision_conflict", "learning.inputChanged", false, { fieldErrors: { "/expectedInputRevision": `Current saved input revision is ${state.activity.inputRevision}.` } });
          }
          const mechanic = getServerMechanic(task.mechanicId, task.mechanicVersion);
          if (!mechanic) throw new ServiceFault(503, "service_unavailable", "learning.mechanicUnavailable", false);
          let response;
          try { response = mechanic.parseResponse(body.response); }
          catch (error) { if (error instanceof z.ZodError) throw invalidLearningFields(error.issues); throw error; }
          const digest = await responseDigest(response);
          const storedBytes = (await tx.query<{ size: number }>("SELECT octet_length($1::jsonb::text) AS size", [canonicalResponseJson(response)])).rows[0]?.size;
          if (storedBytes === undefined || storedBytes > 131_072) throw invalidLearningFields([{ path: ["response"], message: "The stored response exceeds 128 KiB." }]);
          const revision = state.activity.inputRevision + 1;
          await tx.query("INSERT INTO unfurl.activity_inputs(activity_session_id,input_revision,response_digest,response) VALUES($1,$2,$3,$4::jsonb)", [activityId, revision, digest, canonicalResponseJson(response)]);
          await tx.query("UPDATE unfurl.activity_sessions SET input_revision=$2,updated_at=now() WHERE id=$1", [activityId, revision]);
          return { status: 200, data: { activitySessionId: activityId } };
        });
        return { status: 200, data: await repository.readActivity(tx, enrollment, receipt.data.activitySessionId) };
      });
    },
    async dispatchAction(actor: Actor, activityId: string, command: LearningCommand<ActivityActionRequest>) {
      parsed(IdSchema, activityId); parsed(IdSchema, command.key);
      const body = parsed(ActivityActionRequestSchema, command.body);
      const accepted = await transactions.run(async (tx): Promise<MutationReceipt<ActivityActionResult>> => {
        const enrollmentId = await repository.activityEnrollmentId(tx, actor, activityId);
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        const result = await executeIdempotentInTransaction(tx, actor, { operation: "learning.activity.action", key: command.key,
          body: { activityId, ...body }, parseResult: actionReference }, async () => {
          const state = await repository.readActivity(tx, enrollment, activityId, true);
          const digest = requestDigest(body);
          const existing = (await tx.query<{ id: string; request_digest: string }>("SELECT id,request_digest FROM unfurl.activity_actions WHERE activity_session_id=$1 AND client_action_id=$2", [activityId, body.clientActionId])).rows[0];
          if (existing) {
            if (existing.request_digest !== digest) throw new ServiceFault(409, "idempotency_conflict", "request.idempotencyConflict");
            return { status: 200, data: { activitySessionId: activityId, receiptId: existing.id } };
          }
          const task = await currentTask(tx, enrollment, state.activity.taskId, state.activity.taskVersion);
          const privateTask = await repository.loadPrivateTask(tx, enrollment, task.id, task.taskVersion);
          const activity = await repository.authoritativeActivity(tx, enrollment, state);
          const prepared = await prepareActivityAction({ task, privateTask, activity, request: body });
          const synchronous = prepared.execution.kind === "deterministic";
          const receiptId = createId(), reservationRevision = state.activity.revision + 1, terminalRevision = reservationRevision + 1;
          await tx.query(`INSERT INTO unfurl.activity_actions
            (id,activity_session_id,client_action_id,request_digest,action,input_revision,response_digest,session_revision,completed_session_revision,status,public_observation)
            VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)`,
          [receiptId, activityId, body.clientActionId, digest, JSON.stringify(prepared.action), body.inputRevision, body.responseDigest,
            reservationRevision, terminalRevision, synchronous ? "completed" : "unavailable",
            prepared.execution.kind !== "deterministic" || prepared.execution.observation === null ? null : JSON.stringify(prepared.execution.observation)]);
          await tx.query(`UPDATE unfurl.activity_sessions SET actions_used=actions_used+$2,revision=$3,updated_at=now(),
            status=CASE WHEN actions_used+$2>=action_budget THEN 'budget_exhausted' ELSE 'active' END WHERE id=$1`, [activityId, prepared.cost, terminalRevision]);
          if (!synchronous) await enqueueLearningJobTx(tx, { kind: "activity_action", activityActionId: receiptId }, { dispatch: false });
          return { status: 200, data: { activitySessionId: activityId, receiptId } };
        });
        const state = await repository.readActivity(tx, enrollment, result.data.activitySessionId);
        const receipt = state.activity.events.find((event) => event.receipt.id === result.data.receiptId)?.receipt ?? repository.invariant();
        return { status: receipt.status === "pending" ? 202 : 200, data: { ...state, receipt } };
      });
      if (accepted.data.receipt.status !== "unavailable" || !await activateLearningJob(transactions, dependencies.admission, actor,
        { kind: "activity_action", activityActionId: accepted.data.receipt.id }, null)) return accepted;
      return transactions.run(async (tx): Promise<MutationReceipt<ActivityActionResult>> => {
        const enrollmentId = await repository.activityEnrollmentId(tx, actor, activityId);
        const state = await repository.readActivity(tx, await repository.requireEnrollment(tx, actor, enrollmentId), activityId);
        const receipt = state.activity.events.find((event) => event.receipt.id === accepted.data.receipt.id)!.receipt;
        return { status: receipt.status === "pending" ? 202 : 200, data: { ...state, receipt } };
      });
    },
    async retryAction(actor: Actor, activityId: string, receiptId: string, command: LearningCommand<z.infer<typeof ActionRetryInputSchema>>) {
      parsed(IdSchema, activityId); parsed(IdSchema, receiptId); parsed(IdSchema, command.key);
      const body = parsed(ActionRetryInputSchema, command.body);
      const accepted = await transactions.run(async (tx) => {
        const enrollmentId = await repository.activityEnrollmentId(tx, actor, activityId);
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        return executeIdempotentInTransaction(tx, actor, { operation: "learning.activity.retry", key: command.key,
          body: { activityId, receiptId, ...body }, parseResult: actionRetryReference }, async () => {
          const state = await repository.readActivity(tx, enrollment, activityId, true);
          const receipt = state.activity.events.find((event) => event.receipt.id === receiptId)?.receipt ?? repository.notFound();
          if (receipt.status === "unavailable") {
            if (state.activity.revision !== body.expectedRevision) repository.revisionConflict(state.activity.revision, "learning.activityChanged");
            const job = (await tx.query<{ retry_epoch: number }>("SELECT retry_epoch FROM unfurl.execution_jobs WHERE activity_action_id=$1", [receiptId])).rows[0] ?? repository.invariant();
            return { status: 200, data: { activitySessionId: activityId, receiptId, retryEpoch: job.retry_epoch } };
          }
          return { status: receipt.status === "pending" ? 202 : 200, data: { activitySessionId: activityId, receiptId, retryEpoch: null } };
        });
      });
      if (accepted.data.retryEpoch !== null) await activateLearningJob(transactions, dependencies.admission, actor,
        { kind: "activity_action", activityActionId: receiptId }, { retryReceiptId: command.key, expectedRetryEpoch: accepted.data.retryEpoch });
      return transactions.run(async (tx): Promise<MutationReceipt<ActivityActionResult>> => {
        const enrollmentId = await repository.activityEnrollmentId(tx, actor, activityId);
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId);
        const state = await repository.readActivity(tx, enrollment, activityId);
        const receipt = state.activity.events.find((event) => event.receipt.id === receiptId)!.receipt;
        return { status: receipt.status === "pending" ? 202 : 200, data: { ...state, receipt } };
      });
    },
    advance(actor: Actor, enrollmentId: string, command: LearningCommand<z.infer<typeof RouteRevisionInputSchema>>) {
      parsed(IdSchema, enrollmentId); parsed(IdSchema, command.key);
      const body = parsed(RouteRevisionInputSchema, command.body);
      return transactions.run(async (tx) => {
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        await executeIdempotentInTransaction(tx, actor, { operation: "learning.advance", key: command.key,
          body: { enrollmentId, ...body }, parseResult: enrollmentReference }, async () => {
          if (enrollment.routeRevision !== body.expectedRouteRevision) repository.revisionConflict(enrollment.routeRevision);
          const session = await projectLearningSession(tx, enrollment);
          const position = session.route.next[0];
          writable(enrollment, position?.reasonCode === "scheduled_review");
          if (!position || !session.lesson) repository.revisionConflict(enrollment.routeRevision, "learning.noNextPosition");
          const inSupport = position.reasonCode !== "course_sequence" && position.reasonCode !== "scheduled_review";
          if (inSupport && (session.support?.status !== "accepted" || session.support.reasonCode !== position.reasonCode ||
            session.support.tasks.at(-1)?.taskId === position.taskId || (session.support.tasks.length === 0))) {
            throw new ServiceFault(409, "revision_conflict", "learning.supportReturnRequired", false, { currentRevision: enrollment.routeRevision });
          }
          if (session.task) {
            const attempt = session.activity ? await repository.latestTaskAttempt(tx, enrollment, session.activity) : null;
            if (!attempt || attempt.activity_input_revision !== session.activity?.inputRevision || !session.evaluation ||
              !["evaluated", "uncertain"].includes(session.evaluation.evaluation.status)) repository.revisionConflict(enrollment.routeRevision, "learning.feedbackRequired");
          }
          const remaining = session.route.next.slice(1);
          if (position.reasonCode === "course_sequence" && !remaining.some((item) => item.lessonId === position.lessonId && item.reasonCode === "course_sequence")) {
            const program = await repository.loadProgram(tx, enrollment);
            const normal = createInitialLearningRoute({ enrollmentId, ...program }).route.next.filter((item) => item.lessonId === position.lessonId && item.taskId !== null);
            for (const item of normal) {
              const candidate = program.tasks.find(({ task }) => task.id === item.taskId)!.task;
              const state = await repository.findActivity(tx, enrollment, candidate.id, candidate.taskVersion);
              const attempt = state ? await repository.latestTaskAttempt(tx, enrollment, state.activity) : null;
              const evaluation = attempt ? await repository.readEvaluation(tx, enrollment, attempt.id) : null;
              if (!evaluation || !["evaluated", "uncertain"].includes(evaluation.evaluation.status)) repository.revisionConflict(enrollment.routeRevision, "learning.feedbackRequired");
            }
            await tx.query(`INSERT INTO unfurl.enrollment_lesson_traversal(enrollment_id,course_version_id,lesson_id)
              VALUES($1,$2,$3) ON CONFLICT(enrollment_id,lesson_id) DO NOTHING`, [enrollmentId, enrollment.courseVersionId, position.lessonId]);
          }
          const route = PersonalRouteSchema.parse({ ...session.route, revision: session.route.revision + 1, next: remaining });
          const program = await repository.loadProgram(tx, enrollment);
          const traversed = new Set((await tx.query<{ lesson_id: string }>("SELECT lesson_id FROM unfurl.enrollment_lesson_traversal WHERE enrollment_id=$1 AND course_version_id=$2", [enrollmentId, enrollment.courseVersionId])).rows.map(({ lesson_id }) => lesson_id));
          const completed = remaining.length === 0 && route.pendingOutcomeIds.length === 0 && program.version.lessonIds.every((id) => traversed.has(id));
          await tx.query("UPDATE unfurl.personal_routes SET revision=$2,document=$3::jsonb,updated_at=now() WHERE enrollment_id=$1", [enrollmentId, route.revision, JSON.stringify(route)]);
          await tx.query(`UPDATE unfurl.enrollments SET route_revision=$2,current_lesson_id=$3,current_task_id=$4,last_studied_at=now(),
            status=CASE WHEN $5::boolean THEN 'completed' ELSE 'active' END WHERE id=$1`,
          [enrollmentId, route.revision, remaining[0]?.lessonId ?? null, remaining[0]?.taskId ?? null, completed]);
          return { status: 200, data: { enrollmentId } };
        });
        return { status: 200 as const, data: await projectLearningSession(tx, await repository.requireEnrollment(tx, actor, enrollmentId)) };
      });
    },
    revisit(actor: Actor, enrollmentId: string, command: LearningCommand<z.infer<typeof RevisitInputSchema>>) {
      parsed(IdSchema, enrollmentId); parsed(IdSchema, command.key);
      const body = parsed(RevisitInputSchema, command.body);
      return transactions.run(async (tx) => {
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        await executeIdempotentInTransaction(tx, actor, { operation: "learning.revisit", key: command.key,
          body: { enrollmentId, ...body }, parseResult: enrollmentReference }, async () => {
          writable(enrollment, true);
          if (enrollment.routeRevision !== body.expectedRouteRevision) repository.revisionConflict(enrollment.routeRevision);
          const route = await repository.requireRoute(tx, enrollment);
          if (route.next.some(({ reasonCode }) => reasonCode === "scheduled_review") || await repository.readSupport(tx, enrollment)) {
            repository.revisionConflict(enrollment.routeRevision, "learning.returnBeforeRevisit");
          }
          const program = await repository.loadProgram(tx, enrollment);
          const initial = createInitialLearningRoute({ enrollmentId, ...program });
          const position = initial.route.next.find(({ lessonId, taskId }) => lessonId === body.lessonId && taskId === body.taskId);
          const traversed = (await tx.query("SELECT lesson_id FROM unfurl.enrollment_lesson_traversal WHERE enrollment_id=$1 AND course_version_id=$2 AND lesson_id=$3", [enrollmentId, enrollment.courseVersionId, body.lessonId])).rows[0];
          if (!position || !traversed) throw new ServiceFault(403, "forbidden", "learning.revisitNotAvailable");
          const revised = PersonalRouteSchema.parse({ ...route, revision: route.revision + 1,
            next: [{ ...position, reasonCode: "scheduled_review", basisEvidenceIds: [] }, ...route.next] });
          await tx.query("UPDATE unfurl.personal_routes SET revision=$2,document=$3::jsonb,updated_at=now() WHERE enrollment_id=$1", [enrollmentId, revised.revision, JSON.stringify(revised)]);
          await tx.query("UPDATE unfurl.enrollments SET route_revision=$2,current_lesson_id=$3,current_task_id=$4,last_studied_at=now() WHERE id=$1", [enrollmentId, revised.revision, position.lessonId, position.taskId]);
          return { status: 200, data: { enrollmentId } };
        });
        return { status: 200 as const, data: await projectLearningSession(tx, await repository.requireEnrollment(tx, actor, enrollmentId)) };
      });
    },
  };
}
export const learningService = createLearningService();
