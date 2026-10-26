import "server-only";
import { after } from "next/server";
import { dispatchOwnedExecution } from "./dispatcher";

/** Only a delivery kick: callers must first finish their authorized read or
 * commit the mutation and its durable outbox record. Next keeps the callback
 * alive after the response; the normal dispatcher can recover an undelivered
 * record if scheduling or delivery fails. Never defer the business transaction. */
export function dispatchAfterResponse(actor: { id: string }, runId?: string): void {
  const owner = { id: actor.id };
  try {
    after(async () => {
      try {
        const result = await dispatchOwnedExecution(owner, runId);
        if (result === null || result.failed > 0) console.warn("unfurl.dispatch.delivery_deferred");
      } catch {
        console.warn("unfurl.dispatch.delivery_deferred");
      }
    });
  } catch {
    // A host scheduling failure cannot turn an already committed receipt into
    // a rejected command. Keep diagnostics free of actor IDs, payloads or secrets.
    console.warn("unfurl.dispatch.scheduling_unavailable");
  }
}
