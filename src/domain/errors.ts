import { z } from "zod";
import { IdSchema, RevisionSchema } from "./common";

export const ApiErrorCodeSchema = z.enum([
  "invalid_input", "unauthenticated", "forbidden", "not_found", "revision_conflict",
  "idempotency_conflict", "rate_limited", "service_unavailable", "generation_failed",
  "evaluation_unavailable",
]);
export const ApiErrorDetailSchema = z.object({
  code: ApiErrorCodeSchema,
  messageKey: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number().finite()])).optional(),
  fieldErrors: z.record(z.string(), z.string()).optional(),
  retryable: z.boolean(),
  requestId: IdSchema,
}).strict();
export const ApiErrorSchema = z.object({
  error: ApiErrorDetailSchema,
  currentRevision: RevisionSchema.optional(),
}).strict();
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

export type DomainErrorCode = "invalid_curriculum" | "approval_conflict" | "unsafe_public_payload";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly reason: string;

  constructor(code: DomainErrorCode, reason: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.reason = reason;
  }
}
