"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import type { JsonValue } from "@/domain/common";
import { canonicalResponseJson, responseDigest, type ActionReceipt, type PublicObservation } from "@/domain/activity";
import type { ActivityController } from "@/features/learning/player/contracts";
import { observationState, reconcileCapturedRun, runArtifactKey, type CapturedRun } from "./run-state";
import styles from "./construction.module.css";

export function Observation({ observation }: { observation: PublicObservation }) {
  if (observation.kind === "values") return <dl className={styles.values}>
    {observation.values.map(({ id, quantity }) => <div key={id}><dt>{id}</dt><dd>{quantity.value.toLocaleString("en", { maximumSignificantDigits: 10 })} <span>{quantity.unit === "unitless" ? "" : quantity.unit}</span></dd></div>)}
  </dl>;
  if (observation.kind === "case_results") return <div className={styles.caseResults}>
    {observation.cases.map((item) => <div key={item.caseId}>
      <strong>{item.caseId}</strong><p>{Object.entries(item.input).map(([name, value]) => `${name} = ${value}`).join(", ")}</p>
      <p>{item.error === null ? <>Output <strong>{item.output?.toLocaleString("en", { maximumSignificantDigits: 10 })}</strong></> :
        item.error === "division_by_zero" ? "No finite output: division by zero." : item.error === "nonfinite_result" ? "No finite output: the calculation exceeds the numeric range." : "This case could not run with the supplied inputs."}</p>
    </div>)}
  </div>;
  return <p>The observation is available in the activity history.</p>;
}

export interface RunPanelProps {
  response: JsonValue;
  activity?: ActivityController;
  disabled: boolean;
  canRun: boolean;
  onReceipt?: (receipt: ActionReceipt) => void;
  /** Only server-verified receipt attachment may differ from the input that was run. */
  selectedReceiptId?: string | null;
}

export function RunPanel({ response, activity, disabled, canRun, onReceipt, selectedReceiptId }: RunPanelProps) {
  const responseKey = canonicalResponseJson(response);
  const currentInput = useRef({ responseKey, sessionId: activity?.session?.id, mounted: true });
  useLayoutEffect(() => {
    currentInput.current = { responseKey, sessionId: activity?.session?.id, mounted: true };
    return () => { currentInput.current.mounted = false; };
  }, [responseKey, activity?.session?.id]);
  const [receiptState, setReceiptState] = useState<CapturedRun | null>(null);
  const [digestState, setDigestState] = useState<{ key: string; digest: string } | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const deliveredReceipt = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    responseDigest(response).then((digest) => { if (active) setDigestState({ key: responseKey, digest }); }).catch(() => {
      if (active) setDigestState(null);
    });
    return () => { active = false; };
  }, [response, responseKey]);
  const events = activity?.session?.events.filter((event) => event.action.kind === "run") ?? [];
  const saved = events.at(-1)?.receipt ?? null;
  const ownedCapture = reconcileCapturedRun(receiptState, activity?.session ?? null);
  const receipt = saved && ownedCapture && saved.sessionRevision > ownedCapture.receipt.sessionRevision ? saved : ownedCapture?.receipt ?? saved;
  const shownState = receipt === null ? "historical" : observationState({ receipt, captured: ownedCapture, response,
    digest: digestState?.key === responseKey ? digestState.digest : null, session: activity?.session ?? null,
    ...(selectedReceiptId === undefined ? {} : { selectedReceiptId }),
  });
  const pending = localPending || Boolean(activity?.pending) || receipt?.status === "pending";
  const available = activity?.session !== null && activity?.session !== undefined && activity.session.status === "active" && activity.session.remainingActions > 0;

  useEffect(() => {
    if (!ownedCapture?.verified || ownedCapture.receipt.status !== "completed" || !onReceipt ||
      ownedCapture.responseKey !== currentInput.current.responseKey || !currentInput.current.mounted ||
      ownedCapture.receipt.input.activitySessionId !== currentInput.current.sessionId || deliveredReceipt.current === ownedCapture.receipt.id) return;
    deliveredReceipt.current = ownedCapture.receipt.id;
    onReceipt(ownedCapture.receipt);
  }, [ownedCapture, onReceipt]);

  async function run() {
    if (!activity || pending || disabled || !canRun) return;
    const captured = responseKey;
    setLocalPending(true); setLocalError(null);
    try {
      const digest = await responseDigest(response);
      const result = await activity.dispatch({ kind: "run" });
      if (!result.ok) { setLocalError("The run could not finish. Your work is retained. Try Run again."); return; }
      const verified = result.data.input.responseDigest === digest && result.data.input.activitySessionId === activity.session?.id;
      const artifactKey = runArtifactKey(response);
      setReceiptState({ receipt: result.data, responseKey: captured, artifactKey, verified });
      if (verified && result.data.status === "completed" && currentInput.current.mounted && currentInput.current.responseKey === captured &&
        currentInput.current.sessionId === result.data.input.activitySessionId && onReceipt) {
        deliveredReceipt.current = result.data.id;
        onReceipt(result.data);
      }
      if (result.data.status === "unavailable") setLocalError("The run is unavailable. Your work is retained for retry.");
    } catch { setLocalError("The run could not finish. Your work is retained. Try Run again."); }
    finally { setLocalPending(false); }
  }

  return <section className={styles.runPanel} aria-label="Run current work">
    <div className={styles.runAction}>
      <Button variant="secondary" pending={pending} disabled={disabled || !canRun || !available} onClick={() => void run()}>{pending ? "Running" : "Run"}</Button>
      <p>Run shows the result of your current work. Submit records your answer for assessment.</p>
    </div>
    {!available && !pending && <p className={styles.runAvailability}>{activity?.session?.remainingActions === 0 ? "No runs remain. You can still revise and submit your answer." : "Run is unavailable right now. Your work remains editable."}</p>}
    {(localError || activity?.error || receipt?.status === "unavailable") && <p className={styles.error} role="alert">{localError ?? "The run could not finish. Your work is retained for retry."}</p>}
    {receipt?.observation && <div className={styles.observation} aria-live="polite">
      <h3>{shownState === "current" ? "Result of this run" : shownState === "saved" ? "Saved run" : "Earlier run"}</h3>
      {shownState === "historical" && <p className={styles.historical}>This result is historical. Run the edited work to check it.</p>}
      {shownState === "saved" && <p className={styles.historical}>This result belongs to stored work. Its configuration is verified when you submit.</p>}
      <Observation observation={receipt.observation} />
    </div>}
  </section>;
}
