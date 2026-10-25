import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { JsonValue } from "@/domain/common";
import { PythonArtifactConfigSchema } from "@/domain/mechanic-families/v3/python";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { advancePythonCase } from "@/server/course-validation/python-cases";
import { COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import type { PythonExecutionPort, PythonExecutionRequest } from "@/server/execution/python";
import { PYTHON_IMAGE_SHA256, PYTHON_RUNNER_SHA256, PYTHON_RUNTIME_DIGEST, PYTHON_SANDBOX_IMAGE } from "@/server/execution/python/profile";
import type { DbTransaction } from "@/server/db";
import type { DurableStep, RunContext, StepEffectContext } from "@/server/runs/ports";
import type { ModelPort } from "@/server/ai/ports";
import { id } from "../../course-generation/fixtures";

const approvalDigest = "a".repeat(64);
const source = "def solve(payload):\n    return payload * payload\n";
const config = PythonArtifactConfigSchema.parse({
  kind: "artifact_construction", artifactType: "python_function", language: "python",
  runtimeProfile: "python_stdlib_v1", entrypoint: "solve", specification: "Return the square of the input.",
  inputShape: { type: "number", integer: true, minimum: -10, maximum: 10 },
  outputShape: { type: "number", integer: true, minimum: 0, maximum: 100 },
  starterSource: "def solve(payload):\n    return payload + payload\n",
  publicCases: [{ id: "public_two", input: 2 }],
});
const task = {
  id: id(800), taskVersion: 1, mechanicId: "artifact_construction" as const, mechanicVersion: 3,
  outcomeIds: [id(801)], instruction: "Implement the square function.", contentLanguage: "en",
  config, availableHints: 1, responseSchemaVersion: 3,
};
const candidate = prepareTaskCandidate({ task, privateTask: {
  taskId: task.id, taskVersion: 1,
  evaluationSpec: { kind: "execution", executorId: "python_stdlib_v1", dialect: "python3.14",
    testSetId: id(802), resourceLimits: { timeoutMs: 3000, memoryMb: 256 } },
  sourceClaimIds: [], hints: ["Use multiplication."], workedExample: null,
  evaluatorData: { testSetId: id(802), hiddenCases: [{ id: "hidden_negative", input: -3, expected: 9, dimensionId: "behavior" }],
    comparator: { kind: "json_exact" }, requiredDimensions: ["behavior"] },
  assessment: { evidenceGroupId: id(803), role: "required", outcomes: [{ outcomeId: id(801),
    dimensions: [{ dimensionId: "square", evaluationDimensionIds: ["behavior"] }] }] },
} }, { approvalDigest });
const test = { caseId: id(804), key: "valid_square", category: "valid" as const,
  response: { kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source } };

function binding(): ApprovedBuildBinding {
  return {
    run: { id: id(810) }, course: { id: id(811), ownerId: id(812) }, version: { id: id(813) },
    approval: { id: id(814), contentDigest: approvalDigest },
  } as unknown as ApprovedBuildBinding;
}

function completed(request: Extract<PythonExecutionRequest, { purpose: "authoring_validation" }>) {
  return {
    status: "completed" as const,
    executionId: request.executionId,
    input: request.input,
    purpose: request.purpose,
    sourceDigest: request.sourceDigest,
    runtimeProfile: request.runtimeProfile,
    cases: request.cases.map(({ id: caseId }, index) => ({ id: caseId,
      result: { status: "ok" as const, value: index === 0 ? 4 : 9, stdout: "" } })),
    audit: { sandboxId: "sbx", sessionId: "session", providerCommandIds: ["public-command", "hidden-command"],
      image: PYTHON_SANDBOX_IMAGE, imageDigest: PYTHON_IMAGE_SHA256, runnerDigest: PYTHON_RUNNER_SHA256,
      runtimeDigest: PYTHON_RUNTIME_DIGEST, startedAt: "2026-10-25T00:00:00.000Z",
      finishedAt: "2026-10-25T00:00:01.000Z", cleanup: "deleted" as const },
  };
}

describe("durable Python authoring cases", () => {
  it("binds the current execution fence before one combined VM and grades its hidden projection on a later advance", async () => {
    const saved = new Map<string, { id: string; inputDigest: string; result: JsonValue }>();
    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    let sequence = 0;
    const digests = { schema: COURSE_GENERATION_SCHEMA_DIGEST, capability: getCapabilityCatalogDigest(),
      validationPolicy: COURSE_VALIDATION_POLICY_DIGEST, approval: approvalDigest };
    const tx: DbTransaction = { async query<Row>(sql: string, values: unknown[] = []) {
      if (sql.includes("WITH RECURSIVE lineage")) {
        const entry = saved.get(String(values[0]));
        return { rows: entry ? [{ id: entry.id, input_digest: entry.inputDigest, result_reference: entry.result,
          schema_digest: digests.schema, capability_digest: digests.capability,
          validation_policy_digest: digests.validationPolicy, approval_digest: digests.approval } as Row] : [], rowCount: entry ? 1 : 0 } as never;
      }
      prepared.push({ sql, values });
      if (sql.includes("SELECT EXISTS")) return { rows: [{ ok: true } as Row], rowCount: 1 } as never;
      return { rows: [], rowCount: 1 } as never;
    } };
    const execute = vi.fn<PythonExecutionPort["execute"]>(async request => {
      if (request.purpose !== "authoring_validation") throw new Error("wrong purpose");
      return completed(request);
    });
    const claim = { jobId: id(820), leaseOwner: id(821), fencingToken: "7", retryEpoch: 0,
      target: { kind: "generation" as const, runId: id(810), ownerId: id(812), conversationId: id(822),
        branchId: id(823), inputMessageId: id(824), courseId: id(811), approvalId: id(814),
        approvalDigest, courseVersionId: id(813) } };
    const context = {
      claim, signal: new AbortController().signal,
      read: async <T>(reader: (transaction: DbTransaction, target: typeof claim.target) => Promise<T>) => reader(tx, claim.target),
      step: async <I extends JsonValue, O extends JsonValue, R extends JsonValue>(spec: DurableStep<I, O, R>) => {
        const stepId = id(830 + sequence++), effect: StepEffectContext = {
          stepId, deadlineAt: Date.now() + 30_000, signal: new AbortController().signal,
          stepFence: { jobId: claim.jobId, jobLeaseOwner: claim.leaseOwner, jobFencingToken: claim.fencingToken,
            retryEpoch: 0, stepId, stepLeaseOwner: id(840 + sequence), stepFencingToken: "3" },
          budgetOperation: vi.fn(() => { throw new Error("Artifact case must not use the model"); }),
        };
        await spec.prepare?.(tx, effect, spec.input);
        const output = spec.outputSchema.parse(await spec.effect(effect, spec.input));
        const result = spec.resultSchema.parse(await spec.commit(tx, output));
        saved.set(stepId, { id: stepId, inputDigest: "b".repeat(64), result });
        saved.set(spec.key, { id: stepId, inputDigest: "b".repeat(64), result });
        return result;
      },
    } as unknown as RunContext;
    const index = new Map<string, string>();
    const common = { context, binding: binding(), index, key: "course/module/task/slot/1/case/valid_square",
      candidateStepId: id(850), casePlanStepId: id(851), candidate, test,
      model: {} as ModelPort, python: { execute } };

    expect(await advancePythonCase(common)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0]![0];
    expect(request.cases).toEqual([{ id: "public_two", input: 2 }, { id: "hidden_negative", input: -3 }]);
    const insert = prepared.find(({ sql }) => sql.includes("INSERT INTO unfurl.python_authoring_validations"));
    expect(insert?.values).toMatchObject({ 0: expect.any(String), 1: claim.jobId, 2: id(830),
      3: id(850), 4: id(851), 5: test.caseId, 30: claim.leaseOwner, 31: "7", 33: expect.any(String), 34: "3" });

    const executionKey = `${common.key}/execute`;
    index.set(executionKey, saved.get(executionKey)!.id);
    expect(await advancePythonCase(common)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);

    index.set(common.key, saved.get(common.key)!.id);
    const replay = await advancePythonCase(common);
    expect(replay?.result).toMatchObject({ rejectedAsInvalid: false, activityEvidenceRef: request.executionId,
      decision: { status: "evaluated", outcome: "correct", dimensions: [{ id: "behavior", status: "met" }] } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
