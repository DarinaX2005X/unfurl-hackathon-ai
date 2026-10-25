import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { TaskPublic } from "../../../src/domain/mechanics";
import {
  PythonArtifactConfigSchema,
  PythonRepairConfigSchema,
  type PythonArtifactConfig,
  type PythonArtifactResponse,
  type PythonRepairConfig,
  type PythonRepairResponse,
} from "../../../src/domain/mechanic-families/v3/python";
import type { EvaluationContext, RubricJudge } from "../../../src/server/evaluation/contracts";
import {
  PythonArtifactPrivateSchema,
  PythonRepairPrivateSchema,
  pythonArtifactEvaluator,
  pythonRepairEvaluator,
  type PythonArtifactPrivate,
  type PythonRepairPrivate,
} from "../../../src/server/evaluation/python";
import {
  pythonSourceDigest,
  type ExecutionResult,
  type PythonEvaluationPort,
} from "../../../src/server/execution/python/contracts";
import { PYTHON_IMAGE_SHA256, PYTHON_RUNNER_SHA256, PYTHON_RUNTIME_DIGEST, PYTHON_SANDBOX_IMAGE } from "../../../src/server/execution/python/profile";
import { IDS } from "./fixtures";

const correctSource = "def solve(payload):\n    return payload * payload\n";
const alternativeSource = "def solve(payload):\n    return pow(payload, 2)\n";
const originalSource = "def solve(payload):\n    return payload + payload\n";
const baseConfig = {
  artifactType: "python_function" as const,
  language: "python" as const,
  runtimeProfile: "python_stdlib_v1" as const,
  entrypoint: "solve" as const,
  specification: "Return the square of the integer input.",
  inputShape: { type: "number" as const, integer: true, minimum: -10, maximum: 10 },
  outputShape: { type: "number" as const, integer: true, minimum: 0, maximum: 100 },
  starterSource: originalSource,
  publicCases: [{ id: "public_two", input: 2 }],
};
const artifactConfig = PythonArtifactConfigSchema.parse({ ...baseConfig, kind: "artifact_construction" });
const repairConfig = PythonRepairConfigSchema.parse({ ...baseConfig, kind: "diagnosis_repair" });

function task<C extends PythonArtifactConfig | PythonRepairConfig>(config: C): TaskPublic<C> {
  return {
    id: IDS.task,
    taskVersion: 1,
    mechanicId: config.kind,
    mechanicVersion: 3,
    outcomeIds: ["00000000-0000-4000-8000-000000000020"],
    instruction: "Implement and explain the correction.",
    contentLanguage: "en",
    config,
    availableHints: 1,
    responseSchemaVersion: 3,
  };
}

const artifactPrivate: PythonArtifactPrivate = PythonArtifactPrivateSchema.parse({
  testSetId: IDS.testSet,
  hiddenCases: [
    { id: "hidden_negative", input: -3, expected: 9, dimensionId: "behavior" },
    { id: "hidden_zero", input: 0, expected: 0, dimensionId: "behavior" },
  ],
  comparator: { kind: "json_exact" },
  requiredDimensions: ["behavior"],
});

const repairPrivate: PythonRepairPrivate = PythonRepairPrivateSchema.parse({
  ...artifactPrivate,
  requiredDimensions: ["behavior", "location"],
  acceptedFaultRegions: [{ startLine: 2, endLine: 2 }],
  repairLocationDimensionId: "location",
  explanationRubric: null,
});

function completed(
  source: string,
  cases: readonly { id: string }[],
  values: readonly number[],
): Extract<ExecutionResult, { status: "completed" }> {
  return {
    status: "completed",
    executionId: IDS.execution,
    input: { kind: "learning", activitySessionId: IDS.session, inputRevision: 1, responseDigest: "a".repeat(64) },
    purpose: "grade",
    sourceDigest: pythonSourceDigest(source),
    runtimeProfile: "python_stdlib_v1",
    cases: cases.map((item, index) => ({ id: item.id, result: { status: "ok", value: values[index]!, stdout: "" } })),
    audit: {
      sandboxId: "sandbox", sessionId: "session", providerCommandIds: cases.map((_, index) => `cmd-${index}`),
      image: PYTHON_SANDBOX_IMAGE, imageDigest: PYTHON_IMAGE_SHA256, runnerDigest: PYTHON_RUNNER_SHA256,
      runtimeDigest: PYTHON_RUNTIME_DIGEST, startedAt: "2026-10-25T00:00:00.000Z",
      finishedAt: "2026-10-25T00:00:01.000Z", cleanup: "deleted",
    },
  };
}

function pythonPort(values: readonly number[]) {
  const execute = vi.fn<PythonEvaluationPort["execute"]>(async (input) => completed(input.source, input.cases, values));
  return { port: { execute } satisfies PythonEvaluationPort, execute };
}

function context(python: PythonEvaluationPort | null, model: RubricJudge | null = null): EvaluationContext {
  return { python, model, signal: new AbortController().signal };
}

describe("Python private evaluators", () => {
  it("accepts an alternative valid implementation and sends no hidden expectations to execution", async () => {
    const runtime = pythonPort([9, 0]);
    const response: PythonArtifactResponse = {
      kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source: alternativeSource,
    };
    const decision = await pythonArtifactEvaluator.evaluate({
      task: task(artifactConfig), response, privateData: artifactPrivate, activity: null,
    }, context(runtime.port));
    expect(decision).toMatchObject({ status: "evaluated", outcome: "correct" });
    expect(runtime.execute).toHaveBeenCalledWith({
      source: alternativeSource,
      cases: artifactPrivate.hiddenCases.map(({ id, input }) => ({ id, input })),
      runtimeProfile: "python_stdlib_v1",
    }, expect.any(AbortSignal));
    expect(runtime.execute.mock.calls[0]![0]).not.toHaveProperty("expected");
    expect(JSON.stringify(runtime.execute.mock.calls[0]![0])).not.toContain("expected");
  });

  it("accepts a verified hidden projection from one authoring-validation execution", async () => {
    const execute = vi.fn<PythonEvaluationPort["execute"]>(async (input) => ({
      ...completed(input.source, input.cases, [9, 0]),
      purpose: "authoring_validation",
      input: { kind: "authoring", authoringValidationId: IDS.authoringValidation, candidateDigest: "b".repeat(64) },
    }));
    const response: PythonArtifactResponse = {
      kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source: alternativeSource,
    };
    const decision = await pythonArtifactEvaluator.evaluate({
      task: task(artifactConfig), response, privateData: artifactPrivate, activity: null,
    }, context({ execute }));
    expect(decision).toMatchObject({ status: "evaluated", outcome: "correct" });
  });

  it("fails source hardcoded to a public example without leaking hidden IDs, inputs or expectations", async () => {
    const runtime = pythonPort([4, 4]);
    const response: PythonArtifactResponse = {
      kind: "artifact_construction", action: "build_artifact", artifactType: "python_function",
      source: "def solve(payload):\n    return 4\n",
    };
    const decision = await pythonArtifactEvaluator.evaluate({
      task: task(artifactConfig), response, privateData: artifactPrivate, activity: null,
    }, context(runtime.port));
    expect(decision).toMatchObject({ status: "evaluated", outcome: "incorrect", dimensions: [{ id: "behavior", status: "not_met" }] });
    const publicDecision = JSON.stringify(decision);
    expect(publicDecision).not.toContain("hidden_negative");
    expect(publicDecision).not.toContain("hidden_zero");
    expect(publicDecision).not.toContain("-3");
    expect(publicDecision).not.toContain("9");
  });

  it("maps unavailable infrastructure and invalid authored private values to retryable assessment state", async () => {
    const execute = vi.fn<PythonEvaluationPort["execute"]>(async () => { throw new Error("provider unavailable"); });
    const response: PythonArtifactResponse = {
      kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source: correctSource,
    };
    const unavailable = await pythonArtifactEvaluator.evaluate({
      task: task(artifactConfig), response, privateData: artifactPrivate, activity: null,
    }, context({ execute }));
    expect(unavailable).toMatchObject({ status: "unavailable", outcome: null, feedback: { nextAction: "wait" } });

    const invalidValues = PythonArtifactPrivateSchema.parse({
      ...artifactPrivate,
      hiddenCases: [{ id: "hidden_bad", input: "wrong-shape", expected: 9, dimensionId: "behavior" }],
    });
    execute.mockClear();
    const invalid = await pythonArtifactEvaluator.evaluate({
      task: task(artifactConfig), response, privateData: invalidValues, activity: null,
    }, context({ execute }));
    expect(invalid).toMatchObject({ status: "unavailable", outcome: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when numeric tolerance arithmetic would overflow", async () => {
    const execute = vi.fn<PythonEvaluationPort["execute"]>();
    const unsafeTolerance = PythonArtifactPrivateSchema.parse({
      ...artifactPrivate,
      hiddenCases: [{ id: "hidden_large", input: 1, expected: 1, dimensionId: "behavior" }],
      comparator: { kind: "numeric_tolerance", absolute: Number.MAX_VALUE, relative: Number.MAX_VALUE },
    });
    const response: PythonArtifactResponse = {
      kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source: correctSource,
    };
    const decision = await pythonArtifactEvaluator.evaluate({
      task: task(artifactConfig), response, privateData: unsafeTolerance, activity: null,
    }, context({ execute }));
    expect(decision).toMatchObject({ status: "unavailable", outcome: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it("scores repair behavior and source localization as independent dimensions", async () => {
    const runtime = pythonPort([9, 0]);
    const response: PythonRepairResponse = {
      kind: "diagnosis_repair", action: "repair", artifactType: "python_function", source: correctSource,
      locations: [{ startLine: 1, endLine: 1 }], explanation: "Square the input rather than doubling it.",
    };
    const decision = await pythonRepairEvaluator.evaluate({
      task: task(repairConfig), response, privateData: repairPrivate, activity: null,
    }, context(runtime.port));
    expect(decision).toMatchObject({
      status: "evaluated", outcome: "partial",
      dimensions: [{ id: "behavior", status: "met" }, { id: "location", status: "not_met" }],
    });
  });

  it("keeps explanation rubric evidence separate from execution and localization", async () => {
    const withExplanation = PythonRepairPrivateSchema.parse({
      ...repairPrivate,
      requiredDimensions: ["behavior", "location", "explanation"],
      explanationRubric: {
        id: "00000000-0000-4000-8000-000000000021",
        dimensions: [{
          id: "explanation", criterion: "Explain why squaring fixes negative inputs.",
          met: "Connects multiplication to a non-negative square.", partial: "Mentions multiplication without the sign consequence.",
          notMet: "Does not explain the behavioral change.",
        }],
      },
    });
    const response: PythonRepairResponse = {
      kind: "diagnosis_repair", action: "repair", artifactType: "python_function", source: correctSource,
      locations: [{ startLine: 2, endLine: 2 }], explanation: "It changes the operator.",
    };
    const judge = vi.fn<RubricJudge["judge"]>(async () => ({
      dimensions: [{ id: "explanation", status: "not_met", evidenceRefs: [{ responsePath: ["explanation"], span: null }], explanation: "The sign behavior is not explained." }],
      feedback: "Explain what happens for negative inputs.", uncertainReasons: [],
    }));
    const runtime = pythonPort([9, 0]);
    const decision = await pythonRepairEvaluator.evaluate({
      task: task(repairConfig), response, privateData: withExplanation, activity: null,
    }, context(runtime.port, { judge }));
    expect(decision).toMatchObject({
      status: "evaluated", outcome: "partial",
      dimensions: [
        { id: "behavior", status: "met" },
        { id: "location", status: "met" },
        { id: "explanation", status: "not_met" },
      ],
    });
    expect(judge.mock.calls[0]![0].allowedResponsePaths).toEqual([["explanation"], ["locations"]]);
  });

  it("rejects missing behavioral dimensions and collisions among repair criteria", () => {
    expect(PythonArtifactPrivateSchema.safeParse({ ...artifactPrivate, requiredDimensions: ["other"] }).success).toBe(false);
    expect(PythonRepairPrivateSchema.safeParse({ ...repairPrivate, repairLocationDimensionId: "behavior", requiredDimensions: ["behavior"] }).success).toBe(false);
    expect(PythonRepairPrivateSchema.safeParse({
      ...repairPrivate,
      requiredDimensions: ["behavior", "location"],
      explanationRubric: {
        id: "00000000-0000-4000-8000-000000000022",
        dimensions: [{ id: "location", criterion: "Explain it.", met: "Good.", partial: "Some.", notMet: "No." }],
      },
    }).success).toBe(false);
  });
});
