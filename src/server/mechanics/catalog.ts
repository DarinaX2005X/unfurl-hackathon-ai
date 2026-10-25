import "server-only";
import { z } from "zod";
import { productionMechanicManifest, type MechanicManifestEntry } from "@/domain/mechanic-manifest";
import { createTaskPublicSchema, type TaskPublic } from "@/domain/mechanics";
import { StateTracingConfigSchema } from "@/domain/mechanic-families/v2/investigation";
import { PYTHON_RUNTIME_PROFILE } from "@/domain/mechanic-families/v3/python";
import { RubricRequestSchema } from "@/server/evaluation/contracts";
import { getServerMechanic } from "./registry";
import { taskDigest } from "./digest";
import { MechanicRuntimeCapabilitiesSchema, type MechanicRuntimeCapabilities } from "./contracts";

export function getMechanicAuthoringContract(id: string, version: number) {
  const registration = getServerMechanic(id, version);
  if (!registration) throw new Error(`Unsupported mechanic: ${id}@${version}`);
  // V3 uses bounded preflight pipes and source normalization. The output schema describes
  // their concrete validated data; the input side of a preflight is deliberately unknown.
  const io = version === 3 ? "output" as const : "input" as const;
  // Zod throws on unrepresentable types. Never substitute an unconstrained {} or an any schema.
  return {
    id: registration.descriptor.id, version: registration.descriptor.version,
    publicTaskSchema: z.toJSONSchema(createTaskPublicSchema(registration.descriptor.configSchema), { io }),
    configSchema: z.toJSONSchema(registration.descriptor.configSchema, { io }),
    responseSchema: z.toJSONSchema(registration.descriptor.responseSchema, { io }),
    evaluatorDataSchema: z.toJSONSchema(registration.privateSchema, { io }),
    runtimeRefinementsRequired: true as const,
  };
}

let catalogDigest: string | undefined;
export function getCapabilityCatalogDigest(): string {
  return catalogDigest ??= taskDigest({ catalogVersion: 1, validatorVersion: "mechanic-readiness-v1", alternativeSpaceProofVersion: 1,
    mechanics: productionMechanicManifest.map((metadata) => ({ metadata,
      authoring: getMechanicAuthoringContract(metadata.id, metadata.version) })),
  });
}
export function mechanicRuntimeBlockers(entry: MechanicManifestEntry, runtime: MechanicRuntimeCapabilities): string[] {
  const reasons: string[] = [];
  if (entry.requirements.includes("model")) {
    if (!runtime.model?.available) reasons.push("model_unavailable");
    if (!runtime.budget.available) reasons.push("model_budget_unavailable");
  }
  if (entry.requirements.includes("activity") || entry.actions.length > 0) {
    if (!runtime.activity.durable) reasons.push("durable_activity_unavailable");
    for (const action of entry.actions) if (!runtime.activity.supportedActions.includes(action)) reasons.push(`activity_action_unavailable:${action}`);
    if (entry.actions.includes("dialogue.turn") && !runtime.activity.dialogue) reasons.push("dialogue_unavailable");
  }
  if (entry.requirements.includes("sandbox") && (!runtime.sandbox.available || runtime.sandbox.profiles.length === 0)) reasons.push("sandbox_unavailable");
  if (entry.version === 3 && !runtime.sandbox.profiles.includes(PYTHON_RUNTIME_PROFILE)) reasons.push(`sandbox_profile_unavailable:${PYTHON_RUNTIME_PROFILE}`);
  return reasons;
}
/** Membership is stable even when a runtime provider is unavailable. */
export function getGenerationMechanicCatalog(runtimeValue: MechanicRuntimeCapabilities) {
  const runtime = MechanicRuntimeCapabilitiesSchema.parse(runtimeValue);
  return { catalogVersion: 1 as const, capabilityCatalogDigest: getCapabilityCatalogDigest(),
    entries: productionMechanicManifest.map((metadata) => {
      const reasons = mechanicRuntimeBlockers(metadata, runtime);
      return { ...metadata, status: reasons.length ? "blocked" as const : "available" as const, reasons };
    }),
  };
}

/** Successful-grade dimensions, not failure-only diagnostic IDs such as admissibility/current_run. */
export function getAssessmentDimensionIds(taskValue: TaskPublic, evaluatorData: unknown): string[] {
  const registration = getServerMechanic(taskValue.mechanicId, taskValue.mechanicVersion);
  if (!registration) throw new Error("Unsupported mechanic/version");
  const task = registration.parseTask(taskValue), data = registration.parsePrivate(evaluatorData);
  if (task.mechanicVersion === 3) return z.array(z.string().min(1).max(128)).min(1).max(24)
    .refine((ids) => new Set(ids).size === ids.length, "Python dimensions must be unique").parse(data.requiredDimensions);
  const rubric = (key = "rubric", prefix = "") => RubricRequestSchema.shape.rubric.parse(data[key]).dimensions.map(({ id }) => `${prefix}${id}`);
  let ids: string[];
  switch (task.mechanicId) {
    case "recall_reconstruction": ids = rubric(); break;
    case "confusable_discrimination": ids = ["selected_case", "evidence_passage", ...rubric()]; break;
    case "rule_induction": ids = ["slope", "intercept", "new_inputs"]; break;
    case "example_construction": ids = ["total", "false_positives", "true_positives", "false_negatives"]; break;
    case "counterexample_construction": ids = ["antecedent", "refutation"]; break;
    case "procedure_reconstruction": ids = ["dependencies"]; break;
    case "relational_mapping": ids = ["directed_relations"]; break;
    case "representation_translation": ids = ["metric_value"]; break;
    case "state_tracing": ids = StateTracingConfigSchema.parse(task.config).inputs.map((_, index) => `step.${index + 1}`); break;
    case "outcome_prediction": ids = ["prediction"]; break;
    case "cause_diagnosis": case "strategy_selection": case "source_investigation": ids = rubric(); break;
    case "experimental_investigation": ids = ["identification", ...rubric("rubric", "reasoning.")]; break;
    case "causal_intervention": ids = ["target"]; break;
    case "estimation": ids = ["quantity", ...rubric("basisRubric", "reasoning.")]; break;
    case "plan_construction": ids = ["executable_plan"]; break;
    case "artifact_construction": case "diagnosis_repair": {
      ids = ["numeric_cases", ...(Array.isArray(data.properties) && data.properties.length > 0 ? ["properties"] : [])];
      if (task.mechanicId === "diagnosis_repair" && data.explanationRubric !== null) ids.push("diagnosis", ...rubric("explanationRubric"));
      break;
    }
    case "adversarial_testing": ids = ["reproduced_defect"]; break;
    case "constrained_optimization": ids = ["constraints", "improvement"]; break;
    case "analogy_transfer": case "self_explanation": case "argument_rebuttal": case "critique_revision":
    case "misconception_tutoring": case "information_gap": case "role_simulation": case "audience_mediation": ids = rubric(); break;
  }
  if (new Set(ids).size !== ids.length || ids.length > 24 || ids.some((id) => id.length > 128)) throw new Error("Invalid successful assessment dimensions");
  return ids;
}
