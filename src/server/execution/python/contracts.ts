import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DigestSchema, IdSchema, IsoDateTimeSchema, RevisionSchema } from "../../../domain/common";
import { InputIdentitySchema, type InputIdentity } from "../../../domain/activity";
import { LocalIdSchema } from "../../../domain/mechanic-families/v2/shared";
import {
  ExecutionJsonSchema,
  PYTHON_LIMITS,
  PYTHON_RUNTIME_PROFILE,
  PythonProgramResultSchema,
  PythonSourceSchema,
  type ExecutionJson,
  type PythonProgramResult,
  type PythonSource,
} from "../../../domain/mechanic-families/v3/python";
import { jsonDigest } from "../../ai/json";
import {
  PYTHON_IMAGE_SHA256,
  PYTHON_PROFILE_LIMITS,
  PYTHON_RUNNER_SHA256,
  PYTHON_RUNTIME_DIGEST,
  PYTHON_SANDBOX_IMAGE,
} from "./profile";
import type { PythonSandboxCapabilityEvidence } from "./sdk";

export const PythonExecutionCaseSchema = z.object({ id: LocalIdSchema, input: ExecutionJsonSchema }).strict();
export type PythonExecutionCase = z.infer<typeof PythonExecutionCaseSchema>;

export const PythonExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("activity_action"), activityActionId: IdSchema }).strict(),
  z.object({ kind: z.literal("attempt"), attemptId: IdSchema }).strict(),
  z.object({
    kind: z.literal("authoring_validation"),
    authoringValidationId: IdSchema,
    runStepId: IdSchema,
  }).strict(),
]);
export type PythonExecutionTarget = z.infer<typeof PythonExecutionTargetSchema>;

export const PythonExecutionInputSchema = z.discriminatedUnion("kind", [
  InputIdentitySchema.extend({ kind: z.literal("learning") }).strict(),
  z.object({
    kind: z.literal("authoring"),
    authoringValidationId: IdSchema,
    candidateDigest: DigestSchema,
  }).strict(),
]);
export type PythonExecutionInput = z.infer<typeof PythonExecutionInputSchema>;

export const PythonExecutionAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("learning"),
    learnerId: IdSchema,
    enrollmentId: IdSchema,
    courseVersionId: IdSchema,
    taskId: IdSchema,
    taskVersion: RevisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("authoring"),
    ownerId: IdSchema,
    generationRunId: IdSchema,
    courseId: IdSchema,
    courseVersionId: IdSchema,
    approvalId: IdSchema,
    approvalDigest: DigestSchema,
    candidateDigest: DigestSchema,
  }).strict(),
]);
export type PythonExecutionAuthority = z.infer<typeof PythonExecutionAuthoritySchema>;

const PythonExecutionJobFenceSchema = z.object({
  jobId: IdSchema,
  leaseOwner: IdSchema,
  fencingToken: z.string().regex(/^[1-9][0-9]{0,18}$/),
  retryEpoch: z.number().int().nonnegative().max(2_147_483_647),
}).strict();

const PythonExecutionStepFenceSchema = z.object({
  stepId: IdSchema,
  leaseOwner: IdSchema,
  fencingToken: z.string().regex(/^[1-9][0-9]{0,18}$/),
}).strict();

const requestCommonShape = {
  executionId: IdSchema,
  job: PythonExecutionJobFenceSchema,
  logicalExecutionId: IdSchema,
  executionAttempt: z.number().int().positive(),
  retryOfExecutionId: IdSchema.nullable(),
  idempotencyKey: IdSchema,
  requestDigest: DigestSchema,
  source: PythonSourceSchema,
  sourceDigest: DigestSchema,
  cases: z.array(PythonExecutionCaseSchema).min(1).max(PYTHON_PROFILE_LIMITS.authoringCases),
  runtimeProfile: z.literal(PYTHON_RUNTIME_PROFILE),
  runtimeDigest: z.literal(PYTHON_RUNTIME_DIGEST),
  runtimeImage: z.literal(PYTHON_SANDBOX_IMAGE),
  imageDigest: z.literal(PYTHON_IMAGE_SHA256),
  runnerDigest: z.literal(PYTHON_RUNNER_SHA256),
  deadlineAt: IsoDateTimeSchema,
};

export const PythonExecutionRequestSchema = z.discriminatedUnion("purpose", [
  z.object({ ...requestCommonShape,
    purpose: z.literal("public_run"),
    authority: PythonExecutionAuthoritySchema.options[0],
    input: PythonExecutionInputSchema.options[0],
    target: PythonExecutionTargetSchema.options[0],
  }).strict(),
  z.object({ ...requestCommonShape,
    purpose: z.literal("grade"),
    authority: PythonExecutionAuthoritySchema.options[0],
    input: PythonExecutionInputSchema.options[0],
    target: PythonExecutionTargetSchema.options[1],
  }).strict(),
  z.object({ ...requestCommonShape,
    purpose: z.literal("authoring_validation"),
    authority: PythonExecutionAuthoritySchema.options[1],
    input: PythonExecutionInputSchema.options[1],
    target: PythonExecutionTargetSchema.options[2],
    step: PythonExecutionStepFenceSchema,
  }).strict(),
]).superRefine((request, context) => {
  if ((request.executionAttempt === 1) !== (request.retryOfExecutionId === null)) {
    context.addIssue({ code: "custom", path: ["retryOfExecutionId"], message: "Only later execution attempts identify a retry predecessor" });
  }
  if (request.purpose === "public_run" && request.cases.length > PYTHON_LIMITS.publicCases) {
    context.addIssue({ code: "custom", path: ["cases"], message: "Public runs have at most four cases" });
  }
  if (request.purpose === "grade" && request.cases.length > PYTHON_LIMITS.hiddenCases) {
    context.addIssue({ code: "custom", path: ["cases"], message: "Grades have at most eight hidden cases" });
  }
  if (new Set(request.cases.map((item) => item.id)).size !== request.cases.length) {
    context.addIssue({ code: "custom", path: ["cases"], message: "Execution case identifiers must be unique" });
  }
  if (request.purpose === "authoring_validation") {
    if (request.input.authoringValidationId !== request.target.authoringValidationId) {
      context.addIssue({ code: "custom", path: ["input", "authoringValidationId"], message: "Authoring validation identity must match its target" });
    }
    if (request.input.candidateDigest !== request.authority.candidateDigest) {
      context.addIssue({ code: "custom", path: ["input", "candidateDigest"], message: "Authoring candidate digest must match its authority" });
    }
    if (request.step.stepId !== request.target.runStepId) {
      context.addIssue({ code: "custom", path: ["step", "stepId"], message: "Authoring step fence must match its target" });
    }
  }
});
export type PythonExecutionRequest = z.infer<typeof PythonExecutionRequestSchema>;

type SemanticRequest = Pick<PythonExecutionRequest,
  "authority" | "input" | "purpose" | "target" | "logicalExecutionId" | "source" | "sourceDigest" |
  "cases" | "runtimeProfile" | "runtimeDigest" | "runtimeImage" | "imageDigest" | "runnerDigest">;

function semanticRequest(request: PythonExecutionRequest): SemanticRequest {
  return {
    authority: request.authority,
    input: request.input,
    purpose: request.purpose,
    target: request.target,
    logicalExecutionId: request.logicalExecutionId,
    source: request.source,
    sourceDigest: request.sourceDigest,
    cases: request.cases,
    runtimeProfile: request.runtimeProfile,
    runtimeDigest: request.runtimeDigest,
    runtimeImage: request.runtimeImage,
    imageDigest: request.imageDigest,
    runnerDigest: request.runnerDigest,
  };
}

export function pythonSourceDigest(source: PythonSource): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Stable across a safe retry; execution/fence/idempotency identities are intentionally excluded. */
export function pythonExecutionRequestDigest(request: PythonExecutionRequest): string {
  return jsonDigest(semanticRequest(request), 256 * 1_024);
}

export function validatePythonExecutionRequest(value: unknown): PythonExecutionRequest {
  const request = PythonExecutionRequestSchema.parse(value);
  if (pythonSourceDigest(request.source) !== request.sourceDigest) throw new Error("Python source digest mismatch");
  if (pythonExecutionRequestDigest(request) !== request.requestDigest) throw new Error("Python execution request digest mismatch");
  return request;
}

type RuntimeBoundRequestFields =
  | "sourceDigest" | "requestDigest" | "runtimeProfile" | "runtimeDigest"
  | "runtimeImage" | "imageDigest" | "runnerDigest";

export type PythonExecutionRequestDraft = PythonExecutionRequest extends infer Request
  ? Request extends PythonExecutionRequest ? Omit<Request, RuntimeBoundRequestFields> : never
  : never;

/**
 * The only request builder. It normalizes source through the domain schema and
 * binds every runtime/content digest so learning and authoring adapters cannot
 * choose a different execution profile.
 */
export function buildPythonExecutionRequest(value: PythonExecutionRequestDraft): PythonExecutionRequest {
  const source = PythonSourceSchema.parse(value.source);
  const provisional = {
    ...value,
    source,
    sourceDigest: pythonSourceDigest(source),
    requestDigest: "0".repeat(64),
    runtimeProfile: PYTHON_RUNTIME_PROFILE,
    runtimeDigest: PYTHON_RUNTIME_DIGEST,
    runtimeImage: PYTHON_SANDBOX_IMAGE,
    imageDigest: PYTHON_IMAGE_SHA256,
    runnerDigest: PYTHON_RUNNER_SHA256,
  } as PythonExecutionRequest;
  return validatePythonExecutionRequest({
    ...provisional,
    requestDigest: pythonExecutionRequestDigest(provisional),
  });
}

export const PythonUnavailableReasonSchema = z.enum([
  "disabled", "auth", "plan", "quota", "deadline_expired", "cancelled", "provider",
  "create_ambiguous", "transport", "invalid_profile", "cleanup_pending",
]);
export type PythonUnavailableReason = z.infer<typeof PythonUnavailableReasonSchema>;

export const PythonExecutionAuditSchema = z.object({
  sandboxId: z.string().min(1).max(256).nullable(),
  sessionId: z.string().min(1).max(256).nullable(),
  providerCommandIds: z.array(z.string().min(1).max(256)).max(PYTHON_PROFILE_LIMITS.authoringCases),
  image: z.literal(PYTHON_SANDBOX_IMAGE),
  imageDigest: z.literal(PYTHON_IMAGE_SHA256),
  runnerDigest: z.literal(PYTHON_RUNNER_SHA256),
  runtimeDigest: z.literal(PYTHON_RUNTIME_DIGEST),
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema,
  cleanup: z.enum(["not_created", "deleted", "pending"]),
}).strict();
export type PythonExecutionAudit = z.infer<typeof PythonExecutionAuditSchema>;

const executionResultIdentity = {
  executionId: IdSchema,
  input: PythonExecutionInputSchema,
  purpose: z.enum(["public_run", "grade", "authoring_validation"]),
  sourceDigest: DigestSchema,
  runtimeProfile: z.literal(PYTHON_RUNTIME_PROFILE),
};
function refineExecutionResultScope(
  result: { purpose: "public_run" | "grade" | "authoring_validation"; input: PythonExecutionInput },
  context: z.RefinementCtx,
): void {
  if ((result.purpose === "authoring_validation") !== (result.input.kind === "authoring")) {
    context.addIssue({ code: "custom", path: ["input"], message: "Execution result input must match its purpose" });
  }
}
export const CompletedExecutionResultSchema = z.object({
  status: z.literal("completed"),
  ...executionResultIdentity,
  cases: z.array(z.object({ id: LocalIdSchema, result: PythonProgramResultSchema }).strict())
    .min(1).max(PYTHON_PROFILE_LIMITS.authoringCases),
  audit: PythonExecutionAuditSchema.extend({ cleanup: z.literal("deleted") }).strict(),
}).strict().superRefine(refineExecutionResultScope);
export const UnavailableExecutionResultSchema = z.object({
  status: z.literal("unavailable"),
  ...executionResultIdentity,
  reason: PythonUnavailableReasonSchema,
  retryable: z.boolean(),
  audit: PythonExecutionAuditSchema,
}).strict().superRefine((result, context) => {
  refineExecutionResultScope(result, context);
  if ((result.reason === "cleanup_pending") !== (result.audit.cleanup === "pending")) {
    context.addIssue({ code: "custom", path: ["audit", "cleanup"], message: "Pending cleanup has an explicit unavailable reason" });
  }
});
export const ExecutionResultSchema = z.discriminatedUnion("status", [
  CompletedExecutionResultSchema,
  UnavailableExecutionResultSchema,
]);
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export function validateExecutionResult(value: unknown, request: PythonExecutionRequest): ExecutionResult {
  const result = ExecutionResultSchema.parse(value);
  if (result.executionId !== request.executionId || result.purpose !== request.purpose ||
      result.sourceDigest !== request.sourceDigest || canonicalExecutionInput(result.input) !== canonicalExecutionInput(request.input)) {
    throw new Error("Python execution result identity mismatch");
  }
  if (result.status === "completed") {
    const actual = result.cases.map((item) => item.id);
    const expected = request.cases.map((item) => item.id);
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
      throw new Error("Python execution cases must be unique, exhaustive and in request order");
    }
  }
  return result;
}

function canonicalExecutionInput(input: PythonExecutionInput): string {
  return input.kind === "learning"
    ? `learning:${input.activitySessionId}:${input.inputRevision}:${input.responseDigest}`
    : `authoring:${input.authoringValidationId}:${input.candidateDigest}`;
}

interface PythonExecutionJobMutationFence {
  readonly executionId: string;
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly fencingToken: string;
  readonly retryEpoch: number;
}

export type PythonExecutionFence =
  | (PythonExecutionJobMutationFence & { readonly kind: "learning" })
  | (PythonExecutionJobMutationFence & {
      readonly kind: "authoring";
      readonly step: {
        readonly stepId: string;
        readonly leaseOwner: string;
        readonly fencingToken: string;
      };
    });

export type PythonCreateReservation =
  | { readonly status: "dispatch"; readonly resourceName: string }
  | { readonly status: "replay"; readonly result: ExecutionResult }
  | { readonly status: "unavailable"; readonly result: ExecutionResult };

export interface PythonSafeError {
  readonly code: string;
  readonly message: string;
}

export interface PythonExecutionPersistence {
  reserveCreate(request: PythonExecutionRequest): Promise<PythonCreateReservation>;
  /** Persist sanitized signed authorization before any provider create call. */
  recordCapabilityAuthorized(fence: PythonExecutionFence, evidence: PythonSandboxCapabilityEvidence): Promise<void>;
  recordSandboxCreated(fence: PythonExecutionFence, evidence: {
    readonly sandboxId: string;
    readonly sessionId: string;
    readonly createdAt: string;
  }): Promise<void>;
  recordCommandStarted(fence: PythonExecutionFence, evidence: {
    readonly caseId: string;
    readonly commandId: string;
    readonly startedAt: string;
  }): Promise<void>;
  markCreateAmbiguous(fence: PythonExecutionFence, evidence: {
    readonly at: string;
    readonly error: PythonSafeError;
  }): Promise<void>;
  recordCleanupPending(fence: PythonExecutionFence, evidence: {
    readonly at: string;
    readonly error: PythonSafeError | null;
  }): Promise<void>;
  recordUnavailable(
    fence: PythonExecutionFence,
    result: Extract<ExecutionResult, { status: "unavailable" }>,
    error: PythonSafeError,
  ): Promise<void>;
  recordCompleted(
    fence: PythonExecutionFence,
    result: Extract<ExecutionResult, { status: "completed" }>,
  ): Promise<void>;
}

export interface PythonExecutionPort {
  execute(request: PythonExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
}

/** Bound by the trusted learning worker to one durable job/attempt and immutable input identity. */
export interface PythonEvaluationPort {
  execute(input: {
    readonly source: PythonSource;
    readonly cases: readonly { readonly id: string; readonly input: ExecutionJson }[];
    readonly runtimeProfile: typeof PYTHON_RUNTIME_PROFILE;
  }, signal: AbortSignal): Promise<ExecutionResult>;
}

export type { ExecutionJson, InputIdentity, PythonProgramResult, PythonSource };

