import { describe, expect, it, vi } from "vitest";
import { createHttpCurriculum } from "../../src/application/http-curriculum";
import type { CourseArtifactRef } from "../../src/domain/chat";
import type {
  CourseLanguageRequestResult,
  CurriculumApprovalResult,
  CurriculumAuthoringSnapshot,
  CurriculumEvidencePublic,
  CurriculumMutationResult,
} from "../../src/domain/curriculum-authoring";
import type { AgentTurnRun, GenerationRun } from "../../src/domain/generation";
import { curriculumDigest } from "../../src/domain/course";
import { curriculum, ids, timestamp } from "../domain/fixtures";

const key = "40000000-0000-4000-8000-000000000001";
const generationRunId = "40000000-0000-4000-8000-000000000002";
const languageRunId = "40000000-0000-4000-8000-000000000003";
const branchId = "40000000-0000-4000-8000-000000000004";
const messageId = "40000000-0000-4000-8000-000000000005";

function artifact(): CourseArtifactRef {
  const draft = curriculum();
  return {
    courseId: draft.courseId,
    title: draft.title,
    summary: draft.goal,
    contentLanguage: draft.contentLanguage,
    revision: 1,
    curriculum: draft,
    approval: null,
    approvalRequestedRevision: draft.revision,
    readyVersionId: null,
    updatedAt: timestamp,
  };
}

function evidence(): CurriculumEvidencePublic {
  const draft = curriculum();
  return {
    status: "verified",
    rationale: "The sequence is grounded in the cited source and keeps practice close to each outcome.",
    sources: [{ sourceId: ids.source, title: "Generalization and model capacity", url: "https://example.edu/generalization",
      retrievedAt: timestamp, publishedAt: null, extractionState: "complete" }],
    outcomes: draft.outcomes.map((outcome) => ({ outcomeId: outcome.id, rationale: "The source supports this outcome.",
      sourceIds: [ids.source], support: "direct" })),
    estimates: draft.modules.map((module) => ({ moduleId: module.id, minMinutes: 20, maxMinutes: 80,
      assumptions: ["Includes reading, practice and reflection."] })),
    limitations: [],
    answers: [],
  };
}

async function mutation(): Promise<CurriculumMutationResult> {
  const draft = curriculum();
  return { draft, contentDigest: await curriculumDigest(draft), artifact: artifact() };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("curriculum HTTP consumer", () => {
  it("reads the strict authoritative authoring snapshot without caching", async () => {
    const data: CurriculumAuthoringSnapshot = { ...await mutation(), evidence: evidence(), generationRun: null, languageRun: null };
    const fetcher = vi.fn(async () => response({ data }));
    const result = await createHttpCurriculum(fetcher).getCurriculum(ids.draft);
    expect(result).toEqual({ ok: true, data });
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/curricula/${ids.draft}`, expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store",
    }));
  });

  it("restores independent build and language-run identities from the canonical snapshot", async () => {
    const draft = curriculum();
    const contentDigest = await curriculumDigest(draft);
    const approval = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest, approvedBy: ids.actor, approvedAt: timestamp };
    const generationRun: GenerationRun = { id: generationRunId, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation,
      branchId, inputMessageId: messageId, sourceDraftRevision: 1, approvalId: ids.approval,
      phase: "module_research", status: "running", lastSeq: 3, outputVersionId: null, error: null, createdAt: timestamp, updatedAt: timestamp };
    const languageRun: AgentTurnRun = { id: languageRunId, ownerId: ids.actor, conversationId: ids.conversation,
      branchId, inputMessageId: messageId, status: "running", lastSeq: 2, error: null, createdAt: timestamp, updatedAt: timestamp };
    const data: CurriculumAuthoringSnapshot = { draft, contentDigest, artifact: { ...artifact(), approval, approvalRequestedRevision: null },
      evidence: evidence(), generationRun, languageRun };
    const result = await createHttpCurriculum(async () => response({ data })).getCurriculum(ids.draft);
    expect(result).toMatchObject({ ok: true, data: {
      generationRun: { id: generationRunId, lastSeq: 3 },
      languageRun: { id: languageRunId, lastSeq: 2 },
    } });
  });

  it("sends a bounded typed curriculum patch with the caller's stable key", async () => {
    const data = await mutation();
    const fetcher = vi.fn(async () => response({ data }));
    const input = { expectedRevision: 1, changes: [{ op: "set_details" as const, audience: "Engineers new to model evaluation." }] };
    const result = await createHttpCurriculum(fetcher).patchCurriculum(ids.draft, input, { idempotencyKey: key });
    expect(result).toEqual({ ok: true, data });
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/curricula/${ids.draft}`, expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify(input),
      headers: expect.objectContaining({ "Idempotency-Key": key, "X-Request-Id": key }),
    }));
  });

  it("keeps approval separate and accepts only the matching build identity", async () => {
    const draft = curriculum();
    const contentDigest = await curriculumDigest(draft);
    const approval = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest, approvedBy: ids.actor, approvedAt: timestamp };
    const run: GenerationRun = { id: generationRunId, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation,
      branchId, inputMessageId: messageId, sourceDraftRevision: 1, approvalId: ids.approval,
      phase: "module_research", status: "queued", lastSeq: 0, outputVersionId: null, error: null, createdAt: timestamp, updatedAt: timestamp };
    const data: CurriculumApprovalResult = { approval, run, artifact: { ...artifact(), approval, approvalRequestedRevision: null } };
    const fetcher = vi.fn(async () => response({ data }));
    const input = { expectedRevision: 1, contentDigest };
    const result = await createHttpCurriculum(fetcher).approveCurriculum(ids.draft, input, { idempotencyKey: key });
    expect(result).toEqual({ ok: true, data });
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/curricula/${ids.draft}/approve`, expect.objectContaining({ method: "POST", body: JSON.stringify(input) }));
  });

  it("keeps metadata and asynchronous language revision as different operations", async () => {
    const updated = { ...artifact(), title: "A clearer title", summary: "A clearer description", revision: 2,
      curriculum: { ...curriculum(), title: "A clearer title", revision: 2 } };
    const languageRun: AgentTurnRun = { id: languageRunId, ownerId: ids.actor, conversationId: ids.conversation,
      branchId, inputMessageId: messageId, status: "queued", lastSeq: 0, error: null,
      createdAt: timestamp, updatedAt: timestamp };
    const language: CourseLanguageRequestResult = { run: languageRun, artifact: updated };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: updated }))
      .mockResolvedValueOnce(response({ data: language }));
    const port = createHttpCurriculum(fetcher);
    const metadataInput = { expectedRevision: 1, title: updated.title, summary: updated.summary };
    expect(await port.editCourseMetadata(ids.course, metadataInput, { idempotencyKey: key })).toEqual({ ok: true, data: updated });
    const languageInput = { expectedRevision: 2, expectedDraftRevision: 2, contentLanguage: "ja" };
    expect(await port.requestCourseLanguage(ids.course, languageInput, { idempotencyKey: key })).toEqual({ ok: true, data: language });
    expect(fetcher.mock.calls.map(([path, init]) => [path, init.method, init.body])).toEqual([
      [`/api/v1/courses/${ids.course}/metadata`, "PATCH", JSON.stringify(metadataInput)],
      [`/api/v1/courses/${ids.course}/language-revisions`, "POST", JSON.stringify(languageInput)],
    ]);
  });

  it("preserves a canonical 409 signal for an explicit reload and never guesses the new draft", async () => {
    const error = { error: { code: "revision_conflict", messageKey: "curriculum.changed", retryable: false, requestId: key }, currentRevision: 2 };
    const fetcher = vi.fn(async () => response(error, 409));
    const result = await createHttpCurriculum(fetcher).patchCurriculum(ids.draft,
      { expectedRevision: 1, changes: [{ op: "set_details", goal: "My unsaved local goal" }] }, { idempotencyKey: key });
    expect(result).toEqual({ ok: false, error });
  });

  it("rejects invalid input and mismatched acknowledgements before they reach creator state", async () => {
    const fetcher = vi.fn(async () => response({ data: { ...await mutation(), draft: { ...curriculum(), id: ids.missing } } }));
    const port = createHttpCurriculum(fetcher);
    expect((await port.getCurriculum("not-a-uuid")).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await port.patchCurriculum(ids.draft,
      { expectedRevision: 1, changes: [{ op: "set_details", goal: "Still mine" }] }, { idempotencyKey: key });
    expect(result).toMatchObject({ ok: false, error: { error: { code: "service_unavailable" } } });
  });
});
