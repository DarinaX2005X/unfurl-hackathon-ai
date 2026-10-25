import "server-only";
import type { z } from "zod";
import type { JsonValue } from "../../domain/common";
import type { ChatEvent } from "../../domain/generation";
import type { BudgetOperationContext } from "../budget/ports";
import type { DbTransaction } from "../db";

export type ExecutionTarget =
  | { kind: "agent_turn"; runId: string; ownerId: string; conversationId: string; branchId: string; inputMessageId: string }
  | { kind: "generation"; runId: string; ownerId: string; conversationId: string; branchId: string; inputMessageId: string;
      courseId: string; approvalId: string; approvalDigest: string; courseVersionId: string }
  | { kind: "evaluation"; evaluationId: string; targetEvaluationRevision: number }
  | { kind: "activity_action"; activityActionId: string };
export type ExecutionKind = ExecutionTarget["kind"];
export interface JobClaim { jobId: string; leaseOwner: string; fencingToken: string; target: ExecutionTarget }
export type StepDigests = { schema: string; capability: string; validationPolicy: string; approval: string | null };
export type ChatEventPayload = ChatEvent extends infer Event ? Event extends ChatEvent ? Omit<Event, "id" | "runId" | "branchId" | "seq" | "at"> : never : never;

export interface StepEffectContext {
  stepId: string;
  signal: AbortSignal;
  /** Stable across crashes and workflow deliveries. A new paid retry needs an explicit new attempt. */
  budgetOperation(name: string, attempt?: number): BudgetOperationContext;
}
export interface DurableStep<Input extends JsonValue, Output extends JsonValue, Result extends JsonValue> {
  key: string;
  input: Input;
  digests: StepDigests;
  outputSchema: z.ZodType<Output>;
  resultSchema: z.ZodType<Result>;
  /** Bounded external work only. Never retain a DB transaction while awaiting a provider/source. */
  effect(context: StepEffectContext, input: Input): Promise<Output>;
  /** Runs after authority/fence/lease validation. Domain changes, result and events commit together. */
  commit(tx: DbTransaction, output: Output): Promise<Result>;
}
export interface RunContext {
  claim: JobClaim;
  signal: AbortSignal;
  /** Authoritative read under the same ownership/target checks used by step commit. */
  read<T>(reader: (tx: DbTransaction, target: ExecutionTarget) => Promise<T>): Promise<T>;
  /** One new bounded effect per advance; already committed steps can be replayed without another effect. */
  step<Input extends JsonValue, Output extends JsonValue, Result extends JsonValue>(spec: DurableStep<Input, Output, Result>): Promise<Result>;
  emitChat(tx: DbTransaction, payload: ChatEventPayload): Promise<ChatEvent>;
}
export type AdvanceResult = { status: "continue" } | { status: "awaiting_user" } | { status: "succeeded" };
export interface RunHandler {
  kind: ExecutionKind;
  version: string;
  /** Handler-specific authoritative guards (e.g. evaluation revision/action session CAS). No network. */
  assertAuthority(tx: DbTransaction, target: ExecutionTarget): Promise<void>;
  /** Exactly one new bounded external effect at most; return continue for the next durable invocation. */
  advance(context: RunContext): Promise<AdvanceResult>;
}
export interface RunnerPort {
  start(jobId: string): Promise<{ workflowRunId: string }>;
  cancel(workflowRunId: string): Promise<void>;
}
