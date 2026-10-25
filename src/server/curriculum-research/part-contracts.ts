import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { CurriculumDraftSchema, ModuleOutlineSchema, OutcomeSchema } from "../../domain/course";
import { SourceSelectionSchema } from "../agent-tools/contracts";
import { PassageSchema } from "../research/ports";
import { CurriculumResearchEvidenceSchema, SourceClaimSchema } from "./contracts";
import { PreparedCurriculumOutputSchema, ProposedClaimSchema, ResearchPackageSchema } from "./composer";

export const LocalSectionKey = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const CourseHeaderSchema = CurriculumDraftSchema.pick({ title: true, goal: true, audience: true,
  assumedKnowledge: true, contentLanguage: true, unresolvedQuestions: true }).extend({
  summary: z.string().trim().min(1).max(4000), rationale: z.string().trim().min(1).max(12000),
  limitations: z.array(z.string().trim().min(1).max(2000)),
}).strict();
export const RoadmapSectionSchema = z.object({ key: LocalSectionKey, title: z.string().trim().min(1).max(120),
  scope: z.string().trim().min(1).max(4000), prerequisiteKeys: z.array(LocalSectionKey),
  requiredCapabilities: z.array(z.string().trim().min(1).max(1000)).min(1),
  sources: z.array(SourceSelectionSchema).min(1),
}).strict();
const continuation = { complete: z.boolean(), nextFocus: z.string().trim().min(1).max(4000).nullable() };
export const RoadmapPageSchema = z.object({ header: CourseHeaderSchema.nullable(),
  // Bounds one response, never the total roadmap or curriculum.
  sections: z.array(RoadmapSectionSchema).max(8), ...continuation,
}).strict().refine((page) => page.complete === (page.nextFocus === null) && (page.complete || page.sections.length > 0));
export const ContentPageSchema = z.object({ outcomes: z.array(OutcomeSchema), modules: z.array(ModuleOutlineSchema),
  ...continuation,
}).strict().refine((page) => page.complete === (page.nextFocus === null) && page.outcomes.length + page.modules.length > 0);
export const ResearchBatchSchema = ResearchPackageSchema.pick({ rationale: true, outcomeEvidence: true, moduleEstimates: true, limitations: true })
  .extend({ claims: z.array(ProposedClaimSchema) }).strict();
export const QuestionBatchSchema = ResearchPackageSchema.pick({ questionAssessments: true })
  .extend({ claims: z.array(ProposedClaimSchema) }).strict();
export const ResearchPartSchema = z.object({
  rationale: ResearchPackageSchema.shape.rationale,
  outcomeEvidence: CurriculumResearchEvidenceSchema.shape.outcomeEvidence,
  moduleEstimates: CurriculumResearchEvidenceSchema.shape.moduleEstimates,
  claims: z.array(SourceClaimSchema), passages: z.array(PassageSchema),
  limitations: z.array(z.string().trim().min(1).max(2000)),
}).strict();
export const QuestionPartSchema = z.object({ claims: z.array(SourceClaimSchema), passages: z.array(PassageSchema),
  answers: PreparedCurriculumOutputSchema.shape.answers,
}).strict();
export const TranslatedHeaderSchema = CurriculumDraftSchema.pick({ title: true, goal: true, audience: true }).strict();
export const TranslatedOutcomesSchema = z.object({ entries: z.array(OutcomeSchema.pick({ id: true, title: true, demonstration: true })) }).strict();
export const TranslatedModulesSchema = z.object({ entries: z.array(ModuleOutlineSchema.pick({ id: true, title: true, summary: true })) }).strict();
export const TranslatedQuestionsSchema = z.object({ entries: z.array(z.object({ id: IdSchema, text: z.string().trim().min(1).max(4000) }).strict()) }).strict();
export const TranslatedAssumptionsSchema = z.object({ entries: z.array(z.object({ index: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(500) }).strict()) }).strict();

export type RoadmapSection = z.infer<typeof RoadmapSectionSchema>;
export type ResearchPart = z.infer<typeof ResearchPartSchema>;
export type QuestionPart = z.infer<typeof QuestionPartSchema>;
