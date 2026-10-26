import "server-only";
import { z } from "zod";
import { CurriculumDraftSchema, curriculumDigest, type CurriculumDraft, type ModuleOutline, type Outcome } from "../../domain/course";
import type { AgentDecision } from "../agent-tools/contracts";
import { ProviderFailure } from "../ai/failure";
import type { ModelPort } from "../ai/ports";
import { asAgentTarget } from "../agent-turns/repository";
import { applyCurriculumChanges, validateCurriculumOrder } from "../curricula/changes";
import { stableExecutionId } from "../runs/identity";
import type { RunContext } from "../runs/ports";
import { CurriculumResearchEvidenceSchema } from "./contracts";
import { materializeClaimArtifacts, preparedAnswers, sourceInput, type PreparedCurriculum, type SelectedSource } from "./composer";
import { briefEvidenceDigest, moduleEvidenceDigest, outcomeEvidenceDigest, validateCurriculumEvidence } from "./validation";
import { persistPartFacts, readCurriculumParts, runCurriculumPart } from "./part-runtime";
import { CurriculumValidationFailure } from "./validation-feedback";
import { STRICT_RESEARCH_LINK_INSTRUCTIONS, type CurriculumInstructionPolicy } from "./instruction-policy";
import { ContentPageSchema, CourseHeaderSchema, QuestionBatchSchema, QuestionPartSchema, ResearchBatchSchema, ResearchPartSchema,
  RoadmapPageSchema, TranslatedAssumptionsSchema, TranslatedHeaderSchema, TranslatedModulesSchema, TranslatedOutcomesSchema,
  TranslatedQuestionsSchema, type QuestionPart, type ResearchPart, type RoadmapSection } from "./part-contracts";

type CurriculumDecision = Extract<AgentDecision, { tool: "create_course" | "revise_curriculum" | "revise_language" }>;
export interface DurableCompositionInput {
  invocationId: string; decision: CurriculumDecision; capturedDraft: CurriculumDraft | null; now: string; sources: SelectedSource[];
  researchInstructionPolicy?: CurriculumInstructionPolicy;
}
interface ResearchScope { title: string; outcomes: Outcome[]; modules: ModuleOutline[]; sources: SelectedSource[] }
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export function requireExactIds(actual: string[], expected: string[]): void {
  if (actual.length !== expected.length || !unique(actual) || actual.some((id) => !expected.includes(id))) invalid();
}
const chunks = <T>(values: readonly T[], size: number): T[][] => {
  const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result;
};
function chooseSources(available: SelectedSource[], selections: RoadmapSection["sources"]): SelectedSource[] {
  if (!unique(selections.map((source) => source.sourceId))) invalid();
  return selections.map((selection) => {
    const source = available.find((item) => item.document.id === selection.sourceId);
    if (!source || !unique(selection.blockIds) || selection.blockIds.some((id) => !source.blockIds.includes(id))) return invalid();
    return { document: source.document, blockIds: selection.blockIds };
  });
}

/** Pages are private run-step receipts; no draft/artifact exists until this complete result is committed. */
export async function composeDurableCurriculum(context: RunContext, model: ModelPort, input: DurableCompositionInput): Promise<PreparedCurriculum & { summary?: string }> {
  const target = asAgentTarget(context.claim.target);
  const claimContext = (sources: SelectedSource[], step: { stepId: string }) => ({ ownerId: target.ownerId,
    conversationId: target.conversationId, runId: target.runId, now: input.now, sources, step });
  const authorizedSourceIds = new Set(input.sources.map((item) => item.document.id));
  const saved = await readCurriculumParts(context, input.invocationId);
  const parts: ResearchPart[] = [];
  const questionParts: QuestionPart[] = [];
  let draft: CurriculumDraft;
  let summary: string | undefined;
  let rationale: string;
  let limitations: string[] = [];
  let scopes: ResearchScope[];

  async function simplePart<T>(phase: string, index: number, request: unknown, schema: z.ZodType<T>, instructions: string, completedSummary: string): Promise<T> {
    return runCurriculumPart(context, model, { invocationId: input.invocationId, phase, index, request, instructions,
      outputSchema: schema, resultSchema: schema, saved, completedSummary, commit: async (_tx, output) => output });
  }

  if (input.decision.tool === "create_course") {
    const request = input.decision.input;
    const sections: RoadmapSection[] = [];
    let header: z.infer<typeof CourseHeaderSchema> | null = null;
    let nextFocus: string | null = null;
    for (let page = 0; ; page++) {
      const roadmap: z.infer<typeof RoadmapPageSchema> = await simplePart("roadmap", page, { request, continuation: nextFocus,
        completedSections: sections.map(({ key, title }) => ({ key, title })),
        coveredCapabilities: Array.from(new Set(sections.flatMap((section) => section.requiredCapabilities))),
        sources: sourceInput(input.sources) }, RoadmapPageSchema,
      `Plan a substantial, complete learning route for every requested capability, including foundations and dependencies. This is one roadmap page, not the whole-course length limit. Return at most eight sections on this page and continue with complete=false and a precise nextFocus whenever any needed branch or depth remains. Never shorten the course to fit this response. A section is a coherent scope that can later contain any number of modules. Use new stable semantic keys; prerequisiteKeys may reference only sections already saved or earlier on this page. Map each section to exact strings from requiredCapabilities, including prerequisite sections. Select only supplied source/block IDs relevant to that section. Return the course header only on the first page, null afterwards. complete=true is allowed only when the full intended route is planned; nextFocus must then be null.`,
      page === 0 ? "Planned the learning route and its foundations." : "Extended the learning route with its remaining subjects.");
      if (page === 0) {
        if (!roadmap.header || roadmap.header.contentLanguage !== request.contentLanguage) invalid();
        header = roadmap.header;
      } else if (roadmap.header !== null) invalid();
      for (const section of roadmap.sections) {
        if (sections.some((saved) => saved.key === section.key) || section.prerequisiteKeys.some((key) => !sections.some((saved) => saved.key === key))
          || !unique(section.prerequisiteKeys) || !unique(section.requiredCapabilities)
          || section.requiredCapabilities.some((capability) => !request.requiredCapabilities.includes(capability))) invalid();
        chooseSources(input.sources, section.sources);
        sections.push(section);
      }
      if (roadmap.complete) {
        if (!header || sections.length === 0 || request.requiredCapabilities.some((capability) => !sections.some((section) => section.requiredCapabilities.includes(capability)))) invalid();
        break;
      }
      nextFocus = roadmap.nextFocus;
    }
    if (!header) return invalid();
    const outcomes: Outcome[] = [], modules: ModuleOutline[] = [];
    const completed = new Map<string, ResearchScope>();
    let contentPage = 0;
    for (const section of sections) {
      const sectionOutcomes: Outcome[] = [], sectionModules: ModuleOutline[] = [];
      const sources = chooseSources(input.sources, section.sources);
      let continuation: string | null = null;
      const prerequisites = section.prerequisiteKeys.map((key) => {
        const scope = completed.get(key)!;
        const nonterminal = new Set(scope.modules.flatMap((module) => module.prerequisiteModuleIds));
        const frontier = scope.modules.filter((module) => !nonterminal.has(module.id));
        const exits = new Set(frontier.flatMap((module) => module.outcomeIds));
        return { key, title: scope.title, modules: frontier.map(({ id, title, outcomeIds }) => ({ id, title, outcomeIds })),
          outcomes: scope.outcomes.filter((outcome) => exits.has(outcome.id)).map(({ id, title }) => ({ id, title })) };
      });
      for (;;) {
        const page: z.infer<typeof ContentPageSchema> = await simplePart("outline", contentPage++, { header, section, prerequisites, continuation,
          priorOutcomes: sectionOutcomes.slice(-12).map(({ id, title }) => ({ id, title })),
          priorModules: sectionModules.slice(-6).map(({ id, title, outcomeIds }) => ({ id, title, outcomeIds })),
          sources: sourceInput(sources) }, ContentPageSchema,
        `Develop the full scope of this section into concrete outcomes and prerequisite-first modules. Return only the next bounded portion, using new distinct UUIDs for every new outcome and module. Keep each field within its schema. Reference existing prerequisite IDs only from the supplied saved context, or new IDs declared on this page. Preserve depth, prerequisite practice and every requested capability; do not compress the scope into a survey because this response is finite. If more modules or outcomes are needed for this section, return complete=false and describe the remaining work in nextFocus, carrying useful IDs needed by the next page. Continue only with new items. Complete the section only when its entire scope is represented. Each outcome must be taught in a module. Use the prerequisite section frontier in the module dependency graph. Lessons themselves are built only after the user's later approval.`,
        `Outlined the next part of “${section.title}”.`);
        const knownOutcomes = new Set(outcomes.map((outcome) => outcome.id));
        const knownModules = new Set(modules.map((module) => module.id));
        if (!unique(page.outcomes.map((outcome) => outcome.id)) || page.outcomes.some((outcome) => knownOutcomes.has(outcome.id))
          || !unique(page.modules.map((module) => module.id)) || page.modules.some((module) => knownModules.has(module.id))) invalid();
        page.outcomes.forEach((outcome) => knownOutcomes.add(outcome.id));
        for (const outcome of page.outcomes) if (outcome.prerequisiteOutcomeIds.some((id) => !knownOutcomes.has(id))) invalid();
        for (const outline of page.modules) {
          if (outline.outcomeIds.some((id) => !knownOutcomes.has(id)) || outline.prerequisiteModuleIds.some((id) => !knownModules.has(id))) invalid();
          knownModules.add(outline.id);
        }
        outcomes.push(...page.outcomes); modules.push(...page.modules);
        sectionOutcomes.push(...page.outcomes); sectionModules.push(...page.modules);
        if (page.complete) break;
        continuation = page.nextFocus;
      }
      if (sectionOutcomes.length === 0 || sectionModules.length === 0) invalid();
      for (const key of section.prerequisiteKeys) {
        const parentIds = new Set(completed.get(key)!.modules.map((module) => module.id));
        if (!sectionModules.some((module) => module.prerequisiteModuleIds.some((id) => parentIds.has(id)))) invalid();
      }
      completed.set(section.key, { title: section.title, outcomes: sectionOutcomes, modules: sectionModules, sources });
    }
    const { summary: description, rationale: reasoning, limitations: limits, ...fields } = header;
    draft = CurriculumDraftSchema.parse({ ...fields, id: stableExecutionId(input.invocationId, "draft"),
      courseId: stableExecutionId(input.invocationId, "course"), conversationId: target.conversationId, revision: 1,
      outcomes, modules, sourceIds: [], updatedAt: input.now });
    summary = description; rationale = reasoning; limitations = limits;
    scopes = Array.from(completed.values());
  } else {
    if (!input.capturedDraft || input.capturedDraft.conversationId !== target.conversationId) return invalid();
    const current = input.capturedDraft;
    draft = structuredClone(current);
    rationale = `The curriculum is grounded in checked evidence for each learning outcome, with estimated study ranges for every module.`;
    if (input.decision.tool === "revise_language") {
      const targetLanguage = input.decision.input.contentLanguage;
      const header = await simplePart("translate_header", 0, { targetLanguage, title: current.title, goal: current.goal, audience: current.audience },
        TranslatedHeaderSchema, "Translate these curriculum fields faithfully into targetLanguage. Preserve meaning, scope, audience and depth. Return only these translated fields.", "Translated the programme's goal and audience.");
      draft = { ...draft, ...header, contentLanguage: targetLanguage };
      for (const [index, batch] of chunks(current.outcomes, 4).entries()) {
        const output = await simplePart("translate_outcomes", index, { targetLanguage, entries: batch.map(({ id, title, demonstration }) => ({ id, title, demonstration })) },
          TranslatedOutcomesSchema, "Translate exactly these learning outcomes into targetLanguage, preserving every ID and the full demonstrated ability. Return one entry for each supplied ID and no others.", `Translated the learning outcomes beginning with “${batch[0]!.title}”.`);
        requireExactIds(output.entries.map((entry) => entry.id), batch.map((entry) => entry.id));
        const translated = new Map(output.entries.map((entry) => [entry.id, entry]));
        draft.outcomes = draft.outcomes.map((outcome) => ({ ...outcome, ...translated.get(outcome.id) }));
      }
      for (const [index, batch] of chunks(current.modules, 4).entries()) {
        const output = await simplePart("translate_modules", index, { targetLanguage, entries: batch.map(({ id, title, summary }) => ({ id, title, summary })) },
          TranslatedModulesSchema, "Translate exactly these module titles and summaries into targetLanguage. Preserve every ID, all scope and detail. Return one entry per supplied ID and no others.", `Translated the modules beginning with “${batch[0]!.title}”.`);
        requireExactIds(output.entries.map((entry) => entry.id), batch.map((entry) => entry.id));
        const translated = new Map(output.entries.map((entry) => [entry.id, entry]));
        draft.modules = draft.modules.map((module) => ({ ...module, ...translated.get(module.id) }));
      }
      for (const [index, batch] of chunks(current.unresolvedQuestions, 4).entries()) {
        const output = await simplePart("translate_questions", index, { targetLanguage, entries: batch.map(({ id, text }) => ({ id, text })) },
          TranslatedQuestionsSchema, "Translate exactly these questions into targetLanguage. Preserve IDs and the question's meaning. Return one entry per supplied ID.", "Translated the remaining curriculum questions.");
        requireExactIds(output.entries.map((entry) => entry.id), batch.map((entry) => entry.id));
        const translated = new Map(output.entries.map((entry) => [entry.id, entry]));
        draft.unresolvedQuestions = draft.unresolvedQuestions.map((question) => ({ ...question, ...translated.get(question.id) }));
      }
      for (const [index, batch] of chunks(current.assumedKnowledge.map((text, index) => ({ text, index })), 8).entries()) {
        const output = await simplePart("translate_assumptions", index, { targetLanguage, entries: batch }, TranslatedAssumptionsSchema,
          "Translate exactly these assumed-knowledge statements into targetLanguage. Preserve each index and all meaning. Return one entry per supplied index.", "Translated the programme's prerequisites.");
        requireExactIds(output.entries.map((entry) => String(entry.index)), batch.map((entry) => String(entry.index)));
        for (const entry of output.entries) draft.assumedKnowledge[entry.index] = entry.text;
      }
    } else {
      const changes = input.decision.input.changes;
      const answers = changes.filter((change) => change.op === "answer_question");
      if (!unique(answers.map((answer) => answer.id))) invalid();
      for (const [index, batch] of chunks(answers, 4).entries()) {
        const questions = batch.map((answer) => {
          const question = current.unresolvedQuestions.find((question) => question.id === answer.id);
          if (!question) return invalid(); return { question, answer: answer.answer };
        });
        questionParts.push(await runCurriculumPart(context, model, { invocationId: input.invocationId, phase: "questions", index,
          saved,
          request: { goal: current.goal, questions, sources: sourceInput(input.sources) }, outputSchema: QuestionBatchSchema, resultSchema: QuestionPartSchema,
          instructions: "Assess only the exact supplied answers and questions. Return one assessment per question ID. user_context establishes only the learner's own experience/preferences/goals; factual resolution requires claims citing supplied exact source quotes. Give needs_clarification and a precise followUp when the answer is insufficient. Do not reinterpret or add curriculum edits. Claims for these answers use outcomeIds: [].",
          completedSummary: "Checked the supplied curriculum answers.",
          commit: async (tx, output, step) => {
            requireExactIds(output.questionAssessments.map((entry) => entry.questionId), batch.map((entry) => entry.id));
            if (output.claims.some((claim) => claim.outcomeIds.length > 0)) invalid();
            const materialized = materializeClaimArtifacts(claimContext(input.sources, step), output.claims);
            const proof = preparedAnswers(current, batch, output, materialized.localClaimIds);
            if (proof.answers.some((answer) => answer.decision === "resolved" && answer.basis === "source_evidence" && answer.claimIds.length === 0)) invalid();
            const saved = await persistPartFacts(tx, { ...materialized, authorizedSourceIds });
            return { ...saved, answers: proof };
          },
        }));
      }
      if (changes.length) draft = applyCurriculumChanges(current, { expectedRevision: current.revision, changes },
        { now: input.now, verifiedAnswers: questionParts.flatMap((part) => part.answers.verifications) }).draft;
    }
    scopes = [{ title: draft.title, outcomes: draft.outcomes, modules: draft.modules, sources: input.sources }];
  }

  if (validateCurriculumOrder(draft).length) invalid();
  let researchIndex = 0;
  const researchPartInstructions = "Research ONLY the supplied outcome and module records. The rest of this curriculum is saved separately. Return exactly one outcomeEvidence entry per supplied outcome ID and one moduleEstimates entry per supplied module ID, no other target IDs. Each outcome needs claims tied to exact uniquely occurring quotes in the supplied source blocks. Claims may refer only to these outcome IDs. An estimates-only batch can have no claims. Keep all rationale/assumptions/limitations in contentLanguage. The estimate range must be justified and include that module's displayed estimatedStudyMinutes. Do not rewrite the curriculum or omit a target to fit the response.";
  for (const scope of scopes) {
    const outcomeBatches = chunks(scope.outcomes, 4), moduleBatches = chunks(scope.modules, 4);
    for (let batchIndex = 0; batchIndex < Math.max(outcomeBatches.length, moduleBatches.length); batchIndex++) {
      const outcomes = outcomeBatches[batchIndex] ?? [], modules = moduleBatches[batchIndex] ?? [];
      const outcomeIds = new Set(outcomes.map((outcome) => outcome.id));
      const moduleOutcomeIds = new Set(modules.flatMap((module) => module.outcomeIds));
      const partIndex = researchIndex++;
      const part = await runCurriculumPart(context, model, { invocationId: input.invocationId, phase: "research", index: partIndex,
        saved,
        request: { goal: draft.goal, audience: draft.audience, contentLanguage: draft.contentLanguage, scope: scope.title,
          outcomes, modules, moduleOutcomeTitles: draft.outcomes.filter((outcome) => moduleOutcomeIds.has(outcome.id)).map(({ id, title }) => ({ id, title })),
          sources: sourceInput(scope.sources) }, outputSchema: ResearchBatchSchema, resultSchema: ResearchPartSchema,
        instructions: input.researchInstructionPolicy === "research-links-v1" ? `${researchPartInstructions}\n${STRICT_RESEARCH_LINK_INSTRUCTIONS}` : researchPartInstructions,
        ...(input.researchInstructionPolicy === "research-links-v1" ? { instructionVersion: "curriculum-parts-v2:research-links-v1" as const } : {}),
        completedSummary: `Checked sources and study estimates for “${outcomes[0]?.title ?? modules[0]!.title}”.`,
        commit: async (tx, output, step) => {
          requireExactIds(output.outcomeEvidence.map((entry) => entry.outcomeId), outcomes.map((entry) => entry.id));
          requireExactIds(output.moduleEstimates.map((entry) => entry.moduleId), modules.map((entry) => entry.id));
          if (output.claims.some((claim) => claim.outcomeIds.some((id) => !outcomeIds.has(id)))) invalid();
          const materialized = materializeClaimArtifacts(claimContext(scope.sources, step), output.claims);
          const evidence = output.outcomeEvidence.map((entry, evidenceIndex) => {
            const outcome = outcomes.find((outcome) => outcome.id === entry.outcomeId)!;
            const claimIds = entry.claimRefs.map((ref, refIndex) => {
              const id = materialized.localClaimIds.get(ref);
              const claim = id && materialized.claims.find((claim) => claim.id === id);
              if (!claim) return invalid();
              if (!claim.outcomeIds.includes(outcome.id)) throw new CurriculumValidationFailure({ code: "claim_outcome_mismatch",
                path: ["outcomeEvidence", evidenceIndex, "claimRefs", refIndex], claimRef: ref, expectedOutcomeId: outcome.id,
                declaredOutcomeIds: claim.outcomeIds, researchPart: { phase: "research", index: partIndex } });
              return claim.id;
            });
            if (!unique(claimIds)) invalid();
            return { outcomeId: outcome.id, outcomeDigest: outcomeEvidenceDigest(outcome), claimIds, rationale: entry.rationale };
          });
          const estimates = output.moduleEstimates.map((estimate) => {
            const outline = modules.find((module) => module.id === estimate.moduleId)!;
            if (outline.estimatedStudyMinutes < estimate.minMinutes || outline.estimatedStudyMinutes > estimate.maxMinutes) invalid();
            return { ...estimate, moduleDigest: moduleEvidenceDigest(outline) };
          });
          const saved = await persistPartFacts(tx, { ...materialized, authorizedSourceIds });
          return { ...saved, rationale: output.rationale, outcomeEvidence: evidence, moduleEstimates: estimates, limitations: output.limitations };
        },
      });
      parts.push(part);
    }
  }
  const claims = Array.from(new Map([...parts.flatMap((part) => part.claims), ...questionParts.flatMap((part) => part.claims)].map((claim) => [claim.id, claim])).values());
  const passages = Array.from(new Map([...parts.flatMap((part) => part.passages), ...questionParts.flatMap((part) => part.passages)].map((passage) => [passage.id, passage])).values());
  draft = CurriculumDraftSchema.parse({ ...draft, sourceIds: Array.from(new Set(passages.map((passage) => passage.sourceId))) });
  const answers = { verifications: questionParts.flatMap((part) => part.answers.verifications), answers: questionParts.flatMap((part) => part.answers.answers) };
  if (input.decision.tool !== "create_course") rationale = parts[0]?.rationale ?? invalid();
  const evidence = CurriculumResearchEvidenceSchema.parse({ schemaVersion: 1, contentDigest: await curriculumDigest(draft), briefDigest: briefEvidenceDigest(draft),
    rationale, outcomeEvidence: parts.flatMap((part) => part.outcomeEvidence), moduleEstimates: parts.flatMap((part) => part.moduleEstimates),
    questionAnswers: answers.answers, limitations: Array.from(new Set([...limitations, ...parts.flatMap((part) => part.limitations)])) });
  const facts = { ownerId: target.ownerId, authorizedSourceIds, sources: input.sources.map((source) => source.document), passages, claims };
  if ((await validateCurriculumEvidence(draft, evidence, facts)).some((issue) => !["blocking_question", "unresolved_conflict"].includes(issue.code))) invalid();
  // Claims/passages were already committed in private part steps. The final artifact transaction must not repeat those writes.
  return { draft, evidence, facts, claims: [], passages: [], answers, ...(summary === undefined ? {} : { summary }) };
}
