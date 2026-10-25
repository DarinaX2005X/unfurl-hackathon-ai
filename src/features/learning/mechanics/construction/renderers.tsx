"use client";

import { useId, useState } from "react";
import { Button, Notice, Select, Textarea, TextField } from "@/components/ui";
import {
  artifactConstructionDescriptor, adversarialTestingDescriptor, constrainedOptimizationDescriptor,
  diagnosisRepairDescriptor, expressionLocations, planConstructionDescriptor,
  type ArtifactConstructionConfig, type ArtifactConstructionResponse,
  type AdversarialTestingConfig, type AdversarialTestingResponse,
  type ConstrainedOptimizationConfig, type ConstrainedOptimizationResponse,
  type DiagnosisRepairConfig, type DiagnosisRepairResponse,
  type PlanConstructionConfig, type PlanConstructionResponse,
} from "@/domain/mechanic-families/v2/construction";
import { MECHANIC_LIMITS, evaluateBoundedModel, type SubmissionIssue } from "@/domain/mechanic-families/v2/shared";
import type { TaskRendererProps } from "@/features/learning/player/contracts";
import { ExpressionBuilder } from "./ExpressionBuilder";
import { expressionText, partLabel } from "./expression";
import { RunPanel } from "./RunPanel";
import styles from "./construction.module.css";

function FormIssues({ issues }: { issues: SubmissionIssue[] }) {
  if (issues.length === 0) return null;
  return <div className={styles.formIssues} aria-live="polite"><p>Before you submit</p><ul>{issues.map((issue, index) => <li key={`${issue.path.join(".")}:${index}`}>{issue.message}</li>)}</ul></div>;
}

function fieldError(issues: SubmissionIssue[], path: Array<string | number>): string | undefined {
  return issues.find((issue) => path.length === issue.path.length && path.every((part, index) => issue.path[index] === part))?.message;
}

function AssessmentFeedback({ status, evaluation }: Pick<TaskRendererProps<ArtifactConstructionConfig, ArtifactConstructionResponse>, "status" | "evaluation">) {
  if (status === "editing" || !evaluation) return null;
  const tone = evaluation.status === "unavailable" || evaluation.status === "uncertain" ? "warning" :
    evaluation.outcome === "correct" ? "success" : "info";
  return <Notice tone={tone} title={evaluation.status === "unavailable" ? "Assessment unavailable" :
    evaluation.status === "uncertain" ? "Needs another review" : evaluation.outcome === "correct" ? "Requirements met" : "Review your answer"}>
    {evaluation.feedback.explanation}
  </Notice>;
}

export function PlanConstructionRenderer({ task, response, onChange, disabled, status, evaluation }: TaskRendererProps<PlanConstructionConfig, PlanConstructionResponse>) {
  const id = useId();
  const config = task.config;
  const [operation, setOperation] = useState(config.operators[0]?.id ?? "");
  const operators = new Map(config.operators.map((item) => [item.id, item]));
  const cost = response.steps.reduce((sum, step) => sum + (operators.get(step.operatorId ?? "")?.cost ?? 0), 0);
  const issues = planConstructionDescriptor.validateSubmission(config, response);
  const locked = disabled || status === "submitting";
  function addStep() {
    let index = 1;
    while (response.steps.some((step) => step.id === `step${index}`)) index++;
    const previous = response.steps.at(-1);
    onChange({ ...response, steps: [...response.steps, { id: `step${index}`, operatorId: operation, after: previous ? [previous.id] : [] }] });
  }
  return <div className={styles.mechanic}>
    <p className={styles.specification}>{config.goal}</p>
    <div className={styles.planBudget}>
      <span><strong>{response.steps.length}</strong> / {config.budgetSteps} steps</span>
      <span><strong>{Number.isFinite(cost) ? cost.toLocaleString("en") : "Over budget"}</strong> / {config.budgetCost.toLocaleString("en")} cost</span>
    </div>
    <details className={styles.reference}>
      <summary>Starting facts and available operations</summary>
      <p><strong>At the start:</strong> {config.initialFacts.length > 0 ? config.initialFacts.join(", ") : "No facts are established."}</p>
      <dl className={styles.operations}>{config.operators.map((operator) => <div key={operator.id}>
        <dt>{operator.label}</dt><dd>
          <span>Requires: {operator.requires.join(", ") || "nothing"}</span>
          <span>Adds: {operator.adds.join(", ") || "nothing"}</span>
          <span>Removes: {operator.removes.join(", ") || "nothing"}</span>
          <span>Cost: {operator.cost}</span>
        </dd>
      </div>)}</dl>
    </details>
    <div className={styles.addStep}>
      <Select id={`${id}-operation`} label="Operation to add" value={operation} disabled={locked}
        options={config.operators.map((operator) => ({ value: operator.id, label: operator.label }))}
        onChange={(event) => setOperation(event.target.value)} />
      <Button variant="secondary" disabled={locked || !operation || response.steps.length >= config.budgetSteps} onClick={addStep}>Add step</Button>
    </div>
    {response.steps.length === 0 ? <p className={styles.emptyWork}>Add the first operation, then choose what must happen before each step.</p> : <>
      <p className={styles.planHelp}>Prerequisites determine the order of execution. Independent steps may run in either order.</p>
      <ol className={styles.plan}>
        {response.steps.map((step) => <li key={step.id}>
          <div className={styles.stepHeading}><h3>{step.id}: {operators.get(step.operatorId ?? "")?.label ?? "Choose an operation"}</h3>
            <Button variant="quiet" size="compact" disabled={locked} aria-label={`Remove ${step.id}`} onClick={() => onChange({ ...response,
              steps: response.steps.filter((item) => item.id !== step.id).map((item) => ({ ...item, after: item.after.filter((dependency) => dependency !== step.id) })),
            })}>Remove</Button></div>
          <p>{step.after.length > 0 ? `After ${step.after.join(", ")}` : "No prerequisites"}</p>
          <details className={styles.dependencies}><summary>Choose prerequisites</summary>
            <fieldset disabled={locked}><legend className={styles.srOnly}>{`Prerequisites for ${step.id}`}</legend>
              {response.steps.filter((other) => other.id !== step.id).map((other) => <label key={other.id}>
                <input type="checkbox" checked={step.after.includes(other.id)} onChange={(event) => onChange({ ...response, steps: response.steps.map((item) => item.id === step.id ? {
                  ...item, after: event.target.checked ? [...item.after, other.id] : item.after.filter((dependency) => dependency !== other.id),
                } : item) })} />
                <span>{other.id}: {operators.get(other.operatorId ?? "")?.label ?? "Unselected operation"}</span>
              </label>)}
              {response.steps.length === 1 && <p>Add another step to choose a prerequisite.</p>}
            </fieldset>
          </details>
        </li>)}
      </ol>
      <FormIssues issues={issues} />
    </>}
    <AssessmentFeedback status={status} evaluation={evaluation} />
  </div>;
}

export function ArtifactConstructionRenderer({ task, response, onChange, disabled, status, evaluation, activity }: TaskRendererProps<ArtifactConstructionConfig, ArtifactConstructionResponse>) {
  const config = task.config;
  const locked = disabled || status === "submitting";
  const issues = artifactConstructionDescriptor.validateSubmission(config, response);
  return <div className={styles.mechanic}>
    <p className={styles.specification}>{config.specification}</p>
    <ExpressionBuilder value={response.expression} onChange={(expression) => onChange({ ...response, expression })}
      variables={config.variables} maxNodes={config.maxNodes} disabled={locked} />
    <PublicCases cases={config.publicCases} />
    <RunPanel response={response} {...(activity ? { activity } : {})} disabled={locked} canRun={issues.length === 0} />
    {response.expression !== null && <FormIssues issues={issues} />}
    <AssessmentFeedback status={status} evaluation={evaluation} />
  </div>;
}

function PublicCases({ cases }: { cases: Array<{ id: string; input: Record<string, number> }> }) {
  return <details className={styles.reference}><summary>Inputs used by Run</summary>
    <dl className={styles.publicCases}>{cases.map((item) => <div key={item.id}><dt>{item.id}</dt><dd>{Object.entries(item.input).map(([name, value]) => `${name} = ${value}`).join(", ")}</dd></div>)}</dl>
  </details>;
}

export function DiagnosisRepairRenderer({ task, response, onChange, disabled, status, evaluation, activity }: TaskRendererProps<DiagnosisRepairConfig, DiagnosisRepairResponse>) {
  const id = useId();
  const config = task.config;
  const locked = disabled || status === "submitting";
  const [location, setLocation] = useState("");
  const locations = expressionLocations(config.initialExpression).flatMap((entry) => [
    { value: entry.path, label: `${partLabel(entry.path)}: ${expressionText(entry.expression)}` },
    { value: `${entry.path}/op`, label: `${partLabel(entry.path)} operation: ${entry.expression.op}` },
    ...(entry.expression.op === "constant" ? [{ value: `${entry.path}/value`, label: `${partLabel(entry.path)} number: ${entry.expression.value}` }] : []),
    ...(entry.expression.op === "variable" ? [{ value: `${entry.path}/name`, label: `${partLabel(entry.path)} variable: ${entry.expression.name}` }] : []),
  ]);
  const issues = diagnosisRepairDescriptor.validateSubmission(config, response);
  return <div className={styles.mechanic}>
    <p className={styles.specification}>{config.specification}</p>
    <section className={styles.originalArtifact} aria-label="Original expression">
      <h3>Original expression</h3><p className={styles.formulaText}>{expressionText(config.initialExpression)}</p>
      <div className={styles.addLocation}>
        <Select id={`${id}-location`} label="Locate the defect" value={location} disabled={locked} options={locations}
          onChange={(event) => setLocation(event.target.value)} />
        <Button variant="secondary" disabled={locked || response.locationPaths.includes(location) || response.locationPaths.length >= MECHANIC_LIMITS.expressionNodes} onClick={() => onChange({ ...response, locationPaths: [...response.locationPaths, location] })}>Mark location</Button>
      </div>
      {response.locationPaths.length > 0 && <ul className={styles.markedLocations}>{response.locationPaths.map((path) => <li key={path}>
        <span>{path === "" ? "Whole expression" : path}</span><Button variant="quiet" size="compact" disabled={locked}
          aria-label={`Remove repair location ${path || "whole expression"}`} onClick={() => onChange({ ...response, locationPaths: response.locationPaths.filter((item) => item !== path) })}>Remove</Button>
      </li>)}</ul>}
    </section>
    <ExpressionBuilder label="Your repaired expression" value={response.replacement} variables={config.variables} disabled={locked}
      onChange={(replacement) => onChange({ ...response, replacement })} />
    <PublicCases cases={config.publicCases} />
    <RunPanel response={response} {...(activity ? { activity } : {})} disabled={locked} canRun={response.replacement !== null && issues.every((issue) => issue.path[0] !== "replacement")} />
    <Textarea id={`${id}-explanation`} label="Explain the defect and repair" value={response.explanation} disabled={locked} maxLength={4_000}
      onChange={(event) => onChange({ ...response, explanation: event.target.value })} />
    {(response.locationPaths.length > 0 || response.explanation !== "") && <FormIssues issues={issues} />}
    <AssessmentFeedback status={status} evaluation={evaluation} />
  </div>;
}

export function AdversarialTestingRenderer({ task, response, onChange, disabled, status, evaluation, activity }: TaskRendererProps<AdversarialTestingConfig, AdversarialTestingResponse>) {
  const id = useId();
  const config = task.config;
  const locked = disabled || status === "submitting";
  const issues = adversarialTestingDescriptor.validateSubmission(config, response);
  const runIssues = issues.filter((issue) => issue.path[0] !== "failureExplanation");
  function changeInput(caseIndex: number, name: string, value: number | null) {
    onChange({ ...response, cases: response.cases.map((item, index) => {
      if (index !== caseIndex) return item;
      const input = { ...item.input };
      if (value === null) delete input[name]; else input[name] = value;
      return { ...item, input };
    }) });
  }
  return <div className={styles.mechanic}>
    <p className={styles.specification}>{config.specification}</p>
    <section className={styles.originalArtifact} aria-label="Candidate expression"><h3>Candidate to test</h3><p className={styles.formulaText}>{expressionText(config.candidate)}</p></section>
    <div className={styles.artifactHeading}><h3>Your test cases</h3><span>{response.cases.length} of {config.maxCases}</span></div>
    {response.cases.length === 0 && <p className={styles.emptyWork}>Choose an input and state the result that the specification requires.</p>}
    <div className={styles.testCases}>{response.cases.map((item, index) => <section key={index} className={styles.testCase} aria-label={`Test case ${index + 1}`}>
      <div className={styles.stepHeading}><h4>Case {index + 1}</h4><Button variant="quiet" size="compact" disabled={locked}
        aria-label={`Remove case ${index + 1}`} onClick={() => onChange({ ...response, cases: response.cases.filter((_, itemIndex) => itemIndex !== index) })}>Remove</Button></div>
      <div className={styles.numericFields}>
        {config.variables.map((variable) => <TextField key={variable.id} id={`${id}-case${index}-${variable.id}`} label={`${variable.id}${variable.unit === "unitless" ? "" : ` (${variable.unit})`}`}
          type="number" min={variable.min} max={variable.max} step={variable.step} value={item.input[variable.id] ?? ""} disabled={locked}
          hint={`${variable.min} to ${variable.max}, step ${variable.step}`}
          error={fieldError(issues, ["cases", index, "input", variable.id])}
          onChange={(event) => changeInput(index, variable.id, Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : null)} />)}
        <TextField id={`${id}-expected${index}`} label="Expected result" type="number" step="any" value={item.expected ?? ""} disabled={locked}
          error={fieldError(issues, ["cases", index, "expected"])}
          onChange={(event) => onChange({ ...response, cases: response.cases.map((testCase, itemIndex) => itemIndex === index ? { ...testCase, expected: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : null } : testCase) })} />
      </div>
    </section>)}</div>
    <Button variant="secondary" disabled={locked || response.cases.length >= config.maxCases} onClick={() => onChange({ ...response,
      cases: [...response.cases, { input: {}, expected: null }],
    })}>Add case</Button>
    <RunPanel response={response} {...(activity ? { activity } : {})} disabled={locked} canRun={runIssues.length === 0} />
    <Textarea id={`${id}-explanation`} label="Explain what your tests reveal" value={response.failureExplanation} disabled={locked} maxLength={4_000}
      onChange={(event) => onChange({ ...response, failureExplanation: event.target.value })} />
    {response.cases.length > 0 && <FormIssues issues={issues} />}
    <AssessmentFeedback status={status} evaluation={evaluation} />
  </div>;
}

export function ConstrainedOptimizationRenderer({ task, response, onChange, disabled, status, evaluation, activity }: TaskRendererProps<ConstrainedOptimizationConfig, ConstrainedOptimizationResponse>) {
  const id = useId();
  const config = task.config;
  const locked = disabled || status === "submitting";
  const issues = constrainedOptimizationDescriptor.validateSubmission(config, response);
  const baseline = evaluateBoundedModel(config.model, config.baseline);
  const objective = baseline.find((output) => output.id === config.objective.outputId)!;
  function changeConfiguration(name: string, value: number | null) {
    const configuration = { ...response.configuration };
    if (value === null) delete configuration[name]; else configuration[name] = value;
    onChange({ ...response, configuration, observationReceiptId: null });
  }
  return <div className={styles.mechanic}>
    <div className={styles.optimizationGoal}><h3>{config.objective.direction === "maximize" ? "Increase" : "Reduce"} {config.objective.outputId}</h3>
      <p>Improve by at least <strong>{config.objective.minimumImprovement} {objective.quantity.unit === "unitless" ? "" : objective.quantity.unit}</strong> from a baseline of <strong>{objective.quantity.value.toLocaleString("en", { maximumSignificantDigits: 10 })}</strong>.</p>
    </div>
    <div className={styles.baselineAndConstraints}>
      <section><h4>Starting configuration</h4><dl className={styles.values}>{Object.entries(config.baseline).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></section>
      <section><h4>Required constraints</h4>{config.constraints.length > 0 ? <ul>{config.constraints.map((constraint) => <li key={`${constraint.outputId}:${constraint.operator}`}>
        {constraint.outputId} {constraint.operator === "lte" ? "≤" : "≥"} {constraint.value} {config.model.outputs.find(({ id }) => id === constraint.outputId)?.unit === "unitless" ? "" : config.model.outputs.find(({ id }) => id === constraint.outputId)?.unit}
      </li>)}</ul> : <p>Use the declared parameter ranges.</p>}</section>
    </div>
    <section className={styles.parameterStage} aria-label="Your configuration"><h3>Your configuration</h3>
      <div className={styles.parameters}>{config.model.inputs.map((variable) => <div key={variable.id}>
        <TextField id={`${id}-${variable.id}`} label={`${variable.id}${variable.unit === "unitless" ? "" : ` (${variable.unit})`}`}
          type="number" min={variable.min} max={variable.max} step={variable.step} value={response.configuration[variable.id] ?? ""} disabled={locked}
          error={fieldError(issues, ["configuration", variable.id])}
          onChange={(event) => changeConfiguration(variable.id, Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : null)} />
        <input className={styles.range} type="range" aria-label={`Adjust ${variable.id}`} min={variable.min} max={variable.max} step={variable.step}
          value={response.configuration[variable.id] ?? variable.min} disabled={locked} onChange={(event) => changeConfiguration(variable.id, event.target.valueAsNumber)} />
        <div className={styles.rangeLimits}><span>{variable.min}</span><span>{variable.max}</span></div>
      </div>)}</div>
    </section>
    <RunPanel response={response} {...(activity ? { activity } : {})} disabled={locked} canRun={issues.every((issue) => issue.path[0] === "observationReceiptId")}
      selectedReceiptId={response.observationReceiptId} onReceipt={(receipt) => {
        if (receipt.observation?.kind === "values") onChange({ ...response, observationReceiptId: receipt.id });
      }} />
    <FormIssues issues={issues} />
    <AssessmentFeedback status={status} evaluation={evaluation} />
  </div>;
}
