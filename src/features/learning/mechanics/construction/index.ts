"use client";

import {
  artifactConstructionDescriptor, adversarialTestingDescriptor, constrainedOptimizationDescriptor,
  diagnosisRepairDescriptor, planConstructionDescriptor,
  type ArtifactConstructionConfig, type ArtifactConstructionResponse,
  type AdversarialTestingConfig, type AdversarialTestingResponse,
  type ConstrainedOptimizationConfig, type ConstrainedOptimizationResponse,
  type DiagnosisRepairConfig, type DiagnosisRepairResponse,
  type PlanConstructionConfig, type PlanConstructionResponse,
} from "@/domain/mechanic-families/v2/construction";
import type { ProductionMechanic } from "@/features/learning/player/contracts";
import {
  ArtifactConstructionRenderer, AdversarialTestingRenderer, ConstrainedOptimizationRenderer,
  DiagnosisRepairRenderer, PlanConstructionRenderer,
} from "./renderers";

export const planConstructionMechanic: ProductionMechanic<PlanConstructionConfig, PlanConstructionResponse> = {
  descriptor: planConstructionDescriptor, configSchema: planConstructionDescriptor.configSchema,
  responseSchema: planConstructionDescriptor.responseSchema, createInitialResponse: planConstructionDescriptor.createInitialResponse,
  Renderer: PlanConstructionRenderer, summarizeResponse: (response) => `${response.steps.length} plan steps`,
};
export const artifactConstructionMechanic: ProductionMechanic<ArtifactConstructionConfig, ArtifactConstructionResponse> = {
  descriptor: artifactConstructionDescriptor, configSchema: artifactConstructionDescriptor.configSchema,
  responseSchema: artifactConstructionDescriptor.responseSchema, createInitialResponse: artifactConstructionDescriptor.createInitialResponse,
  Renderer: ArtifactConstructionRenderer, summarizeResponse: (response) => response.expression === null ? "No expression yet" : "Constructed a numeric expression",
};
export const diagnosisRepairMechanic: ProductionMechanic<DiagnosisRepairConfig, DiagnosisRepairResponse> = {
  descriptor: diagnosisRepairDescriptor, configSchema: diagnosisRepairDescriptor.configSchema,
  responseSchema: diagnosisRepairDescriptor.responseSchema, createInitialResponse: diagnosisRepairDescriptor.createInitialResponse,
  Renderer: DiagnosisRepairRenderer, summarizeResponse: (response) => `${response.locationPaths.length} defect locations and a repaired expression`,
};
export const adversarialTestingMechanic: ProductionMechanic<AdversarialTestingConfig, AdversarialTestingResponse> = {
  descriptor: adversarialTestingDescriptor, configSchema: adversarialTestingDescriptor.configSchema,
  responseSchema: adversarialTestingDescriptor.responseSchema, createInitialResponse: adversarialTestingDescriptor.createInitialResponse,
  Renderer: AdversarialTestingRenderer, summarizeResponse: (response) => `${response.cases.length} test cases`,
};
export const constrainedOptimizationMechanic: ProductionMechanic<ConstrainedOptimizationConfig, ConstrainedOptimizationResponse> = {
  descriptor: constrainedOptimizationDescriptor, configSchema: constrainedOptimizationDescriptor.configSchema,
  responseSchema: constrainedOptimizationDescriptor.responseSchema, createInitialResponse: constrainedOptimizationDescriptor.createInitialResponse,
  Renderer: ConstrainedOptimizationRenderer, summarizeResponse: (response) => Object.entries(response.configuration).map(([name, value]) => `${name} = ${value}`).join(", "),
};

export const mechanics = [planConstructionMechanic, artifactConstructionMechanic, diagnosisRepairMechanic,
  adversarialTestingMechanic, constrainedOptimizationMechanic] as const;

export { ArtifactConstructionRenderer, AdversarialTestingRenderer, ConstrainedOptimizationRenderer,
  DiagnosisRepairRenderer, PlanConstructionRenderer } from "./renderers";
