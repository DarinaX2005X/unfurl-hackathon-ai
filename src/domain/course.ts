import { z } from "zod";
import {
  ContentLanguageSchema, DigestSchema, IdSchema, IsoDateTimeSchema,
  RevisionSchema, VisibilitySchema, type JsonValue,
} from "./common";
import { DomainError } from "./errors";

const TitleSchema = z.string().trim().min(1).max(120);
const DescriptionSchema = z.string().trim().min(1).max(4_000);

export const CourseSchema = z.object({
  id: IdSchema,
  ownerId: IdSchema,
  slug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: TitleSchema,
  summary: DescriptionSchema,
  contentLanguage: ContentLanguageSchema,
  visibility: VisibilitySchema,
  currentReadyVersionId: IdSchema.nullable(),
  publishedVersionId: IdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  revision: RevisionSchema,
}).strict();

export const OutcomeSchema = z.object({
  id: IdSchema,
  title: TitleSchema,
  demonstration: DescriptionSchema,
  prerequisiteOutcomeIds: z.array(IdSchema),
  requirement: z.enum(["core", "specialization"]),
}).strict();

export const ModuleOutlineSchema = z.object({
  id: IdSchema,
  title: TitleSchema,
  summary: DescriptionSchema,
  outcomeIds: z.array(IdSchema).min(1),
  prerequisiteModuleIds: z.array(IdSchema),
  estimatedStudyMinutes: z.number().finite(),
}).strict();

export const CurriculumDraftSchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  conversationId: IdSchema,
  revision: RevisionSchema,
  title: TitleSchema,
  contentLanguage: ContentLanguageSchema,
  goal: DescriptionSchema,
  audience: DescriptionSchema,
  assumedKnowledge: z.array(z.string().trim().min(1).max(500)),
  outcomes: z.array(OutcomeSchema).min(1),
  modules: z.array(ModuleOutlineSchema).min(1),
  unresolvedQuestions: z.array(z.object({
    id: IdSchema, text: DescriptionSchema, blocking: z.boolean(),
  }).strict()),
  sourceIds: z.array(IdSchema),
  updatedAt: IsoDateTimeSchema,
}).strict();

export const CurriculumApprovalSchema = z.object({
  id: IdSchema,
  draftId: IdSchema,
  draftRevision: RevisionSchema,
  contentDigest: DigestSchema,
  approvedBy: IdSchema,
  approvedAt: IsoDateTimeSchema,
}).strict();

export const CourseVersionSchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  number: z.number().int().positive(),
  approvalId: IdSchema,
  sourceRunId: IdSchema,
  contentDigest: DigestSchema,
  state: z.enum(["building", "validating", "ready", "failed"]),
  title: TitleSchema,
  summary: DescriptionSchema,
  contentLanguage: ContentLanguageSchema,
  assumedKnowledge: z.array(z.string().trim().min(1).max(500)),
  outcomes: z.array(OutcomeSchema).min(1),
  modules: z.array(ModuleOutlineSchema).min(1),
  lessonIds: z.array(IdSchema),
  validationReceiptId: IdSchema.nullable(),
  cover: z.object({
    motifId: z.string().trim().min(1).max(100),
    alt: z.string().trim().min(1).max(300),
  }).strict().nullable(),
  createdAt: IsoDateTimeSchema,
  readyAt: IsoDateTimeSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === "ready" && (value.readyAt === null || value.lessonIds.length === 0 || value.validationReceiptId === null || value.cover === null)) {
    context.addIssue({ code: "custom", path: ["state"], message: "A ready version needs lessons and a ready timestamp" });
  }
  if (value.state !== "ready" && value.readyAt !== null) {
    context.addIssue({ code: "custom", path: ["readyAt"], message: "Only a ready version has a ready timestamp" });
  }
});

export const CourseCoverSchema = z.object({
  motifId: z.string().trim().min(1).max(100),
  alt: z.string().trim().min(1).max(300),
}).strict();

export const CourseSummarySchema = CourseSchema.pick({
  id: true, slug: true, title: true, summary: true, contentLanguage: true, visibility: true,
}).extend({
  moduleCount: z.number().int().nonnegative(),
  lessonCount: z.number().int().nonnegative(),
  estimatedStudyMinutes: z.number().finite().nonnegative(),
  cover: CourseCoverSchema,
}).strict();

export const CourseDetailPublicSchema = CourseSummarySchema.extend({
  assumedKnowledge: z.array(z.string()),
  outcomes: z.array(OutcomeSchema),
  modules: z.array(ModuleOutlineSchema),
}).strict();

export const AccessibleCourseDetailSchema = z.object({
  course: CourseDetailPublicSchema,
  version: z.object({ id: IdSchema, number: z.number().int().positive() }).strict(),
  access: z.enum(["owner", "public", "share", "enrolled"]),
  enrollmentId: IdSchema.nullable(),
}).strict();

export type Course = z.infer<typeof CourseSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type ModuleOutline = z.infer<typeof ModuleOutlineSchema>;
export type CurriculumDraft = z.infer<typeof CurriculumDraftSchema>;
export type CurriculumApproval = z.infer<typeof CurriculumApprovalSchema>;
export type CourseVersion = z.infer<typeof CourseVersionSchema>;
export type CourseCover = z.infer<typeof CourseCoverSchema>;
export type CourseSummary = z.infer<typeof CourseSummarySchema>;
export type CourseDetailPublic = z.infer<typeof CourseDetailPublicSchema>;
export type AccessibleCourseDetail = z.infer<typeof AccessibleCourseDetailSchema>;

export interface ValidationIssue {
  code: "invalid_shape" | "duplicate_id" | "unknown_reference" | "cycle" | "uncovered_outcome" | "invalid_estimate";
  path: Array<string | number>;
  message: string;
}

function collectCycles(
  nodes: Array<{ id: string; prerequisites: string[] }>,
  field: "outcomes" | "modules",
): ValidationIssue[] {
  const edges = new Map(nodes.map((node) => [node.id, node.prerequisites]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const issues: ValidationIssue[] = [];

  function visit(id: string): void {
    if (visiting.has(id)) {
      issues.push({ code: "cycle", path: [field], message: `A prerequisite cycle includes ${id}` });
      return;
    }
    if (visited.has(id) || !edges.has(id)) return;
    visiting.add(id);
    for (const prerequisite of edges.get(id) ?? []) visit(prerequisite);
    visiting.delete(id);
    visited.add(id);
  }

  for (const node of nodes) visit(node.id);
  return issues;
}

export function validateCurriculum(draft: CurriculumDraft): ValidationIssue[] {
  const parsed = CurriculumDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: "invalid_shape",
      path: issue.path.map((part) => typeof part === "number" ? part : String(part)),
      message: issue.message,
    }));
  }

  const value = parsed.data;
  const issues: ValidationIssue[] = [];
  const allIds = new Set<string>();
  for (const field of ["outcomes", "modules", "unresolvedQuestions"] as const) {
    value[field].forEach((entry, index) => {
      if (allIds.has(entry.id)) {
        issues.push({ code: "duplicate_id", path: [field, index, "id"], message: "Every curriculum item needs a unique ID" });
      }
      allIds.add(entry.id);
    });
  }
  const outcomeIds = new Set(value.outcomes.map((outcome) => outcome.id));
  const moduleIds = new Set(value.modules.map((module) => module.id));
  const coveredOutcomeIds = new Set(value.modules.flatMap((module) => module.outcomeIds));

  function checkReferences(ids: string[], allowed: Set<string>, path: Array<string | number>): void {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (!allowed.has(id)) issues.push({ code: "unknown_reference", path: [...path, index], message: "The referenced item is not in this curriculum" });
      if (seen.has(id)) issues.push({ code: "duplicate_id", path: [...path, index], message: "The same item is referenced more than once" });
      seen.add(id);
    });
  }

  value.outcomes.forEach((outcome, index) => {
    checkReferences(outcome.prerequisiteOutcomeIds, outcomeIds, ["outcomes", index, "prerequisiteOutcomeIds"]);
    if (outcome.requirement === "core" && !coveredOutcomeIds.has(outcome.id)) {
      issues.push({ code: "uncovered_outcome", path: ["outcomes", index], message: "A core outcome must be covered by a module" });
    }
  });
  value.modules.forEach((module, index) => {
    checkReferences(module.outcomeIds, outcomeIds, ["modules", index, "outcomeIds"]);
    checkReferences(module.prerequisiteModuleIds, moduleIds, ["modules", index, "prerequisiteModuleIds"]);
    if (module.estimatedStudyMinutes <= 0) {
      issues.push({ code: "invalid_estimate", path: ["modules", index, "estimatedStudyMinutes"], message: "Study time must be a positive number of minutes" });
    }
  });
  if (new Set(value.sourceIds).size !== value.sourceIds.length) {
    issues.push({ code: "duplicate_id", path: ["sourceIds"], message: "Source IDs must be unique" });
  }
  issues.push(...collectCycles(value.outcomes.map((item) => ({ id: item.id, prerequisites: item.prerequisiteOutcomeIds })), "outcomes"));
  issues.push(...collectCycles(value.modules.map((item) => ({ id: item.id, prerequisites: item.prerequisiteModuleIds })), "modules"));
  return issues;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function curriculumDigest(draft: CurriculumDraft): Promise<string> {
  const value = CurriculumDraftSchema.parse(draft);
  const content = {
    title: value.title,
    contentLanguage: value.contentLanguage,
    goal: value.goal,
    audience: value.audience,
    assumedKnowledge: value.assumedKnowledge,
    outcomes: value.outcomes,
    modules: value.modules,
    unresolvedQuestions: value.unresolvedQuestions,
    sourceIds: value.sourceIds,
  };
  const bytes = new TextEncoder().encode(canonicalJson(content));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertCurrentApproval(draft: CurriculumDraft, approval: CurriculumApproval): Promise<void> {
  const current = CurriculumDraftSchema.parse(draft);
  const accepted = CurriculumApprovalSchema.parse(approval);
  const conflict = (reason: string, message: string): never => {
    throw new DomainError("approval_conflict", reason, message);
  };
  if (accepted.draftId !== current.id) conflict("draft_mismatch", "This approval belongs to another curriculum");
  if (accepted.draftRevision !== current.revision) conflict("revision_mismatch", "The curriculum changed after approval");
  if (current.unresolvedQuestions.some((question) => question.blocking)) {
    conflict("blocking_questions", "Resolve the required questions before approving this curriculum");
  }
  if (validateCurriculum(current).length > 0) {
    throw new DomainError("invalid_curriculum", "validation_failed", "This curriculum has unresolved structural issues");
  }
  if (accepted.contentDigest !== await curriculumDigest(current)) {
    conflict("content_mismatch", "The approved content no longer matches this curriculum");
  }
}
