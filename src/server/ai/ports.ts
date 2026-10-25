import "server-only";
import type { z } from "zod";
import type { JsonValue } from "../../domain/common";
import type { BillablePurpose, BudgetOperationContext } from "../budget/ports";
import type { MODEL_ID, PROVIDER_TAG } from "./constants";

export type ModelPurpose = Exclude<BillablePurpose, "web_search" | "capability_probe">;
export type ProviderCapability = "model_structured" | "model_text" | "research_search" | "rubric";

export interface ModelCapabilities {
  model: typeof MODEL_ID;
  provider: typeof PROVIDER_TAG;
  structured: boolean;
  text: boolean;
  search: boolean;
  rubric: boolean;
  limitations: readonly string[];
}

/** Must consult actual persisted evidence; key presence/configuration is insufficient. */
export interface ProviderCapabilityGate {
  snapshot(): ModelCapabilities;
  assertAvailable(capability: ProviderCapability, options: { probe: boolean }): Promise<void>;
}

export interface ModelRequestBase {
  operationId: string;
  purpose: ModelPurpose;
  instructionVersion: string;
  trustedInstructions: string;
  untrustedInput: JsonValue;
  model: typeof MODEL_ID;
  maxOutputTokens: number;
  deadlineAt: number;
  budget: BudgetOperationContext;
}

/** Construct/load this schema inside the executing step; never serialize it as a workflow argument. */
export interface StructuredRequest<T> extends ModelRequestBase {
  schemaId: string;
  schemaVersion: number;
  schema: z.ZodType<T>;
}
export type TextRequest = ModelRequestBase;

export interface NativeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
  cachedPromptTokens: number | null;
  searchRequests: number;
  costUsd: string | null;
}

export interface ModelEvidence {
  operationId: string;
  reservationId: string;
  providerRequestId: string;
  requestedModel: typeof MODEL_ID;
  returnedModel: string;
  provider: typeof PROVIDER_TAG;
  finishReason: string;
  usage: NativeUsage;
  rateCardDigest: string;
  replayed: boolean;
}
export interface ModelResult<T> { data: T; evidence: ModelEvidence }
export interface TextDelta { type: "text.delta"; text: string }
export interface TextCompleted { type: "text.completed"; evidence: ModelEvidence }

export interface ModelPort {
  capabilities(): ModelCapabilities;
  generateStructured<T>(request: StructuredRequest<T>, signal: AbortSignal): Promise<ModelResult<T>>;
  streamText(request: TextRequest, signal: AbortSignal): AsyncIterable<TextDelta | TextCompleted>;
}

