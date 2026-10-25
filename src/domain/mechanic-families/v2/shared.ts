import { z } from "zod";
import type { JsonValue } from "../../common";
import { serializePublicTask, type MechanicDefinition, type TaskPublic } from "../../mechanics";

export const MECHANIC_VERSION = 2 as const;
export const RESPONSE_SCHEMA_VERSION = 2 as const;
export const MECHANIC_LIMITS = {
  text: 4_000, artifactText: 12_000, steps: 20, graphNodes: 24,
  graphEdges: 48, tableCells: 100, actions: 6, expressionNodes: 64,
  expressionDepth: 8, variables: 24,
} as const;

export const LocalIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
  .refine((id) => !["__proto__", "prototype", "constructor"].includes(id), "Reserved identifier");
export const TextSchema = z.string().max(MECHANIC_LIMITS.text);
export const NonemptyTextSchema = TextSchema.trim().min(1);
export const FiniteNumberSchema = z.number().finite();
export const FiniteValuesSchema = z.record(LocalIdSchema, FiniteNumberSchema)
  .refine((values) => Object.keys(values).length <= MECHANIC_LIMITS.variables, "Too many variables");

export type SubmissionIssue = {
  path: Array<string | number>;
  code: "required" | "invalid_reference" | "duplicate" | "out_of_bounds" |
    "incompatible_unit" | "invalid_structure";
  message: string;
};
export type MechanicActionKind = "run" | "prediction.commit" | "experiment.query" |
  "intervention.apply" | "dialogue.turn";

export interface FamilyDescriptor<C extends JsonValue, R extends JsonValue>
  extends MechanicDefinition<C, R> {
  version: 2;
  responseSchemaVersion: 2;
  actions: MechanicActionKind[];
  requirements: Array<"model" | "activity" | "sandbox">;
  limitations: string[];
  createInitialResponse(config: C): R;
  validateSubmission(config: C, response: R): SubmissionIssue[];
}

function assertFamilyKind(value: JsonValue, id: string): void {
  if (value === null || Array.isArray(value) || typeof value !== "object" || value.kind !== id) {
    throw new MechanicValueError("invalid_value", "The payload belongs to a different mechanic family");
  }
}

/** Project public fields, then enforce the exact versioned family join. */
export function parseFamilyTask<C extends JsonValue, R extends JsonValue>(
  descriptor: FamilyDescriptor<C, R>, value: unknown,
): TaskPublic<C> {
  const task = serializePublicTask(value, descriptor.configSchema);
  if (task.mechanicId !== descriptor.id || task.mechanicVersion !== descriptor.version ||
      task.responseSchemaVersion !== descriptor.responseSchemaVersion) {
    throw new MechanicValueError("invalid_value", "Unsupported mechanic or response version");
  }
  assertFamilyKind(task.config, descriptor.id);
  return task;
}

export function parseFamilyResponse<C extends JsonValue, R extends JsonValue>(
  descriptor: FamilyDescriptor<C, R>, value: unknown,
): R {
  const response = descriptor.responseSchema.parse(value);
  assertFamilyKind(response, descriptor.id);
  return response;
}

export type MechanicValueErrorCode = "invalid_expression" | "undeclared_variable" |
  "division_by_zero" | "nonfinite_result" | "incompatible_unit" | "invalid_value";
export class MechanicValueError extends Error {
  constructor(readonly code: MechanicValueErrorCode, message: string) {
    super(message);
    this.name = "MechanicValueError";
  }
}

export type Expr =
  | { op: "constant"; value: number }
  | { op: "variable"; name: string }
  | { op: "add" | "subtract" | "multiply" | "divide"; left: Expr; right: Expr }
  | { op: "abs"; value: Expr };

const ExprNodeSchema: z.ZodType<Expr> = z.lazy(() => z.discriminatedUnion("op", [
  z.object({ op: z.literal("constant"), value: FiniteNumberSchema }).strict(),
  z.object({ op: z.literal("variable"), name: LocalIdSchema }).strict(),
  z.object({ op: z.enum(["add", "subtract", "multiply", "divide"]), left: ExprNodeSchema, right: ExprNodeSchema }).strict(),
  z.object({ op: z.literal("abs"), value: ExprNodeSchema }).strict(),
]));

/** Check bounds before recursive parsing, including cycles from non-JSON callers. */
export const ExprSchema: z.ZodType<Expr> = z.unknown().superRefine((value, context) => {
  const stack: Array<{ value: unknown; depth: number; leaving?: boolean }> = [{ value, depth: 1 }];
  const ancestors = new WeakSet<object>();
  let count = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.leaving) {
      ancestors.delete(frame.value as object);
      continue;
    }
    count += 1;
    if (count > MECHANIC_LIMITS.expressionNodes || frame.depth > MECHANIC_LIMITS.expressionDepth) {
      context.addIssue({ code: "custom", message: "Expression exceeds node or depth limits" });
      return;
    }
    if (frame.value === null || typeof frame.value !== "object" || Array.isArray(frame.value)) continue;
    if (ancestors.has(frame.value)) {
      context.addIssue({ code: "custom", message: "Expression must not contain cycles" });
      return;
    }
    ancestors.add(frame.value);
    stack.push({ ...frame, leaving: true });
    const node = frame.value as Record<string, unknown>;
    if (node.op === "abs") stack.push({ value: node.value, depth: frame.depth + 1 });
    if (["add", "subtract", "multiply", "divide"].includes(String(node.op))) {
      stack.push({ value: node.right, depth: frame.depth + 1 }, { value: node.left, depth: frame.depth + 1 });
    }
  }
}).pipe(ExprNodeSchema);

export function validateExpression(expression: unknown, declaredVariables: readonly string[]): SubmissionIssue[] {
  const parsed = ExprSchema.safeParse(expression);
  if (!parsed.success) return parsed.error.issues.map((issue) => ({
    path: issue.path.map((part) => typeof part === "number" ? part : String(part)),
    code: "invalid_structure", message: issue.message,
  }));
  const declarations = z.array(LocalIdSchema).max(MECHANIC_LIMITS.variables).safeParse(declaredVariables);
  if (!declarations.success || new Set(declaredVariables).size !== declaredVariables.length) {
    return [{ path: [], code: "invalid_structure", message: "Variable declarations must be valid and unique" }];
  }
  const allowed = new Set(declaredVariables);
  const issues: SubmissionIssue[] = [];
  const visit = (node: Expr, path: Array<string | number>): void => {
    if (node.op === "variable" && !allowed.has(node.name)) {
      issues.push({ path: [...path, "name"], code: "invalid_reference", message: `Undeclared variable: ${node.name}` });
    } else if (node.op === "abs") visit(node.value, [...path, "value"]);
    else if ("left" in node) {
      visit(node.left, [...path, "left"]);
      visit(node.right, [...path, "right"]);
    }
  };
  visit(parsed.data, []);
  return issues;
}

function finiteResult(value: number): number {
  if (!Number.isFinite(value)) throw new MechanicValueError("nonfinite_result", "Calculation is outside the finite numeric range");
  return Object.is(value, -0) ? 0 : value;
}

export function evaluateExpression(
  expression: Expr, values: Record<string, number>, declaredVariables: readonly string[] = Object.keys(values),
): number {
  const parsed = ExprSchema.safeParse(expression);
  if (!parsed.success) throw new MechanicValueError("invalid_expression", "Invalid or unbounded expression");
  const issues = validateExpression(parsed.data, declaredVariables);
  if (issues.length > 0) throw new MechanicValueError("undeclared_variable", issues[0]!.message);
  const environment = FiniteValuesSchema.parse(values);
  const evaluate = (node: Expr): number => {
    if (node.op === "constant") return node.value;
    if (node.op === "variable") {
      if (!Object.hasOwn(environment, node.name)) throw new MechanicValueError("undeclared_variable", `Missing value: ${node.name}`);
      return environment[node.name]!;
    }
    if (node.op === "abs") return finiteResult(Math.abs(evaluate(node.value)));
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (node.op === "divide" && right === 0) throw new MechanicValueError("division_by_zero", "Cannot divide by zero");
    return finiteResult(node.op === "add" ? left + right : node.op === "subtract" ? left - right :
      node.op === "multiply" ? left * right : left / right);
  };
  return finiteResult(evaluate(parsed.data));
}

export const UnitSchema = z.enum(["unitless", "ratio", "percent", "byte", "KB", "MB", "second", "ms"]);
export type Unit = z.infer<typeof UnitSchema>;
const unitDefinitions: Record<Unit, { dimension: string; scale: number }> = {
  unitless: { dimension: "unitless", scale: 1 }, ratio: { dimension: "ratio", scale: 1 },
  percent: { dimension: "ratio", scale: 0.01 }, byte: { dimension: "bytes", scale: 1 },
  KB: { dimension: "bytes", scale: 1_000 }, MB: { dimension: "bytes", scale: 1_000_000 },
  second: { dimension: "time", scale: 1 }, ms: { dimension: "time", scale: 0.001 },
};
export const QuantitySchema = z.object({ value: FiniteNumberSchema, unit: UnitSchema }).strict();
export type Quantity = z.infer<typeof QuantitySchema>;
export const NamedQuantitySchema = z.object({ id: LocalIdSchema, quantity: QuantitySchema }).strict();
export type NamedQuantity = z.infer<typeof NamedQuantitySchema>;
export function convertQuantity(quantity: Quantity, to: Unit): Quantity {
  const source = QuantitySchema.parse(quantity);
  const target = UnitSchema.parse(to);
  const fromDefinition = unitDefinitions[source.unit];
  const toDefinition = unitDefinitions[target];
  if (fromDefinition.dimension !== toDefinition.dimension) {
    throw new MechanicValueError("incompatible_unit", `Cannot convert ${source.unit} to ${target}`);
  }
  return { value: finiteResult(source.value * (fromDefinition.scale / toDefinition.scale)), unit: target };
}

export const NumericToleranceSchema = z.object({
  absTol: FiniteNumberSchema.nonnegative(), relTol: FiniteNumberSchema.nonnegative(),
}).strict();
export type NumericTolerance = z.infer<typeof NumericToleranceSchema>;
export function withinTolerance(actual: number, expected: number, tolerance: NumericTolerance): boolean {
  FiniteNumberSchema.parse(actual);
  FiniteNumberSchema.parse(expected);
  const { absTol, relTol } = NumericToleranceSchema.parse(tolerance);
  const difference = Math.abs(actual - expected);
  const threshold = Math.max(absTol, relTol * Math.abs(expected));
  if (!Number.isFinite(difference) || !Number.isFinite(threshold)) {
    throw new MechanicValueError("nonfinite_result", "Tolerance comparison exceeded the numeric range");
  }
  return difference <= threshold;
}

export const BlockSchema = z.object({ id: LocalIdSchema, text: NonemptyTextSchema }).strict();
export type Block = z.infer<typeof BlockSchema>;
/** Span offsets use JavaScript UTF-16 indexes and an exclusive end. */
export const SpanSchema = z.object({
  blockId: LocalIdSchema, start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict().refine((span) => span.end > span.start, "Evidence span must be nonempty");
export type Span = z.infer<typeof SpanSchema>;
export const EdgeSchema = z.object({ from: LocalIdSchema, relation: LocalIdSchema, to: LocalIdSchema }).strict();
export type Edge = z.infer<typeof EdgeSchema>;
export function isValidSpan(span: Span, blocks: readonly Block[]): boolean {
  const parsed = SpanSchema.safeParse(span);
  if (!parsed.success) return false;
  const block = blocks.find((item) => item.id === parsed.data.blockId);
  return block !== undefined && parsed.data.end <= block.text.length;
}

export const BoundedVariableSchema = z.object({
  id: LocalIdSchema, min: FiniteNumberSchema, max: FiniteNumberSchema,
  step: FiniteNumberSchema.positive(), unit: UnitSchema,
}).strict().refine((variable) => variable.min <= variable.max && Number.isFinite(variable.max - variable.min), "Invalid variable range");
export type BoundedVariable = z.infer<typeof BoundedVariableSchema>;
export const BoundedModelSchema = z.object({
  inputs: z.array(BoundedVariableSchema).max(MECHANIC_LIMITS.variables),
  outputs: z.array(z.object({ id: LocalIdSchema, unit: UnitSchema, expression: ExprSchema }).strict()).min(1).max(MECHANIC_LIMITS.variables),
}).strict().superRefine((model, context) => {
  for (const group of ["inputs", "outputs"] as const) {
    if (new Set(model[group].map((item) => item.id)).size !== model[group].length) {
      context.addIssue({ code: "custom", path: [group], message: "Identifiers must be unique" });
    }
  }
  const names = model.inputs.map((input) => input.id);
  model.outputs.forEach((output, index) => {
    for (const issue of validateExpression(output.expression, names)) {
      context.addIssue({ code: "custom", path: ["outputs", index, "expression", ...issue.path], message: issue.message });
    }
  });
});
export type BoundedModel = z.infer<typeof BoundedModelSchema>;

export function evaluateBoundedModel(model: BoundedModel, values: Record<string, number>): NamedQuantity[] {
  const parsed = BoundedModelSchema.parse(model);
  const settings = FiniteValuesSchema.parse(values);
  const names = parsed.inputs.map((input) => input.id);
  if (Object.keys(settings).length !== names.length || Object.keys(settings).some((name) => !names.includes(name))) {
    throw new MechanicValueError("invalid_value", "Supply exactly the declared model inputs");
  }
  for (const input of parsed.inputs) {
    const value = settings[input.id];
    const stepIndex = value === undefined ? NaN : (value - input.min) / input.step;
    if (value === undefined || value < input.min || value > input.max || !Number.isFinite(stepIndex) ||
        Math.abs(stepIndex - Math.round(stepIndex)) > 1e-9) {
      throw new MechanicValueError("invalid_value", `Value is outside the allowed range or step: ${input.id}`);
    }
  }
  return parsed.outputs.map((output) => ({
    id: output.id, quantity: { value: evaluateExpression(output.expression, settings, names), unit: output.unit },
  }));
}
