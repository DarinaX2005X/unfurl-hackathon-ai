import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PythonSourceSchema, ExecutionJsonSchema, BoundedValueShapeSchema, PythonArtifactConfigSchema, PythonArtifactResponseSchema,
  PythonRepairConfigSchema, PythonRepairResponseSchema, PythonProgramResultSchema, PythonExecutionObservationSchema,
  pythonArtifactDescriptor, pythonRepairDescriptor, parseExecutionValue, validateExecutionValue, parsePythonPublicObservation, canonicalExecutionJson,
  type BoundedValueShape,
} from "@/domain/mechanic-families/v3/python";
import { parseFamilyTask, parseFamilyResponse } from "@/domain/mechanic-families/v2/shared";
import { artifactConstructionDescriptor } from "@/domain/mechanic-families/v2/construction";
import { ActionReceiptSchema, PublicObservationSchema, responseDigest } from "@/domain/activity";
import { task } from "../mechanics/foundations/fixtures";

const inputShape: BoundedValueShape = { type: "object", properties: [{ key: "x", shape: { type: "number", integer: true, minimum: -100, maximum: 100 } }] };
const outputShape: BoundedValueShape = { type: "number", integer: true, minimum: 0, maximum: 10000 };
const source = "def solve(payload):\n    return payload['x'] ** 2\n";
const config = PythonArtifactConfigSchema.parse({ kind: "artifact_construction", artifactType: "python_function", language: "python", runtimeProfile: "python_stdlib_v1", entrypoint: "solve",
  specification: "Return the square of the supplied x.", inputShape, outputShape, starterSource: "def solve(payload):\n    raise NotImplementedError()\n",
  publicCases: [{ id: "public_zero", input: { x: 0 } }, { id: "public_two", input: { x: 2 } }] });

describe("Python v3 domain contract", () => {
  it("normalizes only line endings before the immutable response digest, preserving code and indentation", async () => {
    const response = { kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source };
    const windows = PythonArtifactResponseSchema.parse({ ...response, source: source.replaceAll("\n", "\r\n") });
    expect(windows.source).toBe(source);
    expect(await responseDigest(windows)).toBe(await responseDigest(PythonArtifactResponseSchema.parse(response)));
    expect(PythonSourceSchema.parse("  # keep spaces\rdef solve(payload):\r    return 1")).toBe("  # keep spaces\ndef solve(payload):\n    return 1");
    expect(PythonSourceSchema.safeParse("\ud800").success).toBe(false);
  });
  it("applies independent UTF-8 byte and line limits without executing or filtering source keywords", () => {
    expect(PythonSourceSchema.safeParse("😀".repeat(3000)).success).toBe(true);
    expect(PythonSourceSchema.safeParse("😀".repeat(3001)).success).toBe(false);
    expect(PythonSourceSchema.safeParse(Array.from({ length: 300 }, () => "#").join("\n")).success).toBe(true);
    expect(PythonSourceSchema.safeParse(Array.from({ length: 301 }, () => "#").join("\n")).success).toBe(false);
    expect(PythonArtifactResponseSchema.safeParse({ kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source: "" }).success).toBe(true);
    expect(PythonSourceSchema.safeParse("import os\ndef solve(payload):\n    return os.environ").success).toBe(true);
    // Schema acceptance is editable source, never sandbox capability or permission to use a resource.
  });
  it("bounds finite execution JSON before recursive parsing and rejects reserved keys and accessors", () => {
    expect(ExecutionJsonSchema.parse({ a: [null, true, 1.5, "text"] })).toEqual({ a: [null, true, 1.5, "text"] });
    expect(ExecutionJsonSchema.safeParse({ value: Number.NaN }).success).toBe(false);
    expect(ExecutionJsonSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(ExecutionJsonSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(ExecutionJsonSchema.safeParse({ text: "я".repeat(9000) }).success).toBe(false);
    for (const key of ["__proto__", "prototype", "constructor"]) expect(ExecutionJsonSchema.safeParse(JSON.parse(`{"${key}":1}`)).success).toBe(false);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(ExecutionJsonSchema.safeParse(cyclic).success).toBe(false);
    let read = false; expect(ExecutionJsonSchema.safeParse({ get value() { read = true; return 1; } }).success).toBe(false); expect(read).toBe(false);
    let deep: unknown = null; for (let index = 0; index < 13; index++) deep = [deep];
    expect(ExecutionJsonSchema.safeParse(deep).success).toBe(false);
    expect(ExecutionJsonSchema.safeParse(Array.from({ length: 2048 }, () => null)).success).toBe(false);
    expect(canonicalExecutionJson({ b: 2, a: [1, 0] })).toBe(canonicalExecutionJson({ a: [1, 0], b: 2 }));
    expect(canonicalExecutionJson([1, 0])).not.toBe(canonicalExecutionJson([0, 1]));
  });
  it("checks strict required object properties, scalar bounds and nested value shapes", () => {
    expect(parseExecutionValue(inputShape, { x: -2 })).toEqual({ x: -2 });
    for (const invalid of [{}, { x: 1, extra: 1 }, { x: 0.5 }, { x: 101 }, { x: "1" }]) expect(validateExecutionValue(inputShape, invalid).length).toBeGreaterThan(0);
    const nested: BoundedValueShape = { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1, maxLength: 3 } };
    expect(parseExecutionValue(nested, ["a", "abc"])).toEqual(["a", "abc"]);
    expect(() => parseExecutionValue(nested, ["abcd"])).toThrow();
    expect(() => parseExecutionValue(nested, [])).toThrow();
    expect(() => parseExecutionValue(outputShape, -1)).toThrow();
  });
  it("rejects executable/unbounded shape definitions, duplicate keys and impossible numeric bounds", () => {
    for (const shape of [
      { type: "string", minLength: 2, maxLength: 1 }, { type: "array", minItems: 0, maxItems: 129, items: { type: "null" } },
      { type: "number", integer: true, minimum: 0.1, maximum: 0.9 }, { type: "number", integer: false, minimum: 2, maximum: 1 },
      { type: "object", properties: [{ key: "constructor", shape: { type: "null" } }] },
      { type: "object", properties: [{ key: "x", shape: { type: "null" } }, { key: "x", shape: { type: "boolean" } }] },
      { type: "null", $ref: "https://example.invalid/schema" }, { type: "number", minimum: 0, maximum: 1, integer: false, validate: "return true" },
    ]) expect(BoundedValueShapeSchema.safeParse(shape).success).toBe(false);
    let shape: BoundedValueShape = { type: "null" };
    for (let depth = 0; depth < 5; depth++) shape = { type: "array", minItems: 0, maxItems: 1, items: shape };
    expect(BoundedValueShapeSchema.safeParse(shape).success).toBe(false);
  });
  it("validates public inputs before authoring and keeps Python distinct from numeric AST v2", () => {
    expect(PythonArtifactConfigSchema.safeParse({ ...config, publicCases: [{ id: "bad", input: { x: "wrong" } }] }).success).toBe(false);
    expect(PythonArtifactConfigSchema.safeParse({ ...config, entrypoint: "eval" }).success).toBe(false);
    expect(PythonArtifactConfigSchema.safeParse({ ...config, publicCases: [config.publicCases[0], config.publicCases[0]] }).success).toBe(false);
    const pythonTask = { ...task(config), mechanicVersion: 3, responseSchemaVersion: 3 };
    expect(parseFamilyTask(pythonArtifactDescriptor, pythonTask).mechanicVersion).toBe(3);
    expect(() => parseFamilyTask(pythonArtifactDescriptor, { ...pythonTask, mechanicVersion: 2 })).toThrow();
    expect(() => parseFamilyTask(artifactConstructionDescriptor, pythonTask)).toThrow();
    expect(() => parseFamilyResponse(pythonArtifactDescriptor, { kind: "artifact_construction", action: "build_artifact", expression: { op: "constant", value: 1 } })).toThrow();
  });
  it("requires repair locations in the original source and keeps source editing independent of Run state", () => {
    const repair = PythonRepairConfigSchema.parse({ ...config, kind: "diagnosis_repair", starterSource: "def solve(payload):\n    return payload['x']\n" });
    const initial = pythonRepairDescriptor.createInitialResponse(repair);
    expect(PythonRepairResponseSchema.safeParse(initial).success).toBe(true);
    expect(pythonRepairDescriptor.validateSubmission(repair, initial).map((issue) => issue.path[0])).toEqual(["locations", "explanation"]);
    const response = PythonRepairResponseSchema.parse({ ...initial, source, locations: [{ startLine: 2, endLine: 2 }], explanation: "The original code returned x instead of x squared." });
    expect(pythonRepairDescriptor.validateSubmission(repair, response)).toEqual([]);
    expect(pythonRepairDescriptor.validateSubmission(repair, { ...response, locations: [{ startLine: 5, endLine: 5 }] })[0]!.code).toBe("invalid_reference");
    expect(PythonRepairResponseSchema.safeParse({ ...response, locations: [{ startLine: 2, endLine: 1 }] }).success).toBe(false);
  });
  it("joins only the exact public cases and separates infrastructure failures from learner program errors", () => {
    const observation = { kind: "python_execution", runtimeProfile: "python_stdlib_v1", cases: config.publicCases.map((item) => ({ caseId: item.id, input: item.input, result: { status: "ok", value: 0, stdout: "" } })) };
    expect(PublicObservationSchema.safeParse(observation).success).toBe(true);
    expect(parsePythonPublicObservation(config, observation).cases).toHaveLength(2);
    expect(() => parsePythonPublicObservation(config, { ...observation, cases: [{ ...observation.cases[0], caseId: "hidden_case" }, observation.cases[1]] })).toThrow(/authored public cases/);
    expect(() => parsePythonPublicObservation(config, { ...observation, cases: [{ ...observation.cases[0], input: { x: 99 } }, observation.cases[1]] })).toThrow(/authored public cases/);
    expect(() => parsePythonPublicObservation(config, { ...observation, cases: [...observation.cases].reverse() })).toThrow(/authored public cases/);
    expect(PythonExecutionObservationSchema.safeParse({ ...observation, audit: { sandboxId: "private" } }).success).toBe(false);
    expect(PythonProgramResultSchema.safeParse({ status: "error", code: "provider", message: "Unavailable", line: null, column: null }).success).toBe(false);
    expect(PythonProgramResultSchema.safeParse({ status: "error", code: "syntax_error", message: "Expected a colon.", line: 301, column: 12001 }).success).toBe(true);
    const receipt = { id: crypto.randomUUID(), clientActionId: crypto.randomUUID(), input: { activitySessionId: crypto.randomUUID(), inputRevision: 1, responseDigest: "a".repeat(64) }, sessionRevision: 1, status: "unavailable", observation };
    expect(ActionReceiptSchema.safeParse(receipt).success).toBe(false);
    expect(ActionReceiptSchema.safeParse({ ...receipt, observation: null }).success).toBe(true);
  });
  it("bounds stdout per case and exposes real output JSON Schema without empty-any fallbacks", () => {
    expect(PythonProgramResultSchema.safeParse({ status: "ok", value: 1, stdout: "x".repeat(65536) }).success).toBe(true);
    expect(PythonProgramResultSchema.safeParse({ status: "ok", value: 1, stdout: "я".repeat(32769) }).success).toBe(false);
    const schema = z.toJSONSchema(PythonArtifactConfigSchema, { io: "output" });
    expect(schema.type).toBe("object");
    expect(schema.properties?.inputShape).not.toEqual({});
    expect(schema.properties?.publicCases).not.toEqual({});
    expect(schema.properties?.starterSource).toMatchObject({ type: "string" });
    expect(z.toJSONSchema(ExecutionJsonSchema, { io: "output" })).not.toEqual({});
  });
});
