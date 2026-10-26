import "server-only";
import { withSystemTransaction } from "../db";
import { resolveOperationFunding } from "../budget/funding";
import type { BudgetOperationContext } from "../budget/ports";
import type { OpenRouterModel } from "./openrouter";
import type { ModelPort, ModelCapabilities, StructuredRequest, TextRequest } from "./ports";

/** Fixed per-ledger transports prevent concurrent requests from changing another call's funding. */
export class ScopedRuntimeModel implements ModelPort {
  constructor(private readonly modelForBudget: (budgetId: string) => OpenRouterModel,
    private readonly snapshot: () => ModelCapabilities,
    private readonly resolve = (context: BudgetOperationContext) => withSystemTransaction("run_execution", tx => resolveOperationFunding(tx, context))) {}
  capabilities() { return this.snapshot(); }
  async generateStructured<T>(request: StructuredRequest<T>, signal: AbortSignal) {
    return this.modelForBudget((await this.resolve(request.budget)).budgetId).generateStructured(request, signal);
  }
  async *streamText(request: TextRequest, signal: AbortSignal) {
    yield* this.modelForBudget((await this.resolve(request.budget)).budgetId).streamText(request, signal);
  }
  async complete(...args: Parameters<OpenRouterModel["complete"]>): ReturnType<OpenRouterModel["complete"]> {
    return this.modelForBudget((await this.resolve(args[0].budget)).budgetId).complete(...args);
  }
}
