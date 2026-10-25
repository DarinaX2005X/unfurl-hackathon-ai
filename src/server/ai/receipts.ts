import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonObjectSchema, JsonValueSchema } from "../../domain/common";
import type { DbTransaction } from "../db";
import { ProviderFailure } from "./failure";

const EvidenceSchema = z.object({
  operation_id: IdSchema, run_step_id: IdSchema, input_digest: DigestSchema, request_digest: DigestSchema,
  response_digest: DigestSchema, provider_request_id: z.string().min(1).max(256), rate_card_digest: DigestSchema,
  state: z.literal("settled"), usage: JsonObjectSchema, result: JsonValueSchema,
});
/** Caller already holds its authoritative run/step guard. This joins a real paid response to that exact step input. */
export async function loadProviderResponseEvidence(tx: DbTransaction, expected: {
  operationId: string; runStepId: string; inputDigest: string; requestDigest?: string;
}) {
  const row = (await tx.query(`SELECT o.id AS operation_id,o.run_step_id,s.input_digest,o.request_digest,
    r.response_digest,r.provider_request_id,o.rate_card_digest,o.state,r.usage,r.result
    FROM unfurl.ai_provider_operations o JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id
    JOIN unfurl.run_steps s ON s.id=o.run_step_id
    WHERE o.id=$1 AND o.run_step_id=$2 AND s.input_digest=$3 AND o.state='settled'`,
  [expected.operationId, expected.runStepId, expected.inputDigest])).rows[0];
  const parsed = EvidenceSchema.safeParse(row);
  if (!parsed.success || (expected.requestDigest && parsed.data.request_digest !== expected.requestDigest)) throw new ProviderFailure("invalid_output");
  const result = z.object({ failure: z.null() }).safeParse(parsed.data.result);
  if (!result.success) throw new ProviderFailure("invalid_output");
  return { operationId: parsed.data.operation_id, runStepId: parsed.data.run_step_id, inputDigest: parsed.data.input_digest,
    requestDigest: parsed.data.request_digest, responseDigest: parsed.data.response_digest,
    providerRequestId: parsed.data.provider_request_id, rateCardDigest: parsed.data.rate_card_digest,
    usage: parsed.data.usage, result: parsed.data.result };
}
