import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { approveDisplayedCurriculum, CurriculumPanel } from "../../src/features/creator/CurriculumPanel";
import { curriculum, ids, timestamp } from "../domain/fixtures";
import { curriculumDigest, type CurriculumApproval } from "../../src/domain/course";
import type { CurriculumEvidencePublic } from "../../src/domain/curriculum-authoring";
import type { GenerationRun } from "../../src/domain/generation";
import { createGenerationStreamState } from "../../src/features/creator/generation-stream";

describe("program review", () => {
  it("renders actual prerequisites, sequence, and the displayed revision for approval", () => {
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} awaitingApproval onApprove={vi.fn()} />);
    expect(html).toContain("Basic algebra");
    expect(html).toContain("After: What fitting tells us");
    expect(html).toContain("Approve version 1");
    expect(html).not.toContain("expectedAnswer");
  });
  it("hides an approval operation if no actual handler is supplied", () => {
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} awaitingApproval />);
    expect(html).not.toContain("Approve version");
  });
  it("shows source-grounded research and honest build state without invented progress", () => {
    const evidence: CurriculumEvidencePublic = {
      status: "verified", rationale: "The sequence is supported by the cited teaching guide.",
      sources: [{ sourceId: ids.source, title: "Evidence-based teaching guide", url: "https://example.com/guide", retrievedAt: timestamp, publishedAt: null, extractionState: "complete" }],
      outcomes: [{ outcomeId: ids.outcomeA, rationale: "Directly supported", sourceIds: [ids.source], support: "direct" }],
      estimates: [{ moduleId: ids.moduleA, minMinutes: 20, maxMinutes: 40, assumptions: ["A first-time learner"] }],
      limitations: [], answers: [],
    };
    const run: GenerationRun = {
      id: ids.request, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation,
      branchId: ids.sample, inputMessageId: ids.task, sourceDraftRevision: 1, approvalId: ids.approval,
      phase: "building_tasks", status: "running", lastSeq: 3, outputVersionId: null, error: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const generation = createGenerationStreamState({ run, approvedDraftRevision: 1, approvalDigest: "a".repeat(64),
      modules: [{ moduleId: ids.moduleA, title: "What fitting tells us", status: "complete", completedTasks: 4 }],
      work: { completed: 1, total: 1 }, validation: { checked: 4, passed: 3, failed: 1, categories: ["coverage"] },
      readyVersionId: null, lastSeq: 3 });
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} awaitingApproval onApprove={vi.fn()} evidence={evidence} generationRun={run} generation={generation} onCancelBuild={vi.fn()} onEdit={vi.fn()} />);
    expect(html).toContain("Sources verified");
    expect(html).toContain("Evidence-based teaching guide");
    expect(html).toContain("Building lessons and practice");
    expect(html).toContain("Edit program");
    expect(html).toContain("1 of 1 sections saved");
    expect(html).toContain("3 passed, 1 need attention");
    expect(html).toContain("Cancel build");
    expect(html).not.toMatch(/\d+%/);
  });
  it("does not submit approval for an older displayed revision", async () => {
    const approve = vi.fn();
    await expect(approveDisplayedCurriculum(curriculum(), () => ({ id: ids.draft, revision: 2 }), approve)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
  });
  it("checks the acknowledged digest and rejects a revision changed during approval", async () => {
    const draft = curriculum();
    let currentRevision = 1;
    const receipt: CurriculumApproval = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(draft), approvedBy: ids.actor, approvedAt: timestamp };
    const approve = vi.fn(async () => { currentRevision = 2; return receipt; });
    await expect(approveDisplayedCurriculum(draft, () => ({ id: ids.draft, revision: currentRevision }), approve)).rejects.toThrow("program changed");
    expect(approve).toHaveBeenCalledWith({ courseId: ids.course, draftId: ids.draft, revision: 1, contentDigest: receipt.contentDigest });
    await expect(approveDisplayedCurriculum(draft, () => ({ id: ids.draft, revision: 1 }), async () => ({ ...receipt, contentDigest: "0".repeat(64) }))).rejects.toThrow();
  });
  it("accepts only a current matching acknowledgement", async () => {
    const draft = curriculum();
    const receipt: CurriculumApproval = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(draft), approvedBy: ids.actor, approvedAt: timestamp };
    expect(await approveDisplayedCurriculum(draft, () => ({ id: ids.draft, revision: 1 }), async () => receipt)).toEqual(receipt);
  });
  it("offers a real retry only for a terminal failed build", () => {
    const failed: GenerationRun = { id: ids.request, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation,
      branchId: ids.sample, inputMessageId: ids.task, sourceDraftRevision: 1, approvalId: ids.approval,
      phase: "validating", status: "failed", lastSeq: 4, outputVersionId: null,
      error: { code: "generation_failed", messageKey: "generation.failed", retryable: true, requestId: ids.missing },
      createdAt: timestamp, updatedAt: timestamp };
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} generationRun={failed} onRetryBuild={vi.fn()} />);
    expect(html).toContain("Retry build");
    expect(html).toContain("approved program is still saved");
    expect(html).not.toContain("Cancel build");
  });
  it("keeps approval blocked while an accepted answer intent is being checked", () => {
    const run = { id: ids.request, ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample,
      inputMessageId: ids.task, status: "running" as const, lastSeq: 1, error: null, createdAt: timestamp, updatedAt: timestamp };
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} awaitingApproval onApprove={vi.fn()}
      authoringRun={run} onCancelAuthoring={vi.fn()} />);
    expect(html).toContain("exact edits are saved");
    expect(html).toContain("Cancel answer check");
    const approval = html.indexOf("Approve version");
    expect(html.slice(html.lastIndexOf("<button", approval), approval)).toContain("disabled");
  });

  it("offers intent retry after a failed answer check without dropping the editor recovery copy", () => {
    const run = { id: ids.request, ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample,
      inputMessageId: ids.task, status: "failed" as const, lastSeq: 2,
      error: { code: "generation_failed" as const, messageKey: "authoring.failed", retryable: true, requestId: ids.missing },
      createdAt: timestamp, updatedAt: timestamp };
    const html = renderToStaticMarkup(<CurriculumPanel draft={curriculum()} currentRevision={1} authoringRun={run} onRetryAuthoring={vi.fn()} />);
    expect(html).toContain("local changes are still available");
    expect(html).toContain("Retry answer check");
  });
});
