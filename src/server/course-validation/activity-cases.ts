import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonValueSchema, type JsonValue } from "@/domain/common";
import { ActivityEventPublicSchema, InputSnapshotSchema, responseDigest, type ActivityEventPublic, type PublicObservation } from "@/domain/activity";
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { ModelPort } from "@/server/ai/ports";
import { canonicalJson, jsonDigest } from "@/server/ai/json";
import { ProviderFailure } from "@/server/ai/failure";
import { ServiceFault } from "@/server/auth/errors";
import { createRubricJudge } from "@/server/ai/rubric-judge";
import type { RunContext, StepEffectContext } from "@/server/runs/ports";
import { stableExecutionId } from "@/server/runs/identity";
import { GenerationEvidenceRepository, loadGenerationStep, verifyStoredModelData, verifyStoredModelItem, type StoredGenerationStep } from "@/server/course-generation/repository";
import { ProposedTaskCasesSchema, TaskCasesCheckpointSchema, prepareTaskCasesCheckpoint } from "@/server/course-generation/checkpoints";
import { generationDigests, type StageIndex } from "@/server/course-generation/stages";
import { ActivityContextSessionSchema, RubricJudgementSchema, RubricRequestSchema, validateRubricJudgement,
  type AuthoritativeActivity, type RubricJudge, type RubricRequest } from "@/server/evaluation/contracts";
import { activityBudgetLimit, prepareCandidateActivityAction } from "@/server/learning/actions";
import { DialogueDraftSchema, DialogueAuditSchema, prepareDialogueMaterial, generateDialogueDraft, auditDialogueDraft,
  verifiedDialogueObservation, type DialogueMaterial } from "@/server/learning/dialogue";
import { getServerMechanic } from "@/server/mechanics/registry";
import type { PreparedTaskCandidate } from "@/server/mechanics/contracts";
import { taskDigest } from "@/server/mechanics/digest";
import { CaseEvaluationResultSchema, ProposedActivityPlanSchema, type CaseEvaluationResult, type ResponseCase } from "./case-evaluation";

function invalid(): never { throw new ProviderFailure("invalid_output"); }
function unavailable(): never { throw new ProviderFailure("unavailable"); }
const BindingSchema = z.object({ generationRunId: IdSchema, candidateStepId: IdSchema, casePlanStepId: IdSchema,
  candidateDigest: DigestSchema, approvalDigest: DigestSchema, caseId: IdSchema }).strict();
type ActivityBinding = z.infer<typeof BindingSchema>;
const checkpointBase = { binding: BindingSchema, runStepId: IdSchema, actionIndex: z.number().int().min(0).max(23),
  priorActionStepIds: z.array(IdSchema).max(23) };
export const ActivityDraftCheckpointSchema = z.object({ kind: z.literal("course.activity.draft"), ...checkpointBase,
  material: JsonValueSchema, operationId: IdSchema, draft: DialogueDraftSchema }).strict();
export const ActivityAuditCheckpointSchema = z.object({ kind: z.literal("course.activity.audit"), ...checkpointBase,
  draftStepId: IdSchema, operationId: IdSchema, audit: DialogueAuditSchema }).strict();
export const ActivityActionCheckpointSchema = z.object({ kind: z.literal("course.activity.action"), ...checkpointBase,
  input: InputSnapshotSchema, event: ActivityEventPublicSchema, draftStepId: IdSchema.nullable(), auditStepId: IdSchema.nullable() }).strict();
type ActionCheckpoint = z.infer<typeof ActivityActionCheckpointSchema>;
type Authority = { binding: ActivityBinding; candidate: PreparedTaskCandidate; test: ResponseCase;
  plan: z.infer<typeof ProposedActivityPlanSchema> };
type State = { activity: AuthoritativeActivity; actionStepIds: string[] };
const CaseResultJsonSchema = CaseEvaluationResultSchema.transform((value) => JsonValueSchema.parse(value));

function equal(left: unknown, right: unknown): void { if (taskDigest(left) !== taskDigest(right)) invalid(); }
function emptyReceiptReferences(value: JsonValue): void {
  if (value === null || Array.isArray(value) || typeof value !== "object") return;
  for (const key of ["commitReceiptId", "observationReceiptId"]) if (key in value && value[key] !== null) invalid();
  for (const key of ["observationReceiptIds", "turnReceiptIds"]) if (key in value && (!Array.isArray(value[key]) || value[key].length !== 0)) invalid();
}
/** Only these family-owned fields can receive stored receipt IDs; an author cannot select an arbitrary path. */
function bindResponse(authority: Authority, raw: JsonValue, events: readonly ActivityEventPublic[]): JsonValue {
  emptyReceiptReferences(raw);
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") return raw;
  const response = structuredClone(raw);
  const refs = (kind: string) => events.filter((event) => event.action.kind === kind && event.receipt.status === "completed").map((event) => event.receipt.id);
  switch (authority.candidate.task.mechanicId) {
    case "outcome_prediction": response.commitReceiptId = refs("prediction.commit")[0] ?? null; response.observationReceiptId = refs("run").at(-1) ?? null; break;
    case "experimental_investigation": response.observationReceiptIds = refs("experiment.query"); break;
    case "causal_intervention": response.observationReceiptId = refs("intervention.apply").at(-1) ?? null; break;
    case "constrained_optimization": response.observationReceiptId = refs("run").at(-1) ?? null; break;
    case "misconception_tutoring": case "information_gap": case "role_simulation": response.turnReceiptIds = refs("dialogue.turn"); break;
  }
  return response;
}

async function loadAuthority(tx: DbTransaction, binding: ApprovedBuildBinding, ids: Pick<ActivityBinding, "candidateStepId" | "casePlanStepId" | "caseId">): Promise<Authority> {
  const repository = new GenerationEvidenceRepository();
  const current = await repository.loadBinding(tx, { runId: binding.run.id, ownerId: binding.course.ownerId });
  if (current.approval.contentDigest !== binding.approval.contentDigest || current.version.id !== binding.version.id || current.course.id !== binding.course.id) invalid();
  const loaded = await repository.loadTaskCandidate(tx, current, ids.candidateStepId);
  const planned = await loadGenerationStep(tx, current, ids.casePlanStepId, TaskCasesCheckpointSchema);
  if (planned.result.candidateStepId !== ids.candidateStepId || planned.result.candidateDigest !== loaded.candidate.candidateDigest) invalid();
  const proposal = ProposedTaskCasesSchema.parse({ cases: planned.result.cases.map(({ caseId, ...entry }) => { void caseId; return entry; }), alternativeSpaceProof: planned.result.alternativeSpaceProof });
  await verifyStoredModelItem(tx, current, planned, planned.result.operationId, ProposedTaskCasesSchema, proposal, planned.result.modelProof, "cases");
  const reconstructed = prepareTaskCasesCheckpoint({ candidateStepId: ids.candidateStepId, candidateDigest: loaded.candidate.candidateDigest, operationId: planned.result.operationId, proposal });
  equal(planned.result.modelProof ? { ...reconstructed, modelProof: planned.result.modelProof } : reconstructed, planned.result);
  const test = planned.result.cases.find((entry) => entry.caseId === ids.caseId) ?? invalid();
  const plan = ProposedActivityPlanSchema.parse(test.activityPlan);
  canonicalJson(plan);
  if (new Set(plan.actions.map((entry) => entry.key)).size !== plan.actions.length) invalid();
  const handle = getServerMechanic(loaded.candidate.task.mechanicId, loaded.candidate.task.mechanicVersion) ?? unavailable();
  if (handle.descriptor.requirements.includes("sandbox") || !handle.descriptor.actions.length) unavailable();
  emptyReceiptReferences(test.response);
  plan.actions.forEach((entry) => { emptyReceiptReferences(entry.response); if (!handle.descriptor.actions.includes(entry.action.kind)) invalid(); });
  return { candidate: loaded.candidate, test, plan, binding: BindingSchema.parse({ ...ids,
    generationRunId: current.run.id, candidateDigest: loaded.candidate.candidateDigest, approvalDigest: current.approval.contentDigest }) };
}

async function initialState(authority: Authority): Promise<State> {
  const task = authority.candidate.task, sessionId = stableExecutionId(authority.test.caseId, "validation-activity");
  const response = getServerMechanic(task.mechanicId, task.mechanicVersion)!.descriptor.createInitialResponse(task.config);
  const snapshot = InputSnapshotSchema.parse({ activitySessionId: sessionId, inputRevision: 1, responseDigest: await responseDigest(response), response });
  return { actionStepIds: [], activity: { session: ActivityContextSessionSchema.parse({ id: sessionId, taskId: task.id, taskVersion: task.taskVersion,
    revision: 1, inputRevision: 1, status: "active", remainingActions: activityBudgetLimit(task), events: [] }), input: snapshot, receipts: [], receiptInputs: [],
    assistance: "independent", revealedFactIds: [], committedPredictionReceiptId: null, predictionBeforeObservation: false } };
}
async function withResponse(authority: Authority, state: State, raw: JsonValue): Promise<AuthoritativeActivity> {
  const response = bindResponse(authority, raw, state.activity.session.events);
  const snapshot = InputSnapshotSchema.parse({ activitySessionId: state.activity.session.id, inputRevision: state.activity.session.inputRevision + 1,
    responseDigest: await responseDigest(response), response });
  return { ...state.activity, session: { ...state.activity.session, inputRevision: snapshot.inputRevision }, input: snapshot };
}
async function prepareAction(authority: Authority, state: State, actionIndex: number, runStepId: string) {
  const planned = authority.plan.actions[actionIndex] ?? invalid();
  const activity = await withResponse(authority, state, planned.response);
  const request = { clientActionId: stableExecutionId(authority.test.caseId, `action:${actionIndex}`), expectedRevision: activity.session.revision,
    inputRevision: activity.input.inputRevision, responseDigest: activity.input.responseDigest, action: planned.action };
  const prepared = await prepareCandidateActivityAction({ task: authority.candidate.task, privateTask: authority.candidate.privateTask, activity, request,
    validationBinding: { generationRunId: authority.binding.generationRunId, runStepId, candidateDigest: authority.binding.candidateDigest,
      approvalDigest: authority.binding.approvalDigest, caseId: authority.test.caseId } });
  if (prepared.execution.kind === "python") unavailable();
  return { activity, request, prepared };
}
function stageMaterial(authority: Authority, state: State, actionIndex: number, stage: string, extra: Record<string, JsonValue> = {}): JsonValue {
  return JsonValueSchema.parse({ binding: authority.binding, actionIndex, priorActionStepIds: state.actionStepIds,
    action: authority.plan.actions[actionIndex], stage, ...extra });
}
function checkpointIdentity(authority: Authority, state: State, actionIndex: number, runStepId: string) {
  return { binding: authority.binding, runStepId, actionIndex, priorActionStepIds: [...state.actionStepIds] };
}
function verifyIdentity(authority: Authority, state: State, actionIndex: number, step: StoredGenerationStep<{
  binding: ActivityBinding; runStepId: string; actionIndex: number; priorActionStepIds: string[];
}>) {
  equal(checkpointIdentity(authority, state, actionIndex, step.id), {
    binding: step.result.binding, runStepId: step.result.runStepId, actionIndex: step.result.actionIndex, priorActionStepIds: step.result.priorActionStepIds });
}
function inputMatches(step: Pick<StoredGenerationStep<unknown>, "inputDigest">, material: JsonValue): void {
  if (step.inputDigest !== jsonDigest(material)) invalid();
}
function appendAction(state: State, checkpoint: ActionCheckpoint, cost: number): State {
  const remainingActions = state.activity.session.remainingActions - cost;
  if (remainingActions < 0) invalid();
  const events = [...state.activity.session.events, checkpoint.event];
  const commit = events.find((event) => event.action.kind === "prediction.commit");
  const observation = events.find((event) => event.action.kind !== "prediction.commit");
  const session = ActivityContextSessionSchema.parse({ ...state.activity.session, revision: checkpoint.event.seq,
    inputRevision: checkpoint.input.inputRevision, remainingActions, status: remainingActions === 0 ? "budget_exhausted" : "active", events });
  return { actionStepIds: [...state.actionStepIds, checkpoint.runStepId], activity: { ...state.activity, session, input: checkpoint.input,
    receipts: [...state.activity.receipts, checkpoint.event.receipt], receiptInputs: [...state.activity.receiptInputs, checkpoint.input],
    revealedFactIds: [...new Set(events.flatMap((event) => event.receipt.observation?.kind === "dialogue" ? event.receipt.observation.revealedFacts.map((fact) => fact.id) : []))],
    committedPredictionReceiptId: commit?.receipt.id ?? null, predictionBeforeObservation: !!commit && (!observation || commit.seq < observation.seq) } };
}
function actionCheckpoint(authority: Authority, state: State, index: number, stepId: string, prepared: Awaited<ReturnType<typeof prepareAction>>,
  observation: PublicObservation | null, at: string, draftStepId: string | null, auditStepId: string | null): ActionCheckpoint {
  const { response: _response, ...identity } = prepared.activity.input; void _response;
  const seq = state.activity.session.revision + 1;
  return ActivityActionCheckpointSchema.parse({ kind: "course.activity.action", ...checkpointIdentity(authority, state, index, stepId),
    input: prepared.activity.input, draftStepId, auditStepId, event: { id: stableExecutionId(authority.test.caseId, `event:${index}`), seq, at,
      action: prepared.request.action, receipt: { id: stableExecutionId(authority.test.caseId, `receipt:${index}`), clientActionId: prepared.request.clientActionId,
        input: identity, sessionRevision: seq, status: "completed", observation } } });
}

async function loadDialogueDraft(tx: DbTransaction, binding: ApprovedBuildBinding, authority: Authority, state: State, index: number, stepId: string, material: DialogueMaterial) {
  const step = await loadGenerationStep(tx, binding, stepId, ActivityDraftCheckpointSchema);
  verifyIdentity(authority, state, index, step);
  inputMatches(step, stageMaterial(authority, state, index, "draft", { material: JsonValueSchema.parse(material) }));
  equal(step.result.material, material);
  await verifyStoredModelData(tx, step, step.result.operationId, DialogueDraftSchema, step.result.draft);
  return step;
}
async function loadDialogueAudit(tx: DbTransaction, binding: ApprovedBuildBinding, authority: Authority, state: State, index: number,
  stepId: string, draft: StoredGenerationStep<z.infer<typeof ActivityDraftCheckpointSchema>>) {
  const step = await loadGenerationStep(tx, binding, stepId, ActivityAuditCheckpointSchema);
  verifyIdentity(authority, state, index, step);
  if (step.result.draftStepId !== draft.id) invalid();
  inputMatches(step, stageMaterial(authority, state, index, "audit", { draftStepId: draft.id, material: draft.result.material, draft: draft.result.draft }));
  await verifyStoredModelData(tx, step, step.result.operationId, DialogueAuditSchema, step.result.audit);
  return step;
}
async function replayAction(tx: DbTransaction, binding: ApprovedBuildBinding, authority: Authority, state: State, index: number, stepId: string): Promise<State> {
  const step = await loadGenerationStep(tx, binding, stepId, ActivityActionCheckpointSchema);
  verifyIdentity(authority, state, index, step);
  const prepared = await prepareAction(authority, state, index, step.id);
  let observation: PublicObservation | null;
  if (prepared.prepared.execution.kind === "dialogue") {
    if (!step.result.draftStepId || !step.result.auditStepId) invalid();
    const material = await prepareDialogueMaterial(authority.candidate.task, authority.candidate.privateTask, prepared.activity, (prepared.request.action as { kind: "dialogue.turn"; text: string }).text);
    const draft = await loadDialogueDraft(tx, binding, authority, state, index, step.result.draftStepId, material);
    const audit = await loadDialogueAudit(tx, binding, authority, state, index, step.result.auditStepId, draft);
    observation = verifiedDialogueObservation(material, draft.result.draft, audit.result.audit);
  } else if (prepared.prepared.execution.kind === "deterministic") {
    if (step.result.draftStepId !== null || step.result.auditStepId !== null) invalid();
    observation = prepared.prepared.execution.observation;
  } else return unavailable();
  inputMatches(step, stageMaterial(authority, state, index, "action", { draftStepId: step.result.draftStepId, auditStepId: step.result.auditStepId }));
  equal(actionCheckpoint(authority, state, index, step.id, prepared, observation, step.result.event.at, step.result.draftStepId, step.result.auditStepId), step.result);
  return appendAction(state, step.result, prepared.prepared.cost);
}
async function replaySequence(tx: DbTransaction, binding: ApprovedBuildBinding, authority: Authority, stepIds: string[]): Promise<State> {
  if (stepIds.length !== authority.plan.actions.length || new Set(stepIds).size !== stepIds.length) invalid();
  let state = await initialState(authority);
  for (const [index, stepId] of stepIds.entries()) state = await replayAction(tx, binding, authority, state, index, stepId);
  return state;
}
function gradeMaterial(authority: Authority, state: State, response: JsonValue): JsonValue {
  return { binding: authority.binding, stage: "evaluate", actionStepIds: state.actionStepIds, response };
}
async function evaluateActivity(authority: Authority, activity: AuthoritativeActivity, evidenceRef: string, model: ModelPort | null, effect: StepEffectContext): Promise<CaseEvaluationResult> {
  const candidate = authority.candidate, test = authority.test, handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion)!;
  const base = { kind: "course.response_case" as const, candidateDigest: candidate.candidateDigest, caseId: test.caseId, category: test.category,
    response: activity.input.response, activityEvidenceRef: evidenceRef, modelCallId: null, rubricRequest: null, rubricJudgement: null };
  let response: JsonValue;
  try { response = handle.parseResponse(activity.input.response); if (handle.descriptor.validateSubmission(candidate.task.config, response).length) throw new Error(); }
  catch { return CaseEvaluationResultSchema.parse({ ...base, decision: null, rejectedAsInvalid: true }); }
  const captured: { request: RubricRequest | null; judgement: z.infer<typeof RubricJudgementSchema> | null; operationId: string | null } = { request: null, judgement: null, operationId: null };
  const judge: RubricJudge | null = model ? { async judge(request, signal) {
    if (captured.request !== null) unavailable();
    captured.request = RubricRequestSchema.parse(request);
    const budget = effect.budgetOperation("case-rubric"), actual = createRubricJudge(model, { budget, deadlineAt: effect.deadlineAt });
    const judgement = await actual.judge(captured.request, signal);
    captured.judgement = RubricJudgementSchema.parse(judgement); captured.operationId = budget.reservationId;
    return judgement;
  } } : null;
  const decision = await handle.evaluate({ task: candidate.task, privateData: candidate.privateTask.evaluatorData, response, activity }, { model: judge, signal: effect.signal });
  return CaseEvaluationResultSchema.parse({ ...base, response, decision, rejectedAsInvalid: false, modelCallId: captured.operationId,
    rubricRequest: captured.judgement === null ? null : captured.request, rubricJudgement: captured.judgement });
}

/** Loads the actual stored plan, action chain and provider records; it never calls a provider. */
async function replayStoredActivityCaseImpl(tx: DbTransaction, binding: ApprovedBuildBinding, candidate: PreparedTaskCandidate,
  resultValue: CaseEvaluationResult, step: StoredGenerationStep<CaseEvaluationResult>): Promise<void> {
  const storedStep = await loadGenerationStep(tx, binding, step.id, CaseEvaluationResultSchema);
  equal(storedStep, step);
  const result = CaseEvaluationResultSchema.parse(resultValue);
  equal(step.result, result);
  if (!result.activityEvidenceRef) invalid();
  const last = await loadGenerationStep(tx, binding, result.activityEvidenceRef, ActivityActionCheckpointSchema);
  const authority = await loadAuthority(tx, binding, last.result.binding);
  equal(authority.candidate, candidate);
  if (result.caseId !== authority.test.caseId || result.category !== authority.test.category || result.candidateDigest !== candidate.candidateDigest) invalid();
  const state = await replaySequence(tx, binding, authority, [...last.result.priorActionStepIds, last.id]);
  const activity = await withResponse(authority, state, authority.test.response);
  equal(result.response, activity.input.response);
  inputMatches(step, gradeMaterial(authority, state, activity.input.response));
  const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion)!;
  let formValid = false;
  try { formValid = handle.descriptor.validateSubmission(candidate.task.config, handle.parseResponse(result.response)).length === 0; } catch { /* Explicit malformed case. */ }
  if (result.rejectedAsInvalid) {
    if (formValid || result.decision !== null || result.modelCallId !== null || result.rubricRequest !== null || result.rubricJudgement !== null) invalid();
    return;
  }
  if (!formValid || !result.decision) invalid();
  let judge: RubricJudge | null = null;
  let calls = 0;
  if (result.modelCallId !== null) {
    if (!result.rubricRequest || !result.rubricJudgement) invalid();
    await verifyStoredModelData(tx, step, result.modelCallId, RubricJudgementSchema, result.rubricJudgement);
    const request = result.rubricRequest, judgement = validateRubricJudgement(result.rubricJudgement, request);
    judge = { async judge(actual) { if (++calls !== 1) invalid(); equal(actual, request); return judgement; } };
  } else if (result.rubricRequest !== null || result.rubricJudgement !== null) invalid();
  const actual = await handle.evaluate({ task: candidate.task, privateData: candidate.privateTask.evaluatorData, response: result.response, activity },
    { model: judge, signal: new AbortController().signal });
  if (result.modelCallId !== null && calls !== 1) invalid();
  equal(actual, result.decision);
}

/** Returns after one newly persisted step. All provider work runs outside read/commit transactions. */
async function advanceActivityCaseImpl(input: { context: RunContext; binding: ApprovedBuildBinding; index: StageIndex;
  candidateStepId: string; casePlanStepId: string; candidate: PreparedTaskCandidate; test: ResponseCase; model: ModelPort | null;
}): Promise<null | { stepId: string; result: CaseEvaluationResult }> {
  const { context, binding, index } = input;
  if (context.signal.aborted) throw new ProviderFailure("cancelled");
  if (context.claim.target.kind !== "generation" || context.claim.target.runId !== binding.run.id ||
    context.claim.target.ownerId !== binding.course.ownerId || context.claim.target.approvalDigest !== binding.approval.contentDigest) invalid();
  const authority = await context.read((tx) => loadAuthority(tx, binding, { candidateStepId: input.candidateStepId, casePlanStepId: input.casePlanStepId, caseId: input.test.caseId }));
  equal(authority.candidate, input.candidate); equal(authority.test, input.test);
  const prefix = `course/case/${input.test.caseId}/activity`;
  const finalId = index.get(`${prefix}/evaluate`);
  if (finalId) return context.read(async (tx) => {
    const step = await loadGenerationStep(tx, binding, finalId, CaseEvaluationResultSchema);
    await replayStoredActivityCase(tx, binding, authority.candidate, step.result, step);
    return { stepId: step.id, result: step.result };
  });
  let state = await initialState(authority);
  const verifyCurrent = async (tx: DbTransaction) => { const current = await loadAuthority(tx, binding, authority.binding); equal(current, authority); };
  for (let actionIndex = 0; actionIndex < authority.plan.actions.length; actionIndex++) {
    const key = `${prefix}/${actionIndex}`, actionId = index.get(`${key}/action`);
    if (actionId) { state = await context.read((tx) => replayAction(tx, binding, authority, state, actionIndex, actionId)); continue; }
    // Preview is bound to the already loaded plan. The action is recomputed below
    // inside its actual persisted effect before any output/provider call is used.
    const prepared = await prepareAction(authority, state, actionIndex, authority.binding.casePlanStepId);
    let draftId: string | null = null, auditId: string | null = null;
    let observation: PublicObservation | null;
    if (prepared.prepared.execution.kind === "dialogue") {
      if (!input.model || prepared.request.action.kind !== "dialogue.turn") unavailable();
      const model = input.model;
      const material = await prepareDialogueMaterial(authority.candidate.task, authority.candidate.privateTask, prepared.activity, prepared.request.action.text);
      draftId = index.get(`${key}/draft`) ?? null;
      if (!draftId) {
        await context.step({ key: `${key}/draft`, input: stageMaterial(authority, state, actionIndex, "draft", { material: JsonValueSchema.parse(material) }),
          digests: generationDigests(binding), outputSchema: ActivityDraftCheckpointSchema, resultSchema: ActivityDraftCheckpointSchema,
          async effect(effect) {
            const current = await prepareAction(authority, state, actionIndex, effect.stepId);
            if (current.prepared.execution.kind !== "dialogue" || current.request.action.kind !== "dialogue.turn") invalid();
            const actualMaterial = await prepareDialogueMaterial(authority.candidate.task, authority.candidate.privateTask, current.activity, current.request.action.text);
            equal(actualMaterial, material);
            const budget = effect.budgetOperation("dialogue-draft"); return { kind: "course.activity.draft" as const,
            ...checkpointIdentity(authority, state, actionIndex, effect.stepId), material: JsonValueSchema.parse(material), operationId: budget.reservationId,
            draft: await generateDialogueDraft(model, { budget, deadlineAt: effect.deadlineAt }, material, effect.signal) }; },
          async commit(tx, output) { await verifyCurrent(tx); return output; } });
        return null;
      }
      const draft = await context.read((tx) => loadDialogueDraft(tx, binding, authority, state, actionIndex, draftId!, material));
      auditId = index.get(`${key}/audit`) ?? null;
      if (!auditId) {
        await context.step({ key: `${key}/audit`, input: stageMaterial(authority, state, actionIndex, "audit", { draftStepId: draft.id, material: draft.result.material, draft: draft.result.draft }),
          digests: generationDigests(binding), outputSchema: ActivityAuditCheckpointSchema, resultSchema: ActivityAuditCheckpointSchema,
          async effect(effect) { const budget = effect.budgetOperation("dialogue-audit"); return { kind: "course.activity.audit" as const,
            ...checkpointIdentity(authority, state, actionIndex, effect.stepId), draftStepId: draft.id, operationId: budget.reservationId,
            audit: await auditDialogueDraft(model, { budget, deadlineAt: effect.deadlineAt }, material, draft.result.draft, effect.signal) }; },
          async commit(tx, output) { await verifyCurrent(tx); return output; } });
        return null;
      }
      const audit = await context.read((tx) => loadDialogueAudit(tx, binding, authority, state, actionIndex, auditId!, draft));
      observation = verifiedDialogueObservation(material, draft.result.draft, audit.result.audit);
    } else if (prepared.prepared.execution.kind === "deterministic") observation = prepared.prepared.execution.observation;
    else return unavailable();
    await context.step({ key: `${key}/action`, input: stageMaterial(authority, state, actionIndex, "action", { draftStepId: draftId, auditStepId: auditId }),
      digests: generationDigests(binding), outputSchema: ActivityActionCheckpointSchema, resultSchema: ActivityActionCheckpointSchema,
      async effect(effect) {
        const actual = await prepareAction(authority, state, actionIndex, effect.stepId);
        const actualObservation = actual.prepared.execution.kind === "deterministic" ? actual.prepared.execution.observation : observation;
        return actionCheckpoint(authority, state, actionIndex, effect.stepId, actual, actualObservation, new Date().toISOString(), draftId, auditId);
      },
      async commit(tx, output) { await verifyCurrent(tx); return output; } });
    return null;
  }
  const activity = await withResponse(authority, state, authority.test.response), evidenceRef = state.actionStepIds.at(-1) ?? invalid();
  await context.step({ key: `${prefix}/evaluate`, input: gradeMaterial(authority, state, activity.input.response), digests: generationDigests(binding),
    outputSchema: CaseResultJsonSchema, resultSchema: CaseResultJsonSchema,
    async effect(effect) { return JsonValueSchema.parse(await evaluateActivity(authority, activity, evidenceRef, input.model, effect)); },
    async commit(tx, output) { await verifyCurrent(tx); return output; } });
  return null;
}

function activityFailure(error: unknown): never {
  // Invalid authored actions/audits are terminal validation failures, not an
  // infrastructure interruption that should leave a generation lease running.
  if (error instanceof ServiceFault || error instanceof z.ZodError) invalid();
  throw error;
}
export async function advanceActivityCase(input: Parameters<typeof advanceActivityCaseImpl>[0]): ReturnType<typeof advanceActivityCaseImpl> {
  try { return await advanceActivityCaseImpl(input); } catch (error) { return activityFailure(error); }
}
export async function replayStoredActivityCase(...args: Parameters<typeof replayStoredActivityCaseImpl>): Promise<void> {
  try { return await replayStoredActivityCaseImpl(...args); } catch (error) { return activityFailure(error); }
}
