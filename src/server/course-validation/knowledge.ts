import "server-only";
import type { CurriculumDraft } from "@/domain/course";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import { SourceClaimSchema } from "@/server/curriculum-research/contracts";
import { SourceDocumentSchema, PassageSchema } from "@/server/research/ports";
import { verifyPassage } from "@/server/research/repository";
import { jsonDigest } from "@/server/ai/json";
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
