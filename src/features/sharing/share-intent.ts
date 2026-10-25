import type { ServiceResult } from "@/application/ports";
import type { CreateShareInput, ShareCreated } from "@/domain/catalog";

export interface ShareCreationIntent { key: string; input: CreateShareInput }
export interface CreatedShareLink { grantId: string; url: string }

export function shareCreationIntent(current: ShareCreationIntent | null, input: CreateShareInput,
  createKey: () => string = () => crypto.randomUUID()): ShareCreationIntent {
  if (current) return current;
  return { key: createKey(), input };
}

/** Retryable failures may represent an accepted request whose response was lost, so retain its key and body. */
export function settleShareCreation(intent: ShareCreationIntent, result: ServiceResult<ShareCreated>): ShareCreationIntent | null {
  return !result.ok && result.error.error.retryable ? intent : null;
}

export function afterShareRevoked(created: CreatedShareLink | null, revokedGrantId: string): CreatedShareLink | null {
  return created?.grantId === revokedGrantId ? null : created;
}
