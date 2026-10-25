import "server-only";
import type { Id } from "../../domain/common";

/** Created only after a fresh provider user lookup and verified JWT claims. */
export interface Actor {
  readonly id: Id;
  readonly sessionId: Id;
  readonly email: string | null;
}
