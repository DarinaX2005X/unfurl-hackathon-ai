import { z } from "zod";
import { DigestSchema, IdSchema, IsoDateTimeSchema, JsonValueSchema, RevisionSchema, type JsonValue } from "./common";
import { BlockSchema, FiniteNumberSchema, FiniteValuesSchema, LocalIdSchema, MECHANIC_LIMITS, NamedQuantitySchema, NonemptyTextSchema } from "./mechanic-families/v2/shared";
import { PythonExecutionObservationSchema } from "./mechanic-families/v3/python";

const MAX_RESPONSE_BYTES = 131_072;

/** Stable JSON, bounded before parsing/hashing. Arrays retain their authored order. */
export function canonicalResponseJson(response: JsonValue): string {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const encode = (value: JsonValue, depth: number): string => {
    nodes += 1;
    if (depth > 32 || nodes > 10_000) throw new Error("Response exceeds structural limits");
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Response numbers must be finite");
      return JSON.stringify(value);
    }
    if (typeof value === "string") {
      if (value.length > MAX_RESPONSE_BYTES) throw new Error("Response is too large");
      return JSON.stringify(value);
    }
    if (typeof value !== "object" || ancestors.has(value)) throw new Error("Response must be acyclic JSON");
    ancestors.add(value);
    let encoded: string;
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const child of value) parts.push(encode(child, depth + 1));
      encoded = `[${parts.join(",")}]`;
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Response must contain plain JSON objects");
      encoded = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key]!, depth + 1)}`).join(",")}}`;
    }
    ancestors.delete(value);
    if (encoded.length > MAX_RESPONSE_BYTES) throw new Error("Response is too large");
    return encoded;
  };
  const encoded = encode(response, 1);
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESPONSE_BYTES) throw new Error("Response is too large");
  return encoded;
}

export async function responseDigest(response: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalResponseJson(response));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const ActivityResponseSchema = z.unknown().superRefine((value, context) => {
  try { canonicalResponseJson(value as JsonValue); }
  catch { context.addIssue({ code: "custom", message: "Response must be bounded, finite JSON" }); }
}).pipe(JsonValueSchema);

export const InputIdentitySchema = z.object({
  activitySessionId: IdSchema, inputRevision: RevisionSchema, responseDigest: DigestSchema,
}).strict();
export type InputIdentity = z.infer<typeof InputIdentitySchema>;
export const InputSnapshotSchema = InputIdentitySchema.extend({ response: ActivityResponseSchema }).strict();
export type InputSnapshot = z.infer<typeof InputSnapshotSchema>;

/** A schema validates shape; this additionally verifies the immutable content identity. */
export async function validateInputSnapshot(value: unknown): Promise<InputSnapshot> {
  const snapshot = InputSnapshotSchema.parse(value);
  if (await responseDigest(snapshot.response) !== snapshot.responseDigest) throw new Error("Response digest does not match its snapshot");
  return snapshot;
}

export function sameInputIdentity(left: InputIdentity, right: InputIdentity): boolean {
  return left.activitySessionId === right.activitySessionId && left.inputRevision === right.inputRevision &&
    left.responseDigest === right.responseDigest;
}

export const ActivityActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run") }).strict(),
  z.object({ kind: z.literal("prediction.commit") }).strict(),
  z.object({ kind: z.literal("experiment.query"), input: FiniteNumberSchema }).strict(),
  z.object({ kind: z.literal("intervention.apply"), assignments: FiniteValuesSchema.refine((values) => Object.keys(values).length > 0, "Supply an intervention") }).strict(),
  z.object({ kind: z.literal("dialogue.turn"), text: NonemptyTextSchema }).strict(),
]);
export type ActivityAction = z.infer<typeof ActivityActionSchema>;

const PublicCaseResultSchema = z.object({
  caseId: LocalIdSchema,
  input: FiniteValuesSchema,
  output: FiniteNumberSchema.nullable(),
  error: z.enum(["division_by_zero", "nonfinite_result", "invalid_input"]).nullable(),
}).strict().refine((result) => (result.error === null) === (result.output !== null), "A case has either an output or an error");

/** Only explicitly public observations belong here; hidden tests are never cases. */
export const PublicObservationSchema = z.discriminatedUnion("kind", [
  PythonExecutionObservationSchema,
  z.object({ kind: z.literal("values"), values: z.array(NamedQuantitySchema).min(1).max(MECHANIC_LIMITS.variables) }).strict(),
  z.object({ kind: z.literal("trace"), states: z.array(z.object({
    step: z.number().int().positive().max(MECHANIC_LIMITS.steps), values: FiniteValuesSchema,
  }).strict()).min(1).max(MECHANIC_LIMITS.steps) }).strict(),
  z.object({ kind: z.literal("case_results"), cases: z.array(PublicCaseResultSchema).min(1).max(MECHANIC_LIMITS.steps) }).strict(),
  z.object({ kind: z.literal("dialogue"), text: NonemptyTextSchema, revealedFacts: z.array(BlockSchema).max(MECHANIC_LIMITS.variables) }).strict(),
]).superRefine((observation, context) => {
  const ids = observation.kind === "values" ? observation.values.map((value) => value.id) :
    observation.kind === "trace" ? observation.states.map((state) => state.step) :
    observation.kind === "case_results" || observation.kind === "python_execution" ? observation.cases.map((result) => result.caseId) :
    observation.revealedFacts.map((fact) => fact.id);
  if (new Set<string | number>(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Observation identifiers must be unique" });
});
export type PublicObservation = z.infer<typeof PublicObservationSchema>;

export const ActionReceiptSchema = z.object({
  id: IdSchema, clientActionId: IdSchema, input: InputIdentitySchema,
  sessionRevision: RevisionSchema,
  status: z.enum(["pending", "completed", "unavailable"]),
  observation: PublicObservationSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  if (receipt.status !== "completed" && receipt.observation !== null) {
    context.addIssue({ code: "custom", path: ["observation"], message: "An unfinished action has no observation" });
  }
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

export function isCurrentObservation(receipt: ActionReceipt, currentInput: InputIdentity): boolean {
  return receipt.status === "completed" && receipt.observation !== null && sameInputIdentity(receipt.input, currentInput);
}

export const ActivityEventPublicSchema = z.object({
  id: IdSchema, seq: RevisionSchema, at: IsoDateTimeSchema,
  action: ActivityActionSchema, receipt: ActionReceiptSchema,
}).strict().superRefine((event, context) => {
  if (event.receipt.sessionRevision !== event.seq) {
    context.addIssue({ code: "custom", path: ["seq"], message: "Event and receipt revisions must agree" });
  }
  if (event.receipt.status === "completed") {
    const observation = event.receipt.observation;
    const kind = event.action.kind;
    const compatible = kind === "prediction.commit" ? observation === null :
      kind === "dialogue.turn" ? observation?.kind === "dialogue" :
      kind === "experiment.query" || kind === "intervention.apply" ? observation?.kind === "values" :
      observation !== null && observation.kind !== "dialogue";
    if (!compatible) context.addIssue({ code: "custom", path: ["receipt", "observation"], message: "Observation does not match the action" });
  }
});
export type ActivityEventPublic = z.infer<typeof ActivityEventPublicSchema>;

export const ActivitySessionPublicSchema = z.object({
  id: IdSchema, enrollmentId: IdSchema, taskId: IdSchema, taskVersion: RevisionSchema,
  revision: RevisionSchema, inputRevision: z.number().int().nonnegative(),
  status: z.enum(["active", "budget_exhausted", "completed"]),
  remainingActions: z.number().int().min(0).max(MECHANIC_LIMITS.actions),
  events: z.array(ActivityEventPublicSchema).max(100),
}).strict().superRefine((session, context) => {
  if (session.status === "budget_exhausted" && session.remainingActions !== 0) {
    context.addIssue({ code: "custom", path: ["remainingActions"], message: "An exhausted session has no remaining actions" });
  }
  const eventIds = new Set<string>();
  let previousSequence = 0;
  session.events.forEach((event, index) => {
    if (eventIds.has(event.id) || event.seq <= previousSequence || event.seq > session.revision) {
      context.addIssue({ code: "custom", path: ["events", index], message: "Events must be unique and in committed revision order" });
    }
    if (event.receipt.input.activitySessionId !== session.id || event.receipt.input.inputRevision > session.inputRevision) {
      context.addIssue({ code: "custom", path: ["events", index], message: "Receipt belongs to another session or a future input" });
    }
    previousSequence = event.seq;
    eventIds.add(event.id);
  });
});
export type ActivitySessionPublic = z.infer<typeof ActivitySessionPublicSchema>;

export const SaveActivityInputSchema = z.object({
  expectedInputRevision: z.number().int().nonnegative(), response: ActivityResponseSchema,
}).strict();
export type SaveActivityInput = z.infer<typeof SaveActivityInputSchema>;
export const ActivityActionRequestSchema = z.object({
  expectedRevision: RevisionSchema, clientActionId: IdSchema,
  inputRevision: RevisionSchema, responseDigest: DigestSchema, action: ActivityActionSchema,
}).strict();
export type ActivityActionRequest = z.infer<typeof ActivityActionRequestSchema>;
export const SubmitActivityAttemptSchema = InputIdentitySchema.extend({
  taskId: IdSchema, taskVersion: RevisionSchema, response: ActivityResponseSchema, clientAttemptId: IdSchema,
}).strict();
export type SubmitActivityAttempt = z.infer<typeof SubmitActivityAttemptSchema>;

export function activityActionCost(action: ActivityAction): 0 | 1 {
  return action.kind === "prediction.commit" ? 0 : 1;
}
