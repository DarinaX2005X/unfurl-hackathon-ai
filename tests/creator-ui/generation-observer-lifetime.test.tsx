// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurriculumPort } from "../../src/application/curriculum-port";
import type { CurriculumAuthoringSnapshot } from "../../src/domain/curriculum-authoring";
import type { GenerationSnapshot } from "../../src/domain/generation-observer";
import { accountScope } from "../../src/features/account/account-scope";
import { CourseArtifactsPanel } from "../../src/features/creator/CourseArtifactsPanel";
import { cancelGenerationRun, getGenerationSnapshot, readGenerationEvents, type GenerationEventHandlers } from "../../src/features/creator/generation-observer-client";
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
  await act(async () => root.unmount()); container.remove(); accountScope.replaceActor(null); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function show(value: CurriculumAuthoringSnapshot) {
  current = value;
  await act(async () => root.render(<CourseArtifactsPanel actorId={ids.actor} artifacts={[current.artifact]}
    selectedCourseId={ids.course} onSelect={() => {}} getCurrentArtifact={() => current.artifact}
    onArtifactChange={async () => true} onApproval={async () => true} curriculumPort={port} />));
}

describe("mounted generation observer replacement", () => {
  it("keeps a confirmed cancellation terminal when an earlier active refresh finishes afterward", async () => {
    vi.useFakeTimers(); const value = saved(1); const active = observed(value);
    let finishRefresh!: (snapshot: GenerationSnapshot) => void;
    vi.mocked(getGenerationSnapshot).mockResolvedValueOnce(active).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    vi.mocked(cancelGenerationRun).mockResolvedValue({ ...active, run: { ...active.run, status: "cancelled", lastSeq: 2 }, lastSeq: 2 });
    await show(value); await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel build")!.click(); });
    expect(container.textContent).toContain("Build cancelled");
    await act(async () => finishRefresh(active));
    expect(container.textContent).toContain("Build cancelled");
    expect(container.querySelector(".creator-build__activity")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(32000); });
    expect(getGenerationSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes a silent selected run without overlapping requests, then stops on completion", async () => {
    vi.useFakeTimers();
    const value = saved(1); value.generationRun = { ...value.generationRun!, status: "queued" };
    const initial = observed(value);
    let finishRefresh!: (snapshot: GenerationSnapshot) => void;
    vi.mocked(getGenerationSnapshot).mockResolvedValueOnce(initial).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    await show(value);
    expect(container.textContent).toContain("Preparing to build your course");
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(getGenerationSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(24000); });
    expect(getGenerationSnapshot).toHaveBeenCalledTimes(2);
    const active: GenerationSnapshot = { ...initial, run: { ...initial.run, status: "running" },
      modules: [{ moduleId: ids.moduleA, title: "Model fitting", status: "researching", completedTasks: 0 }],
      progress: { stage: "reading_sources", activity: "running", moduleId: ids.moduleA, completedSources: 2, updatedAt: timestamp } };
    await act(async () => finishRefresh(active));
    expect(container.textContent).toContain("Reading sources");
    expect(container.textContent).toContain("Section 1 of 1 · Model fitting");
    const indicator = container.querySelector(".creator-build__activity");
    vi.mocked(getGenerationSnapshot).mockResolvedValueOnce({ ...active, progress: { ...active.progress!, stage: "writing_lessons" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(container.textContent).toContain("Writing the lessons");
    expect(container.querySelector(".creator-build__activity")).toBe(indicator);
    vi.mocked(getGenerationSnapshot).mockResolvedValueOnce({ ...active, progress: undefined, run: { ...active.run, status: "cancelled", lastSeq: 2 }, lastSeq: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(container.textContent).toContain("Build cancelled");
    expect(container.querySelector(".creator-build__activity")).toBeNull();
    const calls = vi.mocked(getGenerationSnapshot).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(32000); });
    expect(getGenerationSnapshot).toHaveBeenCalledTimes(calls);
  });

  it("aborts an old refresh and ignores its delayed result after the selected run changes", async () => {
    vi.useFakeTimers();
    const old = saved(1); const next = saved(2);
    let finishOld!: (snapshot: GenerationSnapshot) => void;
    vi.mocked(getGenerationSnapshot).mockResolvedValueOnce(observed(old)).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue(observed(next, "building_tasks"));
    await show(old); await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    const oldSignal = vi.mocked(getGenerationSnapshot).mock.calls[1]![1];
    await show(next); expect(oldSignal.aborted).toBe(true);
    await act(async () => finishOld({ ...observed(old), progress: { stage: "reading_sources", activity: "running", updatedAt: timestamp } }));
    expect(container.textContent).toContain("Building lessons and practice");
    expect(container.textContent).not.toContain("Reading sources");
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(vi.mocked(getGenerationSnapshot).mock.calls.at(-1)![0]).toBe(next.generationRun!.id);
    expect(vi.mocked(getGenerationSnapshot).mock.calls.filter(([id]) => id === old.generationRun!.id)).toHaveLength(2);
  });

  it("shows a reconnecting state after a refresh fails and resumes the confirmed operation", async () => {
    vi.useFakeTimers(); const value = saved(1);
    const active = { ...observed(value), progress: { stage: "reading_sources" as const, activity: "running" as const, updatedAt: timestamp } };
    vi.mocked(getGenerationSnapshot).mockResolvedValueOnce(active).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(active);
    await show(value); await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(container.textContent).toContain("Reconnecting to build updates");
    expect(container.textContent).toContain("Last confirmed: Reading sources");
    expect(container.querySelector(".creator-build__activity")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(container.textContent).not.toContain("Reconnecting to build updates");
    expect(container.querySelector(".creator-build__activity")).not.toBeNull();
  });

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
