// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurriculumPort } from "../../src/application/curriculum-port";
import type { CurriculumAuthoringSnapshot } from "../../src/domain/curriculum-authoring";
import type { GenerationSnapshot } from "../../src/domain/generation-observer";
import { accountScope } from "../../src/features/account/account-scope";
import { CourseArtifactsPanel } from "../../src/features/creator/CourseArtifactsPanel";
import { getGenerationSnapshot, readGenerationEvents, type GenerationEventHandlers } from "../../src/features/creator/generation-observer-client";
import { curriculum, ids, timestamp } from "../domain/fixtures";

vi.mock("../../src/features/creator/generation-observer-client", () => ({
  getGenerationSnapshot: vi.fn(), readGenerationEvents: vi.fn(), cancelGenerationRun: vi.fn(), retryGenerationRun: vi.fn(),
}));

function saved(revision: number): CurriculumAuthoringSnapshot {
  const draft = { ...curriculum(), revision };
  const approval = { id: crypto.randomUUID(), draftId: draft.id, draftRevision: revision,
    contentDigest: "a".repeat(64), approvedBy: ids.actor, approvedAt: timestamp };
  return { draft, contentDigest: approval.contentDigest, artifact: { courseId: ids.course, title: draft.title,
    summary: draft.goal, contentLanguage: "en", revision, curriculum: draft, approval,
    approvalRequestedRevision: revision, readyVersionId: null, updatedAt: timestamp },
  generationRun: { id: crypto.randomUUID(), ownerId: ids.actor, courseId: ids.course,
    conversationId: ids.conversation, branchId: ids.sample, inputMessageId: ids.task,
    sourceDraftRevision: revision, approvalId: approval.id, phase: "module_research", status: "running",
    lastSeq: 1, outputVersionId: null, error: null, createdAt: timestamp, updatedAt: timestamp },
  evidence: { status: "verified", rationale: "Research checked", sources: [], outcomes: [], estimates: [], limitations: [], answers: [] },
  languageRun: null, authoringRun: null };
}
function observed(value: CurriculumAuthoringSnapshot, phase: GenerationSnapshot["run"]["phase"] = "module_research"): GenerationSnapshot {
  return { run: { ...value.generationRun!, phase }, approvedDraftRevision: value.draft.revision,
    approvalDigest: value.contentDigest, modules: [], work: { completed: 0, total: null },
    validation: null, readyVersionId: null, lastSeq: 1 };
}
let root: Root;
let container: HTMLDivElement;
let current: CurriculumAuthoringSnapshot;
let port: CurriculumPort;
const streams = new Map<string, { signal: AbortSignal; handlers: GenerationEventHandlers }>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  accountScope.replaceActor(ids.actor);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  streams.clear(); vi.clearAllMocks();
  port = { getCurriculum: vi.fn(async () => ({ ok: true, data: current })) } as unknown as CurriculumPort;
  vi.mocked(readGenerationEvents).mockImplementation((id, _after, signal, handlers) => {
    streams.set(id, { signal, handlers });
    return new Promise(() => {});
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); accountScope.replaceActor(null); vi.unstubAllGlobals();
});
async function show(value: CurriculumAuthoringSnapshot) {
  current = value;
  await act(async () => root.render(<CourseArtifactsPanel actorId={ids.actor} artifacts={[current.artifact]}
    selectedCourseId={ids.course} onSelect={() => {}} getCurrentArtifact={() => current.artifact}
    onArtifactChange={async () => true} onApproval={async () => true} curriculumPort={port} />));
}

describe("mounted generation observer replacement", () => {
  it("keeps new progress when the old snapshot resolves after its observer was aborted", async () => {
    const old = saved(1); const next = saved(2);
    let finishOld!: (snapshot: GenerationSnapshot) => void;
    vi.mocked(getGenerationSnapshot).mockImplementation(async (id) => id === old.generationRun!.id
      ? new Promise((resolve) => { finishOld = resolve; }) : observed(next, "building_tasks"));
    await show(old); await show(next);
    expect(container.textContent).toContain("Building lessons and practice");
    expect(vi.mocked(getGenerationSnapshot).mock.calls[0]![1].aborted).toBe(true);
    await act(async () => finishOld(observed(old)));
    expect(container.textContent).toContain("Building lessons and practice");
  });

  it("ignores a late event from the replaced run without losing the new run's phase", async () => {
    const old = saved(1); const next = saved(2);
    vi.mocked(getGenerationSnapshot).mockImplementation(async (id) => observed(id === old.generationRun!.id ? old : next, "building_tasks"));
    await show(old); const oldStream = streams.get(old.generationRun!.id)!;
    await show(next); expect(oldStream.signal.aborted).toBe(true);
    await act(async () => oldStream.handlers.onEvent({ id: crypto.randomUUID(), runId: old.generationRun!.id,
      courseId: ids.course, branchId: ids.sample, seq: 2, at: timestamp, type: "generation.phase.changed", phase: "validating" }));
    expect(container.textContent).toContain("Building lessons and practice");
  });

  it("stops showing a failed old build as soon as the replacement snapshot is available", async () => {
    const old = saved(1); const next = saved(2);
    old.generationRun = { ...old.generationRun!, status: "failed", error: { code: "service_unavailable",
      messageKey: "generation.unavailable", retryable: true, requestId: ids.request } };
    vi.mocked(getGenerationSnapshot).mockImplementation(async (id) => id === old.generationRun!.id ? observed(old) : new Promise(() => {}));
    await show(old); expect(container.textContent).toContain("Your approved program is still saved");
    await show(next);
    expect(container.textContent).toContain("Researching each section");
    expect(container.textContent).not.toContain("Your approved program is still saved");
  });
});
