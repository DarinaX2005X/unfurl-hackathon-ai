import "server-only";
import type { Enrollment } from "@/domain/learning";
import type { TaskPrivate, TaskPublic } from "@/domain/mechanics";
import type { InputIdentity } from "@/domain/activity";
import type { JsonValue } from "@/domain/common";
import { PythonArtifactConfigSchema, PythonArtifactResponseSchema, PythonRepairConfigSchema, PythonRepairResponseSchema,
  parseExecutionValue, parsePythonPublicObservation, type ExecutionJson } from "@/domain/mechanic-families/v3/python";
import { PythonArtifactPrivateSchema, PythonRepairPrivateSchema } from "@/server/evaluation/python";
import { buildPythonExecutionRequest, type ExecutionResult, type PythonEvaluationPort, type PythonExecutionPort } from "@/server/execution/python";
import { validateExecutionResult } from "@/server/execution/python/contracts";
import { stableExecutionId } from "@/server/runs/identity";
import type { JobClaim, StepEffectContext } from "@/server/runs/ports";
import { canonicalJson } from "@/server/ai/json";

export type LearningPythonProgram = { source: string; cases: Array<{ id: string; input: ExecutionJson }> };
export function preparePythonGradeProgram(task: TaskPublic, privateTask: TaskPrivate, response: JsonValue): LearningPythonProgram {
  const config = task.mechanicId === "artifact_construction" ? PythonArtifactConfigSchema.parse(task.config) : PythonRepairConfigSchema.parse(task.config);
  const answer = task.mechanicId === "artifact_construction" ? PythonArtifactResponseSchema.parse(response) : PythonRepairResponseSchema.parse(response);
  const data = task.mechanicId === "artifact_construction" ? PythonArtifactPrivateSchema.parse(privateTask.evaluatorData) : PythonRepairPrivateSchema.parse(privateTask.evaluatorData);
  for (const entry of data.hiddenCases) { parseExecutionValue(config.inputShape, entry.input); parseExecutionValue(config.outputShape, entry.expected); }
  return { source: answer.source, cases: data.hiddenCases.map(({ id, input }) => ({ id, input })) };
}

/** One isolated execution; identity is fixed for this job epoch and cannot be renewed by a crash. */
export async function executeLearningPython(port: PythonExecutionPort, input: {
  claim: JobClaim; effect: StepEffectContext; enrollment: Enrollment; task: TaskPublic; input: InputIdentity;
  program: LearningPythonProgram; target: { kind: "activity_action"; activityActionId: string } | { kind: "attempt"; attemptId: string };
}): Promise<ExecutionResult> {
  const purpose = input.target.kind === "activity_action" ? "public_run" : "grade";
  const targetId = input.target.kind === "activity_action" ? input.target.activityActionId : input.target.attemptId;
  const logicalExecutionId = stableExecutionId(input.claim.jobId, `python:${input.claim.retryEpoch}:${purpose}:${targetId}`);
  const common = {
    executionId: stableExecutionId(logicalExecutionId, "execution:1"), logicalExecutionId, executionAttempt: 1, retryOfExecutionId: null,
    idempotencyKey: stableExecutionId(logicalExecutionId, "idempotency:1"),
    job: { jobId: input.claim.jobId, leaseOwner: input.claim.leaseOwner, fencingToken: input.claim.fencingToken, retryEpoch: input.claim.retryEpoch },
    authority: { kind: "learning" as const, learnerId: input.enrollment.learnerId, enrollmentId: input.enrollment.id,
      courseVersionId: input.enrollment.courseVersionId, taskId: input.task.id, taskVersion: input.task.taskVersion },
    input: { kind: "learning" as const, activitySessionId: input.input.activitySessionId, inputRevision: input.input.inputRevision, responseDigest: input.input.responseDigest },
    ...input.program, deadlineAt: new Date(input.effect.deadlineAt).toISOString(),
  };
  const request = input.target.kind === "activity_action" ? buildPythonExecutionRequest({ ...common, purpose: "public_run", target: input.target }) :
    buildPythonExecutionRequest({ ...common, purpose: "grade", target: input.target });
  return validateExecutionResult(await port.execute(request, input.effect.signal), request);
}

/** A later grading step can consume this persisted result without launching a second execution. */
export function storedPythonEvaluationPort(program: LearningPythonProgram, result: ExecutionResult): PythonEvaluationPort {
  return { async execute(input, signal) {
    signal.throwIfAborted();
    if (input.source !== program.source || canonicalJson(input.cases, 256 * 1024) !== canonicalJson(program.cases, 256 * 1024)) throw new Error("The stored Python result belongs to another program or case set");
    return result;
  } };
}

export function publicPythonObservation(task: TaskPublic, program: LearningPythonProgram, result: ExecutionResult) {
  if (result.status !== "completed") return null;
  const config = task.mechanicId === "artifact_construction" ? PythonArtifactConfigSchema.parse(task.config) : PythonRepairConfigSchema.parse(task.config);
  return parsePythonPublicObservation(config, { kind: "python_execution", runtimeProfile: "python_stdlib_v1", cases: result.cases.map((entry, index) => ({ caseId: entry.id,
    input: program.cases[index]?.input, result: entry.result })) });
}
