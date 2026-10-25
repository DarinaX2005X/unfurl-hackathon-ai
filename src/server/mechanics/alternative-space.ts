import "server-only";
import { JsonObjectSchema, type JsonValue } from "@/domain/common";
import {
  ExampleConstructionConfigSchema, ProcedureReconstructionConfigSchema, RepresentationTranslationConfigSchema,
  RelationalMappingConfigSchema, canonicalNode,
} from "@/domain/mechanic-families/v2/foundations";
import { StateTracingConfigSchema, OutcomePredictionConfigSchema, traceState, predictOutcome } from "@/domain/mechanic-families/v2/investigation";
import { NumericToleranceSchema, convertQuantity, type Edge } from "@/domain/mechanic-families/v2/shared";
import { ProcedureReconstructionPrivateSchema, RelationalMappingPrivateSchema } from "@/server/evaluation/foundations";
import type { AlternativeSpaceEvidence, PreparedTaskCandidate, TaskValidationEvidence } from "./contracts";
import { canonicalTaskJson } from "./digest";

function exactTolerance(candidate: PreparedTaskCandidate): boolean {
  const tolerance = NumericToleranceSchema.parse(candidate.privateTask.evaluatorData.tolerance);
  return tolerance.absTol === 0 && tolerance.relTol === 0;
}
/** Replays a bounded proof. The authored assertion that an answer is unique is never sufficient. */
export function verifyAlternativeSpaceEvidence(candidate: PreparedTaskCandidate, evidence: AlternativeSpaceEvidence,
  validResponses: JsonValue[], caseEvidence: TaskValidationEvidence[]): boolean {
  if (evidence.candidateDigest !== candidate.candidateDigest || evidence.approvalDigest !== candidate.approvalDigest ||
      evidence.capabilityCatalogDigest !== candidate.capabilityCatalogDigest || validResponses.length === 0) return false;
  const analysis = evidence.analysis;
  if (analysis.method === "semantic") {
    const decision = analysis.decision;
    if (decision.status !== "evaluated" || decision.outcome !== "correct" || decision.dimensions.length !== 2 ||
      !["response_space", "trap_discrimination"].every((id) => decision.dimensions.some((dimension) => dimension.id === id && dimension.status === "met"))) return false;
    const traps = caseEvidence.filter((item) => item.kind === "response_case" && analysis.trapCaseIds.includes(item.caseId));
    return traps.length === analysis.trapCaseIds.length && traps.every((item) => item.kind === "response_case" && item.category === "invalid" && !item.rejectedAsInvalid &&
      item.modelCallId !== null && item.decision?.status === "evaluated" && item.decision.outcome !== "correct" && item.decision.dimensions.some((dimension) => dimension.status !== "met")) &&
      new Set(traps.map((item) => canonicalTaskJson(item.kind === "response_case" ? item.response : null))).size === traps.length;
  }
  const proof = analysis.proof, id = candidate.task.mechanicId;
  try {
    const responses = validResponses.map((response) => JsonObjectSchema.parse(response));
    if (proof.kind === "exact_state_trace" && id === "state_tracing") {
      if (!exactTolerance(candidate)) return false;
      const expected = canonicalTaskJson(traceState(StateTracingConfigSchema.parse(candidate.task.config)));
      return canonicalTaskJson(proof.states) === expected && responses.every((response) => canonicalTaskJson(response.states) === expected);
    }
    if (proof.kind === "single_prediction_interval" && id === "outcome_prediction") {
      const config = OutcomePredictionConfigSchema.parse(candidate.task.config);
      if (!exactTolerance(candidate) || config.maxIntervalWidth !== 0 || config.allowedUnits.length !== 1) return false;
      const quantity = convertQuantity(predictOutcome(config).quantity, config.allowedUnits[0]!);
      const interval = { lower: quantity.value, upper: quantity.value, unit: quantity.unit };
      return canonicalTaskJson(proof.quantity) === canonicalTaskJson(quantity) && responses.every((response) => canonicalTaskJson(response.interval) === canonicalTaskJson(interval));
    }
    if (proof.kind === "unique_procedure_order" && id === "procedure_reconstruction") {
      const config = ProcedureReconstructionConfigSchema.parse(candidate.task.config);
      const data = ProcedureReconstructionPrivateSchema.parse(candidate.privateTask.evaluatorData);
      const remaining = new Set(config.steps.map((step) => step.id)), result: string[] = [];
      while (remaining.size) {
        const ready = [...remaining].filter((step) => data.prerequisites.every((edge) => edge.after !== step || !remaining.has(edge.before)));
        if (ready.length !== 1) return false;
        result.push(ready[0]!); remaining.delete(ready[0]!);
      }
      return canonicalTaskJson(proof.stepIds) === canonicalTaskJson(result) && responses.every((response) => canonicalTaskJson(response.stepIds) === canonicalTaskJson(result));
    }
    if (proof.kind === "exact_metric_quantity" && id === "representation_translation") {
      const config = RepresentationTranslationConfigSchema.parse(candidate.task.config), matrix = config.from;
      if (!exactTolerance(candidate) || config.allowedUnits.length !== 1) return false;
      const value = config.to === "precision" ? matrix.tp / (matrix.tp + matrix.fp) : config.to === "recall" ? matrix.tp / (matrix.tp + matrix.fn) : (matrix.tp + matrix.tn) / (matrix.tp + matrix.fp + matrix.tn + matrix.fn);
      const quantity = convertQuantity({ value, unit: "ratio" }, config.allowedUnits[0]!);
      return canonicalTaskJson(proof.quantity) === canonicalTaskJson(quantity) && responses.every((response) => canonicalTaskJson(response.quantity) === canonicalTaskJson(quantity));
    }
    if (proof.kind === "single_confusion_matrix" && id === "example_construction") {
      const { constraints } = ExampleConstructionConfigSchema.parse(candidate.task.config);
      if (constraints.falsePositive + constraints.minTruePositive + constraints.minFalseNegative !== constraints.total) return false;
      const matrix = { tp: constraints.minTruePositive, fp: constraints.falsePositive, tn: 0, fn: constraints.minFalseNegative };
      return canonicalTaskJson(proof.matrix) === canonicalTaskJson(matrix) && responses.every((response) => canonicalTaskJson(response.matrix) === canonicalTaskJson(matrix));
    }
    if (proof.kind === "single_accepted_graph" && id === "relational_mapping") {
      const config = RelationalMappingConfigSchema.parse(candidate.task.config);
      const data = RelationalMappingPrivateSchema.parse(candidate.privateTask.evaluatorData);
      const key = (edges: Edge[]) => canonicalTaskJson(edges.map((edge) => ({ from: canonicalNode(config, edge.from), relation: edge.relation, to: canonicalNode(config, edge.to) }))
        .sort((left, right) => canonicalTaskJson(left).localeCompare(canonicalTaskJson(right))));
      const accepted = new Set(data.acceptedGraphs.map(key));
      return accepted.size === 1 && accepted.has(key(proof.canonicalEdges)) && responses.every((response) => accepted.has(key(response.edges as Edge[])));
    }
  } catch { return false; }
  return false;
}
