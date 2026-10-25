import {
  pythonExecutionRequestDigest,
  pythonSourceDigest,
  validatePythonExecutionRequest,
  type PythonExecutionRequest,
} from "../../../src/server/execution/python/contracts";
import {
  PYTHON_IMAGE_SHA256,
  PYTHON_RUNNER_SHA256,
  PYTHON_RUNTIME_DIGEST,
  PYTHON_RUNTIME_PROFILE,
  PYTHON_SANDBOX_IMAGE,
} from "../../../src/server/execution/python/profile";

export const IDS = {
  execution: "00000000-0000-4000-8000-000000000001",
  job: "00000000-0000-4000-8000-000000000002",
  learner: "00000000-0000-4000-8000-000000000003",
  enrollment: "00000000-0000-4000-8000-000000000004",
  courseVersion: "00000000-0000-4000-8000-000000000005",
  task: "00000000-0000-4000-8000-000000000006",
  session: "00000000-0000-4000-8000-000000000007",
  action: "00000000-0000-4000-8000-000000000008",
  attempt: "00000000-0000-4000-8000-000000000009",
  logical: "00000000-0000-4000-8000-00000000000a",
  idempotency: "00000000-0000-4000-8000-00000000000b",
  testSet: "00000000-0000-4000-8000-00000000000c",
  jobLeaseOwner: "00000000-0000-4000-8000-00000000000d",
  step: "00000000-0000-4000-8000-00000000000e",
  stepLeaseOwner: "00000000-0000-4000-8000-00000000000f",
  authoringValidation: "00000000-0000-4000-8000-000000000010",
  owner: "00000000-0000-4000-8000-000000000011",
  generationRun: "00000000-0000-4000-8000-000000000012",
  course: "00000000-0000-4000-8000-000000000013",
  approval: "00000000-0000-4000-8000-000000000014",
} as const;

export const SOURCE = "def solve(payload):\n    return payload['value'] * 2\n";

export function executionRequest(
  overrides: Partial<Extract<PythonExecutionRequest, { purpose: "public_run" }>> = {},
): Extract<PythonExecutionRequest, { purpose: "public_run" }> {
  const source = overrides.source ?? SOURCE;
  const draft: Extract<PythonExecutionRequest, { purpose: "public_run" }> = {
    executionId: IDS.execution,
    job: { jobId: IDS.job, leaseOwner: IDS.jobLeaseOwner, fencingToken: "1", retryEpoch: 0 },
    authority: {
      kind: "learning",
      learnerId: IDS.learner,
      enrollmentId: IDS.enrollment,
      courseVersionId: IDS.courseVersion,
      taskId: IDS.task,
      taskVersion: 1,
    },
    input: { kind: "learning", activitySessionId: IDS.session, inputRevision: 1, responseDigest: "a".repeat(64) },
    purpose: "public_run",
    target: { kind: "activity_action", activityActionId: IDS.action },
    logicalExecutionId: IDS.logical,
    executionAttempt: 1,
    retryOfExecutionId: null,
    idempotencyKey: IDS.idempotency,
    requestDigest: "0".repeat(64),
    source,
    sourceDigest: pythonSourceDigest(source),
    cases: [{ id: "public_case", input: { value: 3 } }],
    runtimeProfile: PYTHON_RUNTIME_PROFILE,
    runtimeDigest: PYTHON_RUNTIME_DIGEST,
    runtimeImage: PYTHON_SANDBOX_IMAGE,
    imageDigest: PYTHON_IMAGE_SHA256,
    runnerDigest: PYTHON_RUNNER_SHA256,
    deadlineAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
  return validatePythonExecutionRequest({
    ...draft,
    requestDigest: pythonExecutionRequestDigest(draft),
  }) as Extract<PythonExecutionRequest, { purpose: "public_run" }>;
}

export function authoringExecutionRequest(
  overrides: Partial<Extract<PythonExecutionRequest, { purpose: "authoring_validation" }>> = {},
): Extract<PythonExecutionRequest, { purpose: "authoring_validation" }> {
  const source = overrides.source ?? SOURCE;
  const candidateDigest = "b".repeat(64);
  const draft: Extract<PythonExecutionRequest, { purpose: "authoring_validation" }> = {
    executionId: IDS.execution,
    job: { jobId: IDS.job, leaseOwner: IDS.jobLeaseOwner, fencingToken: "1", retryEpoch: 0 },
    authority: {
      kind: "authoring",
      ownerId: IDS.owner,
      generationRunId: IDS.generationRun,
      courseId: IDS.course,
      courseVersionId: IDS.courseVersion,
      approvalId: IDS.approval,
      approvalDigest: "c".repeat(64),
      candidateDigest,
    },
    input: { kind: "authoring", authoringValidationId: IDS.authoringValidation, candidateDigest },
    purpose: "authoring_validation",
    target: { kind: "authoring_validation", authoringValidationId: IDS.authoringValidation, runStepId: IDS.step },
    step: { stepId: IDS.step, leaseOwner: IDS.stepLeaseOwner, fencingToken: "2" },
    logicalExecutionId: IDS.logical,
    executionAttempt: 1,
    retryOfExecutionId: null,
    idempotencyKey: IDS.idempotency,
    requestDigest: "0".repeat(64),
    source,
    sourceDigest: pythonSourceDigest(source),
    cases: [{ id: "hidden_behavior", input: { value: 3 } }],
    runtimeProfile: PYTHON_RUNTIME_PROFILE,
    runtimeDigest: PYTHON_RUNTIME_DIGEST,
    runtimeImage: PYTHON_SANDBOX_IMAGE,
    imageDigest: PYTHON_IMAGE_SHA256,
    runnerDigest: PYTHON_RUNNER_SHA256,
    deadlineAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
  return validatePythonExecutionRequest({
    ...draft,
    requestDigest: pythonExecutionRequestDigest(draft),
  }) as Extract<PythonExecutionRequest, { purpose: "authoring_validation" }>;
}

