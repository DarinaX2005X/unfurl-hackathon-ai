"use client";

import { useId, useState } from "react";
import { Button, Select, TextField } from "@/components/ui";
import { expressionLocations, expressionNodeCount } from "@/domain/mechanic-families/v2/construction";
import { ExprSchema, MECHANIC_LIMITS, type Block, type Expr } from "@/domain/mechanic-families/v2/shared";
import { changeOperation, expressionText, operationLabels, partLabel, replaceExpressionPart, selectedExpressionPart } from "./expression";
import styles from "./construction.module.css";

function ConstantEditor({ value, disabled, onApply }: { value: number; disabled: boolean; onApply(value: number): void }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const parsed = draft.trim() === "" ? NaN : Number(draft);
  const valid = Number.isFinite(parsed);
  return <div className={styles.constantEditor}>
    <TextField id={id} label="Number to apply" inputMode="decimal" value={draft} disabled={disabled}
      onChange={(event) => setDraft(event.target.value)} error={!valid ? "Enter a finite number." : undefined}
      hint={valid && !Object.is(parsed, value) ? "Apply this number to change the expression." : undefined} />
    <Button variant="secondary" disabled={disabled || !valid || Object.is(parsed, value)} onClick={() => onApply(parsed)}>Apply number</Button>
  </div>;
}

export interface ExpressionBuilderProps {
  value: Expr | null;
  onChange(value: Expr | null): void;
  variables: Block[];
  disabled: boolean;
  maxNodes?: number;
  label?: string;
}

export function ExpressionBuilder({ value, onChange, variables, disabled, maxNodes = MECHANIC_LIMITS.expressionNodes, label = "Your expression" }: ExpressionBuilderProps) {
  const id = useId();
  const [selectedPath, setSelectedPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = value === null ? null : selectedExpressionPart(value, selectedPath);

  function apply(next: Expr | null) {
    if (next !== null) {
      const parsed = ExprSchema.safeParse(next);
      if (!parsed.success || expressionNodeCount(next) > maxNodes) {
        setError(`This change would exceed the expression limit of ${maxNodes} parts or ${MECHANIC_LIMITS.expressionDepth} levels. Your expression is unchanged.`);
        return;
      }
    }
    setError(null);
    onChange(next);
  }

  function updatePart(next: Expr) {
    if (value !== null && selected !== null) apply(replaceExpressionPart(value, selected.path, next));
  }

  return <section className={styles.expressionBuilder} aria-labelledby={`${id}-title`}>
    <div className={styles.artifactHeading}>
      <h3 id={`${id}-title`}>{label}</h3>
      {value !== null && <span>{expressionNodeCount(value)} of {maxNodes} parts</span>}
    </div>
    <div className={styles.formula} aria-label={label}>
      {value === null ? <p>Start with a number or a variable, then combine the parts.</p> : <output>{expressionText(value)}</output>}
    </div>
    {value === null ? <Button variant="secondary" disabled={disabled} onClick={() => apply({ op: "constant", value: 0 })}>Start expression</Button> : selected !== null && <>
      <div className={styles.builderControls}>
        <Select id={`${id}-part`} label="Edit part" value={selected.path} disabled={disabled}
          options={expressionLocations(value).map((entry) => ({ value: entry.path, label: `${partLabel(entry.path)}: ${operationLabels[entry.expression.op]}` }))}
          onChange={(event) => setSelectedPath(event.target.value)} />
        <Select id={`${id}-operation`} label="Operation" value={selected.expression.op} disabled={disabled}
          options={(Object.keys(operationLabels) as Array<Expr["op"]>).map((operation) => ({ value: operation, label: operationLabels[operation], disabled: operation === "variable" && variables.length === 0 }))}
          onChange={(event) => updatePart(changeOperation(selected.expression, event.target.value as Expr["op"], variables[0]?.id))} />
      </div>
      <div className={styles.partEditor}>
        <p className={styles.selectedPart}><strong>{partLabel(selected.path)}</strong><span>{expressionText(selected.expression)}</span></p>
        {selected.expression.op === "constant" && <ConstantEditor key={`${selected.path}:${selected.expression.value}`} value={selected.expression.value} disabled={disabled}
          onApply={(number) => updatePart({ op: "constant", value: number })} />}
        {selected.expression.op === "variable" && <Select id={`${id}-variable`} label="Variable" value={selected.expression.name} disabled={disabled}
          options={variables.map((variable) => ({ value: variable.id, label: `${variable.id}: ${variable.text}` }))}
          onChange={(event) => updatePart({ op: "variable", name: event.target.value })} />}
        {"left" in selected.expression && <div className={styles.inlineActions}>
          <Button variant="secondary" disabled={disabled} onClick={() => setSelectedPath(`${selected.path}/left`)}>Edit left operand</Button>
          <Button variant="secondary" disabled={disabled} onClick={() => setSelectedPath(`${selected.path}/right`)}>Edit right operand</Button>
          <Button variant="quiet" disabled={disabled} onClick={() => {
            if ("left" in selected.expression) updatePart({ ...selected.expression, right: selected.expression.left });
          }}>Copy left to right</Button>
        </div>}
        {selected.expression.op === "abs" && <Button variant="secondary" disabled={disabled} onClick={() => setSelectedPath(`${selected.path}/value`)}>Edit inner expression</Button>}
      </div>
      <Button variant="quiet" disabled={disabled} onClick={() => { setSelectedPath(""); apply(null); }}>Clear expression</Button>
    </>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
