import "server-only";
import type { Id, IsoDateTime, Revision } from "@/domain/common";
import type { CourseVersion } from "@/domain/course";
import type { Evaluation, LearnerEvidence } from "@/domain/learning";
import { TaskAssessmentSchema, type TaskAssessment } from "@/domain/mechanics";
import { GradeDecisionSchema, type GradeDecision } from "@/server/evaluation/contracts";
import type { AssessedTask } from "./initial-route";

export type CriterionStatus = Evaluation["dimensions"][number]["status"];
export type CanonicalOutcomeDimensions = { outcomeId: Id; dimensionStatuses: Record<string, CriterionStatus> };
/** Server-only joins loaded from immutable semantic revisions, attempts and evidence. */
export interface ConfirmableEvidence extends CanonicalOutcomeDimensions {
  id: Id; enrollmentId: Id; courseVersionId: Id; attemptId: Id; evaluationId: Id;
  evaluationRevision: Revision; currentEvaluationRevision: Revision; evaluationStatus: Evaluation["status"];
  taskId: Id; taskVersion: Revision; evidenceGroupId: Id;
  assistance: "independent" | "hinted" | "worked_example";
  reviewState: "confirmed" | "contested" | "superseded";
  submittedAt: IsoDateTime; feedbackAcknowledgedAt: IsoDateTime | null;
}

/** Local evaluator labels never become cross-task outcome identifiers. */
export function mapCanonicalDimensions(assessmentInput: TaskAssessment, decisionInput: GradeDecision): CanonicalOutcomeDimensions[] {
  const assessment = TaskAssessmentSchema.parse(assessmentInput);
  const decision = GradeDecisionSchema.parse(decisionInput);
  const local = new Map(decision.dimensions.map(({ id, status }) => [id, status]));
  return assessment.outcomes.map(({ outcomeId, dimensions }) => ({ outcomeId,
    dimensionStatuses: Object.fromEntries(dimensions.map(({ dimensionId, evaluationDimensionIds }) => {
      const statuses = evaluationDimensionIds.map((id) => local.get(id));
      const status: CriterionStatus = decision.status !== "evaluated" ? "uncertain" :
        statuses.every((value) => value === "met") ? "met" :
          statuses.some((value) => value === "not_met") ? "not_met" :
            statuses.some((value) => value === undefined || value === "uncertain") ? "uncertain" : "partial";
      return [dimensionId, status];
    })),
  }));
}

export function evidenceObservation(dimensions: Record<string, CriterionStatus>, assistance: ConfirmableEvidence["assistance"]): LearnerEvidence["observation"] {
  const values = Object.values(dimensions);
  if (values.length === 0 || values.some((status) => status === "uncertain")) return "uncertain";
  if (values.every((status) => status === "met")) return assistance === "independent" ? "independent_success" : "assisted_success";
  if (values.every((status) => status === "not_met")) return "incorrect";
  return "partial";
}

export function isCurrentConfirmedEvidence(evidence: ConfirmableEvidence): boolean {
  return evidence.reviewState === "confirmed" && evidence.evaluationStatus === "evaluated" &&
    evidence.evaluationRevision === evidence.currentEvaluationRevision && evidence.assistance !== "worked_example";
}

export function requiredCriteria(tasks: readonly AssessedTask[]): Map<Id, Set<string>> {
  const criteria = new Map<Id, Set<string>>();
  for (const { assessment } of tasks) {
    if (assessment.role !== "required") continue;
    for (const { outcomeId, dimensions } of assessment.outcomes) {
      const ids = criteria.get(outcomeId) ?? new Set<string>();
      dimensions.forEach(({ dimensionId }) => ids.add(dimensionId));
      criteria.set(outcomeId, ids);
    }
  }
  return criteria;
}

export function deriveCriterionCoverage(input: {
  enrollmentId: Id; version: CourseVersion; tasks: readonly AssessedTask[];
  evidence: readonly ConfirmableEvidence[]; traversedLessonIds: readonly Id[];
}): { coveredOutcomeIds: Id[]; pendingOutcomeIds: Id[]; completedRequiredOutcomes: number; totalRequiredOutcomes: number;
  requiredProgramTraversed: boolean; completed: boolean } {
  const required = requiredCriteria(input.tasks);
  const tasks = new Map(input.tasks.map((entry) => [entry.task.id, entry]));
  const met = new Map<Id, Set<string>>();
  for (const evidence of input.evidence) {
    if (evidence.enrollmentId !== input.enrollmentId || evidence.courseVersionId !== input.version.id || !isCurrentConfirmedEvidence(evidence)) continue;
    const entry = tasks.get(evidence.taskId);
    if (!entry || entry.task.taskVersion !== evidence.taskVersion || entry.assessment.evidenceGroupId !== evidence.evidenceGroupId) continue;
    const mapping = entry.assessment.outcomes.find(({ outcomeId }) => outcomeId === evidence.outcomeId);
    if (!mapping) continue;
    const dimensions = met.get(evidence.outcomeId) ?? new Set<string>();
    for (const { dimensionId } of mapping.dimensions) if (evidence.dimensionStatuses[dimensionId] === "met") dimensions.add(dimensionId);
    met.set(evidence.outcomeId, dimensions);
  }
  const coveredOutcomeIds: Id[] = [], pendingOutcomeIds: Id[] = [];
  for (const { id } of input.version.outcomes) {
    const criteria = required.get(id);
    if (criteria && criteria.size > 0 && [...criteria].every((dimension) => met.get(id)?.has(dimension))) coveredOutcomeIds.push(id);
    else pendingOutcomeIds.push(id);
  }
  const visited = new Set(input.traversedLessonIds);
  const requiredProgramTraversed = input.version.lessonIds.length > 0 && input.version.lessonIds.every((id) => visited.has(id));
  return { coveredOutcomeIds, pendingOutcomeIds, completedRequiredOutcomes: coveredOutcomeIds.length,
    totalRequiredOutcomes: input.version.outcomes.length, requiredProgramTraversed,
    completed: input.version.state === "ready" && requiredProgramTraversed && pendingOutcomeIds.length === 0 };
}
