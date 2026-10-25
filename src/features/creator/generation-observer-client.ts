import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { GenerationEventSchema, GenerationSnapshotSchema, type GenerationEvent, type GenerationSnapshot } from "@/domain/generation-observer";

const SnapshotResponseSchema = z.object({ data: GenerationSnapshotSchema }).strict();

export async function getGenerationSnapshot(runId: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<GenerationSnapshot> {
  const target = IdSchema.parse(runId);
  const response = await fetcher(`/api/v1/generation-runs/${encodeURIComponent(target)}`, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error(`generation_snapshot_${response.status}`);
  const parsed = SnapshotResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.data.run.id !== runId) throw new Error("generation_snapshot_invalid");
  return parsed.data.data;
}

export async function cancelGenerationRun(runId: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<GenerationSnapshot> {
  const target = IdSchema.parse(runId);
  const response = await fetcher(`/api/v1/generation-runs/${encodeURIComponent(target)}/cancel`, {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}",
  });
  if (!response.ok) throw new Error(`generation_cancel_${response.status}`);
  const parsed = SnapshotResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.data.run.id !== runId) throw new Error("generation_snapshot_invalid");
  return parsed.data.data;
}

export async function retryGenerationRun(runId: string, idempotencyKey: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<GenerationSnapshot> {
  const target = IdSchema.parse(runId);
  const key = IdSchema.parse(idempotencyKey);
  const response = await fetcher(`/api/v1/generation-runs/${encodeURIComponent(target)}/retry`, {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": key }, body: "{}",
  });
  if (!response.ok) throw new Error(`generation_retry_${response.status}`);
  const parsed = SnapshotResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.data.run.id === runId) throw new Error("generation_retry_invalid");
  return parsed.data.data;
}

export interface GenerationEventHandlers {
  onEvent(event: GenerationEvent): void;
  onSnapshotRequired(): void;
}

/** One bounded server connection. The caller owns reconnect and authoritative snapshot repair. */
export async function readGenerationEvents(runId: string, after: number, signal: AbortSignal, handlers: GenerationEventHandlers, fetcher: typeof fetch = fetch): Promise<number> {
  const target = IdSchema.parse(runId);
  if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("Generation cursor must be a non-negative integer");
  const response = await fetcher(`/api/v1/generation-runs/${encodeURIComponent(target)}/events?after=${after}`, {
    credentials: "same-origin", cache: "no-store", headers: { Accept: "text/event-stream" }, signal,
  });
  if (!response.ok || !response.body) throw new Error(`generation_events_${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = after;
  const dispatch = (frame: string) => {
    let kind = "message";
    let id: string | null = null;
    const data: string[] = [];
    for (const line of frame.replaceAll("\r\n", "\n").split("\n")) {
      if (line.startsWith("event:")) kind = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (kind === "snapshot.required") { handlers.onSnapshotRequired(); return; }
    if (kind !== "generation.event" || data.length === 0) return;
    const event = GenerationEventSchema.parse(JSON.parse(data.join("\n")));
    if (id !== String(event.seq)) { handlers.onSnapshotRequired(); return; }
    if (event.runId !== runId || event.seq <= cursor) return;
    cursor = event.seq;
    handlers.onEvent(event);
  };
  while (!signal.aborted) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
  return cursor;
}
