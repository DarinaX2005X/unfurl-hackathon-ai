import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, IsoDateTimeSchema, JsonValueSchema } from "@/domain/common";
import { TaskPrivateCandidateSchema, TaskPublicSchema } from "@/domain/mechanics";
import { GradeDecisionSchema } from "@/server/evaluation/contracts";
import { InvestigationSourceSchema } from "@/domain/mechanic-families/v2/investigation";

export const REQUIRED_MECHANIC_MODEL = "moonshotai/kimi-k2.6" as const;
const actionKind = z.enum(["run", "prediction.commit", "experiment.query", "intervention.apply", "dialogue.turn"]);
export const MechanicRuntimeCapabilitiesSchema = z.object({
  model: z.object({ modelId: z.literal(REQUIRED_MECHANIC_MODEL), available: z.boolean() }).strict().nullable(),
  activity: z.object({ durable: z.boolean(), supportedActions: z.array(actionKind), dialogue: z.boolean() }).strict(),
  sandbox: z.object({ available: z.boolean(), profiles: z.array(z.string().min(1).max(128)) }).strict(),
  budget: z.object({ available: z.boolean() }).strict(),
}).strict();
export type MechanicRuntimeCapabilities = z.infer<typeof MechanicRuntimeCapabilitiesSchema>;
export const ValidationCheckIdSchema = z.enum([
  "structure", "content_review", "answer_cases", "source_grounding", "counterexample_claim", "reachability", "dialogue_compatibility",
]);
export type ValidationCheckId = z.infer<typeof ValidationCheckIdSchema>;
export const RequiredTaskCheckSchema = z.object({
  id: ValidationCheckIdSchema, method: z.enum(["pure", "external"]),
}).strict();
export type RequiredTaskCheck = z.infer<typeof RequiredTaskCheckSchema>;
export const PreparedTaskCandidateSchema = z.object({
  task: TaskPublicSchema, privateTask: TaskPrivateCandidateSchema,
  approvalDigest: DigestSchema, candidateDigest: DigestSchema, capabilityCatalogDigest: DigestSchema,
  requiredChecks: z.array(RequiredTaskCheckSchema).min(1),
}).strict();
export type PreparedTaskCandidate = z.infer<typeof PreparedTaskCandidateSchema>;

/** Evidence is loaded with its receipt from the validation store, never from authored task JSON. */
export const TaskValidationEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pure"), validatorVersion: z.literal("mechanic-readiness-v1") }).strict(),
  z.object({
    kind: z.literal("model_review"), callId: IdSchema, modelId: z.literal(REQUIRED_MECHANIC_MODEL),
    validator: z.enum(["content_review", "validateCounterexampleClaim", "dialogue_compatibility"]),
    candidateDigest: DigestSchema, decision: GradeDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("response_case"), caseId: IdSchema, category: z.enum(["valid", "alternative", "invalid"]),
    response: JsonValueSchema, decision: GradeDecisionSchema.nullable(),
    rejectedAsInvalid: z.boolean(), modelCallId: IdSchema.nullable(), activityEvidenceRef: IdSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("research"), researchSnapshotId: IdSchema, approvalDigest: DigestSchema,
    claims: z.array(z.object({ claimId: IdSchema, sourceIds: z.array(z.string().min(1)).min(1) }).strict()).max(100),
    sources: z.array(InvestigationSourceSchema).min(1).max(100),
  }).strict(),
  z.object({ kind: z.literal("witness"), response: JsonValueSchema,
    decision: GradeDecisionSchema, executionEvidenceRef: IdSchema.nullable() }).strict(),
]);
export type TaskValidationEvidence = z.infer<typeof TaskValidationEvidenceSchema>;
export const StoredTaskValidationReceiptSchema = z.object({
  id: IdSchema, taskId: IdSchema, taskVersion: z.number().int().positive(),
  approvalDigest: DigestSchema, candidateDigest: DigestSchema, capabilityCatalogDigest: DigestSchema,
  validatorVersion: z.literal("mechanic-readiness-v1"),
  checks: z.array(z.object({
    id: ValidationCheckIdSchema, status: z.enum(["passed", "failed", "uncertain"]),
    evidence: z.array(TaskValidationEvidenceSchema).max(100), reason: z.string().min(1).max(4000),
  }).strict()).min(1).max(16),
  testEvidenceRefs: z.array(IdSchema).max(100), reviewCallRef: IdSchema.nullable(),
  verdict: z.enum(["passed", "failed", "uncertain"]), createdAt: IsoDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  if (new Set(receipt.checks.map((check) => check.id)).size !== receipt.checks.length) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Each validation check must occur once" });
  }
});
export type StoredTaskValidationReceipt = z.infer<typeof StoredTaskValidationReceiptSchema>;

const storedReceipts = new WeakSet<object>();
declare const storedReceiptBrand: unique symbol;
export type AuthoritativeTaskValidationReceipt = Readonly<StoredTaskValidationReceipt> & { readonly [storedReceiptBrand]: true };

/**
 * Repository boundary only: call after loading the validation service's immutable stored row and evidence.
 * This does not issue a receipt, validate a model claim, or make browser/author JSON authoritative.
 */
export function authoritativeStoredTaskValidationReceipt(stored: unknown): AuthoritativeTaskValidationReceipt {
  const receipt = StoredTaskValidationReceiptSchema.parse(stored);
  // Freeze recursively so evidence cannot change after the repository attests its origin.
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(receipt);
  storedReceipts.add(receipt);
  return receipt as AuthoritativeTaskValidationReceipt;
}
export function isAuthoritativeTaskValidationReceipt(value: unknown): value is AuthoritativeTaskValidationReceipt {
  return value !== null && typeof value === "object" && storedReceipts.has(value);
}
export type TaskReadiness = {
  status: "invalid" | "unsupported" | "unreviewed" | "blocked" | "ready";
  reasons: string[];
};
