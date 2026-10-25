import "server-only";
import type { GenerationValidationIssue, PreparedModule } from "@/server/course-generation/contracts";
import { taskDigest } from "@/server/mechanics/digest";

/** Counts neither alternate IDs nor recycled evidence groups as fresh assessment material. Semantic independence is separately reviewed. */
export function validateAdaptiveMaterial(modules: readonly PreparedModule[]): GenerationValidationIssue[] {
  const issues: GenerationValidationIssue[] = [], tasks = modules.flatMap((section) => section.tasks.map(({ candidate }) => candidate));
  const add = (code: GenerationValidationIssue["code"], taskId: string, message: string) => issues.push({ code, path: ["adaptiveMaterial", taskId], message });
  const required = tasks.filter((task) => task.privateTask.assessment.role === "required"), optional = tasks.filter((task) => task.privateTask.assessment.role !== "required");
  const body = (candidate: typeof tasks[number]) => taskDigest({ mechanicId: candidate.task.mechanicId, mechanicVersion: candidate.task.mechanicVersion,
    instruction: candidate.task.instruction, config: candidate.task.config });
  const mappings = (candidate: typeof tasks[number], outcomeId: string) => candidate.privateTask.assessment.outcomes.find((outcome) => outcome.outcomeId === outcomeId)?.dimensions.map((dimension) => dimension.dimensionId) ?? [];
  const independent = (candidate: typeof tasks[number], original: typeof tasks[number]) => candidate.task.id !== original.task.id &&
    candidate.privateTask.assessment.evidenceGroupId !== original.privateTask.assessment.evidenceGroupId && body(candidate) !== body(original);
  for (const candidate of optional) {
    if (tasks.some((other) => other.task.id !== candidate.task.id && (other.privateTask.assessment.evidenceGroupId === candidate.privateTask.assessment.evidenceGroupId || body(other) === body(candidate))))
      add("invalid_transfer", candidate.task.id, "Optional material needs a distinct authored task/context and evidence group, not renamed existing assessment material");
  }
  const criteria = new Map<string, Set<string>>();
  for (const candidate of required) for (const mapping of candidate.privateTask.assessment.outcomes) {
    const known = criteria.get(mapping.outcomeId) ?? new Set<string>(); mapping.dimensions.forEach((dimension) => known.add(dimension.dimensionId)); criteria.set(mapping.outcomeId, known);
  }
  for (const [outcomeId, dimensions] of criteria) for (const role of ["practice", "diagnostic", "challenge"] as const) for (const dimension of dimensions) {
    if (!optional.some((candidate) => candidate.privateTask.assessment.role === role && mappings(candidate, outcomeId).includes(dimension)))
      add("criterion_mismatch", outcomeId, `Criterion ${dimension} lacks validated optional ${role} material`);
  }
  for (const candidate of required.filter((entry) => entry.task.mechanicId === "outcome_prediction")) {
    for (const mapping of candidate.privateTask.assessment.outcomes) for (const dimension of mapping.dimensions) {
      if (!optional.some((reserve) => mappings(reserve, mapping.outcomeId).includes(dimension.dimensionId) && independent(reserve, candidate)))
        add("invalid_transfer", candidate.task.id, `Locked prediction criterion ${dimension.dimensionId} needs a fresh independent optional assessment`);
    }
  }
  return issues;
}
