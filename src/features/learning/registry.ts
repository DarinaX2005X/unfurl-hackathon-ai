import type { RegisteredMechanic } from "./player/contracts";
import { CapacityConfigSchema, CapacityResponseSchema, createInitialResponse, type CapacityConfig, type CapacityResponse } from "./sample/content";
import { CapacityRenderer } from "./sample/CapacityRenderer";

const capacity: RegisteredMechanic<CapacityConfig, CapacityResponse> = {
  configSchema: CapacityConfigSchema,
  responseSchema: CapacityResponseSchema,
  createInitialResponse,
  Renderer: CapacityRenderer,
  summarizeResponse: (response) => `Polynomial degree ${response.degree}, regularization ${response.lambda}; ${response.explanation === null ? "explanation not selected" : "explanation selected"}`,
};

/** Resolve only known, versioned renderers. Generated code is never executed. */
export function getMechanic(id: string, version: number): RegisteredMechanic<CapacityConfig, CapacityResponse> | null {
  return id === "constrained_optimization" && version === 1 ? capacity : null;
}
