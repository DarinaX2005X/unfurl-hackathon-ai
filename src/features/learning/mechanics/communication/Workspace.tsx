"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button, Textarea } from "@/components/ui";
import type { Block } from "@/domain/mechanic-families/v2/shared";
import type { Evaluation } from "@/domain/learning";
import type { ActivityController } from "@/features/learning/player/contracts";
import styles from "./communication.module.css";

export function Workspace({ children, evaluation }: { children: ReactNode; evaluation: Evaluation | null }) {
  return <div className={styles.workspace}>{children}<Assessment evaluation={evaluation} /></div>;
}

const dimensionLabels: Record<string, string> = {
  structure: "Structural relationship", limit: "Limit of the analogy", principle: "Underlying principle", boundary: "Boundary of the explanation",
  support: "Evidence support", inference: "Reasoning", rebuttal: "Response to the objection", diagnosis: "Diagnosis", revision: "Substantive revision",
  correction: "Helpful correction", transfer_check: "Fresh application check", question_relevance: "Relevant questions", decision_grounding: "Grounded decision",
  constraints: "Scenario constraints", agreement: "Actual agreement", rationale: "Rationale", meaning: "Preserved meaning", limits: "Preserved limitations", audience: "Fit for the audience",
};
const statusLabels = { met: "Met", partial: "Partly met", not_met: "Needs revision", uncertain: "Needs review" } as const;

function Assessment({ evaluation }: { evaluation: Evaluation | null }) {
  if (!evaluation) return null;
  return <section className={styles.assessment} aria-label="Response assessment" aria-live="polite">
    <h3>{evaluation.status === "pending" ? "Assessment in progress" : evaluation.status === "unavailable" ? "Assessment unavailable" :
      evaluation.status === "uncertain" ? "Assessment needs review" : "Response feedback"}</h3>
    <p>{evaluation.feedback.explanation}</p>
    {evaluation.dimensions.length > 0 && <dl className={styles.dimensions}>{evaluation.dimensions.map((dimension) => <div key={dimension.id}>
      <dt><span>{dimensionLabels[dimension.id] ?? dimension.id.replaceAll("_", " ")}</span><span data-result={dimension.status}>{statusLabels[dimension.status]}</span></dt>
      <dd>{dimension.explanation}</dd>
    </div>)}</dl>}
  </section>;
}

export function Material({ title, blocks, language }: { title: string; blocks: readonly Block[]; language: string }) {
  if (!blocks.length) return null;
  return <section className={styles.material}>
    <h3>{title}</h3>
    <ul className={styles.materialList} lang={language}>{blocks.map((block) => <li key={block.id}>{block.text}</li>)}</ul>
  </section>;
}

export function ResponseText({ label, value, onChange, disabled, language, maxLength = 4000, rows = 5, hint }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; language: string;
  maxLength?: number; rows?: number; hint?: string;
}) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const error = value.length > maxLength ? `Use no more than ${maxLength} characters.` : touched && !value.trim() ? "Complete this response part before submitting." : undefined;
  return <Textarea id={id} label={label} value={value} lang={language} rows={rows} disabled={disabled}
    onChange={(event) => onChange(event.target.value)} onBlur={() => setTouched(true)}
    {...(hint ? { hint } : {})} {...(error ? { error } : {})} />;
}

export function ReferenceChoices({ title, blocks, selected, onChange, disabled, language, requiredIds = [] }: {
  title: string; blocks: readonly Block[]; selected: readonly string[]; onChange: (selected: string[]) => void;
  disabled: boolean; language: string; requiredIds?: readonly string[];
}) {
  return <fieldset className={styles.references} disabled={disabled}>
    <legend>{title}</legend>
    {blocks.map((block) => <label className={styles.referenceChoice} key={block.id}>
      <input type="checkbox" checked={selected.includes(block.id)} onChange={(event) => onChange(event.target.checked ? [...selected, block.id] : selected.filter((id) => id !== block.id))} />
      <span><span lang={language}>{block.text}</span>{requiredIds.includes(block.id) && <span className={styles.requiredFact}>Essential to preserve</span>}</span>
    </label>)}
  </fieldset>;
}

export function canSendDialogue(activity: ActivityController | undefined, text: string, disabled: boolean): boolean {
  return !disabled && Boolean(text.trim()) && text.length <= 4000 && Boolean(activity?.session) &&
    !activity?.pending && activity?.session?.status === "active" && activity.session.remainingActions > 0;
}

export function Dialogue({ activity, disabled, language, selectedReceipts, onSelectReceipts, draft, onDraftChange }: {
  activity: ActivityController | undefined; disabled: boolean; language: string;
  selectedReceipts: readonly string[]; onSelectReceipts: (ids: string[]) => void;
  draft: string; onDraftChange: (draft: string) => void;
}) {
  const id = useId();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState(false);
  const lock = useRef(false);
  const latest = useRef({ draft, onDraftChange });
  const requestedReceipt = useRef<string | null>(null);
  const handledCompletion = useRef<string | null>(null);
  useLayoutEffect(() => { latest.current = { draft, onDraftChange }; }, [draft, onDraftChange]);
  const session = activity?.session;
  const turns = session?.events.filter((event) => event.action.kind === "dialogue.turn") ?? [];
  const lastTurn = turns.at(-1);
  useEffect(() => {
    if (!lastTurn || lastTurn.receipt.status !== "completed" || lastTurn.action.kind !== "dialogue.turn" ||
        handledCompletion.current === lastTurn.receipt.id) return;
    handledCompletion.current = lastTurn.receipt.id;
    const isCapturedInput = requestedReceipt.current === lastTurn.receipt.id || session?.inputRevision === lastTurn.receipt.input.inputRevision;
    if (isCapturedInput && latest.current.draft === lastTurn.action.text) latest.current.onDraftChange("");
  }, [lastTurn, session?.inputRevision]);
  const pending = sending || Boolean(activity?.pending);
  const exhausted = session?.remainingActions === 0 || session?.status === "budget_exhausted";
  const available = canSendDialogue(activity, draft, disabled) && !sending;
  async function act(receiptId?: string) {
    if (!activity || lock.current || disabled || pending || (!receiptId && !available)) return;
    const event = receiptId ? turns.find((turn) => turn.receipt.id === receiptId) : null;
    if (receiptId && (!event || event.receipt.status === "completed")) return;
    lock.current = true;
    setSending(true);
    setFailure(false);
    const sent = event?.action.kind === "dialogue.turn" ? event.action.text : draft;
    try {
      const result = receiptId ? await activity.retryAction(receiptId) : await activity.dispatch({ kind: "dialogue.turn", text: sent });
      if (result.ok) requestedReceipt.current = result.data.id;
      if (result.ok && result.data.status === "completed") {
        handledCompletion.current = result.data.id;
        if (latest.current.draft === sent) latest.current.onDraftChange("");
      } else if (!result.ok || result.data.status === "unavailable") setFailure(true);
    } catch { setFailure(true); }
    finally { lock.current = false; setSending(false); }
  }
  return <section className={styles.dialogue} aria-label="Scenario conversation">
    <div className={styles.sectionHeading}><h3>Conversation</h3>{session && <span className={styles.turnCount}>{session.remainingActions} {session.remainingActions === 1 ? "turn" : "turns"} remaining</span>}</div>
    {turns.length > 0 && <ol className={styles.transcript}>{turns.map((event) => <li key={event.id}>
      <div className={styles.turnText}><strong>Your turn</strong><p lang={language}>{event.action.kind === "dialogue.turn" ? event.action.text : ""}</p></div>
      {event.receipt.observation?.kind === "dialogue" ? <>
        <div className={styles.turnText}><strong>Scenario response</strong><p lang={language}>{event.receipt.observation.text}</p></div>
        <label className={styles.turnReference}><input type="checkbox" disabled={disabled} checked={selectedReceipts.includes(event.receipt.id)}
          onChange={(change) => onSelectReceipts(change.target.checked ? [...selectedReceipts, event.receipt.id] : selectedReceipts.filter((receipt) => receipt !== event.receipt.id))} />
          <span>Use this exchange in my response</span></label>
      </> : <div className={styles.pendingTurn}>
        <p className={styles.localStatus} role="status">{event.receipt.status === "pending" ? "Waiting for the scenario response" : "This turn could not be completed. Your turn is retained."}</p>
        <Button variant="secondary" disabled={disabled || pending} onClick={() => void act(event.receipt.id)}>Retry turn</Button>
      </div>}
    </li>)}</ol>}
    <Textarea id={id} label="Your next turn" lang={language} value={draft} rows={4} disabled={disabled || !session || session.status === "completed" || exhausted}
      onChange={(event) => { latest.current.draft = event.target.value; onDraftChange(event.target.value); setFailure(false); }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void act(); }
      }}
      hint="Enter starts a new line. Ctrl+Enter sends the turn."
      {...(draft.length > 4000 ? { error: "Use no more than 4000 characters in a turn." } : {})} />
    <div className={styles.dialogueAction}>
      <div className={styles.inlineActions}><Button onClick={() => void act()} disabled={!available} pending={pending}>Send turn</Button>
        {draft.length > 0 && <Button variant="quiet" disabled={disabled} onClick={() => { latest.current.draft = ""; onDraftChange(""); }}>Clear turn draft</Button>}</div>
      <div className={styles.localStatus} role="status">
        {!session ? "The conversation is unavailable. You can keep editing your final response." : exhausted ? "No turns remain. You can submit your final response." :
          pending ? "Waiting for the scenario response" : failure || activity?.error ? "The turn could not be completed. Your text is retained for retry." : null}
      </div>
    </div>
  </section>;
}
