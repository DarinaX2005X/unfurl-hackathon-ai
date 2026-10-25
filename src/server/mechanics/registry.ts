import "server-only";
import type { z } from "zod";
import { JsonObjectSchema, type JsonObject, type JsonValue } from "@/domain/common";
import type { TaskPublic } from "@/domain/mechanics";
import { descriptors as foundations } from "@/domain/mechanic-families/v2/foundations";
import { descriptors as investigation } from "@/domain/mechanic-families/v2/investigation";
import { descriptors as construction } from "@/domain/mechanic-families/v2/construction";
import { descriptors as communication } from "@/domain/mechanic-families/v2/communication";
import { parseFamilyTask, parseFamilyResponse, type FamilyDescriptor } from "@/domain/mechanic-families/v2/shared";
import { evaluators as foundationEvaluators } from "@/server/evaluation/foundations";
import { evaluators as investigationEvaluators } from "@/server/evaluation/investigation";
import { evaluators as constructionEvaluators } from "@/server/evaluation/construction";
import { evaluators as communicationEvaluators } from "@/server/evaluation/communication";
import type { AuthoritativeActivity, EvaluationContext, EvaluatorRegistration, GradeDecision } from "@/server/evaluation/contracts";

export const productionDescriptors = [...foundations, ...investigation, ...construction, ...communication] as const;
export const productionEvaluators = [...foundationEvaluators, ...investigationEvaluators, ...constructionEvaluators, ...communicationEvaluators] as const;
export interface ServerMechanicHandle {
  descriptor: FamilyDescriptor<JsonValue, JsonValue>;
  privateSchema: z.ZodType;
  parseTask(value: unknown): TaskPublic<JsonObject>;
  parseResponse(value: unknown): JsonValue;
  parsePrivate(value: unknown): JsonObject;
  evaluate(input: { task: unknown; response: unknown; privateData: unknown; activity: AuthoritativeActivity | null }, context: EvaluationContext): Promise<GradeDecision>;
}
function handle<C extends JsonValue, R extends JsonValue, P>(descriptor: FamilyDescriptor<C, R>, evaluator: EvaluatorRegistration<C, R, P>): ServerMechanicHandle {
  return {
    // The descriptor is only exposed server-side; unknown input is always parsed by the handles below.
    descriptor: descriptor as unknown as FamilyDescriptor<JsonValue, JsonValue>, privateSchema: evaluator.privateSchema,
    parseTask(value) { const task = parseFamilyTask(descriptor, value); return { ...task, config: JsonObjectSchema.parse(task.config) }; },
    parseResponse: (value) => parseFamilyResponse(descriptor, value),
    parsePrivate: (value) => JsonObjectSchema.parse(evaluator.privateSchema.parse(value)),
    evaluate(input, context) { return evaluator.evaluate({ ...input, task: parseFamilyTask(descriptor, input.task),
      response: parseFamilyResponse(descriptor, input.response), privateData: evaluator.privateSchema.parse(input.privateData) }, context); },
  };
}
const registrations = productionDescriptors.map((descriptor) => {
  const evaluator = productionEvaluators.find((candidate) => candidate.id === descriptor.id && candidate.version === descriptor.version);
  if (!evaluator) throw new Error(`Missing production evaluator: ${descriptor.id}@${descriptor.version}`);
  // Heterogeneous tuple erasure is confined here; both family schemas are retained and used on every call.
  return handle(descriptor as unknown as FamilyDescriptor<JsonValue, JsonValue>,
    evaluator as unknown as EvaluatorRegistration<JsonValue, JsonValue, unknown>);
});
export function getServerMechanic(id: string, version: number): ServerMechanicHandle | null {
  return registrations.find((registration) => registration.descriptor.id === id && registration.descriptor.version === version) ?? null;
}
