import "server-only";
import { createHash } from "node:crypto";
import { MAX_PROVIDER_RESPONSE_BYTES } from "./constants";
import { ProviderFailure } from "./failure";
import { parseProviderJson } from "./json";

const generationIdPattern = /^gen-[A-Za-z0-9_-]{1,200}$/;

function invalidOutput(): never {
  throw new ProviderFailure("invalid_output");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Consume one bounded OpenRouter Chat Completions SSE response without exposing
 * partial model output. The identity callback is deliberately awaited before
 * any body read whenever OpenRouter supplied the response header.
 */
export async function readOpenRouterChatStream(response: Response, options: {
  onIdentity: (id: string) => Promise<void>;
  maxBytes?: number;
}): Promise<{ value: unknown; responseDigest: string }> {
  const requestedLimit = options.maxBytes ?? MAX_PROVIDER_RESPONSE_BYTES;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) invalidOutput();
  const limit = Math.min(requestedLimit, MAX_PROVIDER_RESPONSE_BYTES);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    if (response.status !== 200) throw new ProviderFailure("unavailable");

    let identity: string | null = null;
    const headerIdentity = response.headers.get("x-generation-id");
    if (headerIdentity !== null) {
      if (!generationIdPattern.test(headerIdentity)) invalidOutput();
      await options.onIdentity(headerIdentity);
      identity = headerIdentity;
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) invalidOutput();
    if (!response.body) invalidOutput();
    try {
      reader = response.body.getReader();
    } catch {
      invalidOutput();
    }

    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let receivedBytes = 0;
    let lineBuffer = "";
    let scanned = 0;
    let dataLines: string[] = [];
    let doneSeen = false;
    let firstChunkIdentityReported = false;
    let model: string | null = null;
    let provider: string | null = null;
    let finishReason: string | null = null;
    let finalUsage: Record<string, unknown> | null = null;
    let lastEventHadUsage = false;
    const content: string[] = [];
    const refusal: string[] = [];
    const annotations: unknown[] = [];
    let refusalSeen = false;
    let annotationsSeen = false;

    const consumeChunk = async (payload: string) => {
      let decoded: unknown;
      try {
        decoded = parseProviderJson(payload);
      } catch {
        invalidOutput();
      }
      const chunk = record(decoded);
      if (!chunk) invalidOutput();
      if (Object.prototype.hasOwnProperty.call(chunk, "error")) throw new ProviderFailure("unavailable");

      const chunkId = chunk.id;
      if (typeof chunkId !== "string" || !generationIdPattern.test(chunkId)) invalidOutput();
      if (identity !== null && chunkId !== identity) invalidOutput();
      identity ??= chunkId;
      if (!firstChunkIdentityReported) {
        await options.onIdentity(chunkId);
        firstChunkIdentityReported = true;
      }

      const chunkModel = chunk.model;
      const chunkProvider = chunk.provider;
      if (typeof chunkModel !== "string" || chunkModel.length < 1 || chunkModel.length > 200) invalidOutput();
      if (model !== null && chunkModel !== model) invalidOutput();
      model ??= chunkModel;
      if (chunkProvider !== undefined) {
        if (typeof chunkProvider !== "string" || chunkProvider.length < 1 || chunkProvider.length > 80) invalidOutput();
        if (provider !== null && chunkProvider !== provider) invalidOutput();
        provider ??= chunkProvider;
      }

      const usagePresent = chunk.usage !== undefined && chunk.usage !== null;
      if (usagePresent) {
        const usage = record(chunk.usage);
        if (!usage) invalidOutput();
        finalUsage = usage;
      }
      lastEventHadUsage = usagePresent;

      if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) invalidOutput();
      if (chunk.choices.length === 0) {
        if (!usagePresent) invalidOutput();
        return;
      }

      const choice = record(chunk.choices[0]);
      if (!choice || choice.index !== 0) invalidOutput();
      const delta = record(choice.delta);
      if (!delta) invalidOutput();
      const terminalBeforeThisFrame = finishReason !== null;

      const frameFinish = choice.finish_reason;
      if (frameFinish !== null && (typeof frameFinish !== "string" || frameFinish.length < 1 || frameFinish.length > 80)) invalidOutput();
      if (frameFinish === undefined) invalidOutput();
      if (typeof frameFinish === "string") {
        if (finishReason !== null && finishReason !== frameFinish) invalidOutput();
        finishReason ??= frameFinish;
      }

      const frameContent = delta.content;
      const frameRefusal = delta.refusal;
      const frameAnnotations = delta.annotations;
      if (frameContent !== undefined && frameContent !== null && typeof frameContent !== "string") invalidOutput();
      if (frameRefusal !== undefined && frameRefusal !== null && typeof frameRefusal !== "string") invalidOutput();
      if (frameAnnotations !== undefined && !Array.isArray(frameAnnotations)) invalidOutput();
      if (terminalBeforeThisFrame && (!usagePresent || frameContent || frameRefusal || (frameAnnotations?.length ?? 0) > 0)) invalidOutput();
      if (typeof frameContent === "string") content.push(frameContent);
      if (typeof frameRefusal === "string") {
        refusalSeen = true;
        refusal.push(frameRefusal);
      }
      if (Array.isArray(frameAnnotations)) {
        annotationsSeen = true;
        annotations.push(...frameAnnotations);
      }
    };

    const dispatch = async () => {
      if (dataLines.length === 0) return;
      const payload = dataLines.join("\n");
      dataLines = [];
      if (doneSeen) invalidOutput();
      if (payload === "[DONE]") {
        doneSeen = true;
        return;
      }
      await consumeChunk(payload);
    };

    const consumeLine = async (line: string) => {
      if (line === "") {
        await dispatch();
        return;
      }
      if (line.startsWith(":")) return;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
    };

    const consumeText = async (text: string, final: boolean) => {
      lineBuffer += text;
      let lineStart = 0;
      let cursor = scanned;
      while (cursor < lineBuffer.length) {
        const character = lineBuffer[cursor];
        if (character !== "\r" && character !== "\n") {
          cursor++;
          continue;
        }
        if (character === "\r" && cursor + 1 === lineBuffer.length && !final) break;
        await consumeLine(lineBuffer.slice(lineStart, cursor));
        cursor += character === "\r" && lineBuffer[cursor + 1] === "\n" ? 2 : 1;
        lineStart = cursor;
      }
      lineBuffer = lineBuffer.slice(lineStart);
      scanned = cursor - lineStart;
      if (final) {
        if (lineBuffer.length > 0) await consumeLine(lineBuffer);
        lineBuffer = "";
        scanned = 0;
        await dispatch();
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) invalidOutput();
      receivedBytes += value.byteLength;
      if (receivedBytes > limit) invalidOutput();
      hash.update(value);
      let text: string;
      try {
        text = decoder.decode(value, { stream: true });
      } catch {
        invalidOutput();
      }
      await consumeText(text, false);
    }
    let tail: string;
    try {
      tail = decoder.decode();
    } catch {
      invalidOutput();
    }
    await consumeText(tail, true);

    if (!doneSeen || !lastEventHadUsage || finalUsage === null || identity === null || model === null ||
      provider === null || finishReason === null) invalidOutput();
    const message: Record<string, unknown> = { content: content.join("") };
    if (refusalSeen) message.refusal = refusal.join("");
    if (annotationsSeen) message.annotations = annotations;
    return {
      value: { id: identity, model, provider, choices: [{ finish_reason: finishReason, message }], usage: finalUsage },
      responseDigest: hash.digest("hex"),
    };
  } finally {
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else if (response.body && !response.body.locked) {
      await response.body.cancel().catch(() => undefined);
    }
  }
}
