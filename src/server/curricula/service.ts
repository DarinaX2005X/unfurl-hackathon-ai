import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../auth/actor";
import { ServiceFault, unavailable } from "../auth/errors";
import { withSystemTransaction, type DbTransaction } from "../db";
import { executeIdempotentInTransaction } from "../idempotency";
import { IdSchema } from "../../domain/common";
import { CourseArtifactRefSchema } from "../../domain/chat";
import { curriculumDigest, type CurriculumDraft } from "../../domain/course";
import {
  ApproveCurriculumInputSchema, CourseLanguageRequestResultSchema, CurriculumApprovalResultSchema,
  CurriculumAuthoringSnapshotSchema, CurriculumMutationResultSchema, EditCourseMetadataInputSchema,
  PatchCurriculumInputSchema, RequestCourseLanguageInputSchema, type PatchCurriculumInput,
} from "../../domain/curriculum-authoring";
import { PostgresCurriculumResearchRepository } from "../curriculum-research/repository";
import { CurriculumResearchEvidenceSchema, QuestionEvidenceSchema, type CurriculumResearchEvidence, type QuestionEvidence } from "../curriculum-research/contracts";
import { projectCurriculumEvidence, validateCurriculumEvidence, type CurriculumEvidenceFacts } from "../curriculum-research/validation";
import { enqueueAcceptedRun } from "../runs/enqueue";
import { answerDigest, applyCurriculumChanges, CurriculumChangeError, questionDigest, type QuestionAnswerVerification } from "./changes";
import * as repository from "./repository";

export interface AuthoringAdmission { assertAvailable(kind: "agent_turn" | "generation"): Promise<void> }
export type AuthoringTransaction = <T>(work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
export interface PreparedQuestionAnswers { verifications: QuestionAnswerVerification[]; answers: QuestionEvidence[] }
export interface QuestionVerificationPort {
  verify(input: { ownerId: string; draft: CurriculumDraft; changes: PatchCurriculumInput["changes"] }, signal: AbortSignal): Promise<PreparedQuestionAnswers>;
}
export interface CurriculumServiceOptions {
  transaction?: AuthoringTransaction;
  admission?: AuthoringAdmission;
  questions?: QuestionVerificationPort;
  now?: () => string;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceFault(400, "invalid_input", "curriculum.invalidInput");
  return result.data;
}
function mutationError(error: unknown): never {
  if (error instanceof CurriculumChangeError) {
    if (error.code === "revision_conflict") throw repository.curriculumConflict(error.currentRevision!);
    if (error.code === "question_unverified") throw new ServiceFault(409, "revision_conflict", "curriculum.questionNeedsReview");
    throw new ServiceFault(400, "invalid_input", "curriculum.invalid", false,
      error.issues.length ? { fieldErrors: Object.fromEntries(error.issues.slice(0, 12).map((issue) => [issue.path.join("."), "curriculum.invalidReference"])) } : {});
  }
  throw error;
}

export async function readAuthoringSnapshot(tx: DbTransaction, ownerId: string, draftId: string) {
  const { draft } = await repository.requireDraft(tx, ownerId, draftId);
  const result = await repository.mutationResult(tx, ownerId, draft.courseId);
  const research = await new PostgresCurriculumResearchRepository().loadEvidence(tx, { draft, ownerId, allowPrevious: true });
  const issues = await validateCurriculumEvidence(draft, research.evidence, research.facts);
  return CurriculumAuthoringSnapshotSchema.parse({ ...result, evidence: projectCurriculumEvidence(draft, research.evidence, research.facts, issues),
    ...await repository.readCurrentRuns(tx, ownerId, result.artifact) });
}

function verifyPreparedAnswers(draft: CurriculumDraft, input: PatchCurriculumInput, proof: PreparedQuestionAnswers): void {
  for (const change of input.changes) {
    if (change.op !== "answer_question") continue;
    const question = draft.unresolvedQuestions.find((item) => item.id === change.id);
    const answer = proof.answers.find((item) => item.questionId === change.id);
    const verification = proof.verifications.find((item) => item.questionId === change.id);
    if (!question || !answer || !verification || !QuestionEvidenceSchema.safeParse(answer).success
      || answer.answerDigest !== answerDigest(change.answer) || answer.questionDigest !== questionDigest(question)
      || answer.question !== question.text || answer.answer !== change.answer
      || verification.answerDigest !== answer.answerDigest || verification.questionDigest !== answer.questionDigest
      || verification.decision !== answer.decision) throw new ServiceFault(409, "revision_conflict", "curriculum.questionNeedsReview");
  }
}

/** The tool executor and HTTP PATCH share this mutation. Callers cannot approve through this function. */
export async function patchCurriculumInTransaction(tx: DbTransaction, input: {
  ownerId: string; draftId: string; request: PatchCurriculumInput; now: string;
  answers?: PreparedQuestionAnswers;
  researched?: { evidence: CurriculumResearchEvidence; facts: CurriculumEvidenceFacts };
}) {
  const { draft } = await repository.requireDraft(tx, input.ownerId, input.draftId, true);
  if (draft.revision !== input.request.expectedRevision) throw repository.curriculumConflict(draft.revision);
  const proof = input.answers ?? { verifications: [], answers: [] };
  verifyPreparedAnswers(draft, input.request, proof);
  let applied;
  try { applied = applyCurriculumChanges(draft, input.request, { now: input.now, verifiedAnswers: proof.verifications }); }
  catch (error) { mutationError(error); }
  if (!applied.changed) return repository.mutationResult(tx, input.ownerId, draft.courseId);
  const previous = await new PostgresCurriculumResearchRepository().loadEvidence(tx, { draft, ownerId: input.ownerId, allowPrevious: true });
  let evidence = input.researched?.evidence ?? structuredClone(previous.evidence);
  const facts = input.researched?.facts ?? previous.facts;
  if (facts.ownerId !== input.ownerId) throw repository.missingCurriculum();
  if (!input.researched) {
    evidence.contentDigest = await curriculumDigest(applied.draft);
    evidence.outcomeEvidence = evidence.outcomeEvidence.filter((entry) => applied.draft.outcomes.some((outcome) => outcome.id === entry.outcomeId));
    evidence.moduleEstimates = evidence.moduleEstimates.filter((estimate) => applied.draft.modules.some((outline) => outline.id === estimate.moduleId));
    evidence.questionAnswers = [...evidence.questionAnswers.filter((answer) => !proof.answers.some((entry) => entry.questionId === answer.questionId)), ...proof.answers];
  }
  evidence = CurriculumResearchEvidenceSchema.parse(evidence);
  const issues = await validateCurriculumEvidence(applied.draft, evidence, facts);
  const researched = !issues.some((issue) => !["blocking_question", "unresolved_conflict"].includes(issue.code));
  if (input.researched && !researched) throw repository.researchRequired(draft.revision);
  await repository.saveDraftRevision(tx, { ownerId: input.ownerId, previous: draft, next: applied.draft, evidence: researched ? evidence : null, approvalReady: issues.length === 0 });
  return repository.mutationResult(tx, input.ownerId, draft.courseId);
}

export async function editMetadataInTransaction(tx: DbTransaction, input: {
  ownerId: string; courseId: string; expectedRevision: number; title: string; summary: string; now: string;
}) {
  const { course, draft } = await repository.requireCourseDraft(tx, input.ownerId, input.courseId, true);
  if (course.revision !== input.expectedRevision) throw repository.curriculumConflict(course.revision);
  const titleChanged = course.title !== input.title || draft.title !== input.title;
  if (titleChanged) await patchCurriculumInTransaction(tx, { ownerId: input.ownerId, draftId: draft.id, now: input.now,
    request: { expectedRevision: draft.revision, changes: [{ op: "set_details", title: input.title }] } });
  if (course.summary !== input.summary) await tx.query(`UPDATE unfurl.courses SET summary=$3,revision=revision+$4,updated_at=$5
    WHERE id=$1 AND owner_id=$2`, [course.id, input.ownerId, input.summary, titleChanged ? 0 : 1, input.now]);
  return repository.readArtifact(tx, input.ownerId, course.id);
}

export function createCurriculumService(options: CurriculumServiceOptions = {}) {
  const transaction = options.transaction ?? ((work) => withSystemTransaction("run_execution", work));
  const now = options.now ?? (() => new Date().toISOString());
  const admission = options.admission ?? { assertAvailable: async () => { throw unavailable("generation.unavailable"); } };
  async function command<T>(actor: Actor, operation: string, key: string, body: unknown, schema: z.ZodType<T>, work: (tx: DbTransaction) => Promise<{ status: 200 | 202; data: T }>) {
    parse(IdSchema, key);
    return transaction((tx) => executeIdempotentInTransaction(tx, actor, { operation, key, body, parseResult: schema }, work));
  }
  return {
    get(actor: Actor, draftId: string) {
      parse(IdSchema, draftId);
      return transaction((tx) => readAuthoringSnapshot(tx, actor.id, draftId));
    },
    async patch(actor: Actor, draftId: string, value: unknown, key: string, signal = new AbortController().signal) {
      parse(IdSchema, draftId);
      const input = parse(PatchCurriculumInputSchema, value);
      let answers: PreparedQuestionAnswers | undefined;
      if (input.changes.some((change) => change.op === "answer_question")) {
        if (!options.questions) throw unavailable("curriculum.questionReviewUnavailable");
        const context = await transaction((tx) => repository.requireDraft(tx, actor.id, draftId));
        if (context.draft.revision !== input.expectedRevision) throw repository.curriculumConflict(context.draft.revision);
        answers = await options.questions.verify({ ownerId: actor.id, draft: context.draft, changes: input.changes }, signal);
      }
      return command(actor, "curriculum.patch", key, { draftId, ...input }, CurriculumMutationResultSchema, async (tx) => ({ status: 200,
        data: await patchCurriculumInTransaction(tx, { ownerId: actor.id, draftId, request: input, now: now(), ...(answers ? { answers } : {}) }) }));
    },
    async approve(actor: Actor, draftId: string, value: unknown, key: string) {
      parse(IdSchema, draftId);
      const input = parse(ApproveCurriculumInputSchema, value);
      await admission.assertAvailable("generation");
      const receipt = await command(actor, "curriculum.approve", key, { draftId, ...input }, CurriculumApprovalResultSchema, async (tx) => ({ status: 202,
        data: await repository.approveInTransaction(tx, { ownerId: actor.id, draftId, ...input }) }));
      if (receipt.replayed) await transaction(async (tx) => {
        const { draft } = await repository.requireDraft(tx, actor.id, draftId);
        if (draft.revision !== input.expectedRevision || await curriculumDigest(draft) !== input.contentDigest) throw repository.curriculumConflict(draft.revision);
      });
      return receipt;
    },
    async metadata(actor: Actor, courseId: string, value: unknown, key: string) {
      parse(IdSchema, courseId);
      const input = parse(EditCourseMetadataInputSchema, value);
      return command(actor, "course.metadata", key, { courseId, ...input }, CourseArtifactRefSchema, async (tx) => ({ status: 200,
        data: await editMetadataInTransaction(tx, { ownerId: actor.id, courseId, ...input, now: now() }) }));
    },
    async language(actor: Actor, courseId: string, value: unknown, key: string) {
      parse(IdSchema, courseId);
      const input = parse(RequestCourseLanguageInputSchema, value);
      await admission.assertAvailable("agent_turn");
      return command(actor, "course.language", key, { courseId, ...input }, CourseLanguageRequestResultSchema, async (tx) => {
        const { course, draft } = await repository.requireCourseDraft(tx, actor.id, courseId, true);
        if (course.revision !== input.expectedRevision || draft.revision !== input.expectedDraftRevision) throw repository.curriculumConflict(course.revision);
        if (Intl.getCanonicalLocales(input.contentLanguage)[0] === Intl.getCanonicalLocales(draft.contentLanguage)[0]) throw new ServiceFault(400, "invalid_input", "curriculum.languageUnchanged");
        const conversation = await repository.requireAuthoringConversation(tx, actor.id, draft, "update");
        const active = (await tx.query("SELECT id FROM unfurl.agent_turn_runs WHERE conversation_id=$1 AND branch_id=$2 AND status IN ('queued','running')", [draft.conversationId, conversation.branchId])).rows[0];
        if (active) throw new ServiceFault(409, "revision_conflict", "chat.turnInProgress");
        const runId = randomUUID();
        await tx.query(`INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status)
          VALUES($1,$2,$3,$4,$5,'queued')`, [runId, actor.id, draft.conversationId, conversation.branchId, conversation.inputMessageId]);
        await tx.query(`INSERT INTO unfurl.course_language_revision_intents
          (run_id,owner_id,course_id,expected_course_revision,draft_id,expected_draft_revision,target_language)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [runId, actor.id, course.id, course.revision, draft.id, draft.revision, input.contentLanguage]);
        await enqueueAcceptedRun(tx, { kind: "agent_turn", runId });
        const current = await repository.readCurrentRuns(tx, actor.id, await repository.readArtifact(tx, actor.id, course.id));
        if (!current.languageRun || current.languageRun.id !== runId) throw unavailable("generation.acceptanceUnconfirmed");
        return { status: 202, data: { run: current.languageRun, artifact: await repository.readArtifact(tx, actor.id, course.id) } };
      });
    },
  };
}

/** Lazy composition avoids a module cycle with the agent tools using the same mutation service. */
export const curriculumService = createCurriculumService({ admission: {
  assertAvailable: async (kind) => (await import("../runs/composition")).getRuntimeAdmission().assertAvailable(kind),
} });
