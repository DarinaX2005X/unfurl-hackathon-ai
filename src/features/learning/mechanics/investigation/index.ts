"use client";

import type { JsonValue } from "@/domain/common";
import type { FamilyDescriptor } from "@/domain/mechanic-families/v2/shared";
import { stateTracingDescriptor, outcomePredictionDescriptor, causeDiagnosisDescriptor,
  experimentalInvestigationDescriptor, causalInterventionDescriptor, estimationDescriptor,
  strategySelectionDescriptor, sourceInvestigationDescriptor } from "@/domain/mechanic-families/v2/investigation";
import type { ProductionMechanic, TaskRendererProps } from "@/features/learning/player/contracts";
import type { ComponentType } from "react";
import { StateTracingRenderer, OutcomePredictionRenderer, CauseDiagnosisRenderer, ExperimentalInvestigationRenderer,
  CausalInterventionRenderer, EstimationRenderer, StrategySelectionRenderer, SourceInvestigationRenderer } from "./renderers";

function register<C extends JsonValue, R extends JsonValue>(descriptor: FamilyDescriptor<C, R>, Renderer: ComponentType<TaskRendererProps<C, R>>, summarizeResponse: (response: R) => string): ProductionMechanic<C, R> {
  return { descriptor, configSchema: descriptor.configSchema, responseSchema: descriptor.responseSchema,
    createInitialResponse: descriptor.createInitialResponse, Renderer, summarizeResponse };
}
export const stateTracingMechanic = register(stateTracingDescriptor, StateTracingRenderer, (response) => `${response.states.length} intermediate states`);
export const outcomePredictionMechanic = register(outcomePredictionDescriptor, OutcomePredictionRenderer, (response) => response.interval.lower === null || response.interval.upper === null ? "Prediction not entered" : `${response.interval.lower} to ${response.interval.upper} ${response.interval.unit ?? ""}`);
export const causeDiagnosisMechanic = register(causeDiagnosisDescriptor, CauseDiagnosisRenderer, (response) => `${response.consistentCauseIds.length} retained causes; ${response.conclusion ?? "conclusion not entered"}`);
export const experimentalInvestigationMechanic = register(experimentalInvestigationDescriptor, ExperimentalInvestigationRenderer, (response) => `${response.observationReceiptIds.length} cited observations; ${response.conclusionHypothesisId ?? "inconclusive"}`);
export const causalInterventionMechanic = register(causalInterventionDescriptor, CausalInterventionRenderer, (response) => Object.entries(response.assignments).map(([name, value]) => `${name}: ${value ?? "not set"}`).join(", "));
export const estimationMechanic = register(estimationDescriptor, EstimationRenderer, (response) => response.lower === null || response.upper === null ? "Estimate not entered" : `${response.lower} to ${response.upper} ${response.unit ?? ""}`);
export const strategySelectionMechanic = register(strategySelectionDescriptor, StrategySelectionRenderer, (response) => response.strategyId ?? "Strategy not selected");
export const sourceInvestigationMechanic = register(sourceInvestigationDescriptor, SourceInvestigationRenderer, (response) => `${response.verdict ?? "Assessment not entered"}; ${response.citations.length} citations`);

export const mechanics = [stateTracingMechanic, outcomePredictionMechanic, causeDiagnosisMechanic,
  experimentalInvestigationMechanic, causalInterventionMechanic, estimationMechanic,
  strategySelectionMechanic, sourceInvestigationMechanic] as const;
export { StateTracingRenderer, OutcomePredictionRenderer, CauseDiagnosisRenderer, ExperimentalInvestigationRenderer,
  CausalInterventionRenderer, EstimationRenderer, StrategySelectionRenderer, SourceInvestigationRenderer } from "./renderers";
