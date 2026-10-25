import "server-only";
import { z } from "zod";
import { PublicObservationSchema, type PublicObservation } from "@/domain/activity";
import type { DbTransaction } from "@/server/db";
import type { RunContext, RunHandler } from "@/server/runs/ports";
import type { ModelPort } from "@/server/ai/ports";
import type { PythonExecutionPort } from "@/server/execution/python";
import { ExecutionResultSchema } from "@/server/execution/python/contracts";
import { jsonDigest } from "@/server/ai/json";
import { MODEL_ID } from "@/server/ai/constants";
import { createRubricJudge } from "@/server/ai/rubric-judge";
import { GradeDecisionSchema, type GradeDecision, type RubricJudge } from "@/server/evaluation/contracts";
import type { PythonEvaluationPort } from "@/server/execution/python";
import { getServerMechanic } from "@/server/mechanics/registry";
import { assertLearningJobAuthority, loadActionWork, loadEvaluationWork } from "./job-work";
import { commitSemanticEvaluationTx } from "./evaluation";
import { validateSubmittedActivity } from "./submission";
import { prepareActivityAction } from "./actions";
import { DialogueDraftSchema, auditDialogueDraft, generateDialogueDraft, prepareDialogueMaterial, verifiedDialogueObservation } from "./dialogue";
import * as repository from "./repository";
import { executeLearningPython, preparePythonGradeProgram, publicPythonObservation, storedPythonEvaluationPort } from "./python";

const resultSchema = z.object({ status: z.enum(["committed", "unavailable"]) }).strict();
const draftResultSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("draft"), draft: DialogueDraftSchema }).strict(), z.object({ status: z.literal("unavailable") }).strict()]);
const actionOutputSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("completed"), observation: PublicObservationSchema }).strict(), z.object({ status: z.literal("unavailable") }).strict()]);
const pythonStepSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("result"), execution: ExecutionResultSchema }).strict(), z.object({ status: z.literal("unavailable") }).strict()]);
const failureDecision = (): GradeDecision => ({ status: "unavailable", outcome: null, dimensions: [], feedback: { explanation: "Assessment could not finish. Your saved response is retained for retry.", nextAction: "wait" } });
const digests = (task: { mechanicId: string; mechanicVersion: number; responseSchemaVersion: number }) => ({
  schema: jsonDigest({ mechanicId: task.mechanicId, mechanicVersion: task.mechanicVersion, responseSchemaVersion: task.responseSchemaVersion }),
  capability: jsonDigest({ model: MODEL_ID, pythonProfile: "python_stdlib_v1" }), validationPolicy: jsonDigest("learning-worker-v1"), approval: null,
});
const statuses = (value: unknown) => JSON.stringify(z.array(z.object({ id: z.string(), status: z.string() }).passthrough()).parse(value).map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id)));
async function stepSucceeded(context: RunContext, key: string) {
  return context.read(async (tx) => (await tx.query("SELECT id FROM unfurl.run_steps WHERE job_id=$1 AND step_key=$2 AND status='succeeded'", [context.claim.jobId, key])).rowCount === 1);
}
async function unavailableEvaluation(tx: DbTransaction, target: Extract<RunContext["claim"]["target"], { kind: "evaluation" }>, decision = failureDecision()) {
  const current = await loadEvaluationWork(tx, target);
  if (current.review) await tx.query("UPDATE unfurl.assessment_review_requests SET status='unavailable',updated_at=now() WHERE id=$1 AND status IN ('queued','running','unavailable')", [current.review.id]);
  else await tx.query("UPDATE unfurl.evaluations SET status='unavailable',dimensions=$2::jsonb,feedback=$3::jsonb,updated_at=now() WHERE id=$1 AND revision=1 AND status IN ('pending','unavailable')", [current.evaluationId, JSON.stringify(decision.dimensions), JSON.stringify(decision.feedback)]);
}

async function commitAction(tx: DbTransaction, context: RunContext, observation: PublicObservation | null) {
  if (context.claim.target.kind !== "activity_action") repository.invariant();
  const work = await loadActionWork(tx, context.claim.target);
  if (work.status === "completed") return { status: "committed" as const };
  const revision = work.currentSessionRevision + 1;
  await tx.query("UPDATE unfurl.activity_actions SET status=$2,public_observation=$3::jsonb,completed_session_revision=$4,updated_at=now() WHERE id=$1 AND status IN ('pending','unavailable')",
    [work.actionId, observation === null ? "unavailable" : "completed", observation === null ? null : JSON.stringify(observation), revision]);
  await tx.query("UPDATE unfurl.activity_sessions SET revision=$2,updated_at=now() WHERE id=$1", [work.sessionId, revision]);
  return { status: observation === null ? "unavailable" as const : "committed" as const };
}

/** Registered by the one durable runtime; no queue, lease loop or detached provider work lives here. */
export function createLearningRunHandlers(dependencies: { model: ModelPort; python?: PythonExecutionPort }): readonly RunHandler[] {
  const evaluation: RunHandler = {
    kind: "evaluation", version: "learning-evaluation-v1", assertAuthority: assertLearningJobAuthority,
    async advance(context) {
      if (context.claim.target.kind !== "evaluation") repository.invariant();
      const target = context.claim.target;
      const work = await context.read((tx) => loadEvaluationWork(tx, target));
      if (work.currentRevision === work.revision && ["evaluated", "uncertain"].includes(work.currentStatus)) return { status: "succeeded" };
      let python: PythonEvaluationPort | null = null;
      if (work.task.mechanicVersion === 3) {
        const program = preparePythonGradeProgram(work.task, work.privateTask, work.activity.input.response);
        const key = `python-grade:${context.claim.retryEpoch}`, existed = await stepSucceeded(context, key);
        const executed = await context.step({ key, input: { attemptId: work.attemptId, programDigest: jsonDigest(program) }, digests: digests(work.task), outputSchema: pythonStepSchema, resultSchema: pythonStepSchema,
          async effect(effect) {
            if (!dependencies.python) return { status: "unavailable" as const };
            try { return { status: "result" as const, execution: await executeLearningPython(dependencies.python, { claim: context.claim, effect, enrollment: work.enrollment,
              task: work.task, input: work.activity.input, program, target: { kind: "attempt", attemptId: work.attemptId } }) }; }
            catch { return { status: "unavailable" as const }; }
          },
          async commit(tx, output) { if (output.status === "unavailable" || output.execution.status === "unavailable") await unavailableEvaluation(tx, target); return output; } });
        if (executed.status === "unavailable" || executed.execution.status === "unavailable") return { status: "awaiting_user" };
        if (!existed) return { status: "continue" };
        python = storedPythonEvaluationPort(program, executed.execution);
      }
      const result = await context.step({ key: `grade:${context.claim.retryEpoch}`, input: { evaluationId: work.evaluationId, attemptId: work.attemptId,
        revision: work.revision, responseDigest: work.activity.input.responseDigest,
        reviewDigest: work.review ? jsonDigest({ id: work.review.id, reason: work.review.reason, comment: work.review.comment }) : null },
      digests: digests(work.task), outputSchema: GradeDecisionSchema, resultSchema,
      async effect(effect) {
        try {
          const handle = getServerMechanic(work.task.mechanicId, work.task.mechanicVersion) ?? repository.invariant();
          const response = await validateSubmittedActivity(work.task, work.activity.input.response, work.activity);
          const base = createRubricJudge(dependencies.model, { budget: effect.budgetOperation("rubric", 1), deadlineAt: effect.deadlineAt });
          const model: RubricJudge = work.review ? { judge(request, signal) {
            if (!request.context) return base.judge(request, signal);
            return base.judge({ ...request, context: { ...request.context, referenceFacts: { original: request.context.referenceFacts ?? null,
              assessmentReview: { reason: work.review!.reason, comment: work.review!.comment } } } }, signal);
          } } : base;
          return GradeDecisionSchema.parse(await handle.evaluate({ task: work.task, response, privateData: handle.parsePrivate(work.privateTask.evaluatorData), activity: work.activity }, { model, python, signal: effect.signal }));
        } catch { return failureDecision(); }
      },
      async commit(tx, decision) {
        const current = await loadEvaluationWork(tx, target);
        if (current.currentRevision === current.revision && ["evaluated", "uncertain"].includes(current.currentStatus)) return { status: "committed" as const };
        if (decision.status === "unavailable") {
          await unavailableEvaluation(tx, target, decision);
          return { status: "unavailable" as const };
        }
        await commitSemanticEvaluationTx(tx, { ...current, decision }, () => crypto.randomUUID());
        if (current.review) {
          const resolution = decision.status === "uncertain" ? "uncertain" : current.currentOutcome === decision.outcome && statuses(current.currentDimensions) === statuses(decision.dimensions) ? "upheld" : "corrected";
          await tx.query("UPDATE unfurl.assessment_review_requests SET status='resolved',resolution=$2,resolved_evaluation_revision=$3,resolved_at=now(),updated_at=now() WHERE id=$1", [current.review.id, resolution, current.revision]);
        }
        return { status: "committed" as const };
      } });
      return { status: result.status === "unavailable" ? "awaiting_user" : "succeeded" };
    },
  };
  const action: RunHandler = {
    kind: "activity_action", version: "learning-action-v1", assertAuthority: assertLearningJobAuthority,
    async advance(context) {
      if (context.claim.target.kind !== "activity_action") repository.invariant();
      const target = context.claim.target;
      const work = await context.read((tx) => loadActionWork(tx, target));
      if (work.status === "completed") return { status: "succeeded" };
      const prepared = await prepareActivityAction({ task: work.task, privateTask: work.privateTask, activity: work.activity,
        request: { expectedRevision: work.activity.session.revision, inputRevision: work.activity.input.inputRevision, responseDigest: work.activity.input.responseDigest, clientActionId: work.clientActionId, action: work.action } });
      const input = { actionId: work.actionId, responseDigest: work.activity.input.responseDigest };
      if (prepared.execution.kind !== "dialogue") {
        const result = await context.step({ key: `action:${context.claim.retryEpoch}`, input, digests: digests(work.task), outputSchema: actionOutputSchema, resultSchema,
          async effect(effect) {
            if (prepared.execution.kind === "deterministic" && prepared.execution.observation !== null) return { status: "completed" as const, observation: prepared.execution.observation };
            if (prepared.execution.kind === "python" && dependencies.python) {
              try {
                const executed = await executeLearningPython(dependencies.python, { claim: context.claim, effect, enrollment: work.enrollment,
                  task: work.task, input: work.activity.input, program: prepared.execution, target: { kind: "activity_action", activityActionId: work.actionId } });
                const observation = publicPythonObservation(work.task, prepared.execution, executed);
                if (observation) return { status: "completed" as const, observation };
              } catch { /* Provider failure remains an unavailable reserved action. */ }
            }
            return { status: "unavailable" as const };
          },
          commit: (tx, output) => commitAction(tx, context, output.status === "completed" ? output.observation : null) });
        return { status: result.status === "unavailable" ? "awaiting_user" : "succeeded" };
      }
      if (work.action.kind !== "dialogue.turn") repository.invariant();
      const material = await prepareDialogueMaterial(work.task, work.privateTask, work.activity, work.action.text);
      const draftKey = `dialogue-draft:${context.claim.retryEpoch}`;
      const hadDraft = await stepSucceeded(context, draftKey);
      const draft = await context.step({ key: draftKey, input, digests: digests(work.task), outputSchema: draftResultSchema, resultSchema: draftResultSchema,
        async effect(effect) {
          try { return { status: "draft" as const, draft: await generateDialogueDraft(dependencies.model, { budget: effect.budgetOperation("dialogue", 1), deadlineAt: effect.deadlineAt }, material, effect.signal) }; }
          catch { return { status: "unavailable" as const }; }
        },
        async commit(tx, output) { if (output.status === "unavailable") await commitAction(tx, context, null); return output; } });
      if (draft.status === "unavailable") return { status: "awaiting_user" };
      if (!hadDraft) return { status: "continue" };
      const result = await context.step({ key: `dialogue-audit:${context.claim.retryEpoch}`, input: { ...input, draftDigest: jsonDigest(draft.draft) }, digests: digests(work.task), outputSchema: actionOutputSchema, resultSchema,
        async effect(effect) {
          try {
            const audit = await auditDialogueDraft(dependencies.model, { budget: effect.budgetOperation("dialogue-audit", 1), deadlineAt: effect.deadlineAt }, material, draft.draft, effect.signal);
            return { status: "completed" as const, observation: verifiedDialogueObservation(material, draft.draft, audit) };
          } catch { return { status: "unavailable" as const }; }
        },
        commit: (tx, output) => commitAction(tx, context, output.status === "completed" ? output.observation : null) });
      return { status: result.status === "unavailable" ? "awaiting_user" : "succeeded" };
    },
  };
  return [evaluation, action];
}
