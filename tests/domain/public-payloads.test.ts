import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ContentLanguageSchema, JsonObjectSchema, UiLocaleSchema } from "../../src/domain/common";
import { GenerationRunSchema } from "../../src/domain/generation";
import { AttemptSchema, EvaluationSchema, SampleAttemptSchema, SampleEvaluationSchema } from "../../src/domain/learning";
import { serializePublicTask, TaskPublicSchema } from "../../src/domain/mechanics";
import { ids, timestamp } from "./fixtures";

function task() {
  return {
    id: ids.task, taskVersion: 1, mechanicId: "constrained_optimization" as const,
    mechanicVersion: 1, outcomeIds: [ids.outcomeA],
    instruction: "Choose a model using the supplied validation evidence.",
    contentLanguage: "en", config: { degrees: [1, 3, 7], penalties: [0, 0.1, 1] },
    availableHints: 2, responseSchemaVersion: 1,
  };
}

const attemptPayload = {
  id: ids.attempt, taskId: ids.task, taskVersion: 1, idempotencyKey: ids.request,
  response: { degree: 3, penalty: 0.1 }, assistance: "independent", hintIdsUsed: [],
  submittedAt: timestamp,
};
const evaluation = {
  id: ids.evaluation, attemptId: ids.attempt, status: "evaluated", outcome: "correct",
  dimensions: [{ id: "evidence", status: "met", explanation: "The validation result supports this choice." }],
  feedback: { explanation: "You compared both errors.", nextAction: "continue" }, awardedXp: 0,
};

describe("public task boundary", () => {
  it("projects only the public contract from a server record", () => {
    const publicTask = task();
    const result = serializePublicTask({
      ...publicTask,
      evaluationSpec: { kind: "deterministic", secretConfig: { expectedAnswer: 3 } },
      expectedAnswer: 3,
      privateResearch: "Internal source assessment",
      sourceClaimIds: [ids.source],
      validationReceiptId: ids.missing,
    }, JsonObjectSchema);
    expect(result).toEqual(publicTask);
    expect(JSON.stringify(result)).not.toMatch(/evaluationSpec|secretConfig|expectedAnswer|privateResearch|sourceClaimIds|validationReceiptId/);
  });

  it.each(["secretConfig", "expectedAnswer", "evaluationSpec", "privateResearch"])(
    "rejects a nested %s field inside otherwise public config", (privateKey) => {
      const source = { ...task(), config: { panels: [{ settings: { [privateKey]: "hidden" } }] } };
      expect(() => serializePublicTask(source, JsonObjectSchema)).toThrow(expect.objectContaining({
        code: "unsafe_public_payload", reason: "private_config_key",
      }));
    },
  );

  it("checks the mechanic-specific config and refuses unknown mechanics", () => {
    const schema = z.object({ degrees: z.array(z.number().int().positive()), penalties: z.array(z.number().nonnegative()) }).strict();
    expect(serializePublicTask(task(), schema).config.degrees).toEqual([1, 3, 7]);
    expect(() => serializePublicTask({ ...task(), config: { degrees: [-1], penalties: [0] } }, schema)).toThrow();
    expect(TaskPublicSchema.safeParse({ ...task(), mechanicId: "custom_html" }).success).toBe(false);
    expect(TaskPublicSchema.safeParse({ ...task(), expectedAnswer: 3 }).success).toBe(false);
  });
});

describe("learning and run boundaries", () => {
  it("keeps a sample attempt distinct from an enrolled attempt", () => {
    expect(SampleAttemptSchema.safeParse({ ...attemptPayload, sampleSessionId: ids.sample }).success).toBe(true);
    expect(SampleAttemptSchema.safeParse({ ...attemptPayload, enrollmentId: ids.sample }).success).toBe(false);
    expect(AttemptSchema.safeParse({ ...attemptPayload, enrollmentId: ids.sample }).success).toBe(true);
    expect(AttemptSchema.safeParse({ ...attemptPayload, sampleSessionId: ids.sample }).success).toBe(false);
  });

  it("allows no XP for samples or unresolved evaluations", () => {
    expect(SampleEvaluationSchema.safeParse(evaluation).success).toBe(true);
    expect(SampleEvaluationSchema.safeParse({ ...evaluation, awardedXp: 10 }).success).toBe(false);
    expect(EvaluationSchema.safeParse({ ...evaluation, status: "uncertain", outcome: null, awardedXp: 0 }).success).toBe(true);
    expect(EvaluationSchema.safeParse({ ...evaluation, status: "uncertain", awardedXp: 10 }).success).toBe(false);
    expect(EvaluationSchema.safeParse({ ...evaluation, status: "evaluated", outcome: null }).success).toBe(false);
  });

  it("does not let an unfinished run claim a completed course", () => {
    const run = {
      id: ids.request, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation,
      branchId: ids.missing, inputMessageId: ids.attempt, sourceDraftRevision: null,
      approvalId: null, phase: "briefing", status: "queued", lastSeq: 0,
      outputVersionId: null, error: null, createdAt: timestamp, updatedAt: timestamp,
    };
    expect(GenerationRunSchema.safeParse(run).success).toBe(true);
    expect(GenerationRunSchema.safeParse({ ...run, outputVersionId: ids.course }).success).toBe(false);
    expect(GenerationRunSchema.safeParse({ ...run, status: "succeeded" }).success).toBe(false);
    expect(GenerationRunSchema.safeParse({ ...run, status: "failed" }).success).toBe(false);
  });

  it("uses English UI independently from valid course language tags", () => {
    expect(UiLocaleSchema.safeParse("en").success).toBe(true);
    expect(UiLocaleSchema.safeParse("ru").success).toBe(false);
    expect(ContentLanguageSchema.safeParse("ru").success).toBe(true);
    expect(ContentLanguageSchema.safeParse("zh-Hans").success).toBe(true);
    expect(ContentLanguageSchema.safeParse("not a language").success).toBe(false);
  });
});
