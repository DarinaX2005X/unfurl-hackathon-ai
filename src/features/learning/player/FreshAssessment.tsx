"use client";

import { Button } from "@/components/ui";
import type { LearningPlayerState, LearningSessionController } from "@/features/learning/session/controller";
import styles from "./player.module.css";

export function FreshAssessment({ state, controller, observedPrediction = false }: {
  state: LearningPlayerState; controller: LearningSessionController; observedPrediction?: boolean;
}) {
  const availability = state.context?.freshAssessment;
  if (state.routeMoved || availability?.availability === "not_needed") return null;
  if (!availability) return state.contextError ? <div className={styles.freshAssessment}><p>Fresh-assessment availability could not be checked.</p>
    <Button variant="secondary" disabled={!state.online || state.contextLoading} onClick={() => void controller.loadContext()}>Check availability</Button></div> :
    <p className={styles.freshAssessment} role="status">Checking for a fresh assessment</p>;
  const disabled = Boolean(state.busy) || state.saving || state.contextLoading || !state.online || state.conflict || state.commandUnconfirmed || state.actionUnconfirmed || state.submissionUnconfirmed;
  return <section className={styles.freshAssessment} aria-label="Fresh assessment">
    {availability.availability === "available" ? <>
      {observedPrediction && <p>This prediction is locked because its result has already been shown.</p>}
      <p>You can try another assessment selected for the outcomes that still need evidence. Your earlier answer and result will be kept.</p>
      <Button variant="secondary" pending={state.busy === "fresh"} disabled={disabled} onClick={() => void controller.requestFreshAssessment()}>Try a fresh assessment</Button>
    </> : availability.availability === "no_unseen_assessment" ? <>
      <p>No unseen assessment remains for these outcomes in this course. Your earlier answers and results are retained.</p>
      {observedPrediction && <p>Revisiting this prediction keeps it locked because you have already seen its result.</p>}
    </> : <p>{availability.blockedReason === "support_active" ? "Return from your support activity before opening a fresh assessment." :
      availability.blockedReason === "review_active" ? "An assessment review is in progress. Check for a fresh assessment after it finishes." :
        availability.blockedReason === "archived" ? "This enrollment is archived, so a fresh assessment cannot be opened." : "A fresh assessment cannot be opened from this position yet."}</p>}
  </section>;
}
