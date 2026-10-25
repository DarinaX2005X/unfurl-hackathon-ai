"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { canonicalResponseJson, responseDigest } from "@/domain/activity";
import { parsePythonPublicObservation, PythonSourceSchema, type PythonArtifactConfig, type PythonArtifactResponse, type PythonRepairConfig, type PythonRepairResponse } from "@/domain/mechanic-families/v3/python";
import type { TaskRendererProps } from "@/features/learning/player/contracts";
import { toggleFaultLine } from "./fault-regions";
import styles from "./python.module.css";

type Config = PythonArtifactConfig | PythonRepairConfig;
type Response = PythonArtifactResponse | PythonRepairResponse;

function SourceEditor({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const leaveWithTab = useRef(false);
  return <div className={styles.editor}><label htmlFor={id}>Your Python function</label>
    <p id={`${id}-help`}>Implement <code>solve(payload)</code>. Tab inserts four spaces; press Escape then Tab to leave the editor. Up to 300 lines and 12,000 UTF-8 bytes.</p>
    <textarea id={id} value={value} disabled={disabled} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby={`${id}-help`} rows={Math.min(24, Math.max(9, value.split("\n").length + 2))}
      onChange={(event) => { const parsed = PythonSourceSchema.safeParse(event.target.value); if (parsed.success) { setError(null); onChange(parsed.data); } else setError("That edit exceeds the source limit. Shorten it before adding more code."); }}
      onBlur={() => { leaveWithTab.current = false; }}
      onKeyDown={(event) => { if (event.key === "Escape") { leaveWithTab.current = true; return; } if (event.key !== "Tab" || event.shiftKey || leaveWithTab.current) return; event.preventDefault(); const target = event.currentTarget;
        const at = target.selectionStart; const next = `${value.slice(0, at)}    ${value.slice(target.selectionEnd)}`;
        const parsed = PythonSourceSchema.safeParse(next); if (!parsed.success) return; onChange(parsed.data);
        requestAnimationFrame(() => { target.selectionStart = at + 4; target.selectionEnd = at + 4; }); }} />
    {error && <p role="alert">{error}</p>}
  </div>;
}

function PythonWorkspace({ task, response, onChange, disabled, activity }: TaskRendererProps<Config, Response>) {
  const key = canonicalResponseJson(response);
  const [digest, setDigest] = useState<{ key: string; value: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => { let active = true; void responseDigest(response).then((value) => { if (active) setDigest({ key, value }); }).catch(() => {}); return () => { active = false; }; }, [key, response]);
  const event = activity?.session?.events.filter((item) => item.action.kind === "run").at(-1);
  const receipt = event?.receipt;
  const current = receipt && digest?.key === key && receipt.input.responseDigest === digest.value && receipt.input.activitySessionId === activity?.session?.id && receipt.input.inputRevision === activity.session.inputRevision;
  let observation = null;
  if (receipt?.observation) { try { observation = parsePythonPublicObservation(task.config, receipt.observation); } catch { /* Reject unmatched public case projections. */ } }
  const pending = running || activity?.pending || receipt?.status === "pending";
  const canRun = Boolean(activity?.session?.status === "active" && activity.session.remainingActions > 0);
  const run = async (retry = false) => {
    if (!activity || running) return;
    setRunning(true); setLocalError(null);
    try { const result = retry && receipt ? await activity.retryAction(receipt.id) : await activity.dispatch({ kind: "run" });
      if (!result.ok) setLocalError("The run could not be confirmed. Your code is retained; retry the same run.");
    } catch { setLocalError("The run could not be confirmed. Your code is retained."); } finally { setRunning(false); }
  };
  return <div className={styles.workspace}>
    <p className={styles.specification}>{task.config.specification}</p>
    {task.config.kind === "diagnosis_repair" && response.kind === "diagnosis_repair" && <section className={styles.original} aria-label="Identify the fault in the original source">
      <h3>Locate the fault in the original</h3><p>Select the relevant lines, then repair the function below. Select up to eight regions.</p>
      <div className={styles.sourceLines}>{task.config.starterSource.split("\n").map((line, index) => {
        const number = index + 1; const selected = response.locations.some((region) => region.startLine <= number && region.endLine >= number);
        const next = toggleFaultLine(response.locations, number);
        return <label key={number}><input type="checkbox" checked={selected} disabled={disabled || next.length > 8} onChange={() => onChange({ ...response,
          locations: next,
        })} aria-label={`Fault at line ${number}`} /><span aria-hidden="true">{number}</span><code>{line || " "}</code></label>;
      })}</div>
    </section>}
    <SourceEditor value={response.source} disabled={disabled} onChange={(source) => onChange({ ...response, source })} />
    {response.kind === "diagnosis_repair" && <label className={styles.explanation}>Why does this repair work?<textarea value={response.explanation} disabled={disabled} maxLength={2000} rows={4} onChange={(event) => onChange({ ...response, explanation: event.target.value })} /></label>}
    <section className={styles.runs} aria-label="Public Python cases"><div className={styles.runActions}>
      <Button variant="secondary" pending={Boolean(pending)} disabled={disabled || !canRun || Boolean(pending)} onClick={() => void run()}>Run public cases</Button>
      <p>Run executes the code on these inputs. Submit assesses your answer.</p>
    </div>
      {!receipt && <dl>{task.config.publicCases.map((item, index) => <div key={item.id}><dt>Input {index + 1}</dt><dd><pre>{JSON.stringify(item.input, null, 2)}</pre></dd></div>)}</dl>}
      {activity?.session?.remainingActions === 0 && <p>No runs remain. You can still revise and submit your answer.</p>}
      {(localError || activity?.error || receipt?.status === "unavailable") && <div role="alert"><p>{localError ?? "Execution is unavailable. Your code is retained."}</p>
        {receipt?.status === "unavailable" && <Button variant="secondary" disabled={disabled || Boolean(pending)} onClick={() => void run(true)}>Retry this run</Button>}</div>}
      {receipt?.status === "pending" && <p role="status">Your captured code is running. Further edits will need another run.</p>}
      {observation && <div aria-live="polite"><h3>{current ? "Results for your current code" : "Results from an earlier answer"}</h3>{!current && <p>Your current edits have not produced these results.</p>}
        {observation.cases.map((item, index) => <section className={styles.case} key={item.caseId}><h4>Case {index + 1}</h4><dl><div><dt>Input</dt><dd><pre>{JSON.stringify(item.input, null, 2)}</pre></dd></div>
          {item.result.status === "ok" ? <><div><dt>Returned value</dt><dd><pre>{JSON.stringify(item.result.value, null, 2)}</pre></dd></div>{item.result.stdout && <div><dt>Printed output</dt><dd><pre>{item.result.stdout}</pre></dd></div>}</> :
            <div><dt>Execution error{item.result.line ? ` at line ${item.result.line}` : ""}</dt><dd>{item.result.message}</dd></div>}</dl></section>)}
      </div>}
    </section>
  </div>;
}

export function PythonArtifactRenderer(props: TaskRendererProps<PythonArtifactConfig, PythonArtifactResponse>) { return <PythonWorkspace {...props} onChange={(next) => { if (next.kind === "artifact_construction") props.onChange(next); }} />; }
export function PythonRepairRenderer(props: TaskRendererProps<PythonRepairConfig, PythonRepairResponse>) { return <PythonWorkspace {...props} onChange={(next) => { if (next.kind === "diagnosis_repair") props.onChange(next); }} />; }
