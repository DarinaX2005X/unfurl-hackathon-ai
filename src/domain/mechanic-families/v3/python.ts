import { z } from "zod";
import { LocalIdSchema, NonemptyTextSchema, type FamilyDescriptor, type SubmissionIssue } from "../v2/shared";

export const PYTHON_MECHANIC_VERSION = 3 as const;
export const PYTHON_RESPONSE_SCHEMA_VERSION = 3 as const;
export const PYTHON_RUNTIME_PROFILE = "python_stdlib_v1" as const;
export const PYTHON_LIMITS = Object.freeze({
  sourceBytes: 12_000, sourceLines: 300, jsonBytes: 16_384, jsonDepth: 12, jsonNodes: 2_048,
  shapeDepth: 5, shapeNodes: 64, objectProperties: 16, arrayItems: 128, stringCharacters: 2_000,
  publicCases: 4, hiddenCases: 8, repairLocations: 8, explanationCharacters: 2_000,
  stdoutBytesPerCase: 65_536, diagnosticCharacters: 2_000,
});
const encoder = new TextEncoder();
const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Preflight runs before recursive Zod parsing and never calls accessors or toJSON. */
function finiteJsonWithinBudget(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > PYTHON_LIMITS.jsonNodes || depth > PYTHON_LIMITS.jsonDepth) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item));
    if (typeof item === "string") return item.length <= PYTHON_LIMITS.jsonBytes;
    if (typeof item !== "object" || ancestors.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const entries = Object.entries(descriptors).filter(([key]) => !(Array.isArray(item) && key === "length"));
    if (Object.getOwnPropertySymbols(item).length || entries.some(([key, descriptor]) => reservedKeys.has(key) || !("value" in descriptor))) return false;
    const valid = entries.every(([, descriptor]) => visit(descriptor.value, depth + 1));
    ancestors.delete(item);
    return valid;
  };
  try { return visit(value, 0) && encoder.encode(JSON.stringify(value)).byteLength <= PYTHON_LIMITS.jsonBytes; }
  catch { return false; }
}
export type ExecutionJson = null | boolean | number | string | ExecutionJson[] | { [key: string]: ExecutionJson };
const ExecutionJsonValueSchema: z.ZodType<ExecutionJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite().refine((value) => !Number.isInteger(value) || Number.isSafeInteger(value), "Integral JSON values must be exactly interoperable with Python"), z.string().max(PYTHON_LIMITS.jsonBytes),
  z.array(ExecutionJsonValueSchema).max(PYTHON_LIMITS.jsonNodes),
  z.record(z.string().refine((key) => !reservedKeys.has(key), "Reserved JSON key"), ExecutionJsonValueSchema),
]));
export const ExecutionJsonSchema = z.unknown().superRefine((value, context) => {
  if (!finiteJsonWithinBudget(value)) context.addIssue({ code: "custom", message: "Execution JSON must be finite plain data within 16 KiB, depth 12 and 2,048 nodes" });
}).pipe(ExecutionJsonValueSchema);
export function canonicalExecutionJson(value: unknown): string {
  const encode = (item: ExecutionJson): string => Array.isArray(item) ? `[${item.map(encode).join(",")}]` :
    item !== null && typeof item === "object" ? `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key]!)}`).join(",")}}` : JSON.stringify(item);
  return encode(ExecutionJsonSchema.parse(value));
}

function wellFormedSource(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    const unit = source.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}

const NormalizedPythonSourceSchema = z.string().max(PYTHON_LIMITS.sourceBytes).superRefine((source, context) => {
  if (!wellFormedSource(source)) context.addIssue({ code: "custom", message: "Python source must be well-formed Unicode text" });
  if (encoder.encode(source).byteLength > PYTHON_LIMITS.sourceBytes) context.addIssue({ code: "custom", message: "Python source exceeds 12,000 UTF-8 bytes" });
  if (source.split("\n").length > PYTHON_LIMITS.sourceLines) context.addIssue({ code: "custom", message: "Python source exceeds 300 lines" });
});
/** Only line endings are normalized; indentation, spacing and learner code are retained. */
export const PythonSourceSchema = z.string().transform((source) => source.replace(/\r\n?/g, "\n")).pipe(NormalizedPythonSourceSchema);
export type PythonSource = z.infer<typeof PythonSourceSchema>;

export type BoundedValueShape =
  | { type: "null" }
  | { type: "boolean" }
  | { type: "number"; integer: boolean; minimum: number; maximum: number }
  | { type: "string"; minLength: number; maxLength: number }
  | { type: "array"; minItems: number; maxItems: number; items: BoundedValueShape }
  | { type: "object"; properties: Array<{ key: string; shape: BoundedValueShape }> };
const shapeKey = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine((key) => !reservedKeys.has(key), "Reserved object property");
const ShapeNodeSchema: z.ZodType<BoundedValueShape> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("null") }).strict(),
  z.object({ type: z.literal("boolean") }).strict(),
  z.object({ type: z.literal("number"), integer: z.boolean(), minimum: z.number().finite(), maximum: z.number().finite() }).strict()
    .refine((shape) => shape.minimum <= shape.maximum && (!shape.integer || Math.ceil(shape.minimum) <= Math.floor(shape.maximum)), "Numeric bounds must contain at least one allowed value"),
  z.object({ type: z.literal("string"), minLength: z.number().int().nonnegative(), maxLength: z.number().int().nonnegative().max(PYTHON_LIMITS.stringCharacters) }).strict()
    .refine((shape) => shape.minLength <= shape.maxLength, "String bounds must be ordered"),
  z.object({ type: z.literal("array"), minItems: z.number().int().nonnegative(), maxItems: z.number().int().nonnegative().max(PYTHON_LIMITS.arrayItems), items: ShapeNodeSchema }).strict()
    .refine((shape) => shape.minItems <= shape.maxItems, "Array bounds must be ordered"),
  z.object({ type: z.literal("object"), properties: z.array(z.object({ key: shapeKey, shape: ShapeNodeSchema }).strict()).max(PYTHON_LIMITS.objectProperties) }).strict()
    .refine((shape) => new Set(shape.properties.map((property) => property.key)).size === shape.properties.length, "Object properties must be unique"),
]));
function shapeWithinBudget(value: unknown): boolean {
  if (!finiteJsonWithinBudget(value)) return false;
  let nodes = 0;
  const visit = (shape: unknown, depth: number): boolean => {
    if (++nodes > PYTHON_LIMITS.shapeNodes || depth > PYTHON_LIMITS.shapeDepth || shape === null || typeof shape !== "object" || Array.isArray(shape)) return false;
    const node = shape as Record<string, unknown>;
    if (node.type === "array") return visit(node.items, depth + 1);
    if (node.type === "object" && Array.isArray(node.properties)) return node.properties.every((property) =>
      property !== null && typeof property === "object" && visit((property as Record<string, unknown>).shape, depth + 1));
    return true;
  };
  return visit(value, 1);
}
export const BoundedValueShapeSchema = z.unknown().superRefine((value, context) => {
  if (!shapeWithinBudget(value)) context.addIssue({ code: "custom", message: "Value shape exceeds its finite JSON, depth-5 or 64-node bounds" });
}).pipe(ShapeNodeSchema);

function schemaForShape(shape: BoundedValueShape): z.ZodType<ExecutionJson> {
  switch (shape.type) {
    case "null": return z.null();
    case "boolean": return z.boolean();
    case "number": return shape.integer ? z.number().int().min(shape.minimum).max(shape.maximum) : z.number().finite().min(shape.minimum).max(shape.maximum);
    case "string": return z.string().min(shape.minLength).max(shape.maxLength);
    case "array": return z.array(schemaForShape(shape.items)).min(shape.minItems).max(shape.maxItems);
    case "object": return z.object(Object.fromEntries(shape.properties.map((property) => [property.key, schemaForShape(property.shape)]))).strict();
  }
}
/** Enforces both the global execution budgets and the authored shape. */
export function parseExecutionValue(shape: BoundedValueShape, value: unknown): ExecutionJson {
  return schemaForShape(BoundedValueShapeSchema.parse(shape)).parse(ExecutionJsonSchema.parse(value));
}
export function validateExecutionValue(shape: BoundedValueShape, value: unknown): SubmissionIssue[] {
  try { parseExecutionValue(shape, value); return []; }
  catch (error) {
    return error instanceof z.ZodError ? error.issues.map((issue) => ({
      path: issue.path.map((segment) => typeof segment === "symbol" ? segment.toString() : segment),
      code: issue.code === "too_big" || issue.code === "too_small" ? "out_of_bounds" : "invalid_structure", message: issue.message,
    })) : [{ path: [], code: "invalid_structure", message: "Value does not match the authored input/output contract" }];
  }
}

const pythonTaskBase = {
  artifactType: z.literal("python_function"), language: z.literal("python"), runtimeProfile: z.literal(PYTHON_RUNTIME_PROFILE), entrypoint: z.literal("solve"),
  specification: NonemptyTextSchema, inputShape: BoundedValueShapeSchema, outputShape: BoundedValueShapeSchema,
  starterSource: PythonSourceSchema.refine((source) => source.trim().length > 0, "Provide the original or starter source"),
  publicCases: z.array(z.object({ id: LocalIdSchema, input: ExecutionJsonSchema }).strict()).min(1).max(PYTHON_LIMITS.publicCases),
};
function validatePublicCases(config: { inputShape: BoundedValueShape; publicCases: Array<{ id: string; input: ExecutionJson }> }, context: z.RefinementCtx): void {
  if (new Set(config.publicCases.map((item) => item.id)).size !== config.publicCases.length) context.addIssue({ code: "custom", path: ["publicCases"], message: "Public case identifiers must be unique" });
  config.publicCases.forEach((item, index) => {
    for (const issue of validateExecutionValue(config.inputShape, item.input)) context.addIssue({ code: "custom", path: ["publicCases", index, "input", ...issue.path], message: issue.message });
  });
}
export const PythonArtifactConfigSchema = z.object({ kind: z.literal("artifact_construction"), ...pythonTaskBase }).strict().superRefine(validatePublicCases);
export type PythonArtifactConfig = z.infer<typeof PythonArtifactConfigSchema>;
export const PythonArtifactResponseSchema = z.object({
  kind: z.literal("artifact_construction"), action: z.literal("build_artifact"), artifactType: z.literal("python_function"), source: PythonSourceSchema,
}).strict();
export type PythonArtifactResponse = z.infer<typeof PythonArtifactResponseSchema>;
export const PythonRepairConfigSchema = z.object({ kind: z.literal("diagnosis_repair"), ...pythonTaskBase }).strict().superRefine(validatePublicCases);
export type PythonRepairConfig = z.infer<typeof PythonRepairConfigSchema>;
export const PythonFaultRegionSchema = z.object({ startLine: z.number().int().min(1).max(PYTHON_LIMITS.sourceLines), endLine: z.number().int().min(1).max(PYTHON_LIMITS.sourceLines) }).strict()
  .refine((region) => region.startLine <= region.endLine, "A source region must be ordered");
export const PythonRepairResponseSchema = z.object({
  kind: z.literal("diagnosis_repair"), action: z.literal("repair"), artifactType: z.literal("python_function"),
  locations: z.array(PythonFaultRegionSchema).max(PYTHON_LIMITS.repairLocations).refine((regions) => new Set(regions.map((region) => `${region.startLine}:${region.endLine}`)).size === regions.length, "Source regions must be unique"),
  source: PythonSourceSchema, explanation: z.string().max(PYTHON_LIMITS.explanationCharacters),
}).strict();
export type PythonRepairResponse = z.infer<typeof PythonRepairResponseSchema>;

export const PythonProgramErrorCodeSchema = z.enum(["syntax_error", "runtime_error", "time_limit", "memory_limit", "output_limit", "file_limit", "process_limit", "invalid_result"]);
export type PythonProgramErrorCode = z.infer<typeof PythonProgramErrorCodeSchema>;
export const PythonProgramResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), value: ExecutionJsonSchema,
    stdout: z.string().max(PYTHON_LIMITS.stdoutBytesPerCase).refine((value) => encoder.encode(value).byteLength <= PYTHON_LIMITS.stdoutBytesPerCase, "stdout exceeds 64 KiB for this case"),
  }).strict(),
  z.object({ status: z.literal("error"), code: PythonProgramErrorCodeSchema, message: z.string().trim().min(1).max(PYTHON_LIMITS.diagnosticCharacters),
    line: z.number().int().min(1).max(PYTHON_LIMITS.sourceLines + 1).nullable(), column: z.number().int().min(1).max(PYTHON_LIMITS.sourceBytes + 1).nullable(),
  }).strict(),
]);
export type PythonProgramResult = z.infer<typeof PythonProgramResultSchema>;
export const PythonExecutionObservationSchema = z.object({
  kind: z.literal("python_execution"), runtimeProfile: z.literal(PYTHON_RUNTIME_PROFILE),
  cases: z.array(z.object({ caseId: LocalIdSchema, input: ExecutionJsonSchema, result: PythonProgramResultSchema }).strict()).min(1).max(PYTHON_LIMITS.publicCases),
}).strict().refine((observation) => new Set(observation.cases.map((item) => item.caseId)).size === observation.cases.length, "Public execution case identifiers must be unique");
export type PythonExecutionObservation = z.infer<typeof PythonExecutionObservationSchema>;
/** Exact projection join: a hidden or stale case can never be relabeled as a public run. */
export function parsePythonPublicObservation(config: PythonArtifactConfig | PythonRepairConfig, value: unknown): PythonExecutionObservation {
  const parsedConfig = config.kind === "artifact_construction" ? PythonArtifactConfigSchema.parse(config) : PythonRepairConfigSchema.parse(config);
  const observation = PythonExecutionObservationSchema.parse(value);
  if (observation.cases.length !== parsedConfig.publicCases.length || observation.cases.some((item, index) =>
    item.caseId !== parsedConfig.publicCases[index]!.id || canonicalExecutionJson(item.input) !== canonicalExecutionJson(parsedConfig.publicCases[index]!.input))) {
    throw new Error("Execution observation must contain exactly the authored public cases, inputs and order");
  }
  return observation;
}

const baseDescriptor = {
  version: PYTHON_MECHANIC_VERSION, responseSchemaVersion: PYTHON_RESPONSE_SCHEMA_VERSION,
  actions: ["run"] as ["run"], supportedEvaluators: ["execution"] as ["execution"],
  accessibility: { keyboardEquivalent: true, nonVisualSummary: true },
};
function sourceIssues(source: string): SubmissionIssue[] {
  return source.trim().length ? [] : [{ path: ["source"], code: "required", message: "Write a solve(payload) implementation before submitting." }];
}
export const pythonArtifactDescriptor: FamilyDescriptor<PythonArtifactConfig, PythonArtifactResponse, 3> = {
  ...baseDescriptor, id: "artifact_construction", configSchema: PythonArtifactConfigSchema, responseSchema: PythonArtifactResponseSchema,
  rendererKey: "python.artifact.v3", requiredAffordances: ["python_source_editor", "public_case_results", "immutable_run_input"], requirements: ["activity", "sandbox"],
  limitations: ["Runs solve(payload) with finite JSON input and output under the python_stdlib_v1 profile.", "Requires the configured durable isolated executor; the numeric-expression v2 mechanic is not a substitute.", "Public runs show only public cases and do not award correctness or XP."],
  createInitialResponse: (config) => ({ kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source: config.starterSource }),
  validateSubmission: (_config, response) => sourceIssues(response.source),
};
export const pythonRepairDescriptor: FamilyDescriptor<PythonRepairConfig, PythonRepairResponse, 3> = {
  ...baseDescriptor, id: "diagnosis_repair", configSchema: PythonRepairConfigSchema, responseSchema: PythonRepairResponseSchema,
  rendererKey: "python.repair.v3", requiredAffordances: ["original_source", "source_region_selection", "python_source_editor", "repair_explanation", "public_case_results"], requirements: ["activity", "sandbox", "model"],
  limitations: ["Repairs a bounded Python solve(payload) function under the python_stdlib_v1 profile.", "Fault regions refer to the original source; behavior, localization and any authored explanation rubric are assessed separately.", "A public run is execution evidence, not a grade or proof of theoretical understanding."],
  createInitialResponse: (config) => ({ kind: "diagnosis_repair", action: "repair", artifactType: "python_function", locations: [], source: config.starterSource, explanation: "" }),
  validateSubmission: (config, response) => [
    ...sourceIssues(response.source),
    ...(response.locations.length ? [] : [{ path: ["locations"], code: "required" as const, message: "Identify the relevant region in the original source." }]),
    ...response.locations.flatMap((region, index) => region.endLine <= config.starterSource.split("\n").length ? [] : [{ path: ["locations", index], code: "invalid_reference" as const, message: "Select lines that exist in the original source." }]),
    ...(response.explanation.trim().length ? [] : [{ path: ["explanation"], code: "required" as const, message: "Explain why the repair changes the behavior." }]),
  ],
};
export const descriptors = [pythonArtifactDescriptor, pythonRepairDescriptor] as const;
