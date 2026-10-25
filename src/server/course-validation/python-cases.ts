import "server-only";
import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "@/domain/common";
import { jsonDigest } from "@/server/ai/json";
import { ProviderFailure } from "@/server/ai/failure";
import { createRubricJudge } from "@/server/ai/rubric-judge";
import type { ModelPort } from "@/server/ai/ports";
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import {
  PythonArtifactConfigSchema,
  PythonArtifactResponseSchema,
  PythonRepairConfigSchema,
  PythonRepairResponseSchema,
  type ExecutionJson,
} from "@/domain/mechanic-families/v3/python";
import {
  GradeDecisionSchema,
  RubricJudgementSchema,
  RubricRequestSchema,
  validateRubricJudgement,
  type GradeDecision,
  type RubricJudge,
  type RubricRequest,
} from "@/server/evaluation/contracts";
import { PythonArtifactPrivateSchema, PythonRepairPrivateSchema } from "@/server/evaluation/python";
import {
  buildPythonExecutionRequest,
  type ExecutionResult,
  type PythonEvaluationPort,
  type PythonExecutionPort,
  type PythonExecutionRequest,
} from "@/server/execution/python";
import { ExecutionResultSchema, validateExecutionResult } from "@/server/execution/python/contracts";
import { getServerMechanic } from "@/server/mechanics/registry";
import { PreparedTaskCandidateSchema, type PreparedTaskCandidate } from "@/server/mechanics/contracts";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { taskDigest } from "@/server/mechanics/digest";
import { stableExecutionId } from "@/server/runs/identity";
import type { RunContext, StepEffectContext } from "@/server/runs/ports";
import { generationDigests, loadStage, type StageIndex } from "@/server/course-generation/stages";
import { verifyStoredModelData, type StoredGenerationStep } from "@/server/course-generation/repository";
import {
  CaseEvaluationInputSchema,
  CaseEvaluationResultSchema,
  ResponseCaseSchema,
  type CaseEvaluationResult,
  type ResponseCase,
} from "./case-evaluation";

const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

export const AuthoringPythonExecutionCheckpointSchema = z.object({
  kind: z.literal("course.python_execution"),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  caseId: z.uuid(),
  authoringValidationId: z.uuid(),
  executionId: z.uuid(),
  result: ExecutionResultSchema,
}).strict();
export type AuthoringPythonExecutionCheckpoint = z.infer<typeof AuthoringPythonExecutionCheckpointSchema>;

type PythonPlan = {
  candidate: PreparedTaskCandidate;
  test: ResponseCase;
  source: string;
  publicCount: number;
  cases: Array<{ id: string; input: ExecutionJson }>;
  caseBindings: Array<{ id: string; role: "public" | "hidden"; inputDigest: string; expectedDigest: string | null }>;
};

function planPythonCase(candidateValue: PreparedTaskCandidate, testValue: ResponseCase): PythonPlan | null {
  const { candidate, test } = CaseEvaluationInputSchema.parse({ candidate: candidateValue, test: testValue });
  const fresh = prepareTaskCandidate({ task: candidate.task, privateTask: candidate.privateTask }, { approvalDigest: candidate.approvalDigest });
  if (taskDigest(fresh) !== taskDigest(candidate)) return invalid();
  const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion);
  if (!handle || !handle.descriptor.requirements.includes("sandbox") || candidate.task.mechanicVersion !== 3) return invalid();
  let response: ReturnType<typeof PythonArtifactResponseSchema.parse> | ReturnType<typeof PythonRepairResponseSchema.parse>;
  try {
    response = candidate.task.mechanicId === "artifact_construction"
      ? PythonArtifactResponseSchema.parse(test.response)
      : candidate.task.mechanicId === "diagnosis_repair"
        ? PythonRepairResponseSchema.parse(test.response)
        : invalid();
    if (handle.descriptor.validateSubmission(candidate.task.config, response).length > 0) return null;
  } catch { return null; }
  const config = candidate.task.mechanicId === "artifact_construction"
    ? PythonArtifactConfigSchema.parse(candidate.task.config)
    : PythonRepairConfigSchema.parse(candidate.task.config);
  const privateData = candidate.task.mechanicId === "artifact_construction"
    ? PythonArtifactPrivateSchema.parse(candidate.privateTask.evaluatorData)
    : PythonRepairPrivateSchema.parse(candidate.privateTask.evaluatorData);
  const cases = [
    ...config.publicCases.map(({ id, input }) => ({ id, input })),
    ...privateData.hiddenCases.map(({ id, input }) => ({ id, input })),
  ];
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) return invalid();
  const caseBindings = [
    ...config.publicCases.map(({ id, input }) => ({ id, role: "public" as const, inputDigest: jsonDigest(input), expectedDigest: null })),
    ...privateData.hiddenCases.map(({ id, input, expected }) => ({ id, role: "hidden" as const,
      inputDigest: jsonDigest(input), expectedDigest: jsonDigest(expected) })),
  ];
  return { candidate, test, source: response.source, publicCount: config.publicCases.length, cases, caseBindings };
}

function requestFor(input: {
  context: RunContext;
  effect: StepEffectContext;
  binding: ApprovedBuildBinding;
  plan: PythonPlan;
}): Extract<PythonExecutionRequest, { purpose: "authoring_validation" }> {
  const authoringValidationId = stableExecutionId(input.effect.stepId, "python-authoring-validation");
  const logicalExecutionId = stableExecutionId(authoringValidationId, "logical-execution");
  const request = buildPythonExecutionRequest({
    executionId: stableExecutionId(logicalExecutionId, "execution:1"),
    logicalExecutionId,
    executionAttempt: 1,
    retryOfExecutionId: null,
    idempotencyKey: stableExecutionId(logicalExecutionId, "idempotency:1"),
    job: {
      jobId: input.context.claim.jobId,
      leaseOwner: input.effect.stepFence.jobLeaseOwner,
      fencingToken: input.effect.stepFence.jobFencingToken,
      retryEpoch: input.effect.stepFence.retryEpoch,
    },
    authority: {
      kind: "authoring",
      ownerId: input.binding.course.ownerId,
      generationRunId: input.binding.run.id,
      courseId: input.binding.course.id,
      courseVersionId: input.binding.version.id,
      approvalId: input.binding.approval.id,
      approvalDigest: input.binding.approval.contentDigest,
      candidateDigest: input.plan.candidate.candidateDigest,
    },
    input: { kind: "authoring", authoringValidationId, candidateDigest: input.plan.candidate.candidateDigest },
    purpose: "authoring_validation",
    target: { kind: "authoring_validation", authoringValidationId, runStepId: input.effect.stepId },
    step: {
      stepId: input.effect.stepId,
      leaseOwner: input.effect.stepFence.stepLeaseOwner,
      fencingToken: input.effect.stepFence.stepFencingToken,
    },
    source: input.plan.source,
    cases: input.plan.cases,
    deadlineAt: new Date(input.effect.deadlineAt).toISOString(),
  });
  if (request.purpose !== "authoring_validation") return invalid();
  return request;
}

async function prepareBinding(tx: DbTransaction, input: {
  context: RunContext;
  effect: StepEffectContext;
  binding: ApprovedBuildBinding;
  candidateStepId: string;
  casePlanStepId: string;
  plan: PythonPlan;
}): Promise<void> {
  const request = requestFor(input);
  const digests = generationDigests(input.binding);
  const values = [
    request.target.authoringValidationId, request.job.jobId, request.step.stepId,
    input.candidateStepId, input.casePlanStepId, input.plan.test.caseId,
    input.binding.course.ownerId, input.binding.run.id, input.binding.course.id, input.binding.version.id,
    input.binding.approval.id, input.binding.approval.contentDigest, input.plan.candidate.candidateDigest,
    input.plan.candidate.capabilityCatalogDigest, request.source, request.sourceDigest, jsonDigest(request.cases),
    input.plan.test.key, input.plan.test.category, JSON.stringify(input.plan.caseBindings), JSON.stringify(request.cases),
    digests.schema, digests.capability, digests.validationPolicy,
    digests.schema, digests.capability, digests.validationPolicy,
    digests.schema, digests.capability, digests.validationPolicy,
    request.job.leaseOwner, request.job.fencingToken, request.job.retryEpoch,
    request.step.leaseOwner, request.step.fencingToken,
  ];
  await tx.query(`INSERT INTO unfurl.python_authoring_validations
    (id,job_id,run_step_id,candidate_step_id,case_plan_step_id,validation_case_id,owner_id,generation_run_id,
      course_id,course_version_id,approval_id,approval_digest,candidate_digest,capability_catalog_digest,source,
      source_digest,cases_digest,case_key,case_category,case_bindings,execution_cases,candidate_step_schema_digest,
      candidate_step_capability_digest,candidate_step_validation_policy_digest,case_plan_schema_digest,
      case_plan_capability_digest,case_plan_validation_policy_digest,execution_schema_digest,
      execution_capability_digest,execution_validation_policy_digest,job_lease_owner,job_fencing_token,
      job_retry_epoch,step_lease_owner,step_fencing_token)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,
      $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
    ON CONFLICT DO NOTHING`, values);
  const verified = (await tx.query<{ ok: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM unfurl.python_authoring_validations
    WHERE id=$1 AND job_id=$2 AND run_step_id=$3 AND candidate_step_id=$4 AND case_plan_step_id=$5
      AND validation_case_id=$6 AND owner_id=$7 AND generation_run_id=$8 AND course_id=$9
      AND course_version_id=$10 AND approval_id=$11 AND approval_digest=$12 AND candidate_digest=$13
      AND capability_catalog_digest=$14 AND source=$15 AND source_digest=$16 AND cases_digest=$17
      AND case_key=$18 AND case_category=$19 AND case_bindings=$20::jsonb AND execution_cases=$21::jsonb
      AND candidate_step_schema_digest=$22 AND candidate_step_capability_digest=$23
      AND candidate_step_validation_policy_digest=$24 AND case_plan_schema_digest=$25
      AND case_plan_capability_digest=$26 AND case_plan_validation_policy_digest=$27
      AND execution_schema_digest=$28 AND execution_capability_digest=$29
      AND execution_validation_policy_digest=$30
  ) AS ok`, values.slice(0, 30))).rows[0]?.ok;
  if (!verified) return invalid();
}

function projectedEvaluationPort(plan: PythonPlan, raw: ExecutionResult): PythonEvaluationPort {
  return { async execute(value, signal) {
    signal.throwIfAborted();
    const hidden = plan.cases.slice(plan.publicCount);
    if (value.source !== plan.source || value.runtimeProfile !== "python_stdlib_v1" ||
        taskDigest(value.cases) !== taskDigest(hidden)) return invalid();
    if (raw.status !== "completed") return raw;
    return ExecutionResultSchema.parse({ ...raw, cases: raw.cases.slice(plan.publicCount) });
  } };
}

async function evaluatePlan(input: {
  plan: PythonPlan;
  execution: AuthoringPythonExecutionCheckpoint;
  effect: StepEffectContext;
  model: ModelPort;
}): Promise<CaseEvaluationResult> {
  const handle = getServerMechanic(input.plan.candidate.task.mechanicId, input.plan.candidate.task.mechanicVersion);
  if (!handle) return invalid();
  const captured: { request: RubricRequest | null; judgement: z.infer<typeof RubricJudgementSchema> | null; operationId: string | null } =
    { request: null, judgement: null, operationId: null };
  let judge: RubricJudge | null = null;
  if (handle.descriptor.requirements.includes("model")) {
    const budget = input.effect.budgetOperation("case-rubric");
    const actual = createRubricJudge(input.model, { budget, deadlineAt: input.effect.deadlineAt });
    judge = { async judge(request, signal) {
      if (captured.request !== null) return invalid();
      captured.request = RubricRequestSchema.parse(request);
      const result = await actual.judge(captured.request, signal);
      captured.judgement = RubricJudgementSchema.parse(result);
      captured.operationId = budget.reservationId;
      return result;
    } };
  }
  const response = handle.parseResponse(input.plan.test.response);
  const decision = await handle.evaluate({ task: input.plan.candidate.task,
    privateData: input.plan.candidate.privateTask.evaluatorData, response, activity: null }, {
    model: judge, python: projectedEvaluationPort(input.plan, input.execution.result), signal: input.effect.signal,
  });
  return CaseEvaluationResultSchema.parse({
    kind: "course.response_case",
    candidateDigest: input.plan.candidate.candidateDigest,
    caseId: input.plan.test.caseId,
    category: input.plan.test.category,
    response: input.plan.test.response,
    decision,
    rejectedAsInvalid: false,
    modelCallId: captured.operationId,
    rubricRequest: captured.judgement === null ? null : captured.request,
    rubricJudgement: captured.judgement,
    activityEvidenceRef: input.execution.executionId,
  });
}

function rejected(candidate: PreparedTaskCandidate, test: ResponseCase): CaseEvaluationResult {
  return CaseEvaluationResultSchema.parse({
    kind: "course.response_case", candidateDigest: candidate.candidateDigest,
    caseId: test.caseId, category: test.category, response: test.response,
    decision: null, rejectedAsInvalid: true, modelCallId: null,
    rubricRequest: null, rubricJudgement: null, activityEvidenceRef: null,
  });
}

/**
 * Advances one Python response case by at most one durable stage. A valid form
 * first executes all public then hidden cases in one VM; a later stage grades
 * only the hidden projection and captures any real rubric judgement.
 */
export async function advancePythonCase(input: {
  context: RunContext;
  binding: ApprovedBuildBinding;
  index: StageIndex;
  key: string;
  candidateStepId: string;
  casePlanStepId: string;
  candidate: PreparedTaskCandidate;
  test: ResponseCase;
  model: ModelPort;
  python: PythonExecutionPort;
}): Promise<{ stepId: string; result: CaseEvaluationResult } | null> {
  const candidate = PreparedTaskCandidateSchema.parse(input.candidate);
  const test = ResponseCaseSchema.parse(input.test);
  const prior = await loadStage(input.context, input.binding, input.index, input.key, CaseEvaluationResultSchema);
  if (prior) return { stepId: prior.id, result: prior.result };
  const plan = planPythonCase(candidate, test);
  const digests = generationDigests(input.binding);
  if (plan === null) {
    await input.context.step<JsonValue, JsonValue, JsonValue>({
      key: input.key,
      input: JsonValueSchema.parse(CaseEvaluationInputSchema.parse({ candidate, test })),
      digests,
      outputSchema: JsonValueSchema,
      resultSchema: JsonValueSchema,
      async effect() { return JsonValueSchema.parse(rejected(candidate, test)); },
      async commit(_tx, output) { return output; },
    });
    return null;
  }
  const executionKey = `${input.key}/execute`;
  const executed = await loadStage(input.context, input.binding, input.index, executionKey, AuthoringPythonExecutionCheckpointSchema);
  if (!executed) {
    await input.context.step<JsonValue, JsonValue, JsonValue>({
      key: executionKey,
      input: JsonValueSchema.parse(CaseEvaluationInputSchema.parse({ candidate, test })),
      digests,
      outputSchema: JsonValueSchema,
      resultSchema: JsonValueSchema,
      prepare: (tx, effect) => prepareBinding(tx, { ...input, effect, plan }),
      async effect(effect) {
        const request = requestFor({ ...input, effect, plan });
        const result = validateExecutionResult(await input.python.execute(request, effect.signal), request);
        return JsonValueSchema.parse(AuthoringPythonExecutionCheckpointSchema.parse({
          kind: "course.python_execution",
          candidateDigest: candidate.candidateDigest,
          caseId: test.caseId,
          authoringValidationId: request.target.authoringValidationId,
          executionId: request.executionId,
          result,
        }));
      },
      async commit(_tx, output) { return output; },
    });
    return null;
  }
  if (executed.result.candidateDigest !== candidate.candidateDigest || executed.result.caseId !== test.caseId) return invalid();
  const gradeInput = JsonValueSchema.parse({ candidate, test, execution: executed.result });
  await input.context.step<JsonValue, JsonValue, JsonValue>({
    key: input.key,
    input: gradeInput,
    digests,
    outputSchema: JsonValueSchema,
    resultSchema: JsonValueSchema,
    effect: async effect => JsonValueSchema.parse(await evaluatePlan({ plan, execution: executed.result, effect, model: input.model })),
    async commit(_tx, output) { return output; },
  });
  return null;
}

type StoredExecutionRow = {
  id: string;
  status: string;
  result: unknown;
  audit: unknown;
  authoring_validation_id: string;
  source: string;
  source_digest: string;
  execution_cases: unknown;
  case_bindings: unknown;
  case_key: string;
  case_category: string;
  validation_case_id: string;
  candidate_digest: string;
  candidate_step_id: string;
  case_plan_step_id: string;
  execution_step_id: string;
  execution_step_result: unknown;
  candidate_step_result: unknown;
  case_plan_step_result: unknown;
};

/** Replays a stored Python case from its immutable binding and execution row. */
export async function replayStoredPythonCase(
  tx: DbTransaction,
  binding: ApprovedBuildBinding,
  candidateValue: PreparedTaskCandidate,
  resultValue: CaseEvaluationResult,
  step: StoredGenerationStep<CaseEvaluationResult>,
): Promise<GradeDecision> {
  const candidate = PreparedTaskCandidateSchema.parse(candidateValue);
  const result = CaseEvaluationResultSchema.parse(resultValue);
  if (taskDigest(step.result) !== taskDigest(result) || result.rejectedAsInvalid || result.decision === null ||
      result.activityEvidenceRef === null) return invalid();
  const row = (await tx.query<StoredExecutionRow>(`WITH RECURSIVE lineage AS (
      SELECT id,retry_of_run_id,ARRAY[id] AS path FROM unfurl.generation_runs
        WHERE id=$3 AND owner_id=$2 AND course_id=$4 AND approval_id=$7 AND source_draft_revision=$5
      UNION ALL
      SELECT parent.id,parent.retry_of_run_id,lineage.path||parent.id FROM unfurl.generation_runs parent
        JOIN lineage ON parent.id=lineage.retry_of_run_id
        WHERE parent.owner_id=$2 AND parent.course_id=$4 AND parent.approval_id=$7
          AND parent.source_draft_revision=$5 AND parent.status IN ('failed','cancelled')
          AND NOT parent.id=ANY(lineage.path)
    ) SELECT e.id,e.status,e.result,e.audit,e.authoring_validation_id,
      b.source,b.source_digest,b.execution_cases,b.case_bindings,b.case_key,b.case_category,
      b.validation_case_id,b.candidate_digest,
      b.candidate_step_id,b.case_plan_step_id,b.run_step_id AS execution_step_id,
      execution_step.result_reference AS execution_step_result,
      candidate_step.result_reference AS candidate_step_result,
      case_plan_step.result_reference AS case_plan_step_result
    FROM unfurl.code_execution_runs e
    JOIN unfurl.python_authoring_validations b ON b.id=e.authoring_validation_id
    JOIN unfurl.run_steps execution_step ON execution_step.id=b.run_step_id AND execution_step.job_id=b.job_id
    JOIN unfurl.run_steps candidate_step ON candidate_step.id=b.candidate_step_id AND candidate_step.job_id=b.job_id
    JOIN unfurl.run_steps case_plan_step ON case_plan_step.id=b.case_plan_step_id AND case_plan_step.job_id=b.job_id
    WHERE e.id=$1 AND b.owner_id=$2 AND b.generation_run_id IN (SELECT id FROM lineage) AND b.course_id=$4
      AND b.course_version_id=$6 AND b.approval_id=$7 AND b.approval_digest=$8`, [
    result.activityEvidenceRef, binding.course.ownerId, binding.run.id, binding.course.id,
    binding.approval.draftRevision, binding.version.id, binding.approval.id, binding.approval.contentDigest,
  ])).rows[0];
  if (!row || row.validation_case_id !== result.caseId || row.candidate_digest !== candidate.candidateDigest ||
      row.case_category !== result.category || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.case_key)) return invalid();
  const test = ResponseCaseSchema.parse({ caseId: result.caseId, key: row.case_key, category: result.category, response: result.response });
  const plan = planPythonCase(candidate, test);
  if (plan === null || row.source !== plan.source || taskDigest(row.execution_cases) !== taskDigest(plan.cases) ||
      taskDigest(row.case_bindings) !== taskDigest(plan.caseBindings)) return invalid();
  const execution = AuthoringPythonExecutionCheckpointSchema.parse(row.execution_step_result);
  if (execution.executionId !== row.id || execution.authoringValidationId !== row.authoring_validation_id ||
      execution.caseId !== result.caseId || execution.candidateDigest !== candidate.candidateDigest) return invalid();
  const storedRaw = ExecutionResultSchema.parse(row.status === "unavailable" && row.audit && typeof row.audit === "object" &&
    "executionResult" in row.audit ? (row.audit as { executionResult: unknown }).executionResult : row.result);
  if (taskDigest(storedRaw) !== taskDigest(execution.result) || storedRaw.executionId !== row.id ||
      storedRaw.purpose !== "authoring_validation" || storedRaw.sourceDigest !== row.source_digest) return invalid();
  const candidateCheckpoint = z.object({ candidate: PreparedTaskCandidateSchema }).passthrough().parse(row.candidate_step_result);
  if (taskDigest(candidateCheckpoint.candidate) !== taskDigest(candidate)) return invalid();
  const caseCheckpoint = z.object({ cases: z.array(ResponseCaseSchema) }).passthrough().parse(row.case_plan_step_result);
  const planned = caseCheckpoint.cases.find(({ caseId }) => caseId === result.caseId);
  if (!planned || planned.category !== result.category || taskDigest(planned.response) !== taskDigest(result.response)) return invalid();
  let judge: RubricJudge | null = null;
  if (result.modelCallId !== null) {
    if (result.rubricRequest === null || result.rubricJudgement === null) return invalid();
    await verifyStoredModelData(tx, step, result.modelCallId, RubricJudgementSchema, result.rubricJudgement);
    const request = RubricRequestSchema.parse(result.rubricRequest);
    const judgement = validateRubricJudgement(result.rubricJudgement, request);
    judge = { async judge(actual) { if (taskDigest(actual) !== taskDigest(request)) return invalid(); return judgement; } };
  } else if (result.rubricRequest !== null || result.rubricJudgement !== null) return invalid();
  const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion);
  if (!handle) return invalid();
  const actual = GradeDecisionSchema.parse(await handle.evaluate({ task: candidate.task,
    privateData: candidate.privateTask.evaluatorData, response: handle.parseResponse(result.response), activity: null }, {
    model: judge, python: projectedEvaluationPort(plan, storedRaw), signal: new AbortController().signal,
  }));
  if (taskDigest(actual) !== taskDigest(result.decision)) return invalid();
  return actual;
}
