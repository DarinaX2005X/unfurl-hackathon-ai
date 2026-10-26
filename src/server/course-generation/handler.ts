import "server-only";
import { z } from "zod";
import { IdSchema, JsonValueSchema } from "@/domain/common";
import { LessonSchema } from "@/domain/learning";
import type { ModelPort } from "@/server/ai/ports";
import { ProviderFailure } from "@/server/ai/failure";
import { readActiveModelPolicy } from "@/server/ai/active-policy";
import { withCapturedModelPolicy } from "@/server/ai/captured-policy";
import { SEARCH_HEADROOM_POLICY,type SearchPolicyId } from "@/server/ai/model-policy";
import type { ResearchPort } from "@/server/research/ports";
import { currentReaderCapabilities } from "@/server/research/reader-capabilities";
import type { RunHandler, StepEffectContext } from "@/server/runs/ports";
import type { MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import type { PythonExecutionPort } from "@/server/execution/python";
import { advancePythonCase } from "@/server/course-validation/python-cases";
import { advanceActivityCase } from "@/server/course-validation/activity-cases";
import { getServerMechanic } from "@/server/mechanics/registry";
import { inspectCandidateSourceGrounding, projectCanonicalResearchSources } from "@/server/course-validation/source-grounding";
import { validateAdaptiveMaterial } from "@/server/course-validation/adaptive-material";
import { getMechanicAuthoringContract } from "@/server/mechanics/catalog";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { taskDigest } from "@/server/mechanics/digest";
import { prepareModuleCandidate } from "@/server/course-validation/module";
import { TaskValidationRepository, TaskValidationReferencesSchema } from "@/server/course-validation/receipts";
import { CONTENT_REVIEW_INSTRUCTIONS, ContentReviewSchema, createContentReviewInput } from "@/server/course-validation/content-review";
import { CaseEvaluationResultSchema, evaluateResponseCase } from "@/server/course-validation/case-evaluation";
import { createModuleReviewInput } from "@/server/course-validation/module-review";
import { SPECIALIZED_REVIEW_INSTRUCTIONS, SpecializedReviewCheckpointSchema, SpecializedReviewSchema } from "@/server/course-validation/specialized-review";
import { GenerationEvidenceRepository, resolveGenerationPolicy } from "./repository";
import { COURSE_GENERATION_POLICY_KEY, CourseGenerationPolicyCheckpointSchema, COURSE_GENERATION_V2_SCHEMA_DIGEST, COURSE_VALIDATION_V2_POLICY_DIGEST, AuthoredTaskSchema, ContentReviewCheckpointSchema, TaskCasesCheckpointSchema, ProposedTaskCasesSchema, prepareTaskCasesCheckpoint } from "./checkpoints";
import type { AuthoredModule } from "./contracts";
import { LessonReadingSchema, validateModulePlan } from "./planning";
import { advanceModuleResearch } from "./research-stages";
import { advanceKnowledgeCoverage } from "./knowledge-coverage-stages";
import { advanceLessonReading } from "./reading-stages";
import { advanceModuleReview, loadVerifiedModuleReview } from "./module-review-stages";
import { advanceModulePlan } from "./plan-stages";
import { checkpointJson, jsonCheckpointSchema, generationDigests, loadStage, loadStageIndex, mappedModelStage, pureStage } from "./stages";
import { materializeCourse, loadVerifiedModule, findReusableCompletedModule } from "@/server/course-materialization/course";
import { CompletedModuleCheckpointSchema, type CompletedModuleCheckpoint } from "./completion";
import { COMPLETE_TASK_AUTHORING_CONTRACT_POLICY } from "./authored-output-contract";

import { CandidateResultSchema, advanceTaskBatch, advanceCandidateBatch, advanceCasesBatch, advanceReviewBatch, plannedTaskBatches, loadLaterBatchCandidates } from "./newbatch-stages";
const ValidationStageSchema = z.object({ kind: z.literal("course.task.validation"), references: TaskValidationReferencesSchema,
  verdict: z.enum(["passed", "failed", "uncertain"]), checks: JsonValueSchema }).strict();
const RepairSchema = z.object({ kind: z.literal("course.module.repair"), issues: JsonValueSchema }).strict();

export interface CourseGenerationDependencies {
  model: ModelPort; research: (effect: StepEffectContext,searchPolicy?:SearchPolicyId) => ResearchPort;
  runtime: () => Promise<MechanicRuntimeCapabilities>;
  python?: PythonExecutionPort;
}

/** Production pipeline: every advance either reuses stored evidence or commits one bounded effect. */
export function createCourseGenerationHandler(dependencies: CourseGenerationDependencies): RunHandler {
  const evidence = new GenerationEvidenceRepository(), validation = new TaskValidationRepository(evidence);
  return { kind: "generation", version: "course-generation-v1",
    async assertAuthority(tx, target) {
      if (target.kind !== "generation") throw new ProviderFailure("invalid_output");
      const binding = await evidence.loadBinding(tx, { runId: target.runId, ownerId: target.ownerId, lock: true });
      if (binding.version.id !== target.courseVersionId || binding.course.id !== target.courseId || binding.approval.id !== target.approvalId || binding.approval.contentDigest !== target.approvalDigest) throw new ProviderFailure("invalid_output");
    },
    async advance(context) {
      const target = context.claim.target;
      if (target.kind !== "generation") throw new ProviderFailure("invalid_output");
      const binding = await context.read((tx) => evidence.loadBinding(tx, { runId: target.runId, ownerId: target.ownerId }));
      const index = await context.read((tx) => loadStageIndex(tx, context.claim.jobId));
      const batchingV2 = await context.read(async (tx) => (await resolveGenerationPolicy(tx, binding)) === "batch-v2");
      if (batchingV2 && !index.has(COURSE_GENERATION_POLICY_KEY)) {
        await pureStage({ context, binding, key: COURSE_GENERATION_POLICY_KEY, material: { approvalDigest: binding.approval.contentDigest }, schema: jsonCheckpointSchema(CourseGenerationPolicyCheckpointSchema),
          async commit(tx) { return { kind: "course.generation.policy" as const, version: "course-generation-batch-v2" as const, batchSize: 5 as const, maxOutputTokens: 16384 as const, approvalDigest: binding.approval.contentDigest, modelPolicy: await readActiveModelPolicy(tx),
            planPagePolicy: "server-plan-identities-v2" as const, knowledgeCoveragePolicy: "approved-scope-v1" as const,searchPolicy:SEARCH_HEADROOM_POLICY,
            taskAuthoringContractPolicy: COMPLETE_TASK_AUTHORING_CONTRACT_POLICY,
            readerCapabilities: currentReaderCapabilities(),sourceSelectionPolicy:"source-selection-v2" as const }; } });
        return { status: "continue" };
      }
      const policy = batchingV2 ? (await loadStage(context, binding, index, COURSE_GENERATION_POLICY_KEY, CourseGenerationPolicyCheckpointSchema))?.result : undefined;
      const model=withCapturedModelPolicy(dependencies.model,policy?.modelPolicy);
      if (batchingV2) {
        const original = context;
        context = { ...original, step: (spec) => original.step({ ...spec, digests: { ...spec.digests,
          schema: COURSE_GENERATION_V2_SCHEMA_DIGEST, validationPolicy: COURSE_VALIDATION_V2_POLICY_DIGEST } }) };
      }
      const runtime = await dependencies.runtime(), completed: CompletedModuleCheckpoint[] = [];
      for (const outline of binding.draft.modules) {
        const modulePrefix = `course/${outline.id}`, complete = await loadStage(context, binding, index, `${modulePrefix}/complete`, CompletedModuleCheckpointSchema);
        if (complete) { completed.push(await context.read((tx) => loadVerifiedModule(tx, binding, complete, runtime))); continue; }
        const reusable = await context.read((tx) => findReusableCompletedModule(tx, binding, outline.id, runtime));
        if (reusable) {
          await pureStage({ context, binding, key: `${modulePrefix}/complete`, material: { sourceModuleStepId: reusable.sourceStepId }, schema: CompletedModuleCheckpointSchema,
            async commit(tx) {
              const original = await evidence.loadBinding(tx, { runId: binding.run.id });
              if (original.approval.contentDigest !== binding.approval.contentDigest) throw new ProviderFailure("invalid_output");
              await context.emitGeneration(tx, { type: "generation.module.completed", moduleId: outline.id, completedTasks: reusable.checkpoint.module.tasks.length });
              return reusable.checkpoint;
            } });
          return { status: "continue" };
        }
        let round = 0, moduleCorrection: unknown = null;
        while (round < 3) {
          const repair = await loadStage(context, binding, index, `${modulePrefix}/repair/${round}`, RepairSchema);
          if (!repair) break;
          moduleCorrection = repair.result.issues; round++;
        }
        if (round === 3) throw new ProviderFailure("invalid_output");
        const prefix = `${modulePrefix}/round/${round}`;
        const requestRepair = async (issues: unknown) => pureStage({ context, binding, key: `${modulePrefix}/repair/${round}`, material: { round }, schema: RepairSchema,
          async commit() { return { kind: "course.module.repair" as const, issues: checkpointJson(issues) }; } });
        let researched = await advanceModuleResearch({ context, binding, index, moduleId: outline.id, model, research: dependencies.research, priorKnowledge: completed.map((entry) => entry.module.knowledge), batchingV2,
          ...(policy?.knowledgeCoveragePolicy ? { knowledgeCoveragePolicy: policy.knowledgeCoveragePolicy } : {}),...(policy?.searchPolicy?{searchPolicy:policy.searchPolicy}:{}),
          ...(policy?.sourceSelectionPolicy?{sourceSelectionPolicy:policy.sourceSelectionPolicy,readerCapabilities:policy.readerCapabilities!}:{}) });
        if (!researched) return { status: "continue" };
        if (policy?.knowledgeCoveragePolicy === "approved-scope-v1") {
          researched = await advanceKnowledgeCoverage({ context, binding, index, source: researched, round, correction: moduleCorrection,
            model, research: dependencies.research, priorKnowledge: completed.map(entry => entry.module.knowledge),...(policy.searchPolicy?{searchPolicy:policy.searchPolicy}:{}),
            ...(policy.sourceSelectionPolicy?{sourceSelectionPolicy:policy.sourceSelectionPolicy,readerCapabilities:policy.readerCapabilities!}:{}) });
          if (!researched) return { status: "continue" };
        }
        const planStep = await advanceModulePlan({ context, binding, index, key: `${prefix}/plan`, knowledge: researched.knowledge, runtime, correction: moduleCorrection,
          priorModules: completed.map((entry) => ({ moduleId: entry.module.moduleId, outcomes: entry.module.knowledge.outcomes.map(({ outcomeId, learnerAction, criteria }) => ({ outcomeId, learnerAction, criteria })) })), model,
          ...(policy?.planPagePolicy ? { planPagePolicy: policy.planPagePolicy } : {}) });
        if (!planStep) return { status: "continue" };
        const plan = planStep.plan;
        const planIssues = validateModulePlan(plan, { draft: binding.draft, knowledge: researched.knowledge, runtime });
        if (planIssues.length) { await requestRepair({ plan, issues: planIssues }); return { status: "continue" }; }
        const readings: z.infer<typeof LessonReadingSchema>[] = [], readingStepIds: string[] = [];
        for (const lesson of plan.lessons) {
          const reading = await advanceLessonReading({ context, binding, index, key: `${prefix}/reading/${lesson.id}`, planStepId: planStep.stepId,
            lesson, knowledge: researched.knowledge, facts: researched.facts, model });
          if (!reading) return { status: "continue" };
          readings.push(reading.reading); readingStepIds.push(reading.stepId);
        }
        const authoredTasks: AuthoredModule["tasks"] = [], taskReferences: z.infer<typeof TaskValidationReferencesSchema>[] = [];
        const taskBatches = plannedTaskBatches(plan.tasks);
        for (const slot of plan.tasks) {
          const currentBatch = taskBatches.find((batch) => batch[0]!.id === slot.id);
          if (batchingV2 && currentBatch && !await advanceTaskBatch({ context, binding, index, model, moduleId: outline.id, prefix,
            batchKey: `${prefix}/batch/v2/${slot.id}/0`, slots: currentBatch,
            ...(policy?.taskAuthoringContractPolicy ? { taskAuthoringContractPolicy: policy.taskAuthoringContractPolicy } : {}),
            previousTasks: [...completed.flatMap((entry) => entry.module.tasks.map(({ candidate }) => candidate)), ...authoredTasks],
            knowledge: researched.knowledge, knowledgeStepId: researched.step.id, facts: researched.facts })) return { status: "continue" };
          const allPreviousTasks = [...completed.flatMap((entry) => entry.module.tasks.map(({ candidate }) => candidate)), ...authoredTasks];
          const previousTasks = allPreviousTasks.filter((entry) => entry.task.outcomeIds.some((outcomeId) => slot.outcomeIds.includes(outcomeId)));
          let accepted = false;
          let correction: unknown = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const taskPrefix = `${prefix}/task/${slot.id}/${attempt}`, candidateKey = `${taskPrefix}/candidate`;
            const candidateStep = await loadStage(context, binding, index, candidateKey, CandidateResultSchema);
            if (!candidateStep) {
              if (batchingV2) {
                await advanceCandidateBatch({ context, binding, index, model, moduleId: outline.id, prefix,
                  batchKey: `${prefix}/batch/v2/repair/${slot.id}/${attempt}`, slots: [slot], attempt,
                  ...(policy?.taskAuthoringContractPolicy ? { taskAuthoringContractPolicy: policy.taskAuthoringContractPolicy } : {}),
                  previousTasks: [...allPreviousTasks, ...await loadLaterBatchCandidates({ context, binding, index, prefix, taskId: slot.id,
                    slots: taskBatches.find((batch) => batch.some((entry) => entry.id === slot.id))! })],
                  knowledge: researched.knowledge, knowledgeStepId: researched.step.id, facts: researched.facts, correction });
                return { status: "continue" };
              }
              await mappedModelStage({ context, binding, model, key: candidateKey, purpose: "task_authoring", schema: AuthoredTaskSchema, resultSchema: CandidateResultSchema,
                material: { slot, contentLanguage: binding.draft.contentLanguage, approvalDigest: binding.approval.contentDigest, knowledge: researched.knowledge,
                  contract: getMechanicAuthoringContract(slot.mechanicId, slot.mechanicVersion), claims: researched.facts.claims, passages: researched.facts.passages,
                  canonicalSourceEvidence: projectCanonicalResearchSources(researched.facts), existingTaskContexts: previousTasks.map((entry) => ({ task: entry.task, assessment: entry.privateTask.assessment })), correction },
                instructions: "Author this exact planned task and private evaluator. Preserve task ID, chosen mechanic/version, outcome IDs, design, assessmentRole and canonical criterion mappings. taskVersion=1. Set privateTask.assessment.role exactly to slot.assessmentRole: optional practice, diagnostic and challenge tasks must remain optional. Use actual contract JSON schemas; no invented fields. All private hints, expected answers, hidden cases and rubrics belong only in privateTask. Build nontrivial assessment of the learner action, accept valid alternatives and avoid answer leakage. Optional tasks must address their particular learning need with a genuinely different problem/context, not a cosmetic rewrite of existingTaskContexts. Give every independent optional assessment a new evidenceGroupId distinct from all existing material. Include real sourceClaimIds supporting every outcome. For source investigation, copy selected canonicalSourceEvidence.sources objects exactly into public/private source snapshots, including URL, title, retrieval timestamp, content digest and complete passage list. Never invent or rewrite source metadata. Claims from unavailable source snapshots cannot support a task. Return a complete corrected candidate when corrections are supplied.",
                async commit(_tx, authored, authoringOperationId) {
                  try {
                    if (authored.task.id !== slot.id || authored.task.mechanicId !== slot.mechanicId || authored.task.mechanicVersion !== slot.mechanicVersion || authored.privateTask.assessment.role !== slot.assessmentRole || taskDigest(authored.task.outcomeIds) !== taskDigest(slot.outcomeIds) || taskDigest(authored.design) !== taskDigest(slot.design)) throw new Error("Task differs from the approved teaching slot");
                    const candidate = prepareTaskCandidate(authored, { approvalDigest: binding.approval.contentDigest });
                    const grounding = inspectCandidateSourceGrounding(candidate, researched.facts);
                    if (grounding.issues.length) throw new Error(grounding.issues.join(" "));
                    if (candidate.privateTask.assessment.role !== "required" && previousTasks.some((previous) => previous.privateTask.assessment.evidenceGroupId === candidate.privateTask.assessment.evidenceGroupId ||
                        taskDigest({ instruction: previous.task.instruction, config: previous.task.config }) === taskDigest({ instruction: candidate.task.instruction, config: candidate.task.config })))
                      throw new Error("Optional material must use a new problem/context and evidence group; changing only task identity is not independent assessment.");
                    return { kind: "course.task.candidate" as const, moduleId: outline.id, knowledgeStepId: researched.step.id, candidate, authored, authoringOperationId };
                  } catch (error) { return { kind: "course.task.rejected" as const, authored, authoringOperationId, reason: error instanceof Error ? error.message : "Invalid task" }; }
                } });
              return { status: "continue" };
            }
            if (candidateStep.result.kind === "course.task.rejected") { correction = candidateStep.result; continue; }
            const loaded = await context.read((tx) => evidence.loadTaskCandidate(tx, binding, candidateStep.id));
            const candidate = loaded.candidate;
            const casesKey = `${taskPrefix}/cases`, casesStep = await loadStage(context, binding, index, casesKey, TaskCasesCheckpointSchema);
            if (!casesStep) {
              if (batchingV2) {
                await advanceCasesBatch({ context, binding, index, model, moduleId: outline.id, prefix,
                  batchKey: `${prefix}/batch/v2/repair/${slot.id}/${attempt}`, attempt, candidates: [loaded.step] });
                return { status: "continue" };
              }
              await mappedModelStage({ context, binding, model, key: casesKey, purpose: "content_review", schema: ProposedTaskCasesSchema, resultSchema: TaskCasesCheckpointSchema,
                material: { candidate, responseSchema: getMechanicAuthoringContract(candidate.task.mechanicId, candidate.task.mechanicVersion).responseSchema },
                instructions: "Independently design adversarial evaluator cases: a substantively valid response, a distinct valid alternative, and a meaningful field-valid but behaviorally wrong response. Include boundary/trap cases where helpful. Malformed-only negatives are insufficient. For a truly unique deterministic response, supply a replayable alternativeSpaceProof instead of an invented alternative. For activity tasks include action plans with real action types; receipt fields start null or empty and are bound by the server. Never invent activity observations or execution receipts.",
                async commit(_tx, proposal, operationId) { return prepareTaskCasesCheckpoint({ candidateStepId: candidateStep.id, candidateDigest: candidate.candidateDigest, operationId, proposal }); } });
              return { status: "continue" };
            }
            const caseStepIds: string[] = [];
            for (const test of casesStep.result.cases) {
              const key = `${taskPrefix}/case/${test.key}`, evaluated = await loadStage(context, binding, index, key, CaseEvaluationResultSchema);
              if (candidate.task.mechanicVersion === 3) {
                if (!dependencies.python) throw new ProviderFailure("unavailable");
                const result = await advancePythonCase({ context, binding, index, key, candidateStepId: candidateStep.id, casePlanStepId: casesStep.id, candidate, test, model, python: dependencies.python });
                if (!result) return { status: "continue" };
                caseStepIds.push(result.stepId); continue;
              }
              if (getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion)!.descriptor.requirements.includes("activity")) {
                const result = await advanceActivityCase({ context, binding, index, candidateStepId: candidateStep.id, casePlanStepId: casesStep.id, candidate, test, model });
                if (!result) return { status: "continue" };
                caseStepIds.push(result.stepId); continue;
              }
              if (!evaluated) {
                await context.step({ key, input: checkpointJson({ candidate, test }), digests: generationDigests(binding), outputSchema: jsonCheckpointSchema(CaseEvaluationResultSchema), resultSchema: jsonCheckpointSchema(CaseEvaluationResultSchema),
                  async effect(effect) { return checkpointJson(await evaluateResponseCase({ candidate, test, context: effect, model, deadlineAt: effect.deadlineAt })); }, async commit(_tx, output) { return output; } });
                return { status: "continue" };
              }
              caseStepIds.push(evaluated.id);
            }
            const reviewKey = `${taskPrefix}/review`, review = await loadStage(context, binding, index, reviewKey, ContentReviewCheckpointSchema);
            if (!review) {
              if (batchingV2) {
                await advanceReviewBatch({ context, binding, index, model, moduleId: outline.id, prefix,
                  batchKey: `${prefix}/batch/v2/repair/${slot.id}/${attempt}`, attempt, candidates: [loaded.step], knowledge: researched.knowledge, facts: researched.facts });
                return { status: "continue" };
              }
              const outcomes = researched.knowledge.outcomes.filter((o) => candidate.task.outcomeIds.includes(o.outcomeId));
              const material = createContentReviewInput({ candidate, criteria: outcomes.flatMap((o) => o.criteria), learnerAction: outcomes.map((o) => o.learnerAction).join("\n"), claims: researched.facts.claims, passages: researched.facts.passages });
              await mappedModelStage({ context, binding, model, key: reviewKey, purpose: "content_review", schema: ContentReviewSchema, resultSchema: ContentReviewCheckpointSchema,
                material, instructions: CONTENT_REVIEW_INSTRUCTIONS,
                async commit(_tx, review, operationId) { return { kind: "course.task.review" as const, candidateStepId: candidateStep.id, operationId, material, review }; } });
              return { status: "continue" };
            }
            const specializedReviewStepIds: string[] = [];
            for (const check of candidate.requiredChecks.filter((c) => c.id === "counterexample_claim" || c.id === "dialogue_compatibility")) {
              const validator = check.id === "counterexample_claim" ? "validateCounterexampleClaim" as const : "dialogue_compatibility" as const;
              const key = `${taskPrefix}/specialized/${check.id}`, specialized = await loadStage(context, binding, index, key, SpecializedReviewCheckpointSchema);
              if (!specialized) {
                await mappedModelStage({ context, binding, model, key, purpose: "content_review", schema: SpecializedReviewSchema, resultSchema: SpecializedReviewCheckpointSchema,
                  material: review.result.material, instructions: `${SPECIALIZED_REVIEW_INSTRUCTIONS} Required validator: ${validator}.`,
                  async commit(_tx, reviewResult, operationId) {
                    if (reviewResult.validator !== validator) throw new ProviderFailure("invalid_output");
                    return { kind: "course.task.specialized_review" as const, candidateStepId: candidateStep.id, operationId, material: review.result.material, review: reviewResult };
                  } });
                return { status: "continue" };
              }
              specializedReviewStepIds.push(specialized.id);
            }
            const references = { candidateStepId: candidateStep.id, casePlanStepId: casesStep.id, caseStepIds, reviewStepId: review.id, specializedReviewStepIds };
            const validationKey = `${taskPrefix}/validation`, checked = await loadStage(context, binding, index, validationKey, ValidationStageSchema);
            if (!checked) {
              await pureStage({ context, binding, key: validationKey, material: references, schema: ValidationStageSchema,
                async commit(tx) { const proof = await validation.validateStoredTask(tx, binding, references); return { kind: "course.task.validation" as const, references, verdict: proof.receipt.verdict, checks: JsonValueSchema.parse(proof.receipt.checks) }; } });
              return { status: "continue" };
            }
            if (checked.result.verdict !== "passed") { correction = { previous: candidateStep.result.authored, findings: checked.result.checks }; continue; }
            authoredTasks.push(candidateStep.result.authored); taskReferences.push(references); accepted = true; break;
          }
          if (!accepted) { await requestRepair({ slot, correction, issue: "Task exhausted its two bounded repair attempts; rethink this learner activity without removing its outcomes" }); return { status: "continue" }; }
        }
        const lessons = plan.lessons.map((lesson) => LessonSchema.parse({ id: lesson.id, courseVersionId: binding.version.id, moduleId: outline.id, title: lesson.title, outcomeIds: lesson.outcomeIds,
          blocks: lesson.blocks.map((block) => block.kind === "task" ? block : readings.find((r) => r.lessonId === lesson.id)!.blocks.find((b) => b.id === block.id)), taskIds: lesson.blocks.flatMap((b) => b.kind === "task" ? [b.taskId] : []) }));
        const authored = { schemaVersion: 1, moduleId: outline.id, approvalDigest: binding.approval.contentDigest, lessons, tasks: authoredTasks, readingEvidence: readings.flatMap((r) => r.readingEvidence) };
        const prepared = prepareModuleCandidate(authored, { ...researched.facts, draft: binding.draft, approvalDigest: binding.approval.contentDigest, courseVersionId: binding.version.id, knowledge: researched.knowledge });
        if (!prepared.candidate) { await requestRepair({ issues: prepared.issues }); return { status: "continue" }; }
        const adaptiveIssues = validateAdaptiveMaterial([prepared.candidate]);
        if (adaptiveIssues.length) { await requestRepair({ issues: adaptiveIssues }); return { status: "continue" }; }
        const preparedModule = prepared.candidate, reviewMaterial = createModuleReviewInput(preparedModule, binding.draft, researched.facts);
        const moduleReview = await advanceModuleReview({ context, binding, index, key: `${prefix}/review`, material: reviewMaterial, model });
        if (!moduleReview) return { status: "continue" };
        if (!moduleReview.passed) { await requestRepair({ findings: moduleReview.review }); return { status: "continue" }; }
        await pureStage({ context, binding, key: `${modulePrefix}/complete`, material: { moduleDigest: preparedModule.moduleDigest, reviewStepId: moduleReview.stepId }, schema: CompletedModuleCheckpointSchema,
          async commit(tx) {
            if (!(await loadVerifiedModuleReview(tx, binding, moduleReview.stepId, reviewMaterial)).passed) throw new ProviderFailure("invalid_output");
            const result = { kind: "course.module.completed" as const, module: preparedModule, coverage: plan.coverage, knowledgeStepId: researched.step.id, planStepId: planStep.stepId, readingStepIds, taskReferences, reviewStepId: moduleReview.stepId };
            await context.emitGeneration(tx, { type: "generation.module.completed", moduleId: preparedModule.moduleId, completedTasks: preparedModule.tasks.length });
            return result;
          } });
        return { status: "continue" };
      }
      await pureStage({ context, binding, key: "course/materialize", material: { modules: completed.map((m) => ({ moduleId: m.module.moduleId, moduleDigest: m.module.moduleDigest })) },
        schema: z.object({ courseVersionId: IdSchema }).strict(), async commit(tx) {
          await materializeCourse(tx, context, binding, completed, runtime);
          return { courseVersionId: binding.version.id };
        } });
      return { status: "succeeded" };
    },
  };
}
