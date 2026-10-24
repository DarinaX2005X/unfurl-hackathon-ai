import Link from "next/link";
import type { CourseSummary } from "@/domain";
import { routes } from "@/lib/routes";
import { CourseArtwork } from "./CourseArtwork";
import { languageName, studyTime } from "./query";

export function CourseCard({ course, headingLevel = 2 }: { course: CourseSummary; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return <article className="uf-course-card">
    <Link className="uf-course-card__link" href={routes.course(course.slug)}>
      <CourseArtwork motifId={course.cover.motifId} alt={course.cover.alt} />
      <div className="uf-course-card__body"><Heading>{course.title}</Heading><p>{course.summary}</p>
        <dl className="uf-course-card__facts"><div><dt>Modules</dt><dd>{course.moduleCount}</dd></div><div><dt>Lessons</dt><dd>{course.lessonCount}</dd></div><div><dt>Study time</dt><dd>{studyTime(course.estimatedStudyMinutes)}</dd></div></dl>
        <div className="uf-course-card__footer"><span>{languageName(course.contentLanguage)}</span><span>View course</span></div>
      </div>
    </Link>
  </article>;
}
