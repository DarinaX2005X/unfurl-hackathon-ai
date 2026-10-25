import "server-only";
import { ProviderFailure } from "../ai/failure";
import type { ExecutionKind, RunHandler } from "./ports";

/** Created by server composition in every worker process; registration is not an in-memory admin action. */
export class RunHandlerRegistry {
  private readonly handlers = new Map<ExecutionKind, RunHandler>();
  constructor(handlers: readonly RunHandler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.kind) || !handler.version) throw new Error("Duplicate or unversioned run handler");
      this.handlers.set(handler.kind, handler);
    }
  }
  has(kind: ExecutionKind): boolean { return this.handlers.has(kind); }
  require(kind: ExecutionKind): RunHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new ProviderFailure("unavailable");
    return handler;
  }
}
