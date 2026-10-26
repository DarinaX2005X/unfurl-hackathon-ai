import "server-only";
import { z } from "zod";
import { IdSchema, type JsonValue } from "../../domain/common";
import { MODEL_ID, MODEL_POLICY_VERSION } from "../ai/constants";
import { ProviderFailure } from "../ai/failure";
import { ServiceFault } from "../auth/errors";
import { jsonDigest } from "../ai/json";
import type { ModelPort } from "../ai/ports";
import type { DbTransaction } from "../db";
import { appendChatEvent } from "../runs/events";
import { stableExecutionId } from "../runs/identity";
import type { RunContext, StepEffectContext } from "../runs/ports";
import { asAgentTarget, jsonSchema, jsonValue } from "../agent-turns/repository";
import { PostgresResearchRepository } from "../research/repository";
import type { Passage } from "../research/ports";
import { PostgresCurriculumResearchRepository } from "./repository";
import type { SourceClaim } from "./contracts";
import { researchInstructions } from "./composer";
import { CurriculumValidationFailure, CurriculumValidationFeedbackSchema } from "./validation-feedback";

export const curriculumPartKey = (invocationId: string, phase: string, index: number) =>
  `curriculum.v2:${invocationId}:${phase}:${String(index).padStart(8, "0")}`;
export interface SavedCurriculumPart {
  step_key: string; input_digest: string; schema_digest: string; capability_digest: string; validation_policy_digest: string;
  approval_digest: string | null; result_reference: unknown;
}
const RejectedPartSchema = z.object({ partRejected: z.literal(true), validationFeedback: CurriculumValidationFeedbackSchema.optional() }).strict();
const rejectedPart = (error: unknown) => ({ partRejected: true as const,
  ...(error instanceof CurriculumValidationFailure ? { validationFeedback: error.feedback } : {}) });
function throwRejectedPart(value: z.infer<typeof RejectedPartSchema>): never {
  if (value.validationFeedback) throw new CurriculumValidationFailure(value.validationFeedback);
  throw new ProviderFailure("invalid_output");
}
const rejectable = (error: unknown) => error instanceof z.ZodError
  || (error instanceof ProviderFailure && error.code === "invalid_output")
  || (error instanceof ServiceFault && [400, 409].includes(error.status));
export async function readCurriculumParts(context: RunContext, invocationId: string): Promise<Map<string, SavedCurriculumPart>> {
  const rows = await context.read(async (tx) => (await tx.query<SavedCurriculumPart>(`SELECT step_key,input_digest,schema_digest,
    capability_digest,validation_policy_digest,approval_digest,result_reference FROM unfurl.run_steps
    WHERE job_id=$1 AND status='succeeded' AND step_key LIKE $2 ORDER BY step_key`,
  [context.claim.jobId, `curriculum.v2:${invocationId}:%`])).rows);
  return new Map(rows.map((row) => [row.step_key, row]));
}

/** Each paid part commits independently. The executor yields before a second new effect. */
export async function runCurriculumPart<T, R>(context: RunContext, model: ModelPort, input: {
  invocationId: string; phase: string; index: number; request: unknown; instructions: string;
  outputSchema: z.ZodType<T>; resultSchema: z.ZodType<R>;
  saved: ReadonlyMap<string, SavedCurriculumPart>;
  completedSummary: string;
  commit(tx: DbTransaction, output: T, step: Pick<StepEffectContext, "stepId">): Promise<R>;
}): Promise<R> {
  const target = asAgentTarget(context.claim.target);
  const key = curriculumPartKey(input.invocationId, input.phase, input.index);
  const actionId = stableExecutionId(input.invocationId, key);
  const EnvelopeSchema = z.union([z.object({ stepId: IdSchema, value: input.outputSchema }).strict(),
    RejectedPartSchema.extend({ stepId: IdSchema })]);
  const ResultSchema = z.union([input.resultSchema, RejectedPartSchema]);
  const stepInput = jsonValue({ invocationId: input.invocationId, request: input.request, instructionsDigest: jsonDigest(input.instructions) });
  const digests = { schema: jsonDigest(z.toJSONSchema(input.outputSchema), 65536),
    capability: jsonDigest({ model: MODEL_ID, policy: MODEL_POLICY_VERSION, parts: "curriculum-parts-v2" }),
    validationPolicy: jsonDigest({ version: "curriculum-parts-v2" }), approval: null };
  const saved = input.saved.get(key);
  if (saved) {
    if (saved.input_digest !== jsonDigest(stepInput) || saved.schema_digest !== digests.schema || saved.capability_digest !== digests.capability
      || saved.validation_policy_digest !== digests.validationPolicy || saved.approval_digest !== null) throw new ProviderFailure("invalid_output");
    const rejected = RejectedPartSchema.safeParse(saved.result_reference);
    if (rejected.success) throwRejectedPart(rejected.data);
    return input.resultSchema.parse(saved.result_reference);
  }
  const result = await context.step({ key, executionProfile: "longform_curriculum",
    input: stepInput, digests,
    outputSchema: jsonSchema(EnvelopeSchema), resultSchema: jsonSchema(ResultSchema),
    prepare: async (tx) => {
      const started = (await tx.query(`SELECT id FROM unfurl.agent_turn_events WHERE run_id=$1 AND type='action.started'
        AND event->>'invocationId'=$2 LIMIT 1`, [target.runId, actionId])).rows[0];
      if (!started) await appendChatEvent(tx, target, { type: "action.started", invocationId: actionId,
        action: "build_outline", labelKey: "generation.planCourse" });
    },
    effect: async (step): Promise<JsonValue> => {
      const budget = step.budgetOperation(input.phase);
      try {
        const response = await model.generateStructured({ operationId: budget.logicalOperationId, purpose: "curriculum",
          instructionVersion: "curriculum-parts-v2", trustedInstructions: `${researchInstructions}\n${input.instructions}`,
          untrustedInput: jsonValue(input.request), model: MODEL_ID, maxOutputTokens: 16384, executionProfile: "longform_curriculum",
          deadlineAt: step.deadlineAt, budget, schema: input.outputSchema, schemaId: `curriculum_${input.phase}`, schemaVersion: 2,
        }, step.signal);
        return jsonValue({ stepId: step.stepId, value: response.data });
      } catch (error) {
        if (!rejectable(error)) throw error;
        return jsonValue({ stepId: step.stepId, ...rejectedPart(error) });
      }
    },
    commit: async (tx, raw) => {
      const output = EnvelopeSchema.parse(raw);
      try {
        if ("partRejected" in output) throwRejectedPart(output);
        const saved = input.resultSchema.parse(await input.commit(tx, output.value, { stepId: output.stepId }));
        await context.emitChat(tx, { type: "action.completed", invocationId: actionId,
          resultSummary: input.completedSummary, sourceIds: [] });
        return jsonValue(saved);
      } catch (error) {
        if (!rejectable(error)) throw error;
        await context.emitChat(tx, { type: "action.failed", invocationId: actionId,
          error: { code: "generation_failed", messageKey: "generation.invalidResponse", retryable: false, requestId: actionId } });
        return jsonValue(rejectedPart(error));
      }
    },
  });
  const rejected = RejectedPartSchema.safeParse(result);
  if (rejected.success) throwRejectedPart(rejected.data);
  return input.resultSchema.parse(result);
}

/** Proof is private until final assembly. Canonical passage identities survive deduplication. */
export async function persistPartFacts(tx: DbTransaction, input: {
  claims: SourceClaim[]; passages: Passage[]; authorizedSourceIds: ReadonlySet<string>;
}) {
  const sources = new PostgresResearchRepository();
  const research = new PostgresCurriculumResearchRepository();
  const identities = new Map<string, string>();
  const passages = new Map<string, Passage>();
  for (const passage of input.passages) {
    const saved = await sources.savePassage(tx, passage);
    identities.set(passage.id, saved.id); passages.set(saved.id, saved);
  }
  const claims: SourceClaim[] = [];
  for (const claim of input.claims) claims.push(await research.saveClaim(tx,
    { ...claim, passageIds: claim.passageIds.map((id) => identities.get(id) ?? id) }, input.authorizedSourceIds));
  return { claims, passages: Array.from(passages.values()) };
}
