"use client";
import { useEffect, useState } from "react";
import type { ApplicationPort } from "@/application/ports";
import { localApplication } from "@/application/local-adapter";
import { AppShell } from "@/components/shell";
import { Button, LinkButton, Notice } from "@/components/ui";
import { routes } from "@/lib/routes";
import { CourseArtwork } from "./CourseArtwork";
import { languageName, studyTime } from "./query";
import { loadCourseDetail, type CourseDetailResult } from "./course-detail";
import "./catalog.css";

type DetailState = { kind: "loading" } | CourseDetailResult;
export function CourseDetailPage({ slug, services = localApplication }: { slug: string; services?: ApplicationPort }) {
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const result = await loadCourseDetail(services, slug, request.signal);
        if (request.signal.aborted) return;
        setState(result);
      } catch { if (!request.signal.aborted) setState({ kind: "error" }); }
    })();
    return () => request.abort();
  }, [slug, services, retry]);
  const course = state.kind === "ready" ? state.course : null;
  return <AppShell active="explore"><div className="uf-collection uf-course-detail">
    <LinkButton variant="quiet" href={routes.explore}>Back to courses</LinkButton>
    {state.kind === "loading" && <div className="uf-collection-loading" role="status"><span className="uf-collection-loading__book" aria-hidden="true" /><p>Opening course</p></div>}
    {state.kind === "unavailable" && <div className="uf-collection-empty uf-collection-empty--search"><h1>This course isn’t available</h1><p>The link may have changed, or access to the course may have been removed.</p><LinkButton href={routes.explore}>Explore courses</LinkButton></div>}
    {state.kind === "error" && <Notice tone="error" title="The course could not be opened" action={<Button variant="secondary" onClick={() => { setState({ kind: "loading" }); setRetry((value) => value + 1); }}>Try again</Button>}>Please try again. You can also return to explore other courses.</Notice>}
    {course && <>
      <header className="uf-course-detail__hero"><div className="uf-course-detail__intro"><h1>{course.title}</h1><p>{course.summary}</p><dl className="uf-course-detail__facts"><div><dt>Course language</dt><dd>{languageName(course.contentLanguage)}</dd></div><div><dt>Study time</dt><dd>{studyTime(course.estimatedStudyMinutes)}</dd></div><div><dt>Course content</dt><dd>{course.moduleCount} modules, {course.lessonCount} lessons</dd></div></dl></div><CourseArtwork large motifId={course.cover.motifId} alt={course.cover.alt} /></header>
      <div className="uf-course-detail__body"><div>
        <section className="uf-course-detail__outcomes"><h2>What you’ll be able to do</h2>{course.outcomes.length ? <ul>{course.outcomes.map((outcome) => <li key={outcome.id}><h3>{outcome.title}</h3><p>{outcome.demonstration}</p>{outcome.requirement === "specialization" && <span className="uf-course-detail__specialization">Specialization</span>}</li>)}</ul> : <p>Learning outcomes are not available for this course.</p>}</section>
        <section className="uf-course-detail__program"><h2>The course at a glance</h2>{course.modules.length ? <ol>{course.modules.map((module, index) => <li key={module.id}><details><summary><span className="uf-course-detail__module-number">{String(index + 1).padStart(2, "0")}</span><span>{module.title}</span><span className="uf-course-detail__module-time">{studyTime(module.estimatedStudyMinutes)}</span></summary><div><p>{module.summary}</p>{module.outcomeIds.length > 0 && <ul>{module.outcomeIds.map((id) => course.outcomes.find((outcome) => outcome.id === id)).filter((outcome) => outcome !== undefined).map((outcome) => <li key={outcome.id}>{outcome.title}</li>)}</ul>}</div></details></li>)}</ol> : <p>The course outline is not available.</p>}</section>
      </div><aside className="uf-course-detail__prerequisites"><h2>Before you begin</h2>{course.assumedKnowledge.length ? <ul>{course.assumedKnowledge.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>This course does not list any prior knowledge requirements.</p>}<div className="uf-course-detail__access"><h3>Course access</h3><p>{course.visibility === "public" ? "This course outline is public." : course.visibility === "unlisted" ? "This course outline is available through its link." : "You are viewing the course outline available to you."} Joining this course is unavailable right now.</p><LinkButton href={routes.try} variant="secondary">Try an activity</LinkButton></div></aside></div>
    </>}
  </div></AppShell>;
}
