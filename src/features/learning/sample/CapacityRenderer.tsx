"use client";

import { useId, useMemo } from "react";
import { Notice, Textarea } from "@/components/ui";
import type { TaskRendererProps } from "../player/contracts";
import { explanationOptions, type CapacityConfig, type CapacityResponse } from "./content";
import { DATASET, evaluatePolynomial, fitPolynomial, type DataPoint, type FitResult } from "./numerics";
import styles from "./sample.module.css";

const baseline = fitPolynomial(7, 0);
const plot = { left: 48, top: 24, width: 584, height: 276 };
const sx = (x: number) => plot.left + (x + 1) / 2 * plot.width;
const sy = (y: number) => plot.top + (1.5 - y) / 3 * plot.height;
const pathFor = (points: readonly DataPoint[]) => points.map(({ x, y }, index) => `${index ? "L" : "M"}${sx(x).toFixed(2)},${sy(y).toFixed(2)}`).join(" ");
const trueCurve = Array.from({ length: 201 }, (_, i) => ({ x: -1 + i / 100, y: Math.sin(Math.PI * (-1 + i / 100)) }));
const formatError = (value: number) => value < 0.0005 ? "0.000" : value.toFixed(3);

function Plot({ fit, response }: { fit: FitResult; response: CapacityResponse }) {
  const titleId = useId();
  const descriptionId = useId();
  return <figure className={styles.plotFigure}>
    <div className={styles.legend} aria-label="Chart legend">
      <span><i className={styles.fitKey} />Your model</span>
      <span><i className={styles.trainingKey} />Training points</span>
      <span><i className={styles.validationKey} />Validation points</span>
      <span><i className={styles.truthKey} />Underlying pattern</span>
    </div>
    <svg viewBox="0 0 660 340" className={styles.plot} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
      <title id={titleId}>Polynomial model, training points and validation points</title>
      <desc id={descriptionId}>Degree {response.degree}, regularization {response.lambda}. Training RMSE {fit.trainRmse.toFixed(6)}. Validation RMSE {fit.validationRmse.toFixed(6)}. Horizontal axis x from minus 1 to 1, vertical axis y from minus 1.5 to 1.5. Training points are circles; validation points are diamonds. Full values are in the data table below.</desc>
      {[-1.5, -1, -0.5, 0, 0.5, 1, 1.5].map((y) => <g key={y}>
        <line x1={plot.left} x2={plot.left + plot.width} y1={sy(y)} y2={sy(y)} className={y === 0 ? styles.axis : styles.grid} />
        <text x={plot.left - 12} y={sy(y) + 4} textAnchor="end" className={styles.tick}>{y}</text>
      </g>)}
      {[-1, -0.5, 0, 0.5, 1].map((x) => <g key={x}>
        <line x1={sx(x)} x2={sx(x)} y1={plot.top} y2={plot.top + plot.height} className={x === 0 ? styles.axis : styles.grid} />
        <text x={sx(x)} y={plot.top + plot.height + 23} textAnchor="middle" className={styles.tick}>{x}</text>
      </g>)}
      <text x="17" y="16" className={styles.axisLabel}>y</text><text x="648" y="324" className={styles.axisLabel}>x</text>
      <path d={pathFor(trueCurve)} className={styles.trueCurve} />
      <path key={`${response.degree}:${response.lambda}`} d={pathFor(fit.curve)} className={styles.fittedCurve} />
      {DATASET.train.map(({ x, y }) => <circle key={x} cx={sx(x)} cy={sy(y)} r="5.5" className={styles.trainingPoint} />)}
      {DATASET.validation.map(({ x, y }) => <path key={x} d={`M${sx(x)},${sy(y) - 6}l6,6l-6,6l-6,-6Z`} className={styles.validationPoint} />)}
    </svg>
    <figcaption className={styles.plotCaption}>The model learns from the circles. The diamonds check it on different points.</figcaption>
  </figure>;
}

function Metric({ label, value, initial, target }: { label: string; value: number; initial: number; target?: number }) {
  const change = value - initial;
  return <div className={styles.metric}>
    <span className={styles.metricLabel}>{label}</span>
    <strong className={styles.metricValue}>{formatError(value)}</strong>
    <span className={styles.metricComparison}>{Math.abs(change) < 0.0005 ? "Starting value" : `${Math.abs(change).toFixed(3)} ${change < 0 ? "lower" : "higher"} than the start`}</span>
    {target !== undefined && <span className={styles.target} data-met={value < target}>{value < target ? "Below the target" : `Target: below ${target.toFixed(3)}`}</span>}
  </div>;
}

export function CapacityRenderer({ task, response, onChange, disabled }: TaskRendererProps<CapacityConfig, CapacityResponse>) {
  const formId = useId();
  const result = useMemo(() => {
    try { return { fit: fitPolynomial(response.degree, response.lambda), error: null }; }
    catch { return { fit: null, error: "This model could not be fitted. Your settings are preserved. Choose another setting to try again." }; }
  }, [response.degree, response.lambda]);
  const fit = result.fit;
  return <div className={styles.task}>
    <details className={styles.prediction}>
      <summary>Make a prediction before experimenting <span>Optional</span></summary>
      <fieldset disabled={disabled} className={styles.predictionField}>
        <legend>If you make this model less flexible, what might happen to its validation error?</legend>
        <div className={styles.predictionOptions}>
          {([{ value: "lower", label: "It could fall" }, { value: "higher", label: "It could rise" }, { value: "unsure", label: "I’m not sure yet" }] as const).map((option) =>
            <label key={option.value} className={styles.predictionChoice}>
              <input type="radio" name={`${formId}-prediction`} checked={response.prediction === option.value} onChange={() => onChange({ ...response, prediction: option.value })} />
              <span>{option.label}</span>
            </label>)}
        </div>
      </fieldset>
    </details>
    <div className={styles.workbench}>
      <div className={styles.chartArea}>
        <div className={styles.chartHeading}><h2>Find the pattern, leave the noise</h2><span>Synthetic data</span></div>
        {fit ? <Plot fit={fit} response={response} /> : <div className={styles.plotFailure}><Notice tone="error">{result.error}</Notice></div>}
        <div className={styles.metrics} aria-live="polite" aria-atomic="true">
          {fit && <><Metric label="Training error" value={fit.trainRmse} initial={baseline.trainRmse} /><Metric label="Validation error" value={fit.validationRmse} initial={baseline.validationRmse} target={task.config.validationTarget} /></>}
        </div>
        <p className={styles.errorHelp}>Error is the root mean squared error (RMSE). Lower means predictions are closer to the points.</p>
      </div>
      <div className={styles.controls}>
        <fieldset className={styles.controlGroup} disabled={disabled}>
          <legend>Model flexibility</legend>
          <p id={`${formId}-degree-help`}>A higher polynomial degree can bend the curve more.</p>
          <div className={styles.segments}>
            {task.config.degrees.map((degree) => <label key={degree} className={styles.segment}>
              <input type="radio" name={`${formId}-degree`} value={degree} checked={response.degree === degree} onChange={() => onChange({ ...response, degree })} aria-describedby={`${formId}-degree-help`} />
              <span><strong>{degree}</strong><small>degree</small></span>
            </label>)}
          </div>
        </fieldset>
        <fieldset className={styles.controlGroup} disabled={disabled}>
          <legend>Regularization</legend>
          <p id={`${formId}-lambda-help`}>A penalty that keeps the model’s coefficients smaller.</p>
          <div className={styles.segments}>
            {task.config.regularizations.map((lambda) => <label key={lambda} className={styles.segment}>
              <input type="radio" name={`${formId}-lambda`} value={lambda} checked={response.lambda === lambda} onChange={() => onChange({ ...response, lambda })} aria-describedby={`${formId}-lambda-help`} />
              <span><strong>{lambda}</strong><small>{lambda === 0 ? "none" : lambda === 0.1 ? "gentle" : "strong"}</small></span>
            </label>)}
          </div>
        </fieldset>
        <div className={styles.startingPoint}>
          <h3>The starting model</h3>
          <p>Degree 7, no penalty. It fits every training point, including the noise.</p>
          <dl><div><dt>Training error</dt><dd>{formatError(baseline.trainRmse)}</dd></div><div><dt>Validation error</dt><dd>{formatError(baseline.validationRmse)}</dd></div></dl>
        </div>
      </div>
    </div>

    <details className={styles.dataDetails}>
      <summary>Inspect the data and fitted model</summary>
      <div className={styles.dataContent}>
        <p>This fixed synthetic dataset uses y = sin(πx). The eight training values contain added noise; the seven validation values do not. The dashed curve shows the known underlying pattern, which is available because this is a synthetic experiment.</p>
        <p>The fit minimizes the sum of squared training errors plus λ times the sum of squared coefficients, excluding the intercept. The axes stay fixed across all settings.</p>
        {fit && <>
          <p><strong>Current fit:</strong> degree {response.degree}, λ = {response.lambda}. Training RMSE {fit.trainRmse.toFixed(6)}; validation RMSE {fit.validationRmse.toFixed(6)}.</p>
          <p className={styles.coefficients}>Coefficients from a₀ to a{response.degree}: {fit.coefficients.map((value) => value.toFixed(6)).join(", ")}</p>
          <div className={styles.dataTables}>
            {([{ title: "Training points", points: DATASET.train }, { title: "Validation points", points: DATASET.validation }]).map(({ title, points }) => <div className={styles.tableScroll} key={title}>
              <table><caption>{title}</caption><thead><tr><th scope="col">x</th><th scope="col">Observed y</th><th scope="col">Model y</th></tr></thead><tbody>
                {points.map((point) => <tr key={point.x}><td>{point.x.toFixed(1)}</td><td>{point.y.toFixed(4)}</td><td>{evaluatePolynomial(fit.coefficients, point.x).toFixed(4)}</td></tr>)}
              </tbody></table>
            </div>)}
          </div>
        </>}
      </div>
    </details>

    <fieldset className={styles.explanation} disabled={disabled}>
      <legend>Why isn’t a perfect training fit enough?</legend>
      <div className={styles.explanationOptions}>
        {explanationOptions.map((option) => <label className={styles.explanationChoice} key={option.value}>
          <input type="radio" name={`${formId}-explanation`} checked={response.explanation === option.value} onChange={() => onChange({ ...response, explanation: option.value })} />
          <span>{option.label}</span>
        </label>)}
      </div>
    </fieldset>
    <details className={styles.reflection}>
      <summary>Keep a note about what you noticed <span>Optional</span></summary>
      <div className={styles.reflectionField}><Textarea id={`${formId}-reflection`} label="Your observation" value={response.reflection} onChange={(event) => onChange({ ...response, reflection: event.target.value })} maxLength={1200} rows={3} disabled={disabled} hint="Saved with this practice on this device. Your note is not graded." /></div>
    </details>
  </div>;
}
