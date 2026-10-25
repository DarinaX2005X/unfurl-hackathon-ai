"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/feedback";
import type { JsonValue } from "@/domain/common";
import type { ApiError } from "@/domain/errors";
import { canonicalResponseJson, isCurrentObservation, responseDigest, type ActionReceipt, type ActivityAction, type InputIdentity } from "@/domain/activity";
import type { Block, Expr, NamedQuantity, Unit } from "@/domain/mechanic-families/v2/shared";
import type { TaskRendererProps } from "@/features/learning/player/contracts";
import styles from "./investigation.module.css";

export const formatNumber = (value: number) => new Intl.NumberFormat("en", {
  maximumSignificantDigits: 9, notation: Math.abs(value) >= 1_000_000 || (value !== 0 && Math.abs(value) < .0001) ? "scientific" : "standard",
}).format(value);
export const unitLabel = (unit: Unit) => ({ unitless: "unitless", ratio: "ratio", percent: "%", byte: "bytes", KB: "KB", MB: "MB", second: "seconds", ms: "ms" })[unit];
export function expressionText(expression: Expr): string {
  if (expression.op === "constant") return formatNumber(expression.value);
  if (expression.op === "variable") return expression.name;
  if (expression.op === "abs") return `abs(${expressionText(expression.value)})`;
  const operator = { add: "+", subtract: "−", multiply: "×", divide: "÷" }[expression.op];
  return `(${expressionText(expression.left)} ${operator} ${expressionText(expression.right)})`;
}
export function WorkSurface({ children }: { children: ReactNode }) { return <div className={styles.workspace}>{children}</div>; }
export function Blocks({ title, items }: { title: string; items: Block[] }) {
  return <section className={styles.reading}><h3>{title}</h3><ul className={styles.facts}>{items.map((block) => <li key={block.id}>{block.text}</li>)}</ul></section>;
}
export function NumberField({ value, onChange, label, disabled, min, max, step, hint }: {
  value: number | null; onChange: (value: number | null) => void; label: string; disabled: boolean;
  min?: number; max?: number; step?: number; hint?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [previous, setPrevious] = useState(value);
  // External resets and restored values replace the draft; partial typed numbers stay editable.
  if (previous !== value) { setPrevious(value); setDraft(value === null ? "" : String(value)); }
  const parsed = draft.trim() === "" ? null : Number(draft);
  const validNumber = parsed !== null && Number.isFinite(parsed);
  const stepIndex = validNumber && min !== undefined && step !== undefined ? (parsed - min) / step : 0;
  const message = draft.trim() && !validNumber ? "Enter a finite number." : validNumber && ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) ? `Use a value from ${min} to ${max}.` :
    validNumber && Math.abs(stepIndex - Math.round(stepIndex)) > 1e-9 ? `Use increments of ${step}.` : undefined;
  return <TextField id={id} label={label} type="text" inputMode="decimal" value={draft} disabled={disabled}
    {...(hint === undefined ? {} : { hint })} {...(message === undefined ? {} : { error: message })}
    onChange={(event) => {
      const text = event.target.value;
      setDraft(text);
      const next = text.trim() === "" ? null : Number(text);
      const valid = next !== null && Number.isFinite(next) ? next : null;
      setPrevious(valid);
      onChange(valid);
    }} />;
}
export function ValueList({ values, title = "Observed values" }: { values: NamedQuantity[]; title?: string }) {
  return <section className={styles.values} aria-label={title}><h3>{title}</h3><dl>{values.map(({ id, quantity }) => <div key={id}><dt>{id}</dt><dd>{formatNumber(quantity.value)} <span>{unitLabel(quantity.unit)}</span></dd></div>)}</dl></section>;
}
function activityError(error: ApiError): string {
  switch (error.error.code) {
    case "unauthenticated": return "Your sign-in needs to be restored before this activity can continue. Your entered work is kept.";
    case "forbidden": case "not_found": return "This activity is not accessible right now. Your entered work is kept.";
    case "revision_conflict": case "idempotency_conflict": return "The saved activity changed. Refresh its history before retrying; your entered work is kept.";
    case "invalid_input": return "The activity could not accept these values. Check the fields and try again.";
    case "rate_limited": return "The activity is temporarily busy. Wait a moment and retry; your entered work is kept.";
    default: return "The activity could not finish. Your work is kept; retry the action.";
  }
}
export function useActivityAction<C extends JsonValue, R extends JsonValue>(props: TaskRendererProps<C, R>) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const latest = useRef(props);
  const running = useRef(false);
  useEffect(() => { latest.current = props; }, [props]);
  async function dispatch(action: ActivityAction, attach: (response: R, receipt: ActionReceipt) => R) {
    if (running.current || props.disabled || props.activity?.pending) return;
    if (!props.activity) { setMessage("This activity is currently unavailable. Your entered work is kept."); return; }
    running.current = true; setPending(true); setMessage(null);
    const original = canonicalResponseJson(props.response);
    const taskId = props.task.id;
    try {
      const result = await props.activity.dispatch(action);
      if (!result.ok) { setMessage(activityError(result.error)); return; }
      if (result.data.status !== "completed") { setMessage(result.data.status === "pending" ? "The observation is still being prepared. Your work is kept." : "The observation could not finish. Your work is kept; retry the action."); return; }
      if (latest.current.task.id !== taskId || canonicalResponseJson(latest.current.response) !== original) {
        setMessage("The observation was saved for the earlier input. Your newer edits are kept."); return;
      }
      latest.current.onChange(attach(latest.current.response, result.data));
    } catch { setMessage("The activity could not finish. Your work is kept; retry the action."); }
    finally { running.current = false; setPending(false); }
  }
  return { dispatch, pending: pending || Boolean(props.activity?.pending), message: message ?? (props.activity?.error ? activityError(props.activity.error) : null) };
}
export function ActivityMessage({ message }: { message: string | null }) { return message ? <Notice tone="warning">{message}</Notice> : null; }
export function useCurrentInput<C extends JsonValue, R extends JsonValue>({ activity, response }: TaskRendererProps<C, R>): InputIdentity | null {
  const key = canonicalResponseJson(response);
  const sessionId = activity?.session?.id;
  const revision = activity?.session?.inputRevision;
  const [resolved, setResolved] = useState<{ key: string; identity: InputIdentity } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (sessionId && revision && revision > 0) {
      void responseDigest(JSON.parse(key) as JsonValue).then((digest) => {
        if (!cancelled) setResolved({ key, identity: { activitySessionId: sessionId, inputRevision: revision, responseDigest: digest } });
      });
    }
    return () => { cancelled = true; };
  }, [key, sessionId, revision]);
  return resolved?.key === key && resolved.identity.activitySessionId === sessionId && resolved.identity.inputRevision === revision ? resolved.identity : null;
}
export function Observation({ receipt, identity }: { receipt: ActionReceipt | undefined; identity: InputIdentity | null }) {
  if (!receipt || receipt.status !== "completed" || receipt.observation?.kind !== "values") return null;
  const current = identity !== null && isCurrentObservation(receipt, identity);
  return <div className={styles.observation} aria-live="polite"><ValueList values={receipt.observation.values} title="Saved observation" />
    <p className={styles.meta}>{current ? "This observation belongs to the current saved input. Checking your answer is a separate step." : "This observation belongs to a recorded input. Edited answers are checked against their saved history."}</p></div>;
}
export function ObservationPlot({ points, inputVariable }: { points: Array<{ id: string; x: number; y: number }>; inputVariable: string }) {
  if (!points.length) return <p className={styles.empty}>Choose a measurement to place its actual result here.</p>;
  const xs = points.map((point) => point.x); const ys = points.map((point) => point.y);
  const xMin = Math.min(0, ...xs); const xMax = Math.max(1, ...xs);
  const yMin = Math.min(0, ...ys); const yMax = Math.max(1, ...ys);
  const xScale = Math.max(Math.abs(xMin), Math.abs(xMax)); const yScale = Math.max(Math.abs(yMin), Math.abs(yMax));
  const x = (value: number) => 5 + (value / xScale - xMin / xScale) / (xMax / xScale - xMin / xScale) * 90;
  const y = (value: number) => 95 - (value / yScale - yMin / yScale) / (yMax / yScale - yMin / yScale) * 90;
  return <div className={styles.measurements}>
    <div className={styles.plot} role="img" aria-label={`Measured output against ${inputVariable}. Both axes are unitless. Exact values are in the measurement table.`}>
      <p className={styles.axisTitle}>Output (unitless)</p>
      <div className={styles.plotGrid}>
        <div className={styles.yTicks} aria-hidden="true"><span>{formatNumber(yMax)}</span><span>{formatNumber((yMax + yMin) / 2)}</span><span>{formatNumber(yMin)}</span></div>
        <div className={styles.plotArea}><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M5 5 V95 H95" className={styles.axes} />
        </svg>{points.map((point) => <span key={point.id} className={styles.point} style={{ left: `${x(point.x)}%`, top: `${y(point.y)}%` }} aria-hidden="true" />)}</div>
        <div className={styles.xTicks} aria-hidden="true"><span>{formatNumber(xMin)}</span><span>{formatNumber((xMax + xMin) / 2)}</span><span>{formatNumber(xMax)}</span></div>
      </div>
      <p className={styles.xTitle}>{inputVariable} (unitless)</p>
    </div>
    <div className={styles.tableScroll}><table className={styles.table}><caption>Recorded measurements</caption><thead><tr><th scope="col">{inputVariable} (unitless)</th><th scope="col">Output (unitless)</th></tr></thead><tbody>{points.map((point) => <tr key={point.id}><td>{formatNumber(point.x)}</td><td>{formatNumber(point.y)}</td></tr>)}</tbody></table></div>
  </div>;
}
