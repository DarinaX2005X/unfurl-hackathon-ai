"use client";

import { useId, useState } from "react";
import { Button, Drawer, Select, Textarea } from "@/components/ui";
import type { AssessmentReviewInput, SupportRequest } from "@/application/learning-port";
import type { LearningPlayerState, LearningSessionController } from "@/features/learning/session/controller";
import { LessonText } from "./LessonText";
import styles from "./player.module.css";

type Props = { state: LearningPlayerState; controller: LearningSessionController };
export function CourseOutline({ state, controller }: Props) {
  const [open, setOpen] = useState(false);
  const { context, session } = state;
  return <><Button variant="quiet" size="compact" disabled={state.routeMoved} onClick={() => setOpen(true)}>Course outline</Button>
    <Drawer open={open} onOpenChange={setOpen} title={context?.course.title ?? "Course outline"} description="Your saved route through this course">
      {state.contextError ? <><p>The outline could not be loaded for your current position.</p><Button variant="secondary" onClick={() => void controller.loadContext()}>Reload outline</Button></> :
        !context ? <p role="status">Loading outline</p> : <>
          {context.revisitBlockedReason && <p>{context.revisitBlockedReason === "support_active" ? "Return from the support activity before revisiting earlier lessons." : context.revisitBlockedReason === "review_active" ? "An assessment review is in progress. Revisit will be available when it finishes." : "This enrollment is archived."}</p>}
          <ol className={styles.outline}>{context.outline.map((lesson) => <li key={lesson.lessonId} aria-current={lesson.availability === "current" ? "step" : undefined}>
            <h3>{lesson.title}</h3><p>{lesson.availability === "current" ? "Current lesson" : lesson.availability === "completed" ? "Visited lesson" : "Coming up"}</p>
            <ul>{lesson.positions.map((position) => <li key={position.taskId ?? "reading"}>{position.revisitable && !context.revisitBlockedReason && !(session?.lesson?.id === lesson.lessonId && session.task?.id === position.taskId) ?
              <Button variant="quiet" size="compact" disabled={Boolean(state.busy) || state.commandUnconfirmed || state.routeMoved} onClick={() => { void controller.revisit(lesson.lessonId, position.taskId).then(() => setOpen(false)); }}>{position.instruction ?? "Revisit reading"}</Button> :
              <span>{position.instruction ?? "Lesson reading"}</span>}</li>)}</ul>
          </li>)}</ol>
          {context.outlineNextCursor && <Button variant="secondary" pending={state.contextLoading} onClick={() => void controller.loadContext(true)}>Show more lessons</Button>}
        </>}
    </Drawer></>;
}

export function LessonAssistance({ state, controller }: Props) {
  const task = state.session?.task;
  const savedAssistance = state.context?.assistance;
  const assistance = savedAssistance?.taskId === task?.id && savedAssistance?.taskVersion === task?.taskVersion ? savedAssistance : null;
  const [confirmReveal, setConfirmReveal] = useState(false);
  if (!task) return null;
  const disabled = Boolean(state.busy) || !state.online || state.commandUnconfirmed || state.routeMoved || !state.context || !state.session?.activity;
  return <details className={styles.assistance}><summary>Help with this activity</summary>
    <p>A hint or worked answer is recorded as assisted work. Your current answer stays editable.</p>
    {assistance?.hints.map((hint, index) => <section key={hint.hintId}><h3>Hint {index + 1}</h3><LessonText text={hint.content} /></section>)}
    {assistance?.workedExample ? <section><h3>Worked answer</h3><LessonText text={assistance.workedExample.content} /></section> : <>
      {(assistance?.hints.length ?? 0) < task.availableHints && <Button variant="secondary" disabled={disabled} onClick={() => void controller.hint()}>{assistance?.hints.length ? "Show next hint" : "Show a hint"}</Button>}
      {confirmReveal ? <div className={styles.revealConfirm}><p>Show a worked answer for this activity? It will be recorded as assisted work.</p><div className={styles.actions}>
        <Button variant="secondary" disabled={disabled} onClick={() => { setConfirmReveal(false); void controller.reveal(); }}>Show worked answer</Button><Button variant="quiet" onClick={() => setConfirmReveal(false)}>Keep working</Button></div></div> :
        <Button variant="quiet" disabled={disabled} onClick={() => setConfirmReveal(true)}>See a worked answer</Button>}
    </>}
    {!state.session?.activity && <p>Start the activity to use hints or a worked answer.</p>}
    {state.contextError && <Button variant="quiet" onClick={() => void controller.loadContext()}>Reload saved help</Button>}
  </details>;
}

export function SupportControls({ state, controller }: Props) {
  const id = useId();
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<SupportRequest["kind"]>("explanation");
  const session = state.session, context = state.context, offer = session?.support;
  if (!session || state.routeMoved) return null;
  const disabled = Boolean(state.busy) || !state.online || state.commandUnconfirmed || session.enrollment.status === "archived";
  const targets = context?.outcomes ?? [];
  const selectedTarget = targets.some((item) => item.id === target) ? target : targets[0]?.id ?? "";
  const active = offer?.status === "accepted";
  const returnTitle = context?.outline.find((lesson) => lesson.lessonId === offer?.returnPoint.lessonId)?.title;
  return <section className={styles.support} aria-label="Learning support">
    {offer && (offer.status === "offered" || active) && <div className={styles.supportOffer}>
      <h2>{active ? "Your support activity" : "A short support activity is available"}</h2><p>{offer.explanation}</p>
      <p>{offer.tasks.length ? `${offer.tasks.length} ${offer.tasks.length === 1 ? "activity" : "activities"}` : "A focused explanation"} · About {offer.estimatedStudyMinutes} minutes</p>
      <p>You can return to {returnTitle ? `“${returnTitle}”` : "your saved place in the course"}.</p>
      <div className={styles.actions}>{active ? <Button variant="secondary" disabled={disabled} onClick={() => void controller.returnSupport()}>Return to course</Button> : <>
        <Button variant="secondary" disabled={disabled} onClick={() => void controller.respondSupport("accept")}>Take this support activity</Button>
        <Button variant="quiet" disabled={disabled} onClick={() => void controller.respondSupport("decline")}>Keep my current route</Button></>}</div>
    </div>}
    {!active && offer?.status !== "offered" && session.enrollment.status !== "completed" && session.route.next[0]?.reasonCode === "course_sequence" && <details><summary>Choose additional support</summary>
      <p>Choose a learning outcome and the kind of support you need. Review the proposed activity before changing your route.</p>
      {targets.length ? <div className={styles.supportForm}><Select id={`${id}-target`} label="Learning outcome" value={selectedTarget} onChange={(event) => setTarget(event.target.value)} options={targets.map((item) => ({ value: item.id, label: item.title }))} />
        <Select id={`${id}-kind`} label="What would help?" value={kind} onChange={(event) => setKind(event.target.value as SupportRequest["kind"])} options={[
          { value: "explanation", label: "Explain this another way" }, { value: "diagnostic_clarification", label: "Help me find what I misunderstood" },
          { value: "additional_practice", label: "More practice" }, { value: "prerequisite_support", label: "Review an earlier idea" }, { value: "challenge", label: "A more demanding challenge" },
        ]} /><Button variant="secondary" disabled={disabled || !selectedTarget} onClick={() => void controller.requestSupport(selectedTarget, kind)}>Find a support activity</Button></div> :
        <p>{state.contextError ? "Support choices could not be loaded." : "Loading learning outcomes"}</p>}
    </details>}
  </section>;
}

export function AssessmentReview({ state, controller }: Props) {
  const id = useId();
  const [reason, setReason] = useState<AssessmentReviewInput["reason"]>("valid_alternative");
  const [comment, setComment] = useState("");
  const receipt = state.session?.evaluation;
  if (!receipt || !["evaluated", "uncertain"].includes(receipt.evaluation.status)) return null;
  const review = receipt.review;
  const pending = review?.status === "queued" || review?.status === "running";
  const disabled = Boolean(state.busy) || !state.online || state.commandUnconfirmed;
  return <details className={styles.review}><summary>{pending ? "Assessment review in progress" : "Request a review of this assessment"}</summary>
    {pending ? <p role="status">Your explanation is being reviewed against this submitted answer. You can read the lesson while the review runs.</p> :
      review?.status === "resolved" ? <p>{review.resolution === "corrected" ? "The review changed the assessment. The feedback above includes the corrected result." : review.resolution === "uncertain" ? "The review could not establish a definite result. The feedback above explains the remaining uncertainty." : "The review confirmed the assessment. The feedback above explains the result."}</p> :
        review?.status === "unavailable" ? <><p>The review is unavailable. Your request has been retained.</p><Button variant="secondary" disabled={disabled} onClick={() => void controller.retryReview()}>Retry review</Button></> :
          <form className={styles.supportForm} onSubmit={(event) => { event.preventDefault(); if (comment.trim()) void controller.review(reason, comment); }}>
            <p>Explain why this submitted answer deserves another look. A review uses the submitted answer, including when you have made later edits.</p>
            <Select id={`${id}-reason`} label="Reason for review" value={reason} onChange={(event) => setReason(event.target.value as AssessmentReviewInput["reason"])} options={[
              { value: "valid_alternative", label: "My answer uses a valid alternative" }, { value: "unclear_prompt", label: "The prompt was unclear" }, { value: "other", label: "Another reason" },
            ]} /><Textarea id={`${id}-comment`} label="What should the review consider?" value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} required />
            <Button variant="secondary" type="submit" disabled={disabled || !comment.trim()}>Request assessment review</Button>
          </form>}
  </details>;
}

export function LessonSources({ state }: Pick<Props, "state">) {
  const sources = state.context?.citations;
  if (!sources?.length) return null;
  return <details className={styles.sources}><summary>Sources for this lesson</summary><ul>{sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><span>{new URL(source.url).hostname}</span></li>)}</ul></details>;
}
