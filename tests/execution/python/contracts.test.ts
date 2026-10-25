import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  buildPythonExecutionRequest,
  ExecutionResultSchema,
  pythonExecutionRequestDigest,
  validateExecutionResult,
  validatePythonExecutionRequest,
} from "../../../src/server/execution/python/contracts";
import {
  PYTHON_RUNNER_SHA256,
  PYTHON_RUNTIME_DIGEST,
  PYTHON_RUNTIME_POLICY,
} from "../../../src/server/execution/python/profile";
import { loadVerifiedPythonRunner } from "../../../src/server/execution/python/runner/asset";
import { authoringExecutionRequest, executionRequest, IDS } from "./fixtures";

describe("Python execution contracts", () => {
  it("binds the exact source and semantic request while retaining a stable retry digest", () => {
    const first = executionRequest();
    expect(validatePythonExecutionRequest(first)).toEqual(first);
    expect(() => validatePythonExecutionRequest({ ...first, source: `${first.source}# changed\n` })).toThrow(/source digest/i);
    const retry = executionRequest({
      executionId: "00000000-0000-4000-8000-000000000010",
      job: { jobId: IDS.job, leaseOwner: IDS.stepLeaseOwner, fencingToken: "2", retryEpoch: 1 },
      executionAttempt: 2,
      retryOfExecutionId: first.executionId,
      idempotencyKey: "00000000-0000-4000-8000-000000000011",
    });
    expect(pythonExecutionRequestDigest(retry)).toBe(first.requestDigest);
    expect(retry.requestDigest).toBe(first.requestDigest);
  });

  it("uses one builder to normalize source and bind the fixed runtime identities", () => {
    const request = executionRequest();
    const {
      sourceDigest: _sourceDigest,
      requestDigest: _requestDigest,
      runtimeProfile: _runtimeProfile,
      runtimeDigest: _runtimeDigest,
      runtimeImage: _runtimeImage,
      imageDigest: _imageDigest,
      runnerDigest: _runnerDigest,
      ...draft
    } = request;
    void [_sourceDigest, _requestDigest, _runtimeProfile, _runtimeDigest, _runtimeImage, _imageDigest, _runnerDigest];
    const built = buildPythonExecutionRequest({ ...draft, source: request.source.replaceAll("\n", "\r\n") });
    expect(built.source).toBe(request.source);
    expect(built.sourceDigest).toBe(request.sourceDigest);
    expect(built.runtimeDigest).toBe(PYTHON_RUNTIME_DIGEST);
    expect(built.requestDigest).toBe(request.requestDigest);
  });

  it("rejects purpose/target mismatches, duplicate cases and too many public cases", () => {
    const base = executionRequest();
    expect(() => validatePythonExecutionRequest({
      ...base,
      target: { kind: "attempt", attemptId: IDS.attempt },
    })).toThrow(/activity_action/i);
    expect(() => executionRequest({ cases: [base.cases[0]!, base.cases[0]!] })).toThrow(/unique/i);
    expect(() => executionRequest({ cases: Array.from({ length: 5 }, (_, index) => ({ id: `case${index}`, input: index })) })).toThrow(/four/i);
  });

  it("binds authoring validation to exact authority, validation identity and dual job/step fences", () => {
    const request = authoringExecutionRequest();
    expect(validatePythonExecutionRequest(request)).toEqual(request);
    expect(request).toMatchObject({
      purpose: "authoring_validation",
      authority: { kind: "authoring", approvalId: IDS.approval, candidateDigest: "b".repeat(64) },
      input: { kind: "authoring", authoringValidationId: IDS.authoringValidation, candidateDigest: "b".repeat(64) },
      target: { kind: "authoring_validation", authoringValidationId: IDS.authoringValidation, runStepId: IDS.step },
      step: { stepId: IDS.step },
      job: { retryEpoch: 0 },
    });
    const refenced = authoringExecutionRequest({
      job: { ...request.job, leaseOwner: IDS.stepLeaseOwner, fencingToken: "7", retryEpoch: 3 },
      step: { ...request.step, leaseOwner: IDS.jobLeaseOwner, fencingToken: "8" },
    });
    expect(refenced.requestDigest).toBe(request.requestDigest);
    expect(() => validatePythonExecutionRequest({
      ...request,
      input: { ...request.input, authoringValidationId: IDS.attempt },
    })).toThrow(/validation identity/i);
    expect(() => validatePythonExecutionRequest({
      ...request,
      input: { ...request.input, candidateDigest: "d".repeat(64) },
    })).toThrow(/candidate digest/i);
    expect(() => validatePythonExecutionRequest({
      ...request,
      step: { ...request.step, stepId: IDS.attempt },
    })).toThrow(/step fence/i);
    expect(() => validatePythonExecutionRequest({
      ...request,
      purpose: "public_run",
    })).toThrow();
  });

  it("allows one bounded authoring pass over public then hidden cases while retaining narrower learning limits", () => {
    const authoring = authoringExecutionRequest({
      cases: Array.from({ length: 12 }, (_, index) => ({ id: `case_${index}`, input: index })),
    });
    expect(authoring.cases).toHaveLength(12);
    expect(() => authoringExecutionRequest({
      cases: Array.from({ length: 13 }, (_, index) => ({ id: `case_${index}`, input: index })),
    })).toThrow();
    const publicRequest = executionRequest();
    const grade = {
      ...publicRequest,
      purpose: "grade" as const,
      target: { kind: "attempt" as const, attemptId: IDS.attempt },
      cases: Array.from({ length: 9 }, (_, index) => ({ id: `hidden_${index}`, input: index })),
    };
    expect(() => validatePythonExecutionRequest({
      ...grade,
      requestDigest: pythonExecutionRequestDigest(grade),
    })).toThrow(/eight hidden/i);
  });

  it("requires completed cases to be exhaustive and in request order", () => {
    const request = executionRequest({ cases: [{ id: "first", input: 1 }, { id: "second", input: 2 }] });
    const result = {
      status: "completed",
      executionId: request.executionId,
      input: request.input,
      purpose: request.purpose,
      sourceDigest: request.sourceDigest,
      runtimeProfile: request.runtimeProfile,
      cases: [
        { id: "second", result: { status: "ok", value: 4, stdout: "" } },
        { id: "first", result: { status: "ok", value: 2, stdout: "" } },
      ],
      audit: {
        sandboxId: "sandbox", sessionId: "session", providerCommandIds: ["cmd1", "cmd2"],
        image: request.runtimeImage, imageDigest: request.imageDigest, runnerDigest: request.runnerDigest,
        runtimeDigest: request.runtimeDigest, startedAt: "2026-10-25T00:00:00.000Z",
        finishedAt: "2026-10-25T00:00:01.000Z", cleanup: "deleted",
      },
    };
    expect(ExecutionResultSchema.safeParse(result).success).toBe(true);
    expect(() => validateExecutionResult(result, request)).toThrow(/request order/i);
  });

  it("keeps authoring and learning result identities structurally disjoint", () => {
    const request = authoringExecutionRequest();
    const result = {
      status: "unavailable",
      executionId: request.executionId,
      input: executionRequest().input,
      purpose: "authoring_validation",
      sourceDigest: request.sourceDigest,
      runtimeProfile: request.runtimeProfile,
      reason: "provider",
      retryable: true,
      audit: {
        sandboxId: null, sessionId: null, providerCommandIds: [], image: request.runtimeImage,
        imageDigest: request.imageDigest, runnerDigest: request.runnerDigest, runtimeDigest: request.runtimeDigest,
        startedAt: null, finishedAt: "2026-10-25T00:00:01.000Z", cleanup: "not_created",
      },
    };
    expect(ExecutionResultSchema.safeParse(result).success).toBe(false);
  });

  it("keeps the content-addressed runner and policy identity stable", async () => {
    const runner = await loadVerifiedPythonRunner();
    expect(Buffer.from(runner).toString("utf8")).toContain("abs(item) > 2**53 - 1");
    expect(Buffer.from(runner).toString("utf8")).toContain("resource.RLIMIT_AS");
    expect((await readFile("src/server/execution/python/runner/guest_runner.py")).equals(Buffer.from(runner))).toBe(true);
    expect(PYTHON_RUNNER_SHA256).toHaveLength(64);
    expect(PYTHON_RUNTIME_DIGEST).toHaveLength(64);
    expect(PYTHON_RUNTIME_POLICY.isolation).toMatchObject({ cgroupLimits: false, landlock: false });
  });
});

