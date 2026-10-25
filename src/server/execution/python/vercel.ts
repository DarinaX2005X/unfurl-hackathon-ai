import "server-only";
import { PythonProgramResultSchema, canonicalExecutionJson, type PythonProgramResult } from "../../../domain/mechanic-families/v3/python";
import {
  type ExecutionResult,
  type PythonExecutionAudit,
  type PythonExecutionFence,
  type PythonExecutionPersistence,
  type PythonExecutionPort,
  type PythonExecutionRequest,
  type PythonSafeError,
  type PythonUnavailableReason,
  validateExecutionResult,
  validatePythonExecutionRequest,
} from "./contracts";
import {
  PYTHON_PROFILE_LIMITS,
  PYTHON_RUNTIME_PROFILE,
  PYTHON_SANDBOX_IMAGE,
} from "./profile";
import type {
  PythonSandbox,
  PythonSandboxCapabilityGate,
  PythonSandboxCommand,
  PythonSandboxCredentials,
  PythonSandboxSdk,
  PythonSandboxSession,
} from "./sdk";
import { loadVerifiedPythonRunner } from "./runner/asset";

const RUNNER_PATH = "/vercel/sandbox/guest-runner.py";
const SOURCE_PATH = "/vercel/sandbox/submission.py";

class DurableMutationError extends Error {
  constructor(readonly failure: unknown) {
    super("Python durable lifecycle mutation failed");
    this.name = "DurableMutationError";
  }
}

class RuntimeUnavailableError extends Error {
  constructor(readonly reason: PythonUnavailableReason, readonly safe: PythonSafeError) {
    super(safe.message);
    this.name = "RuntimeUnavailableError";
  }
}

interface CleanupResult {
  stopConfirmed: boolean;
  deleteConfirmed: boolean;
  error: PythonSafeError | null;
}

export interface PythonRuntimeClock {
  now(): Date;
}

const systemClock: PythonRuntimeClock = { now: () => new Date() };

function fenceFor(request: PythonExecutionRequest): PythonExecutionFence {
  const job = {
    executionId: request.executionId,
    jobId: request.job.jobId,
    leaseOwner: request.job.leaseOwner,
    fencingToken: request.job.fencingToken,
    retryEpoch: request.job.retryEpoch,
  };
  return request.purpose === "authoring_validation"
    ? { ...job, kind: "authoring", step: request.step }
    : { ...job, kind: "learning" };
}

function expectedResourceName(executionId: string): string {
  return `unfurl-py-${executionId.replaceAll("-", "")}`;
}

function safeError(code: string, message: string): PythonSafeError {
  return { code: code.slice(0, 80), message: message.slice(0, 2_000) };
}

function classifyFailure(error: unknown, callerSignal: AbortSignal, deadlineAt: number): RuntimeUnavailableError {
  if (error instanceof RuntimeUnavailableError) return error;
  if (callerSignal.aborted) return new RuntimeUnavailableError("cancelled", safeError("cancelled", "Python execution was cancelled."));
  if (Date.now() >= deadlineAt) return new RuntimeUnavailableError("deadline_expired", safeError("deadline_expired", "Python execution exceeded its durable deadline."));
  return new RuntimeUnavailableError("transport", safeError("transport", "The isolated Python runtime could not finish safely."));
}

function retryable(reason: PythonUnavailableReason): boolean {
  return !["disabled", "plan", "invalid_profile", "cleanup_pending"].includes(reason);
}

function operationSignal(caller: AbortSignal, deadlineAt: number, timeoutMs: number): AbortSignal {
  caller.throwIfAborted();
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new RuntimeUnavailableError("deadline_expired", safeError("deadline_expired", "Python execution deadline has expired."));
  return AbortSignal.any([caller, AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining)))]);
}

function independentSignal(): AbortSignal {
  return AbortSignal.timeout(PYTHON_PROFILE_LIMITS.cleanupTimeoutMs);
}

function profileMatches(sandbox: PythonSandbox, session: PythonSandboxSession, resourceName: string): boolean {
  const network = session.networkPolicy;
  const denyAll = network === "deny-all" || (
    network !== null && typeof network === "object" && "mode" in network && network.mode === "deny-all"
  );
  return sandbox.name === resourceName && sandbox.image === PYTHON_SANDBOX_IMAGE && sandbox.persistent === false &&
    sandbox.routes.length === 0 && session.vcpus === PYTHON_PROFILE_LIMITS.sandboxVcpus &&
    session.memory === PYTHON_PROFILE_LIMITS.sandboxMemoryMiB &&
    session.timeout === PYTHON_PROFILE_LIMITS.sandboxTimeoutMs && session.sourceSnapshotId === null && denyAll;
}

function parseRunnerResult(command: PythonSandboxCommand, stdout: string, stderr: string): PythonProgramResult {
  if (command.exitCode !== 0 || stderr.length > 0 ||
      Buffer.byteLength(stdout, "utf8") > PYTHON_PROFILE_LIMITS.envelopeBytes + 1 ||
      Buffer.byteLength(stderr, "utf8") > PYTHON_PROFILE_LIMITS.combinedOutputBytes) {
    throw new RuntimeUnavailableError("transport", safeError("invalid_command_envelope", "The isolated runner returned an invalid transport envelope."));
  }
  let envelope: unknown;
  try { envelope = JSON.parse(stdout); }
  catch {
    throw new RuntimeUnavailableError("transport", safeError("invalid_command_json", "The isolated runner returned invalid JSON."));
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new RuntimeUnavailableError("transport", safeError("invalid_command_shape", "The isolated runner returned an invalid result shape."));
  }
  const item = envelope as Record<string, unknown>;
  const candidate = item.status === "ok"
    ? { status: "ok", value: item.value, stdout: item.stdout }
    : { status: "error", code: item.code, message: item.message, line: item.line ?? null, column: item.column ?? null };
  const parsed = PythonProgramResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RuntimeUnavailableError("transport", safeError("invalid_program_result", "The isolated runner result failed host validation."));
  }
  return parsed.data;
}

export class VercelPythonExecutionPort implements PythonExecutionPort {
  constructor(
    private readonly persistence: PythonExecutionPersistence,
    private readonly capability: PythonSandboxCapabilityGate,
    private readonly sdk: PythonSandboxSdk,
    private readonly clock: PythonRuntimeClock = systemClock,
  ) {}

  private async mutate(work: () => Promise<void>): Promise<void> {
    try { await work(); }
    catch (error) { throw new DurableMutationError(error); }
  }

  private audit(
    request: PythonExecutionRequest,
    state: { sandboxId: string | null; sessionId: string | null; commandIds: string[]; startedAt: string | null },
    cleanup: PythonExecutionAudit["cleanup"],
  ): PythonExecutionAudit {
    return {
      sandboxId: state.sandboxId,
      sessionId: state.sessionId,
      providerCommandIds: [...state.commandIds],
      image: request.runtimeImage,
      imageDigest: request.imageDigest,
      runnerDigest: request.runnerDigest,
      runtimeDigest: request.runtimeDigest,
      startedAt: state.startedAt,
      finishedAt: this.clock.now().toISOString(),
      cleanup,
    };
  }

  private unavailable(
    request: PythonExecutionRequest,
    reason: PythonUnavailableReason,
    audit: PythonExecutionAudit,
  ): Extract<ExecutionResult, { status: "unavailable" }> {
    return validateExecutionResult({
      status: "unavailable",
      executionId: request.executionId,
      input: request.input,
      purpose: request.purpose,
      sourceDigest: request.sourceDigest,
      runtimeProfile: request.runtimeProfile,
      reason,
      retryable: retryable(reason),
      audit,
    }, request) as Extract<ExecutionResult, { status: "unavailable" }>;
  }

  private async cleanup(session: PythonSandboxSession | null, sandbox: PythonSandbox | null): Promise<CleanupResult> {
    let stopConfirmed = session === null;
    let deleteConfirmed = sandbox === null;
    let error: PythonSafeError | null = null;
    if (session !== null) {
      try {
        const stopped = await session.stop({ signal: independentSignal() });
        stopConfirmed = stopped.session.status === "stopped" || stopped.session.status === "aborted";
        if (!stopConfirmed) error = safeError("stop_unconfirmed", "The sandbox session stop was not confirmed.");
      } catch {
        error = safeError("stop_failed", "The sandbox session could not be confirmed stopped.");
      }
    }
    if (sandbox !== null) {
      try {
        await sandbox.delete({ deleteOrphanSnapshots: true, signal: independentSignal() });
        deleteConfirmed = true;
      } catch {
        error = safeError("delete_failed", "The sandbox deletion could not be confirmed.");
      }
    }
    return { stopConfirmed, deleteConfirmed, error };
  }

  private async exactUnknownCreateCleanup(
    credentials: PythonSandboxCredentials,
    resourceName: string,
  ): Promise<{ cleanup: "not_created" | "deleted" | "pending"; error: PythonSafeError | null }> {
    try {
      const outcome = await this.sdk.deleteExact({ ...credentials, name: resourceName, signal: independentSignal() });
      return { cleanup: outcome === "not_found" ? "not_created" : "deleted", error: null };
    } catch {
      return { cleanup: "pending", error: safeError("delete_exact_failed", "The ambiguous sandbox could not be reconciled safely.") };
    }
  }

  async execute(value: PythonExecutionRequest, callerSignal: AbortSignal): Promise<ExecutionResult> {
    const request = validatePythonExecutionRequest(value);
    const runner = await loadVerifiedPythonRunner();
    const fence = fenceFor(request);
    const state = { sandboxId: null as string | null, sessionId: null as string | null, commandIds: [] as string[], startedAt: null as string | null };
    const reservation = await this.persistence.reserveCreate(request);
    if (reservation.status !== "dispatch") return validateExecutionResult(reservation.result, request);
    const resourceName = expectedResourceName(request.executionId);
    if (reservation.resourceName !== resourceName) throw new Error("Durable Python resource identity mismatch");

    const deadlineAt = Date.parse(request.deadlineAt);
    if (deadlineAt <= this.clock.now().getTime()) {
      const error = safeError("deadline_expired", "Python execution deadline has expired.");
      const result = this.unavailable(request, "deadline_expired", this.audit(request, state, "not_created"));
      await this.mutate(() => this.persistence.recordUnavailable(fence, result, error));
      return result;
    }

    let credentials: PythonSandboxCredentials;
    try {
      const decision = await this.capability.inspect(operationSignal(callerSignal, deadlineAt, PYTHON_PROFILE_LIMITS.capabilityTimeoutMs));
      if (decision.status === "unavailable") {
        const error = safeError(`capability_${decision.reason}`, "The Python sandbox capability is unavailable.");
        const result = this.unavailable(request, decision.reason, this.audit(request, state, "not_created"));
        await this.mutate(() => this.persistence.recordUnavailable(fence, result, error));
        return result;
      }
      credentials = decision.credentials;
      await this.mutate(() => this.persistence.recordCapabilityAuthorized(fence, decision.evidence));
    } catch (error) {
      if (error instanceof DurableMutationError) throw error;
      const failure = classifyFailure(error, callerSignal, deadlineAt);
      const result = this.unavailable(request, failure.reason, this.audit(request, state, "not_created"));
      await this.mutate(() => this.persistence.recordUnavailable(fence, result, failure.safe));
      return result;
    }

    let sandbox: PythonSandbox | null = null;
    let session: PythonSandboxSession | null = null;
    let cases: Array<{ id: string; result: PythonProgramResult }> = [];
    let failure: RuntimeUnavailableError | DurableMutationError | null = null;

    try {
      try {
        sandbox = await this.sdk.create({
          ...credentials,
          name: resourceName,
          image: PYTHON_SANDBOX_IMAGE,
          resources: { vcpus: 1 },
          timeout: 60_000,
          persistent: false,
          networkPolicy: "deny-all",
          ports: [],
          env: {},
          tags: { purpose: "unfurl-python-execution", execution: request.executionId },
          signal: operationSignal(callerSignal, deadlineAt, PYTHON_PROFILE_LIMITS.createTimeoutMs),
        });
      } catch {
        const ambiguous = safeError("create_ambiguous", "Sandbox creation did not return a conclusive result.");
        try {
          await this.mutate(() => this.persistence.markCreateAmbiguous(fence, { at: this.clock.now().toISOString(), error: ambiguous }));
          await this.mutate(() => this.persistence.recordCleanupPending(fence, { at: this.clock.now().toISOString(), error: ambiguous }));
        } catch (durableError) {
          await this.exactUnknownCreateCleanup(credentials, resourceName);
          throw durableError;
        }
        const reconciled = await this.exactUnknownCreateCleanup(credentials, resourceName);
        if (reconciled.cleanup === "pending") {
          return this.unavailable(request, "cleanup_pending", this.audit(request, state, "pending"));
        }
        const result = this.unavailable(request, "create_ambiguous", this.audit(request, state, reconciled.cleanup));
        await this.mutate(() => this.persistence.recordUnavailable(fence, result, ambiguous));
        return result;
      }

      session = sandbox.currentSession();
      state.sandboxId = sandbox.name;
      state.sessionId = session.sessionId;
      state.startedAt = this.clock.now().toISOString();
      await this.mutate(() => this.persistence.recordSandboxCreated(fence, {
        sandboxId: state.sandboxId!, sessionId: state.sessionId!, createdAt: state.startedAt!,
      }));
      if (!profileMatches(sandbox, session, resourceName)) {
        throw new RuntimeUnavailableError("invalid_profile", safeError("invalid_profile", "The sandbox did not match the verified Python profile."));
      }

      const files: Array<{ path: string; content: string | Uint8Array; mode: number }> = [
        { path: RUNNER_PATH, content: runner, mode: 0o500 },
        { path: SOURCE_PATH, content: request.source, mode: 0o400 },
        ...request.cases.map((item, index) => ({
          path: `/vercel/sandbox/cases/case-${index}.json`, content: canonicalExecutionJson(item.input), mode: 0o400,
        })),
      ];
      await session.writeFiles(files, {
        signal: operationSignal(callerSignal, deadlineAt, PYTHON_PROFILE_LIMITS.uploadTimeoutMs),
      });

      cases = [];
      for (let index = 0; index < request.cases.length; index += 1) {
        const item = request.cases[index]!;
        const command = await session.runCommand({
          cmd: "unshare",
          args: ["--mount", "--propagation", "private", "--fork", "python3", RUNNER_PATH, SOURCE_PATH,
            `/vercel/sandbox/cases/case-${index}.json`, item.id],
          sudo: true,
          timeoutMs: PYTHON_PROFILE_LIMITS.commandTimeoutMs,
          signal: operationSignal(callerSignal, deadlineAt, PYTHON_PROFILE_LIMITS.commandTimeoutMs),
          detached: false,
          onStart: async (started) => {
            await this.mutate(() => this.persistence.recordCommandStarted(fence, {
              caseId: item.id, commandId: started.cmdId, startedAt: this.clock.now().toISOString(),
            }));
            state.commandIds.push(started.cmdId);
          },
        });
        if (!state.commandIds.includes(command.cmdId)) {
          throw new RuntimeUnavailableError("transport", safeError("command_identity", "The sandbox command identity was not durably recorded."));
        }
        const readSignal = operationSignal(callerSignal, deadlineAt, PYTHON_PROFILE_LIMITS.outputReadTimeoutMs);
        const [stdout, stderr] = await Promise.all([
          command.stdout({ signal: readSignal }),
          command.stderr({ signal: readSignal }),
        ]);
        cases.push({ id: item.id, result: parseRunnerResult(command, stdout, stderr) });
      }
      callerSignal.throwIfAborted();
    } catch (error) {
      failure = error instanceof DurableMutationError ? error : classifyFailure(error, callerSignal, deadlineAt);
    }

    try {
      await this.mutate(() => this.persistence.recordCleanupPending(fence, {
        at: this.clock.now().toISOString(),
        error: failure instanceof RuntimeUnavailableError ? failure.safe : null,
      }));
    } catch (error) {
      const cleanup = await this.cleanup(session, sandbox);
      void cleanup;
      throw error;
    }
    const cleanup = await this.cleanup(session, sandbox);
    if (!cleanup.deleteConfirmed) {
      return this.unavailable(request, "cleanup_pending", this.audit(request, state, "pending"));
    }
    if (failure instanceof DurableMutationError) throw failure;
    if (failure !== null || !cleanup.stopConfirmed) {
      const unavailable = failure ?? new RuntimeUnavailableError("provider", cleanup.error ?? safeError("stop_unconfirmed", "Sandbox cleanup was incomplete."));
      const result = this.unavailable(request, unavailable.reason, this.audit(request, state, "deleted"));
      await this.mutate(() => this.persistence.recordUnavailable(fence, result, unavailable.safe));
      return result;
    }

    const result = validateExecutionResult({
      status: "completed",
      executionId: request.executionId,
      input: request.input,
      purpose: request.purpose,
      sourceDigest: request.sourceDigest,
      runtimeProfile: PYTHON_RUNTIME_PROFILE,
      cases,
      audit: this.audit(request, state, "deleted"),
    }, request) as Extract<ExecutionResult, { status: "completed" }>;
    await this.mutate(() => this.persistence.recordCompleted(fence, result));
    return result;
  }
}

export { expectedResourceName as pythonExecutionResourceName };

