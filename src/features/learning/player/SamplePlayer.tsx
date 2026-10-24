"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Dialog, LinkButton, Notice } from "@/components/ui";
import { routes } from "@/lib/routes";
import { getMechanic } from "../registry";
import { sampleHint, sampleTask } from "../sample/content";
import { SampleController } from "../sample/session";
import { UnsupportedTask } from "./UnsupportedTask";
import styles from "../sample/sample.module.css";

export function SamplePlayer() {
  const [controller] = useState(() => new SampleController());
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const [resetOpen, setResetOpen] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const snapshotSession = snapshot.session;
  const evaluation = snapshotSession.evaluation;
  const mechanic = getMechanic(sampleTask.mechanicId, sampleTask.mechanicVersion);

  useEffect(() => {
    try { controller.attachStorage(window.localStorage); }
    catch { controller.attachStorage(null); }
  }, [controller]);

  function submit() {
    controller.submit();
    requestAnimationFrame(() => feedbackRef.current?.focus());
  }

  if (!mechanic) return <UnsupportedTask />;
  const Renderer = mechanic.Renderer;
  return <div className={styles.player}>
    <div className={styles.introduction}>
      <div>
        <h1>When a perfect fit goes wrong</h1>
        <p>A model has memorized eight noisy points. Help it find the pattern.</p>
      </div>
      <p className={styles.sampleContext}>A short practice in machine learning<br /><span>Just this device. No account progress.</span></p>
    </div>
    <p className={styles.instruction}>{sampleTask.instruction}</p>
    {snapshot.resumed && <div className={styles.topNotice}><Notice tone="info">Your practice is back where you left it. {evaluation ? "Your last checked answer is shown below." : "Continue with your saved settings."}</Notice></div>}
    {snapshot.storageMessage && <div className={styles.topNotice}><Notice tone="warning">{snapshot.storageMessage}</Notice></div>}
    <Renderer task={sampleTask} response={snapshotSession.response} onChange={(response) => controller.edit(response)} disabled={false} status={snapshot.error ? "error" : evaluation ? "evaluated" : "editing"} evaluation={evaluation} />
    <div className={styles.playerActions}>
      <Button onClick={submit}>{evaluation ? "Check again" : "Check my model"}</Button>
      <Button variant="secondary" onClick={() => controller.useHint()} disabled={snapshotSession.hintIdsUsed.length > 0}>{snapshotSession.hintIdsUsed.length ? "Hint used" : "Get a hint"}</Button>
      <Button variant="quiet" onClick={() => setResetOpen(true)} disabled={!snapshot.started}>Reset practice</Button>
    </div>
    {snapshotSession.hintIdsUsed.length > 0 && <div className={styles.hint}><Notice tone="info" title="A little help">{sampleHint}<p className={styles.assistanceNote}>Your next answer will be recorded as helped by a hint.</p></Notice></div>}
    <div ref={feedbackRef} tabIndex={-1} className={styles.feedback}>
      {snapshot.error && <Notice tone="error">{snapshot.error}</Notice>}
      {evaluation && <Notice tone={evaluation.outcome === "correct" ? "success" : "info"} title={evaluation.outcome === "correct" ? "You found a better balance" : "Keep experimenting"}>
        <p>{evaluation.feedback.explanation}</p>
        {evaluation.outcome === "correct" && <div className={styles.continue}>
          <p>{snapshotSession.lastAttempt?.assistance === "hinted" ? "Completed with a hint." : "Completed independently."} This sample does not award account XP.</p>
          <LinkButton href={routes.create()}>Create a course for your own goal</LinkButton>
          <a className="uf-text-link" href={routes.explore}>Explore courses</a>
        </div>}
      </Notice>}
    </div>
    <p className={styles.selectionNote}>Validation points help you choose a model here. A fresh test set would still be needed to estimate its performance independently.</p>
    <Dialog open={resetOpen} onOpenChange={setResetOpen} title="Start this practice again?" description="Your model settings, notes, hints and checked answers from this practice will be cleared. Your course drafts stay saved.">
      <div className={styles.resetActions}><Button variant="secondary" onClick={() => setResetOpen(false)}>Keep practicing</Button><Button variant="danger" onClick={() => { controller.reset(); setResetOpen(false); }}>Reset practice</Button></div>
    </Dialog>
  </div>;
}
