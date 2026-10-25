import "server-only";
import { z } from "zod";
import type { JsonValue } from "../../../domain/common";
import type { TaskPublic } from "../../../domain/mechanics";
import {
  ActivitySessionPublicSchema, ActionReceiptSchema, canonicalResponseJson, validateInputSnapshot,
  type ActivityEventPublic,
} from "../../../domain/activity";
import {
  analogyTransferDescriptor, selfExplanationDescriptor, argumentRebuttalDescriptor, critiqueRevisionDescriptor,
  misconceptionTutoringDescriptor, informationGapDescriptor, roleSimulationDescriptor, audienceMediationDescriptor,
} from "../../../domain/mechanic-families/v2/communication";
import {
  BlockSchema, MECHANIC_LIMITS, NonemptyTextSchema, parseFamilyTask, parseFamilyResponse,
  type FamilyDescriptor, type SubmissionIssue,
} from "../../../domain/mechanic-families/v2/shared";
import {
  ActivityContextSessionSchema, RubricRequestSchema, evaluateRubric, receiptInputFor, type AuthoritativeActivity, type EvaluatorRegistration,
  type GradeDecision, type ResponsePath, type RubricRequest,
} from "../contracts";

export const communicationDimensions = {
  analogy_transfer: ["structure", "limit"],
  self_explanation: ["principle", "boundary"],
  argument_rebuttal: ["support", "inference", "rebuttal"],
  critique_revision: ["diagnosis", "revision"],
  misconception_tutoring: ["diagnosis", "correction", "transfer_check"],
  information_gap: ["question_relevance", "decision_grounding"],
  role_simulation: ["constraints", "agreement", "rationale"],
  audience_mediation: ["meaning", "limits", "audience"],
} as const;

function rubricFor(ids: readonly string[]) {
  return RubricRequestSchema.shape.rubric.refine((rubric) => {
    const found = rubric.dimensions.map((dimension) => dimension.id);
    return found.length === ids.length && new Set(found).size === ids.length && ids.every((id) => found.includes(id));
  }, "Supply every required family dimension exactly once");
}
const privateBlocks = z.array(BlockSchema).min(1).max(MECHANIC_LIMITS.graphNodes)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Private fact identifiers must be unique");

export const AnalogyTransferPrivateSchema = z.object({
  kind: z.literal("analogy_transfer"), rubric: rubricFor(communicationDimensions.analogy_transfer),
}).strict();
export const SelfExplanationPrivateSchema = z.object({
  kind: z.literal("self_explanation"), rubric: rubricFor(communicationDimensions.self_explanation),
}).strict();
export const ArgumentRebuttalPrivateSchema = z.object({
  kind: z.literal("argument_rebuttal"), rubric: rubricFor(communicationDimensions.argument_rebuttal),
}).strict();
export const CritiqueRevisionPrivateSchema = z.object({
  kind: z.literal("critique_revision"), rubric: rubricFor(communicationDimensions.critique_revision),
}).strict();
export const MisconceptionTutoringPrivateSchema = z.object({
  kind: z.literal("misconception_tutoring"), rubric: rubricFor(communicationDimensions.misconception_tutoring),
  misconception: NonemptyTextSchema, disclosureRules: privateBlocks,
}).strict();
export const InformationGapPrivateSchema = z.object({
  kind: z.literal("information_gap"), rubric: rubricFor(communicationDimensions.information_gap),
  hiddenFacts: privateBlocks, disclosureRules: privateBlocks,
}).strict();
export const RoleSimulationPrivateSchema = z.object({
  kind: z.literal("role_simulation"), rubric: rubricFor(communicationDimensions.role_simulation),
  scenarioConstraints: privateBlocks, permittedOutcomes: privateBlocks, disclosureRules: privateBlocks,
}).strict();
export const AudienceMediationPrivateSchema = z.object({
  kind: z.literal("audience_mediation"), rubric: rubricFor(communicationDimensions.audience_mediation),
}).strict();
export type AnalogyTransferPrivate = z.infer<typeof AnalogyTransferPrivateSchema>;
export type SelfExplanationPrivate = z.infer<typeof SelfExplanationPrivateSchema>;
export type ArgumentRebuttalPrivate = z.infer<typeof ArgumentRebuttalPrivateSchema>;
export type CritiqueRevisionPrivate = z.infer<typeof CritiqueRevisionPrivateSchema>;
export type MisconceptionTutoringPrivate = z.infer<typeof MisconceptionTutoringPrivateSchema>;
export type InformationGapPrivate = z.infer<typeof InformationGapPrivateSchema>;
export type RoleSimulationPrivate = z.infer<typeof RoleSimulationPrivateSchema>;
export type AudienceMediationPrivate = z.infer<typeof AudienceMediationPrivateSchema>;

type PrivateData = { kind: string; rubric: RubricRequest["rubric"] };

/** A form error must be handled before an Attempt, never converted to incorrect knowledge. */
export class CommunicationSubmissionError extends Error {
  constructor(readonly issues: SubmissionIssue[]) {
    super(issues[0]?.message ?? "This response needs a correction before submission.");
    this.name = "CommunicationSubmissionError";
  }
}
function invalidReference(path: SubmissionIssue["path"], message: string): never {
  throw new CommunicationSubmissionError([{ path, code: "invalid_reference", message }]);
}
function unresolved(privateData: PrivateData, explanation: string): GradeDecision {
  return { status: "unavailable", outcome: null,
    dimensions: privateData.rubric.dimensions.map((dimension) => ({ id: dimension.id, status: "uncertain", explanation })),
    feedback: { explanation, nextAction: "wait" } };
}

type DialogueResponse = { turnReceiptIds: string[]; obtainedFactIds?: string[] };
type VerifiedDialogue = { turns: ActivityEventPublic[]; revealedFactIds: string[] };

/** Historical turns may precede the final writing revision, but may not cross session/task identity. */
export async function validateCommunicationActivity<C extends JsonValue, R extends JsonValue>(
  task: TaskPublic<C>, response: R & DialogueResponse, activity: AuthoritativeActivity,
): Promise<VerifiedDialogue> {
  // Learner enrollment is authorized by its service; stored authoring cases use
  // the same bounded history invariants without fabricating an enrollment.
  const session = z.union([ActivitySessionPublicSchema, ActivityContextSessionSchema]).parse(activity.session);
  const snapshot = await validateInputSnapshot(activity.input);
  if (session.taskId !== task.id || session.taskVersion !== task.taskVersion || snapshot.activitySessionId !== session.id ||
      snapshot.inputRevision !== session.inputRevision || canonicalResponseJson(snapshot.response) !== canonicalResponseJson(response)) {
    invalidReference(["turnReceiptIds"], "The conversation does not match the current task and saved response.");
  }
  const receipts = activity.receipts.map((receipt) => ActionReceiptSchema.parse(receipt));
  if (new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length) throw new Error("Authoritative receipt identifiers are not unique");
  const turns = session.events.filter((event) => event.action.kind === "dialogue.turn");
  const complete = turns.filter((event) => event.receipt.status === "completed" && event.receipt.observation?.kind === "dialogue");
  response.turnReceiptIds.forEach((id, index) => {
    const event = complete.find((turn) => turn.receipt.id === id);
    const stored = receipts.find((receipt) => receipt.id === id);
    const historicalInput = receiptInputFor(activity, id);
    if (!event || !stored || !historicalInput || canonicalResponseJson(event.receipt) !== canonicalResponseJson(stored)) {
      invalidReference(["turnReceiptIds", index], "Use only completed turns from this conversation.");
    }
    const historicalResponse = historicalInput.response;
    if (historicalResponse === null || Array.isArray(historicalResponse) || typeof historicalResponse !== "object" ||
        historicalResponse.kind !== task.mechanicId || event.action.kind !== "dialogue.turn" ||
        historicalResponse.dialogueDraft !== event.action.text) throw new Error("Stored turn input does not match its action");
  });
  const revealed = new Set(complete.flatMap((event) => event.receipt.observation?.kind === "dialogue" ?
    event.receipt.observation.revealedFacts.map((fact) => fact.id) : []));
  const authoritative = new Set(activity.revealedFactIds);
  for (const id of revealed) {
    if (!authoritative.has(id)) throw new Error("The authoritative fact ledger and observed dialogue disagree");
  }
  response.obtainedFactIds?.forEach((id, index) => {
    if (!revealed.has(id) || !authoritative.has(id)) {
      invalidReference(["obtainedFactIds", index], "This fact has not been revealed in your conversation.");
    }
  });
  return { turns, revealedFactIds: [...revealed] };
}

const paths: Record<keyof typeof communicationDimensions, ResponsePath[]> = {
  analogy_transfer: [["mappings"], ["limit"]],
  self_explanation: [["principle"], ["limit"]],
  argument_rebuttal: [["claim"], ["evidenceRefs"], ["warrant"], ["counterargument"], ["response"]],
  critique_revision: [["findings"], ["revision"]],
  misconception_tutoring: [["turnReceiptIds"], ["diagnosticQuestion"], ["correction"], ["check"]],
  information_gap: [["turnReceiptIds"], ["obtainedFactIds"], ["decision"]],
  role_simulation: [["turnReceiptIds"], ["agreement", "commitments"], ["agreement", "conditions"], ["rationale"]],
  audience_mediation: [["text"]],
};

/** Context is separate untrusted material. Private criteria remain criteria, with no packed source text. */
export function createCommunicationRubricRequest<C extends JsonValue, R extends JsonValue, P extends PrivateData>(
  task: TaskPublic<C>, response: R, privateData: P, dialogue: VerifiedDialogue | null,
): RubricRequest {
  const { rubric, ...privateContext } = privateData;
  const request = {
    rubric, response, allowedResponsePaths: paths[task.mechanicId as keyof typeof paths],
    context: {
      instruction: task.instruction,
      material: { config: task.config, contentLanguage: task.contentLanguage },
      referenceFacts: { privateContext, dialogue: dialogue ? {
        turns: dialogue.turns.map((event) => ({
          receiptId: event.receipt.id, action: event.action, status: event.receipt.status, observation: event.receipt.observation,
        })), revealedFactIds: dialogue.revealedFactIds,
      } : null },
    },
  };
  return RubricRequestSchema.parse(request);
}

function evaluator<C extends JsonValue, R extends JsonValue, P extends PrivateData>(
  descriptor: FamilyDescriptor<C, R>, privateSchema: z.ZodType<P>,
): EvaluatorRegistration<C, R, P> {
  return {
    id: descriptor.id, version: 2, privateSchema,
    async evaluate(input, context) {
      context.signal.throwIfAborted();
      const task = parseFamilyTask(descriptor, input.task);
      const response = parseFamilyResponse(descriptor, input.response);
      const privateData = privateSchema.parse(input.privateData);
      const issues = descriptor.validateSubmission(task.config, response);
      if (issues.length) throw new CommunicationSubmissionError(issues);
      let dialogue: VerifiedDialogue | null = null;
      if (descriptor.actions.includes("dialogue.turn")) {
        if (!input.activity) return unresolved(privateData, "The conversation could not be loaded for assessment. Your response is retained for retry.");
        try {
          dialogue = await validateCommunicationActivity(task, response as R & DialogueResponse, input.activity);
        } catch (error) {
          if (error instanceof CommunicationSubmissionError) throw error;
          return unresolved(privateData, "The conversation history could not be verified. Your response is retained for retry.");
        }
        if (privateData.kind === "information_gap") {
          const info = InformationGapPrivateSchema.parse(privateData);
          for (const [index, id] of ((response as R & DialogueResponse).obtainedFactIds ?? []).entries()) {
            if (!info.hiddenFacts.some((fact) => fact.id === id)) {
              invalidReference(["obtainedFactIds", index], "This fact is not part of the scenario's missing information.");
            }
          }
        }
      }
      let request: RubricRequest;
      try { request = createCommunicationRubricRequest(task, response, privateData, dialogue); }
      catch { return unresolved(privateData, "This task's assessment material could not be prepared. Your response is retained for review."); }
      return evaluateRubric(request, context);
    },
  };
}

export const analogyTransferEvaluator = evaluator(analogyTransferDescriptor, AnalogyTransferPrivateSchema);
export const selfExplanationEvaluator = evaluator(selfExplanationDescriptor, SelfExplanationPrivateSchema);
export const argumentRebuttalEvaluator = evaluator(argumentRebuttalDescriptor, ArgumentRebuttalPrivateSchema);
export const critiqueRevisionEvaluator = evaluator(critiqueRevisionDescriptor, CritiqueRevisionPrivateSchema);
export const misconceptionTutoringEvaluator = evaluator(misconceptionTutoringDescriptor, MisconceptionTutoringPrivateSchema);
export const informationGapEvaluator = evaluator(informationGapDescriptor, InformationGapPrivateSchema);
export const roleSimulationEvaluator = evaluator(roleSimulationDescriptor, RoleSimulationPrivateSchema);
export const audienceMediationEvaluator = evaluator(audienceMediationDescriptor, AudienceMediationPrivateSchema);

export const evaluators = [analogyTransferEvaluator, selfExplanationEvaluator, argumentRebuttalEvaluator,
  critiqueRevisionEvaluator, misconceptionTutoringEvaluator, informationGapEvaluator, roleSimulationEvaluator,
  audienceMediationEvaluator] as const;
