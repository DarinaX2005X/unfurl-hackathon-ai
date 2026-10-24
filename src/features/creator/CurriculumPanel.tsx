"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button, Notice } from "@/components/ui";
import { assertCurrentApproval, curriculumDigest, validateCurriculum, type CurriculumApproval, type CurriculumDraft } from "@/domain/course";
import { languageLabel } from "./languages";

export interface ApproveCurriculumInput { courseId: string; draftId: string; revision: number; contentDigest: string }
export type ApproveCurriculum = (input: ApproveCurriculumInput) => Promise<CurriculumApproval>;

export async function approveDisplayedCurriculum(
  draft: CurriculumDraft,
  current: () => { id: string; revision: number } | null,
  approve: ApproveCurriculum,
): Promise<CurriculumApproval> {
  const matches = () => { const latest = current(); return latest?.id === draft.id && latest.revision === draft.revision; };
  if (!matches() || draft.unresolvedQuestions.some((question) => question.blocking) || validateCurriculum(draft).length > 0) {
    throw new Error("This program needs an up-to-date review before approval.");
  }
  const contentDigest = await curriculumDigest(draft);
  if (!matches()) throw new Error("The program changed. Review the latest version.");
  const receipt = await approve({ courseId: draft.courseId, draftId: draft.id, revision: draft.revision, contentDigest });
  if (!matches()) throw new Error("The program changed. Review the latest version.");
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
}

export function CurriculumPanel({ draft, currentRevision, onApprove, approval = null, awaitingApproval = false, showTitle = true }: CurriculumPanelProps) {
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<CurriculumApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef({ id: draft.id, revision: currentRevision });
  useEffect(() => { currentRef.current = { id: draft.id, revision: currentRevision }; }, [draft.id, currentRevision]);
  const approved = [approval, receipt].some((value) => value?.draftId === draft.id && value.draftRevision === draft.revision);
  const isCurrent = draft.revision === currentRevision;
  const blockers = draft.unresolvedQuestions.some((question) => question.blocking);
  const valid = validateCurriculum(draft).length === 0;
  const minutes = draft.modules.reduce((total, module) => total + module.estimatedStudyMinutes, 0);
  const moduleNames = new Map(draft.modules.map((module) => [module.id, module.title]));

  async function handleApprove() {
    if (!onApprove || pending || !isCurrent) return;
    setPending(true);
    setError(null);
    try {
      const result = await approveDisplayedCurriculum(draft, () => currentRef.current, onApprove);
      setReceipt(result);
    } catch {
      setError("Approval could not be confirmed. Review the current program and try again.");
    } finally { setPending(false); }
  }

  return <section className="creator-program" aria-label="Course program">
    <header className="creator-program__header">
      <h2>Course program</h2>
      <p>Version {draft.revision} in {languageLabel(draft.contentLanguage)}</p>
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
    </div>
    <footer className="creator-program__footer">
      {!isCurrent && <Notice tone="warning">A newer program is being loaded. Review it before approving.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {approved && isCurrent ? <p className="creator-program__approved" role="status"><Check size={18} aria-hidden="true" /> Version {draft.revision} approved</p> : <>
        <p>{blockers ? "Answer the open questions in the conversation before approving." : "Check the scope and sequence before lessons are created."}</p>
        {onApprove && awaitingApproval && <Button onClick={() => void handleApprove()} pending={pending} disabled={!isCurrent || blockers || !valid}>Approve version {draft.revision}</Button>}
      </>}
    </footer>
  </section>;
}

function formatStudyTime(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}${remainder ? ` ${remainder} min` : ""}`;
}
