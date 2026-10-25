"use client";

import { useEffect, useRef } from "react";
import { BookOpen, Check, CloudOff, RotateCw } from "lucide-react";
import { AppShell } from "@/components/shell";
import { Button, LinkButton, Notice } from "@/components/ui";
import { useAccountSession, refreshAccount } from "@/features/account/account-session";
import { getProductionMechanic } from "@/features/learning/registry";
import { useLearningSession } from "@/features/learning/session/useLearningSession";
import type { LearningFailure } from "@/features/learning/session/controller";
import { routes } from "@/lib/routes";
import { UnsupportedTask } from "./UnsupportedTask";
import { LessonText } from "./LessonText";
import { TaskGuide } from "./TaskGuide";
import { AssessmentReview, CourseOutline, LessonAssistance, LessonSources, SupportControls } from "./PlayerTools";
import styles from "./player.module.css";

function failureText(failure: LearningFailure): string {
  const code = failure.error.error.code;
  if (failure.error.error.messageKey === "support.unavailable") return "No support activity is available for that choice in this course. You can choose another kind of support or keep working on your current activity.";
  if (code === "unauthenticated") return "Sign in again to continue with your saved course.";
  if (code === "forbidden" || code === "not_found") return "This course is not available to this account.";
  if (code === "revision_conflict") return "This activity changed in another session. Check the saved work before continuing.";
  if (code === "invalid_input") return "Check the highlighted response parts and try again.";
  if (code === "rate_limited") return "Please wait a moment before trying again. Your answer is still here.";
  const messages = {
    load: "The course could not be loaded. Try opening it again.",
    start: "The activity could not be started. Try again when the connection is available.",
    save: "Your latest changes have not been confirmed as saved. Keep this page open and retry saving.",
    action: "The activity result could not be confirmed. Your work is still here.",
    submit: "Your submission has not been confirmed. Retry it to check the same answer.",
    evaluation: "The assessment could not be retrieved. Your submitted answer is retained.",
    advance: "The next position could not be confirmed. Retry continuing from here.",
    assistance: "The help request could not be confirmed. Retry it to recover the same request.",
    navigation: "Your position could not be confirmed. Reload the course to check its saved route.",
    support: "The support request could not be confirmed. Your current work is retained.",
    review: "The assessment review request could not be confirmed. Retry the same request.",
  };
  return messages[failure.scope];
}

export function ProductionPlayer({ enrollmentId }: { enrollmentId: string }) {
  const account = useAccountSession();
  return <AppShell active="learn">
    {account.status === "loading" ? <div className={styles.loading} role="status">Opening your course</div> :
      account.status === "error" ? <div className={styles.unavailable}><h1>Your course</h1><Notice tone="warning" title="Your account could not be checked">
        <Button variant="secondary" onClick={() => void refreshAccount()}>Try again</Button></Notice></div> :
        !account.session ? <div className={styles.unavailable}><BookOpen size={32} aria-hidden="true" /><h1>Continue your learning</h1>
          <p>Sign in to open your course and saved work.</p><div className={styles.actions}><LinkButton href={routes.login(routes.learn(enrollmentId))}>Sign in</LinkButton>
            <LinkButton href={routes.signup(routes.learn(enrollmentId))} variant="secondary">Create account</LinkButton></div></div> :
          <LearningWorkspace key={`${account.session.identity.id}:${enrollmentId}`} actorId={account.session.identity.id} enrollmentId={enrollmentId} />}
  </AppShell>;
}

function LearningWorkspace({ actorId, enrollmentId }: { actorId: string; enrollmentId: string }) {
  const { state, controller } = useLearningSession(actorId, enrollmentId);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousTask = useRef<string | null>(null);
  const session = state.session;
  const task = session?.task;
  const handle = task ? getProductionMechanic(task.mechanicId, task.mechanicVersion) : null;
  const taskKey = `${session?.lesson?.id}:${task?.id}`;
  useEffect(() => {
    if (previousTask.current !== null && previousTask.current !== taskKey) heading.current?.focus({ preventScroll: false });
    previousTask.current = taskKey;
  }, [taskKey]);

  if (!session) return <div className={styles.unavailable}>
    <h1>Your course</h1>
    {state.phase === "loading" ? <p role="status">Loading your saved position</p> : state.failure && <Notice tone="warning" title="Course unavailable">
      <p>{failureText(state.failure)}</p>
      <div className={styles.actions}>{state.failure.error.error.code === "unauthenticated" ? <LinkButton href={routes.login(routes.learn(enrollmentId))}>Sign in</LinkButton> :
        <Button variant="secondary" onClick={() => void controller.load()}>Try again</Button>}<LinkButton href={routes.library} variant="quiet">Return to library</LinkButton></div>
    </Notice>}
  </div>;

  const evaluation = session.evaluation?.evaluation;
  const currentEvaluation = controller.hasCurrentEvaluation();
  const evaluated = evaluation?.status === "evaluated" || evaluation?.status === "uncertain";
  const busy = state.busy !== null;
  const editingLocked = !session.activity || session.enrollment.status === "archived" || state.routeMoved || state.busy === "submit" || state.busy === "advance";
  const reading = session.lesson?.blocks.filter((block) => block.kind !== "task") ?? [];
  const Renderer = handle?.Renderer;
  const failedAccess = state.failure && ["unauthenticated", "forbidden", "not_found"].includes(state.failure.error.error.code);
  const retryFailure = () => {
    if (!state.failure) return;
    if (state.commandUnconfirmed) { void controller.retryCommand(); return; }
    switch (state.failure.scope) {
      case "load": void controller.load(); break;
      case "start": void controller.start(); break;
      case "save": void controller.save(); break;
      case "action": void (state.actionUnconfirmed ? controller.retryUnconfirmedAction() : controller.refreshStatus()); break;
      case "submit": void controller.submit(); break;
      case "evaluation": void controller.refreshStatus(); break;
      case "advance": void controller.advance(); break;
      case "navigation": case "assistance": case "support": case "review": void controller.load(); break;
    }
  };

  return <div className={styles.player}>
    <header className={styles.header}>
      <div className={styles.headerLinks}><LinkButton href={routes.library} variant="quiet" size="compact">Your library</LinkButton><CourseOutline state={state} controller={controller} /></div>
      <p className={styles.progress} aria-label={`Level ${session.progress.level}, ${session.progress.xpTotal} experience points`}>
        <span>Level {session.progress.level}</span><span>{session.progress.xpTotal.toLocaleString("en")} XP</span>
      </p>
    </header>
    <div className={styles.title}>{state.context && <p className={styles.courseTitle}>{state.context.course.title}</p>}<h1 ref={heading} tabIndex={-1}>{session.lesson?.title ?? (session.enrollment.status === "completed" ? "Course completed" : "Review your learning")}</h1>
      {session.progress.totalRequiredOutcomes > 0 && <p>{session.progress.completedRequiredOutcomes} of {session.progress.totalRequiredOutcomes} learning outcomes confirmed</p>}
    </div>
    {!state.online && <Notice tone="warning" title="You are offline"><p>The last confirmed position is shown. Your current edits remain here until you reconnect and save.</p></Notice>}
    {state.transitionFeedback && <Notice tone="info" title="Your support activity has finished"><p>{state.transitionFeedback.evaluation.feedback.explanation}</p><p>You are back at your saved position in the course.</p><Button variant="quiet" size="compact" onClick={() => controller.dismissTransitionFeedback()}>Dismiss</Button></Notice>}
    {state.commandUnconfirmed && !state.failure && <Notice tone="warning" title="A previous request needs confirmation"><p>Your work is retained. Recover the same request before changing your route or submitting another answer.</p><Button variant="secondary" disabled={busy || !state.online} onClick={() => void controller.retryCommand()}>Recover request</Button></Notice>}
    {state.failure && !state.conflict && <Notice tone="warning" title={failedAccess ? "Course access changed" : "This action needs attention"}>
      <p>{failureText(state.failure)}</p><div className={styles.actions}>
        {failedAccess ? <LinkButton href={routes.login(routes.learn(enrollmentId))} variant="secondary">Sign in</LinkButton> :
          <Button variant="secondary" disabled={busy || !state.online} onClick={retryFailure}>Retry {state.failure.scope === "save" ? "saving" : state.failure.scope === "submit" ? "submission" : state.failure.scope === "advance" ? "continuing" : "action"}</Button>}
      </div></Notice>}
    {state.conflict && <Notice tone="warning" title="There are two versions of your answer">
      <p>Your edits are still in this page. Choose whether to keep them or load the answer saved by the other session.</p>
      <div className={styles.actions}><Button variant="secondary" onClick={() => void controller.resolveConflict("mine")}>Save my answer</Button>
        <Button variant="quiet" onClick={() => void controller.resolveConflict("saved")}>Use saved answer</Button></div>
    </Notice>}
    {!session.lesson ? <section className={styles.finish}>
      {session.enrollment.status === "completed" ? <><Check size={32} aria-hidden="true" /><p>You have worked through the course and demonstrated its required learning outcomes.</p></> :
        <><p>You have reached the end of the sequence. Some learning outcomes still need confirmed evidence before the course is complete.</p>
          {state.context && <ul>{state.context.outcomes.filter((outcome) => session.route.pendingOutcomeIds.includes(outcome.id)).map((outcome) => <li key={outcome.id}>{outcome.title}</li>)}</ul>}
          <p>Revisit a completed lesson from the course outline to work on these outcomes.</p></>}
      <LinkButton href={routes.library} variant="secondary">Return to library</LinkButton>
    </section> : <div className={styles.lessonLayout}>
      <div className={styles.work}>
        {task ? <section className={styles.task} aria-label="Current activity">
          <div className={styles.instruction} lang={task.contentLanguage}>{task.instruction}</div>
          {!Renderer || state.response === null ? <UnsupportedTask /> : <>
            <TaskGuide key={taskKey} task={task} />
            {!session.activity && <div className={styles.start}><Button pending={state.busy === "start"} disabled={!state.online || Boolean(failedAccess)} onClick={() => void controller.start()}>Start activity</Button>
              <p>Read the task, then start when you are ready to work on your answer.</p></div>}
            <div className={styles.response} aria-disabled={editingLocked || Boolean(failedAccess)}>
              <Renderer task={task} response={state.response} onChange={controller.setResponse} disabled={editingLocked || Boolean(failedAccess)}
                status={state.issues.length ? "error" : state.busy === "submit" ? "submitting" : currentEvaluation && evaluated ? "evaluated" : "editing"}
                evaluation={null} activity={{ session: session.activity, pending: state.busy === "action", error: state.failure?.scope === "action" ? state.failure.error : null,
                  dispatch: (action) => controller.dispatch(action), retryAction: (id) => controller.retryAction(id) }} />
            </div>
            {session.activity && <div className={styles.submitArea}>
              {state.issues.length > 0 && <div className={styles.validation} role="alert"><p>Complete these parts before submitting</p><ul>{state.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div>}
              <div className={styles.submitRow}><Button pending={state.busy === "submit"} disabled={busy || !state.online || state.conflict || state.actionUnconfirmed || state.commandUnconfirmed || Boolean(failedAccess) || (currentEvaluation && Boolean(evaluation))}
                onClick={() => void controller.submit()}>{state.submissionUnconfirmed ? "Retry submission" : "Submit answer"}</Button>
                <p className={styles.saveState} role="status">{state.saving ? <><RotateCw size={16} aria-hidden="true" />Saving changes</> :
                  state.dirty ? <><CloudOff size={16} aria-hidden="true" />Changes not yet saved</> : <><Check size={16} aria-hidden="true" />Answer saved</>}</p></div>
              {!state.recoveryAvailable && state.dirty && <p>Keep this tab open until your answer is saved.</p>}
            </div>}
            <LessonAssistance key={taskKey} state={state} controller={controller} />
          </>}
        </section> : reading.length === 0 ? null : <section className={styles.readingOnly} aria-label="Lesson reading">{reading.map((block) => <div key={block.id} className={styles.readingBlock}>
          {block.kind === "example" && <h2>{block.title}</h2>}<LessonText text={block.kind === "example" ? block.content : block.markdown} />
        </div>)}</section>}
        {evaluation && <section className={styles.feedback} aria-label="Assessment feedback" aria-live="polite" data-result={evaluation.status === "evaluated" ? evaluation.outcome : evaluation.status}>
          <h2>{!currentEvaluation ? "Feedback on your earlier answer" : evaluation.status === "pending" ? "Your answer is being assessed" : evaluation.status === "unavailable" ? "Assessment unavailable" : evaluation.status === "uncertain" ? "This answer needs a closer look" : evaluation.outcome === "correct" ? "Your answer meets the criteria" : "Feedback on your answer"}</h2>
          {!currentEvaluation && <p>Your current edits have not been assessed.</p>}
          <p>{evaluation.feedback.explanation}</p>
          {evaluation.dimensions.length > 0 && <dl className={styles.dimensions}>{evaluation.dimensions.map((dimension) => <div key={dimension.id}>
            <dt>{dimension.status === "met" ? "Met" : dimension.status === "partial" ? "Partly met" : dimension.status === "uncertain" ? "Needs review" : "Needs revision"}</dt><dd>{dimension.explanation}</dd>
          </div>)}</dl>}
          {evaluation.awardedXp > 0 && <p className={styles.earned}>{evaluation.awardedXp} XP awarded for this answer</p>}
          {evaluation.status === "unavailable" && <Button variant="secondary" pending={state.busy === "evaluation"} disabled={!state.online || busy} onClick={() => void controller.retryEvaluation()}>Retry assessment</Button>}
          {(currentEvaluation || state.routeMoved) && evaluated && <Button pending={state.busy === "advance"} disabled={!state.online || busy || state.commandUnconfirmed || ["queued", "running"].includes(session.evaluation?.review?.status ?? "")} onClick={() => void controller.advance()}>{state.routeMoved ? "Return to your saved course position" : "Continue"}</Button>}
          <AssessmentReview key={evaluation.attemptId} state={state} controller={controller} />
        </section>}
        {!task && <Button className={styles.readingContinue} pending={state.busy === "advance" || state.busy === "support"} disabled={!state.online || busy || state.commandUnconfirmed}
          onClick={() => void (session.support?.status === "accepted" && session.support.tasks.length === 0 ? controller.returnSupport() : controller.advance())}>{session.support?.status === "accepted" && session.support.tasks.length === 0 ? "Return to course" : "Continue"}</Button>}
      </div>
      {task && reading.length > 0 && <aside className={styles.lessonReading} aria-label="Lesson explanation"><details open={!session.activity}><summary>Lesson explanation</summary>
        {reading.map((block) => <div key={block.id} className={styles.readingBlock}>{block.kind === "example" && <h2>{block.title}</h2>}<LessonText text={block.kind === "example" ? block.content : block.markdown} /></div>)}
      </details></aside>}
    </div>}
    <LessonSources state={state} />
    <SupportControls state={state} controller={controller} />
  </div>;
}
