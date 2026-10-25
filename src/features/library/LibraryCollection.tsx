import { BookOpen, MessageSquare, RotateCcw } from "lucide-react";
import type { EnrolledCourseProjection, OwnedCourseProjection } from "@/domain/catalog";
import { Button, LinkButton, Notice } from "@/components/ui";
import { routes } from "@/lib/routes";
import { CourseArtwork } from "@/features/catalog/CourseArtwork";
import { EmptyShelfArtwork } from "@/features/catalog/EmptyShelfArtwork";
import { languageName, studyTime, type LibraryView } from "@/features/catalog/query";
import { startCoursePath } from "@/features/catalog/paths";
import type { LibraryState } from "./library-controller";

function LearningCourse({ item }: { item: EnrolledCourseProjection }) {
  const { course, enrollment } = item;
  const archived = enrollment.status === "archived";
  const action = archived ? startCoursePath(course.id, item.version.id) : routes.learn(enrollment.id);
  const label = archived ? "Return to course" : enrollment.status === "completed" ? "Review course" : enrollment.lastStudiedAt ? "Continue course" : "Start course";
  return <article className="uf-learning-course">
    <div className="uf-learning-course__art"><CourseArtwork motifId={course.cover.motifId} alt={course.cover.alt} /></div>
    <div className="uf-learning-course__body"><p className="uf-library-context">Enrolled · Version {item.version.number}</p><h3>{course.title}</h3><p>{course.summary}</p>
      <dl className="uf-learning-course__facts"><div><dt>Course language</dt><dd>{languageName(course.contentLanguage)}</dd></div><div><dt>Study time</dt><dd>{studyTime(course.estimatedStudyMinutes)}</dd></div></dl>
      <div className="uf-learning-course__action"><LinkButton href={action}>{archived ? <RotateCcw size={20} aria-hidden="true" /> : <BookOpen size={20} aria-hidden="true" />}{label}</LinkButton>
        {enrollment.lastStudiedAt && <p>Last opened <time dateTime={enrollment.lastStudiedAt}>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(enrollment.lastStudiedAt))}</time></p>}
      </div>
    </div>
  </article>;
}

function statusName(course: OwnedCourseProjection) {
  if (!course.latestVersion) return "Draft";
  return course.latestVersion.state === "ready" ? "Ready" : course.latestVersion.state === "building" ? "Building"
    : course.latestVersion.state === "validating" ? "Checking course" : "Needs attention";
}
function OwnedCourse({ course }: { course: OwnedCourseProjection }) {
  const action = course.conversationId ? routes.chat(course.conversationId) : course.latestVersion?.state === "ready" ? routes.course(course.slug) : null;
  return <article className="uf-owned-course">
    <div className={`uf-owned-course__art${course.cover ? "" : " uf-owned-course__art--draft"}`}>{course.cover
      ? <CourseArtwork motifId={course.cover.motifId} alt={course.cover.alt} />
      : <div className="uf-draft-book" role="img" aria-label="Course draft without cover"><span /><span /><i /></div>}</div>
    <div className="uf-owned-course__body"><p className="uf-library-context">Created by you · {statusName(course)}</p><h3>{course.title}</h3><p>{course.summary}</p>
      <div className="uf-owned-course__meta"><span>{languageName(course.contentLanguage)}</span><span>{course.visibility}</span>{course.latestVersion && <span>Version {course.latestVersion.number}</span>}</div>
      {action ? <LinkButton href={action}>{course.conversationId ? <MessageSquare size={19} aria-hidden="true" /> : <BookOpen size={19} aria-hidden="true" />}{course.conversationId ? "View in chat" : "View course"}</LinkButton>
        : <p className="uf-owned-course__note">This draft is not linked to an available chat yet.</p>}
    </div>
  </article>;
}

export function LibraryCollection({ state, view, filtered, onRetry, onResetFilters, onShowAll, onLoadMore }: {
  state: LibraryState; view: LibraryView; filtered: boolean; onRetry: () => void;
  onResetFilters: () => void; onShowAll: () => void; onLoadMore: () => void;
}) {
  const enrollments = state.items.flatMap((item) => item.enrollments);
  const active = enrollments.filter((item) => item.enrollment.status === "active");
  const started = active.filter((item) => item.enrollment.lastStudiedAt !== null);
  const unstarted = active.filter((item) => item.enrollment.lastStudiedAt === null);
  const completed = enrollments.filter((item) => item.enrollment.status === "completed");
  const archived = enrollments.filter((item) => item.enrollment.status === "archived");
  const owned = state.items.flatMap((item) => item.owned ? [item.owned] : []);
  const loading = (state.status === "idle" || state.status === "loading") && state.items.length === 0;
  const failed = state.status === "error";
  const empty = (state.status === "ready" || (failed && state.items.length > 0)) && state.items.length === 0;
  return <div className="uf-library-collection" aria-busy={state.refreshing || state.loadingMore}>
    {loading && <div className="uf-collection-loading" role="status"><span className="uf-collection-loading__book" aria-hidden="true" /><p>Opening your library</p></div>}
    {failed && state.items.length === 0 && <section className="uf-library-rest"><div className="uf-library-rest__copy"><h2>Your courses couldn’t be loaded</h2><p>Please try again. You can also explore public courses.</p><div className="uf-library-rest__actions"><Button variant="secondary" pending={state.refreshing} onClick={onRetry}>Try again</Button><LinkButton variant="quiet" href={routes.explore}>Explore courses</LinkButton></div></div><EmptyShelfArtwork /></section>}
    {failed && state.items.length > 0 && <Notice tone="error" title="Your library could not be refreshed" action={<Button variant="secondary" pending={state.refreshing} onClick={onRetry}>Try again</Button>}>Previously loaded courses remain available.</Notice>}
    {empty && <section className="uf-library-rest"><div className="uf-library-rest__copy"><h2>{filtered ? "No courses match your search" : view === "in_progress" ? "No courses in progress yet" : view === "courses" ? "You haven’t created a course yet" : "No courses in your library yet"}</h2>
      <p>{filtered ? "Try a different title, description, or course language." : view === "courses" ? "Start a conversation about what you want to learn. Your courses will appear here when they’re created." : "Create a course, or explore public courses to find your next subject."}</p>
      <div className="uf-library-rest__actions">{filtered ? <Button variant="quiet" onClick={onResetFilters}>Reset filters</Button> : view !== "all" ? <Button variant="quiet" onClick={onShowAll}>Show all courses</Button> : null}<LinkButton variant="secondary" href={routes.explore}>Explore courses</LinkButton></div></div><EmptyShelfArtwork /></section>}
    {started.length > 0 && <section className="uf-library-course-group" aria-labelledby="continue-learning-heading"><h2 id="continue-learning-heading">Continue learning</h2><div className="uf-learning-courses">{started.map((item) => <LearningCourse key={item.enrollment.id} item={item} />)}</div></section>}
    {unstarted.length > 0 && <section className="uf-library-course-group" aria-labelledby="ready-to-start-heading"><h2 id="ready-to-start-heading">Ready to start</h2><div className="uf-learning-courses">{unstarted.map((item) => <LearningCourse key={item.enrollment.id} item={item} />)}</div></section>}
    {completed.length > 0 && <section className="uf-library-course-group" aria-labelledby="completed-heading"><h2 id="completed-heading">Completed</h2><div className="uf-learning-courses">{completed.map((item) => <LearningCourse key={item.enrollment.id} item={item} />)}</div></section>}
    {archived.length > 0 && <section className="uf-library-course-group" aria-labelledby="archived-heading"><h2 id="archived-heading">Archived</h2><div className="uf-learning-courses">{archived.map((item) => <LearningCourse key={item.enrollment.id} item={item} />)}</div></section>}
    {owned.length > 0 && <section className="uf-library-course-group" aria-labelledby="created-courses-heading"><h2 id="created-courses-heading">Created by you</h2><div className="uf-owned-courses">{owned.map((course) => <OwnedCourse key={course.id} course={course} />)}</div></section>}
    {state.pageError && <Notice tone="error" title="Some courses could not be loaded" action={<Button variant="secondary" onClick={onLoadMore}>Retry loading more</Button>}>{state.pageError}</Notice>}
    {state.nextCursor && !state.pageError && <div className="uf-collection-more"><Button variant="secondary" pending={state.loadingMore} onClick={onLoadMore}>Load more courses</Button></div>}
  </div>;
}
