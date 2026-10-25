import "server-only";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { IdSchema } from "../../domain/common";
import { ChatEventSchema } from "../../domain/generation";
import { requireActor } from "../auth/session";
import { assertSameOrigin, failure, readInput, success } from "../auth/http";
import { privateResponse } from "../auth/client";
import { ServiceFault } from "../auth/errors";
import { withSystemTransaction } from "../db";
import { cancelGenerationInTransaction } from "./enqueue";
import { readRunEvents, readRunSnapshot, requireObservedRun, type ObservedRunKind } from "./observer";
import { retryRun } from "./retry";

const invalid = () => new ServiceFault(400, "invalid_input", "generation.invalidInput");
export async function retryRunRoute(request: NextRequest, id: string, kind: ObservedRunKind) {
  try { assertSameOrigin(request);const actor=await requireActor();const target=runId(id);const key=IdSchema.safeParse(request.headers.get("Idempotency-Key"));
    if(!key.success)throw invalid();await readInput(request,z.object({}).strict(),{maxBytes:128});
    const result=await retryRun(actor,target,kind,key.data);return success(result.data,result.status);
  }catch(error){return failure(error,request);}
}
function runId(value: string) { const id = IdSchema.safeParse(value); if (!id.success) throw invalid(); return id.data; }
export async function runSnapshotRoute(request: NextRequest, id: string, kind: ObservedRunKind) {
  try { const actor = await requireActor(); return success(await withSystemTransaction("run_execution", tx => readRunSnapshot(tx, actor, runId(id), kind))); }
  catch (error) { return failure(error, request); }
}
export async function runEventsRoute(request: NextRequest, id: string, kind: ObservedRunKind) {
  try {
    const actor = await requireActor(); const target = runId(id);
    for (const key of request.nextUrl.searchParams.keys()) if (key !== "after" || request.nextUrl.searchParams.getAll(key).length !== 1) throw invalid();
    const raw = request.nextUrl.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
    if (!/^(0|[1-9][0-9]{0,9})$/.test(raw)) throw invalid();
    let after = Number(raw);
    let batch = await withSystemTransaction("run_execution", tx => readRunEvents(tx, actor, target, kind, after));
    const encoder = new TextEncoder(); let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const deadline = Date.now() + 20000;
        try {
          while (!closed && !request.signal.aborted) {
            if (batch.snapshotRequired) { controller.enqueue(encoder.encode('event: snapshot.required\ndata: {}\n\n')); break; }
            for (const event of batch.events) {
              controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${kind === "generation" ? "generation.event" : "run.event"}\ndata: ${JSON.stringify(event)}\n\n`));
              after = event.seq;
            }
            if (batch.terminal || Date.now() >= deadline) break;
            if (!batch.events.length) { controller.enqueue(encoder.encode(": keepalive\n\n")); await new Promise(resolve => setTimeout(resolve, 1000)); }
            if (closed || request.signal.aborted) break;
            batch = await withSystemTransaction("run_execution", tx => readRunEvents(tx, actor, target, kind, after));
          }
        } catch { if (!closed && !request.signal.aborted) controller.enqueue(encoder.encode('event: snapshot.required\ndata: {}\n\n')); }
        finally { if (!closed) { closed = true; controller.close(); } }
      }, cancel() { closed = true; },
    });
    return privateResponse(new NextResponse(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } }));
  } catch (error) { return failure(error, request); }
}
export async function cancelRunRoute(request: NextRequest, id: string, kind: ObservedRunKind) {
  try {
    assertSameOrigin(request); const actor = await requireActor(); const target = runId(id);
    await readInput(request, z.object({}).strict(), { maxBytes: 128 });
    const snapshot = await withSystemTransaction("run_execution", async tx => {
      const run = await requireObservedRun(tx, actor, target, kind, true);
      if (kind === "generation") await cancelGenerationInTransaction(tx, { runId: target, ownerId: actor.id, reason: "user" });
      else if (["queued", "running"].includes(run.status)) {
        const event = ChatEventSchema.parse({ id: randomUUID(), runId: target, branchId: run.branch_id, seq: run.last_seq + 1,
          at: new Date().toISOString(), type: "run.cancelled", reason: "user" });
        await tx.query("UPDATE unfurl.agent_turn_runs SET status='cancelled',last_seq=$2,error=NULL,updated_at=now() WHERE id=$1", [target, event.seq]);
        await tx.query("INSERT INTO unfurl.agent_turn_events(id,run_id,branch_id,seq,type,event,at) VALUES($1,$2,$3,$4,$5,$6,$7)", [event.id,target,event.branchId,event.seq,event.type,JSON.stringify(event),event.at]);
        const job = (await tx.query<{ id: string }>("UPDATE unfurl.execution_jobs SET status='cancelled',fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE agent_turn_run_id=$1 RETURNING id", [target])).rows[0];
        if (job) {
          await tx.query("UPDATE unfurl.run_steps SET status='cancelled',fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE job_id=$1 AND status IN ('pending','running')", [job.id]);
          await tx.query("INSERT INTO unfurl.outbox(id,job_id,operation) VALUES($1,$2,'cancel') ON CONFLICT(job_id,operation) DO NOTHING", [randomUUID(),job.id]);
        }
      }
      return readRunSnapshot(tx, actor, target, kind);
    });
    return success(snapshot);
  } catch (error) { return failure(error, request); }
}
