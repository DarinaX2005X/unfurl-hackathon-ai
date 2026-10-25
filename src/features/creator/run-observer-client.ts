import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { ChatEventSchema, RunSnapshotSchema, type ChatEvent, type RunSnapshot } from "@/domain/generation";

const SnapshotResponseSchema = z.object({ data: RunSnapshotSchema }).strict();
const target = (runId: string) => encodeURIComponent(IdSchema.parse(runId));

async function snapshotResponse(response: Response): Promise<RunSnapshot> {
  if (!response.ok) throw new Error(`run_snapshot_${response.status}`);
  const parsed = SnapshotResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("run_snapshot_invalid");
  return parsed.data.data;
}

export async function getRunSnapshot(runId: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RunSnapshot> {
  const response = await fetcher(`/api/v1/runs/${target(runId)}`, { credentials: "same-origin", cache: "no-store", signal });
  const snapshot = await snapshotResponse(response);
  if (snapshot.run.id !== runId) throw new Error("run_snapshot_invalid");
  return snapshot;
}

export async function cancelRun(runId: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RunSnapshot> {
  const response = await fetcher(`/api/v1/runs/${target(runId)}/cancel`, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" });
  const snapshot = await snapshotResponse(response);
  if (snapshot.run.id !== runId) throw new Error("run_snapshot_invalid");
  return snapshot;
}

export async function retryRun(runId: string, idempotencyKey: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RunSnapshot> {
  const key = IdSchema.parse(idempotencyKey);
  const response = await fetcher(`/api/v1/runs/${target(runId)}/retry`, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": key }, body: "{}" });
  // Most retries create a successor run. A timeout after a settled provider
  // response can safely resume the same durable run and advances its cursor.
  return snapshotResponse(response);
}

export interface RunEventHandlers { onEvent(event: ChatEvent): void; onSnapshotRequired(): void }
export async function readRunEvents(runId: string, after: number, signal: AbortSignal, handlers: RunEventHandlers, fetcher: typeof fetch = fetch): Promise<number> {
  const id = IdSchema.parse(runId);
  if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("Run cursor must be a non-negative integer");
  const response = await fetcher(`/api/v1/runs/${encodeURIComponent(id)}/events?after=${after}`, {
    credentials: "same-origin", cache: "no-store", headers: { Accept: "text/event-stream" }, signal,
  });
  if (!response.ok || !response.body) throw new Error(`run_events_${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = after;
  const dispatch = (frame: string) => {
    let kind = "message"; let eventId: string | null = null; const data: string[] = [];
    for (const line of frame.replaceAll("\r\n", "\n").split("\n")) {
      if (line.startsWith("event:")) kind = line.slice(6).trim();
      else if (line.startsWith("id:")) eventId = line.slice(3).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (kind === "snapshot.required") { handlers.onSnapshotRequired(); return; }
    if (kind !== "run.event" || data.length === 0) return;
    const event = ChatEventSchema.parse(JSON.parse(data.join("\n")));
    if (eventId !== String(event.seq)) { handlers.onSnapshotRequired(); return; }
    if (event.runId !== id || event.seq <= cursor) return;
    cursor = event.seq; handlers.onEvent(event);
  };
  while (!signal.aborted) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) { dispatch(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); boundary = buffer.indexOf("\n\n"); }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
  return cursor;
}
