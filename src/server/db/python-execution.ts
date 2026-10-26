import "server-only";
import { canonicalJson, jsonDigest } from "../ai/json";
import { ExecutionResultSchema, validateExecutionResult, type ExecutionResult, type PythonCreateReservation,
  type PythonExecutionFence, type PythonExecutionPersistence, type PythonExecutionRequest, type PythonSafeError,
} from "../execution/python/contracts";
import type { PythonSandboxCapabilityEvidence } from "../execution/python/sdk";
import { withSystemTransaction, type DbTransaction } from "./index";

export type PythonExecutionTransaction = <T>(work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
type Status = "reserved" | "creating" | "running" | "collecting" | "ambiguous" | "cleanup_pending" | "completed" | "unavailable";
interface ExecutionRow {
  id: string; job_id: string; activity_action_id: string | null; attempt_id: string | null;
  authoring_validation_id: string | null; learner_id: string | null; enrollment_id: string | null;
  course_version_id: string; task_id: string | null; task_version: number | null;
  activity_session_id: string | null; input_revision: number | null; response_digest: string | null;
  owner_id: string | null; generation_run_id: string | null; course_id: string | null; approval_id: string | null;
  approval_digest: string | null; candidate_digest: string | null; cases_digest: string | null;
  execution_cases: unknown; purpose: PythonExecutionRequest["purpose"];
  logical_execution_id: string; execution_attempt: number; retry_of_execution_id: string | null;
  idempotency_key: string; request_digest: string; source_digest: string; runtime_digest: string;
  image_digest: string; runner_digest: string; runtime_profile: string; runtime_image: string;
  job_lease_owner: string; job_fencing_token: string; job_retry_epoch: number;
  step_id: string | null; step_lease_owner: string | null; step_fencing_token: string | null;
  resource_name: string; status: Status;
  provider_sandbox_id: string | null; provider_session_id: string | null; provider_command_ids: string[];
  safe_error: unknown; result: unknown; audit: unknown;
  capability_evidence: unknown;
}
interface AdmissionRow {
  idempotency_key: string; execution_id: string; job_id: string; job_lease_owner: string;
  job_fencing_token: string; job_retry_epoch: number; step_id: string | null;
  step_lease_owner: string | null; step_fencing_token: string | null;
  logical_execution_id: string; execution_attempt: number;
  request_digest: string; state: "assessing" | "dispatch" | "unavailable"; result: unknown;
}

export class PythonExecutionConflictError extends Error {
  constructor() { super("Python execution identity conflict"); }
}

function sameRequest(row: ExecutionRow, request: PythonExecutionRequest): boolean {
  const actionId = request.target.kind === "activity_action" ? request.target.activityActionId : null;
  const attemptId = request.target.kind === "attempt" ? request.target.attemptId : null;
  const authoringId = request.target.kind === "authoring_validation" ? request.target.authoringValidationId : null;
  const common = row.id === request.executionId && row.job_id === request.job.jobId &&
    row.job_retry_epoch === request.job.retryEpoch && row.activity_action_id === actionId &&
    row.attempt_id === attemptId && row.authoring_validation_id === authoringId &&
    row.course_version_id === request.authority.courseVersionId && row.purpose === request.purpose &&
    row.logical_execution_id === request.logicalExecutionId && row.execution_attempt === request.executionAttempt &&
    row.retry_of_execution_id === request.retryOfExecutionId && row.idempotency_key === request.idempotencyKey &&
    row.request_digest === request.requestDigest && row.source_digest === request.sourceDigest &&
    row.runtime_digest === request.runtimeDigest && row.image_digest === request.imageDigest &&
    row.runner_digest === request.runnerDigest && row.runtime_profile === request.runtimeProfile &&
    row.runtime_image === request.runtimeImage && canonicalJson(row.execution_cases) === canonicalJson(request.cases);
  if (!common) return false;
  if (request.purpose === "authoring_validation") {
    return row.owner_id === request.authority.ownerId &&
      row.generation_run_id === request.authority.generationRunId && row.course_id === request.authority.courseId &&
      row.approval_id === request.authority.approvalId && row.approval_digest === request.authority.approvalDigest &&
      row.candidate_digest === request.authority.candidateDigest && row.cases_digest === jsonDigest(request.cases) &&
      row.step_id === request.step.stepId;
  }
  return row.learner_id === request.authority.learnerId && row.enrollment_id === request.authority.enrollmentId &&
    row.task_id === request.authority.taskId && row.task_version === request.authority.taskVersion &&
    row.activity_session_id === request.input.activitySessionId && row.input_revision === request.input.inputRevision &&
    row.response_digest === request.input.responseDigest && row.step_id === null && row.step_lease_owner === null &&
    row.step_fencing_token === null;
}
const sameFence = (row: ExecutionRow, fence: PythonExecutionFence) => row.id === fence.executionId &&
  row.job_id === fence.jobId && row.job_lease_owner === fence.leaseOwner && row.job_fencing_token === fence.fencingToken &&
  row.job_retry_epoch === fence.retryEpoch && (fence.kind === "authoring"
    ? row.authoring_validation_id !== null && row.step_id === fence.step.stepId &&
      row.step_lease_owner === fence.step.leaseOwner && row.step_fencing_token === fence.step.fencingToken
    : row.authoring_validation_id === null && row.step_id === null && row.step_lease_owner === null &&
      row.step_fencing_token === null);
const sameAdmission = (row: AdmissionRow, request: PythonExecutionRequest) =>
  row.idempotency_key === request.idempotencyKey && row.execution_id === request.executionId &&
  row.job_id === request.job.jobId && row.job_retry_epoch === request.job.retryEpoch &&
  row.logical_execution_id === request.logicalExecutionId && row.execution_attempt === request.executionAttempt &&
  row.request_digest === request.requestDigest && (request.purpose === "authoring_validation"
    ? row.step_id === request.step.stepId
    : row.step_id === null && row.step_lease_owner === null && row.step_fencing_token === null);

function storedResult(row: ExecutionRow, request?: PythonExecutionRequest): ExecutionResult | null {
  let candidate: unknown = row.result;
  if (row.status === "unavailable" && row.audit && typeof row.audit === "object" && "executionResult" in row.audit) {
    candidate = (row.audit as { executionResult: unknown }).executionResult;
  }
  if (!candidate) return null;
  const parsed = ExecutionResultSchema.parse(candidate);
  return request ? validateExecutionResult(parsed, request) : parsed;
}

function unavailable(request: PythonExecutionRequest, reason: "cleanup_pending" | "deadline_expired", finishedAt = new Date().toISOString()): ExecutionResult {
  const pending = reason === "cleanup_pending";
  return ExecutionResultSchema.parse({ status: "unavailable", executionId: request.executionId, input: request.input,
    purpose: request.purpose, sourceDigest: request.sourceDigest, runtimeProfile: request.runtimeProfile, reason,
    retryable: !pending, audit: { sandboxId: null, sessionId: null, providerCommandIds: [], image: request.runtimeImage,
      imageDigest: request.imageDigest, runnerDigest: request.runnerDigest, runtimeDigest: request.runtimeDigest,
      startedAt: null, finishedAt, cleanup: pending ? "pending" : "not_created" } });
}

/** The sole database implementation of the Python worker's durable port. */
export class PostgresPythonExecutionPersistence implements PythonExecutionPersistence {
  constructor(private readonly transaction: PythonExecutionTransaction =
    (work) => withSystemTransaction("run_execution", work)) {}

  private async authorize(tx: DbTransaction, request: PythonExecutionRequest): Promise<void> {
    if (request.purpose === "authoring_validation") {
      const ok = (await tx.query<{ ok: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM unfurl.execution_jobs j
        JOIN unfurl.python_authoring_validations b ON b.id=$8 AND b.job_id=j.id
        JOIN unfurl.run_steps s ON s.id=$5 AND s.job_id=j.id
        WHERE j.id=$1 AND j.status='running' AND j.lease_owner=$2 AND j.fencing_token=$3
          AND j.retry_epoch=$4 AND j.lease_expires_at>statement_timestamp()
          AND s.status='running' AND s.lease_owner=$6 AND s.fencing_token=$7
          AND s.lease_expires_at>statement_timestamp() AND b.run_step_id=s.id
          AND b.job_retry_epoch=$4 AND b.owner_id=$9 AND b.generation_run_id=$10
          AND b.course_id=$11 AND b.course_version_id=$12 AND b.approval_id=$13
          AND b.approval_digest=$14 AND b.candidate_digest=$15 AND b.source_digest=$16
          AND b.cases_digest=$17 AND b.execution_cases=$18::jsonb
      ) AS ok`, [request.job.jobId, request.job.leaseOwner, request.job.fencingToken, request.job.retryEpoch,
        request.step.stepId, request.step.leaseOwner, request.step.fencingToken,
        request.target.authoringValidationId, request.authority.ownerId, request.authority.generationRunId,
        request.authority.courseId, request.authority.courseVersionId, request.authority.approvalId,
        request.authority.approvalDigest, request.authority.candidateDigest, request.sourceDigest,
        jsonDigest(request.cases), JSON.stringify(request.cases)])).rows[0]?.ok;
      if (!ok) throw new PythonExecutionConflictError();
      return;
    }
    const actionId = request.target.kind === "activity_action" ? request.target.activityActionId : null;
    const attemptId = request.target.kind === "attempt" ? request.target.attemptId : null;
    const ok = (await tx.query<{ ok: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM unfurl.execution_jobs j
      WHERE j.id=$1 AND j.status='running' AND j.lease_owner=$2 AND j.fencing_token=$3
        AND j.retry_epoch=$4 AND j.lease_expires_at>statement_timestamp()
        AND (($5::uuid IS NOT NULL AND j.activity_action_id=$5)
          OR ($6::uuid IS NOT NULL AND EXISTS (
            SELECT 1 FROM unfurl.evaluations e WHERE e.id=j.evaluation_id AND e.attempt_id=$6))
    )) AS ok`, [request.job.jobId, request.job.leaseOwner, request.job.fencingToken,
      request.job.retryEpoch, actionId, attemptId])).rows[0]?.ok;
    if (!ok) throw new PythonExecutionConflictError();
  }

  private async locked(tx: DbTransaction, id: string): Promise<ExecutionRow> {
    const row = (await tx.query<ExecutionRow>("SELECT * FROM unfurl.code_execution_runs WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!row) throw new PythonExecutionConflictError();
    return row;
  }
  private async fenced(tx: DbTransaction, fence: PythonExecutionFence): Promise<ExecutionRow> {
    const row = await this.locked(tx, fence.executionId);
    if (!sameFence(row, fence)) throw new PythonExecutionConflictError();
    return row;
  }
  private async replay(tx: DbTransaction, row: ExecutionRow, request: PythonExecutionRequest): Promise<PythonCreateReservation> {
    if (!sameRequest(row, request)) throw new PythonExecutionConflictError();
    const result = storedResult(row, request);
    if (result) return { status: "replay", result };
    return { status: "unavailable", result: unavailable(request, "cleanup_pending") };
  }

  private async existingAdmission(tx: DbTransaction, admission: AdmissionRow, request: PythonExecutionRequest): Promise<PythonCreateReservation> {
    if (!sameAdmission(admission, request)) throw new PythonExecutionConflictError();
    if (admission.state === "unavailable") {
      return { status: "replay", result: validateExecutionResult(ExecutionResultSchema.parse(admission.result), request) };
    }
    if (admission.state === "assessing") {
      return { status: "unavailable", result: unavailable(request, "cleanup_pending") };
    }
    const row = await this.locked(tx, request.executionId);
    return this.replay(tx, row, request);
  }

  async reserveCreate(request: PythonExecutionRequest): Promise<PythonCreateReservation> {
    return this.transaction(async (tx) => {
      await this.authorize(tx, request);
      const findAdmission = async () => (await tx.query<AdmissionRow>(`SELECT * FROM unfurl.python_execution_admissions
        WHERE idempotency_key=$1 OR execution_id=$2 OR (logical_execution_id=$3 AND execution_attempt=$4)
        ORDER BY CASE WHEN idempotency_key=$1 THEN 0 WHEN execution_id=$2 THEN 1 ELSE 2 END LIMIT 1 FOR UPDATE`,
      [request.idempotencyKey, request.executionId, request.logicalExecutionId, request.executionAttempt])).rows[0];
      const prior = await findAdmission();
      if (prior) return this.existingAdmission(tx, prior, request);
      const inserted = await tx.query(`INSERT INTO unfurl.python_execution_admissions
        (idempotency_key,execution_id,job_id,job_lease_owner,job_fencing_token,job_retry_epoch,
          step_id,step_lease_owner,step_fencing_token,logical_execution_id,execution_attempt,request_digest,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'assessing') ON CONFLICT DO NOTHING`,
      [request.idempotencyKey, request.executionId, request.job.jobId, request.job.leaseOwner,
        request.job.fencingToken, request.job.retryEpoch,
        request.purpose === "authoring_validation" ? request.step.stepId : null,
        request.purpose === "authoring_validation" ? request.step.leaseOwner : null,
        request.purpose === "authoring_validation" ? request.step.fencingToken : null,
        request.logicalExecutionId, request.executionAttempt, request.requestDigest]);
      if (inserted.rowCount !== 1) {
        const raced = await findAdmission();
        if (!raced) throw new PythonExecutionConflictError();
        return this.existingAdmission(tx, raced, request);
      }
      const databaseClock = (await tx.query<{ now: Date; expired: boolean }>(
        "SELECT statement_timestamp() AS now,statement_timestamp()>=$1::timestamptz AS expired",
        [request.deadlineAt],
      )).rows[0];
      if (!databaseClock) throw new PythonExecutionConflictError();
      if (databaseClock.expired) {
        const result = unavailable(request, "deadline_expired", databaseClock.now.toISOString());
        await tx.query(`UPDATE unfurl.python_execution_admissions
          SET state='unavailable',result=$2,updated_at=now() WHERE idempotency_key=$1`,
        [request.idempotencyKey, JSON.stringify(result)]);
        return { status: "unavailable", result };
      }
      await tx.query("SAVEPOINT python_execution_admission");
      try {
        const actionId = request.target.kind === "activity_action" ? request.target.activityActionId : null;
        const attemptId = request.target.kind === "attempt" ? request.target.attemptId : null;
        const authoring = request.purpose === "authoring_validation" ? request : null;
        const learning = request.purpose === "authoring_validation" ? null : request;
        const row = (await tx.query<ExecutionRow>(`INSERT INTO unfurl.code_execution_runs
          (id,job_id,activity_action_id,attempt_id,authoring_validation_id,learner_id,enrollment_id,course_version_id,
            task_id,task_version,activity_session_id,input_revision,response_digest,owner_id,generation_run_id,course_id,
            approval_id,approval_digest,candidate_digest,cases_digest,execution_cases,purpose,logical_execution_id,
            execution_attempt,retry_of_execution_id,idempotency_key,request_digest,source_digest,runtime_digest,
            image_digest,runner_digest,runtime_profile,runtime_image,job_lease_owner,job_fencing_token,job_retry_epoch,
            step_id,step_lease_owner,step_fencing_token,quota_day,deadline_at,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
            $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,(now() at time zone 'UTC')::date,$40,'creating')
          RETURNING *`,
        [request.executionId, request.job.jobId, actionId, attemptId, authoring?.target.authoringValidationId ?? null,
          learning?.authority.learnerId ?? null, learning?.authority.enrollmentId ?? null,
          request.authority.courseVersionId, learning?.authority.taskId ?? null,
          learning?.authority.taskVersion ?? null, learning?.input.activitySessionId ?? null,
          learning?.input.inputRevision ?? null, learning?.input.responseDigest ?? null,
          authoring?.authority.ownerId ?? null, authoring?.authority.generationRunId ?? null,
          authoring?.authority.courseId ?? null, authoring?.authority.approvalId ?? null,
          authoring?.authority.approvalDigest ?? null, authoring?.authority.candidateDigest ?? null,
          authoring ? jsonDigest(authoring.cases) : null, JSON.stringify(request.cases), request.purpose,
          request.logicalExecutionId, request.executionAttempt,
          request.retryOfExecutionId, request.idempotencyKey, request.requestDigest, request.sourceDigest,
          request.runtimeDigest, request.imageDigest, request.runnerDigest, request.runtimeProfile, request.runtimeImage,
          request.job.leaseOwner, request.job.fencingToken, request.job.retryEpoch, authoring?.step.stepId ?? null,
          authoring?.step.leaseOwner ?? null, authoring?.step.fencingToken ?? null, request.deadlineAt])).rows[0];
        if (!row) throw new PythonExecutionConflictError();
        await tx.query("RELEASE SAVEPOINT python_execution_admission");
        await tx.query("UPDATE unfurl.python_execution_admissions SET state='dispatch',updated_at=now() WHERE idempotency_key=$1", [request.idempotencyKey]);
        return { status: "dispatch", resourceName: row.resource_name };
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT python_execution_admission");
        // Independent executions do not compete for an application capacity slot.
        // Any failed insert is an identity/authority failure, never a provider quota receipt.
        throw new PythonExecutionConflictError();
      }
    });
  }

  async recordCapabilityAuthorized(fence: PythonExecutionFence, evidence: PythonSandboxCapabilityEvidence): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await this.fenced(tx, fence);
      if (row.capability_evidence !== null) {
        if (canonicalJson(row.capability_evidence) === canonicalJson(evidence)) return;
        throw new PythonExecutionConflictError();
      }
      const changed = await tx.query(`UPDATE unfurl.code_execution_runs
        SET capability_evidence=$2,updated_at=now() WHERE id=$1 AND status='creating' AND capability_evidence IS NULL`,
      [row.id, JSON.stringify(evidence)]);
      if (changed.rowCount !== 1) throw new PythonExecutionConflictError();
    });
  }

  async recordSandboxCreated(fence: PythonExecutionFence, evidence: { sandboxId: string; sessionId: string; createdAt: string }): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await this.fenced(tx, fence);
      if (row.provider_sandbox_id !== null || row.provider_session_id !== null) {
        if (row.provider_sandbox_id === evidence.sandboxId && row.provider_session_id === evidence.sessionId) return;
        throw new PythonExecutionConflictError();
      }
      const changed = await tx.query(`UPDATE unfurl.code_execution_runs SET status='running',provider_sandbox_id=$2,
        provider_session_id=$3,sandbox_created_at=$4,updated_at=now() WHERE id=$1 AND status='creating'`,
      [row.id, evidence.sandboxId, evidence.sessionId, evidence.createdAt]);
      if (changed.rowCount !== 1) throw new PythonExecutionConflictError();
    });
  }

  async recordCommandStarted(fence: PythonExecutionFence, evidence: { caseId: string; commandId: string; startedAt: string }): Promise<void> {
    if (!evidence.caseId || !evidence.commandId) throw new PythonExecutionConflictError();
    await this.transaction(async (tx) => {
      const row = await this.fenced(tx, fence);
      if (row.provider_command_ids.includes(evidence.commandId)) return;
      const changed = await tx.query(`UPDATE unfurl.code_execution_runs SET status='collecting',
        provider_command_ids=array_append(provider_command_ids,$2),command_started_at=coalesce(command_started_at,$3),updated_at=now()
        WHERE id=$1 AND status IN ('running','collecting')`, [row.id, evidence.commandId, evidence.startedAt]);
      if (changed.rowCount !== 1) throw new PythonExecutionConflictError();
    });
  }

  async markCreateAmbiguous(fence: PythonExecutionFence, evidence: { at: string; error: PythonSafeError }): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await this.fenced(tx, fence);
      if (row.status === "ambiguous" && canonicalJson(row.safe_error) === canonicalJson(evidence.error)) return;
      const changed = await tx.query(`UPDATE unfurl.code_execution_runs SET status='ambiguous',create_ambiguous_at=$2,
        safe_error=$3,updated_at=now() WHERE id=$1 AND status='creating'`, [row.id, evidence.at, JSON.stringify(evidence.error)]);
      if (changed.rowCount !== 1) throw new PythonExecutionConflictError();
    });
  }

  async recordCleanupPending(fence: PythonExecutionFence, evidence: { at: string; error: PythonSafeError | null }): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await this.fenced(tx, fence);
      if (["cleanup_pending", "completed", "unavailable"].includes(row.status)) return;
      const changed = await tx.query(`UPDATE unfurl.code_execution_runs SET status='cleanup_pending',cleanup_pending_at=$2,
        safe_error=coalesce($3::jsonb,safe_error),updated_at=now()
        WHERE id=$1 AND status IN ('creating','running','collecting','ambiguous')`,
      [row.id, evidence.at, evidence.error ? JSON.stringify(evidence.error) : null]);
      if (changed.rowCount !== 1) throw new PythonExecutionConflictError();
    });
  }

  async recordUnavailable(fence: PythonExecutionFence, result: Extract<ExecutionResult, { status: "unavailable" }>, error: PythonSafeError): Promise<void> {
    if (result.audit.cleanup === "pending") throw new PythonExecutionConflictError();
    await this.transaction(async (tx) => {
      const row = await this.fenced(tx, fence);
      const prior = storedResult(row);
      if (prior) {
        if (canonicalJson(prior) === canonicalJson(result)) return;
        throw new PythonExecutionConflictError();
      }
      const changed = await tx.query(`UPDATE unfurl.code_execution_runs SET status='unavailable',disposition=$2,
        safe_error=$3,audit=$4,disposed_at=$5,unavailable_at=$6,updated_at=now()
        WHERE id=$1 AND status IN ('creating','cleanup_pending')`,
      [row.id, result.audit.cleanup, JSON.stringify(error), JSON.stringify({ executionResult: result }),
        result.audit.cleanup === "deleted" ? result.audit.finishedAt : null, result.audit.finishedAt]);
      if (changed.rowCount !== 1) throw new PythonExecutionConflictError();
    });
  }

  async recordCompleted(fence: PythonExecutionFence, result: Extract<ExecutionResult, { status: "completed" }>): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await this.fenced(tx, fence);
      const prior = storedResult(row);
      if (prior) {
        if (canonicalJson(prior) === canonicalJson(result)) return;
        throw new PythonExecutionConflictError();
      }
      const changed = await tx.query(`UPDATE unfurl.code_execution_runs SET status='completed',disposition='deleted',
        result=$2,result_digest=$3,audit=$4,disposed_at=$5,completed_at=$5,updated_at=now()
        WHERE id=$1 AND status='cleanup_pending'`,
      [row.id, JSON.stringify(result), jsonDigest(result, 2 * 1024 * 1024), JSON.stringify(result.audit), result.audit.finishedAt]);
      if (changed.rowCount !== 1) throw new PythonExecutionConflictError();
    });
  }
}

export const createPythonExecutionPersistence = (transaction?: PythonExecutionTransaction): PythonExecutionPersistence =>
  new PostgresPythonExecutionPersistence(transaction);
