import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { CurriculumAuthoringSnapshotSchema } from "../../domain/curriculum-authoring";
import { ProviderFailure } from "../ai/failure";
import { jsonDigest } from "../ai/json";
import { MODEL_ID, MODEL_POLICY_VERSION } from "../ai/constants";
import type { ModelPort } from "../ai/ports";
import { ServiceFault } from "../auth/errors";
import type { DbTransaction } from "../db";
import { PostgresResearchRepository } from "../research/repository";
import { SearchResultSchema, SourceBlockSchema, SourceDocumentSchema, type ResearchPort } from "../research/ports";
import { stableExecutionId } from "../runs/identity";
import type { RunContext, StepEffectContext } from "../runs/ports";
import { preparedCurriculumOutput, PreparedCurriculumOutputSchema, type SelectedSource } from "../curriculum-research/composer";
import { composeDurableCurriculum } from "../curriculum-research/durable-composer";
import { commitResearchedRevision } from "../curriculum-research/persistence";
import { createResearchedCourse, curriculumConflict, readArtifact, requireCourseDraft, requireDraft } from "../curricula/repository";
import { editMetadataInTransaction, readAuthoringSnapshot } from "../curricula/service";
import { asAgentTarget, jsonSchema, jsonValue, journalKey, loadToolAuthority, type ContextSnapshot } from "../agent-turns/repository";
import { AgentDecisionReceiptSchema, ToolObservationSchema, type AgentDecision, type AgentDecisionReceipt, type AgentToolAuthority, type ToolObservation } from "./contracts";

const ReadResultSchema = z.union([
  z.object({ status: z.literal("success"), document: SourceDocumentSchema }).strict(),
  z.object({ status: z.enum(["unavailable", "unsupported", "blocked", "too_large"]), requestedUrl: z.string() }).strict(),
]);
const ToolOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("search"), result: SearchResultSchema }).strict(),
  z.object({ kind: z.literal("source"), result: ReadResultSchema }).strict(),
  z.object({ kind: z.literal("blocks"), sourceId: IdSchema, blocks: z.array(SourceBlockSchema), overview: z.boolean() }).strict(),
  z.object({ kind: z.literal("artifact"), snapshot: CurriculumAuthoringSnapshotSchema }).strict(),
  z.object({ kind: z.literal("curriculum"), prepared: PreparedCurriculumOutputSchema }).strict(),
  z.object({ kind: z.literal("metadata") }).strict(),
  z.object({ kind: z.literal("response") }).strict(),
  z.object({ kind: z.literal("failure"), code: z.string(), summary: z.string() }).strict(),
]);
type ToolOutput = z.infer<typeof ToolOutputSchema>;
export interface AgentToolDependencies { model: ModelPort; researchForStep(context: StepEffectContext): ResearchPort }
const notInScope = () => new ServiceFault(404, "not_found", "curriculum.notFound");

export async function prepareAgentDecision(tx: DbTransaction, authority: AgentToolAuthority, decision: AgentDecision, index: number,
  intent: ContextSnapshot["languageIntent"] = null): Promise<AgentDecisionReceipt> {
  const receipt: AgentDecisionReceipt = { kind: "decision", index, invocationId: stableExecutionId(authority.runId, `tool:${index}`),
    decision, capturedDraft: null, capturedCourseRevision: null, preparationError: null };
  try {
    if (intent) {
      if (!["search", "read_source", "read_artifact", "revise_language", "respond"].includes(decision.tool)) throw notInScope();
      if (decision.tool === "read_artifact" && decision.input.courseId !== intent.courseId) throw notInScope();
      if (decision.tool === "revise_language" && (decision.input.courseId !== intent.courseId || decision.input.expectedRevision !== intent.expectedCourseRevision
        || decision.input.expectedDraftRevision !== intent.expectedDraftRevision || decision.input.contentLanguage !== intent.targetLanguage)) throw notInScope();
    }
    if (decision.tool === "read_artifact" || decision.tool === "update_metadata" || decision.tool === "revise_language") {
      if (!authority.artifactIds.has(decision.input.courseId)) throw notInScope();
      const current = await requireCourseDraft(tx, authority.ownerId, decision.input.courseId);
      receipt.capturedDraft = current.draft; receipt.capturedCourseRevision = current.course.revision;
      if (decision.tool !== "read_artifact" && current.course.revision !== decision.input.expectedRevision) throw curriculumConflict(current.course.revision);
      if (decision.tool === "revise_language" && current.draft.revision !== decision.input.expectedDraftRevision) throw curriculumConflict(current.draft.revision);
    } else if (decision.tool === "revise_curriculum") {
      const current = await requireDraft(tx, authority.ownerId, decision.input.draftId);
      if (!authority.artifactIds.has(current.course.id) || current.draft.conversationId !== authority.conversationId) throw notInScope();
      if (current.draft.revision !== decision.input.expectedRevision) throw curriculumConflict(current.draft.revision);
      receipt.capturedDraft = current.draft; receipt.capturedCourseRevision = current.course.revision;
    }
    const selections = "sources" in decision.input ? decision.input.sources : [];
    if (selections.some((selection) => !authority.sourceIds.has(selection.sourceId))) throw notInScope();
    if (decision.tool === "read_source" && decision.input.kind === "blocks" && !authority.sourceIds.has(decision.input.sourceId)) throw notInScope();
  } catch (error) {
    if (!(error instanceof ServiceFault)) throw error;
    receipt.preparationError = error.code;
  }
  return AgentDecisionReceiptSchema.parse(receipt);
}

async function selectedSources(tx: DbTransaction, authority: AgentToolAuthority, decision: AgentDecision): Promise<SelectedSource[]> {
  if (!("sources" in decision.input)) return [];
  const selections = decision.input.sources;
  if (new Set(selections.map((source) => source.sourceId)).size !== selections.length) throw new ProviderFailure("invalid_output");
  const repository = new PostgresResearchRepository();
  const documents = await repository.getSources(tx, selections.map((source) => {
    if (!authority.sourceIds.has(source.sourceId)) throw notInScope();
    return source.sourceId;
  }));
  return documents.map((document) => ({ document, blockIds: selections.find((source) => source.sourceId === document.id)!.blockIds }));
}
function observation(tool: string, ok: boolean, summary: string, data: unknown = null, sourceIds: string[] = [], artifactIds: string[] = []): ToolObservation {
  return ToolObservationSchema.parse({ tool, ok, summary, data: jsonValue(data), sourceIds, artifactIds });
}
function blockOverview(blocks: Array<{ id: string; text: string }>) { return blocks.map((block) => ({ id: block.id, text: block.text.slice(0, 160) })); }
export function agentToolStepInput(receipt: AgentDecisionReceipt) {
  return jsonValue({ invocationId: receipt.invocationId, index: receipt.index,
    decisionDigest: jsonDigest(receipt.decision, 2 * 1024 * 1024), capturedDraftDigest: receipt.capturedDraft ? jsonDigest(receipt.capturedDraft, 2 * 1024 * 1024) : null,
    capturedCourseRevision: receipt.capturedCourseRevision, preparationError: receipt.preparationError });
}
export function curriculumObservationData(snapshot: z.infer<typeof CurriculumAuthoringSnapshotSchema>, page?: Extract<AgentDecision, { tool: "read_artifact" }>["input"]["page"]) {
  const { draft, artifact, evidence } = snapshot;
  const selected = page?.kind === "outcomes" ? draft.outcomes : page?.kind === "modules" ? draft.modules
    : page?.kind === "questions" ? draft.unresolvedQuestions : evidence.sources;
  return { courseId: artifact.courseId, draftId: draft.id, courseRevision: artifact.revision, draftRevision: draft.revision,
    contentDigest: snapshot.contentDigest, title: draft.title, goal: draft.goal, audience: draft.audience, language: draft.contentLanguage,
    outcomeCount: draft.outcomes.length, moduleCount: draft.modules.length, questionCount: draft.unresolvedQuestions.length,
    sourceCount: evidence.sources.length, evidenceStatus: evidence.status, approvalRequestedRevision: artifact.approvalRequestedRevision,
    readyVersionId: artifact.readyVersionId, ...(page ? { page: { ...page, items: selected.slice(page.offset, page.offset + page.limit),
      total: selected.length, nextOffset: page.offset + page.limit < selected.length ? page.offset + page.limit : null } } : {}) };
}

export async function executeAgentTool(context: RunContext, receipt: AgentDecisionReceipt, snapshot: ContextSnapshot,
  dependencies: AgentToolDependencies): Promise<ToolObservation> {
  const agent = asAgentTarget(context.claim.target);
  const decision = receipt.decision;
  const authority = await context.read((tx, target) => loadToolAuthority(tx, target, context.claim.jobId));
  const sources = receipt.preparationError ? [] : await context.read((tx) => selectedSources(tx, authority, decision));
  let composed: Awaited<ReturnType<typeof composeDurableCurriculum>> | null = null;
  let compositionFailure: ToolOutput | null = null;
  if (!receipt.preparationError && ["create_course", "revise_curriculum", "revise_language"].includes(decision.tool)) {
    try {
      if (decision.tool === "create_course" || decision.tool === "revise_curriculum" || decision.tool === "revise_language") {
        composed = await composeDurableCurriculum(context, dependencies.model, { invocationId: receipt.invocationId,
          decision, capturedDraft: receipt.capturedDraft, now: snapshot.now, sources });
      }
    } catch (error) {
      if (error instanceof ProviderFailure && error.code === "invalid_output") compositionFailure = { kind: "failure", code: error.code,
        summary: "A saved curriculum part did not pass its reference, source or coverage checks. Review the source selection or requested scope before trying again; no partial programme was published." };
      else if (error instanceof ServiceFault) compositionFailure = { kind: "failure", code: error.code,
        summary: "The selected curriculum changed or became unavailable before this programme could be saved." };
      else throw error;
    }
  }
  const result = await context.step({
    key: journalKey(receipt.index, "tool"), input: agentToolStepInput(receipt),
    digests: { schema: jsonDigest({ version: "agent-tool-output-v1" }), capability: jsonDigest({ model: MODEL_ID, policy: MODEL_POLICY_VERSION, tools: "agent-tools-v1" }),
      validationPolicy: jsonDigest({ version: "curriculum-evidence-v1" }), approval: null },
    outputSchema: jsonSchema(ToolOutputSchema), resultSchema: jsonSchema(ToolObservationSchema),
    effect: async (step): Promise<z.infer<ReturnType<typeof jsonSchema>>> => {
      let output: ToolOutput;
      try {
        if (receipt.preparationError) return jsonValue({ kind: "failure", code: receipt.preparationError, summary: "The selected record changed or is outside this conversation. Read its current state before trying again." });
        if (compositionFailure) return jsonValue(compositionFailure);
        switch (decision.tool) {
          case "search": output = { kind: "search", result: await dependencies.researchForStep(step).search(decision.input, step.signal) }; break;
          case "read_source": {
            if (decision.input.kind === "url") output = { kind: "source", result: await dependencies.researchForStep(step).read({ url: decision.input.url }, step.signal) };
            else {
              const selection = decision.input;
              if (!authority.sourceIds.has(selection.sourceId)) throw notInScope();
              const source = await context.read((tx) => new PostgresResearchRepository().getSource(tx, selection.sourceId));
              if (!source) throw notInScope();
              const blocks = selection.blockIds.length ? selection.blockIds.map((id) => {
                const block = source.blocks.find((item) => item.id === id);
                if (!block) throw new ProviderFailure("invalid_output"); return block;
              }) : blockOverview(source.blocks);
              if (blocks.reduce((count, block) => count + block.text.length, 0) > 96000) throw new ProviderFailure("invalid_output");
              output = { kind: "blocks", sourceId: source.id, blocks, overview: selection.blockIds.length === 0 };
            }
            break;
          }
          case "read_artifact": {
            if (!authority.artifactIds.has(decision.input.courseId) || !receipt.capturedDraft) throw notInScope();
            output = { kind: "artifact", snapshot: await context.read((tx) => readAuthoringSnapshot(tx, agent.ownerId, receipt.capturedDraft!.id)) };
            break;
          }
          case "create_course": case "revise_curriculum": case "revise_language":
            if (!composed) throw new ProviderFailure("invalid_output");
            output = { kind: "curriculum", prepared: preparedCurriculumOutput(composed) }; break;
          case "update_metadata": output = { kind: "metadata" }; break;
          case "respond": output = { kind: "response" }; break;
        }
      } catch (error) {
        if (error instanceof ProviderFailure && error.code === "invalid_output") {
          output = { kind: "failure", code: "invalid_output", summary: "The result did not pass the curriculum, reference or source checks. Read the relevant sources or correct the request before trying again." };
        } else if (error instanceof ServiceFault) {
          output = { kind: "failure", code: error.code, summary: "The selected record changed or is unavailable. Read its current state before trying again." };
        } else throw error;
      }
      return jsonValue(ToolOutputSchema.parse(output));
    },
    commit: async (tx, rawOutput) => {
      const output = ToolOutputSchema.parse(rawOutput);
      let result: ToolObservation;
      switch (output.kind) {
        case "failure": result = observation(decision.tool, false, output.summary, { code: output.code }); break;
        case "search": {
          await new PostgresResearchRepository().saveSearch(tx, output.result);
          result = observation(decision.tool, true, `Found ${output.result.hits.length} source candidates. These search results still need to be read.`, output.result); break;
        }
        case "source": {
          if (output.result.status !== "success") { result = observation(decision.tool, false, `This source could not be read (${output.result.status}).`, output.result); break; }
          const source = await new PostgresResearchRepository().saveSource(tx, output.result.document);
          result = observation(decision.tool, true, `Read ${source.title}.`, { sourceId: source.id, title: source.title, url: source.finalUrl,
            extractionState: source.extractionState, blockIndex: blockOverview(source.blocks), previewOnly: true }, [source.id]); break;
        }
        case "blocks": result = observation(decision.tool, true, output.overview ? "Listed the source's available blocks; previews are not complete passages." : "Read the selected source blocks.", output, [output.sourceId]); break;
        case "artifact": result = observation(decision.tool, true, "Read the current course and curriculum revision.",
          curriculumObservationData(output.snapshot, decision.tool === "read_artifact" ? decision.input.page : undefined), [], [output.snapshot.artifact.courseId]); break;
        case "curriculum": {
          const prepared = output.prepared;
          if (!composed) throw new ProviderFailure("invalid_output");
          const facts = composed.facts;
          let mutation;
          if (decision.tool === "create_course") {
            mutation = await createResearchedCourse(tx, { ownerId: agent.ownerId, runId: agent.runId, branchId: agent.branchId,
              courseId: prepared.draft.courseId, summary: prepared.summary!, draft: prepared.draft, evidence: prepared.evidence, facts });
          } else {
            if (!authority.artifactIds.has(prepared.draft.courseId) || !receipt.capturedDraft) throw notInScope();
            mutation = await commitResearchedRevision(tx, { ownerId: agent.ownerId, expectedRevision: receipt.capturedDraft.revision,
              ...(decision.tool === "revise_language" ? { expectedCourseRevision: decision.input.expectedRevision } : {}), prepared, facts, now: snapshot.now });
          }
          await context.emitChat(tx, { type: "artifact.updated", courseId: mutation.artifact.courseId, revision: mutation.artifact.revision });
          await context.emitChat(tx, { type: "outline.updated", courseId: mutation.artifact.courseId, draftId: mutation.draft.id, revision: mutation.draft.revision });
          if (mutation.artifact.approvalRequestedRevision === mutation.draft.revision) await context.emitChat(tx, {
            type: "approval.required", courseId: mutation.artifact.courseId, draftId: mutation.draft.id, revision: mutation.draft.revision,
          });
          result = observation(decision.tool, true, "Saved a researched curriculum. The user must explicitly approve its exact revision before lesson construction.", {
            courseId: mutation.artifact.courseId, draftId: mutation.draft.id, courseRevision: mutation.artifact.revision,
            draftRevision: mutation.draft.revision, contentDigest: mutation.contentDigest, title: mutation.draft.title,
            language: mutation.draft.contentLanguage, outcomeCount: mutation.draft.outcomes.length, moduleCount: mutation.draft.modules.length,
            approvalRequestedRevision: mutation.artifact.approvalRequestedRevision, readyVersionId: mutation.artifact.readyVersionId,
          },
            mutation.draft.sourceIds, [mutation.artifact.courseId]); break;
        }
        case "metadata": {
          if (decision.tool !== "update_metadata" || !authority.artifactIds.has(decision.input.courseId)) throw notInScope();
          const artifact = await editMetadataInTransaction(tx, { ...decision.input, ownerId: agent.ownerId, now: snapshot.now });
          await context.emitChat(tx, { type: "artifact.updated", courseId: artifact.courseId, revision: artifact.revision });
          result = observation(decision.tool, true, "Saved the course metadata.", artifact, [], [artifact.courseId]); break;
        }
        case "response": {
          if (decision.tool !== "respond") throw new ProviderFailure("invalid_output");
          const messageId = stableExecutionId(receipt.invocationId, "assistant");
          let awaitingUser = decision.input.awaitingUser;
          if (snapshot.languageIntent) {
            const artifact = await readArtifact(tx, agent.ownerId, snapshot.languageIntent.courseId);
            if (artifact.curriculum?.contentLanguage !== snapshot.languageIntent.targetLanguage) awaitingUser = true;
          }
          await tx.query(`INSERT INTO unfurl.messages(id,conversation_id,branch_id,parent_message_id,role,status,parts,client_request_id)
            VALUES($1,$2,$3,$4,'assistant','complete',$5,NULL)`, [messageId, agent.conversationId, agent.branchId, agent.inputMessageId,
              JSON.stringify([{ type: "text", text: decision.input.text }])]);
          await context.emitChat(tx, { type: "message.started", messageId });
          await context.emitChat(tx, { type: "message.delta", messageId, text: decision.input.text });
          await context.emitChat(tx, { type: "message.completed", messageId });
          const status = awaitingUser ? "awaiting_user" : "succeeded";
          await context.completeTurn(tx, { status });
          result = observation(decision.tool, true, "Saved the assistant response.", { status }); break;
        }
      }
      if (decision.tool !== "respond") await context.emitChat(tx, result.ok
        ? { type: "action.completed", invocationId: receipt.invocationId, resultSummary: result.summary, sourceIds: result.sourceIds }
        : { type: "action.failed", invocationId: receipt.invocationId, error: { code: "generation_failed", messageKey: "generation.toolNeedsAttention", retryable: true, requestId: receipt.invocationId } });
      return jsonValue(result);
    },
  });
  return ToolObservationSchema.parse(result);
}
