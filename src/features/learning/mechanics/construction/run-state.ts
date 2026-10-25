import { canonicalResponseJson, isCurrentObservation, sameInputIdentity, type ActionReceipt, type ActivitySessionPublic } from "@/domain/activity";
import type { JsonValue } from "@/domain/common";

export interface CapturedRun {
  receipt: ActionReceipt;
  responseKey: string;
  artifactKey: string;
  verified: boolean;
}

export function reconcileCapturedRun(captured: CapturedRun | null, session: ActivitySessionPublic | null): CapturedRun | null {
  if (!captured || !session || captured.receipt.input.activitySessionId !== session.id) return null;
  const matches = session.events.filter((event) => event.action.kind === "run" && event.receipt.id === captured.receipt.id);
  if (matches.length !== 1) return captured;
  const receipt = matches[0]!.receipt;
  if (!sameInputIdentity(receipt.input, captured.receipt.input) || receipt.sessionRevision < captured.receipt.sessionRevision ||
    receipt.sessionRevision > session.revision || (captured.receipt.status === "completed" && receipt.status !== "completed")) return captured;
  return { ...captured, receipt };
}

export function runArtifactKey(response: JsonValue): string {
  return typeof response === "object" && response !== null && !Array.isArray(response) && response.kind === "constrained_optimization" ?
    canonicalResponseJson({ ...response, observationReceiptId: null }) : canonicalResponseJson(response);
}

/** Saved references alone never prove that the work visible now was run. */
export function observationState(input: {
  receipt: ActionReceipt;
  captured: CapturedRun | null;
  response: JsonValue;
  digest: string | null;
  session: ActivitySessionPublic | null;
  selectedReceiptId?: string | null;
}): "current" | "saved" | "historical" {
  const { receipt, captured, response, digest, session, selectedReceiptId } = input;
  if (!session || receipt.status !== "completed" || receipt.observation === null ||
    receipt.input.activitySessionId !== session.id || receipt.input.inputRevision > session.inputRevision ||
    receipt.sessionRevision > session.revision) return "historical";
  if (digest !== null && isCurrentObservation(receipt, { activitySessionId: session.id, inputRevision: session.inputRevision, responseDigest: digest })) return "current";
  if (captured?.verified && captured.receipt.id === receipt.id && selectedReceiptId === receipt.id &&
    captured.artifactKey === runArtifactKey(response)) return "current";
  return selectedReceiptId === receipt.id ? "saved" : "historical";
}
