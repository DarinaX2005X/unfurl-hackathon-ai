import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { loadVerifiedModule } from "@/server/course-materialization/course";
import { GenerationEvidenceRepository } from "@/server/course-generation/repository";
import { CompletedModuleCheckpointSchema } from "@/server/course-generation/completion";
import { TaskValidationRepository } from "@/server/course-validation/receipts";
import * as planning from "@/server/course-generation/planning";
import * as plans from "@/server/course-generation/plan-stages";
import { adaptiveFixture, id, digest } from "./fixtures";
import { runtime } from "../mechanic-registry/fixtures";

afterEach(() => vi.restoreAllMocks());

it("requires each candidate to use the module's exact checked knowledge revision before task validation", async () => {
  const data = adaptiveFixture(), section = data.modules[0]!, knowledgeStepId = id(810), candidateStepId = id(820);
  const checkpoint = CompletedModuleCheckpointSchema.parse({ kind: "course.module.completed", module: section, coverage: data.coverage,
    knowledgeStepId, planStepId: id(811), readingStepIds: [], reviewStepId: id(812),
    taskReferences: [{ candidateStepId, casePlanStepId: id(821), caseStepIds: [id(822), id(823)], reviewStepId: id(824) }] });
  vi.spyOn(GenerationEvidenceRepository.prototype, "loadKnowledge").mockResolvedValue({
    step: { id: knowledgeStepId, inputDigest: digest, result: { kind: "course.module.knowledge.checked.v1", knowledge: data.knowledge[0]!,
      sourceKnowledgeStepId: id(809), sourceReadStepIds: [], reviewStepIds: [id(808)], correction: null } }, knowledge: data.knowledge[0]!, facts: data.context });
  vi.spyOn(plans, "loadVerifiedModulePlan").mockResolvedValue({ stepId: id(811), plan: { moduleId: section.moduleId, lessons: [], tasks: [], coverage: data.coverage } });
  vi.spyOn(planning, "validateModulePlan").mockReturnValue([]);
  const taskResult = { knowledgeStepId: id(899), moduleId: section.moduleId };
  vi.spyOn(GenerationEvidenceRepository.prototype, "loadTaskCandidate").mockResolvedValue({ step: { id: candidateStepId, inputDigest: digest, result: taskResult } } as never);
  const validation = vi.spyOn(TaskValidationRepository.prototype, "validateStoredTask").mockRejectedValue(new Error("Reached task validation"));
  const step = { id: id(830), inputDigest: digest, result: checkpoint };
  await expect(loadVerifiedModule({} as DbTransaction, {} as ApprovedBuildBinding, step, runtime)).rejects.toThrow("provider.invalid_output");
  expect(validation).not.toHaveBeenCalled();
  taskResult.knowledgeStepId = knowledgeStepId;
  await expect(loadVerifiedModule({} as DbTransaction, {} as ApprovedBuildBinding, step, runtime)).rejects.toThrow("Reached task validation");
  expect(validation).toHaveBeenCalledOnce();
});
