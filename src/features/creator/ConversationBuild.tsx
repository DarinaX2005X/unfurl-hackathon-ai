"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, ChevronRight, CircleAlert, RotateCcw } from "lucide-react";
import { Button, LinkButton, Notice } from "@/components/ui";
import type { CatalogPort } from "@/application/catalog-port";
import { httpCatalog } from "@/application/http-catalog";
import type { AccessibleCourseDetail } from "@/domain/course";
import type { GenerationAction, GenerationProgress, GenerationTimelineEvent } from "@/domain/generation-observer";
import type { BuildRunView } from "./conversation-builds";
import { accountScope } from "@/features/account/account-scope";
import { routes } from "@/lib/routes";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { CourseBuildProgress } from "./CourseBuildProgress";
import type { BuildTimelineItem } from "./build-timeline";
import { actionFactLines, sourceLink } from "./conversation-timeline";

export interface BuildInteraction {
  actorId: string;
  onCommand(approvalId: string, kind: "cancel" | "retry"): void;
  onEarlier(runId: string): void;
  onViewProgram(courseId: string): void;
  catalog?: CatalogPort;
  showCourseLabels?: boolean;
}
const actionLabels: Record<GenerationProgress["stage"], [string, string]> = {
  preparing: ["Preparing the next step", "Preparation finished"], researching: ["Researching the section", "Section research finished"],
  reading_sources: ["Reading sources", "Source reading finished"], planning_lessons: ["Planning lessons", "Lesson planning finished"],
  writing_lessons: ["Writing lessons", "Lesson writing finished"], creating_practice: ["Creating practice", "Practice preparation finished"],
  validating_practice: ["Checking practice", "Practice check finished"], reviewing_section: ["Reviewing the section", "Section review finished"],
  saving_section: ["Saving the section", "Section saved"], finalizing_course: ["Finishing the course", "Course saved"],
};
const specificActionLabels: Record<GenerationAction, [string, string]> = {
  research_plan: ["Planning the research", "Research plan prepared"], search: ["Searching the web", "Web search finished"],
  select_sources: ["Choosing useful sources", "Sources selected"], read_source: ["Reading a source", "Source read"],
  extract_claims: ["Checking source evidence", "Source evidence checked"], review_knowledge: ["Checking topic coverage", "Topic coverage checked"],
  synthesize_knowledge: ["Organizing the learning material", "Learning material organized"], plan_lessons: ["Planning the next lessons", "Lesson planning finished"],
  write_lessons: ["Writing the explanations", "Explanation writing finished"], create_practice: ["Preparing practice", "Practice preparation finished"],
  test_practice: ["Testing the practice", "Practice tests finished"], review_section: ["Reviewing the section", "Section review finished"], save_section: ["Saving the section", "Section saved"],
};
function actionIsActive(run: BuildRunView, event: GenerationTimelineEvent | undefined): boolean {
  if (!run.stream.pending || event?.type !== "generation.action.started") return false;
  const progress = run.stream.progress;
  if (!progress || event.at > progress.updatedAt) return true;
  return progress.activity === "running" && progress.stage === event.stage && progress.moduleId === event.moduleId;
}
export function ConversationBuild({ item, interaction }: { item: BuildTimelineItem; interaction: BuildInteraction }) {
  const { build, run } = item;
  const current = build.runs.at(-1)?.stream.run.id === run.stream.run.id;
  if (item.kind === "build_approval") return <article className="creator-message creator-message--user creator-plan-approved">
    <h2>You</h2><div className="creator-plan-approved__receipt"><span className="creator-plan-approved__check"><Check size={18} aria-hidden="true" /></span>
      <div><strong>Plan approved</strong><p>{build.title}</p><button type="button" onClick={() => interaction.onViewProgram(build.courseId)}>View program <span>· Version {build.draftRevision}</span></button></div></div>
  </article>;
  if (item.kind === "build_retry") return <p className="creator-build-retry"><RotateCcw size={14} aria-hidden="true" />Build restarted<span>{build.title}</span></p>;
  if (item.kind === "build_history") return <div className="creator-build-earlier"><Button variant="quiet" size="compact" pending={run.historyPending} disabled={run.beforeSeq === null} onClick={() => interaction.onEarlier(run.stream.run.id)}>Earlier build activity</Button>{run.historyError && <p role="status">Earlier activity couldn’t be loaded. Try again.</p>}</div>;
  if (item.kind === "build_commentary") return <article className="creator-message creator-message--assistant creator-build-commentary"><h2>Unfurl{interaction.showCourseLabels && <span>{build.title}</span>}</h2><div className="creator-message__text"><AssistantMarkdown text={item.text} /></div></article>;
  if (item.kind === "build_actions") {
    const active = current && run.stream.pending;
    const pendingAction = [...item.actions].reverse().find(action => !action.completed);
    const latestActionEvent = run.events.filter(event => event.type !== "generation.commentary").at(-1);
    const last = item.actions.at(-1)!;
    const working = active && pendingAction && actionIsActive(run, latestActionEvent) && latestActionEvent?.type === "generation.action.started" && latestActionEvent.invocationId === pendingAction.id;
    const needsAttention = item.actions.some(action => action.result?.outcome);
    const labelFor = (action: typeof last, complete: boolean) => action.result?.outcome === "unavailable" ? "Source unavailable"
      : action.result?.outcome === "needs_revision" ? "Revision needed" : (action.action ? specificActionLabels[action.action] : actionLabels[action.stage])[complete ? 1 : 0];
    const section = run.stream.modules.find(module => module.moduleId === (working ? pendingAction.moduleId : last.moduleId));
    const sourceTitle = item.actions.length === 1 && last.action === "read_source" && !last.result?.outcome ? last.details?.source?.title : undefined;
    const label = sourceTitle ? `${last.completed ? "Read" : working ? "Reading" : "Source reading:"} ${sourceTitle}` : working ? labelFor(pendingAction, false) : item.actions.length === 1 ? labelFor(last, last.completed) : section?.title ?? "Course preparation";
    const context = interaction.showCourseLabels ? build.title : section?.title !== label ? section?.title : undefined;
    return <details className={`creator-actions creator-build-actions${working ? " creator-actions--working" : ""}`}>
      <summary><span className="creator-actions__state" aria-hidden="true">{working ? <span className="creator-responding"><span /><span /><span /></span> : pendingAction || needsAttention ? <CircleAlert size={16} /> : <Check size={16} />}</span><span className="creator-actions__label">{label}{context && <small>{context}</small>}</span><ChevronRight className="creator-actions__chevron" size={16} aria-hidden="true" /><span className="creator-actions__hint">Details</span></summary>
      <ol>{item.actions.map(action => {
        const section = run.stream.modules.find(module => module.moduleId === action.moduleId);
        const facts = [[action.result?.sourceCount, "sources"], [action.result?.lessonCount, "lessons"], [action.result?.taskCount, "practice tasks"]] as const;
        const sources = [...(action.details?.source ? [action.details.source] : []), ...(action.details?.sources ?? [])];
        const detailFacts = actionFactLines(action.details ?? {});
        return <li key={action.id}><div className="creator-actions__heading"><strong>{labelFor(action, action.completed)}</strong><span>{action.result?.outcome === "unavailable" ? "Unavailable" : action.result?.outcome === "needs_revision" ? "Needs revision" : action.completed ? "Complete" : working && action.id === pendingAction.id ? "In progress" : "No completion recorded"}</span></div>
          {section && <p>{section.title}</p>}{action.details?.query && <p className="creator-actions__query">{action.details.query}</p>}
          {detailFacts.length > 0 ? <p>{detailFacts.join(" · ")}</p> : facts.some(([count]) => count !== undefined) && <p>{facts.flatMap(([count, label]) => count === undefined ? [] : [`${count} ${label}`]).join(" · ")}</p>}
          {sources.length > 0 && <ul className="creator-actions__sources">{sources.map((source, index) => { const url = sourceLink(source.url); return <li key={`${source.title}:${index}`}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}</a> : source.title}</li>; })}</ul>}</li>;
      })}</ol>
    </details>;
  }
  if (item.kind === "build_ready") return <ReadyCourse item={item} actorId={interaction.actorId} catalog={interaction.catalog ?? httpCatalog} />;
  if (item.kind === "build_status") {
    const activeAction = actionIsActive(run, run.events.filter(event => event.type !== "generation.commentary").at(-1));
    const action = current && (run.stream.pending || ["failed", "cancelled"].includes(run.stream.run.status)) ? <Button variant="quiet" size="compact" pending={run.commandPending} onClick={() => interaction.onCommand(build.approvalId, run.stream.pending ? "cancel" : "retry")}>{run.stream.pending ? "Cancel build" : "Retry build"}</Button> : undefined;
    return <div className="creator-build-update">
      {run.stream.pending && activeAction && !run.connectionError ? <div className="creator-build-update__continuing"><span>{run.stream.modules.filter(module => module.status === "complete").length} of {run.stream.modules.length} sections saved</span>{action}</div>
        : <>{interaction.showCourseLabels && <p className="creator-build-update__course">{build.title}</p>}<CourseBuildProgress run={run.stream.run} generation={run.stream} connectionError={run.connectionError} action={action} /></>}
      {run.commandError && <Notice tone="error">That action couldn’t be confirmed. Try again to check the same request.</Notice>}
    </div>;
  }
  return null;
}

function ReadyCourse({ item, actorId, catalog }: { item: BuildTimelineItem; actorId: string; catalog: CatalogPort }) {
  const { build, run } = item;
  const versionId = run.stream.readyVersionId;
  const [detail, setDetail] = useState<AccessibleCourseDetail | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);
  const enrollmentKey = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!versionId || run.stream.run.status !== "succeeded") return;
    const request = accountScope.request(actorId);
    let mounted = true;
    void catalog.getCourse(build.courseId, versionId, request.signal).then(result => {
      if (!mounted || !request.isCurrent()) return;
      if (!result.ok || result.data.kind !== "ready" || result.data.detail.course.id !== build.courseId || result.data.detail.version.id !== versionId) { setError(true); return; }
      setDetail(result.data.detail); setError(false);
    }).catch(() => { if (mounted && request.isCurrent()) setError(true); }).finally(request.release);
    return () => { mounted = false; request.abort(); };
  }, [actorId, catalog, build.courseId, versionId, run.stream.run.status, refresh]);
  async function start() {
    if (!detail || starting || detail.version.id !== versionId) return;
    const request = accountScope.request(actorId);
    enrollmentKey.current ??= crypto.randomUUID();
    setStarting(true); setStartError(false);
    try {
      const result = await catalog.createEnrollment(build.courseId, { courseVersionId: detail.version.id }, enrollmentKey.current, request.signal);
      if (!mounted.current || !request.isCurrent()) return;
      if (!result.ok) { setStartError(true); return; }
      window.location.assign(result.data.redirectTo);
    } catch { if (mounted.current && request.isCurrent()) setStartError(true); }
    finally { if (mounted.current && request.isCurrent()) setStarting(false); request.release(); }
  }
  const ready = run.readyCourse;
  return <article className="creator-course-result"><div className="creator-course-result__book" aria-hidden="true"><BookOpen size={30} strokeWidth={1.5} /><span /></div>
    <div className="creator-course-result__content"><p className="creator-course-result__status"><Check size={15} aria-hidden="true" />Your course is ready</p>
      <h2>{ready?.title ?? build.title}</h2><p className="creator-course-result__summary">{ready?.summary ?? build.summary}</p>
      {ready && <p className="creator-course-result__facts">{ready.moduleCount} sections<span>·</span>{ready.lessonCount} lessons</p>}
      {detail ? <div className="creator-course-result__actions"><Button pending={starting} onClick={() => void start()}>Start learning</Button><LinkButton variant="secondary" href={routes.course(detail.course.slug)}>View course</LinkButton></div>
        : error ? <div role="status"><p>The course is saved, but its link couldn’t be loaded.</p><Button variant="quiet" size="compact" onClick={() => { setError(false); setRefresh(value => value + 1); }}>Try again</Button></div> : <p role="status">Opening your saved course…</p>}
      {startError && <Notice tone="error">The course is ready, but starting it couldn’t be confirmed. Try again.</Notice>}
    </div>
  </article>;
}
