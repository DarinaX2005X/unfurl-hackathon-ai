import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type {
  ExecutionResult,
  PythonCreateReservation,
  PythonExecutionFence,
  PythonExecutionPersistence,
  PythonSafeError,
} from "../../../src/server/execution/python/contracts";
import { PYTHON_PROFILE_LIMITS, PYTHON_SANDBOX_IMAGE } from "../../../src/server/execution/python/profile";
import type {
  PythonSandbox,
  PythonSandboxCapabilityGate,
  PythonSandboxCapabilityEvidence,
  PythonSandboxCommand,
  PythonSandboxCreateInput,
  PythonSandboxSdk,
  PythonSandboxSession,
} from "../../../src/server/execution/python/sdk";
import { VercelPythonExecutionPort, pythonExecutionResourceName } from "../../../src/server/execution/python/vercel";
import { authoringExecutionRequest, executionRequest, IDS } from "./fixtures";

class MemoryPersistence implements PythonExecutionPersistence {
  readonly events: string[] = [];
  completed: Extract<ExecutionResult, { status: "completed" }> | null = null;
  unavailable: Extract<ExecutionResult, { status: "unavailable" }> | null = null;
  sandboxFence: PythonExecutionFence | null = null;
  failCommand = false;
  failCapability = false;
  constructor(public reservation: PythonCreateReservation | null = null, private readonly trace?: string[]) {}
  private push(event: string): void {
    this.events.push(event);
    this.trace?.push(event);
  }
  async reserveCreate(request: ReturnType<typeof executionRequest>): Promise<PythonCreateReservation> {
    this.push("persist:reserve");
    return this.reservation ?? { status: "dispatch", resourceName: pythonExecutionResourceName(request.executionId) };
  }
  async recordCapabilityAuthorized(_fence: PythonExecutionFence, evidence: PythonSandboxCapabilityEvidence): Promise<void> {
    this.push(`persist:capability:${evidence.source}:${evidence.plan}`);
    if (this.failCapability) throw new Error("stale capability fence");
  }
  async recordSandboxCreated(fence: PythonExecutionFence, evidence: { sandboxId: string; sessionId: string }): Promise<void> {
    this.sandboxFence = fence;
    this.push(`persist:sandbox:${evidence.sandboxId}:${evidence.sessionId}`);
  }
  async recordCommandStarted(_fence: PythonExecutionFence, evidence: { caseId: string; commandId: string }): Promise<void> {
    this.push(`persist:command:${evidence.caseId}:${evidence.commandId}`);
    if (this.failCommand) throw new Error("stale fence");
  }
  async markCreateAmbiguous(): Promise<void> { this.push("persist:ambiguous"); }
  async recordCleanupPending(): Promise<void> { this.push("persist:cleanup_pending"); }
  async recordUnavailable(
    _fence: PythonExecutionFence,
    result: Extract<ExecutionResult, { status: "unavailable" }>,
    _error: PythonSafeError,
  ): Promise<void> {
    void _error;
    this.push("persist:unavailable");
    this.unavailable = result;
  }
  async recordCompleted(_fence: PythonExecutionFence, result: Extract<ExecutionResult, { status: "completed" }>): Promise<void> {
    this.push("persist:completed");
    this.completed = result;
  }
}

interface HarnessOptions {
  executionId?: string;
  createBarrier?: () => Promise<void>;
  createError?: boolean;
  exactDeleteError?: boolean;
  exactDelete?: "deleted" | "not_found";
  memory?: number;
  abortOnRun?: AbortController;
  stopError?: boolean;
  deleteError?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const uploads: Array<{ path: string; content: string | Uint8Array; mode?: number }> = [];
  let commandIndex = 0;
  const session: PythonSandboxSession = {
    sessionId: "session-1",
    status: "running",
    timeout: 60_000,
    networkPolicy: "deny-all",
    sourceSnapshotId: null,
    memory: options.memory ?? 2_048,
    vcpus: 1,
    region: "iad1",
    async writeFiles(files) {
      events.push("session:write");
      uploads.push(...files);
    },
    async runCommand(input): Promise<PythonSandboxCommand> {
      const id = `cmd-${++commandIndex}`;
      events.push(`session:run:${id}`);
      await input.onStart({ cmdId: id });
      events.push(`session:started:${id}`);
      if (options.abortOnRun) {
        options.abortOnRun.abort(new DOMException("cancelled", "AbortError"));
        throw options.abortOnRun.signal.reason;
      }
      return {
        cmdId: id,
        exitCode: 0,
        durationMs: 10,
        async stdout() { return JSON.stringify({ status: "ok", value: 6, stdout: "", audit: {} }); },
        async stderr() { return ""; },
      };
    },
    async stop() {
      events.push("session:stop");
      if (options.stopError) throw new Error("stop failed");
      return { session: { status: "stopped", stoppedAt: Date.now() } };
    },
  };
  const sandbox: PythonSandbox = {
    name: pythonExecutionResourceName(options.executionId ?? executionRequest().executionId),
    image: PYTHON_SANDBOX_IMAGE,
    persistent: false,
    routes: [],
    currentSession() { events.push("sandbox:currentSession"); return session; },
    async delete() {
      events.push("sandbox:delete");
      if (options.deleteError) throw new Error("delete failed");
    },
  };
  let createInput: PythonSandboxCreateInput | null = null;
  const sdk: PythonSandboxSdk = {
    async create(input) {
      createInput = input;
      events.push("sdk:create");
      await options.createBarrier?.();
      if (options.createError) throw new Error("unknown create outcome");
      return sandbox;
    },
    async deleteExact() {
      events.push("sdk:deleteExact");
      if (options.exactDeleteError) throw new Error("delete exact failed");
      return options.exactDelete ?? "not_found";
    },
  };
  const capability: PythonSandboxCapabilityGate = {
    async inspect() {
      events.push("gate:inspect");
      return {
        status: "available",
        credentials: { token: "secret-host-token", teamId: "team_1", projectId: "prj_1" },
        evidence: {
          source: "vercel_oidc_signed_claim_v1", teamId: "team_1", projectId: "prj_1", environment: "production",
          issuer: "https://oidc.vercel.com/team", subject: "owner:team:project:project:environment:production",
          issuedAt: "2026-10-25T00:00:00.000Z", expiresAt: "2026-10-25T01:00:00.000Z", plan: "hobby",
          runtimeProfile: "python_stdlib_v1", image: PYTHON_SANDBOX_IMAGE,
          imageDigest: "3bc79de820271c18e2506c132ce20cc15c6215c0ae5725575b1d8e37ecca0218",
          runnerDigest: "9702abefd2e0d2ff2da4f7dd16aa845d9d27f346cd4028f407cac647cc464565",
          runtimeDigest: executionRequest().runtimeDigest,
        },
      };
    },
  };
  return { events, uploads, session, sandbox, sdk, capability, get createInput() { return createInput; } };
}

function replayResult(): ExecutionResult {
  const request = executionRequest();
  return {
    status: "completed",
    executionId: request.executionId,
    input: request.input,
    purpose: request.purpose,
    sourceDigest: request.sourceDigest,
    runtimeProfile: request.runtimeProfile,
    cases: [{ id: "public_case", result: { status: "ok", value: 6, stdout: "" } }],
    audit: {
      sandboxId: "sandbox", sessionId: "session", providerCommandIds: ["cmd"], image: request.runtimeImage,
      imageDigest: request.imageDigest, runnerDigest: request.runnerDigest, runtimeDigest: request.runtimeDigest,
      startedAt: "2026-10-25T00:00:00.000Z", finishedAt: "2026-10-25T00:00:01.000Z", cleanup: "deleted",
    },
  };
}

describe("Vercel Python lifecycle", () => {
  it("executes independent jobs with shared credentials concurrently and cleans up each exact sandbox", async () => {
    const first = executionRequest();
    const second = executionRequest({ executionId: IDS.task, logicalExecutionId: IDS.session, idempotencyKey: IDS.enrollment,
      job: { ...first.job, jobId: IDS.attempt }, target: { kind: "activity_action", activityActionId: IDS.testSet } });
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const createBarrier = async () => { if (++entered === 2) release(); await barrier; };
    const left = harness({ executionId: first.executionId, createBarrier });
    const right = harness({ executionId: second.executionId, createBarrier });
    const results = await Promise.all([left, right].map((h, index) => new VercelPythonExecutionPort(new MemoryPersistence(), h.capability, h.sdk)
      .execute(index === 0 ? first : second, new AbortController().signal)));
    expect(entered).toBe(2);
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(results.map((result) => result.audit.sandboxId)).toEqual([pythonExecutionResourceName(first.executionId), pythonExecutionResourceName(second.executionId)]);
    expect(left.createInput?.token).toBe(right.createInput?.token);
    for (const h of [left, right]) {
      expect(h.events.filter((event) => event === "session:stop")).toHaveLength(1);
      expect(h.events.filter((event) => event === "sandbox:delete")).toHaveLength(1);
    }
  });
  it("persists identities before side effects, uses the fixed session and completes only after stop/delete", async () => {
    const h = harness();
    const persistence = new MemoryPersistence(null, h.events);
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(h.events.filter((event) => event === "sandbox:currentSession")).toHaveLength(1);
    expect(persistence.events).toEqual([
      "persist:reserve",
      "persist:capability:vercel_oidc_signed_claim_v1:hobby",
      `persist:sandbox:${pythonExecutionResourceName(executionRequest().executionId)}:session-1`,
      "persist:command:public_case:cmd-1",
      "persist:cleanup_pending",
      "persist:completed",
    ]);
    expect(h.events.indexOf("session:started:cmd-1")).toBeGreaterThan(h.events.indexOf("session:run:cmd-1"));
    expect(persistence.events.indexOf("persist:command:public_case:cmd-1")).toBeLessThan(persistence.events.indexOf("persist:completed"));
    expect(h.events).toEqual([
      "persist:reserve", "gate:inspect", "persist:capability:vercel_oidc_signed_claim_v1:hobby",
      "sdk:create", "sandbox:currentSession",
      `persist:sandbox:${pythonExecutionResourceName(executionRequest().executionId)}:session-1`,
      "session:write", "session:run:cmd-1", "persist:command:public_case:cmd-1",
      "session:started:cmd-1", "persist:cleanup_pending", "session:stop", "sandbox:delete", "persist:completed",
    ]);
    expect(h.createInput).toMatchObject({
      image: PYTHON_SANDBOX_IMAGE, resources: { vcpus: 1 }, timeout: 60_000,
      persistent: false, networkPolicy: "deny-all", ports: [], env: {},
    });
    expect(h.uploads.map(({ path }) => path)).toEqual([
      "/vercel/sandbox/guest-runner.py",
      "/vercel/sandbox/submission.py",
      "/vercel/sandbox/cases/case-0.json",
    ]);
    expect(h.uploads.some(({ content }) => typeof content === "string" && content.includes("secret-host-token"))).toBe(false);
  });

  it("carries both job and validation-step fencing through every authoring lifecycle mutation", async () => {
    const persistence = new MemoryPersistence();
    const h = harness();
    const request = authoringExecutionRequest();
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(request, new AbortController().signal);
    expect(result).toMatchObject({
      status: "completed",
      purpose: "authoring_validation",
      input: request.input,
    });
    expect(persistence.sandboxFence).toEqual({
      kind: "authoring",
      executionId: request.executionId,
      jobId: request.job.jobId,
      leaseOwner: request.job.leaseOwner,
      fencingToken: request.job.fencingToken,
      retryEpoch: request.job.retryEpoch,
      step: request.step,
    });
  });

  it("returns a durable replay without inspecting capability or creating a VM", async () => {
    const persistence = new MemoryPersistence({ status: "replay", result: replayResult() });
    const h = harness();
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(h.events).toEqual([]);
    expect(persistence.events).toEqual(["persist:reserve"]);
  });

  it("never creates a VM when durable signed-capability evidence loses its fence", async () => {
    const persistence = new MemoryPersistence();
    persistence.failCapability = true;
    const h = harness();
    await expect(new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal)).rejects.toMatchObject({ name: "DurableMutationError" });
    expect(h.events).toEqual(["gate:inspect"]);
    expect(persistence.events).toEqual([
      "persist:reserve", "persist:capability:vercel_oidc_signed_claim_v1:hobby",
    ]);
  });

  it("records an expired durable deadline without inspecting capability or creating a VM", async () => {
    const persistence = new MemoryPersistence();
    const h = harness();
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest({ deadlineAt: "2020-01-01T00:00:00.000Z" }), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "deadline_expired", audit: { cleanup: "not_created" } });
    expect(h.events).toEqual([]);
    expect(persistence.events).toEqual(["persist:reserve", "persist:unavailable"]);
  });

  it("reconciles an unknown create by exact name and never dispatches a replacement", async () => {
    const persistence = new MemoryPersistence();
    const h = harness({ createError: true, exactDelete: "deleted" });
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "create_ambiguous", audit: { cleanup: "deleted" } });
    expect(h.events.filter((event) => event === "sdk:create")).toHaveLength(1);
    expect(h.events.filter((event) => event === "sdk:deleteExact")).toHaveLength(1);
    expect(persistence.events).toEqual([
      "persist:reserve", "persist:capability:vercel_oidc_signed_claim_v1:hobby",
      "persist:ambiguous", "persist:cleanup_pending", "persist:unavailable",
    ]);
  });

  it("retains the execution as cleanup_pending when exact reconciliation is unconfirmed", async () => {
    const persistence = new MemoryPersistence();
    const h = harness({ createError: true, exactDeleteError: true });
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "cleanup_pending", retryable: false, audit: { cleanup: "pending" } });
    expect(persistence.unavailable).toBeNull();
    expect(persistence.events).toEqual([
      "persist:reserve", "persist:capability:vercel_oidc_signed_claim_v1:hobby",
      "persist:ambiguous", "persist:cleanup_pending",
    ]);
  });

  it("retains a provider quota refusal without creating or retrying a sandbox", async () => {
    const persistence = new MemoryPersistence();
    const h = harness();
    const capability: PythonSandboxCapabilityGate = { inspect: async () => ({ status: "unavailable", reason: "quota" }) };
    const result = await new VercelPythonExecutionPort(persistence, capability, h.sdk).execute(executionRequest(), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "quota", audit: { cleanup: "not_created" } });
    expect(h.events).not.toContain("sdk:create");
    expect(persistence.unavailable).toEqual(result);
  });

  it("uses an independent cleanup signal after caller cancellation", async () => {
    const controller = new AbortController();
    const persistence = new MemoryPersistence();
    const h = harness({ abortOnRun: controller });
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), controller.signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "cancelled", audit: { cleanup: "deleted" } });
    expect(h.events).toContain("session:stop");
    expect(h.events).toContain("sandbox:delete");
    expect(persistence.events.at(-1)).toBe("persist:unavailable");
  });

  it("fails closed before upload if provider readback differs from the proven profile", async () => {
    const persistence = new MemoryPersistence();
    const h = harness({ memory: 1_024 });
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "invalid_profile" });
    expect(h.events).not.toContain("session:write");
    expect(h.events).toContain("sandbox:delete");
  });

  it("does not publish when command identity persistence loses its fence", async () => {
    const persistence = new MemoryPersistence();
    persistence.failCommand = true;
    const h = harness();
    await expect(new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal)).rejects.toMatchObject({ name: "DurableMutationError" });
    expect(h.events).toContain("session:stop");
    expect(h.events).toContain("sandbox:delete");
    expect(persistence.completed).toBeNull();
    expect(persistence.unavailable).toBeNull();
  });

  it("does not mark execution completed when stop confirmation fails", async () => {
    const persistence = new MemoryPersistence();
    const h = harness({ stopError: true });
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "provider", audit: { cleanup: "deleted" } });
    expect(persistence.completed).toBeNull();
  });

  it("keeps deletion failure cleanup-pending even after deterministic learner output", async () => {
    const persistence = new MemoryPersistence();
    const h = harness({ deleteError: true });
    const result = await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", reason: "cleanup_pending", audit: { cleanup: "pending" } });
    expect(persistence.completed).toBeNull();
    expect(persistence.unavailable).toBeNull();
  });

  it("uses the exact proven command and bounds rather than learner-selected shell text", async () => {
    const persistence = new MemoryPersistence();
    const h = harness();
    const run = vi.spyOn(h.session, "runCommand");
    await new VercelPythonExecutionPort(persistence, h.capability, h.sdk)
      .execute(executionRequest(), new AbortController().signal);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      cmd: "unshare",
      sudo: true,
      detached: false,
      timeoutMs: PYTHON_PROFILE_LIMITS.commandTimeoutMs,
      args: expect.arrayContaining(["--mount", "private", "python3", "/vercel/sandbox/guest-runner.py", "/vercel/sandbox/submission.py"]),
    }));
  });
});

