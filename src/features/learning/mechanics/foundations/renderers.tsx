"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button, IconButton, Select, Textarea, TextField } from "@/components/ui";
import {
  canonicalNode, confusableDiscriminationDescriptor, counterexampleConstructionDescriptor, exampleConstructionDescriptor,
  normalizeAffineExpression, procedureReconstructionDescriptor, recallReconstructionDescriptor, relationalMappingDescriptor,
  representationTranslationDescriptor, ruleInductionDescriptor,
  type ConfusableDiscriminationConfig, type ConfusableDiscriminationResponse,
  type CounterexampleConstructionConfig, type CounterexampleConstructionResponse,
  type ExampleConstructionConfig, type ExampleConstructionResponse,
  type ProcedureReconstructionConfig, type ProcedureReconstructionResponse,
  type RecallReconstructionConfig, type RecallReconstructionResponse,
  type RelationalMappingConfig, type RelationalMappingResponse,
  type RepresentationTranslationConfig, type RepresentationTranslationResponse,
  type RuleInductionConfig, type RuleInductionResponse,
} from "@/domain/mechanic-families/v2/foundations";
import type { Expr, Span, SubmissionIssue } from "@/domain/mechanic-families/v2/shared";
import type { TaskRendererProps } from "@/features/learning/player/contracts";
import styles from "./foundations.module.css";

function Workspace({ children, label }: { children: ReactNode; label: string }) {
  return <section className={styles.workspace} aria-label={label}>{children}</section>;
}
function NumberField({ label, value, onChange, disabled, integer = false, error, min, max }: {
  label: string; value: number | null; onChange: (value: number | null) => void; disabled: boolean;
  integer?: boolean; error?: string | undefined; min?: number; max?: number;
}) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  return <TextField id={id} label={label} type="number" inputMode={integer ? "numeric" : "decimal"} step={integer ? 1 : "any"}
    min={min} max={max} value={value ?? ""} disabled={disabled} error={touched ? error ?? (value === null ? "Enter a number." : undefined) : undefined}
    onBlur={() => setTouched(true)} onChange={(event) => onChange(Number.isFinite(event.currentTarget.valueAsNumber) ? event.currentTarget.valueAsNumber : null)} />;
}
const fieldError = (issues: SubmissionIssue[], path: Array<string | number>) => issues.find((issue) => JSON.stringify(issue.path) === JSON.stringify(path))?.message;
function GroupIssues({ issues }: { issues: SubmissionIssue[] }) {
  if (!issues.length) return null;
  return <ul className={styles.issues} aria-live="polite">{[...new Set(issues.map((issue) => issue.message))].map((message) => <li key={message}>{message}</li>)}</ul>;
}
function formatExpression(node: Expr): string {
  if (node.op === "constant") return String(node.value);
  if (node.op === "variable") return node.name;
  if (node.op === "abs") return `abs(${formatExpression(node.value)})`;
  const symbol = { add: "+", subtract: "−", multiply: "×", divide: "/" }[node.op];
  return `(${formatExpression(node.left)} ${symbol} ${formatExpression(node.right)})`;
}
const displayRelation = (value: string) => value.replaceAll("_", " ");

export function RecallReconstructionRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<RecallReconstructionConfig, RecallReconstructionResponse>) {
  const id = useId();
  return <Workspace label="Recall workspace">
    <p className={styles.cue}>{task.config.cue}</p>
    <Textarea id={id} label="Your answer" rows={6} value={response.text} maxLength={task.config.maxChars} disabled={disabled}
      onChange={(event) => onChange({ ...response, text: event.currentTarget.value })} />
    <output className={styles.editingNote} htmlFor={id}>{response.text.length} / {task.config.maxChars} characters</output>
    <GroupIssues issues={status === "error" ? recallReconstructionDescriptor.validateSubmission(task.config, response) : []} />
  </Workspace>;
}

export function ConfusableDiscriminationRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<ConfusableDiscriminationConfig, ConfusableDiscriminationResponse>) {
  const id = useId();
  const [selection, setSelection] = useState<Span | null>(null);
  const config = task.config;
  const selected = config.cases.find((item) => item.id === response.caseId);
  const addEvidence = (span: Span) => {
    if (response.evidenceSpans.some((existing) => existing.blockId === span.blockId && existing.start === span.start && existing.end === span.end)) return;
    onChange({ ...response, evidenceSpans: [...response.evidenceSpans, span] });
  };
  return <Workspace label="Distinguish cases">
    {config.knownFacts.length > 0 && <div className={styles.context}><h3>Known facts</h3><ul>{config.knownFacts.map((fact) => <li key={fact.id}>{fact.text}</li>)}</ul></div>}
    <p className={styles.cue}>{config.requestedDistinction}</p>
    <fieldset className={styles.caseChoices} disabled={disabled}><legend>Choose the case</legend>
      {config.cases.map((item, index) => <label key={item.id} className={styles.caseChoice} data-selected={response.caseId === item.id}>
        <input type="radio" name={`${id}-case`} value={item.id} checked={response.caseId === item.id}
          onChange={() => { setSelection(null); onChange({ ...response, caseId: item.id, evidenceSpans: [] }); }} />
        <span><strong>Case {index + 1}</strong><span className={styles.caseText}>{item.text}</span></span>
      </label>)}
    </fieldset>
    {selected && <div className={styles.evidenceArea}>
      <Textarea id={`${id}-passage`} label="Select supporting evidence" value={selected.text} readOnly rows={3} disabled={disabled}
        hint="Select a passage with your pointer or hold Shift and use the arrow keys. You can also use the entire case."
        onSelect={(event) => {
          const { selectionStart, selectionEnd } = event.currentTarget;
          setSelection(selectionEnd > selectionStart ? { blockId: selected.id, start: selectionStart, end: selectionEnd } : null);
        }} />
      <div className={styles.actions}>
        <Button variant="secondary" disabled={disabled || !selection || response.evidenceSpans.length >= 20} onClick={() => selection && addEvidence(selection)}>Use selected passage</Button>
        <Button variant="quiet" disabled={disabled || response.evidenceSpans.length >= 20} onClick={() => addEvidence({ blockId: selected.id, start: 0, end: selected.text.length })}>Use entire case</Button>
      </div>
      {response.evidenceSpans.length > 0 && <ul className={styles.evidenceList}>{response.evidenceSpans.map((span, index) => <li key={`${span.blockId}:${span.start}:${span.end}`}>
        <blockquote>{config.cases.find((item) => item.id === span.blockId)?.text.slice(span.start, span.end)}</blockquote>
        <IconButton label={`Remove evidence passage ${index + 1}`} icon={<X size={18} />} disabled={disabled}
          onClick={() => onChange({ ...response, evidenceSpans: response.evidenceSpans.filter((_, position) => position !== index) })} />
      </li>)}</ul>}
    </div>}
    <Textarea id={`${id}-distinction`} label="What makes these cases different?" rows={4} value={response.distinction} maxLength={4000}
      disabled={disabled} onChange={(event) => onChange({ ...response, distinction: event.currentTarget.value })} />
    <GroupIssues issues={confusableDiscriminationDescriptor.validateSubmission(config, response).filter((issue) => status === "error" || issue.code !== "required")} />
  </Workspace>;
}

export function RuleInductionRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<RuleInductionConfig, RuleInductionResponse>) {
  const config = task.config;
  let coefficients = { slope: null as number | null, intercept: null as number | null };
  if (response.rule.form === "coefficients") coefficients = response.rule;
  else if (response.rule.expression) {
    try { coefficients = normalizeAffineExpression(response.rule.expression); } catch { /* The editable expression remains visible for correction. */ }
  }
  const update = (part: "slope" | "intercept", value: number | null) => onChange({ ...response, rule: { form: "coefficients", ...coefficients, [part]: value } });
  return <Workspace label="Infer an affine rule">
    <div className={styles.inductionLayout}>
      <div className={styles.tableWrap}><table className={styles.dataTable}><caption>Observed examples</caption><thead><tr><th scope="col">Input x</th><th scope="col">Output y</th></tr></thead>
        <tbody>{config.pairs.map(([x, y], index) => <tr key={index}><td>{x}</td><td>{y}</td></tr>)}</tbody></table></div>
      <div className={styles.ruleArea}>
        <h3>Your rule</h3>
        <p className={styles.formula}>y = slope × x + intercept</p>
        {response.rule.form === "expression" && response.rule.expression && <output className={styles.expression}>Current expression: {formatExpression(response.rule.expression)}</output>}
        <div className={styles.numericPair}>
          <NumberField label="Slope" value={coefficients.slope} disabled={disabled} onChange={(value) => update("slope", value)} />
          <NumberField label="Intercept" value={coefficients.intercept} disabled={disabled} onChange={(value) => update("intercept", value)} />
        </div>
      </div>
    </div>
    <fieldset className={styles.probes} disabled={disabled}><legend>Apply your rule to new inputs</legend>
      <div className={styles.numericGrid}>{config.probeXs.map((x, index) => <NumberField key={index} label={`Output when x = ${x}`} value={response.probeValues[index] ?? null}
        disabled={disabled} onChange={(value) => onChange({ ...response, probeValues: config.probeXs.map((_, position) => position === index ? value : response.probeValues[position] ?? null) })} />)}</div>
    </fieldset>
    <GroupIssues issues={ruleInductionDescriptor.validateSubmission(config, response).filter((issue) => status === "error" || issue.code !== "required")} />
  </Workspace>;
}

function Matrix({ values, editable, disabled = false, onChange, issues = [] }: {
  values: { tp: number | null; fp: number | null; tn: number | null; fn: number | null };
  editable: boolean; disabled?: boolean; onChange?: (key: "tp" | "fp" | "tn" | "fn", value: number | null) => void; issues?: SubmissionIssue[];
}) {
  const cells = [["tp", "fn"], ["fp", "tn"]] as const;
  const labels = { tp: "True positives", fn: "False negatives", fp: "False positives", tn: "True negatives" };
  return <div className={styles.tableWrap}><table className={styles.matrix}><caption>Confusion matrix</caption>
    <thead><tr><th scope="col">Actual outcome</th><th scope="col">Predicted positive</th><th scope="col">Predicted negative</th></tr></thead>
    <tbody>{cells.map((keys, index) => <tr key={index}><th scope="row">{index === 0 ? "Positive" : "Negative"}</th>{keys.map((key) => <td key={key}>
      {editable ? <NumberField label={labels[key]} value={values[key]} integer min={0} max={1_000_000} disabled={disabled}
        error={fieldError(issues, ["matrix", key])} onChange={(value) => onChange?.(key, value)} /> : <><span className={styles.cellLabel}>{labels[key]}</span><strong className={styles.cellValue}>{values[key]}</strong></>}
    </td>)}</tr>)}</tbody>
  </table></div>;
}

export function ExampleConstructionRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<ExampleConstructionConfig, ExampleConstructionResponse>) {
  const c = task.config.constraints;
  const issues = exampleConstructionDescriptor.validateSubmission(task.config, response);
  const complete = Object.values(response.matrix).every((value) => value !== null);
  const total = Object.values(response.matrix).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return <Workspace label="Construct a confusion matrix">
    <div className={styles.conditions}><h3>Build a matrix with these properties</h3><ul>
      <li>{c.total} predictions in total</li><li>Exactly {c.falsePositive} false positives</li>
      <li>At least {c.minTruePositive} true positives</li><li>At least {c.minFalseNegative} false negatives</li>
    </ul></div>
    <Matrix values={response.matrix} editable disabled={disabled} issues={issues}
      onChange={(key, value) => onChange({ ...response, matrix: { ...response.matrix, [key]: value } })} />
    <output className={styles.editingNote} aria-live="polite">{complete ? `Your cells contain ${total} predictions in total.` : "Fill all four cells, including any zeros."}</output>
    <GroupIssues issues={status === "error" ? issues : []} />
  </Workspace>;
}

export function CounterexampleConstructionRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<CounterexampleConstructionConfig, CounterexampleConstructionResponse>) {
  const dataRowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingRowFocus = useRef<string | null>(null);
  useEffect(() => {
    if (pendingRowFocus.current) dataRowRefs.current.get(pendingRowFocus.current)?.querySelector<HTMLInputElement>("input")?.focus();
    pendingRowFocus.current = null;
  }, [response.train.length, response.validation.length]);
  const issues = counterexampleConstructionDescriptor.validateSubmission(task.config, response);
  const updateRow = (group: "train" | "validation", index: number, key: "x" | "y", value: number | null) => onChange({
    ...response, [group]: response[group].map((row, position) => position === index ? { ...row, [key]: value } : row),
  });
  return <Workspace label="Construct a counterexample">
    <blockquote className={styles.claim}>{task.config.claim}</blockquote>
    <div className={styles.constantModel}><NumberField label="Constant prediction for every input" value={response.model.constant} disabled={disabled}
      onChange={(value) => onChange({ ...response, model: { constant: value } })} />
      <p>The predictor returns this same number for every x. Build data that tests the claim.</p></div>
    <div className={styles.datasetPair}>{(["train", "validation"] as const).map((group) => {
      const limit = group === "train" ? task.config.maxTrainRows : task.config.maxValidationRows;
      const title = group === "train" ? "Training data" : "Validation data";
      return <section className={styles.dataset} key={group} aria-label={title}><h3>{title}</h3>
        {response[group].length > 0 ? <div className={styles.dataRows}>{response[group].map((row, index) => <div className={styles.dataRow} key={index}
          ref={(node) => { const key = `${group}-${index}`; if (node) dataRowRefs.current.set(key, node); else dataRowRefs.current.delete(key); }}>
          <NumberField label={`Row ${index + 1}: input x`} value={row.x} disabled={disabled} onChange={(value) => updateRow(group, index, "x", value)} />
          <NumberField label={`Row ${index + 1}: target y`} value={row.y} disabled={disabled} onChange={(value) => updateRow(group, index, "y", value)} />
          <IconButton label={`Remove ${group === "train" ? "training" : "validation"} row ${index + 1}`} icon={<X size={18} />} disabled={disabled}
            onClick={() => onChange({ ...response, [group]: response[group].filter((_, position) => position !== index) })} />
        </div>)}</div> : <p className={styles.empty}>No rows added</p>}
        <Button variant="secondary" disabled={disabled || response[group].length >= limit}
          onClick={() => { pendingRowFocus.current = `${group}-${response[group].length}`; onChange({ ...response, [group]: [...response[group], { x: null, y: null }] }); }}><Plus size={18} aria-hidden="true" />Add {group === "train" ? "training" : "validation"} row</Button>
        <output className={styles.editingNote}>{response[group].length} / {limit} rows</output>
      </section>;
    })}</div>
    <GroupIssues issues={issues.filter((issue) => status === "error" || issue.code !== "required")} />
  </Workspace>;
}

export function ProcedureReconstructionRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<ProcedureReconstructionConfig, ProcedureReconstructionResponse>) {
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const availableRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (pendingFocus.current === "__available__") availableRef.current?.focus();
    else if (pendingFocus.current) rowRefs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [response.stepIds]);
  const move = (index: number, change: number) => {
    const ids = [...response.stepIds];
    const current = ids[index]!;
    [ids[index], ids[index + change]] = [ids[index + change]!, current];
    onChange({ ...response, stepIds: ids });
    setAnnouncement(`Step moved to position ${index + change + 1}.`);
  };
  const unplaced = task.config.steps.filter((step) => !response.stepIds.includes(step.id));
  return <Workspace label="Reconstruct a procedure">
    <div className={styles.orderHeader}><h3>Your procedure</h3><output>{response.stepIds.length} of {task.config.steps.length} steps placed</output></div>
    {response.stepIds.length === 0 ? <p className={styles.empty}>Choose the first step from the available steps.</p> : <ol className={styles.orderedSteps}>
      {response.stepIds.map((id, index) => <li key={id} tabIndex={-1} ref={(node) => { if (node) rowRefs.current.set(id, node); else rowRefs.current.delete(id); }}>
        <span className={styles.position}>{index + 1}</span><p>{task.config.steps.find((step) => step.id === id)?.text ?? "Unknown step"}</p>
        <div className={styles.orderActions}>
          <IconButton label={`Move step ${index + 1} earlier`} icon={<ArrowUp size={18} />} disabled={disabled || index === 0} onClick={() => move(index, -1)} />
          <IconButton label={`Move step ${index + 1} later`} icon={<ArrowDown size={18} />} disabled={disabled || index === response.stepIds.length - 1} onClick={() => move(index, 1)} />
          <IconButton label={`Remove step ${index + 1} from the procedure`} icon={<X size={18} />} disabled={disabled}
            onClick={() => {
              pendingFocus.current = response.stepIds[index + 1] ?? response.stepIds[index - 1] ?? "__available__";
              onChange({ ...response, stepIds: response.stepIds.filter((_, position) => position !== index) });
              setAnnouncement("Step returned to the available steps.");
            }} />
        </div>
      </li>)}
    </ol>}
    {unplaced.length > 0 && <section className={styles.availableSteps} aria-label="Available steps"><h3 ref={availableRef} tabIndex={-1}>Available steps</h3>
      {unplaced.map((step) => <Button key={step.id} variant="secondary" className={styles.placeStep} disabled={disabled}
        onClick={() => { pendingFocus.current = step.id; onChange({ ...response, stepIds: [...response.stepIds, step.id] }); setAnnouncement(`Step placed at position ${response.stepIds.length + 1}.`); }}>
        <Plus size={18} aria-hidden="true" /><span>{step.text}</span>
      </Button>)}
    </section>}
    <p className={styles.srOnly} role="status">{announcement}</p>
    <GroupIssues issues={procedureReconstructionDescriptor.validateSubmission(task.config, response).filter((issue) => status === "error" || issue.code !== "required")} />
  </Workspace>;
}

function RelationGraph({ config, response }: { config: RelationalMappingConfig; response: RelationalMappingResponse }) {
  const marker = useId();
  const title = useId();
  const columns = Math.min(4, config.nodes.length);
  const rows = Math.ceil(config.nodes.length / columns);
  const height = Math.max(160, rows * 120);
  const point = (id: string) => {
    const index = config.nodes.findIndex((node) => node.id === canonicalNode(config, id));
    return index < 0 ? null : { x: 64 + (index % columns) * (512 / Math.max(1, columns - 1)), y: 55 + Math.floor(index / columns) * 120 };
  };
  return <div className={styles.graphLayout}><svg viewBox={`0 0 640 ${height}`} className={styles.graph} role="img" aria-labelledby={title}>
    <title id={title}>{`${config.nodes.length} concepts and ${response.edges.length} directed relations. Numbered concepts and relation fields are listed beside and below the map.`}</title>
    <defs><marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor" /></marker></defs>
    {response.edges.map((edge, index) => {
      const from = point(edge.from), to = point(edge.to);
      if (!from || !to) return null;
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
      const bend = (index % 2 === 0 ? 1 : -1) * 34;
      const cx = (from.x + to.x) / 2 + (length ? -dy / length * bend : 38);
      const cy = (from.y + to.y) / 2 + (length ? dx / length * bend : -44);
      const path = length ? `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x - dx / length * 25} ${to.y - dy / length * 25}` :
        `M ${from.x + 15} ${from.y - 15} C ${from.x + 65} ${from.y - 70} ${from.x - 65} ${from.y - 70} ${from.x - 15} ${from.y - 22}`;
      return <g key={index} className={styles.graphEdge}><path d={path} markerEnd={`url(#${marker})`} /><text x={cx} y={cy - 6} textAnchor="middle">{index + 1}</text></g>;
    })}
    {config.nodes.map((node, index) => { const p = point(node.id)!; return <g key={node.id} className={styles.graphNode} transform={`translate(${p.x} ${p.y})`}><circle r="23" /><text textAnchor="middle" dominantBaseline="central">{index + 1}</text></g>; })}
  </svg><ol className={styles.nodeLegend}>{config.nodes.map((node) => <li key={node.id}>{node.text}</li>)}</ol></div>;
}

export function RelationalMappingRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<RelationalMappingConfig, RelationalMappingResponse>) {
  const id = useId();
  const relationRefs = useRef(new Map<number, HTMLFieldSetElement>());
  const pendingRelationFocus = useRef<number | null>(null);
  useEffect(() => {
    if (pendingRelationFocus.current !== null) relationRefs.current.get(pendingRelationFocus.current)?.querySelector<HTMLSelectElement>("select")?.focus();
    pendingRelationFocus.current = null;
  }, [response.edges.length]);
  const config = task.config;
  const nodeOptions = [
    ...config.nodes.map((node) => ({ value: node.id, label: node.text })),
    ...Object.entries(config.aliases).map(([alias, target]) => ({ value: alias, label: `${displayRelation(alias)} (alias of ${config.nodes.find((node) => node.id === target)?.text})` })),
  ];
  const issues = relationalMappingDescriptor.validateSubmission(config, response);
  return <Workspace label="Build a relation map">
    <RelationGraph config={config} response={response} />
    <div className={styles.relationRows}>{response.edges.map((edge, index) => <fieldset key={index} className={styles.relationRow} disabled={disabled}
      ref={(node) => { if (node) relationRefs.current.set(index, node); else relationRefs.current.delete(index); }}>
      <legend>Relation {index + 1}</legend>
      <div className={styles.relationFields}>
        <Select id={`${id}-${index}-from`} label="From" options={nodeOptions} value={edge.from} disabled={disabled}
          onChange={(event) => onChange({ ...response, edges: response.edges.map((item, position) => position === index ? { ...item, from: event.currentTarget.value } : item) })} />
        <Select id={`${id}-${index}-relation`} label="Relationship" options={config.relationTypes.map((relation) => ({ value: relation, label: displayRelation(relation) }))} value={edge.relation} disabled={disabled}
          onChange={(event) => onChange({ ...response, edges: response.edges.map((item, position) => position === index ? { ...item, relation: event.currentTarget.value } : item) })} />
        <Select id={`${id}-${index}-to`} label="To" options={nodeOptions} value={edge.to} disabled={disabled}
          onChange={(event) => onChange({ ...response, edges: response.edges.map((item, position) => position === index ? { ...item, to: event.currentTarget.value } : item) })} />
        <IconButton label={`Remove relation ${index + 1}`} icon={<X size={18} />} disabled={disabled}
          onClick={() => onChange({ ...response, edges: response.edges.filter((_, position) => position !== index) })} />
      </div>
    </fieldset>)}</div>
    <Button variant="secondary" disabled={disabled || response.edges.length >= 48} onClick={() => { pendingRelationFocus.current = response.edges.length; onChange({ ...response, edges: [...response.edges, {
      from: config.nodes[response.edges.length % config.nodes.length]!.id,
      relation: config.relationTypes[0]!, to: config.nodes[(response.edges.length + 1) % config.nodes.length]!.id,
    }] }); }}><Plus size={18} aria-hidden="true" />Add relation</Button>
    <GroupIssues issues={issues.filter((issue) => status === "error" || issue.code !== "required")} />
  </Workspace>;
}

export function RepresentationTranslationRenderer({ task, response, onChange, disabled, status }: TaskRendererProps<RepresentationTranslationConfig, RepresentationTranslationResponse>) {
  const id = useId();
  return <Workspace label="Translate the matrix into a metric">
    <Matrix values={task.config.from} editable={false} />
    <fieldset className={styles.metricAnswer} disabled={disabled}><legend>Express the {task.config.to}</legend>
      <div className={styles.numericPair}>
        <NumberField label={task.config.to.charAt(0).toUpperCase() + task.config.to.slice(1)} value={response.quantity.value} disabled={disabled}
          onChange={(value) => onChange({ ...response, quantity: { ...response.quantity, value } })} />
        <Select id={`${id}-unit`} label="Unit" value={response.quantity.unit ?? ""} disabled={disabled}
          options={[{ value: "", label: "Choose a unit", disabled: true }, ...task.config.allowedUnits.map((unit) => ({ value: unit, label: unit === "percent" ? "Percent (%)" : "Ratio" }))]}
          onChange={(event) => onChange({ ...response, quantity: { ...response.quantity, unit: event.currentTarget.value as "ratio" | "percent" } })} />
      </div>
    </fieldset>
    <GroupIssues issues={representationTranslationDescriptor.validateSubmission(task.config, response).filter((issue) => status === "error" || issue.code !== "required")} />
  </Workspace>;
}
