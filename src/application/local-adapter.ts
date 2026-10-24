import { IdSchema, type ApiError, type ApiErrorCode } from "../domain";
import { CourseQuerySchema, SendMessageInputSchema, type ApplicationPort, type ServiceResult } from "./ports";

function failure<T>(code: ApiErrorCode, messageKey: string, retryable: boolean, requestId = crypto.randomUUID()): ServiceResult<T> {
  const error: ApiError = { error: { code, messageKey, retryable, requestId } };
  return { ok: false, error };
}

export const localApplication: ApplicationPort = {
  async capabilities() {
    return { generation: false, cloudIdentity: false, cloudPersistence: false };
  },
  async listPublic(query, signal) {
    signal?.throwIfAborted();
    if (!CourseQuerySchema.safeParse(query).success) return failure("invalid_input", "catalog.invalidQuery", false);
    return { ok: true, data: { items: [], nextCursor: null } };
  },
  async getPublicCourse(_slug, signal) {
    signal?.throwIfAborted();
    return failure("not_found", "catalog.notFound", false);
  },
  async listLibrary(signal) {
    signal?.throwIfAborted();
    return { ok: true, data: { items: [], nextCursor: null } };
  },
  async sendMessage(input, signal) {
    signal?.throwIfAborted();
    const requestId = IdSchema.safeParse(input.requestId).success ? input.requestId : crypto.randomUUID();
    if (!SendMessageInputSchema.safeParse(input).success) {
      return failure("invalid_input", "generation.invalidInput", false, requestId);
    }
    return failure("service_unavailable", "generation.unavailable", true, requestId);
  },
};
