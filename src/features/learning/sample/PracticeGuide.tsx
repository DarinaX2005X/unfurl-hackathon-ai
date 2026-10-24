import type { Ref } from "react";
import { Button } from "@/components/ui";
import type { GuideSnapshot } from "./guide";
import styles from "./sample.module.css";

export function ShapePreview({ degree }: { degree: 1 | 3 | 7 }) {
  const paths = {
    1: "M6 35L66 9",
    3: "M6 31C22 53 26 4 46 11S62 30 66 13",
    7: "M6 30C12 4 18 45 24 29S31 5 38 15S46 38 52 18S62 5 66 13",
  };
  return <svg viewBox="0 0 72 48" aria-hidden="true" className={styles.shapePreview}>
    <path d={paths[degree]} />
  </svg>;
}

function GuidePicture({ step, error }: { step: GuideSnapshot["step"]; error: number | null }) {
  if (step === "adjust") return <div className={styles.guideShapes} aria-hidden="true">
    <ShapePreview degree={1} /><ShapePreview degree={3} /><ShapePreview degree={7} />
  </div>;
  if (step === "compare") return <div className={styles.guideComparison} aria-hidden="true">
    <svg viewBox="0 0 150 68"><path d="M10 52C48 52 69 10 140 18" /><path d="M77 31V10" className={styles.guideMiss} /><path d="M77 4l6 6-6 6-6-6Z" className={styles.guideDiamond} /></svg>
    <span>{error === null ? "Try a setting" : error.toFixed(3)}<small>error on new points</small></span>
  </div>;
  return <div className={styles.guideExamples} aria-hidden="true">
    <div><svg viewBox="0 0 108 56"><path d="M6 46C27 40 27 11 53 16S80 48 102 8" />{[[14,42],[35,20],[58,18],[78,29],[96,19]].map(([x,y])=><circle key={x} cx={x} cy={y} r="4" />)}</svg><span>Learn from circles</span></div>
    <div><svg viewBox="0 0 108 56"><path d="M6 46C27 40 27 11 53 16S80 48 102 8" />{[[22,28],[47,11],[68,31],[89,17]].map(([x,y])=><path key={x} d={`M${x} ${y! - 5}l5 5-5 5-5-5Z`} className={styles.guideDiamond} />)}</svg><span>Check on diamonds</span></div>
  </div>;
}

export function PracticeGuideCard({ state, error, onNext, onSkip, onLocate, headingRef }: {
  state: GuideSnapshot; error: number | null; onNext: () => void; onSkip: () => void; onLocate: () => void; headingRef: Ref<HTMLHeadingElement>;
}) {
  const { step, adjusted } = state;
  if (!step) return null;
  const content = {
    observe: { title: "Meet your model", body: "The orange line learned from the circles. The diamonds are new points it has to predict.", action: "Let me try" },
    adjust: { title: "Change its shape", body: adjusted ? "The line and its error have changed. Now look at how it performs on the new points." : "Choose a different shape below. Watch the orange line move, then look at its distance from the diamonds.", action: "Compare the result" },
    compare: { title: "Read the result", body: error !== null && error < 0.21 ? "This model is below the 0.210 target. Compare its two errors, then choose an explanation for what you observed." : "Shorter gaps mean closer predictions. Keep changing the model until its error on new points is below 0.210.", action: error !== null && error < 0.21 ? "Choose an explanation" : "Keep experimenting" },
  }[step];
  return <aside className={styles.guideCard} aria-label="Practice guide">
    <div className={styles.guideTop}><h2 ref={headingRef} tabIndex={-1}>{content.title}</h2><Button variant="quiet" size="compact" onClick={onSkip}>Skip guide</Button></div>
    <GuidePicture step={step} error={error} />
    <div className={styles.guideCopy} key={step}>
      <p>{content.body}</p>
    </div>
    <div className={styles.guideFoot}>
      <span className={styles.guideCount} aria-label={`Step ${step === "observe" ? 1 : step === "adjust" ? 2 : 3} of 3`}>{["observe", "adjust", "compare"].map((item, index) => <span key={item} data-current={step === item}>{index + 1}</span>)}</span>
      {step === "adjust" && !adjusted ? <Button variant="secondary" size="compact" onClick={onLocate}>Choose a shape</Button> : <Button variant={step === "observe" ? "primary" : "secondary"} size="compact" onClick={onNext}>{content.action}</Button>}
    </div>
  </aside>;
}
