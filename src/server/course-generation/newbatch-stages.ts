import "server-only";
import { z } from "zod";
import { IdSchema, type JsonValue } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import type { ModelPort } from "@/server/ai/ports";
import { ProviderFailure } from "@/server/ai/failure";
import { jsonDigest } from "@/server/ai/json";
import type { RunContext } from "@/server/runs/ports";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import { getMechanicAuthoringContract } from "@/server/mechanics/catalog";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { taskDigest } from "@/server/mechanics/digest";
import { inspectCandidateSourceGrounding, projectCanonicalResearchSources } from "@/server/course-validation/source-grounding";
import { CONTENT_REVIEW_INSTRUCTIONS, ContentReviewSchema, createContentReviewInput } from "@/server/course-validation/content-review";
import { AuthoredTaskSchema, BatchItemProofSchema, ModelBatchCheckpointSchema, TaskCandidateCheckpointSchema, TaskCasesCheckpointSchema,
  ContentReviewCheckpointSchema, ProposedTaskCasesSchema, batchResponseSchema, prepareTaskCasesCheckpoint, type AuthoredTask } from "./checkpoints";
import { createBatchItemProof } from "./batch-provenance";
import { GenerationEvidenceRepository, verifyStoredModelData, type StoredGenerationStep } from "./repository";
import { checkpointJson, jsonCheckpointSchema, loadStage, mappedModelStageV2, pureStage, type StageIndex } from "./stages";
import type { ModuleKnowledge } from "./contracts";
import type { ModulePlan } from "./planning";
import { taskAuthoringContractMaterial, taskAuthoringInstructions, type TaskAuthoringContractPolicy } from "./authored-output-contract";
import { TaskIdentityProposalSchema, projectTaskIdentityBatch, taskIdentityMaterial, type TaskPrivateIdentityPolicy } from "./task-authoring-identities";

export const RejectedTaskSchema = z.object({ kind: z.literal("course.task.rejected"), authored: AuthoredTaskSchema,
  authoringOperationId: IdSchema, reason: z.string(), modelProof: BatchItemProofSchema.optional() }).strict();
export const CandidateResultSchema = z.union([TaskCandidateCheckpointSchema, RejectedTaskSchema]);
type BatchKind = "candidate" | "cases" | "review";
type BatchProof = z.infer<typeof BatchItemProofSchema>;
type BatchItem = { itemId: string; key: string; material: JsonValue; candidateStepId?: string; candidateDigest?: string };
type BatchContext = { context: RunContext; binding: ApprovedBuildBinding; index: StageIndex; model: ModelPort; moduleId: string };
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

/** Every requested item is required in order. A malformed envelope cannot silently reduce teaching scope. */
export function assertBatchItemOrder(items: readonly { itemId: string }[], requestedIds: readonly string[]): void {
  if (!requestedIds.length || requestedIds.length > 5 || new Set(requestedIds).size !== requestedIds.length ||
      items.length !== requestedIds.length || items.some((item, index) => item.itemId !== requestedIds[index])) invalid();
}
/** Snapshot and full-source artifacts get their own envelope before any paid request is created. */
export function plannedTaskBatches<T extends { mechanicId: string; mechanicVersion: number }>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  let pending: T[] = [];
  const flush = () => { if (pending.length) { batches.push(pending); pending = []; } };
  for (const item of items) {
    if (item.mechanicId === "source_investigation" || item.mechanicId === "critique_revision" || item.mechanicVersion === 3) {
      flush(); batches.push([item]);
    } else {
      pending.push(item);
      if (pending.length === 5) flush();
    }
  }
  flush();
  return batches;
}

/** One paid parent or one pure derived checkpoint per advance; replay never repeats a paid effect. */
export async function advanceModelBatch<T, R>(input: BatchContext & {
  key: string; batchKind: BatchKind; items: BatchItem[]; schema: z.ZodType<T>; resultSchema: z.ZodType<R>; instructions: string;
  commit(tx: DbTransaction, data: T, operationId: string, proof: BatchProof, peers: T[]): Promise<R>;
}): Promise<StoredGenerationStep<R>[] | null> {
  if (!input.items.length) return [];
  const requestedIds = input.items.map((item) => item.itemId);
  assertBatchItemOrder(input.items, requestedIds);
  const material = checkpointJson({ batchKind: input.batchKind, moduleId: input.moduleId, approvalDigest: input.binding.approval.contentDigest,
    requestedIds, items: input.items.map(({ key: _key, ...item }) => { void _key; return item; }) });
  const responseSchema = batchResponseSchema(input.schema);
  const parent = await loadStage(input.context, input.binding, input.index, input.key, ModelBatchCheckpointSchema);
  if (!parent) {
    await mappedModelStageV2({ ...input, purpose: input.batchKind === "candidate" ? "task_authoring" : "content_review", schema: responseSchema,
      resultSchema: ModelBatchCheckpointSchema, material,
      instructions: `${input.instructions}\nReturn exactly one complete value for every requestedIds entry, in that exact order, inside {items:[{itemId,value}]}. Never omit or merge an item. Each item.material is that task's full context. Evaluate each task independently; all contracts, outcomes, private evaluator details and source evidence remain mandatory. Optional candidates must use distinct contexts and evidenceGroupIds from every other candidate in this batch and all existingTaskContexts.`,
      async commit(_tx, response, operationId) {
        assertBatchItemOrder(response.items, requestedIds);
        return { kind: "course.model.batch.v2" as const, batchKind: input.batchKind, operationId, material, items: response.items.map((item) => ({ itemId: item.itemId, value: checkpointJson(item.value) })) };
      } });
    return null;
  }
  const verify = async (tx: DbTransaction) => {
    if (parent.result.batchKind !== input.batchKind || jsonDigest(parent.result.material) !== jsonDigest(material) || parent.inputDigest !== jsonDigest(material)) invalid();
    assertBatchItemOrder(parent.result.items, requestedIds);
    const response = responseSchema.parse({ items: parent.result.items });
    await verifyStoredModelData(tx, parent, parent.result.operationId, responseSchema, response);
    return response.items;
  };
  const values = await input.context.read(verify), results: StoredGenerationStep<R>[] = [];
  for (const [itemIndex, item] of input.items.entries()) {
    const existing = await loadStage(input.context, input.binding, input.index, item.key, input.resultSchema);
    if (existing) { results.push(existing); continue; }
    await pureStage({ context: input.context, binding: input.binding, key: item.key, material: item.material, schema: jsonCheckpointSchema(input.resultSchema),
      async commit(tx) {
        await verify(tx);
        const proof = createBatchItemProof(parent.id, parent.result.items, item.itemId);
        return checkpointJson(await input.commit(tx, values[itemIndex]!.value, parent.result.operationId, proof, values.map((entry) => entry.value)));
      } });
    return null;
  }
  return results;
}

const AUTHOR_INSTRUCTIONS = "Author this exact planned task and private evaluator. Preserve task ID, chosen mechanic/version, outcome IDs, design, assessmentRole and canonical criterion mappings. taskVersion=1. Set privateTask.assessment.role exactly to slot.assessmentRole: optional practice, diagnostic and challenge tasks must remain optional. Use actual contract JSON schemas; no invented fields. All private hints, expected answers, hidden cases and rubrics belong only in privateTask. Build nontrivial assessment of the learner action, accept valid alternatives and avoid answer leakage. Optional tasks must address their particular learning need with a genuinely different problem/context, not a cosmetic rewrite of existingTaskContexts. Give every independent optional assessment a new evidenceGroupId distinct from all existing material. Include real sourceClaimIds supporting every outcome. For source investigation, copy selected canonicalSourceEvidence.sources objects exactly into public/private source snapshots, including URL, title, retrieval timestamp, content digest and complete passage list. Never invent or rewrite source metadata. Claims from unavailable source snapshots cannot support a task. Return a complete corrected candidate when corrections are supplied.";
const CASE_INSTRUCTIONS = "Independently design adversarial evaluator cases: a substantively valid response, a distinct valid alternative, and a meaningful field-valid but behaviorally wrong response. Include boundary/trap cases where helpful. Malformed-only negatives are insufficient. For a truly unique deterministic response, supply a replayable alternativeSpaceProof instead of an invented alternative. For activity tasks include action plans with real action types; receipt fields start null or empty and are bound by the server. Never invent activity observations or execution receipts.";
function candidateMechanicContract(id: string, version: number, identityPolicy?: TaskPrivateIdentityPolicy) {
  const contract = getMechanicAuthoringContract(id, version);
  if (!identityPolicy) return contract;
  // The complete raw contract is the single private-output authority for this capture.
  const { evaluatorDataSchema: _privateSchema, ...publicContract } = contract;
  void _privateSchema; return publicContract;
}
type CandidateBatchInput = BatchContext & { prefix: string; batchKey: string; slots: ModulePlan["tasks"]; attempt: number;
  taskAuthoringContractPolicy?: TaskAuthoringContractPolicy;
  taskIdentityPolicy?: TaskPrivateIdentityPolicy;
  passedPreviousTasks?: Pick<AuthoredTask, "task" | "privateTask">[];
  previousTasks: Pick<AuthoredTask, "task" | "privateTask">[]; knowledge: ModuleKnowledge; knowledgeStepId: string; facts: CurriculumEvidenceFacts; correction: unknown };

export function assertIndependentOptionalCandidate(authored: AuthoredTask, peers: readonly Pick<AuthoredTask, "task" | "privateTask">[]): void {
  if (authored.privateTask.assessment.role !== "required" && peers.some((other) => other.task.id !== authored.task.id &&
    (other.privateTask.assessment.evidenceGroupId === authored.privateTask.assessment.evidenceGroupId ||
      taskDigest({ instruction: other.task.instruction, config: other.task.config }) === taskDigest({ instruction: authored.task.instruction, config: authored.task.config }))))
    throw new Error("Optional material must use a new problem/context and evidence group; changing only task identity is not independent assessment.");
}
export async function advanceCandidateBatch(input: CandidateBatchInput) {
  const items = input.slots.map((slot) => ({ itemId: slot.id, key: `${input.prefix}/task/${slot.id}/${input.attempt}/candidate`,
      material: checkpointJson({ slot, contentLanguage: input.binding.draft.contentLanguage, approvalDigest: input.binding.approval.contentDigest, knowledge: input.knowledge,
        contract: candidateMechanicContract(slot.mechanicId, slot.mechanicVersion, input.taskIdentityPolicy), claims: input.facts.claims, passages: input.facts.passages,
        ...taskAuthoringContractMaterial(input.taskAuthoringContractPolicy, slot.mechanicId, slot.mechanicVersion, input.taskIdentityPolicy),
        ...taskIdentityMaterial(input.taskIdentityPolicy, input.passedPreviousTasks),
        canonicalSourceEvidence: projectCanonicalResearchSources(input.facts), existingTaskContexts: input.previousTasks.filter((entry) => entry.task.outcomeIds.some((id) => slot.outcomeIds.includes(id)))
          .map((entry) => ({ task: entry.task, assessment: entry.privateTask.assessment })), correction: input.correction }) }));
  const commitAuthored = (authored: AuthoredTask, authoringOperationId: string, modelProof: BatchProof, peers: AuthoredTask[]) => {
      const slot = input.slots.find((entry) => entry.id === modelProof.itemId)!;
      try {
        const mapping = (values: { outcomeId: string; criterionIds: string[] }[]) => values.map((value) => ({ outcomeId: value.outcomeId,
          criterionIds: [...value.criterionIds].sort() })).sort((left, right) => left.outcomeId.localeCompare(right.outcomeId));
        if (authored.task.taskVersion !== 1 || authored.task.id !== slot.id || authored.task.mechanicId !== slot.mechanicId || authored.task.mechanicVersion !== slot.mechanicVersion || authored.privateTask.assessment.role !== slot.assessmentRole || taskDigest(authored.task.outcomeIds) !== taskDigest(slot.outcomeIds) || taskDigest(authored.design) !== taskDigest(slot.design) ||
            taskDigest(mapping(slot.criteria)) !== taskDigest(mapping(authored.privateTask.assessment.outcomes.map((outcome) => ({
              outcomeId: outcome.outcomeId, criterionIds: outcome.dimensions.map((dimension) => dimension.dimensionId) }))))) throw new Error("Task differs from the approved teaching slot");
        const candidate = prepareTaskCandidate(authored, { approvalDigest: input.binding.approval.contentDigest });
        const grounding = inspectCandidateSourceGrounding(candidate, input.facts);
        if (grounding.issues.length) throw new Error(grounding.issues.join(" "));
        assertIndependentOptionalCandidate(authored, [...input.previousTasks, ...peers]);
        return { kind: "course.task.candidate" as const, moduleId: input.moduleId, knowledgeStepId: input.knowledgeStepId, candidate, authored, authoringOperationId, modelProof };
      } catch (error) { return { kind: "course.task.rejected" as const, authored, authoringOperationId, modelProof, reason: error instanceof Error ? error.message : "Invalid task" }; }
  };
  const batch = { ...input, key: `${input.batchKey}/candidate`, batchKind: "candidate" as const, items,
    resultSchema: CandidateResultSchema, instructions: taskAuthoringInstructions(AUTHOR_INSTRUCTIONS, input.taskAuthoringContractPolicy, input.taskIdentityPolicy) };
  if (input.taskIdentityPolicy) return advanceModelBatch({ ...batch, schema: TaskIdentityProposalSchema,
    async commit(_tx, _proposal, operationId, proof, peers) {
      const projected = projectTaskIdentityBatch(proof.batchStepId, { batchKind: "candidate", requestedIds: input.slots.map(({ id }) => id), items },
        peers.map((value, index) => ({ itemId: input.slots[index]!.id, value })));
      return commitAuthored(projected[proof.itemIndex]!.value, operationId, proof, projected.map(({ value }) => value));
    } });
  return advanceModelBatch({ ...batch, schema: AuthoredTaskSchema,
    async commit(_tx, authored, operationId, proof, peers) { return commitAuthored(authored, operationId, proof, peers); } });
}

/** A singleton repair must remain distinct from future candidates already authored in its original group. */
export async function loadLaterBatchCandidates(input: Pick<BatchContext, "context" | "binding" | "index"> & {
  prefix: string; slots: ModulePlan["tasks"]; taskId: string;
}): Promise<AuthoredTask[]> {
  const position = input.slots.findIndex((slot) => slot.id === input.taskId);
  if (position < 0) return invalid();
  const peers: AuthoredTask[] = [], evidence = new GenerationEvidenceRepository();
  for (const slot of input.slots.slice(position + 1)) {
    const step = await loadStage(input.context, input.binding, input.index, `${input.prefix}/task/${slot.id}/0/candidate`, CandidateResultSchema);
    if (!step) return invalid();
    if (step.result.kind === "course.task.rejected") continue;
    const loaded = await input.context.read((tx) => evidence.loadTaskCandidate(tx, input.binding, step.id));
    peers.push(loaded.step.result.authored);
  }
  return peers;
}

type CandidateStep = StoredGenerationStep<z.infer<typeof TaskCandidateCheckpointSchema>>;
type AssessmentBatchInput = BatchContext & { prefix: string; batchKey: string; attempt: number; candidates: CandidateStep[] };
export async function advanceCasesBatch(input: AssessmentBatchInput) {
  return advanceModelBatch({ ...input, key: `${input.batchKey}/cases`, batchKind: "cases", schema: ProposedTaskCasesSchema,
    resultSchema: TaskCasesCheckpointSchema, instructions: CASE_INSTRUCTIONS,
    items: input.candidates.map((step) => ({ itemId: step.result.candidate.task.id, candidateStepId: step.id, candidateDigest: step.result.candidate.candidateDigest,
      key: `${input.prefix}/task/${step.result.candidate.task.id}/${input.attempt}/cases`, material: checkpointJson({ candidate: step.result.candidate,
        responseSchema: getMechanicAuthoringContract(step.result.candidate.task.mechanicId, step.result.candidate.task.mechanicVersion).responseSchema }) })),
    async commit(_tx, proposal, operationId, modelProof) {
      const step = input.candidates.find((entry) => entry.result.candidate.task.id === modelProof.itemId)!;
      return { ...prepareTaskCasesCheckpoint({ candidateStepId: step.id, candidateDigest: step.result.candidate.candidateDigest, operationId, proposal }), modelProof };
    } });
}
export async function advanceReviewBatch(input: AssessmentBatchInput & { knowledge: ModuleKnowledge; facts: CurriculumEvidenceFacts }) {
  const items = input.candidates.map((step) => {
    const candidate = step.result.candidate, outcomes = input.knowledge.outcomes.filter((outcome) => candidate.task.outcomeIds.includes(outcome.outcomeId));
    return { itemId: candidate.task.id, candidateStepId: step.id, candidateDigest: candidate.candidateDigest,
      key: `${input.prefix}/task/${candidate.task.id}/${input.attempt}/review`, material: checkpointJson(createContentReviewInput({ candidate,
        criteria: outcomes.flatMap((outcome) => outcome.criteria), learnerAction: outcomes.map((outcome) => outcome.learnerAction).join("\n"), claims: input.facts.claims, passages: input.facts.passages })) };
  });
  return advanceModelBatch({ ...input, key: `${input.batchKey}/review`, batchKind: "review", schema: ContentReviewSchema,
    resultSchema: ContentReviewCheckpointSchema, instructions: CONTENT_REVIEW_INSTRUCTIONS, items,
    async commit(_tx, review, operationId, modelProof) {
      const item = items.find((entry) => entry.itemId === modelProof.itemId)!;
      return { kind: "course.task.review" as const, candidateStepId: item.candidateStepId, operationId, material: item.material, review, modelProof };
    } });
}

const PreparedBatchSchema = z.object({ kind: z.literal("course.task.batch.prepared"), taskIds: z.array(IdSchema).min(1).max(5) }).strict();
/** Prepares only the current bounded group. Actual case execution and readiness remain in the ordinary task pipeline. */
export async function advanceTaskBatch(input: Omit<CandidateBatchInput, "attempt" | "correction">): Promise<boolean> {
  const readyKey = `${input.batchKey}/prepared`, taskIds = input.slots.map((slot) => slot.id);
  const prepared = await loadStage(input.context, input.binding, input.index, readyKey, PreparedBatchSchema);
  if (prepared) {
    if (taskDigest(prepared.result.taskIds) !== taskDigest(taskIds)) invalid();
    return true;
  }
  const first = await advanceCandidateBatch({ ...input, attempt: 0, correction: null });
  if (!first) return false;
  const candidates: CandidateStep[] = [], evidence = new GenerationEvidenceRepository();
  for (const step of first) if (step.result.kind === "course.task.candidate") {
    const loaded = await input.context.read((tx) => evidence.loadTaskCandidate(tx, input.binding, step.id));
    candidates.push(loaded.step);
  }
  const assessment = { ...input, candidates, attempt: 0 };
  if (!await advanceCasesBatch(assessment)) return false;
  if (!await advanceReviewBatch(assessment)) return false;
  await pureStage({ context: input.context, binding: input.binding, key: readyKey, material: { taskIds }, schema: PreparedBatchSchema,
    async commit() { return { kind: "course.task.batch.prepared" as const, taskIds }; } });
  return false;
}
