"use client";

import type { JsonValue } from "@/domain/common";
import type { FamilyDescriptor } from "@/domain/mechanic-families/v2/shared";
import {
  confusableDiscriminationDescriptor, counterexampleConstructionDescriptor, exampleConstructionDescriptor,
  procedureReconstructionDescriptor, recallReconstructionDescriptor, relationalMappingDescriptor,
  representationTranslationDescriptor, ruleInductionDescriptor,
} from "@/domain/mechanic-families/v2/foundations";
import type { ProductionMechanic } from "@/features/learning/player/contracts";
import {
  ConfusableDiscriminationRenderer, CounterexampleConstructionRenderer, ExampleConstructionRenderer,
  ProcedureReconstructionRenderer, RecallReconstructionRenderer, RelationalMappingRenderer,
  RepresentationTranslationRenderer, RuleInductionRenderer,
} from "./renderers";

function registration<C extends JsonValue, R extends JsonValue>(descriptor: FamilyDescriptor<C, R>,
  Renderer: ProductionMechanic<C, R>["Renderer"], summarizeResponse: (response: R) => string): ProductionMechanic<C, R> {
  return { descriptor, configSchema: descriptor.configSchema, responseSchema: descriptor.responseSchema,
    createInitialResponse: descriptor.createInitialResponse, Renderer, summarizeResponse };
}
export const recallReconstructionMechanic = registration(recallReconstructionDescriptor, RecallReconstructionRenderer, (response) => response.text);
export const confusableDiscriminationMechanic = registration(confusableDiscriminationDescriptor, ConfusableDiscriminationRenderer,
  (response) => `${response.caseId ?? "No case selected"}: ${response.distinction}`);
export const ruleInductionMechanic = registration(ruleInductionDescriptor, RuleInductionRenderer,
  (response) => `${response.rule.form === "coefficients" ? `y = ${response.rule.slope ?? "?"} × x + ${response.rule.intercept ?? "?"}` : "Expression rule"}; predictions: ${response.probeValues.map((value) => value ?? "?").join(", ")}`);
export const exampleConstructionMechanic = registration(exampleConstructionDescriptor, ExampleConstructionRenderer,
  (response) => `True positives ${response.matrix.tp ?? "?"}, false positives ${response.matrix.fp ?? "?"}, true negatives ${response.matrix.tn ?? "?"}, false negatives ${response.matrix.fn ?? "?"}`);
export const counterexampleConstructionMechanic = registration(counterexampleConstructionDescriptor, CounterexampleConstructionRenderer,
  (response) => `Constant prediction ${response.model.constant ?? "?"}; ${response.train.length} training rows and ${response.validation.length} validation rows`);
export const procedureReconstructionMechanic = registration(procedureReconstructionDescriptor, ProcedureReconstructionRenderer,
  (response) => response.stepIds.length ? response.stepIds.join(", then ") : "No steps placed");
export const relationalMappingMechanic = registration(relationalMappingDescriptor, RelationalMappingRenderer,
  (response) => response.edges.map((edge) => `${edge.from} ${edge.relation.replaceAll("_", " ")} ${edge.to}`).join("; "));
export const representationTranslationMechanic = registration(representationTranslationDescriptor, RepresentationTranslationRenderer,
  (response) => `${response.quantity.value ?? "No value"} ${response.quantity.unit ?? "No unit"}`);

export const mechanics = [recallReconstructionMechanic, confusableDiscriminationMechanic, ruleInductionMechanic,
  exampleConstructionMechanic, counterexampleConstructionMechanic, procedureReconstructionMechanic,
  relationalMappingMechanic, representationTranslationMechanic] as const;

export { ConfusableDiscriminationRenderer, CounterexampleConstructionRenderer, ExampleConstructionRenderer,
  ProcedureReconstructionRenderer, RecallReconstructionRenderer, RelationalMappingRenderer,
  RepresentationTranslationRenderer, RuleInductionRenderer } from "./renderers";
