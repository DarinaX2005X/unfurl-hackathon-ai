import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { GenerationEvidenceRepository, loadGenerationStep, verifyStoredModelData, verifyStoredModelDataAndIdentity, verifyStoredModelItem } from "@/server/course-generation/repository";
import { ContentReviewCheckpointSchema, ProposedTaskCasesSchema, TaskCasesCheckpointSchema, prepareTaskCasesCheckpoint } from "@/server/course-generation/checkpoints";
import {
  StoredTaskValidationReceiptSchema, authoritativeStoredTaskValidationReceipt,
  type PreparedTaskCandidate, type StoredTaskValidationReceipt, type TaskValidationEvidence,
} from "@/server/mechanics/contracts";
import { taskDigest } from "@/server/mechanics/digest";
import { getServerMechanic } from "@/server/mechanics/registry";
import { getAssessmentDimensionIds } from "@/server/mechanics/catalog";
import { verifyAlternativeSpaceEvidence } from "@/server/mechanics/alternative-space";
import { RubricJudgementSchema, validateRubricJudgement, type RubricJudge, type GradeDecision } from "@/server/evaluation/contracts";
import { ProviderFailure } from "@/server/ai/failure";
import { stableExecutionId } from "@/server/runs/identity";
import { CaseEvaluationResultSchema } from "./case-evaluation";
import { ContentReviewSchema, assessContentReview, createContentReviewInput } from "./content-review";
import { SpecializedReviewSchema, SpecializedReviewCheckpointSchema, assessSpecializedReview } from "./specialized-review";
import { replayStoredPythonCase } from "./python-cases";
import { replayStoredActivityCase } from "./activity-cases";
import { inspectCandidateSourceGrounding } from "./source-grounding";

export const TaskValidationReferencesSchema = z.object({
  candidateStepId: IdSchema, casePlanStepId: IdSchema, caseStepIds: z.array(IdSchema).min(2), reviewStepId: IdSchema,
  specializedReviewStepIds: z.array(IdSchema).default([]),
}).strict();
export type TaskValidationReferences = z.infer<typeof TaskValidationReferencesSchema>;
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };
const trustedProofs = new WeakSet<object>();
declare const proofBrand: unique symbol;
export type StoredTaskValidationProof = Readonly<{ candidate: PreparedTaskCandidate; receipt: StoredTaskValidationReceipt }> & { readonly [proofBrand]: true };
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function success(decision: GradeDecision | null, expected: readonly string[]): boolean {
  return decision?.status === "evaluated" && decision.outcome === "correct" && decision.dimensions.length === expected.length &&
    decision.dimensions.every((dimension) => dimension.status === "met" && expected.includes(dimension.id));
}

/** This service assembles evidence only from stored generation/provider records. It has no author-JSON receipt endpoint. */
export class TaskValidationRepository {
  constructor(private readonly evidence = new GenerationEvidenceRepository()) {}

  async validateStoredTask(tx: DbTransaction, binding: ApprovedBuildBinding, value: TaskValidationReferences): Promise<StoredTaskValidationProof> {
    const refs = TaskValidationReferencesSchema.parse(value);
    if (new Set([refs.candidateStepId, refs.casePlanStepId, refs.reviewStepId, ...refs.caseStepIds, ...refs.specializedReviewStepIds]).size !== refs.caseStepIds.length + refs.specializedReviewStepIds.length + 3) return invalid();
    const loaded = await this.evidence.loadTaskCandidate(tx, binding, refs.candidateStepId), candidate = loaded.candidate;
    const planned = await loadGenerationStep(tx, binding, refs.casePlanStepId, TaskCasesCheckpointSchema);
    if (planned.result.candidateStepId !== refs.candidateStepId || planned.result.candidateDigest !== candidate.candidateDigest) return invalid();
    const proposal = ProposedTaskCasesSchema.parse({ cases: planned.result.cases.map(({ caseId: _caseId, ...entry }) => { void _caseId; return entry; }), alternativeSpaceProof: planned.result.alternativeSpaceProof });
    await verifyStoredModelItem(tx, binding, planned, planned.result.operationId, ProposedTaskCasesSchema, proposal, planned.result.modelProof, "cases");
    if (planned.result.operationId === loaded.step.result.authoringOperationId) return invalid();
    const { modelProof: _caseProof, ...caseBody } = planned.result; void _caseProof;
    if (taskDigest(prepareTaskCasesCheckpoint({ candidateStepId: refs.candidateStepId, candidateDigest: candidate.candidateDigest, operationId: planned.result.operationId, proposal })) !== taskDigest(caseBody)) return invalid();

    const review = await loadGenerationStep(tx, binding, refs.reviewStepId, ContentReviewCheckpointSchema);
    if (review.result.candidateStepId !== refs.candidateStepId) return invalid();
    const relevant = loaded.knowledge.outcomes.filter((outcome) => candidate.task.outcomeIds.includes(outcome.outcomeId));
    const material = createContentReviewInput({ candidate, criteria: relevant.flatMap((outcome) => outcome.criteria),
      learnerAction: relevant.map((outcome) => outcome.learnerAction).join("\n"), claims: loaded.facts.claims, passages: loaded.facts.passages });
    if (taskDigest(material) !== taskDigest(review.result.material)) return invalid();
    const reviewModelId = await verifyStoredModelItem(tx, binding, review, review.result.operationId, ContentReviewSchema, review.result.review, review.result.modelProof, "review");
    if (review.result.operationId === loaded.step.result.authoringOperationId || review.result.operationId === planned.result.operationId) return invalid();
    const reviewed = assessContentReview(review.result.review, material);
    const specialized = new Map<string, { operationId: string; modelId: typeof reviewModelId; validator: "validateCounterexampleClaim" | "dialogue_compatibility"; decision: GradeDecision }>();
    for (const stepId of refs.specializedReviewStepIds) {
      const step = await loadGenerationStep(tx, binding, stepId, SpecializedReviewCheckpointSchema);
      if (step.result.candidateStepId !== refs.candidateStepId || taskDigest(step.result.material) !== taskDigest(material) || specialized.has(step.result.review.validator)) return invalid();
      const modelId = await verifyStoredModelDataAndIdentity(tx, step, step.result.operationId, SpecializedReviewSchema, step.result.review);
      if (step.result.operationId === loaded.step.result.authoringOperationId) return invalid();
      specialized.set(step.result.review.validator, { operationId: step.result.operationId, modelId, validator: step.result.review.validator, decision: assessSpecializedReview(step.result.review, material) });
    }

    const caseEvidence: Extract<TaskValidationEvidence, { kind: "response_case" }>[] = [];
    const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion)!;
    for (const stepId of refs.caseStepIds) {
      const step = await loadGenerationStep(tx, binding, stepId, CaseEvaluationResultSchema), result = step.result;
      const test = planned.result.cases.find((entry) => entry.caseId === result.caseId);
      if (!test || result.candidateDigest !== candidate.candidateDigest || result.category !== test.category) return invalid();
      const activityCase = candidate.task.mechanicVersion !== 3 && handle.descriptor.requirements.includes("activity");
      if (activityCase) await replayStoredActivityCase(tx, binding, candidate, result, step);
      else if (taskDigest(result.response) !== taskDigest(test.response)) return invalid();
      let formValid = false;
      try { formValid = handle.descriptor.validateSubmission(candidate.task.config, handle.parseResponse(result.response)).length === 0; } catch { /* Invalid forms must be recorded distinctly. */ }
      if (result.rejectedAsInvalid) {
        if (formValid || result.decision !== null || result.modelCallId !== null || result.rubricJudgement !== null || result.rubricRequest !== null) return invalid();
      } else {
        if (!formValid || result.decision === null) return invalid();
        if (candidate.task.mechanicVersion === 3) {
          const actual = await replayStoredPythonCase(tx, binding, candidate, result, step);
          if (taskDigest(actual) !== taskDigest(result.decision)) return invalid();
        } else if (!activityCase) {
        // Real execution/activity evidence requires its storage-bound replay producer. Never accept an authored observation.
        if (handle.descriptor.requirements.includes("activity") || handle.descriptor.requirements.includes("sandbox") || result.activityEvidenceRef !== null) throw new ProviderFailure("unavailable");
        let judge: RubricJudge | null = null;
        if (result.modelCallId !== null) {
          if (result.rubricRequest === null || result.rubricJudgement === null) return invalid();
          await verifyStoredModelData(tx, step, result.modelCallId, RubricJudgementSchema, result.rubricJudgement);
          const request = result.rubricRequest, judgement = validateRubricJudgement(result.rubricJudgement, request);
          // This is a replay of a verified paid response, not a synthetic grader or another provider call.
          judge = { async judge(actual) { if (taskDigest(actual) !== taskDigest(request)) return invalid(); return judgement; } };
        } else if (result.rubricRequest !== null || result.rubricJudgement !== null) return invalid();
        const actual = await handle.evaluate({ task: candidate.task, privateData: candidate.privateTask.evaluatorData, response: result.response, activity: null },
          { model: judge, signal: new AbortController().signal });
        if (taskDigest(actual) !== taskDigest(result.decision)) return invalid();
        }
      }
      caseEvidence.push({ kind: "response_case", caseId: result.caseId, category: result.category, response: result.response,
        decision: result.decision, rejectedAsInvalid: result.rejectedAsInvalid, modelCallId: result.modelCallId, activityEvidenceRef: result.activityEvidenceRef });
    }
    if (new Set(caseEvidence.map((entry) => entry.caseId)).size !== planned.result.cases.length || caseEvidence.length !== planned.result.cases.length) return invalid();
    const dimensions = getAssessmentDimensionIds(candidate.task, candidate.privateTask.evaluatorData);
    const validCases = caseEvidence.filter((entry) => entry.category !== "invalid");
    const authoredValid = planned.result.cases.filter((entry) => entry.category !== "invalid");
    const uniqueResponses = new Set(validCases.map((entry) => taskDigest(entry.response))).size === validCases.length &&
      new Set(authoredValid.map((entry) => taskDigest({ response: entry.response, activityPlan: entry.activityPlan ?? null }))).size === authoredValid.length;
    const valid = validCases.length > 0 && validCases.every((entry) => !entry.rejectedAsInvalid && success(entry.decision, dimensions));
    const invalidCases = caseEvidence.filter((entry) => entry.category === "invalid");
    // A missing field alone is not a meaningful test of the grader's ability to reject wrong knowledge.
    const negative = invalidCases.some((entry) => !entry.rejectedAsInvalid && entry.decision?.status === "evaluated" && entry.decision.outcome !== "correct" && entry.decision.dimensions.some((dimension) => dimension.status !== "met"));
    const allNegatives = invalidCases.every((entry) => entry.rejectedAsInvalid || (entry.decision?.status === "evaluated" && entry.decision.outcome !== "correct"));
    const answerEvidence: TaskValidationEvidence[] = [...caseEvidence];
    let alternative = caseEvidence.some((entry) => entry.category === "alternative");
    if (!alternative && planned.result.alternativeSpaceProof !== null) {
      const proof: Extract<TaskValidationEvidence, { kind: "alternative_space" }> = { kind: "alternative_space", candidateDigest: candidate.candidateDigest,
        approvalDigest: candidate.approvalDigest, capabilityCatalogDigest: candidate.capabilityCatalogDigest,
        analysis: { method: "deterministic", proof: planned.result.alternativeSpaceProof } };
      alternative = verifyAlternativeSpaceEvidence(candidate, proof, validCases.map((entry) => entry.response), caseEvidence);
      if (alternative) answerEvidence.push(proof);
    }
    const casesUncertain = caseEvidence.some((entry) => entry.decision?.status === "unavailable" || entry.decision?.status === "uncertain");
    const casesPassed = valid && negative && allNegatives && uniqueResponses && alternative;
    const supportingClaims = loaded.facts.claims.filter((claim) => candidate.privateTask.sourceClaimIds.includes(claim.id));
    const grounding = inspectCandidateSourceGrounding(candidate, loaded.facts), sources = grounding.sources;
    const research: Extract<TaskValidationEvidence, { kind: "research" }> = { kind: "research", researchSnapshotId: loaded.knowledgeStep.id,
      approvalDigest: binding.approval.contentDigest, sources,
      claims: supportingClaims.map((claim) => ({ claimId: claim.id,
        sourceIds: [...new Set(claim.passageIds.map((id) => loaded.facts.passages.find((passage) => passage.id === id)?.sourceId ?? invalid()))] })) };
    const checks: StoredTaskValidationReceipt["checks"] = candidate.requiredChecks.map((check) => {
      if (check.id === "structure") return { id: check.id, status: "passed", reason: "The actual family parser and joins passed again against the stored candidate.", evidence: [{ kind: "pure", validatorVersion: "mechanic-readiness-v1" }] };
      if (check.id === "content_review") return { id: check.id, status: reviewed.decision.status === "uncertain" ? "uncertain" : reviewed.decision.outcome === "correct" ? "passed" : "failed",
        reason: reviewed.decision.feedback.explanation, evidence: [{ kind: "model_review", callId: review.result.operationId, modelId: reviewModelId, validator: "content_review", candidateDigest: candidate.candidateDigest, decision: reviewed.decision }] };
      if (check.id === "answer_cases") return { id: check.id, status: casesPassed ? "passed" : casesUncertain ? "uncertain" : "failed", reason: casesPassed ? "Recorded cases demonstrate valid, alternative and meaningful invalid responses." : "Recorded answer cases do not establish all required behavior.", evidence: answerEvidence };
      if (check.id === "source_grounding") return { id: check.id, status: grounding.issues.length ? "failed" : "passed",
        reason: grounding.issues.length ? grounding.issues.join(" ").slice(0, 4000) : "Claims and source snapshots match the canonical stored evidence.", evidence: grounding.issues.length ? [] : [research] };
      if (check.id === "reachability") {
        const witness = validCases.find((entry) => success(entry.decision, dimensions));
        return { id: check.id, status: witness ? "passed" : casesUncertain ? "uncertain" : "failed", reason: witness ? "An actually evaluated valid case is a reachable witness." : "No verified successful witness exists.",
          evidence: witness && witness.decision ? [{ kind: "witness", response: witness.response, decision: witness.decision, executionEvidenceRef: witness.activityEvidenceRef }] : [] };
      }
      if (check.id === "counterexample_claim" || check.id === "dialogue_compatibility") {
        const result = specialized.get(check.id === "counterexample_claim" ? "validateCounterexampleClaim" : "dialogue_compatibility");
        return { id: check.id, status: !result || result.decision.status === "uncertain" ? "uncertain" : result.decision.outcome === "correct" ? "passed" : "failed",
          reason: result?.decision.feedback.explanation ?? "The specialized invariant has no verified review.",
          evidence: result ? [{ kind: "model_review", callId: result.operationId, modelId: result.modelId, validator: result.validator, candidateDigest: candidate.candidateDigest, decision: result.decision }] : [] };
      }
      return { id: check.id, status: "uncertain", reason: "This specialized external validation has no verified stored result yet.", evidence: [] };
    });
    const verdict = checks.some((check) => check.status === "failed") ? "failed" : checks.some((check) => check.status === "uncertain") ? "uncertain" : "passed";
    const receipt = StoredTaskValidationReceiptSchema.parse({ id: stableExecutionId(refs.candidateStepId, `receipt:${taskDigest(refs)}`),
      taskId: candidate.task.id, taskVersion: candidate.task.taskVersion, approvalDigest: candidate.approvalDigest, candidateDigest: candidate.candidateDigest,
      capabilityCatalogDigest: candidate.capabilityCatalogDigest, validatorVersion: "mechanic-readiness-v1", checks,
      testEvidenceRefs: caseEvidence.map((entry) => entry.caseId), reviewCallRef: review.result.operationId, verdict, createdAt: new Date().toISOString() });
    const proof = { candidate, receipt }; freeze(proof); trustedProofs.add(proof);
    return proof as StoredTaskValidationProof;
  }

  /** Called after the matching public task row is staged, inside the same guarded materialization transaction. */
  async persistReceipt(tx: DbTransaction, proof: StoredTaskValidationProof) {
    if (!trustedProofs.has(proof)) return invalid();
    const receipt = proof.receipt;
    await tx.query(`INSERT INTO unfurl.task_validation_receipts(id,task_id,task_version,verdict,document,created_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, [receipt.id, receipt.taskId, receipt.taskVersion, receipt.verdict, JSON.stringify(receipt), receipt.createdAt]);
    const row = (await tx.query<{ document: unknown; verdict: string; task_id: string; task_version: number }>(
      "SELECT document,verdict,task_id,task_version FROM unfurl.task_validation_receipts WHERE id=$1", [receipt.id])).rows[0];
    if (!row || row.verdict !== receipt.verdict || row.task_id !== receipt.taskId || row.task_version !== receipt.taskVersion) return invalid();
    const stored = StoredTaskValidationReceiptSchema.parse(row.document);
    const { createdAt: _a, ...storedBody } = stored, { createdAt: _b, ...expectedBody } = receipt; void _a; void _b;
    if (taskDigest(storedBody) !== taskDigest(expectedBody)) return invalid();
    // Origin, actual external results and immutable row have all been checked above. Authoring cannot call this with JSON.
    return authoritativeStoredTaskValidationReceipt(stored);
  }
}
