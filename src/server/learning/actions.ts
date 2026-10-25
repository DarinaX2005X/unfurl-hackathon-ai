import "server-only";
import { z } from "zod";
import {
  ActivityActionRequestSchema, ActivitySessionPublicSchema, PublicObservationSchema, activityActionCost,
  canonicalResponseJson, sameInputIdentity, validateInputSnapshot,
  type ActivityActionRequest, type PublicObservation,
} from "@/domain/activity";
import { IdSchema, type JsonValue } from "@/domain/common";
import { TaskPrivateSchema, TaskPrivateCandidateSchema, type TaskPrivate, type TaskPrivateCandidate, type TaskPublic } from "@/domain/mechanics";
import {
  causalInterventionDescriptor, experimentalInvestigationDescriptor, outcomePredictionDescriptor,
  evaluateCausalModel, predictOutcome,
} from "@/domain/mechanic-families/v2/investigation";
import { MECHANIC_LIMITS, parseFamilyResponse, parseFamilyTask, type SubmissionIssue } from "@/domain/mechanic-families/v2/shared";
import { ExperimentalInvestigationPrivateSchema, experimentalObservation } from "@/server/evaluation/investigation";
import { ConstructionSubmissionError, runConstructionActivity } from "@/server/evaluation/construction";
import { ActivityContextSessionSchema, type AuthoritativeActivity } from "@/server/evaluation/contracts";
import { ServiceFault } from "@/server/auth/errors";
import { getServerMechanic } from "@/server/mechanics/registry";
import { PythonArtifactConfigSchema, PythonArtifactResponseSchema, PythonRepairConfigSchema, PythonRepairResponseSchema,
  type ExecutionJson } from "@/domain/mechanic-families/v3/python";

export function invalidLearningFields(issues: readonly { path: readonly PropertyKey[]; message: string }[]): ServiceFault {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const path = `/${issue.path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
    if (!Object.hasOwn(fieldErrors, path)) fieldErrors[path] = issue.message;
  }
  return new ServiceFault(400, "invalid_input", "learning.invalidInput", false, { fieldErrors });
}
function fields(issues: SubmissionIssue[]): void { if (issues.length) throw invalidLearningFields(issues); }
function invalid(path: string, message: string): never { throw invalidLearningFields([{ path: [path], message }]); }
function conflict(messageKey: string, revision: number): never {
  throw new ServiceFault(409, "revision_conflict", messageKey, false, { currentRevision: revision });
}

export type PreparedActivityAction = {
  action: ActivityActionRequest["action"]; cost: 0 | 1; budgetLimit: number;
  execution: { kind: "deterministic"; observation: PublicObservation | null } | { kind: "dialogue" } |
    { kind: "python"; source: string; cases: Array<{ id: string; input: ExecutionJson }>; runtimeProfile: "python_stdlib_v1" };
};

export function activityBudgetLimit(task: TaskPublic): number {
  const handle = getServerMechanic(task.mechanicId, task.mechanicVersion);
  if (!handle) throw new ServiceFault(503, "service_unavailable", "learning.mechanicUnavailable", false);
  const config = handle.parseTask(task).config;
  const bound = task.mechanicId === "experimental_investigation" ? config.queryBudget :
    task.mechanicId === "causal_intervention" ? config.actionBudget :
      handle.descriptor.actions.includes("dialogue.turn") ? config.turnBudget : MECHANIC_LIMITS.actions;
  if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 0) throw new ServiceFault(503, "service_unavailable", "learning.invalidStoredTask", false);
  return Math.min(MECHANIC_LIMITS.actions, bound);
}

/** Pure bounded work before reservation. Caller holds the activity lock and handles replay first. */
export async function prepareActivityAction(input: {
  task: TaskPublic; privateTask: TaskPrivate; activity: AuthoritativeActivity; request: ActivityActionRequest;
}): Promise<PreparedActivityAction> {
  const validated = TaskPrivateSchema.parse(input.privateTask);
  const { validationReceiptId: _receipt, ...candidate } = validated;
  void _receipt;
  const { enrollmentId: _enrollmentId, ...session } = ActivitySessionPublicSchema.parse(input.activity.session);
  void _enrollmentId;
  return prepareBoundedActivityAction({ ...input, activity: { ...input.activity, session }, privateTask: candidate });
}

const ValidationBindingSchema = z.object({ generationRunId: IdSchema, runStepId: IdSchema,
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), approvalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  caseId: z.string().trim().min(1).max(128) }).strict();
/** Same pure action rules for a generation candidate, before a validation receipt exists. */
export async function prepareCandidateActivityAction(input: {
  task: TaskPublic; privateTask: TaskPrivateCandidate; activity: AuthoritativeActivity; request: ActivityActionRequest;
  /** The generation repository must verify these persisted joins before calling this pure helper. */
  validationBinding: z.infer<typeof ValidationBindingSchema>;
}): Promise<PreparedActivityAction> {
  ValidationBindingSchema.parse(input.validationBinding);
  return prepareBoundedActivityAction(input);
}

async function prepareBoundedActivityAction(input: {
  task: TaskPublic; privateTask: TaskPrivateCandidate; activity: AuthoritativeActivity; request: ActivityActionRequest;
}): Promise<PreparedActivityAction> {
  try {
    const request = ActivityActionRequestSchema.parse(input.request);
    const session = ActivityContextSessionSchema.parse(input.activity.session);
    const snapshot = await validateInputSnapshot(input.activity.input);
    const privateTask = TaskPrivateCandidateSchema.parse(input.privateTask);
    const handle = getServerMechanic(input.task.mechanicId, input.task.mechanicVersion);
    if (!handle) throw new ServiceFault(503, "service_unavailable", "learning.mechanicUnavailable", false);
    const task = handle.parseTask(input.task);
    const response = handle.parseResponse(snapshot.response);
    if (privateTask.taskId !== task.id || privateTask.taskVersion !== task.taskVersion || session.taskId !== task.id || session.taskVersion !== task.taskVersion) {
      throw new ServiceFault(503, "service_unavailable", "learning.invalidStoredTask", false);
    }
    const privateData = handle.parsePrivate(privateTask.evaluatorData);
    if (!sameInputIdentity(snapshot, { activitySessionId: session.id, inputRevision: request.inputRevision, responseDigest: request.responseDigest }) ||
      snapshot.inputRevision !== session.inputRevision) conflict("learning.inputChanged", session.revision);
    if (request.expectedRevision !== session.revision) conflict("learning.activityChanged", session.revision);
    if (!handle.descriptor.actions.includes(request.action.kind)) invalid("action", "This task does not support that action.");
    const action = request.action;
    let budgetLimit: number = MECHANIC_LIMITS.actions;
    let observation: PublicObservation | null = null;
    let dialogue = false;
    let python: Extract<PreparedActivityAction["execution"], { kind: "python" }> | null = null;

    if (task.mechanicId === "outcome_prediction") {
      const config = parseFamilyTask(outcomePredictionDescriptor, task).config;
      const answer = parseFamilyResponse(outcomePredictionDescriptor, response);
      fields(outcomePredictionDescriptor.validateSubmission(config, answer).filter((issue) => issue.path[0] === "interval"));
      if (action.kind === "prediction.commit") {
        if (session.events.some((event) => event.action.kind === "prediction.commit" || activityActionCost(event.action) > 0)) conflict("learning.predictionAlreadyCommitted", session.revision);
        if (answer.commitReceiptId !== null || answer.observationReceiptId !== null) invalid("commitReceiptId", "Commit a fresh prediction before citing observations.");
      } else if (action.kind === "run") {
        const commit = session.events.find((event) => event.action.kind === "prediction.commit" && event.receipt.id === answer.commitReceiptId && event.receipt.status === "completed");
        const historical = input.activity.receiptInputs.find((value) => commit && sameInputIdentity(value, commit.receipt.input));
        if (!commit || !historical) invalid("commitReceiptId", "Commit this prediction before observing its result.");
        await validateInputSnapshot(historical);
        const committed = parseFamilyResponse(outcomePredictionDescriptor, historical.response);
        if (canonicalResponseJson(committed.interval) !== canonicalResponseJson(answer.interval)) invalid("interval", "The interval changed after its prediction was committed.");
        observation = { kind: "values", values: [predictOutcome(config)] };
      }
    } else if (task.mechanicId === "experimental_investigation" && action.kind === "experiment.query") {
      const config = parseFamilyTask(experimentalInvestigationDescriptor, task).config;
      budgetLimit = Math.min(budgetLimit, config.queryBudget);
      if (!config.allowedInputs.includes(action.input)) invalid("action", "Choose a declared experiment input.");
      const hidden = ExperimentalInvestigationPrivateSchema.parse(privateData);
      if (!config.hypotheses.some(({ id }) => id === hidden.hiddenHypothesisId)) throw new ServiceFault(503, "service_unavailable", "learning.invalidStoredTask", false);
      observation = experimentalObservation(config, hidden.hiddenHypothesisId, action.input);
    } else if (task.mechanicId === "causal_intervention" && action.kind === "intervention.apply") {
      const config = parseFamilyTask(causalInterventionDescriptor, task).config;
      const answer = parseFamilyResponse(causalInterventionDescriptor, response);
      budgetLimit = Math.min(budgetLimit, config.actionBudget);
      fields(causalInterventionDescriptor.validateSubmission(config, answer).filter((issue) => issue.path[0] !== "observationReceiptId"));
      if (canonicalResponseJson(action.assignments) !== canonicalResponseJson(answer.assignments)) invalid("action", "Save these assignments before applying the intervention.");
      observation = { kind: "values", values: evaluateCausalModel(config, action.assignments) };
    } else if (action.kind === "run" && task.mechanicVersion === 3) {
      const config = task.mechanicId === "artifact_construction" ? PythonArtifactConfigSchema.parse(task.config) : PythonRepairConfigSchema.parse(task.config);
      const answer = task.mechanicId === "artifact_construction" ? PythonArtifactResponseSchema.parse(response) : PythonRepairResponseSchema.parse(response);
      if (!answer.source.trim()) invalid("source", "Write or repair the function before running its public cases.");
      python = { kind: "python", source: answer.source, cases: config.publicCases.map(({ id, input }) => ({ id, input })), runtimeProfile: config.runtimeProfile };
    } else if (action.kind === "run") {
      observation = runConstructionActivity(task, response);
    } else if (action.kind === "dialogue.turn") {
      if (response === null || Array.isArray(response) || typeof response !== "object" || response.dialogueDraft !== action.text) invalid("action", "Save the current message before sending it.");
      const budget = task.config.turnBudget;
      if (typeof budget !== "number" || !Number.isInteger(budget)) throw new ServiceFault(503, "service_unavailable", "learning.invalidStoredTask", false);
      budgetLimit = Math.min(budgetLimit, budget);
      if (session.events.some((event) => event.action.kind === "dialogue.turn" && event.receipt.status === "pending")) conflict("learning.turnPending", session.revision);
      dialogue = true;
    } else {
      invalid("action", "This action is unavailable for the current task.");
    }
    const cost = activityActionCost(action);
    const reserved = session.events.reduce((total, event) => total + activityActionCost(event.action), 0);
    if (session.events.length >= 100 || (cost > 0 && (session.remainingActions < cost || reserved + cost > budgetLimit))) {
      throw new ServiceFault(409, "revision_conflict", "learning.actionBudgetExhausted", false, { currentRevision: session.revision });
    }
    return { action, cost, budgetLimit, execution: python ?? (dialogue ? { kind: "dialogue" } :
      { kind: "deterministic", observation: observation === null ? null : PublicObservationSchema.parse(observation) }) };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof ConstructionSubmissionError) throw invalidLearningFields(error.issues);
    throw error;
  }
}

/** Parse complete forms before Attempt insertion; well-formed wrong knowledge remains gradeable. */
export function validateLearningSubmission(task: TaskPublic, response: JsonValue): JsonValue {
  const handle = getServerMechanic(task.mechanicId, task.mechanicVersion);
  if (!handle) throw new ServiceFault(503, "service_unavailable", "learning.mechanicUnavailable", false);
  try {
    const parsedTask = handle.parseTask(task);
    const parsedResponse = handle.parseResponse(response);
    fields(handle.descriptor.validateSubmission(parsedTask.config, parsedResponse));
    return parsedResponse;
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidLearningFields(error.issues);
    throw error;
  }
}
