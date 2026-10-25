import "server-only";
import { z } from "zod";
import { DigestSchema, type JsonObject } from "@/domain/common";
import {
  TaskPublicSchema, TaskPrivateSchema, TaskPrivateCandidateSchema,
  type TaskPublic, type TaskPrivate, type TaskPrivateCandidate,
} from "@/domain/mechanics";
import { getMechanicManifest } from "@/domain/mechanic-manifest";
import { RubricRequestSchema, type GradeDecision } from "@/server/evaluation/contracts";
import { SourceInvestigationConfigSchema } from "@/domain/mechanic-families/v2/investigation";
import { SourceInvestigationPrivateSchema } from "@/server/evaluation/investigation";
import {
  MechanicRuntimeCapabilitiesSchema, PreparedTaskCandidateSchema, isAuthoritativeTaskValidationReceipt,
  type PreparedTaskCandidate, type RequiredTaskCheck, type MechanicRuntimeCapabilities,
  type TaskReadiness, type StoredTaskValidationReceipt, type TaskValidationEvidence,
} from "./contracts";
import { getAssessmentDimensionIds, getCapabilityCatalogDigest, mechanicRuntimeBlockers } from "./catalog";
import { getServerMechanic, type ServerMechanicHandle } from "./registry";
import { inspectFamilyCandidate } from "./family-checks";
import { canonicalTaskJson, taskDigest } from "./digest";
import { verifyAlternativeSpaceEvidence } from "./alternative-space";

export class TaskCandidateError extends Error {
  constructor(readonly status: "invalid" | "unsupported", message: string) { super(message); this.name = "TaskCandidateError"; }
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every((id) => right.includes(id));
}
function requireValid(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new TaskCandidateError("invalid", reason);
}

function validatePrivateJoin(task: TaskPublic, privateTask: TaskPrivateCandidate, handle: ServerMechanicHandle): void {
  requireValid(privateTask.taskId === task.id && privateTask.taskVersion === task.taskVersion, "Private task identity/version does not match the public task");
  requireValid(privateTask.hints.length === task.availableHints, "Available hints must equal the authored private hints");
  const spec = privateTask.evaluationSpec;
  if (spec.kind === "execution") throw new TaskCandidateError("unsupported", "No execution adapter is registered for this mechanic version");
  requireValid(handle.descriptor.supportedEvaluators.includes(spec.kind), "This evaluation kind is not supported by the mechanic");
  if (spec.kind === "deterministic") {
    requireValid(spec.evaluatorId === task.mechanicId && spec.evaluatorVersion === 2 && spec.secretConfig === null,
      "Production deterministic data belongs only in evaluatorData, with the matching mechanic ID/version and null secretConfig");
  } else {
    const rubrics = ["rubric", "basisRubric", "explanationRubric"].flatMap((key) => {
      const value = privateTask.evaluatorData[key];
      return value === undefined || value === null ? [] : [RubricRequestSchema.shape.rubric.parse(value)];
    });
    requireValid(rubrics.length === 1 && rubrics[0]!.id === spec.rubricId &&
      sameSet(spec.requiredDimensions, rubrics[0]!.dimensions.map(({ id }) => id)), "Evaluation spec must identify the actual private rubric and all its raw dimensions");
  }
  requireValid(sameSet(task.outcomeIds, privateTask.assessment.outcomes.map((outcome) => outcome.outcomeId)), "Assessment must cover exactly the task's outcomes");
  const available = getAssessmentDimensionIds(task, privateTask.evaluatorData);
  const mapped = privateTask.assessment.outcomes.flatMap((outcome) => outcome.dimensions.flatMap((dimension) => dimension.evaluationDimensionIds));
  requireValid(mapped.every((id) => available.includes(id)) && available.every((id) => mapped.includes(id)),
    "Assessment mappings must use and cover the actual successful evaluator dimensions");
}

/** Phase one: shape/reference/feasibility validation only. It never confers readiness. */
export function prepareTaskCandidate(input: { task: unknown; privateTask: unknown }, context: { approvalDigest: string }): PreparedTaskCandidate {
  try {
    const identity = z.object({ mechanicId: z.string(), mechanicVersion: z.number() }).passthrough().parse(input.task);
    const handle = getServerMechanic(identity.mechanicId, identity.mechanicVersion);
    if (!handle) throw new TaskCandidateError("unsupported", "Unknown production mechanic/version");
    // Authoring is strict; projecting a public DTO later is a different boundary.
    const task = handle.parseTask(TaskPublicSchema.parse(input.task));
    const privateTask = TaskPrivateCandidateSchema.parse(input.privateTask);
    privateTask.evaluatorData = handle.parsePrivate(privateTask.evaluatorData);
    validatePrivateJoin(task, privateTask, handle);
    handle.parseResponse(handle.descriptor.createInitialResponse(task.config));
    const additional = inspectFamilyCandidate(task, privateTask.evaluatorData);
    const checks: RequiredTaskCheck[] = [
      { id: "structure", method: "pure" }, { id: "content_review", method: "external" }, { id: "answer_cases", method: "external" },
    ];
    if (privateTask.sourceClaimIds.length) additional.push("source_grounding");
    for (const id of new Set(additional)) checks.push({ id, method: "external" });
    const approvalDigest = DigestSchema.parse(context.approvalDigest), capabilityCatalogDigest = getCapabilityCatalogDigest();
    const candidateDigest = taskDigest({ task, privateTask, approvalDigest, capabilityCatalogDigest });
    return { task, privateTask, approvalDigest, capabilityCatalogDigest, candidateDigest, requiredChecks: checks };
  } catch (error) {
    if (error instanceof TaskCandidateError) throw error;
    throw new TaskCandidateError("invalid", error instanceof Error ? error.message : "Invalid authored task");
  }
}

function definiteSuccess(decision: GradeDecision): boolean {
  return decision.status === "evaluated" && decision.outcome === "correct" && decision.dimensions.length > 0 && decision.dimensions.every((dimension) => dimension.status === "met");
}
function hasActualSuccessDimensions(decision: GradeDecision, dimensions: string[]): boolean {
  return definiteSuccess(decision) && sameSet(decision.dimensions.map((dimension) => dimension.id), dimensions);
}

function verifyCases(candidate: PreparedTaskCandidate, evidence: TaskValidationEvidence[], receipt: StoredTaskValidationReceipt): boolean {
  const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion)!;
  const dimensions = getAssessmentDimensionIds(candidate.task, candidate.privateTask.evaluatorData);
  const cases = evidence.filter((item) => item.kind === "response_case");
  if (!(["valid", "invalid"] as const).every((category) => cases.some((item) => item.category === category))) return false;
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length || cases.some((item) => !receipt.testEvidenceRefs.includes(item.caseId))) return false;
  const valid = cases.filter((item) => item.category !== "invalid");
  if (new Set(valid.map((item) => canonicalTaskJson(item.response))).size !== valid.length) return false;
  for (const item of cases) {
    let validForm = false;
    try { validForm = handle.descriptor.validateSubmission(candidate.task.config, handle.parseResponse(item.response)).length === 0; } catch { /* malformed case is allowed only as an explicitly invalid test */ }
    if (item.category === "invalid") {
      if (item.rejectedAsInvalid) { if (validForm || item.decision !== null) return false; }
      else if (!validForm || item.decision?.status !== "evaluated" || item.decision.outcome === "correct" ||
        item.decision.dimensions.length === 0 || item.decision.dimensions.every((dimension) => dimension.status === "met")) return false;
    } else if (!validForm || item.rejectedAsInvalid || !item.decision || !hasActualSuccessDimensions(item.decision, dimensions)) return false;
    if (!item.rejectedAsInvalid && handle.descriptor.requirements.includes("model") && item.modelCallId === null) return false;
    if (!item.rejectedAsInvalid && handle.descriptor.requirements.includes("activity") && item.activityEvidenceRef === null) return false;
  }
  if (!cases.some((item) => item.category === "alternative") && !evidence.some((item) => item.kind === "alternative_space" &&
    verifyAlternativeSpaceEvidence(candidate, item, valid.map((test) => test.response), cases))) return false;
  return true;
}

function verifyResearch(candidate: PreparedTaskCandidate, evidence: TaskValidationEvidence[]): boolean {
  const research = evidence.filter((item): item is Extract<TaskValidationEvidence, { kind: "research" }> =>
    item.kind === "research" && item.approvalDigest === candidate.approvalDigest);
  if (!research.length) return false;
  const sources = research.flatMap((item) => item.sources), claims = research.flatMap((item) => item.claims);
  if (new Set(sources.map((source) => source.id)).size !== sources.length || new Set(claims.map((claim) => claim.claimId)).size !== claims.length) return false;
  if (claims.some((claim) => new Set(claim.sourceIds).size !== claim.sourceIds.length || claim.sourceIds.some((id) => !sources.some((source) => source.id === id)))) return false;
  if (candidate.privateTask.sourceClaimIds.some((id) => !claims.some((claim) => claim.claimId === id))) return false;
  if (candidate.task.mechanicId === "source_investigation") {
    const config = SourceInvestigationConfigSchema.parse(candidate.task.config);
    const privateSources = SourceInvestigationPrivateSchema.parse(candidate.privateTask.evaluatorData).sources;
    return [...config.sources, ...privateSources].every((source) => sources.some((stored) => canonicalTaskJson(stored) === canonicalTaskJson(source)));
  }
  return true;
}

function verifyCheckEvidence(candidate: PreparedTaskCandidate, check: StoredTaskValidationReceipt["checks"][number], receipt: StoredTaskValidationReceipt): boolean {
  if (check.id === "structure") return check.evidence.some((item) => item.kind === "pure" && item.validatorVersion === "mechanic-readiness-v1");
  if (check.id === "answer_cases") return verifyCases(candidate, check.evidence, receipt);
  if (check.id === "source_grounding") return verifyResearch(candidate, check.evidence);
  if (check.id === "reachability") {
    const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion)!;
    const dimensions = getAssessmentDimensionIds(candidate.task, candidate.privateTask.evaluatorData);
    return check.evidence.some((item) => {
      if (item.kind !== "witness" || !hasActualSuccessDimensions(item.decision, dimensions)) return false;
      try {
        if (handle.descriptor.validateSubmission(candidate.task.config, handle.parseResponse(item.response)).length) return false;
        return !handle.descriptor.requirements.includes("activity") || item.executionEvidenceRef !== null;
      } catch { return false; }
    });
  }
  const validator = check.id === "counterexample_claim" ? "validateCounterexampleClaim" : check.id;
  return check.evidence.some((item) => item.kind === "model_review" && item.validator === validator &&
    item.candidateDigest === candidate.candidateDigest && definiteSuccess(item.decision) &&
    (check.id !== "content_review" || receipt.reviewCallRef === item.callId) &&
    (check.id !== "counterexample_claim" || sameSet(item.decision.dimensions.map((dimension) => dimension.id), ["coded_implication"])));
}

export interface TaskReadinessContext { runtime: MechanicRuntimeCapabilities; receipt: unknown }
/** Phase two consumes authoritative stored evidence; no DB writes, provider calls or receipt issuance. */
export function validateTaskReadiness(value: unknown, context: TaskReadinessContext): TaskReadiness {
  let candidate: PreparedTaskCandidate;
  try {
    const submitted = PreparedTaskCandidateSchema.parse(value);
    const raw = value as PreparedTaskCandidate;
    // Normalization belongs to preparation. Even a later whitespace-only edit invalidates its receipt.
    const rawDigest = taskDigest({ task: raw.task, privateTask: raw.privateTask,
      approvalDigest: raw.approvalDigest, capabilityCatalogDigest: raw.capabilityCatalogDigest });
    if (rawDigest !== submitted.candidateDigest) return { status: "unreviewed", reasons: ["Authored fields changed after candidate preparation"] };
    candidate = prepareTaskCandidate({ task: submitted.task, privateTask: submitted.privateTask }, { approvalDigest: submitted.approvalDigest });
    if (submitted.candidateDigest !== candidate.candidateDigest || submitted.capabilityCatalogDigest !== candidate.capabilityCatalogDigest ||
      canonicalTaskJson(submitted.requiredChecks) !== canonicalTaskJson(candidate.requiredChecks)) {
      return { status: "unreviewed", reasons: ["Authored task or capability catalog changed after candidate preparation"] };
    }
  } catch (error) {
    return { status: error instanceof TaskCandidateError ? error.status : "invalid", reasons: [error instanceof Error ? error.message : "Invalid candidate"] };
  }
  const parsedRuntime = MechanicRuntimeCapabilitiesSchema.safeParse(context.runtime);
  if (!parsedRuntime.success) return { status: "blocked", reasons: ["Runtime capabilities are invalid or use an unapproved model"] };
  const runtimeReasons = mechanicRuntimeBlockers(getMechanicManifest(candidate.task.mechanicId, candidate.task.mechanicVersion)!, parsedRuntime.data);
  if (runtimeReasons.length) return { status: "blocked", reasons: runtimeReasons };
  if (!isAuthoritativeTaskValidationReceipt(context.receipt)) return { status: "unreviewed", reasons: ["An authoritative stored validation receipt is required"] };
  const receipt = context.receipt;
  if (receipt.taskId !== candidate.task.id || receipt.taskVersion !== candidate.task.taskVersion || receipt.approvalDigest !== candidate.approvalDigest ||
    receipt.candidateDigest !== candidate.candidateDigest || receipt.capabilityCatalogDigest !== candidate.capabilityCatalogDigest) {
    return { status: "unreviewed", reasons: ["The stored receipt belongs to a different candidate, approval, catalog or task version"] };
  }
  if (receipt.verdict === "failed" || receipt.checks.some((check) => check.status === "failed")) return { status: "invalid", reasons: ["Stored validation found a failed check"] };
  if (receipt.verdict !== "passed" || receipt.checks.some((check) => check.status !== "passed")) return { status: "unreviewed", reasons: ["Stored validation remains uncertain"] };
  const reasons: string[] = [];
  for (const required of candidate.requiredChecks) {
    const check = receipt.checks.find((item) => item.id === required.id);
    if (!check || !verifyCheckEvidence(candidate, check, receipt)) reasons.push(`Missing or unverifiable external evidence: ${required.id}`);
  }
  return reasons.length ? { status: "unreviewed", reasons } : { status: "ready", reasons: [] };
}

export function materializeValidatedTask(candidate: PreparedTaskCandidate, context: TaskReadinessContext): { task: TaskPublic; privateTask: TaskPrivate } {
  const readiness = validateTaskReadiness(candidate, context);
  if (readiness.status !== "ready" || !isAuthoritativeTaskValidationReceipt(context.receipt)) {
    throw new Error(`Task is ${readiness.status}: ${readiness.reasons.join("; ")}`);
  }
  return { task: serializeProductionTask(candidate.task), privateTask: TaskPrivateSchema.parse({ ...candidate.privateTask, validationReceiptId: context.receipt.id }) };
}

/** Public projection is independent from private validation records and never includes those records. */
export function serializeProductionTask(value: unknown): TaskPublic<JsonObject> {
  const identity = z.object({ mechanicId: z.string(), mechanicVersion: z.number() }).passthrough().parse(value);
  const handle = getServerMechanic(identity.mechanicId, identity.mechanicVersion);
  if (!handle) throw new TaskCandidateError("unsupported", "Unknown production mechanic/version");
  return handle.parseTask(value);
}
