import { BookOpen } from "lucide-react";
import type { CourseQuery, LibraryItem } from "@/application/ports";
import { Button, LinkButton, Notice } from "@/components/ui";
import { routes } from "@/lib/routes";
import { CourseArtwork } from "@/features/catalog/CourseArtwork";
import { CourseCard } from "@/features/catalog/CourseCard";
import { EmptyShelfArtwork } from "@/features/catalog/EmptyShelfArtwork";
import { languageName, studyTime, type LibraryView } from "@/features/catalog/query";
import { selectLibraryItems, type LibraryState } from "./library-controller";

type EnrolledCourse = Extract<LibraryItem, { kind: "enrolled" }>;
function LearningCourse({ item }: { item: EnrolledCourse }) {
  const { course } = item;
  return <article className="uf-learning-course">
    <div className="uf-learning-course__art"><CourseArtwork motifId={course.cover.motifId} alt={course.cover.alt} /></div>
    <div className="uf-learning-course__body"><h3>{course.title}</h3><p>{course.summary}</p>
      <dl className="uf-learning-course__facts"><div><dt>Course language</dt><dd>{languageName(course.contentLanguage)}</dd></div><div><dt>Study time</dt><dd>{studyTime(course.estimatedStudyMinutes)}</dd></div></dl>
      <div className="uf-learning-course__action"><LinkButton href={routes.learn(item.enrollmentId)}><BookOpen size={20} aria-hidden="true" />{item.lastStudiedAt ? "Continue course" : "Start course"}</LinkButton>
        {item.lastStudiedAt && <p>Last opened <time dateTime={item.lastStudiedAt}>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.lastStudiedAt))}</time></p>}
      </div>
    </div>
  </article>;
}

export function LibraryCollection({ state, query, view, onRetry, onReset }: { state: LibraryState; query: CourseQuery; view: LibraryView; onRetry: () => void; onReset: () => void }) {
  const records = selectLibraryItems(state.items, query, view);
  const started = records.filter((item): item is EnrolledCourse => item.kind === "enrolled" && item.lastStudiedAt !== null).sort((a, b) => (b.lastStudiedAt ?? "").localeCompare(a.lastStudiedAt ?? ""));
  const unstarted = records.filter((item): item is EnrolledCourse => item.kind === "enrolled" && item.lastStudiedAt === null);
  const owned = records.filter((item) => item.kind === "owned");
  const hasFilters = Boolean(query.q || query.contentLanguage);
  const loading = (state.status === "idle" || state.status === "loading") && state.items.length === 0;
  const unavailable = state.status === "unavailable";
  const failed = state.status === "error";
  const empty = (state.status === "ready" || (failed && state.items.length > 0)) && records.length === 0;

  return <div className="uf-library-collection" aria-busy={state.refreshing}>
    {loading && <div className="uf-collection-loading" role="status"><span className="uf-collection-loading__book" aria-hidden="true" /><p>Opening your library</p></div>}
    {(unavailable || (failed && state.items.length === 0)) && <section className="uf-library-rest">
      <div className="uf-library-rest__copy"><h2>{unavailable ? "Your library is unavailable" : "Your courses couldn’t be loaded"}</h2>
        <p>{unavailable ? "Try again to access the courses you create or join." : "Please try again. You can also explore public courses."}</p>
        <div className="uf-library-rest__actions"><Button variant="secondary" pending={state.refreshing} onClick={onRetry}>Try again</Button><LinkButton variant="quiet" href={routes.explore}>Explore courses</LinkButton></div>
      </div><EmptyShelfArtwork />
    </section>}
    {failed && state.items.length > 0 && <Notice tone="error" title="Your library could not be refreshed" action={<Button variant="secondary" pending={state.refreshing} onClick={onRetry}>Try again</Button>}>Previously loaded courses remain available.</Notice>}
    {empty && (hasFilters ? <section className="uf-library-no-match"><h2>No courses match your search</h2><p>Try a different subject or reset the course language filter.</p><Button variant="secondary" onClick={onReset}>Reset filters</Button></section> : <section className="uf-library-rest">
      <div className="uf-library-rest__copy"><h2>{view === "in_progress" ? "No courses in progress yet" : view === "courses" ? "You haven’t created a course yet" : "No courses in your library yet"}</h2>
        <p>{view === "courses" ? "Start a conversation about what you want to learn. Your courses will appear here when they’re created." : "Create a course, or explore public courses to find your next subject."}</p>
        <LinkButton variant="secondary" href={routes.explore}>Explore courses</LinkButton>
      </div><EmptyShelfArtwork />
    </section>)}
    {started.length > 0 && <section className="uf-library-course-group" aria-labelledby="continue-learning-heading"><h2 id="continue-learning-heading">Continue learning</h2><div className="uf-learning-courses">{started.map((item) => <LearningCourse key={item.enrollmentId} item={item} />)}</div></section>}
    {unstarted.length > 0 && <section className="uf-library-course-group" aria-labelledby="ready-to-start-heading"><h2 id="ready-to-start-heading">Ready to start</h2><div className="uf-learning-courses">{unstarted.map((item) => <LearningCourse key={item.enrollmentId} item={item} />)}</div></section>}
    {owned.length > 0 && <section className="uf-library-course-group" aria-labelledby="created-courses-heading"><h2 id="created-courses-heading">Created by you</h2><div className="uf-course-list">{owned.map((item) => <CourseCard key={item.course.id} course={item.course} headingLevel={3} />)}</div></section>}
  </div>;
}
