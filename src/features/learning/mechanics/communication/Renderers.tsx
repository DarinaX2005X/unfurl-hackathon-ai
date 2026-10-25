"use client";

import { useId, useState } from "react";
import { Button, Select, Textarea } from "@/components/ui";
import type { TaskRendererProps } from "@/features/learning/player/contracts";
import type { Block, Span } from "@/domain/mechanic-families/v2/shared";
import {
  countResponseWords, type AnalogyTransferConfig, type AnalogyTransferResponse,
  type SelfExplanationConfig, type SelfExplanationResponse, type ArgumentRebuttalConfig, type ArgumentRebuttalResponse,
  type CritiqueRevisionConfig, type CritiqueRevisionResponse, type MisconceptionTutoringConfig, type MisconceptionTutoringResponse,
  type InformationGapConfig, type InformationGapResponse, type RoleSimulationConfig, type RoleSimulationResponse,
  type AudienceMediationConfig, type AudienceMediationResponse,
} from "@/domain/mechanic-families/v2/communication";
import { Dialogue, Material, ReferenceChoices, ResponseText, Workspace } from "./Workspace";
import styles from "./communication.module.css";

const materialOptions = (blocks: readonly Block[]) => [{ value: "", label: "Choose a passage" },
  ...blocks.map((block) => ({ value: block.id, label: block.text }))];

function Mapping({ config, value, index, disabled, onChange, onRemove }: {
  config: AnalogyTransferConfig; value: AnalogyTransferResponse["mappings"][number]; index: number; disabled: boolean;
  onChange: (value: AnalogyTransferResponse["mappings"][number]) => void; onRemove: () => void;
}) {
  const id = useId();
  return <fieldset className={styles.mapping} disabled={disabled}>
    <legend>Relationship {index + 1}</legend>
    <div className={styles.mappingFields}>
      <Select id={`${id}-source`} label="From the source" value={value.sourceId ?? ""} options={materialOptions(config.source)}
        onChange={(event) => onChange({ ...value, sourceId: event.target.value || null })} />
      <Select id={`${id}-target`} label="In the new setting" value={value.targetId ?? ""} options={materialOptions(config.target)}
        onChange={(event) => onChange({ ...value, targetId: event.target.value || null })} />
      <Select id={`${id}-relation`} label="Relationship to transfer" value={value.relation ?? ""}
        options={[{ value: "", label: "Choose a relationship" }, ...config.requiredRelations.map((relation) => ({ value: relation, label: relation.replaceAll("_", " ") }))]}
        onChange={(event) => onChange({ ...value, relation: event.target.value || null })} />
    </div>
    <Button variant="quiet" onClick={onRemove} disabled={disabled}>Remove relationship {index + 1}</Button>
  </fieldset>;
}

export function AnalogyTransferRenderer({ task, response, onChange, disabled, evaluation }: TaskRendererProps<AnalogyTransferConfig, AnalogyTransferResponse>) {
  const config = task.config;
  return <Workspace evaluation={evaluation}>
    <div className={styles.materialPair}><Material title="Source setting" blocks={config.source} language={task.contentLanguage} />
      <Material title="New setting" blocks={config.target} language={task.contentLanguage} /></div>
    <section className={styles.responseSection} aria-label="Transfer the relationships">
      <h3>Transfer the relationships</h3>
      {response.mappings.map((mapping, index) => <Mapping key={index} config={config} value={mapping} index={index} disabled={disabled}
        onChange={(next) => onChange({ ...response, mappings: response.mappings.map((item, at) => at === index ? next : item) })}
        onRemove={() => onChange({ ...response, mappings: response.mappings.filter((_item, at) => at !== index) })} />)}
      <Button variant="secondary" disabled={disabled || response.mappings.length >= 48}
        onClick={() => onChange({ ...response, mappings: [...response.mappings, { sourceId: null, targetId: null, relation: null }] })}>Add a relationship</Button>
    </section>
    <ResponseText label="Where does the analogy stop working?" value={response.limit} language={task.contentLanguage} disabled={disabled}
      onChange={(limit) => onChange({ ...response, limit })} />
  </Workspace>;
}

export function SelfExplanationRenderer({ task, response, onChange, disabled, evaluation }: TaskRendererProps<SelfExplanationConfig, SelfExplanationResponse>) {
  return <Workspace evaluation={evaluation}>
    <section className={styles.material}><h3>The step to explain</h3><p className={styles.materialText} lang={task.contentLanguage}>{task.config.step}</p>
      <p className={styles.question} lang={task.contentLanguage}>{task.config.question}</p></section>
    <ResponseText label="Why does this step work?" value={response.principle} language={task.contentLanguage} disabled={disabled} maxLength={task.config.maxChars} rows={7}
      onChange={(principle) => onChange({ ...response, principle })} />
    <ResponseText label="When does this reasoning stop applying?" value={response.limit} language={task.contentLanguage} disabled={disabled} maxLength={task.config.maxChars}
      onChange={(limit) => onChange({ ...response, limit })} />
  </Workspace>;
}

export function ArgumentRebuttalRenderer({ task, response, onChange, disabled, evaluation }: TaskRendererProps<ArgumentRebuttalConfig, ArgumentRebuttalResponse>) {
  return <Workspace evaluation={evaluation}>
    <p className={styles.question} lang={task.contentLanguage}>{task.config.question}</p>
    <ResponseText label="Your claim" value={response.claim} language={task.contentLanguage} disabled={disabled}
      onChange={(claim) => onChange({ ...response, claim })} />
    <ReferenceChoices title="Select the material supporting your claim" blocks={task.config.materials} selected={response.evidenceRefs}
      disabled={disabled} language={task.contentLanguage} onChange={(evidenceRefs) => onChange({ ...response, evidenceRefs })} />
    <ResponseText label="How does the evidence support your claim?" value={response.warrant} language={task.contentLanguage} disabled={disabled}
      onChange={(warrant) => onChange({ ...response, warrant })} />
    <section className={styles.material}><h3>The objection to address</h3><p lang={task.contentLanguage}>{task.config.objection}</p></section>
    <div className={styles.argumentResponse}>
      <ResponseText label="The strongest case for the objection" value={response.counterargument} language={task.contentLanguage} disabled={disabled}
        onChange={(counterargument) => onChange({ ...response, counterargument })} />
      <ResponseText label="Your response to the objection" value={response.response} language={task.contentLanguage} disabled={disabled}
        onChange={(answer) => onChange({ ...response, response: answer })} />
    </div>
  </Workspace>;
}

function Finding({ config, finding, index, selection, disabled, language, onChange, onRemove }: {
  config: CritiqueRevisionConfig; finding: CritiqueRevisionResponse["findings"][number]; index: number;
  selection: Span | null; disabled: boolean; language: string;
  onChange: (finding: CritiqueRevisionResponse["findings"][number]) => void; onRemove: () => void;
}) {
  const id = useId();
  return <fieldset className={styles.finding} disabled={disabled}>
    <legend>Finding {index + 1}</legend>
    <Select id={id} label="Criterion" value={finding.criterionId ?? ""}
      options={[{ value: "", label: "Choose a criterion" }, ...config.criteria.map((criterion) => ({ value: criterion.id, label: criterion.text }))]}
      onChange={(event) => onChange({ ...finding, criterionId: event.target.value || null })} />
    <div className={styles.citation}>
      <p>{finding.span ? "Cited passage" : "This finding concerns the whole draft"}</p>
      {finding.span && <p className={styles.quotedText} lang={language}>{config.draft.slice(finding.span.start, finding.span.end)}</p>}
      <div className={styles.inlineActions}><Button variant="secondary" disabled={disabled || selection === null}
        onClick={() => onChange({ ...finding, span: selection })}>Cite selected passage</Button>
        {finding.span && <Button variant="quiet" disabled={disabled} onClick={() => onChange({ ...finding, span: null })}>Use whole draft</Button>}</div>
    </div>
    <ResponseText label="What is the problem, and why does it matter?" value={finding.problem} language={language} disabled={disabled}
      onChange={(problem) => onChange({ ...finding, problem })} />
    <Button variant="quiet" disabled={disabled} onClick={onRemove}>Remove finding {index + 1}</Button>
  </fieldset>;
}

export function CritiqueRevisionRenderer({ task, response, onChange, disabled, evaluation }: TaskRendererProps<CritiqueRevisionConfig, CritiqueRevisionResponse>) {
  const id = useId();
  const [selection, setSelection] = useState<Span | null>(null);
  return <Workspace evaluation={evaluation}>
    <Material title="Revision criteria" blocks={task.config.criteria} language={task.contentLanguage} />
    <div className={styles.revisionPair}>
      <div className={styles.originalDraft}><Textarea id={id} label="Original draft" value={task.config.draft} readOnly lang={task.contentLanguage} rows={12}
        onSelect={(event) => {
          const { selectionStart: start, selectionEnd: end } = event.currentTarget;
          setSelection(end > start ? { blockId: "draft", start, end } : null);
        }} hint="Select a passage here to cite it in a finding. You can also critique the whole draft." />
        {selection && <p className={styles.selectionNote}>Selected {selection.end - selection.start} characters for citation</p>}
      </div>
      <ResponseText label="Your revision" value={response.revision} language={task.contentLanguage} disabled={disabled}
        maxLength={task.config.maxRevisionChars} rows={12} onChange={(revision) => onChange({ ...response, revision })} />
    </div>
    <section className={styles.responseSection} aria-label="Critique findings"><h3>Your findings</h3>
      {response.findings.map((finding, index) => <Finding key={index} config={task.config} finding={finding} index={index} selection={selection}
        disabled={disabled} language={task.contentLanguage}
        onChange={(next) => onChange({ ...response, findings: response.findings.map((item, at) => at === index ? next : item) })}
        onRemove={() => onChange({ ...response, findings: response.findings.filter((_item, at) => at !== index) })} />)}
      <Button variant="secondary" disabled={disabled || response.findings.length >= 20}
        onClick={() => onChange({ ...response, findings: [...response.findings, { criterionId: null, span: null, problem: "" }] })}>Add a finding</Button>
    </section>
  </Workspace>;
}

export function MisconceptionTutoringRenderer({ task, response, onChange, disabled, evaluation, activity }: TaskRendererProps<MisconceptionTutoringConfig, MisconceptionTutoringResponse>) {
  return <Workspace evaluation={evaluation}>
    <section className={styles.material}><h3>The simulated learner’s claim</h3><p className={styles.materialText} lang={task.contentLanguage}>{task.config.simulatedClaim}</p></section>
    <Material title="Known context" blocks={task.config.knownContext} language={task.contentLanguage} />
    <Dialogue activity={activity} disabled={disabled} language={task.contentLanguage} selectedReceipts={response.turnReceiptIds}
      draft={response.dialogueDraft} onDraftChange={(dialogueDraft) => onChange({ ...response, dialogueDraft })}
      onSelectReceipts={(turnReceiptIds) => onChange({ ...response, turnReceiptIds })} />
    <section className={styles.responseSection} aria-label="Teaching response"><h3>Your teaching response</h3>
      <ResponseText label="The question that reveals the misunderstanding" value={response.diagnosticQuestion} language={task.contentLanguage} disabled={disabled}
        onChange={(diagnosticQuestion) => onChange({ ...response, diagnosticQuestion })} />
      <ResponseText label="Explain the correction" value={response.correction} language={task.contentLanguage} disabled={disabled} rows={6}
        onChange={(correction) => onChange({ ...response, correction })} />
      <ResponseText label="A fresh question to check understanding" value={response.check} language={task.contentLanguage} disabled={disabled}
        onChange={(check) => onChange({ ...response, check })} />
    </section>
  </Workspace>;
}

export function InformationGapRenderer({ task, response, onChange, disabled, evaluation, activity }: TaskRendererProps<InformationGapConfig, InformationGapResponse>) {
  const revealedFacts = [...new Map((activity?.session?.events ?? []).flatMap((event) => event.receipt.status === "completed" && event.receipt.observation?.kind === "dialogue" ?
    event.receipt.observation.revealedFacts.map((fact) => [fact.id, fact] as const) : [])).values()];
  return <Workspace evaluation={evaluation}>
    <p className={styles.question} lang={task.contentLanguage}>{task.config.goal}</p>
    <Material title="What is already known" blocks={task.config.knownFacts} language={task.contentLanguage} />
    <Dialogue activity={activity} disabled={disabled} language={task.contentLanguage} selectedReceipts={response.turnReceiptIds}
      draft={response.dialogueDraft} onDraftChange={(dialogueDraft) => onChange({ ...response, dialogueDraft })}
      onSelectReceipts={(turnReceiptIds) => onChange({ ...response, turnReceiptIds })} />
    {revealedFacts.length > 0 && <ReferenceChoices title="Facts obtained in this conversation" blocks={revealedFacts} selected={response.obtainedFactIds}
      disabled={disabled} language={task.contentLanguage} onChange={(obtainedFactIds) => onChange({ ...response, obtainedFactIds })} />}
    <ResponseText label="Your decision and the facts that support it" value={response.decision} language={task.contentLanguage} disabled={disabled} rows={7}
      onChange={(decision) => onChange({ ...response, decision })} />
  </Workspace>;
}

function AgreementItems({ label, singular, items, onChange, disabled, language }: {
  label: string; singular: string; items: string[]; onChange: (items: string[]) => void; disabled: boolean; language: string;
}) {
  return <section className={styles.responseSection} aria-label={label}><h3>{label}</h3>
    {items.map((item, index) => <div className={styles.agreementItem} key={index}>
      <ResponseText label={`${singular} ${index + 1}`} value={item} language={language} disabled={disabled} rows={3}
        onChange={(next) => onChange(items.map((value, at) => at === index ? next : value))} />
      <Button variant="quiet" disabled={disabled} onClick={() => onChange(items.filter((_value, at) => at !== index))}>Remove {singular.toLowerCase()} {index + 1}</Button>
    </div>)}
    <Button variant="secondary" disabled={disabled || items.length >= 20} onClick={() => onChange([...items, ""])}>Add {singular.toLowerCase()}</Button>
  </section>;
}

export function RoleSimulationRenderer({ task, response, onChange, disabled, evaluation, activity }: TaskRendererProps<RoleSimulationConfig, RoleSimulationResponse>) {
  return <Workspace evaluation={evaluation}>
    <section className={styles.material}><h3>Your role</h3><p lang={task.contentLanguage}>{task.config.role}</p><p className={styles.question} lang={task.contentLanguage}>{task.config.goal}</p></section>
    <div className={styles.materialPair}><Material title="Known facts" blocks={task.config.knownFacts} language={task.contentLanguage} />
      <Material title="Constraints to respect" blocks={task.config.constraints} language={task.contentLanguage} /></div>
    <Dialogue activity={activity} disabled={disabled} language={task.contentLanguage} selectedReceipts={response.turnReceiptIds}
      draft={response.dialogueDraft} onDraftChange={(dialogueDraft) => onChange({ ...response, dialogueDraft })}
      onSelectReceipts={(turnReceiptIds) => onChange({ ...response, turnReceiptIds })} />
    <div className={styles.agreementPair}>
      <AgreementItems label="Commitments reached" singular="Commitment" items={response.agreement.commitments} disabled={disabled} language={task.contentLanguage}
        onChange={(commitments) => onChange({ ...response, agreement: { ...response.agreement, commitments } })} />
      <AgreementItems label="Conditions of the agreement" singular="Condition" items={response.agreement.conditions} disabled={disabled} language={task.contentLanguage}
        onChange={(conditions) => onChange({ ...response, agreement: { ...response.agreement, conditions } })} />
    </div>
    <ResponseText label="Why does this outcome meet the goal?" value={response.rationale} language={task.contentLanguage} disabled={disabled}
      onChange={(rationale) => onChange({ ...response, rationale })} />
  </Workspace>;
}

export function AudienceMediationRenderer({ task, response, onChange, disabled, evaluation }: TaskRendererProps<AudienceMediationConfig, AudienceMediationResponse>) {
  const words = countResponseWords(response.text);
  return <Workspace evaluation={evaluation}>
    <section className={styles.material}><h3>Your audience</h3><p className={styles.materialText} lang={task.contentLanguage}>{task.config.audience}</p></section>
    <ReferenceChoices title="Source facts to preserve in your message" blocks={task.config.source} selected={response.preservedFactIds}
      requiredIds={task.config.mustPreserveFactIds} disabled={disabled} language={task.contentLanguage}
      onChange={(preservedFactIds) => onChange({ ...response, preservedFactIds })} />
    <ResponseText label="Your message" value={response.text} language={task.contentLanguage} disabled={disabled} rows={9}
      hint="Select the facts above that your actual wording preserves." onChange={(text) => onChange({ ...response, text })} />
    <p className={styles.wordCount} data-exceeded={words > task.config.maxWords}>{words} of {task.config.maxWords} words
      {words > task.config.maxWords ? ". Shorten the message before submitting." : ""}</p>
  </Workspace>;
}
