// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPort } from "../../src/application/catalog-port";
import type { AccessibleCourseDetail } from "../../src/domain/course";
import { ConversationBuild, type BuildInteraction } from "../../src/features/creator/ConversationBuild";
import { Conversation } from "../../src/features/creator/Conversation";
import { buildTimeline, type BuildTimelineItem } from "../../src/features/creator/build-timeline";
import { createGenerationStreamState } from "../../src/features/creator/generation-stream";
import type { ConversationBuildView } from "../../src/features/creator/conversation-builds";
import { accountScope } from "../../src/features/account/account-scope";
import { curriculum, ids, timestamp } from "../domain/fixtures";

function readyBuild(): ConversationBuildView {
  const run = { id: ids.request, ownerId: ids.actor, courseId: ids.course, conversationId: ids.conversation, branchId: ids.sample,
    inputMessageId: ids.task, sourceDraftRevision: 1, approvalId: ids.approval, phase: "validating" as const, status: "succeeded" as const,
    lastSeq: 4, outputVersionId: ids.question, error: null, createdAt: timestamp, updatedAt: timestamp };
  return { approvalId: ids.approval, draftId: ids.draft, draftRevision: 1, approvalDigest: "a".repeat(64), approvedAt: timestamp,
    courseId: ids.course, branchId: ids.sample, title: "From foundations to AI systems", summary: "Build models and evaluate working AI systems.",
    contentLanguage: "en", initialRunId: ids.request, runs: [{ retryOfRunId: null,
      stream: createGenerationStreamState({ run, approvedDraftRevision: 1, approvalDigest: "a".repeat(64), modules: [], work: { completed: 20, total: 20 },
        validation: null, readyVersionId: ids.question, lastSeq: 4 }),
      events: [], beforeSeq: null, historyLoaded: false, historyPending: false, historyError: false, connectionError: false,
      commandPending: false, commandError: false, readyCourse: { courseId: ids.course, courseVersionId: ids.question, title: "From foundations to AI systems",
        summary: "Build models and evaluate working AI systems.", contentLanguage: "en", moduleCount: 20, lessonCount: 60 } }] };
}
function course(version = ids.question as string): AccessibleCourseDetail {
  const draft = curriculum();
  return { course: { id: ids.course, slug: "learning-ai", title: draft.title, summary: draft.goal, contentLanguage: "en", visibility: "private",
    moduleCount: 20, lessonCount: 60, estimatedStudyMinutes: 3000, cover: { motifId: "book", alt: "Course" },
    assumedKnowledge: draft.assumedKnowledge, outcomes: draft.outcomes, modules: draft.modules }, version: { id: version, number: 1 }, access: "owner", enrollmentId: null };
}
const interaction: BuildInteraction = { actorId: ids.actor, onCommand: vi.fn(), onEarlier: vi.fn(), onViewProgram: vi.fn() };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); accountScope.replaceActor(ids.actor); });
afterEach(() => { accountScope.replaceActor(null); vi.unstubAllGlobals(); });

describe("course build chat presentation", () => {
  it("shows honest loading only while no build projection is available", () => {
    const render = (builds: ConversationBuildView[], loading: boolean) => renderToStaticMarkup(<Conversation messages={[]} pending={false}
      transmittingId={null} onRetry={vi.fn()} onEdit={vi.fn()} builds={builds} buildsLoading={loading} buildInteraction={interaction} />);
    expect(render([], true)).toContain("Loading course activity…");
    expect(render([], false)).not.toContain("Loading course activity…");
    const hydrated = render([readyBuild()], true);
    expect(hydrated).toContain("Plan approved"); expect(hydrated).not.toContain("Loading course activity…");
  });
  it("shows user-side approval and the genuine model paragraph without internal identities", () => {
    const build = readyBuild();
    build.runs[0]!.events = [{ id: ids.attempt, runId: ids.request, courseId: ids.course, branchId: ids.sample,
      type: "generation.commentary", stepId: ids.source, seq: 2, at: timestamp, text: "The examples connect **matrix operations** to model inputs." }];
    const html = buildTimeline([build]).map(item => renderToStaticMarkup(<ConversationBuild item={item} interaction={interaction} />)).join("");
    expect(html).toContain("creator-message--user creator-plan-approved"); expect(html).toContain("Plan approved");
    expect(html).toContain("<strong>matrix operations</strong>"); expect(html).not.toContain(ids.approval); expect(html).not.toContain(ids.source);
  });
  it("shows actual search facts and marks unavailable sources without claiming successful reads", () => {
    const build = readyBuild(), run = build.runs[0]!;
    const item: BuildTimelineItem = { id: "action-view", at: timestamp, build, run, kind: "build_actions", actions: [{
      id: ids.source, stage: "reading_sources", action: "read_source", at: timestamp, completed: true, result: { outcome: "unavailable" },
      details: { source: { title: "NumPy documentation", url: "https://numpy.org/doc/" }, query: "NumPy matrix operations" },
    }] };
    const html = renderToStaticMarkup(<ConversationBuild item={item} interaction={interaction} />);
    expect(html).toContain("Source unavailable"); expect(html).toContain('href="https://numpy.org/doc/"');
    expect(html).toContain("NumPy matrix operations"); expect(html).not.toContain("Source read");
  });
  it("lets a newer waiting snapshot stop old action animation, while a new started event resumes it", () => {
    const build = readyBuild(), run = build.runs[0]!;
    run.stream.run.status = "running"; run.stream.pending = true; run.stream.run.outputVersionId = null; run.stream.readyVersionId = null;
    run.stream.progress = { stage: "reading_sources", activity: "waiting", moduleId: ids.moduleA, updatedAt: "2026-10-24T12:00:10.000Z" };
    run.events = [{ id: ids.attempt, runId: ids.request, courseId: ids.course, branchId: ids.sample, at: timestamp, seq: 2,
      type: "generation.action.started", invocationId: ids.source, stage: "reading_sources", action: "read_source", moduleId: ids.moduleA,
      details: { source: { title: "NumPy documentation", url: "https://numpy.org/doc/" } } }];
    const html = () => buildTimeline([build]).map(item => renderToStaticMarkup(<ConversationBuild item={item} interaction={interaction} />)).join("");
    expect(html()).not.toContain('class="creator-responding"'); expect(html()).toContain("Preparing the next step");
    expect(html()).not.toContain("In progress");
    expect(html()).not.toContain("Read NumPy"); expect(html()).toContain("Source reading: NumPy documentation");
    run.events[0]!.at = "2026-10-24T12:00:11.000Z";
    expect(html()).toContain('class="creator-responding"'); expect(html()).toContain("In progress");
    expect(html()).not.toContain("Preparing the next step");
  });
  it("enables learning only for the exact ready version and keeps one enrollment key across failed retries", async () => {
    const build = readyBuild(), item = buildTimeline([build]).find(item => item.kind === "build_ready")!;
    const getCourse = vi.fn<CatalogPort["getCourse"]>().mockResolvedValueOnce({ ok: true, data: { kind: "ready", detail: course(ids.missing) } })
      .mockResolvedValue({ ok: true, data: { kind: "ready", detail: course() } });
    const createEnrollment = vi.fn<CatalogPort["createEnrollment"]>().mockRejectedValue(new Error("unavailable"));
    const catalog = { getCourse, createEnrollment } as unknown as CatalogPort;
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<ConversationBuild item={item} interaction={{ ...interaction, catalog }} />));
      expect(container.textContent).toContain("its link couldn’t be loaded"); expect(container.textContent).not.toContain("Start learning");
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Try again")!.click());
      expect(container.querySelector('a[href="/courses/learning-ai"]')).not.toBeNull();
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Start learning")!.click());
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Start learning")!.click());
      expect(createEnrollment).toHaveBeenCalledTimes(2);
      expect(createEnrollment.mock.calls[0]![1]).toEqual({ courseVersionId: ids.question });
      expect(createEnrollment.mock.calls[0]![2]).toBe(createEnrollment.mock.calls[1]![2]);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
