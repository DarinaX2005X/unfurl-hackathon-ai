import { z } from "zod";
import { IdSchema } from "../domain/common";
import { ConversationSchema } from "../domain/generation";
import { ApiErrorSchema, type ApiError } from "../domain/errors";
import {
  ComposerDraftSchema, ConversationDetailSchema, ConversationPageSchema,
  ConversationActionPageSchema, ConversationActionQuerySchema,
  ConversationQuerySchema, CreateConversationInputSchema, DeleteConversationInputSchema,
  ImportConversationInputSchema, ImportConversationResultSchema,
  RenameConversationInputSchema, SaveComposerInputSchema,
} from "../domain/conversations";
import type { ServiceResult } from "./ports";
import type { ConversationPort } from "./conversation-port";

export function conversationFailure<T>(requestId: string, invalid = false): ServiceResult<T> {
  return { ok: false, error: { error: {
    code: invalid ? "invalid_input" : "service_unavailable",
    messageKey: invalid ? "chat.invalidInput" : "chat.unavailable", retryable: !invalid, requestId,
  } } };
}

/** Shared HTTP boundary, with no local data fallback or private response cache. */
export function createConversationHttpRequest(fetcher: typeof fetch) {
  return async function request<T>(
    path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", schema: z.ZodType<T>,
    options: { body?: unknown; key?: string; signal?: AbortSignal; noContent?: boolean } = {},
  ): Promise<ServiceResult<T>> {
    options.signal?.throwIfAborted();
    const requestId = options.key ?? crypto.randomUUID();
    if (!IdSchema.safeParse(requestId).success) return conversationFailure(crypto.randomUUID(), true);
    try {
      const response = await fetcher(path, {
        method, credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "X-Request-Id": requestId,
          ...(method === "GET" ? {} : { "Content-Type": "application/json", "Idempotency-Key": requestId }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
      if (response.status === 204 && options.noContent) return { ok: true, data: schema.parse(null) };
      const payload: unknown = await response.json();
      options.signal?.throwIfAborted();
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(payload);
        return parsed.success ? { ok: false, error: parsed.data } : conversationFailure(requestId);
      }
      const parsed = z.object({ data: schema }).strict().safeParse(payload);
      return parsed.success ? { ok: true, data: parsed.data.data } : conversationFailure(requestId);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return conversationFailure(requestId);
    }
  };
}

export function createHttpConversations(fetcher: typeof fetch = (...args) => fetch(...args)): ConversationPort {
  const request = createConversationHttpRequest(fetcher);
  function mutation<T, I>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", inputSchema: z.ZodType<I>, resultSchema: z.ZodType<T>, input: I, key: string, signal?: AbortSignal, noContent = false) {
    signal?.throwIfAborted();
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve(conversationFailure<T>(IdSchema.safeParse(key).success ? key : crypto.randomUUID(), true));
    return request(path, method, resultSchema, { body: parsed.data, key, ...(signal ? { signal } : {}), noContent });
  }
  const pathFor = (id: string) => IdSchema.safeParse(id).success ? `/api/v1/conversations/${id}` : null;
  return {
    async list(query = {}, signal) {
      signal?.throwIfAborted();
      const parsed = ConversationQuerySchema.safeParse(query);
      if (!parsed.success) return conversationFailure(crypto.randomUUID(), true);
      const params = new URLSearchParams();
      if (parsed.data.cursor) params.set("cursor", parsed.data.cursor);
      if (parsed.data.limit) params.set("limit", String(parsed.data.limit));
      return request(`/api/v1/conversations${params.size ? `?${params}` : ""}`, "GET", ConversationPageSchema, { ...(signal ? { signal } : {}) });
    },
    async get(id, signal) {
      signal?.throwIfAborted();
      const path = pathFor(id);
      if (!path) return conversationFailure(crypto.randomUUID(), true);
      const result = await request(path, "GET", ConversationDetailSchema, { ...(signal ? { signal } : {}) });
      return result.ok && result.data.conversation.id !== id ? conversationFailure(crypto.randomUUID()) : result;
    },
    async getActions(id, query = {}, signal) {
      signal?.throwIfAborted();
      const path = pathFor(id);
      const parsed = ConversationActionQuerySchema.safeParse(query);
      if (!path || !parsed.success) return conversationFailure(crypto.randomUUID(), true);
      const params = new URLSearchParams();
      if (parsed.data.cursor) params.set("cursor", parsed.data.cursor);
      if (parsed.data.limit) params.set("limit", String(parsed.data.limit));
      const result = await request(`${path}/actions${params.size ? `?${params}` : ""}`, "GET", ConversationActionPageSchema, { ...(signal ? { signal } : {}) });
      return result.ok && result.data.conversationId !== id ? conversationFailure(crypto.randomUUID()) : result;
    },
    create: (input, key, signal) => mutation("/api/v1/conversations", "POST", CreateConversationInputSchema, ConversationDetailSchema, input, key, signal),
    rename: (id, input, key, signal) => pathFor(id) ? mutation(pathFor(id)!, "PATCH", RenameConversationInputSchema, ConversationSchema, input, key, signal) : Promise.resolve(conversationFailure(key, true)),
    saveComposer: (id, input, key, signal) => pathFor(id) ? mutation(`${pathFor(id)!}/composer`, "PUT", SaveComposerInputSchema, ComposerDraftSchema, input, key, signal) : Promise.resolve(conversationFailure(key, true)),
    remove: (id, input, key, signal) => pathFor(id) ? mutation(pathFor(id)!, "DELETE", DeleteConversationInputSchema, z.null(), input, key, signal, true) : Promise.resolve(conversationFailure(key, true)),
    importLocal: (input, key, signal) => mutation("/api/v1/conversations/import", "POST", ImportConversationInputSchema, ImportConversationResultSchema, input, key, signal),
  };
}

export const httpConversations: ConversationPort = createHttpConversations();
export type ConversationHttpError = ApiError;
