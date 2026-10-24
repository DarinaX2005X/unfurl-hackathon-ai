"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RotateCcw } from "lucide-react";
import { Button, Notice, Textarea } from "@/components/ui";
import type { TaskRendererProps } from "../player/contracts";
import { explanationOptions, type CapacityConfig, type CapacityResponse } from "./content";
import { DATASET, evaluatePolynomial, fitPolynomial, type DataPoint, type FitResult } from "./numerics";
import { PracticeGuide } from "./guide";
import { PracticeGuideCard, ShapePreview } from "./PracticeGuide";
import styles from "./sample.module.css";

const baseline = fitPolynomial(7, 0);
const plot = { left: 48, top: 24, width: 584, height: 276 };
const sx = (x: number) => plot.left + (x + 1) / 2 * plot.width;
const sy = (y: number) => plot.top + (1.5 - y) / 3 * plot.height;
const pathFor = (points: readonly DataPoint[]) => points.map(({ x, y }, index) => `${index ? "L" : "M"}${sx(x).toFixed(2)},${sy(y).toFixed(2)}`).join(" ");
const formatError = (value: number) => value < 0.0005 ? "0.000" : value.toFixed(3);
const shapeNames = { 1: "Straight", 3: "Curved", 7: "Flexible" } as const;

function Plot({ fit, response, comparing }: { fit: FitResult; response: CapacityResponse; comparing: boolean }) {
  const titleId = useId();
  const descriptionId = useId();
  const clipId = useId();
  const path = pathFor(fit.curve);
  return <figure className={styles.plotFigure}>
    <div className={styles.legend} aria-label="Chart legend">
      <span><i className={styles.fitKey} />Your model</span>
      <span><i className={styles.trainingKey} />Learning examples</span>
      <span><i className={styles.validationKey} />New points</span>
    </div>
    <svg viewBox="0 0 660 340" className={styles.plot} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
      <title id={titleId}>Your model’s predictions on learning examples and new points</title>
      <desc id={descriptionId}>Degree {response.degree}, regularization {response.lambda}. Training RMSE {fit.trainRmse.toFixed(6)}. Validation RMSE {fit.validationRmse.toFixed(6)}. Horizontal axis x from minus 1 to 1, vertical axis y from minus 1.5 to 1.5. Training points are circles; validation points are diamonds. Dotted gaps show the model’s error on each new point. Full values are in the data table below.</desc>
      <defs><clipPath id={clipId}><rect x={plot.left - 7} y={plot.top - 7} width={plot.width + 14} height={plot.height + 14} /></clipPath></defs>
      {[-1.5, -1, -0.5, 0, 0.5, 1, 1.5].map((y) => <g key={y} className={Math.abs(y) === 0.5 ? styles.minorTick : undefined}>
        <line x1={plot.left} x2={plot.left + plot.width} y1={sy(y)} y2={sy(y)} className={y === 0 ? styles.axis : styles.grid} />
        <text x={plot.left - 12} y={sy(y) + 4} textAnchor="end" className={styles.tick}>{y}</text>
      </g>)}
      {[-1, -0.5, 0, 0.5, 1].map((x) => <g key={x} className={Math.abs(x) === 0.5 ? styles.minorTick : undefined}>
        <line x1={sx(x)} x2={sx(x)} y1={plot.top} y2={plot.top + plot.height} className={x === 0 ? styles.axis : styles.grid} />
        <text x={sx(x)} y={plot.top + plot.height + 23} textAnchor="middle" className={styles.tick}>{x}</text>
      </g>)}
      <text x="17" y="16" className={styles.axisLabel}>y</text><text x="648" y="324" className={styles.axisLabel}>x</text>
      <g clipPath={`url(#${clipId})`}>
        {DATASET.validation.map(({ x, y }) => <line key={x} x1={sx(x)} x2={sx(x)} y1={sy(y)} y2={sy(evaluatePolynomial(fit.coefficients, x))} className={styles.validationGap} data-emphasized={comparing} />)}
        <path d={path} style={{ d: `path("${path}")` }} className={styles.fittedCurve} />
        {DATASET.train.map(({ x, y }) => <circle key={x} cx={sx(x)} cy={sy(y)} r="5.5" className={styles.trainingPoint} />)}
        {DATASET.validation.map(({ x, y }) => <path key={x} d={`M${sx(x)},${sy(y) - 6}l6,6l-6,6l-6,-6Z`} className={styles.validationPoint} />)}
      </g>
    </svg>
    <figcaption className={styles.plotCaption}><span className={styles.mobileAxisLabels}><span>x: −1 to 1</span><span>y: −1.5 to 1.5</span></span>The dotted gaps show missed predictions. Shorter gaps are better.</figcaption>
  </figure>;
}

function Metric({ label, value, initial, target, highlighted }: { label: string; value: number; initial: number; target?: number; highlighted?: boolean }) {
  const change = value - initial;
  return <div className={styles.metric} data-primary={target !== undefined} data-highlighted={highlighted}>
    <span className={styles.metricLabel}>{label}</span>
    <strong className={styles.metricValue}>{formatError(value)}</strong>
    <span className={styles.metricComparison}>{Math.abs(change) < 0.0005 ? "The starting model" : `${Math.abs(change).toFixed(3)} ${change < 0 ? "less" : "more"} error than at the start`}</span>
    {target !== undefined && <>
      <div className={styles.errorScale} aria-hidden="true"><span className={styles.errorScaleFill} style={{ transform: `scaleX(${Math.min(value / 0.6, 1)})` }} /><i style={{ left: `${target / 0.6 * 100}%` }} /></div>
      <span className={styles.target} data-met={value < target}>{value < target ? "Model target reached" : `Your target: below ${target.toFixed(3)}`}</span>
    </>}
  </div>;
}

export function CapacityRenderer({ task, response, onChange, disabled }: TaskRendererProps<CapacityConfig, CapacityResponse>) {
  const formId = useId();
  const shapeRef = useRef<HTMLFieldSetElement>(null);
  const guideTitleRef = useRef<HTMLHeadingElement>(null);
  const explanationRef = useRef<HTMLFieldSetElement>(null);
  const [guide] = useState(() => new PracticeGuide());
  const guideState = useSyncExternalStore(guide.subscribe, guide.getSnapshot, guide.getServerSnapshot);
  const result = useMemo(() => {
    try { return { fit: fitPolynomial(response.degree, response.lambda), error: null }; }
    catch { return { fit: null, error: "This model could not be fitted. Your settings are preserved. Choose another setting to try again." }; }
  }, [response.degree, response.lambda]);
  const fit = result.fit;
  useEffect(() => {
    try { guide.attachStorage(window.localStorage); }
    catch { guide.attachStorage(null); }
  }, [guide]);

  function changeModel(next: CapacityResponse) {
    if (next.degree !== response.degree || next.lambda !== response.lambda) guide.recordAdjustment();
    onChange(next);
  }
  function locateShape() {
    const selected = shapeRef.current?.querySelector<HTMLInputElement>("input:checked");
    selected?.focus({ preventScroll: true });
    shapeRef.current?.scrollIntoView({ block: window.matchMedia("(max-width: 820px)").matches ? "start" : "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  function dismissGuide() {
    guide.dismiss();
    requestAnimationFrame(locateShape);
  }
  function replayGuide() {
    guide.replay();
    requestAnimationFrame(() => {
      guideTitleRef.current?.focus({ preventScroll: true });
      guideTitleRef.current?.scrollIntoView({ block: "nearest" });
    });
  }
  function nextGuide() {
    if (guideState.step === "compare" && fit && fit.validationRmse < task.config.validationTarget) {
      guide.dismiss();
      requestAnimationFrame(() => { explanationRef.current?.focus({ preventScroll: true }); explanationRef.current?.scrollIntoView({ block: "start" }); });
    } else if (guideState.step === "compare") dismissGuide();
    else {
      guide.next();
      if (guideState.step === "adjust" && window.matchMedia("(max-width: 820px)").matches) {
        requestAnimationFrame(() => { guideTitleRef.current?.focus({ preventScroll: true }); guideTitleRef.current?.scrollIntoView({ block: "start" }); });
      }
    }
  }

  return <div className={styles.task}>
    <div className={styles.workbench} data-guided={guideState.step !== null} data-guide-step={guideState.step}>
      <div className={styles.chartArea}>
        <div className={styles.chartHeading}>
          <h2>Your experiment</h2>
          {guideState.step === null && <Button size="compact" variant="quiet" onClick={replayGuide}><RotateCcw size={16} aria-hidden="true" />Show the guide</Button>}
        </div>
        {fit ? <Plot fit={fit} response={response} comparing={guideState.step === "compare"} /> : <div className={styles.plotFailure}><Notice tone="error">{result.error}</Notice></div>}
        <div className={styles.metrics} aria-live="polite" aria-atomic="true">
          {fit && <><Metric label="Error on learning examples" value={fit.trainRmse} initial={baseline.trainRmse} /><Metric label="Error on new points" value={fit.validationRmse} initial={baseline.validationRmse} target={task.config.validationTarget} highlighted={guideState.step === "compare"} /></>}
        </div>
        <details className={styles.errorDefinition}><summary>What does this number mean?</summary><p>It measures how far the line misses the points. Zero is a perfect match; lower is better. The calculation is called root mean squared error, or RMSE. New points were not used to fit the line, so their error checks predictions beyond the learning examples.</p></details>
      </div>
      <div className={styles.controlArea}>
        <PracticeGuideCard headingRef={guideTitleRef} state={guideState} error={fit?.validationRmse ?? null} onNext={nextGuide} onSkip={dismissGuide} onLocate={locateShape} />
        <div className={styles.controls}>
          <fieldset ref={shapeRef} className={styles.controlGroup} disabled={disabled} data-highlighted={guideState.step === "adjust"}>
            <legend>Choose the model’s shape</legend>
            <div className={styles.segments}>
              {task.config.degrees.map((degree) => <label key={degree} className={styles.segment}>
                <input type="radio" name={`${formId}-degree`} value={degree} checked={response.degree === degree} onChange={() => changeModel({ ...response, degree })} aria-describedby={`${formId}-degree-help`} />
                <span><ShapePreview degree={degree} /><strong>{shapeNames[degree]}</strong></span>
              </label>)}
            </div>
            <p id={`${formId}-degree-help`}>A flexible curve can bend more to fit the examples.</p>
          </fieldset>
          <fieldset className={styles.controlGroup} disabled={disabled}>
            <legend>Limit the bending</legend>
            <div className={`${styles.segments} ${styles.penalties}`}>
              {task.config.regularizations.map((lambda) => <label key={lambda} className={styles.segment}>
                <input type="radio" name={`${formId}-lambda`} value={lambda} checked={response.lambda === lambda} onChange={() => changeModel({ ...response, lambda })} aria-describedby={`${formId}-lambda-help`} />
                <span><strong>{lambda === 0 ? "None" : lambda === 0.1 ? "Gentle" : "Strong"}</strong></span>
              </label>)}
            </div>
            <p id={`${formId}-lambda-help`}>A stronger limit discourages large bends. Try it with any shape.</p>
          </fieldset>
          <details className={styles.prediction}>
            <summary>Make a prediction <span>Optional</span></summary>
            <fieldset disabled={disabled} className={styles.predictionField}>
              <legend>What might happen to the error on new points if you make the curve less flexible?</legend>
              <div className={styles.predictionOptions}>
                {([{ value: "lower", label: "It could fall" }, { value: "higher", label: "It could rise" }, { value: "unsure", label: "I’m not sure" }] as const).map((option) => <label key={option.value} className={styles.predictionChoice}>
                  <input type="radio" name={`${formId}-prediction`} checked={response.prediction === option.value} onChange={() => onChange({ ...response, prediction: option.value })} /><span>{option.label}</span>
                </label>)}
              </div>
            </fieldset>
          </details>
          {guideState.step === "adjust" && guideState.adjusted && <div className={styles.mobileGuideContinue}><Button variant="secondary" onClick={nextGuide}>Compare the result</Button></div>}
        </div>
      </div>
    </div>

    <fieldset ref={explanationRef} tabIndex={-1} className={styles.explanation} disabled={disabled}>
      <legend>What would you trust on new data?</legend>
      <p className={styles.explanationPrompt}>Choose the explanation that fits what you observed.</p>
      <div className={styles.explanationOptions}>
        {explanationOptions.map((option, index) => <label className={styles.explanationChoice} key={option.value}>
          <input type="radio" name={`${formId}-explanation`} checked={response.explanation === option.value} onChange={() => onChange({ ...response, explanation: option.value })} />
          <span className={styles.answerLetter} aria-hidden="true">{String.fromCharCode(65 + index)}</span><span>{option.label}</span>
        </label>)}
      </div>
    </fieldset>
    <details className={styles.reflection}>
      <summary>Keep a note about your experiment <span>Optional</span></summary>
      <div className={styles.reflectionField}><Textarea id={`${formId}-reflection`} label="Your observation" value={response.reflection} onChange={(event) => onChange({ ...response, reflection: event.target.value })} maxLength={1200} rows={3} disabled={disabled} hint="Your note stays with this practice. It is not graded." /></div>
    </details>
    <details className={styles.dataDetails}>
      <summary>Look inside the model and data</summary>
      <div className={styles.dataContent}>
        <p>This is a fixed synthetic experiment. The underlying pattern is y = sin(πx). Eight learning examples contain added noise; seven new points do not. In machine learning these two sets are called training data and validation data.</p>
        <p>Straight, Curved and Flexible use polynomial degrees 1, 3 and 7. The bending limits are regularization penalties of λ = 0, 0.1 and 1. The model minimizes squared training errors plus λ times the sum of squared coefficients, excluding the intercept. The axes stay fixed across all settings.</p>
        {fit && <>
          <p><strong>Current fit:</strong> degree {response.degree}, λ = {response.lambda}. Training RMSE {fit.trainRmse.toFixed(6)}; validation RMSE {fit.validationRmse.toFixed(6)}.</p>
          <p className={styles.coefficients}>Coefficients from a₀ to a{response.degree}: {fit.coefficients.map((value) => value.toFixed(6)).join(", ")}</p>
          <div className={styles.dataTables}>
            {([{ title: "Learning examples (training)", points: DATASET.train }, { title: "New points (validation)", points: DATASET.validation }]).map(({ title, points }) => <div className={styles.tableScroll} key={title}>
              <table><caption>{title}</caption><thead><tr><th scope="col">x</th><th scope="col">Observed y</th><th scope="col">Model y</th></tr></thead><tbody>
                {points.map((point) => <tr key={point.x}><td>{point.x.toFixed(1)}</td><td>{point.y.toFixed(4)}</td><td>{evaluatePolynomial(fit.coefficients, point.x).toFixed(4)}</td></tr>)}
              </tbody></table>
            </div>)}
          </div>
        </>}
      </div>
    </details>
  </div>;
}
