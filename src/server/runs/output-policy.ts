import "server-only";
import { z } from "zod";
import type { DbTransaction } from "../db";
import { ProviderFailure } from "../ai/failure";
import { jsonDigest } from "../ai/json";
import { CapturedOutputPolicySchema, OUTPUT_POLICY_STEP_KEY, PROVIDER_MAX_OUTPUT_POLICY, type CapturedOutputPolicy } from "../ai/output-policy";
import { stableExecutionId } from "./identity";

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent_turn"), runId: z.uuid() }).strict(),
  z.object({ kind: z.literal("generation"), runId: z.uuid() }).strict(),
  z.object({ kind: z.literal("evaluation"), evaluationId: z.uuid(), targetEvaluationRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("activity_action"), activityActionId: z.uuid() }).strict(),
]);
export type OutputPolicyTarget = z.infer<typeof targetSchema>;
const receiptSchema = z.object({ kind: z.literal("execution.output-policy"), version: z.literal(PROVIDER_MAX_OUTPUT_POLICY),
  jobId: z.uuid(), target: targetSchema }).strict();
const protocolDigest = jsonDigest({ version: PROVIDER_MAX_OUTPUT_POLICY });
const unavailable = () => new ProviderFailure("unavailable");

interface PolicyRow {
  job_id: string; agent_turn_run_id: string | null; generation_run_id: string | null;
  evaluation_id: string | null; target_evaluation_revision: number | null; activity_action_id: string | null;
  policy_id: string | null; policy_status: string | null; input_digest: string | null; schema_digest: string | null;
  capability_digest: string | null; validation_policy_digest: string | null; policy_result: unknown;
}

function targetFromRow(row: PolicyRow): OutputPolicyTarget {
  if ([row.agent_turn_run_id, row.generation_run_id, row.evaluation_id, row.activity_action_id].filter(Boolean).length !== 1) throw unavailable();
  return targetSchema.parse(row.agent_turn_run_id ? { kind: "agent_turn", runId: row.agent_turn_run_id }
    : row.generation_run_id ? { kind: "generation", runId: row.generation_run_id }
    : row.evaluation_id ? { kind: "evaluation", evaluationId: row.evaluation_id, targetEvaluationRevision: row.target_evaluation_revision }
    : { kind: "activity_action", activityActionId: row.activity_action_id });
}

/** A policy receipt is configuration, never evidence that a paid or semantic effect ran. */
export function effectStepSql(alias = ""): string {
  if (alias && !/^[a-z_]+$/.test(alias)) throw unavailable();
  return `${alias ? `${alias}.` : ""}step_key <> '${OUTPUT_POLICY_STEP_KEY}'`;
}

const selectPolicy = `SELECT j.id AS job_id,j.agent_turn_run_id,j.generation_run_id,j.evaluation_id,j.target_evaluation_revision,j.activity_action_id,
  p.id AS policy_id,p.status AS policy_status,p.input_digest,p.schema_digest,p.capability_digest,p.validation_policy_digest,p.result_reference AS policy_result
  FROM unfurl.execution_jobs j LEFT JOIN unfurl.run_steps p ON p.job_id=j.id AND p.step_key=$2`;

function readRow(row: PolicyRow | undefined): CapturedOutputPolicy | undefined {
  if (!row?.policy_id) return undefined;
  const target = targetFromRow(row), parsed = receiptSchema.safeParse(row.policy_result);
  if (!parsed.success || row.policy_id !== stableExecutionId(row.job_id, OUTPUT_POLICY_STEP_KEY) || row.policy_status !== "succeeded" ||
      parsed.data.jobId !== row.job_id || jsonDigest(parsed.data.target) !== jsonDigest(target) ||
      row.input_digest !== jsonDigest({ jobId: row.job_id, target }) || row.schema_digest !== protocolDigest ||
      row.capability_digest !== protocolDigest || row.validation_policy_digest !== protocolDigest) throw unavailable();
  return CapturedOutputPolicySchema.parse({ version: PROVIDER_MAX_OUTPUT_POLICY, jobId: row.job_id,
    receiptId: row.policy_id, receiptDigest: jsonDigest(parsed.data) });
}

export async function readJobOutputPolicy(tx: DbTransaction, jobId: string): Promise<CapturedOutputPolicy | undefined> {
  z.uuid().parse(jobId);
  return readRow((await tx.query<PolicyRow>(`${selectPolicy} WHERE j.id=$1`, [jobId, OUTPUT_POLICY_STEP_KEY])).rows[0]);
}

export async function readStepOutputPolicy(tx: DbTransaction, stepId: string): Promise<CapturedOutputPolicy | undefined> {
  z.uuid().parse(stepId);
  return readRow((await tx.query<PolicyRow>(`${selectPolicy} JOIN unfurl.run_steps effect ON effect.job_id=j.id WHERE effect.id=$1`,
    [stepId, OUTPUT_POLICY_STEP_KEY])).rows[0]);
}

/** Called only in the transaction creating a new job. Historical jobs and retries are not adopted. */
export async function captureNewJobOutputPolicy(tx: DbTransaction, jobId: string, target: OutputPolicyTarget): Promise<void> {
  z.uuid().parse(jobId); targetSchema.parse(target);
  const result = receiptSchema.parse({ kind: "execution.output-policy", version: PROVIDER_MAX_OUTPUT_POLICY, jobId, target });
  await tx.query(`INSERT INTO unfurl.run_steps
    (id,job_id,step_key,input_digest,schema_digest,capability_digest,validation_policy_digest,status,result_reference)
    VALUES($1,$2,$3,$4,$5,$5,$5,'succeeded',$6::jsonb)`,
  [stableExecutionId(jobId, OUTPUT_POLICY_STEP_KEY), jobId, OUTPUT_POLICY_STEP_KEY, jsonDigest({ jobId, target }), protocolDigest, JSON.stringify(result)]);
  if (!await readJobOutputPolicy(tx, jobId)) throw unavailable();
}

export async function assertStepOutputPolicy(tx: DbTransaction, stepId: string | null, capture: CapturedOutputPolicy): Promise<void> {
  if (!stepId) throw unavailable();
  const actual = await readStepOutputPolicy(tx, stepId);
  if (!actual || jsonDigest(actual) !== jsonDigest(CapturedOutputPolicySchema.parse(capture))) throw unavailable();
}
