import { describe, expect, it } from "vitest";
import {
  AccessibleCourseDetailSchema,
  AssessmentReviewRequestSchema,
  CourseSchema,
  LearningSessionSchema,
  SupportOfferSchema,
} from "../../src/domain";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const at = "2026-10-25T10:00:00Z";

describe("catalog and learning contract joins", () => {
  it("keeps published and latest-ready course versions independent", () => {
    const course = CourseSchema.parse({
      id: id("1"), ownerId: id("2"), slug: "deep-ai", title: "Deep AI", summary: "Build a working model of modern AI.",
      contentLanguage: "en", visibility: "public", currentReadyVersionId: id("4"), publishedVersionId: id("3"),
      createdAt: at, updatedAt: at, revision: 4,
    });
    expect(course.publishedVersionId).not.toBe(course.currentReadyVersionId);
  });

  it("returns the exact accessible version and enrollment identity", () => {
    const detail = AccessibleCourseDetailSchema.parse({
      course: {
        id: id("1"), slug: "deep-ai", title: "Deep AI", summary: "Build a working model of modern AI.",
        contentLanguage: "en", visibility: "public", moduleCount: 1, lessonCount: 2, estimatedStudyMinutes: 40,
        cover: { motifId: "neural-fold", alt: "Layered lines forming a model" }, assumedKnowledge: [],
        outcomes: [{ id: id("5"), title: "Evaluate a model", demonstration: "Diagnose a held-out evaluation.", prerequisiteOutcomeIds: [], requirement: "core" }],
        modules: [{ id: id("6"), title: "Evaluation", summary: "Separate fit from evidence.", outcomeIds: [id("5")], prerequisiteModuleIds: [], estimatedStudyMinutes: 40 }],
      },
      version: { id: id("3"), number: 1 }, access: "enrolled", enrollmentId: id("7"),
    });
    expect(detail.version.id).toBe(id("3"));
  });

  it("requires bounded support material and a final-task completion check", () => {
    const base = {
      id: id("10"), enrollmentId: id("11"), courseVersionId: id("12"), policyVersion: "adaptation-v1",
      basedOnRouteRevision: 2, target: { outcomeId: id("13"), dimensionIds: ["held_out_evidence"] },
      triggerKind: "auto", reasonCode: "additional_practice", basisEvidenceIds: [id("14"), id("15")],
      explanation: "Two separate attempts confused training fit with held-out evidence.",
      tasks: [{ lessonId: id("16"), taskId: id("17"), taskVersion: 2 }], explanationBlock: null,
      estimatedStudyMinutes: 6, returnPoint: { lessonId: id("18"), taskId: id("19") },
      completionCheck: { taskId: id("17"), dimensionIds: ["held_out_evidence"] },
      status: "offered", createdAt: at, updatedAt: at,
    } as const;
    expect(SupportOfferSchema.parse(base).tasks).toHaveLength(1);
    expect(SupportOfferSchema.safeParse({ ...base, tasks: [], completionCheck: null }).success).toBe(false);
    expect(SupportOfferSchema.safeParse({ ...base, completionCheck: { taskId: id("20"), dimensionIds: ["held_out_evidence"] } }).success).toBe(false);
  });

  it("distinguishes resolved uncertain review from a running review", () => {
    const resolved = AssessmentReviewRequestSchema.parse({
      id: id("21"), attemptId: id("22"), evaluationId: id("23"), expectedEvaluationRevision: 1,
      reason: "valid_alternative", comment: "This answer uses an equivalent held-out split.", status: "resolved",
      resolution: "uncertain", resolvedEvaluationRevision: 2, createdAt: at, updatedAt: at, resolvedAt: at,
    });
    expect(resolved.resolution).toBe("uncertain");
    expect(AssessmentReviewRequestSchema.safeParse({ ...resolved, status: "running" }).success).toBe(false);
  });

  it("rejects a learning projection joined across another enrollment", () => {
    const session = {
      enrollment: { id: id("30"), learnerId: id("31"), courseId: id("32"), courseVersionId: id("33"), status: "active", routeRevision: 1, currentLessonId: null, currentTaskId: null, createdAt: at, lastStudiedAt: null },
      route: { enrollmentId: id("34"), revision: 1, policyVersion: "adaptation-v1", targetOutcomeIds: [], next: [], coveredOutcomeIds: [], pendingOutcomeIds: [] },
      lesson: null, task: null,
      progress: { xpTotal: 0, level: 1, xpToNextLevel: 250, completedRequiredOutcomes: 0, totalRequiredOutcomes: 1, publication: { eligible: false, requiredLevel: 3, reasons: ["Reach level 3"] } },
      activity: null, savedInput: null, evaluation: null, support: null,
    };
    expect(LearningSessionSchema.safeParse(session).success).toBe(false);
  });
});
