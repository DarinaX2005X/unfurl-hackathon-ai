"use client";

import type { JsonValue } from "@/domain/common";
import type { FamilyDescriptor } from "@/domain/mechanic-families/v2/shared";
import type { ProductionMechanic } from "@/features/learning/player/contracts";
import {
  analogyTransferDescriptor, selfExplanationDescriptor, argumentRebuttalDescriptor, critiqueRevisionDescriptor,
  misconceptionTutoringDescriptor, informationGapDescriptor, roleSimulationDescriptor, audienceMediationDescriptor,
} from "@/domain/mechanic-families/v2/communication";
import {
  AnalogyTransferRenderer, SelfExplanationRenderer, ArgumentRebuttalRenderer, CritiqueRevisionRenderer,
  MisconceptionTutoringRenderer, InformationGapRenderer, RoleSimulationRenderer, AudienceMediationRenderer,
} from "./Renderers";

function register<C extends JsonValue, R extends JsonValue>(
  descriptor: FamilyDescriptor<C, R>, Renderer: ProductionMechanic<C, R>["Renderer"], summarizeResponse: (response: R) => string,
): ProductionMechanic<C, R> {
  return { descriptor, configSchema: descriptor.configSchema, responseSchema: descriptor.responseSchema,
    createInitialResponse: descriptor.createInitialResponse, Renderer, summarizeResponse };
}
export const analogyTransferMechanic = register(analogyTransferDescriptor, AnalogyTransferRenderer,
  (response) => `${response.mappings.length} relationships. Limit: ${response.limit}`);
export const selfExplanationMechanic = register(selfExplanationDescriptor, SelfExplanationRenderer,
  (response) => `${response.principle}\nLimit: ${response.limit}`);
export const argumentRebuttalMechanic = register(argumentRebuttalDescriptor, ArgumentRebuttalRenderer,
  (response) => `${response.claim}\nReasoning: ${response.warrant}\nObjection: ${response.counterargument}\nResponse: ${response.response}`);
export const critiqueRevisionMechanic = register(critiqueRevisionDescriptor, CritiqueRevisionRenderer,
  (response) => `${response.findings.length} findings.\nRevision: ${response.revision}`);
export const misconceptionTutoringMechanic = register(misconceptionTutoringDescriptor, MisconceptionTutoringRenderer,
  (response) => `Diagnostic question: ${response.diagnosticQuestion}\nCorrection: ${response.correction}\nCheck: ${response.check}`);
export const informationGapMechanic = register(informationGapDescriptor, InformationGapRenderer, (response) => response.decision);
export const roleSimulationMechanic = register(roleSimulationDescriptor, RoleSimulationRenderer,
  (response) => `Commitments: ${response.agreement.commitments.join("; ")}\nConditions: ${response.agreement.conditions.join("; ")}\n${response.rationale}`);
export const audienceMediationMechanic = register(audienceMediationDescriptor, AudienceMediationRenderer, (response) => response.text);

export const mechanics = [analogyTransferMechanic, selfExplanationMechanic, argumentRebuttalMechanic, critiqueRevisionMechanic,
  misconceptionTutoringMechanic, informationGapMechanic, roleSimulationMechanic, audienceMediationMechanic] as const;

export {
  AnalogyTransferRenderer, SelfExplanationRenderer, ArgumentRebuttalRenderer, CritiqueRevisionRenderer,
  MisconceptionTutoringRenderer, InformationGapRenderer, RoleSimulationRenderer, AudienceMediationRenderer,
};
