import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BoundedModelSchema, ExprSchema, convertQuantity, evaluateBoundedModel, evaluateExpression,
  isValidSpan, parseFamilyResponse, parseFamilyTask, validateExpression, withinTolerance,
  type BoundedModel, type Expr, type FamilyDescriptor,
} from "../../src/domain/mechanic-families/v2/shared";

const constant = (value: number): Expr => ({ op: "constant", value });
const variable = (name: string): Expr => ({ op: "variable", name });
const subtract = (left: Expr, right: Expr): Expr => ({ op: "subtract", left, right });

describe("bounded expression interpreter", () => {
  it("calculates equivalent expression structures rather than comparing one formula string", () => {
    const delta = subtract(variable("y"), variable("prediction"));
    const reversed = subtract(variable("prediction"), variable("y"));
    for (const expression of [
      { op: "multiply", left: delta, right: delta },
      { op: "multiply", left: reversed, right: reversed },
    ] as const) {
      expect(evaluateExpression(expression, { y: 4, prediction: 1 })).toBe(9);
    }
    expect(evaluateExpression({ op: "abs", value: delta }, { y: 4, prediction: 1 })).toBe(3);
  });

  it("does not treat environment or prototype properties as declared variables", () => {
    expect(validateExpression(variable("secret"), ["x"])).toEqual([
      expect.objectContaining({ code: "invalid_reference", path: ["name"] }),
    ]);
    expect(() => evaluateExpression(variable("secret"), { x: 1, secret: 4 }, ["x"]))
      .toThrow(expect.objectContaining({ code: "undeclared_variable" }));
    expect(() => evaluateExpression(variable("x"), {}, ["x"]))
      .toThrow(expect.objectContaining({ code: "undeclared_variable" }));
    expect(ExprSchema.safeParse(variable("constructor")).success).toBe(false);
  });

  it("rejects excess depth, node count, cycles and code-shaped expressions before interpretation", () => {
    let deepest: Expr = constant(1);
    for (let index = 0; index < 7; index++) deepest = { op: "abs", value: deepest };
    expect(ExprSchema.safeParse(deepest).success).toBe(true);
    expect(ExprSchema.safeParse({ op: "abs", value: deepest }).success).toBe(false);
    let broad: Expr = constant(1);
    for (let index = 0; index < 5; index++) broad = { op: "add", left: broad, right: broad };
    expect(ExprSchema.safeParse(broad).success).toBe(true); // 63 occurrences, shared JS references are not cycles.
    expect(ExprSchema.safeParse({ op: "add", left: broad, right: constant(1) }).success).toBe(false);
    const cycle: { op: "abs"; value?: unknown } = { op: "abs" };
    cycle.value = cycle;
    expect(ExprSchema.safeParse(cycle).success).toBe(false);
    expect(ExprSchema.safeParse({ op: "execute", source: "process.env" }).success).toBe(false);
    expect(ExprSchema.safeParse({ op: "constant", value: 1, source: "arbitrary code" }).success).toBe(false);
  });

  it("reports numerical failures without returning NaN, Infinity or an invented result", () => {
    expect(() => evaluateExpression({ op: "divide", left: constant(1), right: constant(0) }, {}))
      .toThrow(expect.objectContaining({ code: "division_by_zero" }));
    expect(() => evaluateExpression({ op: "multiply", left: constant(1e308), right: constant(1e308) }, {}))
      .toThrow(expect.objectContaining({ code: "nonfinite_result" }));
    expect(ExprSchema.safeParse(constant(NaN)).success).toBe(false);
  });
});

describe("quantities and bounded models", () => {
  const model: BoundedModel = {
    inputs: [{ id: "x", min: -2, max: 2, step: 0.5, unit: "unitless" }],
    outputs: [{ id: "y", unit: "unitless", expression: {
      op: "add", left: { op: "multiply", left: constant(2), right: variable("x") }, right: constant(1),
    } }],
  };

  it("converts equivalent decimal units and rejects incompatible dimensions", () => {
    expect(convertQuantity({ value: 4, unit: "MB" }, "byte")).toEqual({ value: 4_000_000, unit: "byte" });
    expect(convertQuantity({ value: 66.66666667, unit: "percent" }, "ratio").value).toBeCloseTo(2 / 3, 9);
    expect(convertQuantity({ value: 1500, unit: "ms" }, "second").value).toBe(1.5);
    expect(() => convertQuantity({ value: 4, unit: "byte" }, "second"))
      .toThrow(expect.objectContaining({ code: "incompatible_unit" }));
    expect(() => convertQuantity({ value: 4, unit: "ratio" }, "unitless"))
      .toThrow(expect.objectContaining({ code: "incompatible_unit" }));
    expect(() => convertQuantity({ value: 1e308, unit: "MB" }, "byte"))
      .toThrow(expect.objectContaining({ code: "nonfinite_result" }));
  });

  it("applies declared absolute and relative tolerances without rounding away a wrong scale", () => {
    expect(withinTolerance(0.000000001, 0, { absTol: 1e-9, relTol: 0 })).toBe(true);
    expect(withinTolerance(1_000_001, 1_000_000, { absTol: 0, relTol: 1e-6 })).toBe(true);
    expect(withinTolerance(4_000, 4_000_000, { absTol: 1e-9, relTol: 0.01 })).toBe(false);
    expect(() => withinTolerance(NaN, 1, { absTol: 1, relTol: 0 })).toThrow();
    expect(() => withinTolerance(1, 1, { absTol: -1, relTol: 0 })).toThrow();
  });

  it("computes actual outputs and rejects missing, extra, off-grid and out-of-range settings", () => {
    expect(evaluateBoundedModel(model, { x: 1.5 })).toEqual([{ id: "y", quantity: { value: 4, unit: "unitless" } }]);
    for (const settings of [{}, { x: 1, hidden: 2 }, { x: 1.2 }, { x: 3 }]) {
      expect(() => evaluateBoundedModel(model, settings)).toThrow();
    }
    expect(BoundedModelSchema.safeParse({ ...model, inputs: [...model.inputs, ...model.inputs] }).success).toBe(false);
    expect(BoundedModelSchema.safeParse({ ...model, outputs: [{ id: "y", unit: "unitless", expression: variable("missing") }] }).success).toBe(false);
  });

  it("validates evidence spans against the actual block, using exclusive offsets", () => {
    const blocks = [{ id: "statement", text: "Use held-out data." }];
    expect(isValidSpan({ blockId: "statement", start: 4, end: 12 }, blocks)).toBe(true);
    expect(isValidSpan({ blockId: "missing", start: 0, end: 1 }, blocks)).toBe(false);
    expect(isValidSpan({ blockId: "statement", start: 4, end: 100 }, blocks)).toBe(false);
  });
});

describe("versioned family join", () => {
  const configSchema = z.object({ kind: z.literal("recall_reconstruction"), cue: z.string() }).strict();
  const responseSchema = z.object({ kind: z.literal("recall_reconstruction"), action: z.literal("recall"), text: z.string() }).strict();
  const descriptor: FamilyDescriptor<z.infer<typeof configSchema>, z.infer<typeof responseSchema>> = {
    id: "recall_reconstruction", version: 2, responseSchemaVersion: 2, configSchema, responseSchema,
    requiredAffordances: ["text"], supportedEvaluators: ["rubric"], rendererKey: "recall_reconstruction@2",
    accessibility: { keyboardEquivalent: true, nonVisualSummary: true }, actions: [], requirements: ["model"], limitations: [],
    createInitialResponse: () => ({ kind: "recall_reconstruction", action: "recall", text: "" }),
    validateSubmission: (_config, response) => response.text.trim() ? [] : [{ path: ["text"], code: "required", message: "Enter an answer" }],
  };
  const task = {
    id: crypto.randomUUID(), taskVersion: 1, mechanicId: "recall_reconstruction", mechanicVersion: 2,
    responseSchemaVersion: 2, outcomeIds: [crypto.randomUUID()], instruction: "Recall the meaning.", contentLanguage: "en",
    config: { kind: "recall_reconstruction", cue: "What is accuracy?" }, availableHints: 0,
  };

  it("accepts editable blanks but rejects a wrong family/version and strips private envelope data", () => {
    const response = parseFamilyResponse(descriptor, descriptor.createInitialResponse(task.config as z.infer<typeof configSchema>));
    expect(descriptor.validateSubmission(task.config as z.infer<typeof configSchema>, response)[0]?.code).toBe("required");
    expect(parseFamilyTask(descriptor, { ...task, evaluationSpec: { secretConfig: { expectedAnswer: "private" } } })).toEqual(task);
    expect(() => parseFamilyTask(descriptor, { ...task, mechanicVersion: 1 })).toThrow();
    expect(() => parseFamilyTask(descriptor, { ...task, responseSchemaVersion: 1 })).toThrow();
    expect(() => parseFamilyTask(descriptor, { ...task, mechanicId: "state_tracing" })).toThrow();
    expect(() => parseFamilyResponse(descriptor, { kind: "state_tracing", action: "recall", text: "answer" })).toThrow();
    expect(() => parseFamilyTask(descriptor, { ...task, config: { ...task.config, expectedAnswer: "private" } })).toThrow();
  });
});
