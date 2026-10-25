import "server-only";
import { canonicalResponseJson, sameInputIdentity, validateInputSnapshot, type ActivityAction } from "@/domain/activity";
import type { JsonValue } from "@/domain/common";
import type { TaskPublic } from "@/domain/mechanics";
import { parseFamilyResponse } from "@/domain/mechanic-families/v2/shared";
import { outcomePredictionDescriptor, causalInterventionDescriptor } from "@/domain/mechanic-families/v2/investigation";
import { constrainedOptimizationDescriptor } from "@/domain/mechanic-families/v2/construction";
import { CommunicationSubmissionError, validateCommunicationActivity } from "@/server/evaluation/communication";
import type { AuthoritativeActivity } from "@/server/evaluation/contracts";
import { invalidLearningFields, validateLearningSubmission } from "./actions";

function invalid(field: string, message: string): never { throw invalidLearningFields([{ path: [field], message }]); }

/** Field/reference invalidity is rejected before creating any Attempt or knowledge evidence. */
export async function validateSubmittedActivity(task: TaskPublic, response: JsonValue, activity: AuthoritativeActivity): Promise<JsonValue> {
  const parsed = validateLearningSubmission(task, response);
  await validateInputSnapshot(activity.input);
  if (activity.input.activitySessionId !== activity.session.id || activity.input.inputRevision !== activity.session.inputRevision ||
    activity.session.taskId !== task.id || activity.session.taskVersion !== task.taskVersion || canonicalResponseJson(activity.input.response) !== canonicalResponseJson(parsed)) invalid("response", "Submit the exact saved response for this activity.");
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") invalid("response", "A task response must be an object.");
  async function receipt(id: unknown, kind: ActivityAction["kind"], field: string) {
    const event = activity.session.events.find((event) => event.receipt.id === id && event.action.kind === kind);
    const authoritative = activity.receipts.find((receipt) => receipt.id === id);
    if (!event || !authoritative || event.receipt.status !== "completed" || canonicalResponseJson(event.receipt) !== canonicalResponseJson(authoritative)) invalid(field, "Use a completed observation from this activity.");
    const snapshots = activity.receiptInputs.filter((snapshot) => sameInputIdentity(snapshot, authoritative.input));
    if (snapshots.length !== 1) invalid(field, "The observation's saved input is unavailable.");
    const historical = await validateInputSnapshot(snapshots[0]);
    return { event, response: historical.response };
  }
  if (task.mechanicId === "outcome_prediction") {
    const answer = parseFamilyResponse(outcomePredictionDescriptor, parsed);
    const commit = await receipt(answer.commitReceiptId, "prediction.commit", "commitReceiptId");
    const run = await receipt(answer.observationReceiptId, "run", "observationReceiptId");
    const committed = parseFamilyResponse(outcomePredictionDescriptor, commit.response);
    const observed = parseFamilyResponse(outcomePredictionDescriptor, run.response);
    if (canonicalResponseJson(committed.interval) !== canonicalResponseJson(answer.interval) || canonicalResponseJson(observed.interval) !== canonicalResponseJson(answer.interval) ||
      observed.commitReceiptId !== answer.commitReceiptId || !activity.predictionBeforeObservation || activity.committedPredictionReceiptId !== answer.commitReceiptId || commit.event.seq >= run.event.seq) {
      invalid("interval", "This prediction changed after commitment or was observed before commitment.");
    }
  } else if (task.mechanicId === "causal_intervention") {
    const answer = parseFamilyResponse(causalInterventionDescriptor, parsed);
    const observed = await receipt(answer.observationReceiptId, "intervention.apply", "observationReceiptId");
    const prior = parseFamilyResponse(causalInterventionDescriptor, observed.response);
    if (observed.event.action.kind !== "intervention.apply" || canonicalResponseJson(prior.assignments) !== canonicalResponseJson(answer.assignments) ||
      canonicalResponseJson(observed.event.action.assignments) !== canonicalResponseJson(answer.assignments)) invalid("assignments", "Apply the current saved assignments before submitting.");
  } else if (task.mechanicId === "constrained_optimization") {
    const answer = parseFamilyResponse(constrainedOptimizationDescriptor, parsed);
    const observed = await receipt(answer.observationReceiptId, "run", "observationReceiptId");
    const prior = parseFamilyResponse(constrainedOptimizationDescriptor, observed.response);
    if (canonicalResponseJson(prior.configuration) !== canonicalResponseJson(answer.configuration)) invalid("configuration", "Run the current saved configuration before submitting.");
  } else if (task.mechanicId === "experimental_investigation") {
    if (!Array.isArray(parsed.observationReceiptIds)) invalid("observationReceiptIds", "Use the saved measurement receipts.");
    for (const id of parsed.observationReceiptIds) await receipt(id, "experiment.query", "observationReceiptIds");
  } else if (["misconception_tutoring", "information_gap", "role_simulation"].includes(task.mechanicId)) {
    if (!Array.isArray(parsed.turnReceiptIds) || parsed.turnReceiptIds.some((id) => typeof id !== "string")) invalid("turnReceiptIds", "Use the saved conversation turns.");
    for (const id of parsed.turnReceiptIds) await receipt(id, "dialogue.turn", "turnReceiptIds");
    try {
      await validateCommunicationActivity(task, { ...parsed, turnReceiptIds: parsed.turnReceiptIds as string[] }, activity);
    } catch (error) {
      if (error instanceof CommunicationSubmissionError) throw invalidLearningFields(error.issues);
      throw error;
    }
  }
  return parsed;
}
