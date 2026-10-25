-- Normal required-program traversal is durable authority, separate from support route insertion.
create table unfurl.enrollment_lesson_traversal (
  enrollment_id uuid not null,
  course_version_id uuid not null,
  lesson_id uuid not null,
  completed_at timestamptz not null default now(),
  primary key (enrollment_id, lesson_id),
  foreign key (enrollment_id, course_version_id)
    references unfurl.enrollments(id, course_version_id) on delete cascade,
  foreign key (lesson_id, course_version_id)
    references unfurl.lessons(id, course_version_id) on delete restrict
);
create index enrollment_traversal_version on unfurl.enrollment_lesson_traversal(enrollment_id, course_version_id, completed_at, lesson_id);
create trigger enrollment_traversal_immutable before update or delete on unfurl.enrollment_lesson_traversal
  for each row execute function unfurl.reject_immutable_change();
alter table unfurl.enrollment_lesson_traversal enable row level security;
alter table unfurl.enrollment_lesson_traversal force row level security;
revoke all on unfurl.enrollment_lesson_traversal from public, anon, authenticated;
grant all on unfurl.enrollment_lesson_traversal to service_role;
