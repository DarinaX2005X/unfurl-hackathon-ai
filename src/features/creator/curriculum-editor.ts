import {
  PatchCurriculumInputSchema,
  type CurriculumChange,
  type PatchCurriculumInput,
} from "@/domain/curriculum-authoring";
import {
  CurriculumDraftSchema,
  validateCurriculum,
  type CurriculumDraft,
  type ModuleOutline,
  type Outcome,
} from "@/domain/course";

export interface CurriculumEditBuffer {
  base: CurriculumDraft;
  working: CurriculumDraft;
  answers: Record<string, string>;
}

export class CurriculumEditError extends Error {
  constructor(readonly reason: "identity_changed" | "unsupported_change" | "invalid_curriculum" | "no_changes") {
    super(reason);
    this.name = "CurriculumEditError";
  }
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function createCurriculumEditBuffer(draft: CurriculumDraft): CurriculumEditBuffer {
  const base = CurriculumDraftSchema.parse(draft);
  return { base: structuredClone(base), working: structuredClone(base), answers: {} };
}

function outcomeChanges(base: Outcome, working: Outcome): Extract<CurriculumChange, { op: "update_outcome" }>["changes"] {
  return {
    ...(base.title === working.title ? {} : { title: working.title }),
    ...(base.demonstration === working.demonstration ? {} : { demonstration: working.demonstration }),
    ...(same(base.prerequisiteOutcomeIds, working.prerequisiteOutcomeIds) ? {} : { prerequisiteOutcomeIds: working.prerequisiteOutcomeIds }),
    ...(base.requirement === working.requirement ? {} : { requirement: working.requirement }),
  };
}

function moduleChanges(base: ModuleOutline, working: ModuleOutline): Extract<CurriculumChange, { op: "update_module" }>["changes"] {
  return {
    ...(base.title === working.title ? {} : { title: working.title }),
    ...(base.summary === working.summary ? {} : { summary: working.summary }),
    ...(same(base.outcomeIds, working.outcomeIds) ? {} : { outcomeIds: working.outcomeIds }),
    ...(same(base.prerequisiteModuleIds, working.prerequisiteModuleIds) ? {} : { prerequisiteModuleIds: working.prerequisiteModuleIds }),
    ...(base.estimatedStudyMinutes === working.estimatedStudyMinutes ? {} : { estimatedStudyMinutes: working.estimatedStudyMinutes }),
  };
}

/** Produces only the server's typed command surface; source, language and authority fields cannot enter the patch. */
export function curriculumPatchForBuffer(buffer: CurriculumEditBuffer, expectedRevision = buffer.base.revision): PatchCurriculumInput {
  const base = CurriculumDraftSchema.parse(buffer.base);
  const working = CurriculumDraftSchema.safeParse(buffer.working);
  if (!working.success || validateCurriculum(buffer.working).length > 0) throw new CurriculumEditError("invalid_curriculum");
  const value = working.data;
  if (base.id !== value.id || base.courseId !== value.courseId || base.conversationId !== value.conversationId) {
    throw new CurriculumEditError("identity_changed");
  }
  if (base.contentLanguage !== value.contentLanguage || !same(base.sourceIds, value.sourceIds)
    || !same(base.unresolvedQuestions, value.unresolvedQuestions)) throw new CurriculumEditError("unsupported_change");
  const changes: CurriculumChange[] = [];
  const details = {
    ...(base.title === value.title ? {} : { title: value.title }),
    ...(base.goal === value.goal ? {} : { goal: value.goal }),
    ...(base.audience === value.audience ? {} : { audience: value.audience }),
    ...(same(base.assumedKnowledge, value.assumedKnowledge) ? {} : { assumedKnowledge: value.assumedKnowledge }),
  };
  if (Object.keys(details).length > 0) changes.push({ op: "set_details", ...details });

  const baseOutcomes = new Map(base.outcomes.map((outcome) => [outcome.id, outcome]));
  const workingOutcomes = new Map(value.outcomes.map((outcome) => [outcome.id, outcome]));
  const survivingOutcomeOrder = base.outcomes.filter((outcome) => workingOutcomes.has(outcome.id)).map((outcome) => outcome.id);
  const actualSurvivingOrder = value.outcomes.filter((outcome) => baseOutcomes.has(outcome.id)).map((outcome) => outcome.id);
  if (!same(survivingOutcomeOrder, actualSurvivingOrder)) throw new CurriculumEditError("unsupported_change");
  for (const outcome of value.outcomes) {
    const previous = baseOutcomes.get(outcome.id);
    if (!previous) changes.push({ op: "add_outcome", outcome });
    else {
      const update = outcomeChanges(previous, outcome);
      if (Object.keys(update).length > 0) changes.push({ op: "update_outcome", id: outcome.id, changes: update });
    }
  }
  for (const outcome of base.outcomes) if (!workingOutcomes.has(outcome.id)) changes.push({ op: "remove_outcome", id: outcome.id });

  const baseModules = new Map(base.modules.map((item) => [item.id, item]));
  const workingModules = new Map(value.modules.map((item) => [item.id, item]));
  for (const [index, item] of value.modules.entries()) {
    const previous = baseModules.get(item.id);
    if (!previous) changes.push({ op: "add_module", module: item, afterModuleId: index === 0 ? null : value.modules[index - 1]!.id });
    else {
      const update = moduleChanges(previous, item);
      if (Object.keys(update).length > 0) changes.push({ op: "update_module", id: item.id, changes: update });
    }
  }
  for (const item of base.modules) if (!workingModules.has(item.id)) changes.push({ op: "remove_module", id: item.id });
  if (!same(base.modules.map((item) => item.id), value.modules.map((item) => item.id))) {
    changes.push({ op: "reorder_modules", moduleIds: value.modules.map((item) => item.id) });
  }

  for (const question of base.unresolvedQuestions) {
    const answer = buffer.answers[question.id]?.trim();
    if (answer) changes.push({ op: "answer_question", id: question.id, answer });
  }
  if (changes.length === 0) throw new CurriculumEditError("no_changes");
  return PatchCurriculumInputSchema.parse({ expectedRevision, changes });
}

/** Reuses the user's exact typed operations while asking the server to validate them against the new canonical revision. */
export function rebaseCurriculumPatch(buffer: CurriculumEditBuffer, latest: CurriculumDraft): PatchCurriculumInput {
  const current = CurriculumDraftSchema.parse(latest);
  if (current.id !== buffer.base.id || current.courseId !== buffer.base.courseId || current.conversationId !== buffer.base.conversationId) {
    throw new CurriculumEditError("identity_changed");
  }
  const original = curriculumPatchForBuffer(buffer);
  return PatchCurriculumInputSchema.parse({ expectedRevision: current.revision, changes: original.changes });
}
