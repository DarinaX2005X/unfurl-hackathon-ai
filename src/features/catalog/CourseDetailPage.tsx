"use client";
import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { CatalogPort } from "@/application/catalog-port";
import { httpCatalog } from "@/application/http-catalog";
import { AppShell } from "@/components/shell";
import { Button, LinkButton, Notice } from "@/components/ui";
import { routes } from "@/lib/routes";
import { ShareCourseDialog } from "@/features/sharing/ShareCourseDialog";
import { useAccountEpoch, useAccountSession } from "@/features/account/account-session";
import { CourseArtwork } from "./CourseArtwork";
import { languageName, studyTime } from "./query";
import { courseDetailAuthorityKey, CourseDetailRequest, type CourseDetailLoadResult } from "./course-detail";
import { startCoursePath } from "./paths";
import "./catalog.css";

type DetailState = { kind: "loading" } | CourseDetailLoadResult;
type Source = { slug: string; shareToken?: never } | { shareToken: string; slug?: never };
export function CourseDetailPage({ slug, shareToken, services = httpCatalog }: Source & { services?: CatalogPort }) {
  const account = useAccountSession();
  const accountEpoch = useAccountEpoch();
  const authorityKey = courseDetailAuthorityKey(accountEpoch, account.status, account.session?.identity.id ?? null);
  const detailKey = `${authorityKey}:${shareToken === undefined ? `slug:${slug}` : `share:${shareToken}`}`;
  return shareToken === undefined
    ? <CourseDetailContent key={detailKey} slug={slug} services={services} />
    : <CourseDetailContent key={detailKey} shareToken={shareToken} services={services} />;
}

function CourseDetailContent({ slug, shareToken, services }: Source & { services: CatalogPort }) {
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const source = shareToken === undefined ? { slug } : { shareToken };
    const request = new CourseDetailRequest(services, source, setState);
    void request.start();
    return request.dispose;
  }, [slug, shareToken, services, retry]);

  const ready = state.kind === "ready" ? state.detail : null;
  const course = ready?.course ?? null;
  const back = shareToken ? routes.home : routes.explore;
  return <AppShell active="explore"><div className="uf-collection uf-course-detail">
    <LinkButton variant="quiet" href={back}>{shareToken ? "Back to Unfurl" : "Back to courses"}</LinkButton>
    {state.kind === "loading" && <div className="uf-collection-loading" role="status"><span className="uf-collection-loading__book" aria-hidden="true" /><p>Opening course</p></div>}
    {state.kind === "unavailable" && <div className="uf-collection-empty uf-collection-empty--search"><h1>This course isn’t available</h1><p>The link may have changed, expired, or been revoked.</p><LinkButton href={routes.explore}>Explore courses</LinkButton></div>}
    {state.kind === "error" && <Notice tone="error" title="The course could not be opened" action={<Button variant="secondary" onClick={() => { setState({ kind: "loading" }); setRetry((value) => value + 1); }}>Try again</Button>}>Please try again. You can also return to explore other courses.</Notice>}
    {state.kind === "owned_unready" && <section className="uf-owned-unready"><div className="uf-owned-unready__paper" aria-hidden="true"><span /><span /></div><div><p className="uf-owned-unready__eyebrow">{state.course.latestVersion?.state === "failed" ? "Needs attention" : state.course.latestVersion?.state === "validating" ? "Checking course" : state.course.latestVersion?.state === "building" ? "Building" : "Draft"}</p>
      <h1>{state.course.title}</h1><p>{state.course.summary}</p><p className="uf-owned-unready__note">This course is visible only to you until a complete version is ready.</p>
      {state.course.conversationId && <LinkButton href={routes.chat(state.course.conversationId)}><MessageSquare size={18} aria-hidden="true" />View in chat</LinkButton>}</div></section>}
    {course && ready && <>
      <header className="uf-course-detail__hero"><div className="uf-course-detail__intro"><p className="uf-course-detail__version">Version {ready.version.number}</p><h1>{course.title}</h1><p>{course.summary}</p><dl className="uf-course-detail__facts"><div><dt>Course language</dt><dd>{languageName(course.contentLanguage)}</dd></div><div><dt>Study time</dt><dd>{studyTime(course.estimatedStudyMinutes)}</dd></div><div><dt>Course content</dt><dd>{course.moduleCount} modules, {course.lessonCount} lessons</dd></div></dl>
        <div className="uf-course-detail__primary-actions">{ready.enrollmentId ? <LinkButton href={routes.learn(ready.enrollmentId)}>Continue course</LinkButton>
          : <LinkButton href={startCoursePath(course.id, ready.version.id, shareToken)}>Start this course</LinkButton>}
          {ready.access === "owner" && <ShareCourseDialog services={services} courseId={course.id} courseVersionId={ready.version.id} courseVersionNumber={ready.version.number} />}</div>
      </div><CourseArtwork large motifId={course.cover.motifId} alt={course.cover.alt} /></header>
      <div className="uf-course-detail__body"><div>
        <section className="uf-course-detail__outcomes"><h2>What you’ll be able to do</h2>{course.outcomes.length ? <ul>{course.outcomes.map((outcome) => <li key={outcome.id}><h3>{outcome.title}</h3><p>{outcome.demonstration}</p>{outcome.requirement === "specialization" && <span className="uf-course-detail__specialization">Specialization</span>}</li>)}</ul> : <p>Learning outcomes are not available for this course.</p>}</section>
        <section className="uf-course-detail__program"><h2>The course at a glance</h2>{course.modules.length ? <ol>{course.modules.map((module, index) => <li key={module.id}><details><summary><span className="uf-course-detail__module-number">{String(index + 1).padStart(2, "0")}</span><span>{module.title}</span><span className="uf-course-detail__module-time">{studyTime(module.estimatedStudyMinutes)}</span></summary><div><p>{module.summary}</p>{module.outcomeIds.length > 0 && <ul>{module.outcomeIds.map((id) => course.outcomes.find((outcome) => outcome.id === id)).filter((outcome) => outcome !== undefined).map((outcome) => <li key={outcome.id}>{outcome.title}</li>)}</ul>}</div></details></li>)}</ol> : <p>The course outline is not available.</p>}</section>
      </div><aside className="uf-course-detail__prerequisites"><h2>Before you begin</h2>{course.assumedKnowledge.length ? <ul>{course.assumedKnowledge.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>This course does not list any prior knowledge requirements.</p>}<div className="uf-course-detail__access"><h3>Course access</h3><p>{ready.access === "share" ? "This exact course version is available through a private link." : ready.access === "enrolled" ? "This version is already in your library." : ready.access === "owner" ? "You own this course and can also take it as a learner." : "This course version is published for everyone."}</p></div></aside></div>
    </>}
  </div></AppShell>;
}
