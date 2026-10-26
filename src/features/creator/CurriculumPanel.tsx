"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Pencil } from "lucide-react";
import { Button, Notice } from "@/components/ui";
import { assertCurrentApproval, curriculumDigest, validateCurriculum, type CurriculumApproval, type CurriculumDraft } from "@/domain/course";
import type { CurriculumEvidencePublic } from "@/domain/curriculum-authoring";
import type { AgentTurnRun, GenerationRun } from "@/domain/generation";
import { languageLabel } from "./languages";
import { CourseBuildProgress } from "./CourseBuildProgress";
import type { GenerationStreamState } from "./generation-stream";

export interface ApproveCurriculumInput { courseId: string; draftId: string; revision: number; contentDigest: string }
export type ApproveCurriculum = (input: ApproveCurriculumInput) => Promise<CurriculumApproval>;

const unconfirmedApproval = "Approval could not be confirmed. Review the current program and try again.";
function approvalMessage(messageKey: string): string {
  switch (messageKey) {
    case "generation.rateLimited": return "Generation is busy right now. Your program is saved. Wait a moment, then try approving again.";
    case "generation.budgetExhausted": return "There isn’t enough available generation budget to start this build. Your program is saved. Try again when budget is available.";
    case "curriculum.authoringInProgress": return "The agent is still finishing the course program. Wait for the response to finish before approving.";
    case "curriculum.reviewInProgress": return "Your program edits are still being checked. Wait for the check to finish, then review the program before approving.";
    case "curriculum.changed": return "The program changed. Review the latest version, then approve it again.";
    case "curriculum.researchRequired": return "The program’s research check is not complete. Review its research status and resolve any open questions before approving again.";
    case "generation.timeout": return "The approval request timed out. Your program is saved. Check its current status, then try again if approval is still needed.";
    case "generation.unavailable":
    case "curriculum.unavailable": return "The generation service is temporarily unavailable. Your program is saved. Try approving again in a moment.";
    default: return unconfirmedApproval;
  }
}
export class CurriculumApprovalFailure extends Error {
  constructor(readonly messageKey: string) { super(approvalMessage(messageKey)); this.name = "CurriculumApprovalFailure"; }
}
export function curriculumApprovalErrorMessage(error: unknown): string {
  return error instanceof CurriculumApprovalFailure ? approvalMessage(error.messageKey) : unconfirmedApproval;
}

export async function approveDisplayedCurriculum(
  draft: CurriculumDraft,
  current: () => { id: string; revision: number; authoringActive?: boolean } | null,
  approve: ApproveCurriculum,
): Promise<CurriculumApproval> {
  const matches = () => { const latest = current(); return latest?.id === draft.id && latest.revision === draft.revision; };
  const assertAuthoringFinished = () => { if (current()?.authoringActive) throw new CurriculumApprovalFailure("curriculum.authoringInProgress"); };
  assertAuthoringFinished();
  if (!matches() || draft.unresolvedQuestions.some((question) => question.blocking) || validateCurriculum(draft).length > 0) {
    throw new Error("This program needs an up-to-date review before approval.");
  }
  const contentDigest = await curriculumDigest(draft);
  assertAuthoringFinished();
  if (!matches()) throw new CurriculumApprovalFailure("curriculum.changed");
  const receipt = await approve({ courseId: draft.courseId, draftId: draft.id, revision: draft.revision, contentDigest });
  if (!matches()) throw new CurriculumApprovalFailure("curriculum.changed");
  await assertCurrentApproval(draft, receipt);
  return receipt;
}

export interface CurriculumPanelProps {
  draft: CurriculumDraft;
  currentRevision: number;
  onApprove?: ApproveCurriculum;
  approval?: CurriculumApproval | null;
  awaitingApproval?: boolean;
  showTitle?: boolean;
  evidence?: CurriculumEvidencePublic;
  generationRun?: GenerationRun | null;
  languageRun?: AgentTurnRun | null;
  generation?: GenerationStreamState;
  generationConnectionError?: boolean;
  cancelPending?: boolean;
  onCancelBuild?: () => void;
  retryPending?: boolean;
  retryError?: boolean;
  onRetryBuild?: () => void;
  authoringRun?: AgentTurnRun | null;
  conversationAuthoringActive?: boolean;
  authoringConnectionError?: boolean;
  authoringCommandPending?: boolean;
  authoringCommandError?: boolean;
  onCancelAuthoring?: () => void;
  onRetryAuthoring?: () => void;
  onEdit?: () => void;
  buildInChat?: boolean;
  onViewBuild?: () => void;
}

export function CurriculumPanel({ draft, currentRevision, onApprove, approval = null, awaitingApproval = false, showTitle = true, evidence, generationRun = null, languageRun = null, generation, generationConnectionError = false, cancelPending = false, onCancelBuild, retryPending = false, retryError = false, onRetryBuild, authoringRun = null, conversationAuthoringActive = false, authoringConnectionError = false, authoringCommandPending = false, authoringCommandError = false, onCancelAuthoring, onRetryAuthoring, onEdit, buildInChat = false, onViewBuild }: CurriculumPanelProps) {
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<CurriculumApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authoringActive = Boolean(authoringRun && !["succeeded", "failed", "cancelled"].includes(authoringRun.status));
  const finishingProgram = conversationAuthoringActive || Boolean(languageRun && ["queued", "running"].includes(languageRun.status));
  const approvalBlockedByAuthoring = authoringActive || finishingProgram;
  const currentRef = useRef({ id: draft.id, revision: currentRevision, authoringActive: approvalBlockedByAuthoring });
  useEffect(() => { currentRef.current = { id: draft.id, revision: currentRevision, authoringActive: approvalBlockedByAuthoring }; }, [draft.id, currentRevision, approvalBlockedByAuthoring]);
  const approved = [approval, receipt].some((value) => value?.draftId === draft.id && value.draftRevision === draft.revision);
  const isCurrent = draft.revision === currentRevision;
  const blockers = draft.unresolvedQuestions.some((question) => question.blocking);
  const valid = validateCurriculum(draft).length === 0;
  const researchReady = evidence === undefined || evidence.status === "verified";
  const minutes = draft.modules.reduce((total, module) => total + module.estimatedStudyMinutes, 0);
  const moduleNames = new Map(draft.modules.map((module) => [module.id, module.title]));

  async function handleApprove() {
    if (!onApprove || pending || !isCurrent || approvalBlockedByAuthoring) return;
    setPending(true);
    setError(null);
    try {
      const result = await approveDisplayedCurriculum(draft, () => currentRef.current, onApprove);
      setReceipt(result);
    } catch (failure) {
      setError(curriculumApprovalErrorMessage(failure));
    } finally { setPending(false); }
  }

  return <section className="creator-program" aria-label="Course program">
    <header className="creator-program__header">
      <div><h2>Course program</h2><p>Version {draft.revision} in {languageLabel(draft.contentLanguage)}</p></div>
      {onEdit && <Button variant="quiet" size="compact" onClick={onEdit}><Pencil size={16} aria-hidden="true" />Edit program</Button>}
    </header>
    <div className="creator-program__body">
      {showTitle && <h3 className="creator-program__title">{draft.title}</h3>}
      <p className="creator-program__goal">{draft.goal}</p>
      <p className="creator-program__estimate">{draft.modules.length} {draft.modules.length === 1 ? "section" : "sections"}, about {formatStudyTime(minutes)}</p>
      <section className="creator-program__section"><h3>Who this is for</h3><p>{draft.audience}</p></section>
      <section className="creator-program__section"><h3>Before you begin</h3>
        {draft.assumedKnowledge.length ? <ul>{draft.assumedKnowledge.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>No prior knowledge is listed.</p>}
      </section>
      <section className="creator-program__section"><h3>What you’ll be able to do</h3>
        <ul className="creator-program__outcomes">{draft.outcomes.map((outcome) => <li key={outcome.id}><strong>{outcome.title}</strong><p>{outcome.demonstration}</p>{outcome.requirement === "specialization" && <span>Specialization</span>}</li>)}</ul>
      </section>
      <section className="creator-program__section"><h3>Your learning sequence</h3>
        <ol className="creator-program__modules">{draft.modules.map((module, index) => <li key={module.id}>
          <div className="creator-program__module-heading"><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><h4>{module.title}</h4></div>
          <p>{module.summary}</p><p className="creator-program__module-meta">About {formatStudyTime(module.estimatedStudyMinutes)}</p>
          {module.prerequisiteModuleIds.length > 0 && <p className="creator-program__module-meta">After: {module.prerequisiteModuleIds.map((id) => moduleNames.get(id) ?? "An earlier section").join(", ")}</p>}
        </li>)}</ol>
      </section>
      {draft.unresolvedQuestions.length > 0 && <section className="creator-program__section"><h3>Questions to resolve</h3><ul>{draft.unresolvedQuestions.map((question) => <li key={question.id}>{question.text}{question.blocking && <strong> Needed before approval</strong>}</li>)}</ul></section>}
      {evidence && <section className="creator-program__section creator-program__evidence"><h3>Research check</h3>
        <p className={`creator-program__evidence-status creator-program__evidence-status--${evidence.status}`}>{evidence.status === "verified" ? "Sources verified" : evidence.status === "blocked" ? "Research is blocked" : "Research needs to be refreshed"}</p>
        <p>{evidence.rationale}</p>
        {evidence.limitations.length > 0 && <><h4>Limitations</h4><ul>{evidence.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
        {evidence.sources.length > 0 && <><h4>Sources</h4><ul className="creator-program__sources">{evidence.sources.map((source) => <li key={source.sourceId}><a href={source.url} target="_blank" rel="noreferrer">{source.title}<ExternalLink size={14} aria-hidden="true" /></a>{source.extractionState === "truncated" && <span>Partial extract</span>}</li>)}</ul></>}
      </section>}
    </div>
    <footer className="creator-program__footer">
      {finishingProgram && <Notice tone="info">The agent is still finishing the course program. You can approve it when the response is complete.</Notice>}
      {!isCurrent && <Notice tone="warning">A newer program is being loaded. Review it before approving.</Notice>}
      {evidence?.status === "needs_research" && <Notice tone="info">Your changes are saved. Research support is being refreshed before this version can be approved.</Notice>}
      {evidence?.status === "blocked" && <Notice tone="warning">Research could not verify this program yet. Keep the saved draft and try again when the source issue is resolved.</Notice>}
      {!buildInChat && generationRun && <CourseBuildProgress run={generationRun} {...(generation ? { generation } : {})} connectionError={generationConnectionError}
        action={onCancelBuild ? <Button variant="quiet" size="compact" pending={cancelPending} onClick={onCancelBuild}>Cancel build</Button>
          : onRetryBuild ? <Button variant="quiet" size="compact" pending={retryPending} onClick={onRetryBuild}>Retry build</Button> : undefined} />}
      {retryError && <Notice tone="error">The build could not be retried. Your approved program is still safe; try again.</Notice>}
      {authoringRun && <Notice tone={authoringRun.status === "failed" ? "error" : authoringRun.status === "succeeded" ? "success" : "info"}
        action={onCancelAuthoring ? <Button variant="quiet" size="compact" pending={authoringCommandPending} onClick={onCancelAuthoring}>Cancel answer check</Button>
          : onRetryAuthoring ? <Button variant="quiet" size="compact" pending={authoringCommandPending} onClick={onRetryAuthoring}>Retry answer check</Button> : undefined}>
        {authoringStatus(authoringRun)}
      </Notice>}
      {authoringConnectionError && authoringActive && <Notice tone="warning">Live answer-check updates were interrupted. Your exact edits are safe; reconnecting…</Notice>}
      {authoringCommandError && <Notice tone="error">That answer-check action could not be confirmed. Your edits are still safe; try again.</Notice>}
      {languageRun && <Notice tone={languageRun.status === "failed" ? "error" : languageRun.status === "succeeded" ? "success" : "info"}>{languageStatus(languageRun)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {approved && isCurrent ? <div className="creator-program__approved" role="status">{buildInChat ? <><Button disabled variant="secondary"><Check size={18} aria-hidden="true" />Approved</Button><Button variant="quiet" size="compact" onClick={onViewBuild}>View in conversation</Button></> : <><Check size={18} aria-hidden="true" /> Version {draft.revision} approved</>}</div> : <>
        <p>{blockers ? "Answer the open questions in the conversation before approving." : "Check the scope and sequence before lessons are created."}</p>
        {onApprove && awaitingApproval && <Button onClick={() => void handleApprove()} pending={pending} disabled={!isCurrent || blockers || !valid || !researchReady || approvalBlockedByAuthoring}>Approve version {draft.revision}</Button>}
      </>}
    </footer>
  </section>;
}

function languageStatus(run: AgentTurnRun): string {
  if (run.status === "succeeded") return "The requested language version is ready to be checked.";
  if (run.status === "failed") return "The language version could not be created. Your current course is unchanged.";
  if (run.status === "cancelled") return "The language request was cancelled. Your current course is unchanged.";
  return "Creating the requested language version. Your current course remains available.";
}

function authoringStatus(run: AgentTurnRun): string {
  if (run.status === "succeeded") return "The checked answers and edits were applied to the program.";
  if (run.status === "failed") return "The answer check stopped before applying your edits. Your local changes are still available.";
  if (run.status === "cancelled") return "The answer check was cancelled. Your local changes are still available.";
  if (run.status === "awaiting_user") return "The answer check needs more information before it can apply your edits.";
  return "Checking your answers before applying this program update. Your exact edits are saved.";
}

function formatStudyTime(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}${remainder ? ` ${remainder} min` : ""}`;
}
