import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonValueSchema, type JsonValue } from "@/domain/common";
import type { CurriculumDraft } from "@/domain/course";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import { SourceClaimSchema } from "@/server/curriculum-research/contracts";
import { SourceDocumentSchema, PassageSchema } from "@/server/research/ports";
import { verifyPassage } from "@/server/research/repository";
import { jsonDigest } from "@/server/ai/json";
import { ProviderFailure } from "@/server/ai/failure";
import { ResponsePathSchema, resolveResponsePath } from "@/server/evaluation/contracts";
import { taskDigest } from "@/server/mechanics/digest";
import { ModuleKnowledgeSchema, type GenerationValidationIssue, type ModuleKnowledge } from "@/server/course-generation/contracts";

export interface KnowledgeContext extends CurriculumEvidenceFacts { draft: CurriculumDraft; approvalDigest: string }
export function validateModuleKnowledge(value: unknown, context: KnowledgeContext): GenerationValidationIssue[] {
  const parsed = ModuleKnowledgeSchema.safeParse(value);
  if (!parsed.success) return [{ code: "invalid_shape", path: [], message: "Module knowledge must match its strict schema" }];
  const knowledge = parsed.data;
  const issues: GenerationValidationIssue[] = [];
  const add = (code: GenerationValidationIssue["code"], path: GenerationValidationIssue["path"], message: string) => issues.push({ code, path, message });
  if (knowledge.approvalDigest !== context.approvalDigest) add("stale_approval", ["approvalDigest"], "Knowledge belongs to another approved curriculum");
  const section = context.draft.modules.find((item) => item.id === knowledge.moduleId);
  if (!section) return [...issues, { code: "unknown_reference", path: ["moduleId"], message: "Module is outside the approved curriculum" }];
  const sources = SourceDocumentSchema.array().safeParse(context.sources);
  const passages = PassageSchema.array().safeParse(context.passages);
  const claims = SourceClaimSchema.array().safeParse(context.claims);
  if (!sources.success || !passages.success || !claims.success) return [...issues, { code: "invalid_source", path: [], message: "Stored research does not match its schema" }];
  const sourceMap = new Map(sources.data.map((item) => [item.id, item]));
  const passageMap = new Map(passages.data.map((item) => [item.id, item]));
  const claimMap = new Map(claims.data.map((item) => [item.id, item]));
  if (sourceMap.size !== sources.data.length || passageMap.size !== passages.data.length || claimMap.size !== claims.data.length) {
    add("duplicate_reference", [], "Research identities must be unique");
  }
  const outcomeIds = knowledge.outcomes.map((item) => item.outcomeId);
  if (new Set(outcomeIds).size !== outcomeIds.length) add("duplicate_reference", ["outcomes"], "Each section outcome occurs once");
  if (section.outcomeIds.some((id) => !outcomeIds.includes(id)) || outcomeIds.some((id) => !section.outcomeIds.includes(id))) {
    add("missing_outcome", ["outcomes"], "Knowledge must cover exactly this section's approved outcomes");
  }
  knowledge.outcomes.forEach((outcome, index) => {
    if (new Set(outcome.criteria.map((criterion) => criterion.id)).size !== outcome.criteria.length) add("criterion_mismatch", ["outcomes", index, "criteria"], "Canonical criteria must be unique");
    const references = [...outcome.concepts, ...outcome.misconceptions].flatMap((item) => item.claimIds);
    for (const id of new Set(references)) {
      const path = ["outcomes", index, "claims", id];
      const claim = claimMap.get(id);
      if (!claim || claim.ownerId !== context.ownerId || !claim.outcomeIds.includes(outcome.outcomeId)) {
        add("invalid_source", path, "Knowledge needs an authorized stored claim for the actual outcome"); continue;
      }
      if (claim.unresolvedConflicts.some((conflict) => conflict.blocking)) add("unresolved_conflict", path, "Blocking source contradictions remain unresolved");
      if (new Set(claim.passageIds).size !== claim.passageIds.length) add("duplicate_reference", path, "Claim passages must be distinct");
      for (const passageId of claim.passageIds) {
        const passage = passageMap.get(passageId);
        const source = passage && sourceMap.get(passage.sourceId);
        try {
          if (!source || !passage || !context.authorizedSourceIds.has(source.id) || jsonDigest(source.blocks, 2 * 1024 * 1024) !== source.contentDigest) throw new Error();
          verifyPassage(source, passage);
        } catch { add("invalid_source", path, "Supporting passage must match an authorized immutable source document"); }
      }
    }
  });
  return issues;
}

export function knowledgeClaimIds(knowledge: ModuleKnowledge, outcomeId?: string): Set<string> {
  return new Set(knowledge.outcomes.filter((item) => outcomeId === undefined || item.outcomeId === outcomeId)
    .flatMap((item) => [...item.concepts, ...item.misconceptions].flatMap((entry) => entry.claimIds)));
}

export const KNOWLEDGE_COVERAGE_CATEGORIES = ["approved_scope", "criteria", "source_support"] as const;
export const KnowledgeCoverageReviewSchema = z.object({ knowledgeDigest: DigestSchema, outcomeId: IdSchema,
  publicCommentary: z.string().trim().min(1).max(1600).nullable(),
  checks: z.array(z.object({ category: z.enum(KNOWLEDGE_COVERAGE_CATEGORIES), status: z.enum(["passed", "failed", "uncertain"]),
    explanation: z.string().trim().min(1).max(4000), correction: z.string().trim().min(1).max(4000).nullable(),
    evidence: z.array(z.object({ path: ResponsePathSchema, value: JsonValueSchema }).strict()).min(1),
  }).strict()).length(3),
  invalidCriteria: z.array(z.object({ criterionId: z.string().min(1).max(128), reason: z.string().trim().min(1).max(4000) }).strict()),
  unsupportedClaimIds: z.array(IdSchema),
}).strict();
export type KnowledgeCoverageReview = z.infer<typeof KnowledgeCoverageReviewSchema>;

/** The complete approved demonstration, not its title or an authored proxy, is the review authority. */
export function createKnowledgeCoverageInput(input: { draft: CurriculumDraft; knowledge: ModuleKnowledge;
  sourceKnowledgeStepId: string; outcomeId: string; facts: CurriculumEvidenceFacts; correction: JsonValue }): JsonValue {
  const approvedModule = input.draft.modules.find(item => item.id === input.knowledge.moduleId);
  const approvedOutcome = input.draft.outcomes.find(item => item.id === input.outcomeId);
  if (!approvedModule?.outcomeIds.includes(input.outcomeId) || !approvedOutcome) throw new ProviderFailure("invalid_output");
  const claimIds = knowledgeClaimIds(input.knowledge, input.outcomeId);
  const claims = input.facts.claims.filter(claim => claimIds.has(claim.id));
  const passageIds = new Set(claims.flatMap(claim => claim.passageIds));
  return JsonValueSchema.parse({ sourceKnowledgeStepId: IdSchema.parse(input.sourceKnowledgeStepId), knowledgeDigest: taskDigest(input.knowledge),
    approvedModule, approvedOutcome, assumedKnowledge: input.draft.assumedKnowledge, knowledge: input.knowledge,
    claims, passages: input.facts.passages.filter(passage => passageIds.has(passage.id)), correction: input.correction });
}

export function assessKnowledgeCoverageReview(value: unknown, material: JsonValue) {
  const invalid = (): never => { throw new ProviderFailure("invalid_output"); };
  const review = KnowledgeCoverageReviewSchema.parse(value);
  const input = z.object({ knowledgeDigest: DigestSchema, approvedOutcome: z.object({ id: IdSchema, demonstration: z.string() }),
    knowledge: ModuleKnowledgeSchema, claims: z.array(z.object({ id: IdSchema })) }).parse(material);
  if (review.knowledgeDigest !== input.knowledgeDigest || input.knowledgeDigest !== taskDigest(input.knowledge) ||
      review.outcomeId !== input.approvedOutcome.id || new Set(review.checks.map(check => check.category)).size !== 3) return invalid();
  for (const check of review.checks) {
    if (check.status !== "passed" && check.correction === null) return invalid();
    for (const evidence of check.evidence) {
      const resolved = resolveResponsePath(material, evidence.path);
      if (!resolved.found || taskDigest(resolved.value) !== taskDigest(evidence.value)) return invalid();
    }
    if (check.category === "approved_scope" && (!check.evidence.some(evidence =>
      taskDigest(evidence.path) === taskDigest(["approvedOutcome", "demonstration"])) ||
      !check.evidence.some(evidence => evidence.path[0] === "knowledge"))) return invalid();
  }
  const outcome = input.knowledge.outcomes.find(item => item.outcomeId === review.outcomeId);
  if (!outcome || new Set(review.invalidCriteria.map(item => item.criterionId)).size !== review.invalidCriteria.length ||
      review.invalidCriteria.some(item => !outcome.criteria.some(criterion => criterion.id === item.criterionId)) ||
      new Set(review.unsupportedClaimIds).size !== review.unsupportedClaimIds.length ||
      review.unsupportedClaimIds.some(id => !input.claims.some(claim => claim.id === id))) return invalid();
  if (review.invalidCriteria.length && review.checks.find(check => check.category === "criteria")!.status === "passed" ||
      review.unsupportedClaimIds.length && review.checks.find(check => check.category === "source_support")!.status === "passed") return invalid();
  return { passed: review.checks.every(check => check.status === "passed"), review };
}

export const KNOWLEDGE_COVERAGE_INSTRUCTIONS = `Independently review the saved knowledge against the COMPLETE approvedOutcome.demonstration and approvedModule scope before lessons are planned. Cover every operation, implementation requirement, representation, constraint and depth requirement in that demonstration, including prerequisites. Matching outcome IDs, titles or a subset of the demonstration is insufficient. Do not replace advanced or implementation competencies with introductory proxies. Return exactly one check for approved_scope, criteria and source_support. A passed approved_scope check means every part of the complete demonstration is teachable from this knowledge; a passed criteria check means canonical criteria assess every required competence; source_support must establish substantive support from the actual supplied claims and exact passages. Later lesson authoring cannot invent omitted source knowledge.
publicCommentary is a brief natural message to the course creator in the course content language explaining what was established about this approved topic and what comes next. Say when more source work is needed. Never expose task answers, private assessment criteria, source quotes, internal IDs or implementation jargon; never claim the course is complete. Use null only if this result adds no useful progress to communicate.
Every check needs exact evidence paths and values into this input. The approved_scope check MUST cite ["approvedOutcome","demonstration"] with its full unchanged value AND actual knowledge evidence. Failed or uncertain checks require concrete actionable corrections describing the missing competence and research needed. Identify an existing incorrect criterion in invalidCriteria only when it must be retired, explaining why; missing criteria normally require additions, not removal of valid criteria. Changed competencies require new criterion IDs, never silent changes to old identities. List unsupportedClaimIds only when supplied claims genuinely fail to support their stated knowledge; do not discard valid evidence. Passed checks cannot retire criteria or reject source claims. Treat correction as prior review evidence to investigate, not permission to weaken the approved scope. This review cannot waive later source, lesson, task or complete-module validation.`;

/** Retain valid competencies; a justified semantic replacement gets a new identity in the new revision. */
export function validateKnowledgeRevision(value: unknown, previous: ModuleKnowledge, reviews: readonly KnowledgeCoverageReview[], context: KnowledgeContext) {
  const issues = validateModuleKnowledge(value, context), parsed = ModuleKnowledgeSchema.safeParse(value);
  if (!parsed.success) return issues;
  const knowledge = parsed.data;
  for (const outcome of previous.outcomes) {
    const current = knowledge.outcomes.find(item => item.outcomeId === outcome.outcomeId);
    for (const criterion of outcome.criteria) {
      const retired = reviews.some(review => review.outcomeId === outcome.outcomeId && review.invalidCriteria.some(item => item.criterionId === criterion.id));
      const retained = current?.criteria.find(item => item.id === criterion.id);
      if (retired ? retained !== undefined : !retained || retained.description !== criterion.description) issues.push({ code: "criterion_mismatch",
        path: ["outcomes", outcome.outcomeId, "criteria", criterion.id], message: retired
          ? "A justified replacement competency requires a new criterion identity" : "Valid established criteria retain their identities and exact descriptions" });
    }
  }
  const referenced = knowledgeClaimIds(knowledge);
  if (reviews.some(review => review.unsupportedClaimIds.some(id => referenced.has(id)))) issues.push({ code: "invalid_source", path: ["claims"],
    message: "Revised knowledge must not reuse source claims identified as unsupported by its coverage review" });
  const unsupported = new Set(reviews.flatMap(review => review.unsupportedClaimIds));
  for (const outcome of previous.outcomes) {
    const retainedClaims = knowledgeClaimIds(knowledge, outcome.outcomeId);
    if ([...knowledgeClaimIds(previous, outcome.outcomeId)].some(id => !unsupported.has(id) && !retainedClaims.has(id)))
      issues.push({ code: "invalid_source", path: ["outcomes", outcome.outcomeId, "claims"],
        message: "Targeted revisions retain valid established source claims for their original outcomes" });
  }
  return issues;
}
