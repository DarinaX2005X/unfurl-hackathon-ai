import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { ProviderFailure } from "../ai/failure";
import { jsonDigest } from "../ai/json";
import type { RunContext } from "../runs/ports";

export const CurriculumInstructionPolicySchema = z.object({ kind: z.literal("curriculum.instruction_policy"), invocationId: IdSchema,
  version: z.enum(["legacy-v2", "research-links-v1"]) }).strict();
export type CurriculumInstructionPolicy = z.infer<typeof CurriculumInstructionPolicySchema>["version"];
export const curriculumInstructionPolicyKey = (invocationId: string) => `curriculum.policy.v1:${invocationId}`;
const policyDigest = jsonDigest({ version: "curriculum-instruction-policy-v1" });
const digests = { schema: policyDigest, capability: policyDigest, validationPolicy: policyDigest, approval: null };

/** Any existing part step (including failed/running paid work) pins the historical producer.
 * A pristine invocation records its choice in a model-free step before any composition effect.
 */
export async function resolveCurriculumInstructionPolicy(context: RunContext, invocationId: string): Promise<CurriculumInstructionPolicy> {
  IdSchema.parse(invocationId);
  const key = curriculumInstructionPolicyKey(invocationId), prefix = `curriculum.v2:${invocationId}:`;
  const rows = await context.read(async tx => (await tx.query<{ step_key: string; status: string; input_digest: string; schema_digest: string;
    capability_digest: string; validation_policy_digest: string; approval_digest: string | null; result_reference: unknown }>(
    `SELECT step_key,status,input_digest,schema_digest,capability_digest,validation_policy_digest,approval_digest,result_reference
      FROM unfurl.run_steps WHERE job_id=$1 AND (step_key=$2 OR step_key LIKE $3)`, [context.claim.jobId, key, `${prefix}%`])).rows);
  const saved = rows.find(row => row.step_key === key);
  if (saved?.status === "succeeded") {
    const policy = CurriculumInstructionPolicySchema.parse(saved.result_reference);
    if (policy.invocationId !== invocationId || saved.input_digest !== jsonDigest({ invocationId, version: policy.version }) ||
        saved.schema_digest !== policyDigest || saved.capability_digest !== policyDigest || saved.validation_policy_digest !== policyDigest || saved.approval_digest !== null) {
      throw new ProviderFailure("invalid_output");
    }
    return policy.version;
  }
  const version: CurriculumInstructionPolicy = rows.some(row => row.step_key.startsWith(prefix)) ? "legacy-v2" : "research-links-v1";
  const policy = { kind: "curriculum.instruction_policy" as const, invocationId, version };
  const result = await context.step({ key, input: { invocationId, version }, digests,
    outputSchema: CurriculumInstructionPolicySchema, resultSchema: CurriculumInstructionPolicySchema,
    async effect() { return policy; }, async commit(_tx, output) { return output; } });
  return result.version;
}

export const STRICT_RESEARCH_LINK_INSTRUCTIONS = `Before returning, self-check every outcomeEvidence entry and every claimRef: the referenced claim must exist in this same response, and that claim's outcomeIds MUST include the exact outcomeId of that evidence entry. A claim about a related outcome is not automatically linked to this outcome. If a sourced claim substantively supports multiple supplied outcomes, including an integrated or capstone outcome, declare every supported target ID explicitly in that claim's outcomeIds; alternatively provide separate properly grounded claims for those outcomes. Do not cite a claim for an outcome absent from its outcomeIds. Do not add an unsupported outcome merely to satisfy this membership rule. Keep the exact source support, distinguish inference from direct support, and preserve the full requested learning depth. Verify these links locally in your response before submitting it; do not leave their repair to the outer planner.`;
