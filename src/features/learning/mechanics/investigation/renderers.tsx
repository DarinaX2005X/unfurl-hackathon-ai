"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/field";
import type { TaskRendererProps } from "@/features/learning/player/contracts";
import { isCurrentObservation, sameInputIdentity } from "@/domain/activity";
import {
  outcomePredictionDescriptor, causalInterventionDescriptor, evaluateCausalModel,
  type StateTracingConfig, type StateTracingResponse, type OutcomePredictionConfig, type OutcomePredictionResponse,
  type CauseDiagnosisConfig, type CauseDiagnosisResponse, type ExperimentalInvestigationConfig, type ExperimentalInvestigationResponse,
  type CausalInterventionConfig, type CausalInterventionResponse, type EstimationConfig, type EstimationResponse,
  type StrategySelectionConfig, type StrategySelectionResponse, type SourceInvestigationConfig, type SourceInvestigationResponse,
} from "@/domain/mechanic-families/v2/investigation";
import type { Unit } from "@/domain/mechanic-families/v2/shared";
import { ActivityMessage, Blocks, NumberField, Observation, ObservationPlot, ValueList, WorkSurface,
  expressionText, formatNumber, unitLabel, useActivityAction, useCurrentInput } from "./common";
import styles from "./investigation.module.css";

export function StateTracingRenderer({ task, response, onChange, disabled }: TaskRendererProps<StateTracingConfig, StateTracingResponse>) {
  const config = task.config;
  const stateNames = Object.keys(config.initial);
  const inputNames = Object.keys(config.inputs[0]!);
  return <WorkSurface>
    <section className={styles.model}><h3>Trace the state after each input</h3><p>Every update uses the previous state. Apply all updates together before moving to the next step.</p>
      <div className={styles.equations}>{stateNames.map((name) => <p key={name}><strong>{name}</strong> = {expressionText(config.updates[name]!)} <span>({unitLabel(config.units[name]!)})</span></p>)}</div>
      <dl className={styles.initial}>{stateNames.map((name) => <div key={name}><dt>Initial {name}</dt><dd>{formatNumber(config.initial[name]!)} {unitLabel(config.units[name]!)}</dd></div>)}</dl>
    </section>
    <div className={styles.traceSteps}>{config.inputs.map((input, index) => <fieldset className={styles.traceStep} key={index}><legend>Step {index + 1}</legend>
      <dl className={styles.inputValues}>{inputNames.map((name) => <div key={name}><dt>{name}</dt><dd>{formatNumber(input[name]!)}</dd></div>)}</dl>
      <div className={styles.fields}>{stateNames.map((name) => <NumberField key={name} label={`${name} after step ${index + 1} (${unitLabel(config.units[name]!)})`} value={response.states[index]?.[name] ?? null} disabled={disabled}
        onChange={(value) => onChange({ ...response, states: config.inputs.map((_, step) => step === index ? { ...response.states[step], [name]: value } : response.states[step] ?? {}) })} />)}</div>
    </fieldset>)}</div>
  </WorkSurface>;
}

export function OutcomePredictionRenderer(props: TaskRendererProps<OutcomePredictionConfig, OutcomePredictionResponse>) {
  const { task, response, onChange } = props; const config = task.config;
  const action = useActivityAction(props); const currentInput = useCurrentInput(props); const id = useId();
  const events = props.activity?.session?.events ?? [];
  const recoverableCommit = events.find((event) => event.action.kind === "prediction.commit" && event.receipt.status === "completed" && currentInput !== null && sameInputIdentity(event.receipt.input, currentInput));
  const committed = response.commitReceiptId !== null || events.some((event) => event.action.kind === "prediction.commit" && event.receipt.status === "completed");
  const recoverableObservation = [...events].reverse().find((event) => event.action.kind === "run" && currentInput !== null && isCurrentObservation(event.receipt, currentInput));
  const observation = events.find((event) => event.receipt.id === response.observationReceiptId)?.receipt ?? recoverableObservation?.receipt;
  const disabled = props.disabled || action.pending;
  const intervalIssues = outcomePredictionDescriptor.validateSubmission(config, response).filter((item) => item.path[0] === "interval");
  return <WorkSurface>
    <section className={styles.model}><h3>Predict before observing</h3><div className={styles.equations}>{config.model.outputs.map((output) => <p key={output.id}><strong>{output.id}</strong> = {expressionText(output.expression)} <span>({unitLabel(output.unit)})</span></p>)}</div>
      <dl className={styles.initial}>{config.model.inputs.map((input) => <div key={input.id}><dt>{input.id}</dt><dd>{formatNumber(config.settings[input.id]!)} {unitLabel(input.unit)}</dd></div>)}</dl>
    </section>
    <section className={styles.response}><h3>Your interval for {config.targetOutputId}</h3><p>Commit your bounds before running the model. The committed interval stays in your activity history.</p>
      <div className={styles.interval}><NumberField label="Lower bound" value={response.interval.lower} disabled={disabled || committed} onChange={(lower) => onChange({ ...response, interval: { ...response.interval, lower } })} />
        <NumberField label="Upper bound" value={response.interval.upper} disabled={disabled || committed} onChange={(upper) => onChange({ ...response, interval: { ...response.interval, upper } })} />
        <Select id={id} label="Unit" value={response.interval.unit ?? ""} disabled={disabled || committed} options={[{ value: "", label: "Choose a unit" }, ...config.allowedUnits.map((unit) => ({ value: unit, label: unitLabel(unit) }))]} onChange={(event) => onChange({ ...response, interval: { ...response.interval, unit: event.target.value === "" ? null : event.target.value as Unit } })} /></div>
      <p className={styles.meta}>Maximum interval width: {formatNumber(config.maxIntervalWidth)} {unitLabel(config.model.outputs.find((output) => output.id === config.targetOutputId)!.unit)}</p>
      <div className={styles.actions}><Button disabled={disabled || (committed && !(recoverableCommit && response.commitReceiptId === null)) || intervalIssues.length > 0} pending={action.pending} onClick={() => {
        if (recoverableCommit && response.commitReceiptId === null) onChange({ ...response, commitReceiptId: recoverableCommit.receipt.id });
        else void action.dispatch({ kind: "prediction.commit" }, (current, receipt) => ({ ...current, commitReceiptId: receipt.id }));
      }}>{recoverableCommit && response.commitReceiptId === null ? "Restore saved commitment" : committed ? "Prediction committed" : "Commit prediction"}</Button>
        <Button variant="secondary" disabled={disabled || !response.commitReceiptId || Boolean(observation)} onClick={() => void action.dispatch({ kind: "run" }, (current, receipt) => ({ ...current, observationReceiptId: receipt.id }))}>Run model</Button></div>
      <ActivityMessage message={action.message} />
    </section>
    {!response.observationReceiptId && recoverableObservation && <Button variant="secondary" disabled={disabled} onClick={() => onChange({ ...response, observationReceiptId: recoverableObservation.receipt.id })}>Use recorded observation</Button>}
    <Observation receipt={observation} identity={currentInput} />
  </WorkSurface>;
}

export function CauseDiagnosisRenderer({ task, response, onChange, disabled }: TaskRendererProps<CauseDiagnosisConfig, CauseDiagnosisResponse>) {
  const id = useId();
  return <WorkSurface><Blocks title="Observed evidence" items={task.config.observations} />
    <fieldset className={styles.choiceGroup}><legend>Which causes remain consistent?</legend>{task.config.candidateCauses.map((cause) => <label className={styles.choice} key={cause.id} data-selected={response.consistentCauseIds.includes(cause.id) || undefined}>
      <input type="checkbox" checked={response.consistentCauseIds.includes(cause.id)} disabled={disabled} onChange={(event) => onChange({ ...response, consistentCauseIds: event.target.checked ? [...response.consistentCauseIds, cause.id] : response.consistentCauseIds.filter((item) => item !== cause.id) })} /><span>{cause.text}</span></label>)}</fieldset>
    <Select id={`${id}-conclusion`} label="What can you conclude?" value={response.conclusion ?? ""} disabled={disabled} options={[{ value: "", label: "Choose a conclusion" }, { value: "identified", label: "The evidence identifies a cause" }, { value: "unidentified", label: "The cause remains unresolved" }]} onChange={(event) => onChange({ ...response, conclusion: event.target.value === "" ? null : event.target.value as "identified" | "unidentified" })} />
    <Textarea id={`${id}-evidence`} label="Evidence that would distinguish the causes" hint="Explain how the existing observations support your conclusion and what another observation would resolve." rows={4} maxLength={4000} value={response.neededEvidence} disabled={disabled} onChange={(event) => onChange({ ...response, neededEvidence: event.target.value })} />
  </WorkSurface>;
}

export function ExperimentalInvestigationRenderer(props: TaskRendererProps<ExperimentalInvestigationConfig, ExperimentalInvestigationResponse>) {
  const { task, response, onChange } = props; const config = task.config; const id = useId();
  const [input, setInput] = useState(config.allowedInputs[0]!); const action = useActivityAction(props);
  const events = props.activity?.session?.events ?? [];
  const queries = events.filter((event) => event.action.kind === "experiment.query");
  const points = queries.flatMap((event) => {
    if (event.action.kind !== "experiment.query" || event.receipt.status !== "completed" || event.receipt.observation?.kind !== "values") return [];
    const outcome = event.receipt.observation.values.find((value) => value.id === "outcome" && value.quantity.unit === "unitless");
    return outcome ? [{ id: event.receipt.id, x: event.action.input, y: outcome.quantity.value }] : [];
  });
  const remaining = Math.max(0, Math.min(config.queryBudget - queries.length, props.activity?.session?.remainingActions ?? config.queryBudget));
  const disabled = props.disabled || action.pending;
  return <WorkSurface><section className={styles.model}><h3>Choose a measurement that separates the hypotheses</h3><div className={styles.hypotheses}>{config.hypotheses.map((hypothesis) => <p key={hypothesis.id}><strong>{hypothesis.id}</strong><span>Output = {expressionText(hypothesis.expression)}</span></p>)}</div></section>
    <div className={styles.lab}><div className={styles.labControl}><Select id={`${id}-input`} label={`${config.inputVariable} to measure (unitless)`} value={String(input)} disabled={disabled} options={config.allowedInputs.map((value) => ({ value: String(value), label: formatNumber(value) }))} onChange={(event) => setInput(Number(event.target.value))} />
      <Button disabled={disabled || remaining === 0} pending={action.pending} onClick={() => void action.dispatch({ kind: "experiment.query", input }, (current, receipt) => ({ ...current, observationReceiptIds: current.observationReceiptIds.includes(receipt.id) ? current.observationReceiptIds : [...current.observationReceiptIds, receipt.id] }))}>Measure output</Button>
      <p className={styles.meta}>{remaining} {remaining === 1 ? "measurement" : "measurements"} remaining</p><ActivityMessage message={action.message} /></div>
      <ObservationPlot points={points} inputVariable={config.inputVariable} /></div>
    {points.some((point) => !response.observationReceiptIds.includes(point.id)) && <Button variant="secondary" disabled={disabled} onClick={() => onChange({ ...response, observationReceiptIds: points.map((point) => point.id) })}>Use recorded measurements</Button>}
    <section className={styles.response}><h3>Explain what the measurements establish</h3><Select id={`${id}-conclusion`} label="Conclusion" value={response.conclusionHypothesisId ?? ""} disabled={disabled} options={[{ value: "", label: "The evidence is inconclusive" }, ...config.hypotheses.map((hypothesis) => ({ value: hypothesis.id, label: hypothesis.id }))]} onChange={(event) => onChange({ ...response, conclusionHypothesisId: event.target.value || null })} />
      <Textarea id={`${id}-rationale`} label="Reasoning from your measurements" rows={4} maxLength={4000} value={response.rationale} disabled={disabled} onChange={(event) => onChange({ ...response, rationale: event.target.value })} /></section>
  </WorkSurface>;
}

export function CausalInterventionRenderer(props: TaskRendererProps<CausalInterventionConfig, CausalInterventionResponse>) {
  const { task, response, onChange } = props; const config = task.config; const action = useActivityAction(props); const currentInput = useCurrentInput(props);
  const errors = causalInterventionDescriptor.validateSubmission(config, response).filter((item) => item.path[0] === "assignments");
  const preview = errors.length ? null : evaluateCausalModel(config, response.assignments as Record<string, number>);
  const observations = props.activity?.session?.events ?? [];
  const observation = observations.find((event) => event.receipt.id === response.observationReceiptId)?.receipt;
  const recoverableObservation = [...observations].reverse().find((event) => event.action.kind === "intervention.apply" && currentInput !== null && isCurrentObservation(event.receipt, currentInput));
  const remaining = Math.max(0, Math.min(config.actionBudget - observations.filter((event) => event.action.kind === "intervention.apply").length, props.activity?.session?.remainingActions ?? config.actionBudget));
  const disabled = props.disabled || action.pending;
  return <WorkSurface><section className={styles.model}><h3>Reach {config.target.variableId} = {formatNumber(config.target.quantity.value)}</h3><p>Change the input variables. Derived values follow these equations within this model.</p><div className={styles.equations}>{Object.entries(config.equations).map(([name, expression]) => <p key={name}><strong>{name}</strong> = {expressionText(expression)}</p>)}</div></section>
    <div className={styles.lab}><section className={styles.labControl}><h3>Input intervention</h3>{config.variables.map((variable) => <NumberField key={variable.id} label={`${variable.id} (unitless)`} value={response.assignments[variable.id] ?? null} min={variable.min} max={variable.max} step={variable.step} hint={`Range ${formatNumber(variable.min)} to ${formatNumber(variable.max)}, step ${formatNumber(variable.step)}`} disabled={disabled} onChange={(value) => onChange({ ...response, assignments: { ...response.assignments, [variable.id]: value } })} />)}
      <Button pending={action.pending} disabled={disabled || errors.length > 0 || remaining === 0} onClick={() => void action.dispatch({ kind: "intervention.apply", assignments: response.assignments as Record<string, number> }, (current, receipt) => ({ ...current, observationReceiptId: receipt.id }))}>Apply intervention</Button><p className={styles.meta}>{remaining} {remaining === 1 ? "intervention" : "interventions"} remaining</p><ActivityMessage message={action.message} /></section>
      <section className={styles.preview}>{preview ? <><ValueList values={preview} title="Calculated preview" /><p className={styles.meta}>Apply the intervention to record these inputs and their result. This preview is not a checked answer.</p></> : <p className={styles.empty}>Set each input to calculate the model’s derived values.</p>}</section></div>
    {!response.observationReceiptId && recoverableObservation && <Button variant="secondary" disabled={disabled} onClick={() => onChange({ ...response, observationReceiptId: recoverableObservation.receipt.id })}>Use recorded intervention</Button>}
    <Observation receipt={observation ?? recoverableObservation?.receipt} identity={currentInput} />
  </WorkSurface>;
}

export function EstimationRenderer({ task, response, onChange, disabled }: TaskRendererProps<EstimationConfig, EstimationResponse>) {
  const id = useId();
  return <WorkSurface><Blocks title="Given facts" items={task.config.facts} /><section className={styles.response}><h3>{task.config.requestedQuantity}</h3><div className={styles.interval}>
    <NumberField label="Lower estimate" value={response.lower} disabled={disabled} onChange={(lower) => onChange({ ...response, lower })} />
    <NumberField label="Upper estimate" value={response.upper} disabled={disabled} onChange={(upper) => onChange({ ...response, upper })} />
    <Select id={`${id}-unit`} label="Unit" disabled={disabled} value={response.unit ?? ""} options={[{ value: "", label: "Choose a unit" }, ...task.config.allowedUnits.map((unit) => ({ value: unit, label: unitLabel(unit) }))]} onChange={(event) => onChange({ ...response, unit: event.target.value ? event.target.value as Unit : null })} /></div>
    <p className={styles.meta}>The interval width may be at most {Number.isFinite(task.config.maxRelativeIntervalWidth * 100) ? `${formatNumber(task.config.maxRelativeIntervalWidth * 100)}% of` : `${formatNumber(task.config.maxRelativeIntervalWidth)} times`} the reference quantity.</p>
    <Textarea id={`${id}-basis`} label="Calculation and assumptions" hint="Show the quantities, their units, and what you include or exclude." rows={5} maxLength={4000} value={response.basis} disabled={disabled} onChange={(event) => onChange({ ...response, basis: event.target.value })} />
  </section></WorkSurface>;
}

export function StrategySelectionRenderer({ task, response, onChange, disabled }: TaskRendererProps<StrategySelectionConfig, StrategySelectionResponse>) {
  const id = useId();
  return <WorkSurface><Blocks title="Situation" items={task.config.situation} /><Blocks title="Constraints to preserve" items={task.config.constraints} />
    <fieldset className={styles.choiceGroup}><legend>Choose a strategy</legend>{task.config.strategies.map((strategy) => <label className={styles.choice} key={strategy.id} data-selected={response.strategyId === strategy.id || undefined}><input type="radio" name={`${id}-strategy`} checked={response.strategyId === strategy.id} disabled={disabled} onChange={() => onChange({ ...response, strategyId: strategy.id })} /><span>{strategy.text}</span></label>)}</fieldset>
    <section className={styles.assumptions}><h3>Assumptions your strategy needs</h3>{response.assumptions.map((assumption, index) => <div className={styles.assumption} key={index}><Textarea id={`${id}-assumption-${index}`} label={`Assumption ${index + 1}`} rows={2} maxLength={4000} value={assumption} disabled={disabled} onChange={(event) => onChange({ ...response, assumptions: response.assumptions.map((value, at) => at === index ? event.target.value : value) })} /><Button variant="quiet" disabled={disabled} onClick={() => onChange({ ...response, assumptions: response.assumptions.filter((_, at) => at !== index) })}>Remove assumption {index + 1}</Button></div>)}
      <Button variant="secondary" disabled={disabled || response.assumptions.length >= 20} onClick={() => onChange({ ...response, assumptions: [...response.assumptions, ""] })}>Add assumption</Button></section>
    <Textarea id={`${id}-justification`} label="Why this strategy fits the constraints" rows={4} maxLength={4000} value={response.justification} disabled={disabled} onChange={(event) => onChange({ ...response, justification: event.target.value })} />
  </WorkSurface>;
}

export function SourceInvestigationRenderer({ task, response, onChange, disabled }: TaskRendererProps<SourceInvestigationConfig, SourceInvestigationResponse>) {
  const id = useId();
  return <WorkSurface><section className={styles.claim}><h3>Claim to investigate</h3><p>{task.config.claim}</p></section>
    <div className={styles.sources}>{task.config.sources.map((source) => <article key={source.id} className={styles.source}><h3><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></h3>
      <p className={styles.meta}>Retrieved {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(source.retrievedAt))}</p>
      {source.passages.map((passage) => {
        const citations = response.citations.filter((citation) => citation.sourceId === source.id && citation.passageId === passage.id);
        const selected = citations.length > 0;
        return <div className={styles.passage} key={passage.id}><blockquote>{passage.text}</blockquote><label className={styles.citation} data-selected={selected || undefined}><input type="checkbox" disabled={disabled || (!selected && response.citations.length >= 24)} checked={selected} onChange={(event) => onChange({ ...response, citations: event.target.checked ? [...response.citations, { sourceId: source.id, passageId: passage.id, span: null }] : response.citations.filter((citation) => citation.sourceId !== source.id || citation.passageId !== passage.id) })} /><span>{selected ? "Passage cited" : response.citations.length >= 24 ? "Citation limit reached" : "Cite this passage"}</span></label>
          {citations.some((citation) => citation.span !== null) && <p className={styles.meta}>Your restored citation refers to a selected span within this passage.</p>}</div>;
      })}</article>)}</div>
    <section className={styles.response}><h3>Your assessment of the claim</h3><Select id={`${id}-verdict`} label="Relationship to the evidence" value={response.verdict ?? ""} disabled={disabled} options={[{ value: "", label: "Choose an assessment" }, { value: "supported", label: "The evidence supports the claim" }, { value: "not_supported", label: "The evidence does not support the claim" }, { value: "mixed", label: "The evidence supports only part of the claim" }]} onChange={(event) => onChange({ ...response, verdict: event.target.value ? event.target.value as "supported" | "not_supported" | "mixed" : null })} />
      <Textarea id={`${id}-explanation`} label="Explain the support and its limits" hint="Use the cited passages. A source's title or reputation alone does not establish what it supports." rows={5} maxLength={4000} value={response.explanation} disabled={disabled} onChange={(event) => onChange({ ...response, explanation: event.target.value })} /></section>
  </WorkSurface>;
}
