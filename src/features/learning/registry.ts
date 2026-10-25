import type { RegisteredMechanic } from "./player/contracts";
import { CapacityConfigSchema, CapacityResponseSchema, createInitialResponse, type CapacityConfig, type CapacityResponse } from "./sample/content";
import { CapacityRenderer } from "./sample/CapacityRenderer";
import { createElement } from "react";
import type { JsonValue } from "@/domain/common";
import { parseFamilyTask, parseFamilyResponse } from "@/domain/mechanic-families/v2/shared";
import type { ProductionMechanic, TaskRendererProps } from "./player/contracts";
import { mechanics as foundations } from "./mechanics/foundations";
import { mechanics as investigation } from "./mechanics/investigation";
import { mechanics as construction } from "./mechanics/construction";
import { mechanics as communication } from "./mechanics/communication";

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

export interface ProductionMechanicHandle {
  id: string;
  version: 2;
  parseTask(value: unknown): import("@/domain/mechanics").TaskPublic<JsonValue>;
  parseResponse(value: unknown): JsonValue;
  createInitialResponse(config: unknown): JsonValue;
  validateSubmission(config: unknown, response: unknown): import("@/domain/mechanic-families/v2/shared").SubmissionIssue[];
  summarizeResponse(response: unknown): string;
  Renderer: (props: TaskRendererProps<JsonValue, JsonValue>) => ReturnType<typeof createElement>;
}
function validatedHandle<C extends JsonValue, R extends JsonValue>(registration: ProductionMechanic<C, R>): ProductionMechanicHandle {
  const descriptor = registration.descriptor;
  const parseResponse = (value: unknown) => parseFamilyResponse(descriptor, value);
  return Object.freeze({
    id: descriptor.id, version: descriptor.version,
    parseTask: (value: unknown) => parseFamilyTask(descriptor, value), parseResponse,
    createInitialResponse: (config: unknown) => parseResponse(descriptor.createInitialResponse(descriptor.configSchema.parse(config))),
    validateSubmission: (config: unknown, response: unknown) => descriptor.validateSubmission(descriptor.configSchema.parse(config), parseResponse(response)),
    summarizeResponse: (response: unknown) => registration.summarizeResponse(parseResponse(response)),
    Renderer: (props: TaskRendererProps<JsonValue, JsonValue>) => createElement(registration.Renderer, {
      ...props, task: parseFamilyTask(descriptor, props.task), response: parseResponse(props.response),
      onChange: (response: R) => props.onChange(parseResponse(response)),
    }),
  });
}
// Erasure is confined to this validated adapter: no caller can reach a typed function without parsing first.
export const productionMechanics: readonly ProductionMechanicHandle[] = Object.freeze(
  [...foundations, ...investigation, ...construction, ...communication].map((registration) =>
    validatedHandle(registration as unknown as ProductionMechanic<JsonValue, JsonValue>)),
);
export function getProductionMechanic(id: string, version: number): ProductionMechanicHandle | null {
  return productionMechanics.find((entry) => entry.id === id && entry.version === version) ?? null;
}
