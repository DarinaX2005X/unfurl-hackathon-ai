import "server-only";
import { createHash } from "node:crypto";
import { CurriculumDraftSchema, validateCurriculum, type CurriculumDraft, type ValidationIssue } from "../../domain/course";
import { PatchCurriculumInputSchema, type CurriculumChange, type PatchCurriculumInput } from "../../domain/curriculum-authoring";
import { IsoDateTimeSchema } from "../../domain/common";

export interface QuestionAnswerVerification {
  questionId: string;
  questionDigest: string;
  answerDigest: string;
  decision: "resolved" | "needs_clarification";
  followUp: string | null;
}
export interface AppliedCurriculumChanges {
  draft: CurriculumDraft;
  changed: boolean;
  /** The research service must recheck affected semantic content, not just copy old claim IDs. */
  researchImpact: "none" | "structure" | "content";
  answeredQuestions: Array<{ questionId: string; question: string; answer: string; resolved: boolean }>;
}
export class CurriculumChangeError extends Error {
  constructor(
    readonly code: "invalid_input" | "revision_conflict" | "unknown_reference" | "invalid_curriculum" | "question_unverified",
    readonly issues: ValidationIssue[] = [],
    readonly currentRevision?: number,
  ) { super(code); this.name = "CurriculumChangeError"; }
}

export function answerDigest(answer: string): string { return createHash("sha256").update(answer.trim()).digest("hex"); }
export function questionDigest(question: { id: string; text: string }): string {
  return createHash("sha256").update(JSON.stringify([question.id, question.text])).digest("hex");
}

/** Full document checks run after the whole command batch, so explicit multi-item repairs are atomic. */
export function validateCurriculumOrder(draft: CurriculumDraft): ValidationIssue[] {
  const issues = validateCurriculum(draft);
  if (issues.some((issue) => issue.code === "invalid_shape")) return issues;
  const positions = new Map(draft.modules.map((module, index) => [module.id, index]));
  const firstOutcome = new Map<string, number>();
  draft.modules.forEach((module, index) => {
    module.outcomeIds.forEach((id) => { if (!firstOutcome.has(id)) firstOutcome.set(id, index); });
    module.prerequisiteModuleIds.forEach((id) => {
      const before = positions.get(id);
      if (before !== undefined && before >= index) issues.push({ code: "invalid_shape", path: ["modules", index, "prerequisiteModuleIds"],
        message: "A prerequisite module must appear before the module that uses it" });
    });
  });
  draft.outcomes.forEach((outcome, index) => {
    const position = firstOutcome.get(outcome.id);
    if (position === undefined && outcome.requirement !== "core") issues.push({ code: "uncovered_outcome", path: ["outcomes", index],
      message: "A specialization outcome also needs a module" });
    outcome.prerequisiteOutcomeIds.forEach((id) => {
      const before = firstOutcome.get(id);
      if (position !== undefined && before !== undefined && before > position) issues.push({ code: "invalid_shape", path: ["outcomes", index, "prerequisiteOutcomeIds"],
        message: "An outcome cannot first appear before its prerequisite" });
    });
  });
  return issues;
}

function requireIndex(items: Array<{ id: string }>, id: string): number {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new CurriculumChangeError("unknown_reference");
  return index;
}
function content(draft: CurriculumDraft): string {
  return JSON.stringify({ ...draft, revision: 1, updatedAt: "" });
}
function impact(change: CurriculumChange): AppliedCurriculumChanges["researchImpact"] {
  if (change.op === "set_details") return Object.keys(change).some((key) => !["op", "title"].includes(key)) ? "content" : "none";
  if (["reorder_modules", "remove_outcome", "remove_module"].includes(change.op)) return "structure";
  return "content";
}

export function applyCurriculumChanges(
  current: CurriculumDraft,
  request: PatchCurriculumInput,
  options: { now: string; verifiedAnswers?: readonly QuestionAnswerVerification[] },
): AppliedCurriculumChanges {
  const original = CurriculumDraftSchema.parse(current);
  const parsed = PatchCurriculumInputSchema.safeParse(request);
  if (!parsed.success || !IsoDateTimeSchema.safeParse(options.now).success) throw new CurriculumChangeError("invalid_input");
  if (parsed.data.expectedRevision !== original.revision) throw new CurriculumChangeError("revision_conflict", [], original.revision);
  const draft = structuredClone(original);
  let researchImpact: AppliedCurriculumChanges["researchImpact"] = "none";
  const answeredQuestions: AppliedCurriculumChanges["answeredQuestions"] = [];

  for (const change of parsed.data.changes) {
    const nextImpact = impact(change);
    if (nextImpact === "content" || (nextImpact === "structure" && researchImpact === "none")) researchImpact = nextImpact;
    switch (change.op) {
      case "set_details": {
        if (change.title !== undefined) draft.title = change.title;
        if (change.goal !== undefined) draft.goal = change.goal;
        if (change.audience !== undefined) draft.audience = change.audience;
        if (change.assumedKnowledge !== undefined) draft.assumedKnowledge = change.assumedKnowledge;
        break;
      }
      case "add_outcome": draft.outcomes.push(change.outcome); break;
      case "update_outcome": {
        const index = requireIndex(draft.outcomes, change.id);
        const target = draft.outcomes[index]!;
        if (change.changes.title !== undefined) target.title = change.changes.title;
        if (change.changes.demonstration !== undefined) target.demonstration = change.changes.demonstration;
        if (change.changes.prerequisiteOutcomeIds !== undefined) target.prerequisiteOutcomeIds = change.changes.prerequisiteOutcomeIds;
        if (change.changes.requirement !== undefined) target.requirement = change.changes.requirement;
        break;
      }
      case "remove_outcome": draft.outcomes.splice(requireIndex(draft.outcomes, change.id), 1); break;
      case "add_module": {
        const index = change.afterModuleId === null ? 0 : requireIndex(draft.modules, change.afterModuleId) + 1;
        draft.modules.splice(index, 0, change.module);
        break;
      }
      case "update_module": {
        const index = requireIndex(draft.modules, change.id);
        const target = draft.modules[index]!;
        if (change.changes.title !== undefined) target.title = change.changes.title;
        if (change.changes.summary !== undefined) target.summary = change.changes.summary;
        if (change.changes.outcomeIds !== undefined) target.outcomeIds = change.changes.outcomeIds;
        if (change.changes.prerequisiteModuleIds !== undefined) target.prerequisiteModuleIds = change.changes.prerequisiteModuleIds;
        if (change.changes.estimatedStudyMinutes !== undefined) target.estimatedStudyMinutes = change.changes.estimatedStudyMinutes;
        break;
      }
      case "remove_module": draft.modules.splice(requireIndex(draft.modules, change.id), 1); break;
      case "reorder_modules": {
        if (change.moduleIds.length !== draft.modules.length || new Set(change.moduleIds).size !== draft.modules.length) {
          throw new CurriculumChangeError("invalid_input");
        }
        draft.modules = change.moduleIds.map((id) => draft.modules[requireIndex(draft.modules, id)]!);
        break;
      }
      case "answer_question": {
        const index = requireIndex(draft.unresolvedQuestions, change.id);
        const question = draft.unresolvedQuestions[index]!;
        const verification = options.verifiedAnswers?.find((item) => item.questionId === question.id
          && item.questionDigest === questionDigest(question) && item.answerDigest === answerDigest(change.answer));
        if (!verification || (verification.decision === "needs_clarification" && !verification.followUp?.trim())) {
          throw new CurriculumChangeError("question_unverified");
        }
        const resolved = verification.decision === "resolved";
        answeredQuestions.push({ questionId: question.id, question: question.text, answer: change.answer, resolved });
        if (resolved) draft.unresolvedQuestions.splice(index, 1);
        else draft.unresolvedQuestions[index] = { ...question, text: verification.followUp!.trim() };
        break;
      }
    }
  }

  const issues = validateCurriculumOrder(draft);
  if (issues.length > 0) throw new CurriculumChangeError("invalid_curriculum", issues);
  const changed = content(original) !== content(draft);
  if (changed) { draft.revision = original.revision + 1; draft.updatedAt = options.now; }
  return { draft: CurriculumDraftSchema.parse(draft), changed, researchImpact: changed ? researchImpact : "none", answeredQuestions };
}
