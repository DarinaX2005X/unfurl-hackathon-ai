import { IdSchema } from "../domain/common";
import { CloudSendMessageInputSchema, SendMessageResultSchema } from "../domain/conversations";
import { AccountStateSchema } from "./account-port";
import { CourseQuerySchema, type ApplicationPort, type ServiceResult } from "./ports";
import { conversationFailure, createConversationHttpRequest } from "./http-conversations";

export function createHttpApplication(fetcher: typeof fetch = (...args) => fetch(...args)): ApplicationPort {
  const request = createConversationHttpRequest(fetcher);
  const catalogUnavailable = <T>(): ServiceResult<T> => ({ ok: false, error: { error: {
    code: "service_unavailable", messageKey: "catalog.unavailable", retryable: true, requestId: crypto.randomUUID(),
  } } });
  return {
    async capabilities() {
      const result = await request("/api/v1/me", "GET", AccountStateSchema);
      return result.ok ? result.data.capabilities : { generation: false, cloudIdentity: false, cloudPersistence: false };
    },
    async listPublic(query, signal) {
      signal?.throwIfAborted();
      const parsed = CourseQuerySchema.safeParse(query);
      if (!parsed.success) return conversationFailure(crypto.randomUUID(), true);
      return catalogUnavailable();
    },
    async getPublicCourse(_slug, signal) { signal?.throwIfAborted(); return catalogUnavailable(); },
    async listLibrary(signal) { signal?.throwIfAborted(); return catalogUnavailable(); },
    async sendMessage(input, signal) {
      signal?.throwIfAborted();
      const parsed = CloudSendMessageInputSchema.safeParse(input);
      const key = IdSchema.safeParse(input.requestId).success ? input.requestId : crypto.randomUUID();
      if (!parsed.success) return conversationFailure(key, true);
      const result = await request(`/api/v1/conversations/${input.conversationId}/messages`, "POST", SendMessageResultSchema, {
        body: parsed.data, key, ...(signal ? { signal } : {}),
      });
      if (result.ok && (result.data.message.id !== input.messageId || result.data.message.clientRequestId !== key
        || result.data.message.conversationId !== input.conversationId || result.data.message.branchId !== parsed.data.branchId)) return conversationFailure(key);
      return result;
    },
  };
}

export const httpApplication: ApplicationPort = createHttpApplication();
