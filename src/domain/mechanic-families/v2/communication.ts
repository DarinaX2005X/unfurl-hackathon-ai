import { z } from "zod";
import { IdSchema, type JsonValue } from "../../common";
import {
  BlockSchema, LocalIdSchema, MECHANIC_LIMITS, NonemptyTextSchema, SpanSchema, TextSchema,
  isValidSpan, type Block, type FamilyDescriptor, type SubmissionIssue,
} from "./shared";

const blocks = z.array(BlockSchema).min(1).max(MECHANIC_LIMITS.graphNodes)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Material identifiers must be unique");
const optionalBlocks = z.array(BlockSchema).max(MECHANIC_LIMITS.graphNodes)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Material identifiers must be unique");
const localRefs = z.array(LocalIdSchema).max(MECHANIC_LIMITS.graphNodes)
  .refine((items) => new Set(items).size === items.length, "References must be unique");
const turnRefs = z.array(IdSchema).max(MECHANIC_LIMITS.actions)
  .refine((items) => new Set(items).size === items.length, "Turn references must be unique");
const turnBudget = z.number().int().min(1).max(MECHANIC_LIMITS.actions);
const charLimit = z.number().int().min(1).max(MECHANIC_LIMITS.text);
const artifact = z.string().max(MECHANIC_LIMITS.artifactText);
const selection = LocalIdSchema.nullable();

export const AnalogyTransferConfigSchema = z.object({
  kind: z.literal("analogy_transfer"), source: blocks, target: blocks,
  requiredRelations: localRefs.refine((items) => items.length > 0, "Provide the relations to transfer"),
  requireLimit: z.literal(true),
}).strict();
export const AnalogyTransferResponseSchema = z.object({
  kind: z.literal("analogy_transfer"), action: z.literal("transfer_analogy"),
  mappings: z.array(z.object({ sourceId: selection, targetId: selection, relation: selection }).strict()).max(MECHANIC_LIMITS.graphEdges),
  limit: TextSchema,
}).strict();
export type AnalogyTransferConfig = z.infer<typeof AnalogyTransferConfigSchema>;
export type AnalogyTransferResponse = z.infer<typeof AnalogyTransferResponseSchema>;

export const SelfExplanationConfigSchema = z.object({
  kind: z.literal("self_explanation"), step: NonemptyTextSchema, question: NonemptyTextSchema, maxChars: charLimit,
}).strict();
export const SelfExplanationResponseSchema = z.object({
  kind: z.literal("self_explanation"), action: z.literal("explain_step"), principle: TextSchema, limit: TextSchema,
}).strict();
export type SelfExplanationConfig = z.infer<typeof SelfExplanationConfigSchema>;
export type SelfExplanationResponse = z.infer<typeof SelfExplanationResponseSchema>;

export const ArgumentRebuttalConfigSchema = z.object({
  kind: z.literal("argument_rebuttal"), question: NonemptyTextSchema, materials: blocks, objection: NonemptyTextSchema,
}).strict();
export const ArgumentRebuttalResponseSchema = z.object({
  kind: z.literal("argument_rebuttal"), action: z.literal("argue"), claim: TextSchema,
  evidenceRefs: localRefs, warrant: TextSchema, counterargument: TextSchema, response: TextSchema,
}).strict();
export type ArgumentRebuttalConfig = z.infer<typeof ArgumentRebuttalConfigSchema>;
export type ArgumentRebuttalResponse = z.infer<typeof ArgumentRebuttalResponseSchema>;

export const CritiqueRevisionConfigSchema = z.object({
  kind: z.literal("critique_revision"), draft: artifact.trim().min(1), criteria: blocks,
  maxRevisionChars: z.number().int().min(1).max(MECHANIC_LIMITS.artifactText),
}).strict();
export const CritiqueRevisionResponseSchema = z.object({
  kind: z.literal("critique_revision"), action: z.literal("critique_and_revise"),
  findings: z.array(z.object({ criterionId: selection, span: SpanSchema.nullable(), problem: TextSchema }).strict()).max(MECHANIC_LIMITS.steps),
  revision: artifact,
}).strict();
export type CritiqueRevisionConfig = z.infer<typeof CritiqueRevisionConfigSchema>;
export type CritiqueRevisionResponse = z.infer<typeof CritiqueRevisionResponseSchema>;

export const MisconceptionTutoringConfigSchema = z.object({
  kind: z.literal("misconception_tutoring"), simulatedClaim: NonemptyTextSchema, knownContext: optionalBlocks, turnBudget,
}).strict();
export const MisconceptionTutoringResponseSchema = z.object({
  kind: z.literal("misconception_tutoring"), action: z.literal("tutor"), turnReceiptIds: turnRefs,
  dialogueDraft: TextSchema, diagnosticQuestion: TextSchema, correction: TextSchema, check: TextSchema,
}).strict();
export type MisconceptionTutoringConfig = z.infer<typeof MisconceptionTutoringConfigSchema>;
export type MisconceptionTutoringResponse = z.infer<typeof MisconceptionTutoringResponseSchema>;

export const InformationGapConfigSchema = z.object({
  kind: z.literal("information_gap"), goal: NonemptyTextSchema, knownFacts: optionalBlocks, turnBudget,
}).strict();
export const InformationGapResponseSchema = z.object({
  kind: z.literal("information_gap"), action: z.literal("resolve_information_gap"), turnReceiptIds: turnRefs,
  dialogueDraft: TextSchema, obtainedFactIds: localRefs, decision: TextSchema,
}).strict();
export type InformationGapConfig = z.infer<typeof InformationGapConfigSchema>;
export type InformationGapResponse = z.infer<typeof InformationGapResponseSchema>;

export const RoleSimulationConfigSchema = z.object({
  kind: z.literal("role_simulation"), role: NonemptyTextSchema, goal: NonemptyTextSchema,
  knownFacts: optionalBlocks, constraints: blocks, turnBudget,
}).strict();
export const RoleSimulationResponseSchema = z.object({
  kind: z.literal("role_simulation"), action: z.literal("resolve_scenario"), turnReceiptIds: turnRefs,
  dialogueDraft: TextSchema,
  agreement: z.object({ commitments: z.array(TextSchema).max(MECHANIC_LIMITS.steps), conditions: z.array(TextSchema).max(MECHANIC_LIMITS.steps) }).strict(),
  rationale: TextSchema,
}).strict();
export type RoleSimulationConfig = z.infer<typeof RoleSimulationConfigSchema>;
export type RoleSimulationResponse = z.infer<typeof RoleSimulationResponseSchema>;

export const AudienceMediationConfigSchema = z.object({
  kind: z.literal("audience_mediation"), source: blocks, audience: NonemptyTextSchema,
  mustPreserveFactIds: localRefs.refine((items) => items.length > 0, "Provide the essential source facts"),
  maxWords: z.number().int().min(1).max(MECHANIC_LIMITS.text),
}).strict().superRefine((config, context) => {
  config.mustPreserveFactIds.forEach((id, index) => {
    if (!config.source.some((block) => block.id === id)) {
      context.addIssue({ code: "custom", path: ["mustPreserveFactIds", index], message: "Essential fact must refer to the source material" });
    }
  });
});
export const AudienceMediationResponseSchema = z.object({
  kind: z.literal("audience_mediation"), action: z.literal("mediate"), text: TextSchema, preservedFactIds: localRefs,
}).strict();
export type AudienceMediationConfig = z.infer<typeof AudienceMediationConfigSchema>;
export type AudienceMediationResponse = z.infer<typeof AudienceMediationResponseSchema>;

function issue(path: SubmissionIssue["path"], code: SubmissionIssue["code"], message: string): SubmissionIssue {
  return { path, code, message };
}
function required(text: string, path: SubmissionIssue["path"], label: string): SubmissionIssue[] {
  return text.trim() ? [] : [issue(path, "required", label)];
}
function references(ids: readonly string[], material: readonly Block[], path: string): SubmissionIssue[] {
  return ids.flatMap((id, index) => material.some((block) => block.id === id) ? [] :
    [issue([path, index], "invalid_reference", "Choose a reference from this task's material.")]);
}
function needsTurns(ids: readonly string[]): SubmissionIssue[] {
  return ids.length ? [] : [issue(["turnReceiptIds"], "required", "Complete a conversation turn before submitting your response.")];
}
function unsentTurn(text: string): SubmissionIssue[] {
  return text.trim() ? [issue(["dialogueDraft"], "required", "Send or clear the turn draft before submitting your final response.")] : [];
}

/** Uses Unicode word boundaries, including languages that do not separate words with spaces. */
export function countResponseWords(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(text))
    .filter((segment) => segment.isWordLike).length;
}

function descriptor<C extends JsonValue, R extends JsonValue>(
  id: FamilyDescriptor<C, R>["id"], configSchema: z.ZodType<C>, responseSchema: z.ZodType<R>,
  createInitialResponse: (config: C) => R, check: (config: C, response: R) => SubmissionIssue[],
  limitations: string[], dialogue = false,
): FamilyDescriptor<C, R> {
  return {
    id, version: 2, responseSchemaVersion: 2, configSchema, responseSchema, createInitialResponse,
    rendererKey: `${id}@2`, requiredAffordances: dialogue ? ["multiline_text", "dialogue_history"] : ["multiline_text"],
    supportedEvaluators: ["rubric"], accessibility: { keyboardEquivalent: true, nonVisualSummary: true },
    actions: dialogue ? ["dialogue.turn"] : [], requirements: dialogue ? ["model", "activity"] : ["model"], limitations,
    validateSubmission(config, response) {
      const c = configSchema.safeParse(config);
      const r = responseSchema.safeParse(response);
      const errors = [!c.success ? c.error : null, !r.success ? r.error : null];
      const invalid = errors.flatMap((error) => error?.issues.map((entry) => issue(
        entry.path.map((part) => typeof part === "number" ? part : String(part)), "invalid_structure", entry.message,
      )) ?? []);
      return c.success && r.success ? check(c.data, r.data) : invalid;
    },
  };
}

export const analogyTransferDescriptor = descriptor(
  "analogy_transfer", AnalogyTransferConfigSchema, AnalogyTransferResponseSchema,
  (): AnalogyTransferResponse => ({ kind: "analogy_transfer", action: "transfer_analogy", mappings: [], limit: "" }),
  (config, response) => {
    const issues = required(response.limit, ["limit"], "Explain a limit of this analogy.");
    if (!response.mappings.length) issues.push(issue(["mappings"], "required", "Map the relevant relationships between the two settings."));
    const seen = new Set<string>();
    response.mappings.forEach((mapping, index) => {
      for (const [key, available] of [["sourceId", config.source.map((block) => block.id)],
        ["targetId", config.target.map((block) => block.id)], ["relation", config.requiredRelations]] as const) {
        if (mapping[key] === null) issues.push(issue(["mappings", index, key], "required", "Complete this mapping."));
        else if (!available.includes(mapping[key])) issues.push(issue(["mappings", index, key], "invalid_reference", "Choose a value from this task."));
      }
      const key = JSON.stringify(mapping);
      if (seen.has(key)) issues.push(issue(["mappings", index], "duplicate", "This mapping is already included."));
      seen.add(key);
    });
    config.requiredRelations.forEach((relation) => {
      if (!response.mappings.some((mapping) => mapping.relation === relation)) {
        issues.push(issue(["mappings"], "required", `Include a mapping for ${relation}.`));
      }
    });
    return issues;
  },
  ["Assesses structural transfer and a stated limit through a rubric; it does not certify unrestricted analogy equivalence."],
);

export const selfExplanationDescriptor = descriptor(
  "self_explanation", SelfExplanationConfigSchema, SelfExplanationResponseSchema,
  (): SelfExplanationResponse => ({ kind: "self_explanation", action: "explain_step", principle: "", limit: "" }),
  (config, response) => [
    ...required(response.principle, ["principle"], "Explain why this step works."),
    ...required(response.limit, ["limit"], "Explain when that reasoning stops applying."),
    ...(["principle", "limit"] as const).flatMap((key) => response[key].length > config.maxChars ?
      [issue([key], "out_of_bounds", `Use no more than ${config.maxChars} characters in this response part.`)] : []),
  ],
  ["One step explanation is evidence about this step, not general competence across the topic."],
);

export const argumentRebuttalDescriptor = descriptor(
  "argument_rebuttal", ArgumentRebuttalConfigSchema, ArgumentRebuttalResponseSchema,
  (): ArgumentRebuttalResponse => ({ kind: "argument_rebuttal", action: "argue", claim: "", evidenceRefs: [], warrant: "", counterargument: "", response: "" }),
  (config, response) => [
    ...(["claim", "warrant", "counterargument", "response"] as const).flatMap((key) => required(response[key], [key], "Complete this part of your argument.")),
    ...(!response.evidenceRefs.length ? [issue(["evidenceRefs"], "required", "Select the material that supports your argument.")] : []),
    ...references(response.evidenceRefs, config.materials, "evidenceRefs"),
  ],
  ["Different defensible stances are permitted; eloquence, length, and confidence do not establish evidence support."],
);

export const critiqueRevisionDescriptor = descriptor(
  "critique_revision", CritiqueRevisionConfigSchema, CritiqueRevisionResponseSchema,
  (): CritiqueRevisionResponse => ({ kind: "critique_revision", action: "critique_and_revise", findings: [], revision: "" }),
  (config, response) => {
    const issues = required(response.revision, ["revision"], "Write your revised version.");
    if (!response.findings.length) issues.push(issue(["findings"], "required", "Identify a substantive problem before revising."));
    if (response.revision.length > config.maxRevisionChars) issues.push(issue(["revision"], "out_of_bounds", `Use no more than ${config.maxRevisionChars} characters.`));
    response.findings.forEach((finding, index) => {
      if (finding.criterionId === null) issues.push(issue(["findings", index, "criterionId"], "required", "Choose the relevant criterion."));
      else if (!config.criteria.some((criterion) => criterion.id === finding.criterionId)) issues.push(issue(["findings", index, "criterionId"], "invalid_reference", "Choose a criterion from this task."));
      issues.push(...required(finding.problem, ["findings", index, "problem"], "Explain the problem and its consequence."));
      if (finding.span !== null && !isValidSpan(finding.span, [{ id: "draft", text: config.draft }])) {
        issues.push(issue(["findings", index, "span"], "invalid_reference", "The cited passage must exist in the original draft."));
      }
    });
    return issues;
  },
  ["Assesses both diagnosis and substantive improvement; a cosmetic rewrite is not evidence of repair."],
);

export const misconceptionTutoringDescriptor = descriptor(
  "misconception_tutoring", MisconceptionTutoringConfigSchema, MisconceptionTutoringResponseSchema,
  (): MisconceptionTutoringResponse => ({ kind: "misconception_tutoring", action: "tutor", turnReceiptIds: [], dialogueDraft: "", diagnosticQuestion: "", correction: "", check: "" }),
  (_config, response) => [...needsTurns(response.turnReceiptIds), ...unsentTurn(response.dialogueDraft),
    ...(["diagnosticQuestion", "correction", "check"] as const).flatMap((key) => required(response[key], [key], "Complete this part of your teaching response."))],
  ["The misconception belongs to the simulated learner; this activity does not diagnose the real learner from one reply.",
    "Requires a real server-owned dialogue service and authoritative turn history."], true,
);

export const informationGapDescriptor = descriptor(
  "information_gap", InformationGapConfigSchema, InformationGapResponseSchema,
  (): InformationGapResponse => ({ kind: "information_gap", action: "resolve_information_gap", turnReceiptIds: [], dialogueDraft: "", obtainedFactIds: [], decision: "" }),
  (_config, response) => [...needsTurns(response.turnReceiptIds), ...unsentTurn(response.dialogueDraft),
    ...required(response.decision, ["decision"], "Explain your decision using what you learned."),
    ...(!response.obtainedFactIds.length ? [issue(["obtainedFactIds"], "required", "Identify the facts you obtained in the conversation.")] : [])],
  ["Only facts revealed by the authoritative session can support an obtained-fact claim.",
    "Requires a real server-owned dialogue service; final submission remains available after turn exhaustion."], true,
);

export const roleSimulationDescriptor = descriptor(
  "role_simulation", RoleSimulationConfigSchema, RoleSimulationResponseSchema,
  (): RoleSimulationResponse => ({ kind: "role_simulation", action: "resolve_scenario", turnReceiptIds: [], dialogueDraft: "", agreement: { commitments: [], conditions: [] }, rationale: "" }),
  (_config, response) => [...needsTurns(response.turnReceiptIds), ...unsentTurn(response.dialogueDraft),
    ...required(response.rationale, ["rationale"], "Explain how the outcome meets the goal and constraints."),
    ...(!response.agreement.commitments.length ? [issue(["agreement", "commitments"], "required", "Record the proposed commitments, including a decision to defer if applicable.")] : []),
    ...(["commitments", "conditions"] as const).flatMap((key) => response.agreement[key].flatMap((text, index) =>
      required(text, ["agreement", key, index], "Complete this agreement item or remove it.")))],
  ["Learner-authored agreement text is a claim, not partner consent. The actual ordered dialogue and private constraints determine assessment.",
    "Ambiguous agreement remains uncertain; there is no independent structured negotiation ledger."], true,
);

export const audienceMediationDescriptor = descriptor(
  "audience_mediation", AudienceMediationConfigSchema, AudienceMediationResponseSchema,
  (): AudienceMediationResponse => ({ kind: "audience_mediation", action: "mediate", text: "", preservedFactIds: [] }),
  (config, response) => [...required(response.text, ["text"], "Write the message for this audience."),
    ...references(response.preservedFactIds, config.source, "preservedFactIds"),
    ...config.mustPreserveFactIds.flatMap((id) => response.preservedFactIds.includes(id) ? [] :
      [issue(["preservedFactIds"], "required", "Identify each essential fact in your message.")]),
    ...(countResponseWords(response.text) > config.maxWords ? [issue(["text"], "out_of_bounds", `Use no more than ${config.maxWords} words.`)] : [])],
  ["Fact identifiers do not prove preservation; the actual message must retain meaning, limits, and the decision consequence."],
);

export const descriptors = [analogyTransferDescriptor, selfExplanationDescriptor, argumentRebuttalDescriptor,
  critiqueRevisionDescriptor, misconceptionTutoringDescriptor, informationGapDescriptor, roleSimulationDescriptor,
  audienceMediationDescriptor] as const;

export type CommunicationConfig = z.infer<typeof AnalogyTransferConfigSchema> | SelfExplanationConfig | ArgumentRebuttalConfig |
  CritiqueRevisionConfig | MisconceptionTutoringConfig | InformationGapConfig | RoleSimulationConfig | AudienceMediationConfig;
export type CommunicationResponse = AnalogyTransferResponse | SelfExplanationResponse | ArgumentRebuttalResponse |
  CritiqueRevisionResponse | MisconceptionTutoringResponse | InformationGapResponse | RoleSimulationResponse | AudienceMediationResponse;
